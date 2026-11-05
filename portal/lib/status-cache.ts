// Server-side building-status cache — the primary fix for the FastNEAR 429.
//
// THE PROBLEM: every client that opened a building read one get_tile per unit (216 for Miracle
// Tower). The public RPC 429-rate-limits after ~125 rapid reads → the grid stalled "125/216" live.
// Load scaled as (clients × units).
//
// THE FIX: OUR server reads the chain ONCE per building, caches the whole status map with a short
// TTL, and bakes `status` onto each unit in /api/catalog. Clients make ONE request to us and do ZERO
// direct RPC reads for the grid. Load collapses to (~units once, shared across all clients).
//
// The cache lives in the Next.js server process memory — no external service. Locally it's warm as
// long as `npm run dev` runs; on the Denis/Coolify box it's a long-lived process shared by every
// phone/browser, which is where this pays off most (memory). WRITES stay trustless + direct: the
// client still signs stamps against the chain; only the read/display path is cached (secs-stale, fine
// for DISPLAY — the tradeoff). After a client stamps, it requests ?fresh=1 to rebuild the slice.
//
// This is the pragmatic 80% of a full event indexer with no separate service. When live
// "someone just booked that" push is needed, this component UPGRADES into the push-fed cache —
// same shape, better feed.

import { readBuildingStatus, readUnitsStatus } from "./vrx-server";
import { getBuildingSnapshot, saveBuildingStatuses } from "./status-store";

// How long a cached status map is served before a refresh. Short: the chain moves when someone
// stamps/books, and a stamp triggers an explicit invalidate anyway, so this is just the ceiling on
// staleness for changes made by OTHERS. 15s keeps the grid feeling live without hammering the RPC.
// 90s: a building's availability rarely changes minute-to-minute, and a stamp/book explicitly
// invalidates its cache anyway. A longer TTL is the single biggest lever against RPC saturation —
// it stops the progressive fill from re-reading hundreds of tiles on every navigation/reload (which
// was starving the critical get_peer/get_gate picker reads → false "no access").
const TTL_MS = 90_000;

type Entry = {
  status: Record<string, number>; // unitId → tile status (0..3, or -1 not stamped)
  builtAt: number; // epoch ms the map was computed
  inflight: Promise<Record<string, number>> | null; // dedupe concurrent refreshes
};

const cache = new Map<string, Entry>();

export type BuildingStatus = {
  status: Record<string, number>;
  /** epoch ms the status was read from chain (for a "as of …" hint client-side). */
  asOf: number;
  /** true if this response was served from a still-fresh cache (not a fresh chain read). */
  cached: boolean;
  /** true if the RPC was unreachable and we served the persisted snapshot instead (UI: "network busy"). */
  busy?: boolean;
  /** where the served values came from, for the UI's "as of" detail. */
  source?: "chain" | "snapshot" | "cache";
};

/**
 * Get the building's per-unit status map, reading the chain only when the cache is missing/stale (or
 * `force`). Concurrent callers during a refresh share ONE chain read (inflight dedupe) — 10 phones
 * opening the same building at once trigger a single read, not ten.
 */
export async function getBuildingStatus(
  buildingId: string,
  unitIds: string[],
  force = false
): Promise<BuildingStatus> {
  const now = Date.now();
  const entry = cache.get(buildingId);

  if (!force && entry && now - entry.builtAt < TTL_MS) {
    return { status: entry.status, asOf: entry.builtAt, cached: true };
  }

  // A refresh is already running (from another request) and we're not forcing — join it.
  if (!force && entry?.inflight) {
    const status = await entry.inflight;
    return { status, asOf: cache.get(buildingId)?.builtAt ?? now, cached: false };
  }

  const inflight = readBuildingStatus(buildingId, unitIds);
  // Record the inflight promise so concurrent callers dedupe onto it.
  cache.set(buildingId, {
    status: entry?.status ?? {}, // keep serving the last-known map to any TTL reader mid-refresh
    builtAt: entry?.builtAt ?? 0,
    inflight,
  });

  try {
    const status = await inflight;
    const builtAt = Date.now();
    cache.set(buildingId, { status, builtAt, inflight: null });
    return { status, asOf: builtAt, cached: false };
  } catch (e) {
    // Refresh failed entirely — clear the inflight flag; serve stale if we have it, else rethrow.
    if (entry) {
      cache.set(buildingId, { ...entry, inflight: null });
      return { status: entry.status, asOf: entry.builtAt, cached: true };
    }
    cache.delete(buildingId);
    throw e;
  }
}

