// Geo payload validation for POST /api/catalog/geo (+ layer 1). Lives in lib/ (not the route
// file) because a Next route module may only export HTTP handlers + known config — extra exports break the
// generated route type. Pure functions, unit-tested in lib/catalog-geo.test.ts.

import type { BuildingGeo, AccessRoad } from "@/lib/catalog";

/** Validate + normalise an incoming geo payload, or null to clear. Throws on bad shape (caller → 400). */
export function cleanGeo(raw: unknown): BuildingGeo | null {
  if (raw == null) return null;
  const r = raw as Record<string, unknown>;
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error("lat/lng out of range");
  }
  const out: BuildingGeo = { lat, lng };
  if (typeof r.label === "string" && r.label.trim()) out.label = r.label.trim().slice(0, 200);
  if (Array.isArray(r.accessRoads)) {
    const roads: AccessRoad[] = [];
    for (const rr of r.accessRoads.slice(0, 20)) {
      const road = rr as Record<string, unknown>;
      if (!Array.isArray(road.path)) continue;
      const path = road.path
        .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN]))
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180)
        .slice(0, 500) as [number, number][];
      if (path.length === 0) continue;
      const road2: AccessRoad = { path };
      if (typeof road.name === "string" && road.name.trim()) road2.name = road.name.trim().slice(0, 120);
      roads.push(road2);
    }
    if (roads.length) out.accessRoads = roads;
  }
  // Site plan (layer 1): land/footprint polygons + orientation bearing. All optional.
  const landPolygon = cleanPolygon(r.landPolygon);
  if (landPolygon) out.landPolygon = landPolygon;
  const footprintPolygon = cleanPolygon(r.footprintPolygon);
  if (footprintPolygon) out.footprintPolygon = footprintPolygon;
  if (r.northBearing != null) {
    const b = Number(r.northBearing);
    if (Number.isFinite(b)) out.northBearing = ((b % 360) + 360) % 360; // normalise to 0–359
  }
  return out;
}

/** Minimum allowed distance between two distinct building pins, in metres: two buildings
 *  must never sit on top of each other (the parkgate trio drew 2.6m apart, reading as one block). */
export const MIN_BUILDING_SEPARATION_M = 5;

/** Great-circle-ish distance between two [lat,lng] points in METRES. Equirectangular approximation —
 *  exact enough at building scale (sub-cm error over the tens of metres we care about). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000; // Earth radius (m)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const latMid = toRad((a.lat + b.lat) / 2);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng) * Math.cos(latMid);
  return R * Math.hypot(dLat, dLng);
}

/** If `candidate` pin is within MIN_BUILDING_SEPARATION_M of any OTHER building's pin, return that
 *  building's name/distance so the caller can reject; otherwise null. `others` excludes the building
 *  being edited (compare against siblings only). Pure → unit-tested. */
export function nearbyBuildingConflict(
  candidate: { lat: number; lng: number },
  others: { id: string; name: string; lat: number; lng: number }[],
): { id: string; name: string; meters: number } | null {
  for (const o of others) {
    const m = distanceMeters(candidate, o);
    if (m < MIN_BUILDING_SEPARATION_M) return { id: o.id, name: o.name, meters: m };
  }
  return null;
}

/** Validate a polygon: an array of [lat,lng] points in range. Returns the cleaned polygon or null (too
 *  few points / wrong shape → treated as absent, so a half-drawn polygon never corrupts the store). */
export function cleanPolygon(raw: unknown): [number, number][] | null {
  if (!Array.isArray(raw)) return null;
  const pts = raw
    .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN]))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180)
    .slice(0, 500) as [number, number][];
  return pts.length >= 3 ? pts : null; // a polygon needs ≥3 vertices
}
