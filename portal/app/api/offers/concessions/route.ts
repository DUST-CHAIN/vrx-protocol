// POST /api/offers/concessions — the DEVELOPER records negotiation CONCESSIONS on a booking.
//
//   POST { requestId, viewer, op:"add", label, note?, valueUsd?, id? }  → add/update a concession line.
//   POST { requestId, viewer, op:"remove", id }                         → remove a concession line.
//
// During negotiation a developer promises extras/changes ("free covered parking", "upgraded worktops",
// "waive the first instalment") that become binding at close → they MUST be recorded into the S&P. EDITABLE
// ONLY while the contract is at `preview`; once the developer marks it `final` the list FREEZES (the buyer
// signs against a fixed set) → a late edit returns 409. DEVELOPER-ONLY (they grant the concession); the
// agent/buyer see them on the S&P. Off-seal (frozen hash untouched). Participant-scoped via lib/participant.

import { NextResponse } from "next/server";
import { getOffer, upsertConcession, removeConcession } from "@/lib/offers";
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
    return NextResponse.json({ error: "only the developer may record concessions" }, { status: 403 });
  }

  if (body.op === "remove") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { offer: updated, locked } = await removeConcession(requestId, id);
    if (locked) return NextResponse.json({ error: "the contract is final — concessions are locked" }, { status: 409 });
    return NextResponse.json({ ok: true, concessions: updated?.concessions ?? [] });
  }

  // default = add/update
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
  const { offer: updated, locked } = await upsertConcession(requestId, viewer, {
    id: typeof body.id === "string" ? body.id : undefined,
    label,
    note: typeof body.note === "string" ? body.note : undefined,
    valueUsd: Number.isFinite(Number(body.valueUsd)) ? Number(body.valueUsd) : undefined,
  });
  if (locked) return NextResponse.json({ error: "the contract is final — concessions are locked" }, { status: 409 });
  return NextResponse.json({ ok: true, concessions: updated?.concessions ?? [] });
}
