// ── Participant scoping for a booking — the ONE place the "who may see/act on this deal" rule lives ──────
//
// A booking/deal is PRIVATE. Its participants are exactly three accounts:
//   • the DEVELOPER   — offer.developer (the counterparty / sell-to side)
//   • the AGENT       — offer.seal.by (the agent who authored the booking)
//   • that agent's supervising AGENCY — agencyOf(agent) (same sell side as the agent; the agency app
//                        observes deals as `me` = the agency account, per /api/agency-claims)
// "agent" as a ROLE covers both the agent and its agency (they're one sell side); only the developer is the
// counterparty. Anyone else — or an unknown booking (no off-chain offer → no resolvable party) — is NOT a
// participant and every gate must FAIL CLOSED.
//
// WHY THIS MODULE EXISTS (security audit, 💬 Finding F1): this rule was copy-pasted into
// /api/channels, /api/claims/sp, and inlined in /api/conversations — three copies that could drift. Worse,
// the known demo-layer caveat is that the caller's identity arrives as an UNSIGNED `?viewer=` param, trusted
// as-is. Consolidating here gives ONE chokepoint: when the real auth binding lands (verify a signed request /
// wallet session instead of trusting the param), it changes in exactly one place and every consumer inherits
// it. The audit's explicit recommendation: "fix it ONCE as a shared helper." This is that helper.
//
// Behaviour is IDENTICAL to the three prior copies — this is a pure consolidation, no scope change.

import { getOffer, type Offer } from "./offers";
import { agencyOf } from "./agents";

/** The caller's role on a deal. "agent" = the authoring agent OR its supervising agency (one sell side). */
export type ParticipantRole = "developer" | "agent";

/**
 * Resolve the caller's role from an ALREADY-FETCHED offer. Returns the role, or null if the account is not a
 * participant. Pass the raw stored offer (the scope is decided on the real parties, not a masked projection).
 */
export async function roleOnOffer(offer: Offer, account: string): Promise<ParticipantRole | null> {
  const acct = account.trim().toLowerCase();
  if (!acct) return null;
  if (offer.developer.toLowerCase() === acct) return "developer";
  const agent = typeof offer.seal?.by === "string" ? offer.seal.by.toLowerCase() : "";
  if (agent && agent === acct) return "agent"; // the agent who made the offer
  if (agent) {
    const agency = (await agencyOf(agent))?.toLowerCase();
    if (agency && agency === acct) return "agent"; // the agent's supervising agency (same sell side)
  }
  return null;
}

/**
 * Resolve the caller's role from a booking's requestId — fetches the offer and applies {@link roleOnOffer}.
 * Returns null if the booking is unknown (no off-chain offer → no resolvable party → fail closed) OR the
 * account isn't a participant. The requestId-first shape /api/channels uses.
 */
export async function roleOnBooking(requestId: string, account: string): Promise<ParticipantRole | null> {
  const offer = await getOffer(requestId);
  if (!offer) return null; // unknown booking → fail closed
  return roleOnOffer(offer, account);
}

/**
 * Resolve the caller's role AND both sides (developer + agent account ids) from an offer — the shape
 * /api/conversations needs to build a row (title + counterpart). Returns null if not a participant / no offer.
 */
export async function partyOnOffer(
  offer: Offer | null,
  account: string
): Promise<{ role: ParticipantRole; developer: string; agent: string } | null> {
  if (!offer) return null; // unknown booking → no resolvable party → fail closed
  const role = await roleOnOffer(offer, account);
  if (!role) return null;
  return { role, developer: offer.developer, agent: typeof offer.seal?.by === "string" ? offer.seal.by : "" };
}
