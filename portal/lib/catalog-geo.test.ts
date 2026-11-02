// layer-1 validation checks — the site-plan geo payload (land/footprint polygons + north bearing)
// is validated + normalised by cleanGeo/cleanPolygon in app/api/catalog/geo/route.ts. Freeze that contract:
// polygons need ≥3 in-range vertices (half-drawn/garbage dropped), bearings wrap into 0–359, and previously
// payloads (point + roads only) are unaffected (absent-safe). Run via `npx tsx`.
import { cleanGeo, cleanPolygon, distanceMeters, nearbyBuildingConflict, MIN_BUILDING_SEPARATION_M } from "./catalog-geo";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// ── cleanPolygon ──
ok(cleanPolygon([[1, 1], [1, 2], [2, 2]])?.length === 3, "3-vertex polygon accepted");
ok(cleanPolygon([[1, 1], [1, 2]]) === null, "2-vertex polygon rejected (needs ≥3)");
ok(cleanPolygon([]) === null, "empty polygon rejected");
ok(cleanPolygon("nope") === null, "non-array rejected");
ok(cleanPolygon([[1, 1], [1, 2], [999, 2]]) === null, "out-of-range vertex drops below 3 → null");
ok((cleanPolygon([[1, 1], [1, 2], [2, 2], [91, 2]]) as [number, number][]).length === 3, "out-of-range vertex filtered, rest kept");

// ── cleanGeo: new fields persist ──
const g = cleanGeo({
  lat: 12.9236, lng: 100.8825,
  landPolygon: [[12.924, 100.882], [12.924, 100.883], [12.9232, 100.883]],
  footprintPolygon: [[12.9238, 100.8823], [12.9238, 100.8827], [12.9234, 100.8827]],
  northBearing: 405,
})!;
ok(g.landPolygon?.length === 3, "landPolygon persisted");
ok(g.footprintPolygon?.length === 3, "footprintPolygon persisted");
ok(g.northBearing === 45, "northBearing 405 normalised to 45");

// negative bearing wraps too
ok(cleanGeo({ lat: 0, lng: 0, northBearing: -90 })!.northBearing === 270, "northBearing -90 normalised to 270");

// ── absent-safe: previously payload unaffected ──
const old = cleanGeo({ lat: 1, lng: 2, accessRoads: [{ path: [[1, 1], [1, 2]] }] })!;
ok(old.landPolygon === undefined, "no landPolygon when not supplied");
ok(old.footprintPolygon === undefined, "no footprintPolygon when not supplied");
ok(old.northBearing === undefined, "no northBearing when not supplied");
ok(old.accessRoads?.length === 1, "existing accessRoads still work");

// half-drawn polygon on an otherwise-valid payload is dropped, not fatal
const half = cleanGeo({ lat: 1, lng: 2, landPolygon: [[1, 1], [1, 2]] })!;
ok(half.landPolygon === undefined, "half-drawn (2-pt) polygon dropped, payload still valid");

// ── no-overlap guard: buildings must be ≥ MIN_BUILDING_SEPARATION_M apart ──
// distanceMeters sanity: ~0.0001° lat ≈ 11.1 m at the equator.
{
  const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 0.0001, lng: 0 });
  ok(d > 10 && d < 12, `~0.0001deg lat ~= 11m (got ${d.toFixed(2)})`);
}
// The real Parkgate/Palmgate case: 2.6 m apart → conflict.
{
  const parkgate = { lat: 12.92552854761522, lng: 100.8755233883858 };
  const palmgate = { id: "palmgate", name: "Palmgate", lat: 12.925531197391074, lng: 100.87549929508641 };
  const clash = nearbyBuildingConflict(parkgate, [palmgate]);
  ok(clash !== null, "2.6m-apart sibling flagged as a conflict");
  ok(clash !== null && clash.meters < MIN_BUILDING_SEPARATION_M, "conflict distance is under the 5m threshold");
  ok(clash?.name === "Palmgate", "conflict names the clashing building");
}
// Well-separated pins → no conflict.
{
  const a = { lat: 12.9200, lng: 100.8770 };
  const far = { id: "x", name: "Far", lat: 12.9050, lng: 100.8680 }; // ~1.8km away
  ok(nearbyBuildingConflict(a, [far]) === null, "well-separated buildings do not conflict");
}
// Empty others (first building placed) → never conflicts.
ok(nearbyBuildingConflict({ lat: 1, lng: 1 }, []) === null, "no others → no conflict");
// Exactly at the threshold is allowed (strictly LESS than 5m conflicts).
{
  // craft a point ~6m north → allowed; ~4m north → blocked.
  const base = { lat: 12.9, lng: 100.9 };
  const sixM = { lat: 12.9 + 0.000054, lng: 100.9 }; // ~6.0 m
  const fourM = { lat: 12.9 + 0.000036, lng: 100.9 }; // ~4.0 m
  ok(nearbyBuildingConflict(sixM, [{ id: "b", name: "B", ...base }]) === null, "~6m apart allowed");
  ok(nearbyBuildingConflict(fourM, [{ id: "b", name: "B", ...base }]) !== null, "~4m apart blocked");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("ALL SITE-PLAN GEO VALIDATION CHECKS PASSED");
