// useDirectUnread — CLIENT hook. The cross-building UNREAD COUNT for DIRECT (pre-booking) desk conversations,
// the twin of useUnreadConversations (which counts booking threads only). Feeds a sidebar/button badge so a
// developer sees "N new direct enquiries" and a buyer sees "the desk replied" WITHOUT opening the thread —
// the gap hit: a desk reply landed with no badge or alert anywhere.
//
// Reads the cheap server count (/api/conversations-direct/unread — scoped + read-marker truth, survives
// device/login) on mount (= login) and again on any channel SSE tick (a message landed in some direct thread).
// Same transport-swappable seam as the booking hook (useEventStream, not EventSource directly). Returns 0
// while signed-out / loading so the badge simply hides. Used by BOTH /node (developer) and /buyer.

"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventStream } from "./useEventStream";

export function useDirectUnread(accountId: string | null): number {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!accountId) {
      setCount(0);
      return;
    }
    try {
      const r = await fetch(`/api/conversations-direct/unread?viewer=${encodeURIComponent(accountId)}`);
      const d = await r.json();
      setCount(typeof d.count === "number" && d.count >= 0 ? d.count : 0);
    } catch {
      /* best-effort — leave the last known count; a transient failure shouldn't clear the badge */
    }
  }, [accountId]);

  // On mount / account change (= login) fetch the count so the badge paints before the thread is opened.
  useEffect(() => {
    void load();
  }, [load]);

  // Any message in any direct thread ticks an opaque "channel:<token>" topic; a desk/funnel action can tick
  // "events". We can't tell from the opaque token which thread moved, so we just re-read the count (cheap).
  useEventStream((t) => {
    if (t.topic === "events" || t.topic.startsWith("channel:")) void load();
  }, !!accountId);

  return count;
}
