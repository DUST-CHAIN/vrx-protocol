// AI Sales Director — the open_unit ACTION tool (slice 6, the design docs §5). SERVER-ONLY.
// The first STATEFUL tool (the slice-2 query tools are read-only): when the AI decides to HOLD a unit for a deal,
// this resolves the desk, re-checks the unit is actually open, fires the signing SEAM (lib/ai-desk/signing-seam —
// a sealed off-chain soft-hold in the demo, the real vault later), and WRITES the deal sidecar's held/release
// fields. This is where the sidecar finally gets its writer (the §6 foundation from slice 5a comes alive).
//
// ── Gating (defence in depth) ──────────────────────────────────────────────────────────────────────────
// Three gates, fail-closed, before any hold is placed:
//   1. the PERMISSION MATRIX — open_unit is `deny` in base, `allow` only at the book/deposit phases (so the AI
//      can't hold a unit while still browsing). Checked here via can(persona, phase, "open_unit").
//  2. the CONFIG toggle canOpenUnit — the per-action authority switch (default ON per D- flip OFF
//      VRX-root). Passed in by the loop (it reads the live AiDeskConfig). OFF ⇒ the tool PROPOSES, never holds.
//   3. AVAILABILITY — the unit must be on-market/bookable AND not already soft-held by another live deal. We
//      never hold a unit that's taken (the cheap, definitive negative).
// Because the hold is autonomous (canOpenUnit ON), the slice-7 auto-release timers are the mandatory safety net
// — a mistaken hold self-frees (the signing seam stamps an L1 2h window; the timer escalates/releases).
//
// Pure of the LLM transport; reads the catalog (fs) + writes two stores (holds, sidecar). Unit-testable with a
// seeded catalog + a temp cwd.

import { checkAvailability, type ToolScope } from "./query-tools";
import { can } from "./permissions";
import { signGrantExclusive } from "./signing-seam";
import { unitSoftHeld, activeHoldForDeal } from "./unit-holds";
import { upsertSidecar } from "./deal-sidecar";
import { deskDeveloperFor } from "../conversations-direct";
import type { AiDeskConfig } from "./types";
import type { PresentedAuth } from "./signing-vault";

/** The scope an ACTION tool needs beyond the read-only ToolScope: the deal id (to key the hold + sidecar) and
 *  the live canOpenUnit toggle (the config authority the loop reads). The buildingId/persona/phase come from the
 *  base ToolScope. Kept separate so the read-only query tools stay free of action concerns. */
export type ActionScope = ToolScope & {
  /** The deal/conversation id — the hold + sidecar key (DeskContext.conversationId). */
  dealId: string;
  /** The live per-action authority: may the AI hold a unit autonomously? (cfg.canOpenUnit). */
  canOpenUnit: boolean;
  /** The signing posture (slice 9, cfg.signingPosture). Omitted ⇒ "soft_hold" (the stub). When "vault",
   *  a hold requires a one-time human `authorization` below; without it the outcome is "needs_authorization". */
  signingPosture?: AiDeskConfig["signingPosture"];
  /** The one-time human authorization to present to the vault (posture "vault" only). */
  authorization?: PresentedAuth;
  /** Optional "now" hook for tests/replay — the hold window is relative to it. */
  asOf?: number;
};

export type OpenUnitOutcome =
  | { ok: true; outcome: "held"; unitId: string; releaseAt: number; onChain: boolean; authorized: boolean }
  | { ok: true; outcome: "propose"; unitId: string; reason: "toggle_off" }
  // The vault posture refused the signature (slice 9). The AI asks a human for the one-time approval and holds
  // nothing. `reason` distinguishes "none presented" from a presented-but-invalid one (so the reply is honest).
  | { ok: true; outcome: "needs_authorization"; unitId: string; reason: "needs_authorization" | "scope_mismatch" | "used" | "expired" | "revoked" }
  | { ok: false; outcome: "denied"; reason: "matrix" | "unavailable" | "already_held" | "no_desk" | "no_unit" };

