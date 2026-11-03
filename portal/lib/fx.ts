// SHARED static FX table — the ONE server-safe way to turn a stored minor-unit money figure in some
// currency into USD. Same rationale + shape as lib/near-rate.ts: NO "use client"/"server-only" directive on
// purpose, so a plain pure constant is importable from BOTH the client display layer (lib/currency.ts) AND the
// server-only money gates (the $VRX self-pay settlement in app/api/direct-deposits). A fixed demo rate keeps
// prices + settlement stable and auditable during a walkthrough (identical to currency.ts's design note); a
// live FX feed can slot in behind this one table later without touching any consumer.
//
// WHY THIS EXISTS. The $VRX self-pay path (D-) debits the buyer's $VRX ($VRX ≈ USD, 1:1 display
// convention) for a deposit that was RECORDED by the desk in the desk's own currency + minor units (e.g. THB
// satang). To charge the right $VRX amount we must convert the stored (amountMinor, currency) → USD SERVER-SIDE
// (never trust a client-sent USD figure for a money charge). currency.ts carries the same numbers but is
// "use client" (a React display context) so it can't be imported server-side — this is the pure-constant twin,
// the single source the client table should eventually derive from (noted as a follow-on; not refactored this
// pass to avoid churning currency.ts's many consumers).

import { NEAR_PER_USD } from "./near-rate";

/** Units of each currency per 1 USD (the static demo rate). Mirrors lib/currency.ts CURRENCIES.defaultPerUsd —
 *  kept in lock-step by hand for now (the client module is "use client"; collapsing them to this one table is
 *  the clean follow-on). An unknown currency is treated as already-USD (perUsd 1) — safe + deterministic. */
const PER_USD: Record<string, number> = {
  USD: 1,
  THB: 35,
  EUR: 0.92,
  GBP: 0.79,
  AED: 3.67,
  SGD: 1.35,
  ETH: 0.0004,
  BTC: 0.0000152,
  NEAR: NEAR_PER_USD,
};

/** Convert a stored minor-unit amount in `currency` to whole USD (rounded). `amountMinor` is in the currency's
 *  minor units (×100, e.g. satang/cents — the direct-deposit store's convention). An unknown currency falls back
 *  to treating the figure as USD (perUsd 1). Returns 0 for a non-positive/non-finite input (caller validates). */
export function minorToUsd(amountMinor: number, currency: string): number {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return 0;
  const perUsd = PER_USD[(currency || "USD").trim().toUpperCase()] ?? 1;
  const major = amountMinor / 100; // minor → major units of `currency`
  return Math.round(major / perUsd); // major-of-currency → USD
}
