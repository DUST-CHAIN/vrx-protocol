// Availability indexer — Slice 3: the standalone background poller (INDEXER_DESIGN.md).
//
// WHAT IT IS: a gentle, always-on loop that keeps the availability snapshot LIVE without anyone opening
// a building. Slice 1 made display correct (effective-status derive); Slice 2 killed the role/config
// key-burn (view-cache). This slice closes the last gap: a building nobody has opened recently has a
// FROZEN snapshot (status-cache's browse path never re-reads KNOWN units — that's what protects the RPC,
// but it means `filledAt` goes stale). The `refreshBuildingIfStale` already refreshes a stale
// building WHEN SOMEONE OPENS IT; this promotes that same safe refresh into a standalone loop that walks
// EVERY catalog building on its own cadence, so the snapshot stays current for the first viewer too.
//
// HOW IT STAYS GENTLE (INDEXER_DESIGN §design): hash-to-skip-unchanged. After each building poll we hash
// the resulting status map; an UNCHANGED hash means nothing moved, so we BACK OFF that building's cadence
// (idle buildings cost almost nothing). A CHANGED hash resets it to the base cadence (stay responsive
// while it's active). Chain load is bounded + predictable: N buildings once per their own cadence, SHARED
// across all users — never N × users × loads (the measured failure mode).
//
// IN-PROCESS NOW, EXTRACTABLE LATER (the Q1): this runs inside the Next.js server process
// (same lifecycle as status-cache / view-cache). The SCHEDULING CORE below is pure + side-effect-free, so
// Slice 4/5 can lift it into a standalone always-on process (or several, offset by slice set) with no
// rewrite — the harness at the bottom is the only part that touches timers/chain.
//
// DISPLAY-ONLY (INDEXER_DESIGN open-Q3): the poller never calls the on-chain `release`
// crank. Display correctness for expired holds comes from the Slice-1 effective-status derive
// (get_hold_expiry + now), which `readBuildingStatus` already applies. No gas, no settlement action.
//
// V7-SAFE: reads only STATE (get_tile via getBuildingStatus), stable V4→V7. No event-log coupling.

import { createHash } from "crypto";

// ── Tunables (display-acceleration cadence, revert here) ───────────────────────────────
/** Base re-poll interval for an ACTIVE building (its status changed on the last poll). */
export const BASE_CADENCE_MS = 45_000; // 45s — matches status-cache's "feels live" intent
/** Ceiling cadence for a building that keeps coming back UNCHANGED (fully backed off). */
export const IDLE_CADENCE_MS = 10 * 60_000; // 10 min
/** Each consecutive unchanged poll multiplies the cadence by this, capped at IDLE_CADENCE_MS. */
export const BACKOFF_FACTOR = 2;

/** Per-building scheduler state. Pure data — the core below transforms it; the harness persists nothing
 *  (a restart just re-polls everything at base cadence, which is correct + cheap). */
export type BuildingSchedule = {
  /** Hash of the last status map we saw (undefined = never polled → always due). */
  lastHash?: string;
  /** epoch ms of the last completed poll (0 = never). */
  lastPolledAt: number;
  /** current interval (ms) before this building is due again. */
  cadenceMs: number;
};

/** A fresh schedule entry for a building we've never polled — due immediately, at base cadence. */
export function initSchedule(): BuildingSchedule {
  return { lastHash: undefined, lastPolledAt: 0, cadenceMs: BASE_CADENCE_MS };
}

/**
 * Stable hash of a status map, order-independent (so {a:0,b:1} and {b:1,a:0} hash equal). Used only to
 * detect "did anything change since last poll" — not security-sensitive, sha256 is just convenient + the
 * same primitive the rest of the codebase hashes with. Empty/absent maps hash to a constant.
 */