/**
 * Attempt to open (hold) a unit for a deal. Runs the three gates, then fires the signing seam + writes the
 * sidecar. Returns a structured outcome the dispatcher renders for the model:
 *   held     — the soft-hold is placed; the sidecar now carries heldUnitId/releaseAt; the AI confirms + the
 *              timers will free it if the deal stalls.
 *   propose  — canOpenUnit is OFF: the AI must ASK a human to hold (the design's propose-only posture); no hold.
 *   denied   — a gate refused (matrix/availability/resolution); the AI answers honestly, never confabulates a hold.
 */
export async function openUnit(scope: ActionScope, args: { unitId: string }): Promise<OpenUnitOutcome> {
  const unitId = (args.unitId ?? "").trim();
  if (!unitId) return { ok: false, outcome: "denied", reason: "no_unit" };

  // Gate 1 — the permission matrix (phase-gated: only at book/deposit).
  if (can(scope.persona, scope.phase, "open_unit") !== "allow") {
    return { ok: false, outcome: "denied", reason: "matrix" };
  }

  // Gate 2 — the config authority. OFF ⇒ propose-only (the AI asks a human to hold), never an autonomous hold.
  if (!scope.canOpenUnit) {
    return { ok: true, outcome: "propose", unitId, reason: "toggle_off" };
  }

  // Gate 3a — the unit must be bookable (reuses the slice-2 availability tool — the real/chain-aware check).
  const avail = await checkAvailability(scope, { unitId });
  if (!avail.ok) return { ok: false, outcome: "denied", reason: "matrix" }; // matrix denied inventory → treat as denied
  if (avail.data === "unavailable") return { ok: false, outcome: "denied", reason: "unavailable" };
  if (avail.data === "unknown") return { ok: false, outcome: "denied", reason: "no_unit" };

  // Gate 3b — not already soft-held by ANOTHER live deal (don't double-hold). A re-hold by THIS deal is fine
  // (placeHold is idempotent/supersedes); we only block a unit a different deal currently holds.
  const asOf = Number.isFinite(scope.asOf) && (scope.asOf as number) > 0 ? (scope.asOf as number) : Date.now();
  if (await unitSoftHeld(scope.buildingId, unitId, asOf)) {
    const mine = await activeHoldForDeal(scope.dealId);
    const heldByMe = mine && !mine.released && mine.unitId.toLowerCase() === unitId.toLowerCase() && mine.buildingId.toLowerCase() === scope.buildingId.toLowerCase();
    if (!heldByMe) return { ok: false, outcome: "denied", reason: "already_held" };
  }

  // Resolve the desk the hold is signed as (the real flow's deskDeveloperFor — the same authority).
  const desk = await deskDeveloperFor(scope.buildingId);
  if (!desk) return { ok: false, outcome: "denied", reason: "no_desk" };

  // Fire the signing seam. STUB posture: a sealed off-chain soft-hold with an L1 window. VAULT posture (slice 9):
  // the seam first requires a one-time human authorization scoped to this unit+deal; without a valid one it
  // refuses and NO hold is placed (we surface "needs_authorization" and leave the sidecar's hold fields alone).
  const grant = await signGrantExclusive({
    dealId: scope.dealId,
    desk,
    buildingId: scope.buildingId,
    unitId,
    asOf,
    posture: scope.signingPosture,
    authorization: scope.authorization,
  });
  if (!grant.ok) {
    // The vault declined — the AI must obtain a one-time human approval. No hold, no sidecar hold-write.
    return { ok: true, outcome: "needs_authorization", unitId, reason: grant.reason };
  }

  // Write the sidecar: this deal now HOLDS this unit, with the auto-release anchor + level L1. The sidecar is
  // the AI's working memory (slice 5a); open_unit is its first writer. counterparty is buyer|agent (matrix
  // persona agency isn't a wired lane — see decide.personaOf), so narrow it for the sidecar's type.
  const counterparty: "buyer" | "agent" = scope.persona === "agent" ? "agent" : "buyer";
  await upsertSidecar(scope.dealId, scope.buildingId, counterparty, {
    phase: scope.phase,
    focusUnitId: unitId,
    heldUnitId: unitId,
    releaseAt: grant.releaseAt,
    releaseLevel: "l1",
    releaseWarned: false,
  });

  return { ok: true, outcome: "held", unitId, releaseAt: grant.releaseAt, onChain: grant.onChain, authorized: grant.authorized };
}
