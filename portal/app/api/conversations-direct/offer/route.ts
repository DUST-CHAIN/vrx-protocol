// GET /api/conversations-direct/offer?account=<viewer>&building=<id> (or &conversationId=)
// → resolve the MATERIALIZED direct Offer for this deal and return { requestId } — so a party can view the
// S&P. slice 4.
// WHY THIS EXISTS: a direct offer's requestId is a ONE-WAY hash of (conversationId, epoch) salted server-side
// (lib/direct-offer.directRequestId). The desk gets it back from the materialize call, but the BUYER never
// computes it (no salt, no epoch). This route resolves it for EITHER party, scoped: the caller must be a party
// to the conversation (directRole), and we only return a requestId when a direct offer actually exists on file.
// SCOPE/privacy: returns ONLY the opaque requestId (no PII, no terms) to an authorized party; the S&P
// route (api/claims/sp) applies its own per-viewer masking when the contract is actually fetched. Fail-closed:
// a non-party or an un-materialized deal → no requestId.

import { NextResponse } from "next/server";
import { directConversationId, resolveDirectConversation, directRole, dealEpoch } from "@/lib/conversations-direct";
import { directRequestId } from "@/lib/direct-offer";
import { getOffer } from "@/lib/offers";
import { isDirectOffer } from "@/lib/direct-offer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  const conversationIdParam = url.searchParams.get("conversationId")?.trim() || "";
  if (!account || (!building && !conversationIdParam)) {
    return NextResponse.json({ error: "account + (building or conversationId) required" }, { status: 400 });
  }

  // Resolve the conversation id. From a building we DON'T create one (read-only resolve); if none exists there's
  // nothing to paper, so return no offer rather than minting a conversation.
  let conversationId = conversationIdParam;
  if (!conversationId && building) {
    const conv = await resolveDirectConversation(account, building, /* ensure */ false);
    conversationId = conv?.id ?? directConversationId(account, building);
  }

  // Fail-closed authorization: only a party to the conversation may learn the requestId.
  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ error: "not a party to this deal" }, { status: 403 });

  // The offer is keyed on (conversationId, current epoch). Only return it when it actually exists AND is a
  // direct offer (never surface a non-direct record here).
  const epoch = await dealEpoch(conversationId);
  const requestId = directRequestId(conversationId, epoch);
  const offer = await getOffer(requestId);
  if (!offer || !isDirectOffer(offer)) {
    return NextResponse.json({ requestId: null, materialized: false });
  }
  return NextResponse.json({ requestId, materialized: true });
}
