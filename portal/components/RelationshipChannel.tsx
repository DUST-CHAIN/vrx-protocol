// RelationshipChannel — the Part D developer↔agency relationship-channel UI (docs/GOVERNED_CHANGE_DESIGN
// _S180.md). The relationship-context sibling of DealChat (booking) — same visual grammar (bubbles,
// a centred `vrx` system notice, a composer, the off-chain footnote) but a DIFFERENT transport + party set:
// it talks to /api/relationship-channel and the two sides are "developer" / "agency" (an agent posts as the
// agency). A cross-deal thread, not a per-booking one.
// Self-contained (like DealChatPanel): pass the (developer, agency) pair + the viewer `me`, and it resolves/
// starts the channel on mount, then loads + SSE-pushes + slow-polls + sends. The parent needs no channel id.
// TRANSPORT (invariant 3 / §2c): poll+append over /api/relationship-channel; the SSE tick (the same opaque
// channelTopic keyed on the channelId, published by lib/channels.postMessage) nudges the open thread. Swapping
// to WebSocket / near.email later changes delivery here, not callers.
// PRIVACY: bodies are off-chain plaintext; the chain is never touched. The API authorizes the viewer as a
// party (developer / agency / an agent of that agency) and resolves the author role server-side.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { input, submitBtn } from "@/lib/ui";
import { T } from "@/lib/theme";
import { timeAgo } from "@/lib/catalog-client";
import { useEventStream } from "@/lib/useEventStream";
import { channelTopic } from "@/lib/channel-topic";

// The message shape the relationship-channel API returns (mirror of lib/channels.ts ChannelMessage, client-
// facing). `vrx` is the SYSTEM origin — not a party, never "mine"; it renders as a centred notice below.
export type RelMsg = {
  id: string;
  from: "developer" | "agency" | "agent" | "buyer" | "vrx";
  by: string;
  text: string;
  at: number;
};

/** Which side the current viewer posts on. An agent of the agency reads/writes as "agency". */
export type RelationshipViewerRole = "developer" | "agency";

function sideCopy(viewer: RelationshipViewerRole) {
  const counterpart = viewer === "developer" ? "Agency" : "Developer";
  return {
    counterpart,
    empty:
      viewer === "developer"
        ? "No messages yet. Talk to this agency about buildings, terms, or a change here — not tied to one booking."
        : "No messages yet. Talk to this developer about buildings, terms, or a change here — not tied to one booking.",
    placeholder: viewer === "developer" ? "Message the agency…" : "Message the developer…",
    footnote: `Messages are private to you and the ${counterpart.toLowerCase()}, kept off-chain. This thread spans your whole relationship, not one deal.`,
  };
}

export default function RelationshipChannel({
  developer,
  agency,
  me,
}: {
  /** The developer (Node) account of the pair. */
  developer: string;
  /** The agency (Org) account of the pair. */
  agency: string;
  /** The viewer's account — must be the developer, the agency, or an agent of the agency. */
  me: string;
}) {
  const [channelId, setChannelId] = useState<string | null>(null);
  const [role, setRole] = useState<RelationshipViewerRole | null>(null);
  const [thread, setThread] = useState<RelMsg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Resolve/start the (developer, agency) channel, then load its thread. One request does both (GET path A).
  const load = useCallback(async () => {
    if (!developer || !agency || !me) return;
    try {
      const qs = new URLSearchParams({ viewer: me, developer, agency }).toString();
      const r = await fetch(`/api/relationship-channel?${qs}`);
      if (!r.ok) {
        // 404 = no relationship (no agreement); 403 = not a party. Either way there's nothing to show.
        if (thread === null) setError(r.status === 404 ? "no-relationship" : "not-a-party");
        return;
      }
      const j = (await r.json()) as { channelId?: string; role?: RelationshipViewerRole; messages?: RelMsg[] };
      if (j.channelId) setChannelId(j.channelId);
      if (j.role) setRole(j.role);
      setThread(j.messages ?? []);
      setError(null);
    } catch {
      /* transient — keep the last known thread */
    }
  }, [developer, agency, me, thread]);

  // Initial load + slow safety poll (SSE fallback; visible-tab only), same cadence as the deal chats.
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 300_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [developer, agency, me]);

  // Fast path: a message landing in THIS channel pushes the channel's opaque topic → reload now.
  useEventStream((t) => {
    if (channelId && t.topic === channelTopic(channelId)) void load();
  });

  // Keep the newest message in view when the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.length]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !me || !channelId || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/relationship-channel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ by: me, channelId, text }),
      });
      if (r.ok) {
        setDraft("");
        await load();
      }
    } catch {
      /* leave the draft so the user can retry */
    } finally {
      setSending(false);
    }
  }, [draft, me, channelId, sending, load]);

  if (error === "no-relationship") {
    return (
      <p style={{ fontSize: 12.5, opacity: 0.6, margin: 0 }}>
        No relationship channel — this opens once you and the {role === "developer" ? "agency" : "other party"} share an agreement.
      </p>
    );
  }
  if (error === "not-a-party") {
    return <p style={{ fontSize: 12.5, opacity: 0.6, margin: 0 }}>You don’t have access to this channel.</p>;
  }

  const copy = sideCopy(role ?? "developer");
  const msgs = thread ?? [];

  return (
    <div>
      {thread === null ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, margin: "0 0 8px" }}>Loading messages…</p>
      ) : msgs.length === 0 ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, margin: "0 0 8px" }}>{copy.empty}</p>
      ) : (
        <div
          ref={scrollRef}
          style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, maxHeight: 300, overflowY: "auto" }}
        >
          {msgs.map((m) => {
            // A SYSTEM (`vrx`) notice is neither "mine" nor the counterpart — VRX speaking to the whole thread.
            // Render it CENTRED + distinct so no one mistakes it for the other party's words.
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
            // "mine" = a message from the viewer's own side. The viewer's side is `role` (developer|agency); an
            // agent's own messages are stored as "agency", which matches when role==="agency".
            const mine = m.from === role;
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
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={copy.placeholder}
          style={{ ...input, margin: 0, flex: 1 }}
          disabled={sending || !channelId}
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !draft.trim() || !channelId}
          style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, margin: 0 }}
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
      <p style={{ fontSize: 10.5, opacity: 0.6, marginTop: 6, marginBottom: 0 }}>{copy.footnote}</p>
    </div>
  );
}
