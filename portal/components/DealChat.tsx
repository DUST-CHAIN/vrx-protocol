// DealChat — the reusable booking channel UI (the design docs §2).
//
// Extracted from the twin inline `MessagesTab`s that lived in app/node/page.tsx and
// app/agency/page.tsx — byte-identical except for the viewer's SIDE of the conversation. One component
// now, parameterized by `viewerRole`, so the developer inbox, the agency observer, and the new agent
// "My bookings" surface all render the same thread the same way.
//
// THREE shapes, pick per consumer:
//   • <DealChat …>          STATELESS presenter. Thread + draft are OWNED BY THE PARENT (keyed by
//  requestId) and passed in. This is the lifted-state fix — because the draft
//                           doesn't live here, a list re-render (a booking moving Awaiting→Held on Accept)
//                           can never unmount this and wipe an unsent message. Use this in a MASTER-DETAIL
//                           inbox where ONE parent juggles many threads but shows one at a time (node, agency).
//   • useDealChat(reqId, viewer)  SELF-CONTAINED transport hook: owns load + SSE push + slow safety poll +
//                           send + its own draft, for ONE requestId. Use when a surface mounts MANY chats at
//                           once and there's no single "selected" thread for a parent to lift (the agent list).
//   • <DealChatPanel …>     useDealChat + DealChat wired together = the one-liner self-contained panel.
//
// TRANSPORT (invariant 3 / §2c): poll+append over /api/channels/[requestId]; SSE tick nudges the open
// thread. Swapping to WebSocket / near.email later changes delivery here, not the callers.
//
// PRIVACY: bodies are off-chain plaintext; the chain is never touched. The API authorizes the viewer
// as a participant (participantRole) — developer, the agent who made the offer, or that agent's agency.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { input, submitBtn } from "@/lib/ui";
import { T } from "@/lib/theme";
import { timeAgo } from "@/lib/catalog-client";
import { useEventStream } from "@/lib/useEventStream";
import { channelTopic } from "@/lib/channel-topic";
import BookingCode from "@/components/BookingCode";

// The message shape the channel API returns (mirror of lib/channels.ts ChannelMessage, client-facing).
// `vrx` is the SYSTEM origin (§3c) — not a party, never "mine"; it renders as a centred notice below.
export type Msg = { id: string; from: "developer" | "agent" | "buyer" | "vrx"; by: string; text: string; at: number };

/** Which side the current viewer posts on. "agent" covers an agent AND its supervising agency (sell side). */
export type ViewerRole = "developer" | "agent";

// Per-role copy — the only thing that differs between the two old presenters.
function sideCopy(viewer: ViewerRole) {
  const counterpart = viewer === "developer" ? "Agent" : "Developer";
  return {
    counterpart,
    empty:
      viewer === "developer"
        ? "No messages yet. Ask the agent about the buyer, terms, or deposit here."
        : "No messages yet. Ask the developer about this booking here.",
    placeholder: viewer === "developer" ? "Message the agent…" : "Message the developer…",
    footnote: `Messages are private to you and the ${counterpart.toLowerCase()}, kept off-chain. Updates live while this is open.`,
  };
}

