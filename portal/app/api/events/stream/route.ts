// GET /api/events/stream — Server-Sent Events PUSH over the shared mirror + channels.
//
// Replaces the browser's 60s poll (the one that caused the /api/* 120/min 429s) with one long-lived
// connection per client that the SERVER nudges on change. The client's inbox keeps an EventSource here
// and, on each nudge, re-reads the normal query routes (/api/claims, /api/channels/[id]). The nudge is a
// SIGNAL, not the payload — so privacy and the shared-mirror contract are untouched, and this exact
// endpoint shape can be backed by a WebSocket or near.email transport later without touching the client.
//
// Events emitted (SSE `event:` field):
//   • ready                      — once, on connect, with the baseline revision.
//   • tick  {topic, revision}    — a shared store changed; the client decides what to re-pull:
//         topic "events"            → the mirror advanced (new/changed booking or unit status) → refresh inbox.
//         topic "channel:<id>"      → that thread got a message → reload the thread if it's selected.
//   • :heartbeat (comment line)  — every 25s, so proxies/load-balancers don't idle-kill the connection.
//
// FRESHNESS: connecting kicks a best-effort sync immediately (so a just-opened inbox is current), and
// starts the shared background sync loop (lib/sync-loop) that keeps the mirror fresh *while clients are
// connected* and idles when the room is empty — the zero-config replacement for an external cron. A real
// cron hitting /api/events/sync still works and is the recommended prod path (see DEPLOY notes).

import { subscribe, currentRevision } from "@/lib/bus";
import { startSyncLoop } from "@/lib/sync-loop";
import { syncEvents } from "@/lib/event-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true; // controller closed under us (client vanished mid-write)
        }
      };
      // SSE framing: `event:` names the type, `data:` is the (JSON) payload, blank line terminates.
      const sendEvent = (event: string, data: unknown) =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Baseline so a reconnecting client can tell it may have missed a bump (revision jumped).
      sendEvent("ready", { revision: currentRevision() });

      // Every change on the bus becomes a client tick. The client re-pulls the relevant read route.
      const unsubscribe = subscribe((topic) => {
        sendEvent("tick", { topic, revision: currentRevision() });
      });

      // Keep-alive comment (`:` lines are ignored by EventSource) so intermediaries don't idle-close us.
      const heartbeat = setInterval(() => send(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      // Freshness on connect: sync once now (best-effort), and keep the shared loop running while we're here.
      startSyncLoop();
      void syncEvents().catch(() => {});

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // The client went away (tab closed, navigated) — tear down so the sync loop can idle if we were last.
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering (nginx) so events flush immediately rather than batching.
      "x-accel-buffering": "no",
    },
  });
}
