// VRX in-process CHANGE BUS — SERVER-ONLY. The seam between "something in a shared store changed"
// and "push that to connected clients" ( real-time, swappable transport).
// WHY A BUS (not file-tailing): the event mirror (lib/events.ts) and the channel store (lib/channels.ts)
// are the single sources of truth. Rather than have the SSE layer watch their files, the WRITERS bump a
// monotonic revision here when they change. The SSE endpoint (app/api/events/stream) subscribes and pushes
// a lightweight "tick" to the browser, which then re-reads the normal query routes (api/claims,
// /api/channels/[id]). The tick is a SIGNAL, not the payload — so privacy and the shared-mirror
// contract are untouched, and a WebSocket / near.email transport can later subscribe to this SAME bus
// without changing a single writer.
// SCOPE: one bump = "the inbox should refresh". We keep two channels so a client can be selective:
// • "events" — the mirror advanced (new/changed booking or unit status).
// • "channel:<requestId>" — a message landed in that thread.
// A subscriber may listen to all topics (the SSE connection does) and let the client decide what to pull.
// SINGLE PROCESS ONLY: this is an in-memory bus, correct for the demo's single Node server (and the
// self-managed container on Denis' box — one instance). A multi-instance deploy would need the bus backed
// by Redis/pg LISTEN or similar; noted as a future seam, not needed for the beachhead.

type Listener = (topic: string) => void;

const listeners = new Set<Listener>();

/** Monotonic revision — bumped on every change. A client that reconnects can compare to catch a miss. */
let revision = 0;

/** The current revision (so a fresh SSE connection can send an initial baseline). */
export function currentRevision(): number {
  return revision;
}

/**
 * Announce that a shared store changed. `topic` is "events" (the mirror advanced) or
 * "channel:<requestId>" (a thread got a message). Bumps the revision and notifies every listener.
 * Never throws — a listener error must not break the writer that called us.
 */
export function publish(topic: string): void {
  revision++;
  for (const l of listeners) {
    try {
      l(topic);
    } catch {
      /* a broken subscriber must never affect the store writer or the other subscribers */
    }
  }
}

/** Subscribe to every bump. Returns an unsubscribe fn (call it on SSE disconnect). */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How many subscribers are currently connected — the SSE sync loop uses this to idle when nobody watches. */
export function subscriberCount(): number {
  return listeners.size;
}
