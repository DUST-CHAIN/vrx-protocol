// POST /api/offers/payment-option — the BUYER chooses which of the seller's accepted payment methods they
// will use for this deal ( slice 5).
// POST { requestId, viewer, optionId } — optionId null/"" clears the pick (revert to "accepted menu").
// The developer authors the accepted-payment menu per building's seller ( slices 1/3); the buyer picks one
// here. The chosen id lands on the offer (off-seal), is FROZEN at `final` (409) like every other deal-tailoring
// field, and makes the S&P §2 state THAT destination as the binding payment term (paymentMethodTerm). An id
// that no longer resolves falls back to the menu in the renderer (graceful).
// SCOPE — mirrors the S&P route's auth EXACTLY (the buyer is not a roleOnOffer party): a DIRECT deal's buyer is
// authorized via the conversation's directRole ("buyer"); on a booking deal the authoring agent acts on the
// buyer's behalf (the booking buyer has no account party of their own). The desk/developer does NOT pick the
// buyer's method. The id MUST be one of the seller's resolved options (no ghost pick stored).: the
// destination is off-chain payee data; only the opaque option id rides the offer.

import { NextResponse } from "next/server";
import { getOffer, setPaymentOption } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";
import { getBuilding } from "@/lib/catalog";
import { getEntity, resolvePaymentOptions } from "@/lib/seller-entities";
import { isDirectOffer } from "@/lib/direct-offer";
import { directRole } from "@/lib/conversations-direct";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const viewer = typeof body.viewer === "string" ? body.viewer.trim() : "";
  const optionId = typeof body.optionId === "string" ? body.optionId.trim() : "";
  if (!requestId || !viewer) {
    return NextResponse.json({ error: "requestId + viewer required" }, { status: 400 });
  }

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  // Authorize the BUYER (or the agent on their behalf). Same model as /api/claims/sp.
  if (isDirectOffer(offer)) {
    const convId = offer.display.conversationId?.trim() || "";
    const dr = convId ? await directRole(convId, viewer) : null;
    if (dr !== "buyer") {
      return NextResponse.json({ error: "only the buyer may choose the payment method" }, { status: 403 });
    }
  } else {
    // Booking deal: the authoring agent (or its agency) picks on the buyer's behalf; the developer may not.
    const role = await roleOnOffer(offer, viewer);
    if (role !== "agent") {
      return NextResponse.json({ error: "only the buyer's agent may choose the payment method" }, { status: 403 });
    }
  }

  // When SETTING (not clearing), the id must be one of the seller's resolved options — never store a ghost.
  if (optionId) {
    const building = offer.display?.buildingId ? await getBuilding(offer.display.buildingId) : null;
    const seller = building?.sellerEntityId ? await getEntity(building.sellerEntityId) : null;
    const options = resolvePaymentOptions(seller);
    if (!options.some((o) => o.id === optionId)) {
      return NextResponse.json({ error: "that payment method is not offered for this property" }, { status: 409 });
    }
  }

  const { offer: updated, locked } = await setPaymentOption(requestId, optionId || null);
  if (locked) return NextResponse.json({ error: "the contract is final — the payment method is locked" }, { status: 409 });
  return NextResponse.json({ ok: true, paymentOptionId: updated?.paymentOptionId ?? null });
}
