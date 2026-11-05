// channelTopic — the ONE place that maps a booking requestId to its SSE change-bus topic.
//
// WHY THIS EXISTS (security audit, 💬 Finding F2): the SSE stream (/api/events/stream) broadcasts
// every "tick" topic to EVERY connected client — that's fine for the "events" topic (a generic "mirror moved,
// refresh" nudge) but the per-thread topic used to be the RAW `channel:<requestId>`. So any connected client
// learned the existence + timing of activity on specific booking ids it was NOT a party to — a soft
// privacy-moat leak (who's-talking-to-whom-and-when), even though no message BODY leaks (the gated
// /api/channels/[id] re-read still fails closed for non-parties).
//
// THE FIX: make the thread topic OPAQUE. We publish `channel:<token>` where token is a short, stable,
// NON-reversible digest of the requestId. A party already HOLDS the requestId (they have the thread), so they
// recompute the same token and match their own tick; a non-party sees only an opaque token that names no
// booking and can't be casually enumerated. Both server (publish) and client (match) call this one function,
// so they can never drift. The `startsWith("channel:")` consumers (the agent's conversation-list refresh)
// still work unchanged — the prefix is preserved.
//
// NOT a security boundary by itself: this is metadata-hygiene, not access control (the real gate is
// participantRole, lib/participant). It's isomorphic (no node/crypto import) so the exact same code runs in
// the browser and on the server. FNV-1a 32-bit → 8 hex chars: ample to avoid collision/enumeration for a
// change-signal token (NOT a cryptographic hash — it doesn't need to be; the requestId it hides is itself a
// 64-hex opaque value, and bodies stay behind the real gate).

/** FNV-1a 32-bit hash of a string → 8-char lowercase hex. Pure, isomorphic, no deps. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned via Math.imul + >>> 0
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The SSE change-bus topic for a booking's chat thread. Opaque: `channel:<token>` where token reveals nothing
 * about the booking. A holder of the requestId recomputes the same topic to match their own ticks; everyone
 * else sees an unlinkable token. Domain-salted so the token can't be matched against hashes used elsewhere.
 */
export function channelTopic(requestId: string): string {
  return `channel:${fnv1a("vrx-channel|" + requestId.trim())}`;
}
