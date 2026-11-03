// useUnreadConversations — CLIENT hook. The cross-booking UNREAD COUNT a role page feeds to its
// "Conversations" sidebar badge, so a party who LOGS ON sees "you have N unread" at a glance without opening
// the Conversations section (notify-on-login — the everlasting unit chat that lives for years).
//
// It reads the cheap server count (/api/conversations/unread — scoped + read-marker truth, survives
// device/login) on mount (= login) and again on any channel SSE tick (a new message landed somewhere) OR a
// generic "events" tick (a developer reply). Same transport-swappable seam as the Conversations roll-up
// (useEventStream, not EventSource directly). Returns 0 while signed-out / loading so the badge simply hides.
//
// Reusable across /node, /agent, /agency — the SAME route + rule for all three (one seam, three views).

"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventStream } from "./useEventStream";

export function useUnreadConversations(accountId: string | null): number {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!accountId) {
      setCount(0);
      return;
    }
    try {
      const r = await fetch(`/api/conversations/unread?viewer=${encodeURIComponent(accountId)}`);
      const d = await r.json();
      setCount(typeof d.count === "number" && d.count >= 0 ? d.count : 0);
    } catch {
      /* best-effort — leave the last known count; a transient failure shouldn't clear the badge */
    }
  }, [accountId]);

  // On mount / account change (= login) fetch the count so the badge paints before Conversations is opened.
  useEffect(() => {
    void load();
  }, [load]);

  // Any message landing in any thread ticks an opaque "channel:<token>" topic; a developer reply also ticks
  // "events". We can't tell from the opaque token which thread moved, so we just re-read the count (cheap).
  useEventStream((t) => {
    if (t.topic === "events" || t.topic.startsWith("channel:")) void load();
  }, !!accountId);

  return count;
}
