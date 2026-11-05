// POST /api/offers/instalment-milestone — tie a plan INSTALMENT to a construction MILESTONE.
//
//   POST { requestId, viewer, instalment, milestoneLabel }   — milestoneLabel ""/null clears the tie.
//
// Off-plan buying ties payments to build progress ("20% due at topping-out"). This is a DISPLAY JOIN: the
// sealed plan (instalment ordinals) and the building's construction timeline (milestone labels) are
// both read-only; this records the mutable link. Editable while `preview`, FROZEN at `final` (409).
// DEVELOPER-ONLY. The milestoneLabel MUST be a real milestone on this booking's building (else 409) — a
// referenced label that later disappears from the timeline simply drops the tie at render (no drift/crash).

import { NextResponse } from "next/server";
import { getOffer, setInstalmentMilestone } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";
import { getBuilding } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const viewer = typeof body.viewer === "string" ? body.viewer.trim() : "";
  const instalment = Number(body.instalment);
  const milestoneLabel = typeof body.milestoneLabel === "string" ? body.milestoneLabel.trim() : "";
  if (!requestId || !viewer || !(instalment >= 1)) {
    return NextResponse.json({ error: "requestId + viewer + instalment(>=1) required" }, { status: 400 });
  }

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  const role = await roleOnOffer(offer, viewer);
  if (role !== "developer") {
    return NextResponse.json({ error: "only the developer may tie instalments to milestones" }, { status: 403 });
  }

  // Validate the label is a real milestone on this building (unless clearing).
  if (milestoneLabel) {
    const building = offer.display.buildingId ? await getBuilding(offer.display.buildingId) : null;
    const labels = (building?.constructionTimeline ?? []).map((m) => m.label);
    if (!labels.includes(milestoneLabel)) {
      return NextResponse.json({ error: "that milestone is not on this building's timeline" }, { status: 409 });
    }
  }

  const { offer: updated, locked } = await setInstalmentMilestone(requestId, instalment, milestoneLabel || null);
  if (locked) return NextResponse.json({ error: "the contract is final — the schedule is locked" }, { status: 409 });
  return NextResponse.json({ ok: true, instalmentMilestones: updated?.instalmentMilestones ?? {} });
}