// ── Stateless presenter ──────────────────────────────────────────────────────────────────────────────
export function DealChat({
  viewerRole,
  thread,
  draft,
  onDraft,
  onSend,
}: {
  viewerRole: ViewerRole;
  /** null = still loading; [] = loaded-and-empty. */
  thread: Msg[] | null;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (body: string) => void | Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgs = thread ?? [];
  const copy = sideCopy(viewerRole);

  // Keep the newest message in view when the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  async function send() {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await onSend(draft);
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      {thread === null ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, margin: "0 0 8px" }}>Loading messages…</p>
      ) : msgs.length === 0 ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, margin: "0 0 8px" }}>{copy.empty}</p>
      ) : (
        <div ref={scrollRef} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, maxHeight: 300, overflowY: "auto" }}>
          {msgs.map((m) => {
            // A SYSTEM (`vrx`) notice is neither "mine" nor the counterpart — it's VRX speaking to the whole
            // thread (§3c). Render it CENTRED and distinct so no one mistakes it for the other party's words.
            if (m.from === "vrx") {
              return (
                <div
                  key={m.id}
                  style={{
                    alignSelf: "center",
                    maxWidth: "92%",
                    padding: "6px 12px",
                    borderRadius: 10,
                    fontSize: 12.5,
                    lineHeight: 1.45,
                    textAlign: "center",
                    background: T.panel2,
                    border: `1px dashed ${T.borderSoft}`,
                    color: T.dim,
                  }}
                >
                  <div style={{ fontSize: 10.5, opacity: 0.7, marginBottom: 2, letterSpacing: 0.3 }}>
                    VRX · {timeAgo(m.at)}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                </div>
              );
            }
            const mine = m.from === viewerRole;
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: mine ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "6px 10px",
                  borderRadius: 10,
                  fontSize: 13,
                  lineHeight: 1.45,
                  background: mine ? T.accentSoft : T.panel2,
                  border: `1px solid ${T.borderSoft}`,
                }}
              >
                <div style={{ fontSize: 10.5, opacity: 0.55, marginBottom: 2 }}>
                  {mine ? "You" : copy.counterpart} · {timeAgo(m.at)}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={copy.placeholder}
          style={{ ...input, margin: 0, flex: 1 }}
          disabled={sending}
        />
        <button type="button" onClick={send} disabled={sending || !draft.trim()} style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, margin: 0 }}>
          {sending ? "…" : "Send"}
        </button>
      </div>
      <p style={{ fontSize: 10.5, opacity: 0.6, marginTop: 6, marginBottom: 0 }}>{copy.footnote}</p>
    </div>
  );
}

// ── Self-contained transport hook ───────────────────────────────────────────────────────────────────
// Owns thread + draft + load/poll/SSE/send for ONE requestId, posting as `viewerRole`/`me`. For surfaces
// that mount many chats at once (no single "selected" thread). The hook's own state means the draft
// survives as long as the hosting component stays mounted — the same guarantee the lifted parent gives.
export function useDealChat(requestId: string, viewerRole: ViewerRole, me: string) {
  const [thread, setThread] = useState<Msg[] | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    if (!requestId || !me) return;
    try {
      const r = await fetch(`/api/channels/${encodeURIComponent(requestId)}?viewer=${encodeURIComponent(me)}`);
      if (!r.ok) return; // not a participant / transient — keep the last known thread
      const j = (await r.json()) as { messages?: Msg[] };
      setThread(j.messages ?? []);
    } catch {
      /* transient — keep the last known thread */
    }
  }, [requestId, me]);

  // Initial load + slow safety poll (SSE fallback; visible-tab only), same cadence as the inboxes.
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 300_000);
    return () => clearInterval(timer);
  }, [load]);

  // Fast path: a message landing in THIS thread pushes the thread's opaque channel topic → reload now.
  useEventStream((t) => {
    if (t.topic === channelTopic(requestId)) void load();
  });

  const send = useCallback(
    async (body: string) => {
      const text = body.trim();
      if (!text || !me) return;
      try {
        const r = await fetch(`/api/channels/${encodeURIComponent(requestId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: viewerRole, by: me, text }),
        });
        if (r.ok) {
          setDraft("");
          await load();
        }
      } catch {
        /* leave the draft so the user can retry */
      }
    },
    [requestId, viewerRole, me, load]
  );

  return { thread, draft, setDraft, send };
}

// ── Self-contained panel = hook + presenter ─────────────────────────────────────────────────────────
export function DealChatPanel({
  requestId,
  viewerRole,
  me,
  showCode = true,
}: {
  requestId: string;
  viewerRole: ViewerRole;
  me: string;
  /** Show the short booking code (VRX-DDD-NNN) in a header bar — the quote-it-to-someone spot. */
  showCode?: boolean;
}) {
  const { thread, draft, setDraft, send } = useDealChat(requestId, viewerRole, me);
  return (
    <div>
      {showCode && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11.5, color: T.dim }}>Booking</span>
          <BookingCode requestId={requestId} size={12.5} />
        </div>
      )}
      <DealChat viewerRole={viewerRole} thread={thread} draft={draft} onDraft={setDraft} onSend={send} />
    </div>
  );
}
