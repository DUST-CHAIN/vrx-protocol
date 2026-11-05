// AI Sales Director — the reveal_unit ACTION tool (the "open a unit to view in-app" capability). SERVER-ONLY.
// What a human desk operator does when a buyer says "show me a unit": OPEN the unit into the buyer's in-app view
// (the "units opened to you" list — building hero photo + specs now, floorplan/price once the buyer is offer-
// eligible). That capability already exists as the operator grant (lib/unit-grants.grantUnit, POST /api/unit-grants
// §9 3b); the AI simply had NO tool for it, so it fell back to "what's your email?" (the live-transcript bug
//  caught). This wraps the SAME grant the operator uses — the AI now does exactly what the operator would.
//
// ── Gating (defence in depth, fail-closed) ──────────────────────────────────────────────────────────────
//   1. the PERMISSION MATRIX — reveal_unit is `deny` in base, `allow` from the `qualify` phase onward (a human
//      opens units to view DURING the conversation, well before booking — earlier than open_unit's book/deposit).
//   2. AVAILABILITY — grantUnit itself only opens a published + currently-open unit (tile status 0); an
//      unpublished/held/closed/sold unit is refused there (409). We surface that as a clean "not available".
//   3. SCOPE — the buyer/building/desk are resolved SERVER-SIDE from the dealId (directParties), never from the
//      model. So the AI can only ever open a unit in ITS OWN deal's building, to ITS OWN deal's buyer. The model
//  supplies only a unitId; it never sees or names an account (privacy, — no PII reaches the prompt).
//
// Unlike open_unit (a HOLD — reserves the unit, auto-releases), reveal_unit is non-exclusive and reversible: it
// just makes the unit visible to this buyer. No signing seam, no hold, no sidecar hold-write. A separate, lighter
// act. (It DOES advance the buyer's funnel to units_opened inside grantUnit — a legitimate deliberate-offer event.)
//
// Pure of the LLM transport; reads conversations-direct + the catalog + writes the grant store. Unit-testable with
// a seeded catalog + a temp cwd.

import { can } from "./permissions";
import type { ToolScope } from "./query-tools";
import { grantUnit } from "../unit-grants";
import { directParties } from "../conversations-direct";
import { getBuildingSnapshot } from "../status-store";
import { getBuyerDirect, advanceFunnel, funnelRank } from "../buyers-direct";
import { publish } from "../bus";
import { grantTopic } from "../grant-topic";

/** The scope the reveal action needs beyond the read-only ToolScope: just the deal id (the buyer + desk are
 * resolved server-side from it). No config authority toggle — reveal is autonomous by decision
 *  (it's reversible + only opens available units), the same always-available posture as the read-only tools. */
export type RevealScope = ToolScope & {
  /** The deal/conversation id — resolves {buyer, building, developer} via directParties (server-side, no PII up). */
  dealId: string;
};

export type RevealUnitOutcome =
  | { ok: true; outcome: "opened"; unitId: string }
  | { ok: false; outcome: "denied"; reason: "matrix" | "no_unit" | "unavailable" | "no_deal" | "failed" };

/**
 * Open (reveal) a unit into the buyer's in-app view for this deal. Runs the matrix gate, resolves the deal's
 * parties server-side, then calls the SAME operator grant a human desk uses. Returns a structured outcome the
 * dispatcher renders for the model:
 *   opened — the unit is now in the buyer's "units opened to you" list (they see it in the app); the AI confirms.
 *   denied — a gate refused (matrix / no such unit / not available to open / can't resolve the deal); the AI
 *            answers honestly and never claims it opened something it didn't.
 */
export async function revealUnit(scope: RevealScope, args: { unitId: string }): Promise<RevealUnitOutcome> {
  const unitId = (args.unitId ?? "").trim();
  if (!unitId) return { ok: false, outcome: "denied", reason: "no_unit" };

  // Gate 1 — the permission matrix (phase-gated: qualify onward).
  if (can(scope.persona, scope.phase, "reveal_unit") !== "allow") {
    return { ok: false, outcome: "denied", reason: "matrix" };
  }

  // Resolve the deal's parties server-side (the buyer account never enters the model). Fail-closed if the deal
  // can't be scoped (no conversation, no desk developer). The building the unit opens into is ALWAYS the deal's
  // building (parties.building) — the model only supplies a unitId, never a building, so it can't open a unit
  // into another deal's building. A unitId that isn't a currently-open unit of THIS building is caught below.
  const parties = await directParties(scope.dealId);
  if (!parties) return { ok: false, outcome: "denied", reason: "no_deal" };

  // The availability gate: only a published + currently-open unit (snapshot tile status 0) of THIS deal's building
  // may be opened to a buyer. A unit not in this building's snapshot (a unit from another building, or a ghost) has
  // no tile 0 here → unavailable (fail-closed). This IS the load-bearing check for the AI path: the operator ROUTE
  // (POST /api/unit-grants) runs this same tile-0 gate, but the lib grantUnit does NOT — so we must run it here
  // (otherwise the AI could open a held/unpublished unit). It mirrors the route's gate exactly (status !== 0 → 409).
  const snap = await getBuildingSnapshot(parties.building);
  const status = snap?.units?.[unitId];
  if (status !== 0) return { ok: false, outcome: "denied", reason: "unavailable" };

  // Fire the SAME operator grant the human desk uses (caller = the desk developer = the authorized desk).
  const grant = await grantUnit(parties.buyer, parties.building, unitId, parties.developer);
  if (!grant) return { ok: false, outcome: "denied", reason: "failed" };

  // Parity with the operator route (POST /api/unit-grants): opening a unit is a funnel event → auto-advance the
  // buyer to units_opened (monotonic, never regresses), and push the buyer's "units opened to you" topic so the
  // unit appears without a reload. Best-effort — a funnel/push hiccup must not undo a completed grant.
  try {
    const buyer = await getBuyerDirect(parties.buyer);
    if (buyer && funnelRank(buyer.funnel) < funnelRank("units_opened")) {
      await advanceFunnel(parties.buyer, "units_opened");
    }
    publish(grantTopic(parties.buyer));
  } catch {
    // the grant is placed; the funnel nudge + push are convenience — swallow a fault so the reveal still succeeds.
  }

  return { ok: true, outcome: "opened", unitId };
}
