// EFFECTIVE AVAILABILITY DERIVE — the indexer's Slice 1 (INDEXER_DESIGN.md §"The TRAP", c). PURE.
// THE SILENT GAP this closes. Availability changes two ways on-chain:
// • WRITE-driven (stamp/book/close/grant) — a tx mutates the tile → `get_tile.s` changes → any reader
// sees it. Reliable.
// • TIME-driven (the trap) — a timed hold EXPIRES by the CLOCK, not a tx. The contract frees it only when
// `release` or the lazy `open_claim` path fires (contract/src/lib.rs is_hold_expired/release_if_expired,
// ~lib.rs:1144-1170). Until then the STORED tile stays `status:1 (hold)` even though true availability is
// OPEN. So a naive "read get_tile.s" shows a unit as held that is really free — WRONG for a race-to-
// reserve product where "who got it first" is the whole game.
// THE DERIVE. When a tile reads `status:1 (hold)`, also read its expiry (`get_hold_expiry(unit_key)`, a view
// that exists precisely for this, lib.rs:1185) and serve the EFFECTIVE status: `now >= expiry ? OPEN: HOLD`.
// Every other status (open/closed/done/not-stamped) is returned unchanged — so only hold tiles pay the one
// extra read (calls are expensive). This is a DISPLAY accelerator only: even a stale display can't cause
// a bad booking — `open_claim` re-enforces availability on-chain and rejects a non-open unit. The
// contract remains the settlement authority; this just stops the browse grid from lying about a lapsed hold.
// ── THE UNIT BOUNDARY (the one subtlety — get it wrong and every hold looks expired or none do) ──────────
// `get_hold_expiry` returns NANOSECONDS (u64), because the contract compares against `env::block_timestamp`,
// which is ns. JS `Date.now` is MILLISECONDS. So `now` here is expressed in ns and callers convert with
// `Date.now * 1_000_000` (see msToNs). We use wall-clock now, not block time: it's within seconds of the
// chain's clock — ample for a display derive, and the on-chain re-check at booking is the real gate.

/** Status codes (mirror lib/status-ledger): 0 open · 1 hold · 2 closed · 3 done · -1 not stamped. */
export const STATUS_OPEN = 0;
export const STATUS_HOLD = 1;

/** Convert JS epoch milliseconds to the nanoseconds the contract's hold-expiry is denominated in. */
export function msToNs(ms: number): bigint {
  return BigInt(Math.trunc(ms)) * 1_000_000n;
}

/**
 * The DISPLAY status for a unit, given its raw on-chain `get_tile` status and (if it is a hold) the
 * hold-expiry. Pure — `nowNs` is injected so tests are deterministic.
 *
 * @param rawStatus the tile's stored status (0..3, or -1 not stamped) from get_tile.s
 * @param holdExpiryNs get_hold_expiry(unit_key): expiry in ns, or null/undefined if the tile has no timed
 * hold recorded. Only meaningful when rawStatus === HOLD.
 * @param nowNs current time in NANOSECONDS (msToNs(Date.now) in production; a fixed value in tests).
 * @returns the effective status: a hold whose expiry has passed becomes OPEN; everything else is
 * returned unchanged.
 */
export function effectiveStatus(
  rawStatus: number,
  holdExpiryNs: number | bigint | null | undefined,
  nowNs: bigint
): number {
  // Only a HOLD can be silently stale. Open/closed/done/not-stamped are write-driven and already truthful.
  if (rawStatus !== STATUS_HOLD) return rawStatus;
  // A hold with no recorded expiry is an untimed/indefinite hold — never auto-opens, leave it as HOLD.
  if (holdExpiryNs === null || holdExpiryNs === undefined) return STATUS_HOLD;
  const expiry = typeof holdExpiryNs === "bigint" ? holdExpiryNs : BigInt(Math.trunc(holdExpiryNs));
  // The contract frees the hold on `now >= until`; mirror that exactly so the derive and the chain agree at
  // the boundary (an at-the-instant expiry reads as OPEN, same as release_if_expired would do).
  return nowNs >= expiry ? STATUS_OPEN : STATUS_HOLD;
}
