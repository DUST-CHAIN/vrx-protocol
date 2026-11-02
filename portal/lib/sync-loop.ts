// VRX background SYNC LOOP — SERVER-ONLY. Keeps the event mirror fresh *while someone is watching*.
// The read routes (api/claims, /api/events) are cheap reads over the file-backed mirror; the mirror's
// freshness is owned by /api/events/sync (lib/event-fetch.syncEvents). Something has to call sync on a
// cadence. Rather than require an external cron, the SSE layer drives it: the loop ticks only while ≥1 SSE
// client is connected (subscriberCount > 0) and idles completely when nobody's watching — so we never
// burn FastNEAR quota for an empty room. When a sync adds events, ingestEvents publishes "events" on the
// bus, which the SSE connections turn into a client tick. This is the replacement for the 60s browser
// poll that caused the /api/* 120/min 429s: one server-side cadence feeds many clients by push.
// A real cron can still hit /api/events/sync (it's the freshness owner either way) — this loop is the
// zero-config demo path. It's a process singleton: many SSE connections share ONE loop.

import { syncEvents } from "./event-fetch";
import { subscriberCount } from "./bus";

/** How often to sync while clients are connected. With the block-walk OFF by default, a tick is now
 * just the cheap known-claims seed + a single head read, so the interval isn't burn-sensitive anymore;
 * ~15s keeps the seeded view responsive. If VRX_INDEXER_WALK=1 re-enables the walk, the tailer clears
 * ~40 blocks/tick so ~15s still keeps lag small. Override via env for tuning. */
const INTERVAL_MS = Number(process.env.VRX_SYNC_INTERVAL_MS || 15_000);

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * The pure tick DECISION (extracted so the quota-protection logic is testable without timers/RPC):
 * • "stop" — no audience → stop the loop entirely so an idle server does ZERO RPC work (the
 * "never burn FastNEAR quota for an empty room" invariant; the next SSE connect restarts it).
 * • "skip" — a previous tick is still running (slow archival round-trips) → skip this beat so we
 * never overlap sync calls (syncEvents also guards, but we avoid even calling it).
 * • "run" — audience present and idle → do the sync.
 * Order matters: the empty-room check wins over the in-flight check (stop beats skip).
 */
export function tickDecision(subscribers: number, ticking: boolean): "stop" | "skip" | "run" {
  if (subscribers === 0) return "stop";
  if (ticking) return "skip";
  return "run";
}

async function tick(): Promise<void> {
  const decision = tickDecision(subscriberCount(), ticking);
  if (decision === "stop") {
    stopSyncLoop();
    return;
  }
  if (decision === "skip") return;
  ticking = true;
  try {
    await syncEvents(); // publishes "events" on the bus iff it adds anything (lib/events.ingestEvents)
  } catch {
    /* transport hiccup — the mirror stays at its last good cursor; next tick retries */
  } finally {
    ticking = false;
  }
}

/** Start the shared sync loop if it isn't already running. Called when an SSE client connects. Idempotent. */
export function startSyncLoop(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), INTERVAL_MS);
  // Node keeps the event loop alive for an interval; unref so the loop never blocks a graceful shutdown.
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** Stop the loop (called when the last client leaves, or from within a tick that finds an empty room). */
export function stopSyncLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
