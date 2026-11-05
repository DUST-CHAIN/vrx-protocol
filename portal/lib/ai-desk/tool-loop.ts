// AI Sales Director — the TOOL-LOOP dispatcher (the design docs §4, Option B). SERVER-ONLY.
// Maps a model-emitted {type:"query", tool, args} action to the matching slice-2 query tool, runs it (the tool
// itself consults the permission matrix), and formats the RESULT compactly for the model to read on the next
// round. This is the bridge that makes real data reach the AI WITHOUT ever sending it the raw catalog: the
// model asks "find 1-bed <$65k", we return "71 match; best 3: …" — reduced, matrix-gated, server-side.
//
// Pure of the LLM transport (decide.ts owns the round loop). Pure-ish: it reads the catalog via the query
// tools (fs), but has no network/model dependency, so it's unit-testable with a seeded catalog.

import { findUnits, unitDetail, buildingTerms, checkAvailability, type ToolScope } from "./query-tools";
import { openUnit, type ActionScope } from "./open-unit";
import { revealUnit, type RevealScope } from "./reveal-unit";
import { recordDeposit } from "./deposit";
import type { Persona, Phase } from "./permissions";

/** The tool names the model may call. Kept as a closed set so an unknown tool is a clean "unknown tool" result
 *  (not an error) — the model simply learns it asked for something that doesn't exist and moves on.
 * (slice 6): open_unit + record_deposit are the first STATEFUL (action) tools — they need the ActionScope
 *  (dealId + canOpenUnit + buyer), so runTool takes an optional `action` context the loop supplies. */
