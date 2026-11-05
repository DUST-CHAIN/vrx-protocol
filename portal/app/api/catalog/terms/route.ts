// POST /api/catalog/terms — developer sets/updates a building's COMMISSION TERMS-ENVELOPE (§9):
// the soft MIN–MAX commission band they're willing to agree on NEW agreements for the building.
//
//   POST { building, envelope }   → save the envelope; envelope:null (or an empty one) CLEARS it.
//
// SOFT by design: this never gates anything server-side. It is surfaced to the developer as a flag when a new
// rate falls outside the band (node agreement form + the Subscribed-agencies view) so they NOTICE before
// sealing — the principle is sunshine/visibility, not adjudication. It bounds only NEW proposals; an
// already-sealed agreement's snapshotted commissionPct is frozen and untouched.
//
// OFF-CHAIN, developer-authored building context (not PII, like geo/). Persists through the same
// file-backed catalog override store (saveBuilding) used by geo + off-market. AUTH posture matches the rest of
// the off-chain demo layer (trusted caller; the real signed-request binding is the deferred signing arc, F1).
// Server-side validated so a malformed payload can't corrupt the store.

import { NextResponse } from "next/server";
import { getBuilding, saveBuilding, type TermsEnvelope } from "@/lib/catalog";
import { cleanTermsEnvelope } from "@/lib/catalog-terms";
import { requireEditable, inventoryVerbFor, resolveNoticeParties } from "@/lib/catalog-edit-gate";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = String(body.building ?? "").trim();
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  let envelope: TermsEnvelope | null;
  try {
    envelope = cleanTermsEnvelope(body.envelope);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid envelope" }, { status: 400 });
  }

  // Freeze gate: the commission terms-envelope is the `terms` change class (version-gated by
  // default — a material terms change). Gate only when a developer identity is supplied (`by`); a `by`-less
  // legacy caller is the pre-gate demo path and is left to the deferred signing arc to bind.
  if (by) {
    const gate = await requireEditable(by, buildingId, "terms");
    if (!gate.allowed) return NextResponse.json(gate.body, { status: gate.status });
  }

  building.termsEnvelope = envelope ?? undefined;
  await saveBuilding(building);
  if (by) await logActivity(inventoryVerbFor("terms"), by.toLowerCase(), { kind: "unit", id: buildingId }, await resolveNoticeParties(by, buildingId), { building: building.name });
  return NextResponse.json({ ok: true, envelope: building.termsEnvelope ?? null });
}
