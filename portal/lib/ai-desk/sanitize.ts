// AI Sales Director — sanitize / buildDeskContext (the design docs §3). SERVER-ONLY. The
// SINGLE inbound gate: everything the model sees is assembled here, and it is PII-SAFE BY CONSTRUCTION —
//   • the buyer profile is run through buyer-mask.publicDirectProfileView (the SAME masked view a human desk
//     operator sees: partial name hint + nationality; passport/id/phone/email/address dropped), and
//   • the chat thread is run through pii-scrub (names/phone/email/id tokens → neutral placeholders), UNLESS the
//     buyer consented to share contact info on this conversation (§3b).
// If this fn is the only thing feeding the prompt, no raw PII can reach the AI. The no-PII test pins that.

import { getThread, type ChannelMessage } from "../channels";
import { publicDirectProfileView, type BuyerMask } from "../buyer-mask";
import { getDirectReveal, directParties } from "../conversations-direct";
import { getBuilding } from "../catalog";
import { getOffer } from "../offers";
import { isDirectOffer } from "../direct-offer";
import { nameTokens, scrubLine } from "./pii-scrub";
import type { DeskContext, ScrubbedTurn, ConcessionLever, AiDeskConfig } from "./types";

/** The raw buyer profile shape we need for masking + name-scrub (server-side only; mirrors BuyerDirectProfile
 *  — kept structural so this module doesn't hard-depend on the buyers-direct store's export). */
export type RawBuyerProfile = {
  name?: string;
  legalName?: string;
  nationality?: string;
  phone?: string;
  email?: string;
  passportNo?: string;
  idCardNo?: string;
  address?: string;
};

/** Map a channel author role → the ScrubbedTurn role the model reasons over. The desk side (developer/agent)
 *  collapses to "developer" (the AI plays the desk); buyer stays buyer; vrx stays vrx; anything else → vrx. */
function turnRole(from: ChannelMessage["from"]): ScrubbedTurn["from"] {
  if (from === "buyer") return "buyer";
  if (from === "developer" || from === "agent" || from === "agency") return "developer";
  return "vrx";
}

/**
 * Assemble the PII-SAFE DeskContext for a conversation. `profile` is the buyer's RAW stored profile (read by the
 * caller server-side); `levers` are the real draftable concession levers for this building (resolved by the
 * caller from furniture-packs / sale-contract support); `cfg` gates the scrub + buyer `consented` overrides it.
 * Returns null if the conversation can't be scoped (fail-closed).
 */
export async function buildDeskContext(
  conversationId: string,
  profile: RawBuyerProfile | undefined,
  levers: ConcessionLever[],
  cfg: Pick<AiDeskConfig, "piiScrubChat">,
  consented: boolean,
  buyerMaskOverride?: BuyerMask
): Promise<DeskContext | null> {
  const parties = await directParties(conversationId);
  if (!parties) return null;

  // Masked profile — the human-desk view. publicDirectProfileView fail-closes unmapped fields to hide.
  const buyer = publicDirectProfileView(profile, buyerMaskOverride) ?? {};

  // Thread → scrubbed turns. Scrub is ON unless the config disables it OR the buyer consented to share.
  const scrub = cfg.piiScrubChat && !consented;
  const names = scrub ? nameTokens(profile) : [];
  const raw = await getThread(conversationId).catch(() => [] as ChannelMessage[]);
  // Cap each turn (don't feed a wall of text to the model — cost + prompt-injection surface) and keep only the
  // recent tail of a long thread. A single buyer message is clipped to ~800 chars; the context to the last 20.
  const MAX_TURN_CHARS = 800;
  const MAX_TURNS = 20;
  const thread: ScrubbedTurn[] = raw.slice(-MAX_TURNS).map((m) => {
    const clipped = m.text.length > MAX_TURN_CHARS ? m.text.slice(0, MAX_TURN_CHARS) + "…" : m.text;
    return { from: turnRole(m.from), text: scrub ? scrubLine(clipped, names, false) : clipped };
  });

  // Deal state the brain reasons over.
  const reveal = (await getDirectReveal(conversationId)) ?? {};
  const bld = await getBuilding(parties.building).catch(() => null);

  return {
    conversationId,
    buyer,
    thread,
    building: {
      id: parties.building,
      name: bld?.name ?? parties.building,
      area: (bld as { area?: string } | null)?.area,
    },
    levers,
    phase: "browse", // the opening phase; the loop/act layer can advance it as the deal moves
    deal: {
      epoch: 0, // filled by the caller if it reads dealEpoch; 0 is a safe default for the prompt
      blocked: false, // the act lane re-checks block at fire time; context only needs the negotiation shape
      revealPending: !!reveal.request,
      grantedFields: reveal.grantedFields ?? [],
    },
  };
}