export function hashStatusMap(status: Record<string, number>): string {
  const canonical = Object.keys(status)
    .sort()
    .map((k) => `${k}:${status[k]}`)
    .join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Is this building due for a poll? Due when it's never been polled, or `now` has reached
 * lastPolledAt + cadenceMs. Pure — the harness calls this against wall-clock `now`.
 */
export function isDue(sched: BuildingSchedule, now: number): boolean {
  if (sched.lastPolledAt === 0) return true;
  return now >= sched.lastPolledAt + sched.cadenceMs;
}

/**
 * Fold a completed poll's result into the schedule. CHANGED (new hash ≠ lastHash) → reset to base cadence
 * (stay responsive). UNCHANGED → multiply cadence by BACKOFF_FACTOR, capped at IDLE_CADENCE_MS (idle
 * buildings cost almost nothing). A first-ever poll (lastHash undefined) counts as CHANGED so a building
 * that happens to be empty/quiet still backs off from the SECOND poll on, not the first. Pure: returns a
 * NEW schedule, never mutates the input.
 */
export function applyPollResult(
  sched: BuildingSchedule,
  newHash: string,
  now: number
): BuildingSchedule {
  const changed = sched.lastHash === undefined || newHash !== sched.lastHash;
  const cadenceMs = changed
    ? BASE_CADENCE_MS
    : Math.min(sched.cadenceMs * BACKOFF_FACTOR, IDLE_CADENCE_MS);
  return { lastHash: newHash, lastPolledAt: now, cadenceMs };
}

// ── Runtime harness (the only part that touches timers + the chain) ──────────────────────────────────
// Kept thin + injectable so the pure core above is what carries the logic (and the tests). Slice 4/5 can
// replace this harness with a standalone process using the SAME core.

/** The outcome of polling one building. `failed` is how many unit reads timed out / errored this poll
 *  (they land in `status` as -1, indistinguishable from a real "not stamped" -1 — hence we carry the
 *  COUNT explicitly). A poll with failures is a LOW-CONFIDENCE reading: the -1 noise shifts run-to-run,
 *  so folding it into the change hash makes a quiet building look "changed" forever and defeats backoff
 * (the credit-burn root cause). `ok` is how many reads succeeded. */
export type PollOutcome = { status: Record<string, number>; ok: number; failed: number };

/** What the poller needs from the outside world — injected so tests never touch chain/timers. */
export type PollerDeps = {
  /** List the buildings to watch as { id, unitIds }. Reads the catalog in the real harness. */
  listBuildings: () => Promise<{ id: string; unitIds: string[] }[]>;
  /** Poll ONE building: read + persist its status (the real harness calls getBuildingStatus(force)),
   *  returning the status map + read-quality counts so we can hash CONFIDENTLY. Throws on total RPC
   *  failure (we skip + retry next tick). May return a bare map (legacy/test) → treated as all-ok. */
  pollBuilding: (id: string, unitIds: string[]) => Promise<PollOutcome | Record<string, number>>;
  /** epoch ms now (injectable clock). */
  now: () => number;
  /** optional: called after each building poll, for a debug/usage surface. */
  onPoll?: (id: string, changed: boolean, cadenceMs: number, confident: boolean) => void;
};

/** Normalise a pollBuilding return (bare map OR {status,ok,failed}) into a PollOutcome. A bare map is
 *  treated as a fully-successful read (ok=size, failed=0) so legacy/test deps keep working unchanged. */
export function toPollOutcome(r: PollOutcome | Record<string, number>): PollOutcome {
  if (r && typeof r === "object" && "status" in r && "ok" in r && "failed" in r) {
    return r as PollOutcome;
  }
  const status = r as Record<string, number>;
  return { status, ok: Object.keys(status).length, failed: 0 };
}

/** A poll is CONFIDENT enough to drive change-detection + backoff when it read substantially all tiles.
 *  A read with many failures is noise (shifting -1s) — we must NOT let it reset cadence to "changed".
 *  Rule: confident when nothing failed, OR failures are a small fraction (<10%) of the attempted reads.
 *  A poll where EVERYTHING failed (ok=0) is never confident (and the harness throws on total failure
 *  anyway, so it's left due). Pure. */
export function isConfidentPoll(ok: number, failed: number): boolean {
  const total = ok + failed;
  if (total === 0) return false;
  if (ok === 0) return false;
  return failed / total < 0.1;
}

/**
 * Run ONE tick: for every building that's DUE, poll it and fold the result into its schedule. Mutates the
 * passed `schedules` map in place (creating entries for new buildings). Returns the number of buildings
 * actually polled this tick (0 when nothing was due). A building whose poll throws is left unchanged (not
 * marked polled) so it's retried next tick — an RPC outage just means the snapshot holds, never corrupts.
 * The loop driver below calls this on an interval; it's separated out so a test can step it deterministically.
 */
export async function runTick(
  deps: PollerDeps,
  schedules: Map<string, BuildingSchedule>
): Promise<number> {
  const now = deps.now();
  const buildings = await deps.listBuildings();
  let polled = 0;
  for (const { id, unitIds } of buildings) {
    const sched = schedules.get(id) ?? initSchedule();
    if (!schedules.has(id)) schedules.set(id, sched);
    if (!isDue(sched, now)) continue;
    try {
      const { status, ok, failed } = toPollOutcome(await deps.pollBuilding(id, unitIds));
      const confident = isConfidentPoll(ok, failed);
      polled++;
      if (!confident) {
        // Low-confidence poll (many tile reads timed out → shifting -1 noise). DON'T fold it into the
        // change hash — that noise is exactly what made quiet buildings read "changed" every poll and
        // pinned them at base cadence (the credit-burn). Just stamp lastPolledAt so backoff keeps
        // marching on the LAST confident hash; the building is re-read next cadence tick.
        const next: BuildingSchedule = { ...sched, lastPolledAt: deps.now() };
        schedules.set(id, next);
        deps.onPoll?.(id, false, next.cadenceMs, false);
        continue;
      }
      const hash = hashStatusMap(status);
      const next = applyPollResult(sched, hash, deps.now());
      schedules.set(id, next);
      deps.onPoll?.(id, next.lastHash !== sched.lastHash, next.cadenceMs, true);
    } catch {
      // RPC busy/blocked for this building — leave its schedule untouched so it's due again next tick.
      // The snapshot keeps serving the last-known map (status-cache's graceful degrade).
    }
  }
  return polled;
}

// ── Singleton loop driver (in-process) ───────────────────────────────────────────────────────────────
// A single setInterval drives runTick. start is idempotent (guards against Next.js double-invocation
// dev / multiple route imports). TICK_MS is how often we CHECK for due buildings — the per-building cadence
// above decides which actually get polled, so a short tick just keeps the scheduler responsive; it does NOT
// mean every building is read every tick.
const TICK_MS = 5_000;
let timer: ReturnType<typeof setInterval> | null = null;
const schedules = new Map<string, BuildingSchedule>();

/**
 * Start the in-process poller with real deps. Idempotent — a second call is a no-op while running. Returns
 * stop. The real deps are passed in by the caller (a server bootstrap module) so this file stays free of
 * Next-specific imports and remains unit-testable via runTick.
 */
export function startPoller(deps: PollerDeps): () => void {
  if (timer) return stopPoller;
  // Fire one tick immediately so a cold start warms the snapshot without waiting a full tick, then interval.
  void runTick(deps, schedules);
  timer = setInterval(() => void runTick(deps, schedules), TICK_MS);
  // Don't keep the Node process alive just for the poller (so a CLI/test can exit cleanly).
  if (typeof timer.unref === "function") timer.unref();
  return stopPoller;
}

/** Stop the loop (and clear schedules so a later start re-polls fresh). */
export function stopPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  schedules.clear();
}

/** True while the loop is running — for a debug/status surface. */
export function isPollerRunning(): boolean {
  return timer !== null;
}

/** Snapshot of current schedules (debug/status surface; a copy, not the live map). */
export function pollerSchedules(): Record<string, BuildingSchedule> {
  return Object.fromEntries(schedules);
}
