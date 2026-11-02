// /api/root/change-governance — the VRX-ROOT change-governance console (S190h Slice 7,
// This is "a party asks, VRX retrieves the sealed before/after" — projected for the VRX team (the one actor
// entitled to see every party's change history + to decide a TIER-0 correction).
// GET → { queue } — the open TIER-0 correction REVIEW queue (oldest-first), each with
// the before/after land anchors + reason + building name. The highest-privilege
// review in the model: approving one overrides land IMMUTABILITY (§Slice 5).
// GET ?building=<id> → { building, evidence[], amendments[], corrections[] } — that building's full
// sealed change history (newest-first), salt-stripped + buyer refs left as
// OPAQUE refs (never a resolved identity — the masking boundary.
// POST { id, decision, by } → review an OPEN correction (approved|rejected). On approve, runs the SAME
// attested land write + evidence + notify as the demo decide route (shared
// lib/tier0-correction-apply — one seam, no drift). Idempotent.
// ── WHY THIS IS SEPARATE FROM /api/catalog/tier0-correction/decide ────────────────────────────────────────
// The demo-layer decide route is self-named `by` (open to the demo). THIS surface is the VRX TEAM console behind
// the operator-secret gate — the correct boundary for the override write. Both call the same apply helper, so the
// attested effect is identical; only the AUTH differs (demo self-serve vs VRX-root operator). When F1 signing
// lands, the demo route retires and this becomes the one path.
// ── AUTH: the EXISTING /root operator-secret gate (fail-closed) — identical to /api/root/halts & /escalations ──
// x-vrx-operator vs VRX_OPERATOR_SECRET, with the explicit local VRX_DEMO_OPEN=1 escape hatch. An unset secret
// DENIES — this surface crosses every party boundary (it shows one building's full cross-party change history)
// AND carries the immutable-anchor override, so it is never open by default.
// ── PRIVACY + the MASKING BOUNDARY ─────────────────────────────────────────────────────────
// SERVER-side only; nothing on-chain. The projection STRIPS the per-record salt from every record — the
// salt never leaves the server (same discipline as publicHalt / the /root overview). The before/after values are
// PUBLIC building context (land anchors, car parks, fees, copy — the family, NOT PII). An amendment carries
// the buyer as an OPAQUE buyerRef only (the off-seal display ref the deal attached) — this surface passes it
// through UNCHANGED, never resolving it to an identity. The consumer that may show a buyer applies the mask; this
// resolver returns refs (the boundary — the resolver returns refs, the consumer masks).

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import {
  openCorrections,
  correctionsForBuilding,
  decideCorrection,
  getCorrection,
  type Tier0Correction,
} from "@/lib/tier0-correction";
import { applyApprovedCorrection } from "@/lib/tier0-correction-apply";
import { evidenceForBuilding, type ChangeEvidence } from "@/lib/change-evidence";
import { amendmentsForBuilding, type ContractAmendment } from "@/lib/contract-amendment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical posture to /api/root/halts + /api/root/escalations.
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

// ── Salt-stripping projections (the salt NEVER leaves the server) ─────────────────────────────────────

/** A correction as the VRX reviewer sees it — the sealed REQUEST + its review state, WITHOUT the salt. */
type QueueCorrection = Omit<Tier0Correction, "salt"> & { buildingName: string };
function publicCorrection(c: Tier0Correction, buildingName: string): QueueCorrection {
  const { salt: _salt, ...rest } = c;
  return { ...rest, buildingName };
}

/** Change-evidence without the salt (the before/after are public building context, not PII). */
type PublicEvidence = Omit<ChangeEvidence, "salt">;
function publicEvidence(e: ChangeEvidence): PublicEvidence {
  const { salt: _salt, ...rest } = e;
  return rest;
}

/** An amendment without the salt. buyerRef is passed through as the OPAQUE ref it already is (never resolved —
 * the masking boundary; a consumer that shows a buyer applies the mask, this returns the ref). */
type PublicAmendment = Omit<ContractAmendment, "salt">;
function publicAmendment(a: ContractAmendment): PublicAmendment {
  const { salt: _salt, ...rest } = a;
  return rest;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const building = (new URL(req.url).searchParams.get("building") ?? "").trim();

  if (building) {
    // Drill-down: one building's full sealed change history (evidence + amendments + corrections).
    const [b, evidence, amendments, corrections] = await Promise.all([
      getBuilding(building),
      evidenceForBuilding(building),
      amendmentsForBuilding(building),
      correctionsForBuilding(building),
    ]);
    return NextResponse.json({
      building: b?.name ?? building,
      buildingId: building,
      evidence: evidence.map(publicEvidence),
      amendments: amendments.map(publicAmendment),
      corrections: corrections.map((c) => publicCorrection(c, b?.name ?? building)),
    });
  }

  // The REVIEW QUEUE: every open TIER-0 correction awaiting a VRX decision (oldest-first — fair order).
  const open = await openCorrections();
  // Resolve building names once (dedup the ids so a building with several open corrections is read once).
  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(open.map((c) => c.building))].map(async (id) => {
      const b = await getBuilding(id).catch(() => null);
      names.set(id, b?.name ?? id);
    })
  );
  return NextResponse.json({ queue: open.map((c) => publicCorrection(c, names.get(c.building) ?? c.building)) });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

  // APPROVED → the shared attested write (identical to the demo decide route).
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