/**
 * PARTIAL / progressive status (A1, — the lazy-load): read the status of ONLY the requested
 * units (a chunk of the grid, or a single clicked unit), MERGE into the shared building cache, and
 * return the merged status for those units + everything else already cached. This is the engine behind
 * the lazy grid: the client asks for small chunks (showing a progress spinner as each lands) instead of
 * baking all 476 up front, and any read warms the shared cache for the next viewer. Cached-fresh
 * units are served without a re-read; only the not-yet-known ones hit the chain.
 */
export async function getUnitsStatusMerged(
  buildingId: string,
  unitIds: string[],
  force = false
): Promise<BuildingStatus> {
  const now = Date.now();
  const entry = cache.get(buildingId);

  // The PERSISTED SNAPSHOT is the AUTHORITATIVE BASE for browsing (the idea): a durable per-unit map
  // captured by the manual pass (and, later, kept live by the indexer), surviving reloads. We serve
  // it directly and DO NOT re-read the chain on every view — that's the whole point of the snapshot. A
  // fresh, authoritative read is only needed at booking time (the open_claim tx enforces availability
  // on-chain anyway). So: trust the snapshot within a staleness window; only hit the chain for units NO
  // layer knows, or when the snapshot is stale AND we have no fresh in-memory cache.
  const snap = await getBuildingSnapshot(buildingId);
  const known: Record<string, number> = { ...(snap?.units ?? {}), ...(entry?.status ?? {}) };

  // A unit needs a live read only if NO layer knows it (absent from both the snapshot and the in-memory
  // cache). Everything the snapshot/cache holds is served as-is — we never re-poll known units on the
  // browse path (that's what tripped the RPC block). Freshness for KNOWN units is the job of the indexer
  // (push updates) or an explicit "Live"/refresh, not per-request polling.
  //
  // FORCE: an EXPLICIT refresh — the developer's ↻ Refresh, or a floor-tap after they've
  // stamped — must re-read the chain for the REQUESTED units even when the snapshot already "knows" them
  // (as -1). Without this, the snapshot's known value is sticky: your own fresh stamp never shows because
  // the browse path skips a unit the snapshot holds. Force re-reads exactly the requested slice (bounded,
  // not the whole building) and overwrites the snapshot with the truth, so the actor sees their own action.
  const need = force ? unitIds : unitIds.filter((id) => known[id] === undefined);

  if (need.length === 0) {
    return {
      status: known,
      asOf: snap?.filledAt ?? entry?.builtAt ?? now,
      cached: true,
      source: snap ? "snapshot" : "cache",
    };
  }

  // Read the chain for what we still need. If the RPC is unreachable (429 storm / IP cooldown), DON'T
  // fail — serve the snapshot/cache we have and flag `busy` so the UI can say "network busy, showing
  // availability as of <time>". This is the graceful-degrade asked for.
  try {
    const read = await readUnitsStatus(buildingId, need);
    const merged = { ...known, ...read };
    cache.set(buildingId, { status: merged, builtAt: now, inflight: entry?.inflight ?? null });
    // Persist newly-read values into the durable snapshot so the base keeps improving.
    void saveBuildingStatuses(buildingId, read).catch(() => {});
    return { status: merged, asOf: now, cached: false, source: "chain" };
  } catch {
    return {
      status: known,
      asOf: entry?.builtAt ?? snap?.filledAt ?? now,
      cached: true,
      busy: true,
      source: snap ? "snapshot" : "cache",
    };
  }
}

/** Invalidate a building's cached status (call after a stamp so the next read rebuilds it). */
export function invalidateBuilding(buildingId: string): void {
  const entry = cache.get(buildingId);
  if (entry) cache.set(buildingId, { ...entry, builtAt: 0 });
}

