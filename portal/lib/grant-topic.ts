// grantTopic — the ONE place that maps a direct buyer's account to its SSE change-bus topic for
// "units opened to you". Same opaque-topic discipline as channelTopic (Finding F2).
//
// WHY OPAQUE: the SSE stream (/api/events/stream) broadcasts every "tick" topic to EVERY connected client.
// A per-buyer topic lets the buyer's units-opened list refresh the instant the desk opens/closes a unit —
// but a RAW `grants:<account>` would leak to every listener that a specific wallet just had activity (a
// who's-being-shown-units-and-when metadata leak). So we publish `grants:<token>` where token is a short,
// stable, non-reversible digest of the account. The buyer already holds their own account id, so they
// recompute the same token and match their own tick; a non-party sees only an opaque token.
//
// NOT a security boundary: metadata hygiene, not access control (the real gate is the server unit-grants
// route, which only returns a buyer's own grants). Isomorphic (no node/crypto) so server-publish and
// client-match call the exact same function and can never drift. FNV-1a 32-bit → 8 hex chars.

/** FNV-1a 32-bit hash of a string → 8-char lowercase hex. Pure, isomorphic, no deps. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The SSE change-bus topic for a direct buyer's opened-units list. Opaque: `grants:<token>` where token
 * reveals nothing about the account. The buyer recomputes the same topic from their own account to match
 * their own ticks; everyone else sees an unlinkable token. Account is lowercased to match the grant store's
 * normalisation (so publish and subscribe agree on the same token for the same buyer).
 */
export function grantTopic(account: string): string {
  return `grants:${fnv1a("vrx-grant|" + account.trim().toLowerCase())}`;
}
