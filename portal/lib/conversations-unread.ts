// Server-side UNREAD computation for the everlasting unit chat ( notify-on-login) — the ONE place the
// "does this viewer have unseen messages, and how many threads" rule lives, so the full Conversations roll-up
// (api/conversations) and the cheap sidebar COUNT (api/conversations/unread) can never drift.
// THE RULE (identical to the roll-up's per-row `unread`): a thread is unread for a viewer when
// (a) the viewer is a PARTICIPANT of that booking (lib/participant — fail closed on a thread they're not on
// or whose offer we don't hold), AND
// (b) the thread has MORE messages than the viewer last marked seen (server read-marker, survives
// device/login — lib/read-markers), AND
// (c) the NEWEST message is NOT the viewer's own (your own last word isn't unread to you).
// The count route only needs the TOTAL of unread threads (a sidebar badge), so this returns both the count
// and the id set — the roll-up can keep using its own inline per-row derivation, but the count route uses
// THIS so the two agree on what "unread" means. No bodies leave here: ids + an integer.

import { allThreadSummaries } from "./channels";
import { getOffer } from "./offers";
import { partyOnOffer } from "./participant";
import { seenFor } from "./read-markers";
import type { ParticipantRole } from "./participant";

/**
 * The PURE unread rule, extracted so it can be tested without.data IO (the store reads are the thin wrapper
 * around it below). A thread is unread for a participant iff it has MORE messages than they've seen AND the
 * newest message is from the OTHER side (not their own role). `viewerRole` null = not a participant → never
 * unread (fail closed). `newestFrom` null = no messages yet → never unread.
 */
export function isThreadUnread(args: {
  viewerRole: ParticipantRole | null;
  msgCount: number;
  seenCount: number;
  newestFrom: string | null;
}): boolean {
  const { viewerRole, msgCount, seenCount, newestFrom } = args;
  if (!viewerRole) return false; // not a party → fail closed
  if (!newestFrom) return false; // silent thread
  return msgCount > seenCount && newestFrom !== viewerRole;
}

/** The ids of the viewer's threads that are currently unread, newest-activity first. */
export async function unreadThreadIds(viewer: string): Promise<string[]> {
  const v = viewer.trim();
  if (!v) return [];
  const [threads, seen] = await Promise.all([
    allThreadSummaries().catch(() => []),
    seenFor(v).catch(() => ({} as Record<string, number>)),
  ]);

  const unread: { id: string; at: number }[] = [];
  for (const t of threads) {
    if (!t.lastMsg) continue; // a seeded-but-silent thread can't be unread
    const offer = await getOffer(t.requestId);
    const party = await partyOnOffer(offer, v); // null → not a participant / no offer → drop (fail closed)
    if (!party) continue;
    const seenCount = seen[t.requestId] ?? 0;
    // More than the viewer saw AND the newest message is from the OTHER side (not the viewer's own role).
    if (
      isThreadUnread({
        viewerRole: party.role,
        msgCount: t.msgCount,
        seenCount,
        newestFrom: t.lastMsg.from,
      })
    ) {
      unread.push({ id: t.requestId, at: t.lastMsg.at });
    }
  }
  unread.sort((a, b) => b.at - a.at);
  return unread.map((u) => u.id);
}

/** The number of the viewer's threads with unseen counterpart messages — the sidebar badge value. */
export async function unreadCountFor(viewer: string): Promise<number> {
  return (await unreadThreadIds(viewer)).length;
}