// ── Prioritize-on-open: gentle background refresh of a STALE building (the design) ──────
// The browse path never re-reads KNOWN units (that's what protects the RPC), so a complete snapshot's
// filledAt freezes — a building nobody stamped shows "cached 7h ago" forever. This closes that gap the
// safe way: when a building is OPENED and its snapshot is older than STALE_MS, kick ONE background
// re-read of the whole building so the snapshot (and its timestamp) freshens within moments — the
// "prioritize a cold building the moment someone views it" tier. Strictly bounded so it never bursts:
//   • non-blocking (fire-and-forget — the open response returns instantly from the snapshot);
//   • deduped (one refresh per building at a time, tracked in refreshing);
//   • throttled (skip if we refreshed this building within REFRESH_COOLDOWN_MS);
//   • self-limiting (readBuildingStatus is concurrency-capped + time-budgeted + retrying).
// If the RPC is blocked it just fails quietly and we keep serving the snapshot — no user impact.

/** A building's snapshot is "stale" (worth a background refresh on open) past this age. */
const STALE_MS = 10 * 60_000; // 10 min
/** Don't re-kick a building's background refresh more often than this. */
const REFRESH_COOLDOWN_MS = 5 * 60_000; // 5 min

const refreshing = new Set<string>();
const lastRefreshAt = new Map<string, number>();

/**
 * PURE decision for the background-refresh throttle, split out of refreshBuildingIfStale so the three
 * guards are testable without the module-level Set/Map or the fire-and-forget read. Returns true ONLY
 * when a stale-refresh should actually be kicked. This predicate IS the RPC-burst protection — a
 * regression that returns true too eagerly reopens the 429-storm this whole module exists to stop.
 * Guards (ALL must pass):
 *   • stale enough — a null snapshotAt means "never captured" → treated as Infinity age → stale;
 *   • not already refreshing this building (dedupe);
 *   • cooldown elapsed since the last kick (throttle).
 */
export function shouldRefreshStale(args: {
  snapshotAt: number | null;
  now: number;
  lastRefreshAt: number; // 0 = never refreshed
  alreadyRefreshing: boolean;
  staleMs?: number;
  cooldownMs?: number;
}): boolean {
  const { snapshotAt, now, lastRefreshAt, alreadyRefreshing } = args;
  const staleMs = args.staleMs ?? STALE_MS;
  const cooldownMs = args.cooldownMs ?? REFRESH_COOLDOWN_MS;
  const age = snapshotAt === null ? Infinity : now - snapshotAt;
  if (age < staleMs) return false; // fresh enough — nothing to do
  if (alreadyRefreshing) return false; // already refreshing
  if (now - lastRefreshAt < cooldownMs) return false; // refreshed recently — don't hammer
  return true;
}

/**
 * If `buildingId`'s snapshot is older than STALE_MS, kick a non-blocking background refresh (deduped +
 * cooldown-throttled). Returns immediately; the snapshot updates when the read lands. `snapshotAt` is
 * the served snapshot's filledAt (null = never captured → treat as stale). Safe to call on every open.
 */
export function refreshBuildingIfStale(
  buildingId: string,
  unitIds: string[],
  snapshotAt: number | null
): void {
  const now = Date.now();
  if (!shouldRefreshStale({
    snapshotAt,
    now,
    lastRefreshAt: lastRefreshAt.get(buildingId) ?? 0,
    alreadyRefreshing: refreshing.has(buildingId),
  })) return;

  refreshing.add(buildingId);
  lastRefreshAt.set(buildingId, now);
  // Fire-and-forget. readBuildingStatus persists into the snapshot (via getUnitsStatusMerged's save on
  // the chain path) — here we go straight through getBuildingStatus(force) which reads + persists.
  void (async () => {
    try {
      const { status } = await getBuildingStatus(buildingId, unitIds, true);
      // Persist into the durable snapshot so filledAt advances + the next viewer serves fresh.
      await saveBuildingStatuses(buildingId, status);
    } catch {
      /* RPC busy/blocked — keep serving the existing snapshot, try again after cooldown */
    } finally {
      refreshing.delete(buildingId);
    }
  })();
}
