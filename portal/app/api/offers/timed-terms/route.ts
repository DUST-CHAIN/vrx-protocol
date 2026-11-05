// POST /api/offers/timed-terms — the DEVELOPER records per-deal TIMED TERMS on a booking (part 1).
//
//   POST { requestId, viewer, op:"add", label, when, note?, committed?, id? }  → add/update a timed term.
//   POST { requestId, viewer, op:"remove", id }                               → remove a timed term.
//
// Timed terms are the deal-specific time-bound commitments a buyer was anxious about and wanted in THEIR
// contract ("covered car-park handed over by March 2027", "title transferred within 60 days of final
// payment"). Distinct from the building's construction schedule (§4) and from undated concessions.
// EDITABLE ONLY while the contract is at `preview`; once the developer marks it `final` the list FREEZES (the
// buyer signs against a fixed set) → a late edit returns 409. DEVELOPER-ONLY (they make the commitment); the
// agent/buyer see them on the S&P §4B. Off-seal (frozen hash untouched). Participant-scoped via lib/participant.

import { NextResponse } from "next/server";
import { getOffer, upsertTimedTerm, removeTimedTerm } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const viewer = typeof body.viewer === "string" ? body.viewer.trim() : "";
  if (!requestId || !viewer) return NextResponse.json({ error: "requestId + viewer required" }, { status: 400 });

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  const role = await roleOnOffer(offer, viewer);
  if (role !== "developer") {
    return NextResponse.json({ error: "only the developer may record timed terms" }, { status: 403 });
  }

  if (body.op === "remove") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { offer: updated, locked } = await removeTimedTerm(requestId, id);
    if (locked) return NextResponse.json({ error: "the contract is final — timed terms are locked" }, { status: 409 });
    return NextResponse.json({ ok: true, timedTerms: updated?.timedTerms ?? [] });
  }

  // default = add/update
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const when = typeof body.when === "string" ? body.when.trim() : "";
  if (!label || !when) return NextResponse.json({ error: "label + when required" }, { status: 400 });
  const { offer: updated, locked } = await upsertTimedTerm(requestId, viewer, {
    id: typeof body.id === "string" ? body.id : undefined,
    label,
    when,
    note: typeof body.note === "string" ? body.note : undefined,
    committed: body.committed === true,
  });
  if (locked) return NextResponse.json({ error: "the contract is final — timed terms are locked" }, { status: 409 });
  return NextResponse.json({ ok: true, timedTerms: updated?.timedTerms ?? [] });
}
