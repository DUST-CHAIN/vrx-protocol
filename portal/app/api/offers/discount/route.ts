// POST /api/offers/discount — the DEVELOPER sets (or clears) a DISCOUNT off the price.
//
//   POST { requestId, viewer, kind: "amount" | "percent", value }   set
//   POST { requestId, viewer, value: 0 }  (or kind omitted + value<=0)  clear
//
// Sibling of concessions and the transfer tax: off-seal, DEVELOPER-ONLY, editable while the
// contract is at `preview`, FROZEN at `final` (409). Either a fixed USD `amount` or a `percent` of the booked
// price; the net/discounted figure is computed at render, never stored. Participant-scoped via lib/participant.

import { NextResponse } from "next/server";
import { getOffer, setDiscount } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";
import { requireCaller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  // AUTH (F3 class): the party setting a DISCOUNT (a money mutation) must be the PROVEN caller — the
  // old code trusted body.viewer, so anyone who learned a requestId could name the developer and set the price.
  const who = requireCaller(req, { param: typeof body.viewer === "string" ? body.viewer.trim() : "" });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const viewer = who.account;
  if (!requestId || !viewer) return NextResponse.json({ error: "requestId + viewer required" }, { status: 400 });

  const value = Number(body.value);
  const kind: "amount" | "percent" = body.kind === "percent" ? "percent" : "amount";
  const note = typeof body.note === "string" ? body.note : undefined;
  // value <= 0 (or not finite) clears the discount — the setter treats it as a clear.
  const discount = Number.isFinite(value) && value > 0 ? { kind, value, note } : null;

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  const role = await roleOnOffer(offer, viewer);
  if (role !== "developer") {
    return NextResponse.json({ error: "only the developer may set a discount" }, { status: 403 });
  }

  const { offer: updated, locked } = await setDiscount(requestId, viewer, discount);
  if (locked) return NextResponse.json({ error: "the contract is final — the discount is locked" }, { status: 409 });
  return NextResponse.json({ ok: true, discount: updated?.discount ?? null });
}
