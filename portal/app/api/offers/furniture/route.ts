// POST /api/offers/furniture — set/clear the buyer's chosen FURNITURE pack for a booking.
//
//   POST { requestId, viewer, packId }   — packId null/"" clears the selection.
//
// ONE pack per booking. Off-seal (frozen hash untouched). AUTHORIZED to a PARTICIPANT of the booking
// (the shared lib/participant chokepoint — the agent acts for the buyer; the developer may also set it) AND
// the packId must be a pack ATTACHED to this booking's building (can't select a pack not on offer here). The
// per-unit cost is NOT stored — recomputed from the unit's m² at render (lib/furniture), so edits flow through.

import { NextResponse } from "next/server";
import { getOffer, markFurnitureSelection } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";
import { packsForBuilding } from "@/lib/furniture-packs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const viewer = typeof body.viewer === "string" ? body.viewer.trim() : "";
  const packId = typeof body.packId === "string" ? body.packId.trim() : "";
  if (!requestId || !viewer) return NextResponse.json({ error: "requestId + viewer required" }, { status: 400 });

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  const role = await roleOnOffer(offer, viewer);
  if (!role) return NextResponse.json({ error: "not a party to this booking" }, { status: 403 });

  // Clearing is always allowed for a party.
  if (!packId) {
    const updated = await markFurnitureSelection(requestId, viewer, null);
    return NextResponse.json({ ok: true, furniture: updated?.furniture ?? null });
  }

  // Validate the pack is attached to THIS booking's building — can't select a pack not on offer here.
  const buildingId = offer.display.buildingId?.trim() || "";
  const attached = buildingId ? await packsForBuilding(buildingId) : [];
  if (!attached.some((p) => p.id === packId)) {
    return NextResponse.json({ error: "that furniture pack is not offered on this building" }, { status: 409 });
  }

  const updated = await markFurnitureSelection(requestId, viewer, packId);
  return NextResponse.json({ ok: true, furniture: updated?.furniture ?? null });
}
