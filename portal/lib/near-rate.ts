// SHARED static NEAR↔USD demo rate — the ONE source of truth for the NEAR price, imported by BOTH the
// client display layer (lib/currency.ts, "use client") AND the server-only eligibility/settlement gates
// (lib/offer-eligibility.ts, app/api/settlement/balance). No "use client"/"server-only" directive here on
// purpose: a plain pure constant is safe to import from either side, so neither half has to re-declare the
// number. (config-surface audit: USD_PER_NEAR in offer-eligibility was a SECOND literal that had to be
// kept in lock-step with currency.ts's NEAR entry by hand — a drift trap. This collapses them to one value.)
// STATIC BY DESIGN (same rationale as lib/currency.ts): a fixed demo rate keeps prices + the offer bar stable
// and auditable during a walkthrough. A live FX feed can slot in behind this one constant later without
// touching either consumer. This is NOT a per-developer/industry policy dial (an FX rate is global), so it is
// deliberately a plain constant, NOT a resolver surface — promoting it would be the speculative generality the
// craft card warns against (no per-party varying axis, one true value).

/** Static demo price of 1 NEAR in USD. The single source; everything else derives from this. */
export const USD_PER_NEAR = 5;

/** How many NEAR equal 1 USD — the inverse, for the display layer's `defaultPerUsd`. Derived, never re-typed. */
export const NEAR_PER_USD = 1 / USD_PER_NEAR; // 0.2
