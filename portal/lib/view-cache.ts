// Server-side VIEW cache for STABLE reads (indexer Slice 2, / INDEXER_DESIGN.md).
// THE PROBLEM (measured): /api/view is a pure pass-through proxy — every role resolution fires four
// uncached reads (get_owner/get_node/get_org/get_peer) at FastNEAR, per account × per fresh session.
// The escalation log (.data/fastnear-keys.json) is wall-to-wall exactly those method names — the role
// reads are the key-burner, firing per-load-per-user and exhausting even the keyed pool. role.tsx's
// sessionStorage only spares REPEAT loads in ONE browser session; it does nothing for a fresh session
// or for the shared server-side key pool. its status-cache already fixed the TILE reads; this is its
// twin for the ROLE/CONFIG reads — the other half of the "browse from our server" posture.
// THE FIX: our server caches the result of a small ALLOWLIST of STABLE view methods (roles + config),
// keyed by method+args, with a per-method TTL. A role changes ~never within a session; config changes
// only when the owner calls a set_* write (rare). So one chain read serves every user for the whole TTL
// window — chain load collapses from (accounts × sessions × 4) to (~distinct roles once per TTL).
// WHY ONLY THESE METHODS: availability (get_tile/get_hold_expiry), claims (get_claim/get_pending_claims),
// and relationships that gate money (get_gate/can_access/get_agreement) are NOT cached here — they must
// read fresh (tiles have their own status-cache path with explicit invalidation; claims/gates change per
// booking and a stale read there could mislead a race-to-reserve). This cache is deliberately scoped to
// reads whose staleness is harmless for the TTL window.
// NEGATIVE CACHING: get_node/get_org/get_peer returning null (an UNREGISTERED account) is the single most
// common role read — it MUST be cached too, or every unregistered visitor re-burns four reads. We cache
// null exactly like a hit (it IS the answer "no such record"). Only errors are never cached.
// V7-SAFETY (INDEXER_DESIGN §V7-safety): these are STATE view methods, stable V4→V7 (V7 only ADDS the
// vetting flag — additive). The cache is schema-agnostic (it stores whatever JSON the view returned), so
// a V7 field addition flows through untouched. This slice does NOT read the event log.
// standalone engine at Slice 3). Locally it's warm while `npm run dev` runs; on the Coolify box it's a
// long-lived process shared by every phone/browser — which is where it pays off most (same lifecycle as
// status-cache). A restart just re-warms on the next reads. No external store, no contract change.

/** Per-method TTL (ms). A method absent from this map is NOT cacheable — pass-through, read fresh. */
const TTL_BY_METHOD: Record<string, number> = {
  // Roles: an account's role changes ~never within a session (owner vets once, provisions once). 10 min
  // is long enough to erase the per-load burn while still re-verifying a freshly-onboarded account within
  // a reasonable window. Mirrors the role-cache TTL the design doc proposed (~10 min).
  get_owner: 10 * 60_000,
  get_node: 10 * 60_000,
  get_org: 10 * 60_000,
  get_peer: 10 * 60_000,
  // Config: changed only by an owner set_* write (set_toll/set_treasury/set_hold_window) — rare. A longer
  // TTL is safe; the owner-side write path can invalidate explicitly (invalidateView) right after a set_*.
  get_toll: 60 * 60_000,
  get_treasury: 60 * 60_000,
  get_hold_window: 60 * 60_000,
};

type Entry = {
  value: unknown; // the view result (may be null — a cached negative, see header)
  expiresAt: number; // epoch ms after which this entry is stale
};

const cache = new Map<string, Entry>();

/** True if this method's reads are eligible for caching (on the stable-reads allowlist). */
export function isCacheable(method: string): boolean {
  return method in TTL_BY_METHOD;
}

// Stable cache key: method + canonicalized args (keys sorted so {id:"a"} and the same object in any key
// order collide correctly). Args are small, opaque, JSON-safe ( hashes / account ids) — safe to serialize.
function keyOf(method: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args).sort();
  return `${method}|${JSON.stringify(args, sorted)}`;
}

/**
 * Look up a cached view result. Returns { value } (a HIT — value may be null, a cached negative) or null
 * (MISS — not cached, or expired, or the method isn't cacheable). Wrapping the value in an object lets the
 * caller distinguish "cached null" from "cache miss" without a sentinel.
 */
export function getCachedView(
  method: string,
  args: Record<string, unknown>,
  now = Date.now() // injectable clock — tests pass a far-future `now` to exercise the expiry branch
): { value: unknown } | null {
  if (!isCacheable(method)) return null;
  const entry = cache.get(keyOf(method, args));
  if (!entry) return null;
  if (now >= entry.expiresAt) {
    cache.delete(keyOf(method, args)); // expired — drop it so the map doesn't grow unbounded
    return null;
  }
  return { value: entry.value };
}

/**
 * Store a view result (only if the method is cacheable). A null `value` IS stored — it's the valid answer
 * "no such record" (negative caching). Never call this with an error result; errors are never cached so a
 * transient RPC failure can't pin a wrong answer for the whole TTL.
 */
export function setCachedView(method: string, args: Record<string, unknown>, value: unknown): void {
  const ttl = TTL_BY_METHOD[method];
  if (ttl === undefined) return; // not cacheable — no-op
  cache.set(keyOf(method, args), { value, expiresAt: Date.now() + ttl });
}

/**
 * Invalidate cached entries. With no method → clears everything (test/dev reset). With a method and no
 * args → clears every entry for that method (e.g. after set_toll, drop all get_toll). With method+args →
 * clears that one entry (e.g. after an owner register_node(id), drop get_node for that id so the newly
 * onboarded account resolves immediately instead of waiting out the TTL). The owner-side write paths are
 * the callers that keep this honest.
 */
export function invalidateView(method?: string, args?: Record<string, unknown>): void {
  if (!method) {
    cache.clear();
    return;
  }
  if (args) {
    cache.delete(keyOf(method, args));
    return;
  }
  const prefix = `${method}|`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/** Current cached-entry count — for a usage/debug surface (⚙ Settings) and tests. */
export function cachedViewCount(): number {
  return cache.size;
}