/**
 * Assemble the PII-SAFE DeskContext for a BOOKING thread (the seller-autoresponder "chat" lane). A booking
 * is keyed by an OFFER requestId, not a direct conversationId, so this is the sibling of buildDeskContext for
 * that lane. The counterparty persona is derived from the offer: a DIRECT offer (display.origin==="direct") is a
 * walk-in buyer who booked → "buyer" persona (continue the retail value-sell); any other offer is an AGENT
 * booking for their client → "agent" persona (the B2B desk↔agent playbook). The counterparty's turns are mapped
 * to the "buyer" slot so buildMessages treats them as the user side in BOTH lanes. No raw PII: a booking thread
 * carries no stored buyer profile here (the agent is the party; a direct buyer's KYC is a separate gated vault),
 * so the masked `buyer` map is empty and only the scrubbed chat text + public building facts reach the model.
 * Returns null if the offer can't be scoped (fail-closed).
 */
export async function buildBookingContext(
  requestId: string,
  levers: ConcessionLever[],
  cfg: Pick<AiDeskConfig, "piiScrubChat">
): Promise<DeskContext | null> {
  const offer = await getOffer(requestId);
  if (!offer) return null;
  const counterparty: "buyer" | "agent" = isDirectOffer(offer) ? "buyer" : "agent";
  const buildingId = offer.display?.buildingId ?? "";

  // Thread → scrubbed turns. No stored profile here, so name-scrub has no profile names to strip; the generic
  // pii-scrub (phone/email/id patterns) still runs on the free text unless the config disables it.
  const scrub = cfg.piiScrubChat;
  const raw = await getThread(requestId).catch(() => [] as ChannelMessage[]);
  const MAX_TURN_CHARS = 800;
  const MAX_TURNS = 20;
  const thread: ScrubbedTurn[] = raw.slice(-MAX_TURNS).map((m) => {
    const clipped = m.text.length > MAX_TURN_CHARS ? m.text.slice(0, MAX_TURN_CHARS) + "…" : m.text;
    // The desk side (developer/vrx) → "developer" (assistant); the COUNTERPARTY (agent or buyer) → "buyer"
    // (the user slot buildMessages maps to role:"user"), regardless of whether they posted as agent or buyer.
    const from: ScrubbedTurn["from"] = m.from === "developer" || m.from === "vrx" ? "developer" : "buyer";
    return { from, text: scrub ? scrubLine(clipped, [], false) : clipped };
  });

  const bld = await getBuilding(buildingId).catch(() => null);
  return {
    conversationId: requestId,
    counterparty,
    buyer: {}, // no stored profile in the booking lane — the counterparty is the agent (or a KYC-gated direct buyer)
    thread,
    building: {
      id: buildingId,
      name: bld?.name ?? buildingId,
      area: (bld as { area?: string } | null)?.area,
    },
    levers,
    phase: "browse", // booking lane also opens at browse; advances as the agent/buyer progresses
    deal: { epoch: 0, blocked: false, revealPending: false, grantedFields: [] },
  };
}
