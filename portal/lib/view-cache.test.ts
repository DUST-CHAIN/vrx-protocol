// Freeze the Slice-2 server view-cache (INDEXER_DESIGN.md). It must: cache only the allowlisted stable
// reads, serve a cached NULL as a HIT (negative caching — unregistered accounts must not re-burn reads),
// expire by TTL, key correctly by method+args (incl. arg-order independence), and invalidate at three
// granularities. Pure logic + one real-clock expiry probe. Run via tsx.

import {
  isCacheable,
  getCachedView,
  setCachedView,
  invalidateView,
  cachedViewCount,
} from "./view-cache";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

function main() {
  invalidateView(); // clean slate (the cache is a module-level singleton)

  // ── Allowlist: only stable role/config methods are cacheable; availability/claim/gate reads are NOT ──
  ok(isCacheable("get_owner"), "get_owner cacheable");
  ok(isCacheable("get_node"), "get_node cacheable");
  ok(isCacheable("get_org"), "get_org cacheable");
  ok(isCacheable("get_peer"), "get_peer cacheable");
  ok(isCacheable("get_toll"), "get_toll cacheable");
  ok(isCacheable("get_treasury"), "get_treasury cacheable");
  ok(isCacheable("get_hold_window"), "get_hold_window cacheable");
  ok(!isCacheable("get_tile"), "get_tile NOT cacheable (availability must stay fresh)");
  ok(!isCacheable("get_hold_expiry"), "get_hold_expiry NOT cacheable");
  ok(!isCacheable("get_claim"), "get_claim NOT cacheable");
  ok(!isCacheable("get_pending_claims"), "get_pending_claims NOT cacheable");
  ok(!isCacheable("get_gate"), "get_gate NOT cacheable (gates money — stays fresh)");
  ok(!isCacheable("can_access"), "can_access NOT cacheable");
  ok(!isCacheable("get_agreement"), "get_agreement NOT cacheable");

  // ── Miss on an empty cache ──────────────────────────────────────────────────────────────────────────
  ok(getCachedView("get_node", { id: "dev.testnet" }) === null, "cold miss");

  // ── Store then HIT, returning the exact value (wrapped so null is distinguishable from a miss) ───────
  setCachedView("get_node", { id: "dev.testnet" }, { a: true, h: "abc" });
  const hit = getCachedView("get_node", { id: "dev.testnet" });
  ok(hit !== null, "warm hit");
  ok(JSON.stringify(hit?.value) === JSON.stringify({ a: true, h: "abc" }), "hit returns the stored value");

  // ── NEGATIVE CACHING: a cached null (unregistered account) is a HIT, not a miss ──────────────────────
  setCachedView("get_peer", { id: "nobody.testnet" }, null);
  const neg = getCachedView("get_peer", { id: "nobody.testnet" });
  ok(neg !== null, "cached null is a HIT (negative caching) — not re-read");
  ok(neg?.value === null, "cached null hit carries value null");

  // ── Arg-order independence: {a,b} and {b,a} must collide (same canonical key) ────────────────────────
  setCachedView("get_gate" as string, {}, 1); // non-cacheable → no-op, must not throw
  ok(getCachedView("get_gate", {}) === null, "setCachedView is a no-op for non-cacheable methods");
  // use a cacheable method with multi-key args to prove order independence
  setCachedView("get_node", { id: "x", extra: "y" }, "V");
  ok(getCachedView("get_node", { extra: "y", id: "x" })?.value === "V", "arg order doesn't change the key");

  // ── Different args → different entries (no cross-contamination) ──────────────────────────────────────
  setCachedView("get_node", { id: "a.testnet" }, "A");
  setCachedView("get_node", { id: "b.testnet" }, "B");
  ok(getCachedView("get_node", { id: "a.testnet" })?.value === "A", "entry A isolated");
  ok(getCachedView("get_node", { id: "b.testnet" })?.value === "B", "entry B isolated");

  // ── Invalidation: single entry ───────────────────────────────────────────────────────────────────────
  invalidateView("get_node", { id: "a.testnet" });
  ok(getCachedView("get_node", { id: "a.testnet" }) === null, "single-entry invalidate drops just that key");
  ok(getCachedView("get_node", { id: "b.testnet" })?.value === "B", "sibling entry survives single invalidate");

  // ── Invalidation: whole method (e.g. after set_toll, drop every get_toll) ────────────────────────────
  setCachedView("get_toll", {}, "100");
  setCachedView("get_node", { id: "b.testnet" }, "B");
  invalidateView("get_node");
  ok(getCachedView("get_node", { id: "b.testnet" }) === null, "method invalidate drops all get_node");
  ok(getCachedView("get_toll", {})?.value === "100", "method invalidate leaves other methods alone");

  // ── Invalidation: everything ─────────────────────────────────────────────────────────────────────────
  invalidateView();
  ok(cachedViewCount() === 0, "full invalidate clears the cache");

  // ── TTL expiry (injectable clock). get_owner's TTL is 10 min; store now, then read with a `now` set
  // just BEFORE and just AFTER expiry to pin both sides of the boundary deterministically (no real wait). ─
  const t0 = Date.now();
  setCachedView("get_owner", {}, "calculating-hand.testnet"); // expiresAt = t0 + 10min
  ok(getCachedView("get_owner", {}, t0 + 60_000)?.value === "calculating-hand.testnet", "live 1min after store");
  ok(getCachedView("get_owner", {}, t0 + 9 * 60_000)?.value === "calculating-hand.testnet", "live 9min after store");
  ok(getCachedView("get_owner", {}, t0 + 11 * 60_000) === null, "expired 11min after store (past 10min TTL)");
  // The expired read must also PURGE the entry (not just report a miss) — confirm it's gone from the map.
  ok(getCachedView("get_owner", {}, t0) === null, "expired entry was purged, not merely reported stale");

  console.log(fail === 0 ? `view-cache: ${pass}/${pass} PASS` : `view-cache: ${fail} FAILED, ${pass} passed`);
  if (fail > 0) process.exit(1);
}

main();
