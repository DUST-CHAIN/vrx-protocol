// Off-market state logic — pure, shared, OFF-CHAIN. No `fs`, no React → safe to import
// from both the API route (server) and the developer dashboard (client).
// • A developer can take a unit OFF-MARKET in two ways:
// (hold for phase-2 pricing, reserve for a company/shop, executive/VIP hold, external party).
// Fully REVERSIBLE — un-block floats it back to available, typically with a price update.
// Reversible only via an explicit un-kill.
// • A block is a REASON + MEMORY, not just a flag: note + category + who + when, carried forward
// in an append-only history so a LATER decision is informed.
// THE ANTI-FRAUD GUARD ( — "no fraud, no holes"): off-chain blocking can NEVER silently override a
// LIVE on-chain reservation. You may only block/kill a unit whose on-chain tile status is OPEN (0) or
// NOT STAMPED (-1). A unit with a live hold/booking/sale (1/2/3) must be removed through the recorded
// lawful cancellation door (cancel/terminate per the contract), NOT hidden behind an off-chain flag.

import type {
  Unit,
  OffMarket,
  OffMarketEvent,
  OffMarketState,
  BlockCategory,
} from "./catalog-client";

/** On-chain tile status codes (mirror of TILE_STATUS in lib/vrx). */
export const OPEN = 0;
export const HOLD = 1;
export const CLOSED = 2;
export const DONE = 3;
export const UNSTAMPED = -1;

/** A unit is on-market (bookable, subject to on-chain status) only if it has no off-market state. */
export function isOffMarket(unit: Unit): boolean {
  return unit.offMarket != null;
}

/**
 * Buyer-facing status adjustment: off-market units are DEVELOPER-ONLY, so for an agent/agency view
 * we force any blocked/killed unit to "unavailable" (2) in the status map — it can't be booked and doesn't
 * count as available. Returns a NEW map (does not mutate). The developer view passes the raw map (they
 * see + manage off-market units); only the buyer-facing screens apply this.
 */
export function hideOffMarketInStatus(
  units: Unit[],
  status: Record<string, number>
): Record<string, number> {
  let changed = false;
  const adjusted = { ...status };
  for (const u of units) {
    if (u.offMarket && adjusted[u.id] !== 2) {
      adjusted[u.id] = 2;
      changed = true;
    }
  }
  return changed ? adjusted : status;
}

export function isBlocked(unit: Unit): boolean {
  return unit.offMarket?.state === "blocked";
}

export function isKilled(unit: Unit): boolean {
  return unit.offMarket?.state === "killed";
}

/**
 * Killed units are EXCLUDED from every stat (mirrors the operator catalog's `unit_killed=0` filter): sold m², area
 * totals, quota math, availability counts. Blocked units still COUNT in totals (they're inventory the
 * developer is holding, not destroyed) but are not AVAILABLE. This predicate is the one to use when
 * summing a building's real, sellable inventory.
 */
export function countsInStats(unit: Unit): boolean {
  return !isKilled(unit);
}

/**
 * The anti-fraud guard. Returns null if the unit may be taken off-market, or a reason string if it
 * may NOT (because a live on-chain reservation exists — that must go through the lawful cancellation door
 * instead). `onChainStatus` is the unit's current on-chain tile status (-1..3); pass what the server read.
 */
export function offMarketBlockedReason(onChainStatus: number | undefined): string | null {
  // Unknown status (never read) is treated as safe-to-block only when explicitly open/unstamped. If we
  // genuinely don't know, refuse — better to make the developer confirm availability than to hide a live
  // reservation by accident. Callers that have a fresh read pass 0/-1 here.
  if (onChainStatus === OPEN || onChainStatus === UNSTAMPED) return null;
  if (onChainStatus === HOLD) return "This unit has a live hold on-chain — cancel the hold first.";
  if (onChainStatus === CLOSED || onChainStatus === DONE)
    return "This unit has a live booking/sale on-chain — removal must follow the recorded cancellation.";
  return "This unit's availability could not be confirmed on-chain — refresh its status, then try again.";
}

/** Whether `killed` (regulatory) vs `blocked` is the appropriate state for a chosen category. */
export function defaultStateFor(category: BlockCategory): OffMarketState {
  return category === "regulatory" ? "killed" : "blocked";
}

// ── Pure transitions — each returns a NEW OffMarket (or clears it), append-only history ──

type ActorNote = {
  reason: string;
  category: BlockCategory;
  by: string;
  confirmedBy?: string;
  at?: number; // injectable for tests; defaults to Date.now()
};

/** Put a unit off-market (block or kill). Appends to history; carries forward any prior history. */
export function applyOffMarket(
  prior: OffMarket | undefined,
  state: OffMarketState,
  note: ActorNote
): OffMarket {
  const at = note.at ?? Date.now();
  const event: OffMarketEvent = {
    action: state === "killed" ? "kill" : "block",
    reason: note.reason,
    category: note.category,
    by: note.by,
    at,
    confirmedBy: note.confirmedBy,
  };
  return {
    state,
    reason: note.reason,
    category: note.category,
    by: note.by,
    at,
    confirmedBy: note.confirmedBy,
    history: [...(prior?.history ?? []), event],
  };
}

/**
 * Reverse an off-market state → back on-market. Returns { offMarket: undefined } to clear it, plus the
 * history event to preserve (the caller drops the field but keeps the trail on the unit if it wants).
 * Since clearing removes the field, we return the trail so the UI/audit can still surface "was blocked,
 * released on [date] at [new price]" ( — reversible WITH context). The optional new price is recorded
 * for the audit trail; the caller applies it to the live unit.priceUsd in the same step.
 */
export function reverseOffMarket(
  prior: OffMarket,
  by: string,
  newPriceUsd?: number,
  at: number = Date.now()
): { history: OffMarketEvent[] } {
  const event: OffMarketEvent = {
    action: prior.state === "killed" ? "unkill" : "unblock",
    reason: "Released back to market",
    category: prior.category,
    by,
    at,
    newPriceUsd,
  };
  return { history: [...prior.history, event] };
}
