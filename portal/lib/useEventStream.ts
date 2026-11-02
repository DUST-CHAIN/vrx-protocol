// useEventStream — CLIENT hook. Subscribes to the server's /api/events/stream SSE push and calls
// back on each "tick", so the inbox refreshes on real change instead of polling every 60s (the poll that
// caused the /api/* 120/min 429s). Transport-swappable: the component talks to THIS hook, not to
// EventSource directly, so a WebSocket / near.email delivery can replace the wire without touching callers.
// Robustness: EventSource reconnects on its own, but if the server is unreachable it can thrash — we don't
// fight it; the caller pairs this with a SLOW safety poll so a dropped stream still catches up eventually.

"use client";

import { useEffect, useRef } from "react";

export type StreamTick = { topic: string; revision: number };

/**
 * Open an SSE connection to `/api/events/stream` for the lifetime of the component and invoke `onTick`
 * for every push. `onTick` is kept in a ref so the subscription isn't torn down on every render (the
 * caller can pass an inline closure freely). Returns nothing; cleanup closes the connection.
 *
 * @param onTick called with the tick topic ("events" | "channel:<requestId>") on each server push.
 * @param enabled when false, no connection is opened (e.g. signed-out).
 */
export function useEventStream(onTick: (tick: StreamTick) => void, enabled = true): void {
  const cb = useRef(onTick);
  cb.current = onTick;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const es = new EventSource("/api/events/stream");
    const handler = (e: MessageEvent) => {
      try {
        cb.current(JSON.parse(e.data) as StreamTick);
      } catch {
        /* malformed frame — ignore */
      }
    };
    es.addEventListener("tick", handler as EventListener);
    return () => {
      es.removeEventListener("tick", handler as EventListener);
      es.close();
    };
  }, [enabled]);
}
