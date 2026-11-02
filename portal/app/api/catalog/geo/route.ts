// POST /api/catalog/geo — developer sets/updates a building's map location + access roads, or a
// PER-UNIT override pin.
// POST { building, geo } → save BuildingGeo on the building; geo:null clears it.
// POST { building, unit, geo } → save the override pin on that unit; geo:null clears it (the unit
// then inherits the building's pin again).
// A unit pin is the rare case — a villa / townhouse / plot with its own location inside a wider development.
// A tower unit normally has no pin (the building pin is the location). Same BuildingGeo shape + validation.
// OFF-CHAIN, public building context (a building location is NOT PII). Persists through the same
// file-backed catalog override store (lib/catalog.saveBuilding) used by the off-market route. AUTH posture
// matches the rest of the off-chain demo layer (off-market, KYC vault): the caller is trusted at the demo
// layer; the real wallet/signed-request binding is the deferred signing arc (F1). Server-side validated so
// a malformed payload can't corrupt the store.

import { NextResponse } from "next/server";
import { getBuilding, getCatalog, saveBuilding, type BuildingGeo } from "@/lib/catalog";
import { cleanGeo, nearbyBuildingConflict, MIN_BUILDING_SEPARATION_M } from "@/lib/catalog-geo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = String(body.building ?? "").trim();
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  let geo: BuildingGeo | null;
  try {
    geo = cleanGeo(body.geo);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid geo" }, { status: 400 });
  }

  // Per-unit override pin when a unit id is supplied; otherwise the building pin.
  const unitId = String(body.unit ?? "").trim();
  if (unitId) {
    const unit = building.inventory.find((u) => u.id === unitId);
    if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });
    unit.geo = geo ?? undefined;
    await saveBuilding(building);
    return NextResponse.json({ ok: true, geo: unit.geo ?? null });
  }

  // building's pin, so two developments can't sit on top of each other. Only when SETTING a pin (clearing
  // is always allowed). Unit-override pins (above) are exempt — a villa/plot legitimately sits inside a dev.
  if (geo) {
    const others = (await getCatalog())
      .filter((x) => x.id !== building.id && x.geo)
      .map((x) => ({ id: x.id, name: x.name, lat: x.geo!.lat, lng: x.geo!.lng }));
    const clash = nearbyBuildingConflict(geo, others);
    if (clash) {
      return NextResponse.json(
        {
          error: `Too close to ${clash.name} (${clash.meters.toFixed(1)} m away). Buildings must be at least ${MIN_BUILDING_SEPARATION_M} m apart.`,
          conflict: { id: clash.id, name: clash.name, meters: clash.meters },
        },
        { status: 409 },
      );
    }
  }

  building.geo = geo ?? undefined;
  await saveBuilding(building);
  return NextResponse.json({ ok: true, geo: building.geo ?? null });
}
