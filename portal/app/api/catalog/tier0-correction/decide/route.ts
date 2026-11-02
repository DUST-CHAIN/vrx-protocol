// POST /api/catalog/tier0-correction/decide — VRX REVIEWS an open TIER-0 land correction (Slice 5,
// the store records the decision; THIS route applies the attested change on approve.
// POST { id, decision:"approved"|"rejected", by } (by = the VRX reviewer account)
// APPROVE → merge the correction's proposed anchors into building.land + saveBuilding (the land write the normal
// edit path REFUSES as immutable — a correction is the only legitimate path), then SEAL before/after evidence
// (changeClass "land") + NOTIFY every affected party (agencies AND live buyers), and link the evidence id back
// onto the correction. VRX anchors the review + the evidence; VRX does not warrant the new value ( pt5).
// REJECT → nothing applied; the anchors stand. No notice (nothing changed).
// AUTH posture matches the off-chain demo layer (the reviewer `by` is self-named; a real VRX-root auth binding
// is the deferred signing arc, F1). GET ?status=open lists the review queue.

import { NextResponse } from "next/server";
import { decideCorrection, getCorrection, openCorrections } from "@/lib/tier0-correction";
import { applyApprovedCorrection } from "@/lib/tier0-correction-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status")?.trim() || "";
  if (status === "open") return NextResponse.json({ corrections: await openCorrections() });
  return NextResponse.json({ error: "only ?status=open is supported" }, { status: 400 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  const by = typeof body.by === "string" ? body.by.trim() : "";
  const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!by) return NextResponse.json({ error: "by (reviewer) required" }, { status: 400 });
  if (!decision) return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });

  const existing = await getCorrection(id);
  if (!existing) return NextResponse.json({ error: "correction not found" }, { status: 404 });

  const result = await decideCorrection({ id, decision, by });
  if (!result) return NextResponse.json({ error: "correction not found" }, { status: 404 });
  if (!result.changed) {
    // Already decided — report its current state, apply nothing again (idempotent).
    return NextResponse.json({ ok: true, id, status: result.correction.status, noop: true });
  }

  if (decision === "rejected") {
    return NextResponse.json({ ok: true, id, status: "rejected", applied: false });
  }

  // APPROVED → apply the corrected anchors to the live building (shared helper — the SAME attested write the
  // VRX-root review surface runs, lib/tier0-correction-apply). This is the land write the normal edit path
  // refuses (immutable_tier0); the VRX review is what authorises it.
  const applied = await applyApprovedCorrection(result.correction, by);
  return NextResponse.json({
    ok: true,
    id,
    status: "approved",
    applied: applied.applied,
    evidenceId: applied.evidenceId,
    ...(applied.note ? { note: applied.note } : {}),
  });
}
