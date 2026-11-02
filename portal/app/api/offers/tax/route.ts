// POST /api/offers/tax — the DEVELOPER sets the negotiable TRANSFER-TAX rate + buyer/seller split.
// POST { requestId, viewer, ratePct, buyerSharePct }
// Transfer tax/duty is optional + SHARED; the developer can adjust the rate AND the split during negotiation
// (409). DEVELOPER-ONLY. Off-seal (frozen hash untouched). The tax AMOUNT is computed from rate × price at
// render, never stored. Participant-scoped via lib/participant.

import { NextResponse } from "next/server";
import { getOffer, setTax } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const viewer = typeof body.viewer === "string" ? body.viewer.trim() : "";
  if (!requestId || !viewer) return NextResponse.json({ error: "requestId + viewer required" }, { status: 400 });

  const ratePct = Number(body.ratePct);
  const buyerSharePct = Number(body.buyerSharePct);
  if (!Number.isFinite(ratePct) || !Number.isFinite(buyerSharePct)) {
    return NextResponse.json({ error: "ratePct + buyerSharePct required" }, { status: 400 });
  }

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  const role = await roleOnOffer(offer, viewer);
  if (role !== "developer") {
    return NextResponse.json({ error: "only the developer may set the transfer tax" }, { status: 403 });
  }

  const { offer: updated, locked } = await setTax(requestId, viewer, ratePct, buyerSharePct);
  if (locked) return NextResponse.json({ error: "the contract is final — the tax is locked" }, { status: 409 });
  return NextResponse.json({ ok: true, tax: updated?.tax ?? null });
}