export const TOOL_NAMES = ["find_units", "unit_detail", "building_terms", "check_availability", "reveal_unit", "open_unit", "record_deposit"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(s: unknown): s is ToolName {
  return typeof s === "string" && (TOOL_NAMES as readonly string[]).includes(s);
}

/** Build the scope a tool runs under from the context's persona + phase + building. The caller (decide) owns
 *  these — the model never supplies the building id, so a conversation can't read another building's data. */
export function toolScope(persona: Persona, phase: Phase, buildingId: string): ToolScope {
  return { persona, phase, buildingId };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined);

/**
 * Run ONE query tool and return a COMPACT, model-readable string. Never throws (a fault → a short note the
 * model can read). A matrix-denied tool returns a plain "not available in this context" line — the model never
 * sees a raw value it wasn't granted. The strings are deliberately terse (token cost + the model only needs the
 * reduced facts, not JSON ceremony).
 */
/** The extra context the STATEFUL action tools (open_unit / record_deposit) need beyond the read-only scope:
 *  the deal id, the live canOpenUnit toggle, and the buyer account. The loop supplies it (from the DeskContext +
 *  config); the read-only query tools ignore it. Absent ⇒ the action tools refuse (no deal to act on). */
export type ToolActionContext = {
  dealId: string;
  canOpenUnit: boolean;
  buyer?: string;
  /** The signing posture (slice 9, cfg.signingPosture). "vault" ⇒ a hold needs a one-time human
   *  authorization; absent ⇒ "soft_hold" (the stub). */
  signingPosture?: import("./types").AiDeskConfig["signingPosture"];
  /** The one-time human authorization for the vault, if one has been presented for THIS deal/unit (posture
   *  "vault" only). Supplied by the approval channel (TAN / TG-OTP) — until that channel is wired, a vault-posture
   *  hold correctly resolves to "needs_authorization". */
  authorization?: import("./signing-vault").PresentedAuth;
};

export async function runTool(
  scope: ToolScope,
  tool: string,
  args: Record<string, unknown> = {},
  action?: ToolActionContext
): Promise<string> {
  try {
    switch (tool) {
      case "find_units": {
        const r = await findUnits(scope, {
          beds: str(args.beds) ?? num(args.beds),
          maxBudgetUsd: num(args.maxBudgetUsd) ?? num(args.budget),
          view: str(args.view),
          limit: num(args.limit),
        });
        if (!r.ok) return deniedLine("inventory");
        if (r.data.matchCount === 0) return r.data.note ?? "No matching units.";
        const lines = r.data.units.map(
          (u) =>
            `${u.id}: ${u.typeLabel}, floor ${u.floor}, ${u.sqm}m², $${u.priceUsd.toLocaleString()}` +
            (u.view ? `, ${u.view}` : "") +
            (u.corner ? ", corner" : "")
        );
        const more = r.data.matchCount > r.data.units.length ? ` (${r.data.matchCount} match in total; showing the best ${r.data.units.length})` : "";
        return `${r.data.matchCount} unit(s) match${more}:\n${lines.join("\n")}`;
      }
      case "unit_detail": {
        const r = await unitDetail(scope, { unitId: str(args.unitId) ?? "" });
        if (!r.ok) return deniedLine("unit_detail");
        if (!r.data) return "No such unit.";
        const u = r.data;
        return `${u.id}: ${u.typeLabel}, floor ${u.floor}, ${u.sqm}m², $${u.priceUsd.toLocaleString()}` +
          (u.view ? `, ${u.view}` : "") + (u.corner ? ", corner" : "") + (typeof u.baths === "number" ? `, ${u.baths} bath` : "");
      }
      case "building_terms": {
        const r = await buildingTerms(scope, { unitId: str(args.unitId) });
        if (!r.ok) return deniedLine("building_terms");
        if (!r.data || Object.keys(r.data).length === 0) return "No published terms for this building.";
        return formatTerms(r.data);
      }
      case "check_availability": {
        const r = await checkAvailability(scope, { unitId: str(args.unitId) ?? "" });
        if (!r.ok) return deniedLine("inventory");
        return `Unit ${str(args.unitId) ?? ""} is ${r.data}.`;
      }
      case "reveal_unit": {
        if (!action) return "(cannot open a unit to view — no active deal context.)";
        const unitId = str(args.unitId) ?? "";
        const rScope: RevealScope = { ...scope, dealId: action.dealId };
        const r = await revealUnit(rScope, { unitId });
        if (r.ok && r.outcome === "opened") {
          return `Opened unit ${r.unitId} to the customer — it now shows in their "units opened to you" list in the app, with the photos and the unit's details. Tell them it's open to view there; invite them to look. (This is NOT a hold — it doesn't reserve the unit; offer to hold it separately if they want it secured.)`;
        }
        const whyR: Record<string, string> = {
          matrix: "opening a unit to view isn't available at this stage of the conversation",
          no_unit: "no unit id was given to open",
          unavailable: `unit ${unitId} isn't available to open (it's unpublished, held, closed, sold, or not in this building)`,
          no_deal: "there's no active deal to open a unit into",
          failed: `unit ${unitId} couldn't be opened`,
        };
        return `Could not open unit ${unitId} to view (${whyR[r.reason] ?? r.reason}). Do not tell the customer it's open to view in the app; if it's a photo/detail they want, say you'll get it to them another way.`;
      }
      case "open_unit": {
        if (!action) return "(cannot hold a unit — no active deal context.)";
        const unitId = str(args.unitId) ?? "";
        const aScope: ActionScope = {
          ...scope,
          dealId: action.dealId,
          canOpenUnit: action.canOpenUnit,
          signingPosture: action.signingPosture,
          authorization: action.authorization,
        };
        const r = await openUnit(aScope, { unitId });
        if (r.ok && r.outcome === "held") {
          return `Held unit ${r.unitId} for this deal. It's reserved for the customer and will auto-release if the deal stalls — confirm the reservation deposit to keep it secured.`;
        }
        if (r.ok && r.outcome === "propose") {
          return `Autonomous holds are off for this desk — do NOT claim the unit is held. Instead offer to arrange a hold: "shall I hold unit ${r.unitId} for you while we finalise?" (a colleague will confirm it).`;
        }
        if (r.ok && r.outcome === "needs_authorization") {
          // The signing vault requires a one-time human approval (slice 9). The AI must NOT claim a hold; it tells
          // the customer the hold needs a quick internal sign-off, and (internally) a human authorizer is pinged.
          const whyA: Record<string, string> = {
            needs_authorization: "it needs a one-time sign-off from the desk",
            scope_mismatch: "the approval on file is for a different unit",
            used: "that approval was already used",
            expired: "the approval has expired",
            revoked: "the approval was cancelled",
          };
          return `Do NOT claim unit ${r.unitId} is held — holding it ${whyA[r.reason] ?? "needs a one-time sign-off"}. Tell the customer you're getting it reserved now and will confirm shortly.`;
        }
        // denied — tell the model plainly why, so it answers honestly (never confabulate a hold).
        const why: Record<string, string> = {
          matrix: "holding isn't available at this stage of the conversation",
          unavailable: `unit ${unitId} isn't available to hold`,
          already_held: `unit ${unitId} is already being held for another customer`,
          no_desk: "this building has no desk configured to hold against",
          no_unit: `there's no unit ${unitId} to hold`,
        };
        return `Could not hold the unit (${why[r.reason] ?? r.reason}). Do not tell the customer it's held.`;
      }
      case "record_deposit": {
        if (!action) return "(cannot record a deposit — no active deal context.)";
        const aScope: ActionScope = { ...scope, dealId: action.dealId, canOpenUnit: action.canOpenUnit };
        const amountUsd = num(args.amountUsd) ?? num(args.amount) ?? NaN;
        const r = await recordDeposit(aScope, { amountUsd, method: "other", buyer: action.buyer });
        if (r.ok && r.outcome === "recorded") {
          return r.confirmed
            ? `Reservation deposit recorded and CONFIRMED for unit ${r.unitId}. The unit is secured.`
            : `Reservation deposit recorded for unit ${r.unitId} — it will show as confirmed once the payment settles. Tell the customer it's recorded (not yet "paid/confirmed").`;
        }
        const whyD: Record<string, string> = {
          matrix: "a deposit can't be taken at this stage",
          no_hold: "there's no held unit to take a deposit against — hold the unit first",
          bad_amount: "the deposit amount wasn't a valid figure",
          no_desk: "this building has no desk configured",
        };
        return `Could not record the deposit (${whyD[(r as { reason: string }).reason] ?? "unavailable"}). Do not tell the customer it's paid.`;
      }
      default:
        return `Unknown tool "${tool}". Available tools: ${TOOL_NAMES.join(", ")}.`;
    }
  } catch {
    return "That lookup failed; proceed without it.";
  }
}

function deniedLine(category: string): string {
  return `(${category} is not available to share in this context.)`;
}

/** Compact, plain-English terms rendering — only the fields that exist (the only-what-exists reduction already
 *  happened in buildingTerms; here we just phrase it). Percentages read as "from X%"; dollars plainly. */
function formatTerms(t: import("./query-tools").RealTerms): string {
  const parts: string[] = [];
  if (t.depositPctOptions?.length) parts.push(`Deposit: ${t.depositPctOptions.join("% / ")}%`);
  if (typeof t.reservationFeeUsd === "number") parts.push(`Reservation fee: $${t.reservationFeeUsd.toLocaleString()}`);
  else if (t.bookingFeeUsdOptions?.length) parts.push(`Booking fee: $${t.bookingFeeUsdOptions.map((n) => n.toLocaleString()).join(" / $")}`);
  if (typeof t.contractDays === "number") parts.push(`S&P to be signed within ${t.contractDays} days of reserving`);
  if (t.instalmentPlan?.onContract?.length) {
    const oc = t.instalmentPlan.onContract.map((i) => `${i.installments}×${i.amountPct}%`).join(" + ");
    parts.push(`On contract: ${oc}`);
  }
  if (t.instalmentPlan?.ongoing?.length) {
    const og = t.instalmentPlan.ongoing.map((i) => `${i.installments}×${i.amountPct}%`).join(" + ");
    parts.push(`Instalments: ${og}`);
  }
  if (t.onKeyPctOptions?.length) parts.push(`On handover: ${t.onKeyPctOptions.join("% / ")}%`);
  if (typeof t.furniturePerSqmUsd === "number") parts.push(`Furniture pack: $${t.furniturePerSqmUsd}/m²`);
  if (t.taxPctOptions?.length) parts.push(`Tax: ${t.taxPctOptions.join("% / ")}%`);
  if (typeof t.maintenancePerSqmUsd === "number") parts.push(`Maintenance: $${t.maintenancePerSqmUsd}/m²`);
  if (t.transferFeePct) parts.push(`Transfer fee: ${t.transferFeePct}`);
  if (t.completion) parts.push(`Completion: ${t.completion}`);
  return parts.length ? parts.join("\n") : "No published terms for this building.";
}
