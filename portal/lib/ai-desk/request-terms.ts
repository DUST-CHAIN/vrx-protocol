// AI Sales Director — the request_terms tool (the design docs §terms). SERVER-ONLY.
// The desk's ROUTING-ONLY path for a buyer's OUT-OF-RANGE terms ask: when the buyer asks in CHAT for a figure
// beyond the developer's published range, the desk files a TermRequest so the developer sees it on /node — the
// SAME queue the overlay form feeds. The in-range case is NOT this tool's job (the desk accepts those directly,
//  2b; and the overlay sliders are bounded by caps). This tool ONLY routes an out-of-range ask to the human.
//
// WHY ROUTING-ONLY: the desk must NEVER compose the out-of-range numbers (that would be inventing a
// term it has no authority for — the confabulation risk). It recognizes the ask, and hands it to the developer.
// If the model mislabels an IN-range figure as out-of-range, this module's own range-check catches it and tells
// the model to just accept it — so a routing mistake can't create a pointless developer work item.
//
// SCOPE: buyer/building/developer are resolved SERVER-SIDE from the dealId (directParties) — the model never
// supplies them. PRIVACY: a TermRequest carries only the neutral money ask + the (model-provided) note; the
// note came through the already-scrubbed context, so no raw PII reaches the store.

import { directParties } from "../conversations-direct";
import { getBuilding, effectiveTerms } from "../catalog";
import { isAskInRange, rangeBreach, type TermsMilestone, type AcceptableRanges } from "../payment-plan";
import { fileTermRequest } from "./term-requests";
import { can, type Persona, type Phase } from "./permissions";

export type RequestTermsScope = {
  persona: Persona;
  phase: Phase;
  buildingId: string;
  /** The deal/conversation id — resolves {buyer, building, developer} via directParties (server-side). */
  dealId: string;
};

export type RequestTermsOutcome =
  | { ok: true; outcome: "filed"; ask: string }
  | { ok: true; outcome: "in_range"; milestone: TermsMilestone; value: number } // the model mislabelled an in-range figure
  | { ok: false; outcome: "denied"; reason: "matrix" | "no_deal" | "no_ask" | "failed" };

/** Build the acceptable-range shape from a building's effective caps (the SAME derivation query-tools uses). */
async function rangesForBuilding(buildingId: string): Promise<AcceptableRanges | undefined> {
  const bld = await getBuilding(buildingId);
  if (!bld) return undefined;
  // effectiveTerms needs a unit to resolve a unit-override; the building default is the common case — derive
  // from the first unit (any unit yields the building-level caps when there's no per-unit override).
  const terms = bld.inventory?.[0] ? effectiveTerms(bld, bld.inventory[0]) : bld.terms ?? null;
  const c = terms?.caps;
  if (!c) return undefined;
  const bound = (min?: number, max?: number) =>
    min != null || max != null ? { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) } : undefined;
  return {
    depositPct: bound(c.depositPctMin, c.depositPctMax),
    onContractPct: bound(c.onContractPctMin, c.onContractPctMax),
    onKeyPct: bound(c.onKeyPctMin, c.onKeyPctMax),
    instalments: bound(c.instalmentsMin, c.instalmentsMax),
  };
}

const MS: TermsMilestone[] = ["depositPct", "onContractPct", "onKeyPct", "instalments"];

/**
 * File a term request for an OUT-OF-RANGE ask the desk heard in chat. Gates:
 *   matrix  — building_terms must be allowed in this phase (the desk only routes terms once it's discussing them).
 *   no_deal — the dealId doesn't resolve to a live direct conversation (can't scope the parties).
 *   no_ask  — neither a structured (milestone+value) ask nor a free-text note was given.
 * If a STRUCTURED ask is actually IN range, returns `in_range` (the model should accept it, not escalate) — the
 * self-correcting guard. Otherwise files the request + returns `filed` with a short human ask line.
 */
export async function requestTerms(
  scope: RequestTermsScope,
  args: { milestone?: string; value?: number; note?: string }
): Promise<RequestTermsOutcome> {
  // Gate on the SAME permission as reading terms — the desk may only route a terms ask where it may discuss terms.
  if (can(scope.persona, scope.phase, "building_terms") !== "allow") {
    return { ok: false, outcome: "denied", reason: "matrix" };
  }

  const milestone = MS.includes(args.milestone as TermsMilestone) ? (args.milestone as TermsMilestone) : undefined;
  const value = typeof args.value === "number" && isFinite(args.value) ? args.value : undefined;
  const note = typeof args.note === "string" ? args.note.trim() : "";
  if (!milestone && !note) return { ok: false, outcome: "denied", reason: "no_ask" };

  const parties = await directParties(scope.dealId);
  if (!parties) return { ok: false, outcome: "denied", reason: "no_deal" };

  // Self-correcting guard: if the model routed a STRUCTURED ask that is actually in range, don't file — tell it
  // to accept the figure (2b). A free-text-only ask (no milestone) can't be range-checked → always files.
  let breach: { side: "below" | "above"; bound: number } | undefined;
  if (milestone && typeof value === "number") {
    const ranges = await rangesForBuilding(parties.building);
    if (isAskInRange(ranges, milestone, value)) {
      return { ok: true, outcome: "in_range", milestone, value };
    }
    breach = rangeBreach(ranges, milestone, value) ?? undefined;
  }

  try {
    await fileTermRequest({
      dealId: scope.dealId,
      buildingId: parties.building,
      developer: parties.developer,
      ...(milestone ? { milestone } : {}),
      ...(typeof value === "number" ? { askedValue: value } : {}),
      ...(breach ? { breach } : {}),
      ...(note ? { note } : {}),
      source: "desk",
    });
  } catch {
    return { ok: false, outcome: "denied", reason: "failed" };
  }

  const unit = milestone === "instalments" ? "" : "%";
  const ask = milestone && typeof value === "number" ? `${milestone} ${value}${unit}` : note || "a custom structure";
  return { ok: true, outcome: "filed", ask };
}
