// POST /api/catalog/tier0-correction — a developer OPENS a VRX-reviewed correction to an IMMUTABLE land
// legal-anchor (title deed / survey page / land number / address) on an on-contract building (Slice 5,
// the design docs §Slice 5). This is the ONLY legitimate path to change a TIER-0 field once
// a building is on contract — the self-serve edit is refused by the freeze gate (immutable_tier0, Slice 1).
//
//   POST { building, by, data:{titleDeedNum?,surveyPageNum?,landNumber?,address?,addressTH?}, reason }
//     → opens an `open` correction (awaiting VRX review). `before` = the building's current anchors. `reason`
//       is REQUIRED (a correction is never silent or reason-less). The correction is NOT applied here — VRX
//       reviews + approves via /api/catalog/tier0-correction/decide, which applies it.
//   GET ?building=<id>  → corrections for the building (newest-first) — the developer's view of their requests.
//
// OFF-CHAIN. AUTH posture matches the rest of the off-chain demo layer (the `by` developer is self-named; the
// real signed-request binding is the deferred signing arc, F1). The land values are PUBLIC building context, not
// PII.

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import { cleanLand } from "@/lib/catalog-building-setup";
import { openCorrection, correctionsForBuilding, type LandAnchors } from "@/lib/tier0-correction";
import type { BuildingLand } from "@/lib/catalog-client";
import { requireCaller } from "@/lib/caller";
import { callerOwnsBuilding } from "@/lib/catalog-edit-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Project a BuildingLand (or absent) to the TIER-0 anchors only (clauseText is editable prose, not an anchor).
 *  Undefined fields are dropped so a correction's before/after carries only the legal identifiers. */
function anchorsOf(land: BuildingLand | LandAnchors | undefined): LandAnchors {
  const l = (land ?? {}) as Record<string, unknown>;
  const out: LandAnchors = {};
  for (const f of ["titleDeedNum", "surveyPageNum", "landNumber", "address", "addressTH"] as const) {
    if (typeof l[f] === "string" && (l[f] as string).trim()) out[f] = (l[f] as string).trim();
  }
  return out;
}

export async function GET(req: Request) {
  const building = new URL(req.url).searchParams.get("building")?.trim() || "";
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });
  return NextResponse.json({ corrections: await correctionsForBuilding(building) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = String(body.building ?? "").trim();
  // AUTH (F3 class): opening a TIER-0 land correction attests a proposed legal-anchor change in the
  // developer's name — bind `by` to the PROVEN caller so nobody can file a correction as another developer.
  const who = requireCaller(req, { param: typeof body.by === "string" ? body.by.trim() : "" });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const by = who.account;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });
  if (!by) return NextResponse.json({ error: "by (developer) required" }, { status: 400 });
  if (!reason) return NextResponse.json({ error: "a reason is required for a correction", code: "needs_reason" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  // OWNERSHIP: only the building's developer may open a correction on its land anchors.
  if (!(await callerOwnsBuilding(by, buildingId))) {
    return NextResponse.json({ error: "only the building's developer may open a correction" }, { status: 403 });
  }

  // Validate the proposed corrected anchors through the SAME cleaner the normal land save uses, so a correction
  // can't write a malformed shape (throws → 400). Then project both sides to the TIER-0 anchors only.
  let cleanedAfter: BuildingLand | null;
  try {
    cleanedAfter = cleanLand(body.data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid land data" }, { status: 400 });
  }
  const before = anchorsOf(building.land);
  const after = anchorsOf(cleanedAfter ?? undefined);

  const correction = await openCorrection({ building: buildingId, developer: by, before, after, reason });
  if (!correction) return NextResponse.json({ error: "could not open correction" }, { status: 400 });
  return NextResponse.json({ ok: true, correction });
}
