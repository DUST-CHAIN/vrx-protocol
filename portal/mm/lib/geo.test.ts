// §4d geometry-engine tests (lib/geo.ts). Pure, no I/O. Run via tsx.
// Covers: clampRect containment, the nested-fraction metre derivation + deriveSqm, constrainToSqm,
// the named factories (valid shapes, child-kind depth), and tree navigation over pack.geo[].

import { emptyPack, type Footprint, type GeoNode, type Pack } from "./pack";
import {
  ancestorsOf,
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN,
  cameraViewPhrase,
  CHILD_KIND,
  childrenOf,
  clampCamera,
  clampRect,
  compass16,
  constrainPolySqm,
  constrainRectSqmAtOrigin,
  constrainToSqm,
  DEFAULT_CAMERA,
  deriveSqm,
  effectiveFootprint,
  footprintSelfNorm,
  renderFootprint,
  rotatePointsAboutCentre,
  editsSharedPlanOnly,
  unitShownAsShape,
  resolvePlan,
  subtypeForNode,
  subtypeLockedSqm,
  writeSubtypePlanFootprint,
  writeSubtypePlanPatch,
  bboxFromCenterMetres,
  bboxFromLatLngPolygon,
  detectEdgeLinks,
  edgeLengthsMetres,
  facingFromVector,
  facingVectorTip,
  floorSummary,
  footprintToLatLngPolygon,
  frustumPoints,
  haversineMetres,
  isLocked,
  latLngPolygonToFootprint,
  footprintToLatLngParcel,
  makeNode,
  metreExtentFromLatLngPolygon,
  normDeg,
  parcelFootprintForBuilding,
  parentShapeInChildFrame,
  insetForParentShape,
  seedRectFloorsUnderPolyBuilding,
  seedNextFloorFromApproved,
  niceMetreStep,
  FLOOR_SEED_INSET,
  canMatchParentShape,
  ancestorLayersMetric,
  nodePosM,
  derivePosM,
  pointInPoly,
  polyInPoly,
  polyMetrePoints,
  toMetrePoly,
  fromMetrePoly,
  footprintWithStoredMetres,
  planFootprintWithStoredMetres,
  hydrateGeoMetres,
  realMetres,
  scaleFootprintAboutOrigin,
  unitsFitInFloorShape,
  rootNodes,
  scalePolyAboutCentroid,
  setEdgeLengthMetres,
  shoelaceArea,
  snapToColumns,
  STATUS_FILL,
  toggleInSet,
  UNIT_STATUSES,
  polyCentroid,
  bearingFromVectorMetres,
  deskewToFrontDown,
  reskewForMap,
  bearingFromLongestEdgeMetres,
  latLngPolygonToMetrePoints,
  bearingFromLatLngPolygon,
  latLngPolygonToSquareFootprint,
} from "./geo";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

// --- clampRect (containment / never-protrude) ---
const r1 = clampRect({ x: 0.8, y: 0.8, w: 0.5, h: 0.5 });
ok(r1.x + r1.w <= 1 + 1e-9 && r1.y + r1.h <= 1 + 1e-9, "clampRect keeps a rect inside the parent (0..1)");
const r2 = clampRect({ x: -0.2, y: -0.2, w: 0.3, h: 0.3 });
ok(r2.x >= 0 && r2.y >= 0, "clampRect pulls negatives back to 0");
const r3 = clampRect({ x: 0.5, y: 0.5, w: 0, h: 0 });
ok(r3.w >= 0.01 && r3.h >= 0.01, "clampRect floors a degenerate box to a visible minimum");

// --- build a small tree: building (40×25 m anchor) → floor → unit (half × half) ---
let ids = new Set<string>();
const building = makeNode("building", undefined, { metreW: 40, metreH: 25, rect: { x: 0, y: 0, w: 1, h: 1 } }, ids);
ids.add(building.id);
const floor = makeNode("floor", building.id, { rect: { x: 0, y: 0, w: 1, h: 1 }, heightM: 3 }, ids);
ids.add(floor.id);
const unit = makeNode("unit", floor.id, { rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, ids);
ids.add(unit.id);

const pack: Pack = { ...emptyPack("Geo Test"), geo: [building, floor, unit] };

// --- metre derivation down the nested fractions ---
const rm = realMetres(pack, unit.id);
ok(!!rm && near(rm.w, 20) && near(rm.h, 12.5), "realMetres: 40m×0.5 = 20m wide, 25m×0.5 = 12.5m deep");
ok(near(deriveSqm(pack, unit.id)!, 250), "deriveSqm: 20 × 12.5 = 250 m²");
ok(near(deriveSqm(pack, floor.id)!, 1000), "deriveSqm: full floor = 40 × 25 = 1000 m²");
ok(deriveSqm({ ...pack, geo: [{ ...unit, parentId: undefined }] }, unit.id) === undefined, "deriveSqm undefined with no metre anchor");

// --- B3: niceMetreStep — a 1/2/5×10ⁿ grid step giving ~8+ divisions across the frame's larger side ---
ok(niceMetreStep(60) === 5, "niceMetreStep: a 60 m frame → 5 m squares (60/8=7.5 → snaps down to 5)");
ok(niceMetreStep(600) === 50, "niceMetreStep: a 600 m parcel → 50 m squares");
ok(niceMetreStep(6) === 0.5, "niceMetreStep: a 6 m room → 0.5 m squares");
ok(niceMetreStep(100) === 10, "niceMetreStep: 100 m → 10 m (100/8=12.5 → snaps down to 10)");
ok(niceMetreStep(25) === 2, "niceMetreStep: 25 m → 2 m (25/8≈3.1 → snaps down to 2)");
ok(niceMetreStep(undefined) === undefined, "niceMetreStep: no extent → undefined (no grid without a metre anchor)");
ok(niceMetreStep(0) === undefined && niceMetreStep(-5) === undefined, "niceMetreStep: ≤0 extent → undefined");
// step always yields >= minDivs squares across the extent (the guarantee the grid density rests on)
for (const ext of [3, 7, 42, 123, 777, 1999]) { const s = niceMetreStep(ext)!; ok(ext / s >= 8 - 1e-9, `niceMetreStep(${ext}) → ${s}: ≥8 divisions (${(ext/s).toFixed(1)})`); }

// --- constrainToSqm: pin the unit to 100 m² and confirm the derived area follows ---
const newRect = constrainToSqm(pack, unit.id, 100);
const constrained: GeoNode = { ...unit, footprint: { shape: "rect", rect: newRect } };
const packC: Pack = { ...pack, geo: [building, floor, constrained] };
ok(near(deriveSqm(packC, unit.id)!, 100, 0.5), "constrainToSqm: pinning to 100 m² yields ~100 m² derived");
ok(near(newRect.w / newRect.h, (unit.footprint as any).rect.w / (unit.footprint as any).rect.h, 0.02), "constrainToSqm keeps aspect ratio");

// --- factories: valid shapes, depth, defaults ---
ok(building.kind === "building" && building.footprint?.shape === "rect", "makeNode seeds a rect footprint");
ok(building.factoryName === "make-building", "makeNode stamps a factoryName (clipper convention)");
ok(floor.heightM === 3, "floor factory seeds a real height (3m default)");
ok(unit.status === "available", "unit factory seeds status=available");
ok(CHILD_KIND.building === "floor" && CHILD_KIND.unit === "prop" && CHILD_KIND.prop === null, "CHILD_KIND encodes the Russian-doll depth");

// --- tree navigation ---
ok(rootNodes(pack).length === 1 && rootNodes(pack)[0].id === building.id, "rootNodes finds the parentless building");
ok(childrenOf(pack, building.id).length === 1 && childrenOf(pack, floor.id)[0].id === unit.id, "childrenOf walks the tree");

// --- status table completeness ---
ok(UNIT_STATUSES.every((s) => !!STATUS_FILL[s]), "every status has a fill colour");

// ===========================================================================
// POLYGON engine (slice 2.x — illustration-grade dimensioned editor)
// ===========================================================================

// shoelace: a 2×3 metre rectangle = 6 m²; a unit-square = 1
ok(near(shoelaceArea([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }, { x: 0, y: 3 }]), 6), "shoelace: 2×3 rect = 6");
ok(near(shoelaceArea([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]), 0.5), "shoelace: unit right-triangle = 0.5");
// an L-shape (outer 4×4 minus a 2×2 notch) = 16 − 4 = 12
const lshape = [ { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 4 } ];
ok(near(shoelaceArea(lshape), 12), "shoelace: 4×4 L minus 2×2 notch = 12");

// Build a poly node: a half×half RECT-poly inside the 40×25 building → metres (0,0)(20,0)(20,12.5)(0,12.5)
let pids = new Set<string>();
const pBuilding = makeNode("building", undefined, { metreW: 40, metreH: 25, rect: { x: 0, y: 0, w: 1, h: 1 } }, pids);
pids.add(pBuilding.id);
const polyUnit: GeoNode = {
  id: "poly-1", name: "Poly", kind: "floor", parentId: pBuilding.id,
  footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 } ] },
};
const pPack: Pack = { ...emptyPack("Poly Test"), geo: [pBuilding, polyUnit] };

const mp = polyMetrePoints(pPack, polyUnit.id)!;
ok(!!mp && near(mp[2].x, 20) && near(mp[2].y, 12.5), "polyMetrePoints maps fractions through the parent metre extent");
ok(near(deriveSqm(pPack, polyUnit.id)!, 250), "deriveSqm(poly): shoelace of 20×12.5 = 250 m²");

const el = edgeLengthsMetres(pPack, polyUnit.id);
ok(el.length === 4 && near(el[0], 20) && near(el[1], 12.5) && near(el[2], 20) && near(el[3], 12.5), "edgeLengthsMetres: 20,12.5,20,12.5");

const links = detectEdgeLinks(pPack, polyUnit.id);
ok(links.length === 2 && links.every((g) => g.length === 2), "detectEdgeLinks: two linked pairs (opposite walls)");
ok(links.some((g) => g.includes(0) && g.includes(2)) && links.some((g) => g.includes(1) && g.includes(3)), "links pair parallel+equal edges (0↔2, 1↔3)");

// set edge 0 → 30 m; its link partner (edge 2) must follow to 30 m too
const np = setEdgeLengthMetres(pPack, polyUnit.id, 0, 30);
const pPack2: Pack = { ...pPack, geo: [pBuilding, { ...polyUnit, footprint: { shape: "poly", points: np } }] };
const el2 = edgeLengthsMetres(pPack2, polyUnit.id);
ok(near(el2[0], 30, 0.05), "setEdgeLengthMetres: edge 0 is now 30 m");
ok(near(el2[2], 30, 0.05), "setEdgeLengthMetres: linked edge 2 followed to 30 m");

// freeze far vertex of edge 0 (vertex 1) → setting edge 0 slides the NEAR end instead, edge still = target
const frozenPoly: GeoNode = { ...polyUnit, footprint: { shape: "poly", points: polyUnit.footprint!.shape === "poly" ? (polyUnit.footprint as any).points : [], frozenVerts: [1] } };
const pPackF: Pack = { ...pPack, geo: [pBuilding, frozenPoly] };
const npF = setEdgeLengthMetres(pPackF, frozenPoly.id, 0, 10);
ok(near(npF[1].x, 0.5) && near(npF[1].y, 0), "frozen far vertex did NOT move");
const pPackF2: Pack = { ...pPackF, geo: [pBuilding, { ...frozenPoly, footprint: { shape: "poly", points: npF, frozenVerts: [1] } }] };
ok(near(edgeLengthsMetres(pPackF2, frozenPoly.id)[0], 10, 0.05), "edge still took the target length (near end slid)");

// poly m² pin: scale the 250 m² NON-ANCHOR poly to 1000 m² (k=2), shape kept similar → returns kind:"points"
const pinnedR = constrainPolySqm(pPack, polyUnit.id, 1000);
ok(pinnedR.kind === "points", "constrainPolySqm: a NON-anchor node scales its points (kind 'points')");
const pinned = pinnedR.kind === "points" ? pinnedR.points : [];
const pPackP: Pack = { ...pPack, geo: [pBuilding, { ...polyUnit, footprint: { shape: "poly", points: pinned } }] };
ok(near(deriveSqm(pPackP, polyUnit.id)!, 1000, 1), "constrainPolySqm: pinned to 1000 m² yields ~1000 m²");
const elP = edgeLengthsMetres(pPackP, polyUnit.id);
ok(near(elP[0] / elP[1], el[0] / el[1], 0.02), "constrainPolySqm keeps the shape (edge ratio preserved)");

// (D- step 6) poly m² pin on an ANCHOR node — the quirk fix. A building IS its own anchor (40×25 = 1000 m²
// bbox; a full-bbox rect-poly → 1000 m²). Pinning it to 4000 m² must return a kind:"anchorScale" with k=2 (area
// ×4 → linear ×2), NOT scale the points (which would no-op — the old quirk). Applying k to metreW/H hits the target.
const anchorPoly: GeoNode = { ...pBuilding, footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 } ] } };
const aPack: Pack = { ...emptyPack("anchor"), geo: [anchorPoly] };
ok(near(deriveSqm(aPack, anchorPoly.id)!, 1000, 1), "constrainPolySqm(anchor): the full-bbox poly starts at 40×25 = 1000 m²");
const aR = constrainPolySqm(aPack, anchorPoly.id, 4000);
ok(aR.kind === "anchorScale", "constrainPolySqm: an ANCHOR node returns kind 'anchorScale' (scale lives in metreW/H, not points)");
ok(aR.kind === "anchorScale" && near(aR.k, 2, 0.001), "constrainPolySqm(anchor): k = √(4000/1000) = 2");
// applying k to the anchor hits the target area (what pinPolySqm does): metreW/H ×2 → 80×50 = 4000 m².
const aScaled: Pack = aR.kind === "anchorScale" ? { ...aPack, geo: [{ ...anchorPoly, metreW: anchorPoly.metreW! * aR.k, metreH: anchorPoly.metreH! * aR.k, footprint: { shape: "poly", points: (anchorPoly.footprint as any).points } }] } : aPack;
ok(near(deriveSqm(aScaled, anchorPoly.id)!, 4000, 1), "constrainPolySqm(anchor): applying k to metreW/H yields the target 4000 m² (the quirk is FIXED — no longer a no-op)");
// INDEPENDENT ANCHORS (D-): a NON-LEAF anchor (has a child deriving metres from it) is no longer
// BLOCKED — resizing it is a PLOT-boundary op. constrainPolySqm returns the real k + scaleChildren:true; the caller
// (pinPolySqm) scales the anchor's metreW/H by k AND every direct child's footprint by 1/k about the origin, so the
// child's real size (fraction × anchor metres) is INVARIANT. The land grows; the tower stays put.
const anchorChild: GeoNode = { id: "ac-child", name: "child", kind: "building", parentId: anchorPoly.id, footprint: { shape: "rect", rect: { x: 0.2, y: 0.2, w: 0.5, h: 0.4 } } };
const aNonLeaf: Pack = { ...emptyPack("nonleaf"), geo: [anchorPoly, anchorChild] };
const childBefore = realMetres(aNonLeaf, anchorChild.id)!; // child's real size BEFORE the land resize
const nlR = constrainPolySqm(aNonLeaf, anchorPoly.id, 4000);
ok(nlR.kind === "anchorScale" && nlR.scaleChildren === true, "constrainPolySqm: a NON-leaf anchor returns scaleChildren (independent anchors — no longer blocked)");
ok(nlR.kind === "anchorScale" && near(nlR.k, 2, 0.001), "constrainPolySqm(non-leaf anchor): k = √(4000/1000) = 2");
// replicate what pinPolySqm does: scale the anchor metreW/H ×k, scale the child footprint ×(1/k) about the origin.
const nlK = nlR.kind === "anchorScale" ? nlR.k : 1;
const nlScaled: Pack = { ...aNonLeaf, geo: [
  { ...anchorPoly, metreW: anchorPoly.metreW! * nlK, metreH: anchorPoly.metreH! * nlK },
  { ...anchorChild, footprint: scaleFootprintAboutOrigin(anchorChild.footprint, 1 / nlK)! },
] };
ok(near(deriveSqm(nlScaled, anchorPoly.id)!, 4000, 1), "independent anchors: the LAND reaches its target 4000 m²");
const childAfter = realMetres(nlScaled, anchorChild.id)!;
ok(near(childAfter.w, childBefore.w, 0.01) && near(childAfter.h, childBefore.h, 0.01), "independent anchors: the CHILD's real size is UNCHANGED when the land resizes (the tower stays put)");

// toggleInSet (freeze set helper)
ok(JSON.stringify(toggleInSet(undefined, 2)) === "[2]", "toggleInSet adds to an empty set");
ok(toggleInSet([2], 2) === undefined, "toggleInSet removes the last → undefined");
ok(JSON.stringify(toggleInSet([1, 3], 2)) === "[1,2,3]", "toggleInSet inserts sorted");

// --- geographic → metre scale (slice 2.5: the map seeds the land metre anchor) ---
// A ~0.001° box near the equator-ish Pattaya latitude (~12.92°). 0.001° lat ≈ 111 m; 0.001° lng ≈ 108 m here.
ok(near(haversineMetres([12.92, 100.88], [12.921, 100.88]), 111.2, 1.5), "haversine: 0.001° latitude ≈ 111 m");
const ext = metreExtentFromLatLngPolygon([
  [12.9200, 100.8800],
  [12.9200, 100.8810], // +0.0010° lng  → ~108 m wide at this latitude
  [12.9205, 100.8810], // +0.0005° lat  → ~55.6 m deep
  [12.9205, 100.8800],
]);
ok(!!ext && near(ext.w, 108.4, 2) && near(ext.h, 55.6, 1.5), "metreExtent: parcel bbox ≈ 108 × 55.6 m");
ok(metreExtentFromLatLngPolygon([[12.92, 100.88]]) === undefined, "metreExtent undefined for < 2 corners");
ok(metreExtentFromLatLngPolygon(undefined) === undefined, "metreExtent undefined for no polygon");
// a degenerate (all-same-point) parcel has no extent → undefined, not a 0×0 anchor
ok(metreExtentFromLatLngPolygon([[12.92, 100.88], [12.92, 100.88]]) === undefined, "metreExtent undefined for a zero-area parcel");

// --- map → editor bridge: latLngPolygonToFootprint (D- draw-on-map first) ---
// The same ~108×55.6 m parcel, traced clockwise from its SW corner. Expect a 0..1 bbox-normalized poly
// with north (max lat) at the TOP (y=0) and east (max lng) at the RIGHT (x=1).
const fp = latLngPolygonToFootprint([
  [12.9200, 100.8800], // SW  → x=0, y=1 (min lat = south = bottom)
  [12.9200, 100.8810], // SE  → x=1, y=1
  [12.9205, 100.8810], // NE  → x=1, y=0 (max lat = north = top)
  [12.9205, 100.8800], // NW  → x=0, y=0
]);
ok(!!fp && fp.shape === "poly" && fp.points.length === 4, "latLngToFootprint: 4-corner poly");
ok(!!fp && near(fp.points[0].x, 0, 0.001) && near(fp.points[0].y, 1, 0.001), "latLngToFootprint: SW → (0,1)");
ok(!!fp && near(fp.points[1].x, 1, 0.001) && near(fp.points[1].y, 1, 0.001), "latLngToFootprint: SE → (1,1)");
ok(!!fp && near(fp.points[2].x, 1, 0.001) && near(fp.points[2].y, 0, 0.001), "latLngToFootprint: NE → (1,0) (north-up)");
ok(!!fp && near(fp.points[3].x, 0, 0.001) && near(fp.points[3].y, 0, 0.001), "latLngToFootprint: NW → (0,0)");
// an L-shaped (5-corner) parcel keeps all 5 vertices, each clamped to 0..1
const lShape = latLngPolygonToFootprint([
  [12.9200, 100.8800], [12.9200, 100.8810], [12.9203, 100.8810],
  [12.9203, 100.8805], [12.9205, 100.8805],
]);
ok(!!lShape && lShape.points.length === 5, "latLngToFootprint: L-shape keeps all 5 vertices");
ok(!!lShape && lShape.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), "latLngToFootprint: all points in 0..1");
// degenerate guards: < 3 corners, zero span, or no polygon → undefined (caller leaves the footprint alone)
ok(latLngPolygonToFootprint([[12.92, 100.88], [12.92, 100.881]]) === undefined, "latLngToFootprint undefined for < 3 corners");
ok(latLngPolygonToFootprint([[12.92, 100.88], [12.92, 100.881], [12.92, 100.882]]) === undefined, "latLngToFootprint undefined for zero lat span");
ok(latLngPolygonToFootprint(undefined) === undefined, "latLngToFootprint undefined for no polygon");

// --- editor → map bridge: footprintToLatLngParcel ("place my drawn shape, don't re-trace") ---
// A 90×70 m RECT land footprint placed at a Pattaya pin, bearing 0, should come back as a ring whose metre
// bbox ≈ 90×70 and whose CENTROID ≈ the pin (the shape is centred on the pin).
const pin: [number, number] = [12.9236, 100.8825];
const ring = footprintToLatLngParcel({ shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } }, 90, 70, pin, 0);
ok(!!ring && ring.length === 4, "footprintToLatLngParcel: rect → 4-corner ring");
const rExt = metreExtentFromLatLngPolygon(ring);
ok(!!rExt && near(rExt.w, 90, 1) && near(rExt.h, 70, 1), "footprintToLatLngParcel: metre bbox ≈ 90×70 (scale preserved)");
const cLat = ring!.reduce((s, p) => s + p[0], 0) / ring!.length;
const cLng = ring!.reduce((s, p) => s + p[1], 0) / ring!.length;
ok(near(cLat, pin[0], 1e-4) && near(cLng, pin[1], 1e-4), "footprintToLatLngParcel: centred on the pin");
// a 90° bearing SWAPS the bbox (90 wide, 70 tall → 70 wide, 90 tall) — the shape rotates rigidly, scale kept.
const ringRot90 = footprintToLatLngParcel({ shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } }, 90, 70, pin, 90);
const extRot90 = metreExtentFromLatLngPolygon(ringRot90);
ok(!!extRot90 && near(extRot90.w, 70, 1.5) && near(extRot90.h, 90, 1.5), "footprintToLatLngParcel: 90° bearing swaps the bbox (rigid rotate)");
// guards: no footprint / no pin / non-positive metre size → undefined (caller leaves the parcel alone)
ok(footprintToLatLngParcel(undefined, 90, 70, pin, 0) === undefined, "footprintToLatLngParcel undefined for no footprint");
ok(footprintToLatLngParcel({ shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } }, 90, 70, undefined, 0) === undefined, "footprintToLatLngParcel undefined for no pin");
ok(footprintToLatLngParcel({ shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } }, 0, 70, pin, 0) === undefined, "footprintToLatLngParcel undefined for zero metre width");

// --- metre-native step 3c (D-): the place-drawn round-trip is LOSSLESS at a non-zero bearing. ---
// The map⇄studio drift: a shape PLACED at bearing≠0 was read back via latLngPolygonToFootprint, which
// re-normalizes the ROTATED ring per-axis against its axis-aligned bbox → the shape shears ("from another
// dimension"). The fix keeps the editor metre footprint + northBearingDeg as the one truth and RE-DERIVES the ring
// rigidly. We prove: (1) the old re-import path DOES distort a rotated L-shape (the regression we're fixing), and
// (2) re-deriving the ring rigidly (footprintToLatLngParcel at the same bearing) recovers the SAME ring (identity).
const lFootprint: Extract<Footprint, { shape: "poly" }> = {
  shape: "poly",
  points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }],
};
const BRG = 45;
const placed = footprintToLatLngParcel(lFootprint, 80, 60, pin, BRG);
ok(!!placed && placed.length === 6, "place-drawn: L-shape → 6-corner ring at bearing 45°");
// (1) the LOSSY path — re-importing the rotated ring re-normalizes per-axis → the recovered 0..1 points DIFFER from
// the true editor footprint (this is the bug; the fix routes AROUND this, never through it, for a placed shape).
const reimported = latLngPolygonToFootprint(placed);
const distorted = !!reimported && lFootprint.points.some((p, i) => !near(reimported!.points[i].x, p.x, 0.02) || !near(reimported!.points[i].y, p.y, 0.02));
ok(distorted, "place-drawn: re-importing the ROTATED ring DISTORTS the shape (the S289 drift the fix avoids)");
// (2) the LOSSLESS path — re-derive the ring from the SAME preserved editor footprint + bearing about the ring's
// centroid → identical ring (editor→map→editor stays put; this is syncParcelFromFootprint's rotated branch).
const pc: [number, number] = [placed!.reduce((s, p) => s + p[0], 0) / placed!.length, placed!.reduce((s, p) => s + p[1], 0) / placed!.length];
const rederived = footprintToLatLngParcel(lFootprint, 80, 60, pc, BRG);
ok(!!rederived && placed!.every((c, i) => near(rederived![i][0], c[0], 1e-6) && near(rederived![i][1], c[1], 1e-6)),
  "place-drawn: re-deriving rigidly (same footprint+bearing) recovers the SAME ring (lossless editor→map→editor)");

// --- editor → map bridge: footprintToLatLngPolygon + anchors (D- draw-on-ref-then-align) ---
// bboxFromLatLngPolygon = the REFINE anchor (the same bbox the forward pass normalized against).
const parcel: [number, number][] = [
  [12.9200, 100.8800], [12.9200, 100.8810], [12.9205, 100.8810], [12.9205, 100.8800],
];
const bb = bboxFromLatLngPolygon(parcel);
ok(!!bb && near(bb.minLat, 12.92, 1e-6) && near(bb.maxLat, 12.9205, 1e-6), "bboxFromLatLngPolygon: lat span");
ok(!!bb && near(bb.minLng, 100.88, 1e-6) && near(bb.maxLng, 100.881, 1e-6), "bboxFromLatLngPolygon: lng span");
ok(bboxFromLatLngPolygon([[12.92, 100.88]]) === undefined, "bboxFromLatLngPolygon undefined for < 2 corners");
ok(bboxFromLatLngPolygon([[12.92, 100.88], [12.92, 100.88]]) === undefined, "bboxFromLatLngPolygon undefined for zero span");

// THE KEY PROPERTY: forward ∘ reverse is identity. Normalize the parcel to a 0..1 footprint, project it back
// through its own bbox, and the lat/lng corners must return (within r6 rounding).
const fwd = latLngPolygonToFootprint(parcel);
const back = footprintToLatLngPolygon(fwd, bb);
ok(!!back && back.length === 4, "footprintToLatLng: round-trip keeps 4 corners");
ok(!!back && parcel.every((c, i) => near(back![i][0], c[0], 1e-4) && near(back![i][1], c[1], 1e-4)),
  "footprintToLatLng: forward∘reverse = identity (parcel corners recovered)");
// north-up check: the footprint's TOP (y=0) maps to the MAX latitude (north).
const topPt = footprintToLatLngPolygon({ shape: "poly", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] }, bb);
ok(!!topPt && near(topPt[0][0], 12.9205, 1e-6), "footprintToLatLng: y=0 (top) → maxLat (north-up)");
ok(!!topPt && near(topPt[2][0], 12.9200, 1e-6), "footprintToLatLng: y=1 (bottom) → minLat");
// an L-shape (5 pts) survives the round-trip corner count
const lFwd = latLngPolygonToFootprint([
  [12.9200, 100.8800], [12.9200, 100.8810], [12.9203, 100.8810], [12.9203, 100.8805], [12.9205, 100.8805],
]);
ok(footprintToLatLngPolygon(lFwd, bb)?.length === 5, "footprintToLatLng: L-shape keeps all 5 vertices");
// degenerate guards
ok(footprintToLatLngPolygon({ shape: "poly", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, bb) === undefined, "footprintToLatLng undefined for < 3 pts");
ok(footprintToLatLngPolygon(fwd, { minLat: 12.92, maxLat: 12.92, minLng: 100.88, maxLng: 100.881 }) === undefined, "footprintToLatLng undefined for zero-lat bbox");
ok(footprintToLatLngPolygon(fwd, undefined) === undefined, "footprintToLatLng undefined for no bbox");
ok(footprintToLatLngPolygon(undefined, bb) === undefined, "footprintToLatLng undefined for no footprint");

// bboxFromCenterMetres = the ORIGINATE anchor (pin + metre extent, no prior trace). A 108×55.6 m parcel at the
// northpoint pin should produce a bbox whose metre extent round-trips back to ~108×55.6 via metreExtentFromLatLngPolygon.
const originBox = bboxFromCenterMetres([12.92, 100.88], 108, 55.6);
ok(!!originBox, "bboxFromCenterMetres: builds a bbox from pin + metres");
const originPoly: [number, number][] = originBox
  ? [[originBox.minLat, originBox.minLng], [originBox.minLat, originBox.maxLng], [originBox.maxLat, originBox.maxLng], [originBox.maxLat, originBox.minLng]]
  : [];
const originExt = metreExtentFromLatLngPolygon(originPoly);
ok(!!originExt && near(originExt.w, 108, 1.5) && near(originExt.h, 55.6, 1.5), "bboxFromCenterMetres: metre extent round-trips (~108×55.6 m)");
ok(!!originBox && near((originBox.minLat + originBox.maxLat) / 2, 12.92, 1e-6) && near((originBox.minLng + originBox.maxLng) / 2, 100.88, 1e-6), "bboxFromCenterMetres: centred on the pin");
ok(bboxFromCenterMetres(undefined, 108, 55.6) === undefined, "bboxFromCenterMetres undefined for no pin");
ok(bboxFromCenterMetres([12.92, 100.88], 0, 55.6) === undefined, "bboxFromCenterMetres undefined for zero width");

// ===========================================================================
// FACING VECTOR — editor-space pose: 0 = up, clockwise. normDeg / facingVectorTip / facingFromVector / compass16.
// ===========================================================================

// normDeg wraps negatives + multiple turns into 0..359
ok(normDeg(0) === 0 && normDeg(360) === 0 && normDeg(359) === 359, "normDeg: 0/360/359");
ok(normDeg(-90) === 270, "normDeg: -90 → 270");
ok(normDeg(450) === 90 && normDeg(-450) === 270, "normDeg: wraps multiple turns");

// facingVectorTip: 0 = up (−y), 90 = right (+x), 180 = down (+y), 270 = left (−x). Screen y grows down.
const up = facingVectorTip(0, 10);
ok(near(up.dx, 0) && near(up.dy, -10), "facingVectorTip: 0° points up (0, -len)");
const right = facingVectorTip(90, 10);
ok(near(right.dx, 10) && near(right.dy, 0), "facingVectorTip: 90° points right (+len, 0)");
const down = facingVectorTip(180, 10);
ok(near(down.dx, 0) && near(down.dy, 10), "facingVectorTip: 180° points down (0, +len)");
const left = facingVectorTip(270, 10);
ok(near(left.dx, -10) && near(left.dy, 0), "facingVectorTip: 270° points left (-len, 0)");

// facingFromVector: the INVERSE — a tip dragged to a screen point → the facing degree (centre at 100,100).
ok(near(facingFromVector(100, 100, 100, 80), 0), "facingFromVector: tip above centre → 0° (up)");
ok(near(facingFromVector(100, 100, 120, 100), 90), "facingFromVector: tip right of centre → 90°");
ok(near(facingFromVector(100, 100, 100, 120), 180), "facingFromVector: tip below centre → 180°");
ok(near(facingFromVector(100, 100, 80, 100), 270), "facingFromVector: tip left of centre → 270°");
ok(facingFromVector(100, 100, 100, 100) === 0, "facingFromVector: zero-length drag → 0° (no NaN)");

// round-trip: tip(deg) then back through facingFromVector recovers deg, for several angles
for (const d of [0, 30, 45, 90, 135, 200, 315, 359]) {
  const t = facingVectorTip(d, 25);
  ok(near(facingFromVector(0, 0, t.dx, t.dy), d, 0.01), `facing round-trip at ${d}°`);
}

// compass16: 16-point label (0 = N/up, clockwise)
ok(compass16(0) === "N" && compass16(90) === "E" && compass16(180) === "S" && compass16(270) === "W", "compass16: cardinals");
ok(compass16(45) === "NE" && compass16(-45) === "NW" && compass16(360) === "N", "compass16: diagonals + wrap");

// ===========================================================================
// CAMERA / FRUSTUM — clampCamera / frustumPoints / cameraViewPhrase. Reuses the facing trig.
// ===========================================================================

// clampCamera: x/y into 0..1, facing normalized, fov into [MIN,MAX]
const cc = clampCamera({ x: 1.5, y: -0.2, facingDeg: -90, fovDeg: 5 });
ok(cc.x === 1 && cc.y === 0, "clampCamera: x/y clamped to 0..1");
ok(cc.facingDeg === 270, "clampCamera: facing normalized (-90 → 270)");
ok(cc.fovDeg === CAMERA_FOV_MIN, "clampCamera: fov floored to MIN");
ok(clampCamera({ x: 0.5, y: 0.5, facingDeg: 0, fovDeg: 999 }).fovDeg === CAMERA_FOV_MAX, "clampCamera: fov capped to MAX");
ok(DEFAULT_CAMERA.fovDeg === 60 && DEFAULT_CAMERA.x === 0.5, "DEFAULT_CAMERA: centred ~60°");

// frustumPoints: apex at the camera, two edges at facing ± fov/2 of length len. A camera at centre facing up
// with 90° fov → left edge up-left, right edge up-right (symmetric about straight up).
const fru = frustumPoints({ x: 0.5, y: 0.5, facingDeg: 0, fovDeg: 90 }, 0.4);
ok(near(fru.apex.x, 0.5) && near(fru.apex.y, 0.5), "frustumPoints: apex at the camera position");
// facing-45 (up-left) tip and facing+45 (up-right) tip of length 0.4
const fle = facingVectorTip(-45, 0.4), fre = facingVectorTip(45, 0.4);
ok(near(fru.left.x, 0.5 + fle.dx) && near(fru.left.y, 0.5 + fle.dy), "frustumPoints: left edge at facing-fov/2");
ok(near(fru.right.x, 0.5 + fre.dx) && near(fru.right.y, 0.5 + fre.dy), "frustumPoints: right edge at facing+fov/2");
ok(fru.left.y < 0.5 && fru.right.y < 0.5, "frustumPoints: a camera looking up points the cone upward (y<0.5)");
// the two edges are symmetric about the centre facing ray (equal |dx| from apex x)
ok(near(Math.abs(fru.left.x - 0.5), Math.abs(fru.right.x - 0.5)), "frustumPoints: edges symmetric about the facing ray");

// cameraViewPhrase: reads in ROOM terms + compass + a lens word, and includes the fov number
const ph = cameraViewPhrase({ x: 0.1, y: 0.9, facingDeg: 45, fovDeg: 60 });
ok(ph.includes("near-left"), "cameraViewPhrase: near-left corner (x low, y high)");
ok(ph.includes("NE"), "cameraViewPhrase: compass facing (45 → NE)");
ok(ph.includes("60°"), "cameraViewPhrase: includes the fov degrees");
ok(cameraViewPhrase({ x: 0.5, y: 0.5, facingDeg: 0, fovDeg: 120 }).includes("very wide"), "cameraViewPhrase: wide fov → 'very wide'");
ok(cameraViewPhrase({ x: 0.5, y: 0.5, facingDeg: 0, fovDeg: 30 }).includes("tight"), "cameraViewPhrase: narrow fov → 'tight'");
ok(cameraViewPhrase({ x: 0.5, y: 0.5, facingDeg: 180, fovDeg: 60 }).includes("centre of the room"), "cameraViewPhrase: centred reads 'centre of the room'");

// ===========================================================================
// FLOOR ROLL-UP + COLUMN SNAP (slice-2.x draw polish)
// ===========================================================================

// floorSummary: a floor (40×25 m anchor) with 3 units — 2 available, 1 reserved-minus — at half×half each (250 m²).
let fids = new Set<string>();
const fBuilding = makeNode("building", undefined, { metreW: 40, metreH: 25, rect: { x: 0, y: 0, w: 1, h: 1 } }, fids);
fids.add(fBuilding.id);
const fFloor = makeNode("floor", fBuilding.id, { rect: { x: 0, y: 0, w: 1, h: 1 }, heightM: 3 }, fids);
fids.add(fFloor.id);
const u1 = makeNode("unit", fFloor.id, { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, status: "available" }, fids); fids.add(u1.id);
const u2 = makeNode("unit", fFloor.id, { rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, status: "available" }, fids); fids.add(u2.id);
const u3 = makeNode("unit", fFloor.id, { rect: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, status: "reserved-minus" }, fids); fids.add(u3.id);
const fPack: Pack = { ...emptyPack("Floor Test"), geo: [fBuilding, fFloor, u1, u2, u3] };

const fs = floorSummary(fPack, fFloor.id);
ok(fs.units === 3, "floorSummary: counts 3 units");
ok(near(fs.totalSqm, 750), "floorSummary: total m² = 3 × 250 = 750");
ok(fs.byStatus.length === 2, "floorSummary: two distinct statuses present");
ok(fs.byStatus[0].status === "available" && fs.byStatus[0].count === 2, "floorSummary: available tally = 2 (UNIT_STATUSES order)");
ok(fs.byStatus[1].status === "reserved-minus" && fs.byStatus[1].count === 1, "floorSummary: reserved-minus tally = 1");
ok(floorSummary(fPack, fBuilding.id).units === 0, "floorSummary: a building (no unit children) rolls up 0 units");
// a unit with no metre anchor counts but adds 0 m²
const noAnchor: Pack = { ...emptyPack("x"), geo: [makeNode("unit", undefined, { rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, new Set())] };
const fsNA = floorSummary(noAnchor, undefined);
ok(fsNA.units === 1 && fsNA.totalSqm === 0, "floorSummary: anchor-less unit counts but contributes 0 m²");

// snapToColumns: a rect whose left edge is 0.015 from a sibling's left (0.5) snaps to it; right edge follows shape.
const sib = [{ x: 0.5, y: 0, w: 0.25, h: 0.4 }];
const snapped = snapToColumns({ x: 0.515, y: 0.1, w: 0.25, h: 0.4 }, sib, 0.02);
ok(near(snapped.x, 0.5), "snapToColumns: left edge snapped to the sibling column (0.5)");
ok(near(snapped.w, 0.25, 0.02), "snapToColumns: width preserved on a left-edge snap (box slides)");
// right edge snaps to a sibling's right edge (0.75)
const snapR = snapToColumns({ x: 0.3, y: 0, w: 0.46, h: 0.4 }, sib, 0.02); // right edge 0.76 → near 0.75
ok(near(snapR.x + snapR.w, 0.75, 0.001), "snapToColumns: right edge snapped to the sibling right (0.75)");
// nothing within tolerance → unchanged (freehand)
const far = snapToColumns({ x: 0.1, y: 0, w: 0.2, h: 0.4 }, sib, 0.02);
ok(near(far.x, 0.1) && near(far.w, 0.2), "snapToColumns: no snap when no sibling edge is within tolerance");
// no siblings → unchanged
ok(near(snapToColumns({ x: 0.1, y: 0, w: 0.2, h: 0.4 }, [], 0.02).x, 0.1), "snapToColumns: no siblings → unchanged");

// ===========================================================================
// LOCK + ANCESTOR CHAIN (the "professional plans" hierarchy spine)
// ===========================================================================

// isLocked reads node.locked honestly (absent = unlocked; the back-compat default)
ok(isLocked(pack, unit.id) === false, "isLocked: an unlocked node (no flag) reads false");
ok(isLocked({ ...pack, geo: [building, floor, { ...unit, locked: true }] }, unit.id) === true, "isLocked: locked:true reads true");
ok(isLocked(pack, "nope") === false, "isLocked: an unknown id reads false (never throws)");
ok(isLocked(pack, undefined) === false, "isLocked: undefined id reads false");

// ancestorsOf walks parent-first, excludes self, and terminates (the reference-layer chain)
const anc = ancestorsOf(pack, unit.id);
ok(anc.length === 2 && anc[0].id === floor.id && anc[1].id === building.id, "ancestorsOf(unit): [floor, building] nearest-first");
ok(ancestorsOf(pack, building.id).length === 0, "ancestorsOf(root): empty (nothing above a root)");
ok(ancestorsOf(pack, undefined).length === 0, "ancestorsOf(undefined): empty");
// a cyclic parentId must not HANG (the guard) — the key property is termination. A self-parent resolves its
// parent once (itself) then the guard stops, so it returns a bounded chain (≤1), never loops forever.
const cyc: Pack = { ...emptyPack("cyc"), geo: [{ id: "a", name: "A", kind: "building", parentId: "a" }] };
ok(ancestorsOf(cyc, "a").length <= 1, "ancestorsOf: a self-referential parentId terminates (cycle guard, no hang)");

// ===========================================================================
// SUBTYPE-PLAN resolution + subtype-size lock (units bound to a subtype share one plan + one size)
// ===========================================================================

// a building with one type (studio) carrying a subtype "a" with a declared size + a plan polygon
const subPlanPoly = { shape: "poly" as const, points: [ { x: 0.1, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.6, y: 0.5 }, { x: 0.1, y: 0.5 } ] };
let sids = new Set<string>();
const sBuilding = makeNode("building", undefined, { metreW: 40, metreH: 25, rect: { x: 0, y: 0, w: 1, h: 1 } }, sids);
sids.add(sBuilding.id);
const sFloor = makeNode("floor", sBuilding.id, { rect: { x: 0, y: 0, w: 1, h: 1 } }, sids);
sids.add(sFloor.id);
// a placed unit that POINTS at subtype {studio, a}; it carries only a rect footprint + the link
const sUnit: GeoNode = {
  id: "s-unit", name: "Studio A 48m²", kind: "unit", parentId: sFloor.id,
  subtypeRef: { typeKey: "studio", subtypeKey: "a" },
  footprint: { shape: "rect", rect: { x: 0, y: 0, w: 0.3, h: 0.3 } },
};
const sPack: Pack = {
  ...emptyPack("Subtype Test"),
  geo: [sBuilding, sFloor, sUnit],
  buildings: [{
    id: "b1", name: "B1", complexId: "c1", type: "High Rise", stories: 1,
    unitTypes: [{ key: "studio", label: "Studio", sqmMin: 48, sqmMax: 48, subtypes: [{ key: "a", label: "A", sqm: 48, plan: { footprint: subPlanPoly } }] }],
  }],
};

ok(subtypeForNode(sPack, sUnit)?.key === "a", "subtypeForNode: resolves the subtype by the stable {type,subtypeKey} pair");
ok(resolvePlan(sPack, sUnit)?.footprint.points.length === 4, "resolvePlan: returns the subtype's shared plan polygon");
ok(effectiveFootprint(sPack, sUnit)?.shape === "poly", "effectiveFootprint: a subtype-planned unit measures by the SHARED poly, not its own rect");
ok(subtypeLockedSqm(sPack, sUnit.id) === 48, "subtypeLockedSqm: the unit is locked to the subtype's declared 48 m²");

// back-compat: a node with NO subtypeRef falls back to its own footprint verbatim (behaviour)
const plainUnit: GeoNode = { ...sUnit, id: "plain", subtypeRef: undefined };
ok(resolvePlan(sPack, plainUnit) === undefined, "resolvePlan: no subtypeRef → undefined (back-compat)");
ok(effectiveFootprint(sPack, plainUnit)?.shape === "rect", "effectiveFootprint: no subtypeRef → the node's own rect");
ok(subtypeLockedSqm(sPack, plainUnit.id) === undefined, "subtypeLockedSqm: an unbound unit is NOT size-locked (free to resize)");
// a subtypeRef whose subtype has no sqm is not size-locked either
const noSqmPack: Pack = { ...sPack, buildings: [{ ...sPack.buildings[0], unitTypes: [{ key: "studio", label: "Studio", sqmMin: 48, sqmMax: 48, subtypes: [{ key: "a", label: "A" }] }] }] };
ok(subtypeLockedSqm(noSqmPack, sUnit.id) === undefined, "subtypeLockedSqm: a subtype without a declared sqm doesn't lock");

// constrainRectSqmAtOrigin: a RECT unit locked to 48 m² (no poly plan authored yet — the plan-less scenario the
// resize-snap serves). Dragging to a 0.5×0.5 box (would be 40×0.5×25×0.5 = 250 m²) snaps the AREA back to 48.
const rectUnit: GeoNode = { ...sUnit, id: "rect-unit", footprint: { shape: "rect", rect: { x: 0, y: 0, w: 0.3, h: 0.3 } } };
const rectPack: Pack = {
  ...emptyPack("Rect Lock Test"),
  geo: [sBuilding, sFloor, rectUnit],
  buildings: [{
    id: "b1", name: "B1", complexId: "c1", type: "High Rise", stories: 1,
    unitTypes: [{ key: "studio", label: "Studio", sqmMin: 48, sqmMax: 48, subtypes: [{ key: "a", label: "A", sqm: 48 }] }],
  }],
};
ok(effectiveFootprint(rectPack, rectUnit)?.shape === "rect", "a subtype WITHOUT a plan → the unit keeps its own rect (deriveSqm measures it)");
const dragged = constrainRectSqmAtOrigin(rectPack, rectUnit.id, { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 48);
const draggedNode: GeoNode = { ...rectUnit, footprint: { shape: "rect", rect: dragged } };
const draggedPack: Pack = { ...rectPack, geo: [sBuilding, sFloor, draggedNode] };
ok(near(dragged.x, 0.2) && near(dragged.y, 0.2), "constrainRectSqmAtOrigin: keeps the dragged TOP-LEFT (position is free)");
ok(near(deriveSqm(draggedPack, rectUnit.id)!, 48, 0.5), "constrainRectSqmAtOrigin: snaps the AREA back to the locked 48 m²");
ok(near(dragged.w / dragged.h, 1, 0.02), "constrainRectSqmAtOrigin: keeps the dragged aspect (0.5/0.5 = 1)");
ok(constrainRectSqmAtOrigin(rectPack, rectUnit.id, { x: 0, y: 0, w: 0.3, h: 0.3 }, 0).w === 0.3, "constrainRectSqmAtOrigin: target ≤ 0 is a no-op");

// --- writeSubtypePlanFootprint (slice 4): editing one subtype-bound unit authors the SHARED plan ---
// start from the plan-less rect pack; two units of the SAME subtype {studio, a}
const uA: GeoNode = { id: "ua", name: "A", kind: "unit", parentId: sFloor.id, subtypeRef: { typeKey: "studio", subtypeKey: "a" }, footprint: { shape: "rect", rect: { x: 0, y: 0, w: 0.3, h: 0.3 } } };
const uB: GeoNode = { id: "ub", name: "B", kind: "unit", parentId: sFloor.id, subtypeRef: { typeKey: "studio", subtypeKey: "a" }, footprint: { shape: "rect", rect: { x: 0.4, y: 0, w: 0.3, h: 0.3 } } };
const twoPack: Pack = {
  ...emptyPack("Two"),
  geo: [sBuilding, sFloor, uA, uB],
  buildings: [{
    id: "b1", name: "B1", complexId: "c1", type: "High Rise", stories: 1,
    unitTypes: [{ key: "studio", label: "Studio", sqmMin: 48, sqmMax: 48, subtypes: [{ key: "a", label: "A", sqm: 48 }] }],
  }],
};
// author an L-ish poly on unit A → it lands on the subtype plan
const editedPoly: Footprint = { shape: "poly", points: [ { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.5 }, { x: 0.1, y: 0.5 } ] };
const afterEdit = writeSubtypePlanFootprint(twoPack, uA, editedPoly);
ok(afterEdit !== twoPack, "writeSubtypePlanFootprint: a subtype-bound poly edit returns a new pack");
ok(afterEdit.buildings[0].unitTypes![0].subtypes![0].plan?.footprint.points.length === 6, "the edit lands on the SUBTYPE's shared plan (6 pts)");
// BOTH units now resolve the SAME shared plan (edit one → every unit of the subtype follows)
ok(effectiveFootprint(afterEdit, uA)?.shape === "poly" && effectiveFootprint(afterEdit, uB)?.shape === "poly", "every unit of the subtype now renders the shared plan (edit one → all follow)");
ok(JSON.stringify(effectiveFootprint(afterEdit, uA)) === JSON.stringify(effectiveFootprint(afterEdit, uB)), "unit A and unit B resolve IDENTICAL shared geometry");

// --- renderFootprint: the shared SHAPE is placed at each unit's OWN position (D-) ---
// uA sits at x=0, uB at x=0.4 (same subtype, same shared plan). The RENDER footprint must carry the same OUTLINE
// but at DIFFERENT positions — else every Studio B would overlap at the authored unit's spot (the Floor-4 bug).
const rA = renderFootprint(afterEdit, uA);
const rB = renderFootprint(afterEdit, uB);
ok(rA?.shape === "poly" && rB?.shape === "poly", "renderFootprint: both subtype-bound units render a polygon from the shared plan");
if (rA?.shape === "poly" && rB?.shape === "poly") {
  const minXA = Math.min(...rA.points.map((p) => p.x));
  const minXB = Math.min(...rB.points.map((p) => p.x));
  ok(near(minXB - minXA, 0.4, 1e-6), "renderFootprint: uB's shape is OFFSET by its own position (x+0.4), not drawn on top of uA");
  // same SHAPE: normalize both to their own bbox → identical outlines (within float tolerance — uB's position
  // offset introduces ~1e-16 rounding, so compare per-point with `near`, not bit-identical JSON).
  const normA = footprintSelfNorm(rA)!;
  const normB = footprintSelfNorm(rB)!;
  const sameOutline = normA.length === normB.length && normA.every((p, i) => near(p.x, normB[i].x, 1e-9) && near(p.y, normB[i].y, 1e-9));
  ok(sameOutline, "renderFootprint: the OUTLINE (self-normalized) is identical for every unit of the subtype — shape shared, position own");
}
// a unit with NO subtype plan renders its own footprint unchanged
ok(renderFootprint(rectPack, plainUnit) === plainUnit.footprint || renderFootprint(rectPack, plainUnit)?.shape === "rect", "renderFootprint: no plan → the node's own footprint, unchanged");
// a second edit REPLACES the plan footprint (idempotent single-truth), preserving any markers
const withMarker: Pack = { ...afterEdit, buildings: [{ ...afterEdit.buildings[0], unitTypes: [{ ...afterEdit.buildings[0].unitTypes![0], subtypes: [{ ...afterEdit.buildings[0].unitTypes![0].subtypes![0], plan: { footprint: editedPoly as any, markers: [{ kind: "door", at: { x: 0.1, y: 0.3 } }] } }] }] }] };
const reEdited = writeSubtypePlanFootprint(withMarker, uA, { shape: "poly", points: [ { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 } ] });
ok(reEdited.buildings[0].unitTypes![0].subtypes![0].plan?.footprint.points.length === 4, "re-editing REPLACES the plan shape (single source of truth)");
ok(reEdited.buildings[0].unitTypes![0].subtypes![0].plan?.markers?.length === 1, "re-editing PRESERVES the plan's markers (only the footprint changes)");
// a node with NO subtypeRef is a no-op (returns the same pack)
ok(writeSubtypePlanFootprint(twoPack, plainUnit, editedPoly) === twoPack, "writeSubtypePlanFootprint: no subtypeRef → no-op (same pack)");
// a non-poly footprint is a no-op (we only author shapes)
ok(writeSubtypePlanFootprint(twoPack, uA, { shape: "rect", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }) === twoPack, "writeSubtypePlanFootprint: non-poly → no-op");

// --- editsSharedPlanOnly (D-): once a subtype HAS a plan, a poly edit writes ONLY the plan (the own
// footprint = the unit's on-floor placement, stays put; renderFootprint re-places the shared shape into it). ---
ok(editsSharedPlanOnly(twoPack, uA) === false, "editsSharedPlanOnly: no plan yet → false (the first author seeds the plan FROM the own footprint)");
ok(editsSharedPlanOnly(afterEdit, uA) === true, "editsSharedPlanOnly: bound unit with an existing shared plan → true (edit the plan directly, don't clobber placement)");
ok(editsSharedPlanOnly(afterEdit, uB) === true, "editsSharedPlanOnly: every unit of a planned subtype edits the shared plan (edit one → all follow, from the focus editor too)");
ok(editsSharedPlanOnly(afterEdit, plainUnit) === false, "editsSharedPlanOnly: unbound unit → false (no shared plan to edit)");
// the KEY invariant the fix guarantees: uA and uB keep their DISTINCT own footprints (placements) even though both
// resolve the same shared plan — the edit must never write plan points onto a unit's own footprint (the drift).
ok(uA.footprint!.shape === "rect" && uB.footprint!.shape === "rect" && JSON.stringify(uA.footprint) !== JSON.stringify(uB.footprint), "a planned subtype's units keep DISTINCT own footprints (placement own, shape shared) — the drift the plan-only write prevents");
// read-side consistency: the focus editor's metre labels/edge-length edit measure the EFFECTIVE shape (the shared
// plan) even though the bound unit's OWN footprint is now a placement RECT — else the labels would go dark post-fix.
const mpBound = polyMetrePoints(afterEdit, uA.id);
ok(!!mpBound && mpBound.length === 6, "polyMetrePoints: a bound unit (own = rect) measures its SHARED PLAN's 6 edges, not its own rect");
ok(edgeLengthsMetres(afterEdit, uA.id).length === 6, "edgeLengthsMetres: metre labels stay live on a bound unit after the plan-only write (reads effectiveFootprint)");

// --- unitShownAsShape (D-): MARKERS-FIRST level view. Default = marker; shape iff approved OR forced. ---
const uShapeDraft: GeoNode = { id: "ud", kind: "unit", name: "U", footprint: { shape: "poly", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] } };
ok(unitShownAsShape(uShapeDraft, true) === false, "unitShownAsShape: a drafted unit with a poly → MARKER (markers-first default; no approval/override)");
ok(unitShownAsShape(uShapeDraft, false) === false, "unitShownAsShape: no poly → never a shape (a shapeless pin stays a pin)");
ok(unitShownAsShape({ ...uShapeDraft, approved: true }, true) === true, "unitShownAsShape: APPROVED → brought into the level plan as its shape");
ok(unitShownAsShape({ ...uShapeDraft, approved: true }, false) === false, "unitShownAsShape: approved but no poly → still nothing to show as a shape");
ok(unitShownAsShape({ ...uShapeDraft, representation: "shape" }, true) === true, "unitShownAsShape: representation=shape forces a shape even when not approved");
ok(unitShownAsShape({ ...uShapeDraft, approved: true, representation: "marker" }, true) === false, "unitShownAsShape: representation=marker forces a MARKER even when approved (toggle overrides approval)");
ok(unitShownAsShape(undefined, true) === false, "unitShownAsShape: undefined node → marker (defensive)");
// and both units of the subtype measure IDENTICAL edge lengths (same shared plan, same parent metres)
ok(JSON.stringify(edgeLengthsMetres(afterEdit, uA.id)) === JSON.stringify(edgeLengthsMetres(afterEdit, uB.id)), "edgeLengthsMetres: every unit of the subtype measures the same shared plan edges");

// --- rotatePointsAboutCentre + renderFootprint rotation (per-instance on-floor pose) ---
const C = { x: 0.5, y: 0.5 };
ok(rotatePointsAboutCentre([{ x: 0.6, y: 0.5 }], 0, C)[0].x === 0.6, "rotatePointsAboutCentre: deg=0 is identity");
const r90 = rotatePointsAboutCentre([{ x: 0.6, y: 0.5 }], 90, C)[0]; // right of centre → rotate 90° CW (y-down) → below
ok(near(r90.x, 0.5) && near(r90.y, 0.6), "rotatePointsAboutCentre: 90° CW sends the point to the right down (y-down space)");
const r180 = rotatePointsAboutCentre([{ x: 0.6, y: 0.5 }], 180, C)[0];
ok(near(r180.x, 0.4) && near(r180.y, 0.5), "rotatePointsAboutCentre: 180° sends +x to -x about the centre");
// renderFootprint applies the unit's rotationDeg: same bbox SIZE, rotated outline. uA centre = (0.15, 0.15).
const uARot: GeoNode = { ...uA, rotationDeg: 90 };
const packRot: Pack = { ...afterEdit, geo: [uARot] };
const rr0 = renderFootprint(afterEdit, uA);       // unrotated placement of the 6-pt plan into uA's rect
const rr90 = renderFootprint(packRot, uARot);     // same, rotated 90° about uA's centre
ok(rr0?.shape === "poly" && rr90?.shape === "poly" && rr90.points.length === rr0.points.length, "renderFootprint: rotation keeps the vertex count (rigid whole)");
if (rr0?.shape === "poly" && rr90?.shape === "poly") {
  // a rigid rotation preserves the polygon AREA (shoelace magnitude) — the shape is unchanged, only its pose
  ok(near(Math.abs(shoelaceArea(rr0.points)), Math.abs(shoelaceArea(rr90.points)), 1e-6), "renderFootprint: a 90° rotation preserves area (rigid-body move, no reshape)");
  // and the centre is invariant (rotation is about the unit's own centre)
  const cx0 = rr0.points.reduce((s, p) => s + p.x, 0) / rr0.points.length;
  const cx90 = rr90.points.reduce((s, p) => s + p.x, 0) / rr90.points.length;
  const cy0 = rr0.points.reduce((s, p) => s + p.y, 0) / rr0.points.length;
  const cy90 = rr90.points.reduce((s, p) => s + p.y, 0) / rr90.points.length;
  ok(near(cx0, cx90, 1e-9) && near(cy0, cy90, 1e-9), "renderFootprint: rotation is about the unit's own centroid (centre invariant)");
}

// --- ANTI-SKEW (caught it): rotation must be RIGID in METRE space, not the floor's anisotropic 0..1
// frame. On a NON-SQUARE floor (sBuilding = 40×25 m, aspect 1.6), rotating directly in fraction space SHEARS the
// shape (a rectangle came out a parallelogram). Build an axis-aligned rectangular subtype plan, keep the FULL geo
// so the floor's metre anchor resolves, rotate 45° → the rendered outline's adjacent edges must stay PERPENDICULAR
// (zero shear) when measured in METRES. (The pre-fix code failed this; the metre-space rotate passes it.) ---
const rectPlan: Footprint = { shape: "poly", points: [ { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.4 }, { x: 0.1, y: 0.4 } ] };
const skewPack0 = writeSubtypePlanFootprint(twoPack, uA, rectPlan); // full geo (sBuilding/sFloor present → metre anchor)
const uA45: GeoNode = { ...uA, rotationDeg: 45 };
const skewPack: Pack = { ...skewPack0, geo: skewPack0.geo!.map((n) => (n.id === uA.id ? uA45 : n)) };
const rSkew = renderFootprint(skewPack, uA45);
ok(rSkew?.shape === "poly" && rSkew.points.length === 4, "renderFootprint(anti-skew): a rotated rectangle stays a 4-pt quad");
if (rSkew?.shape === "poly") {
  // convert the rendered fraction points to METRES (floor = 40×25), then check edge 0→1 ⟂ edge 1→2 (a rectangle's
  // corner is a right angle; a sheared parallelogram's is not). dot/|a||b| ≈ 0 ⇔ perpendicular.
  const mw = 40, mh = 25;
  const m = rSkew.points.map((p) => ({ x: p.x * mw, y: p.y * mh }));
  const e01 = { x: m[1].x - m[0].x, y: m[1].y - m[0].y };
  const e12 = { x: m[2].x - m[1].x, y: m[2].y - m[1].y };
  const dot = e01.x * e12.x + e01.y * e12.y;
  const cosang = dot / (Math.hypot(e01.x, e01.y) * Math.hypot(e12.x, e12.y));
  ok(near(cosang, 0, 1e-6), "renderFootprint(anti-skew): adjacent edges stay PERPENDICULAR in metre space after a 45° rotation (no shear on a non-square floor)");
}

// --- (kill-the-bbox arc Slice 4): ROTATION IS A FIRST-CLASS NODE TRANSFORM. A NON-plan node (building/floor/
// land) now honours rotationDeg in renderFootprint — so a building can be rotated to HUG a tilted plot. Before
// renderFootprint early-returned the own footprint unrotated for any node with no shared plan. Build a land (metre
// anchor 60×44) holding a building with its OWN rect footprint; rotate it 30° and assert: it renders a rotated poly,
// rigid (area + vertex count preserved), about its own centre, and anti-skew (rigid in the land's metre frame). ---
{
  const landNode: GeoNode = { id: "L", name: "land", kind: "land", metreW: 60, metreH: 44,
    footprint: { shape: "poly", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } };
  const bldRect: Footprint = { shape: "rect", rect: { x: 0.2, y: 0.25, w: 0.5, h: 0.4 } };
  const bld0: GeoNode = { id: "B", name: "bld", kind: "building", parentId: "L", footprint: bldRect };
  const bld30: GeoNode = { ...bld0, rotationDeg: 30 };
  const packS4: Pack = { ...twoPack, geo: [landNode, bld0] };
  const packS4r: Pack = { ...twoPack, geo: [landNode, bld30] };

  const unrot = renderFootprint(packS4, bld0);
  ok(unrot?.shape === "rect" || (unrot?.shape === "poly"), "Slice4: an UNrotated building renders its own footprint (unchanged)");

  const rot = renderFootprint(packS4r, bld30);
  ok(rot?.shape === "poly" && rot.points.length === 4, "Slice4: a rotated building renders a 4-pt poly (rect → rotated quad)");
  if (rot?.shape === "poly") {
    // area preserved in the land's metre frame (60×44) — a rigid rotation never changes area.
    const mw = 60, mh = 44;
    const rectCornersM = [ { x: 0.2 * mw, y: 0.25 * mh }, { x: 0.7 * mw, y: 0.25 * mh }, { x: 0.7 * mw, y: 0.65 * mh }, { x: 0.2 * mw, y: 0.65 * mh } ];
    const rotM = rot.points.map((p) => ({ x: p.x * mw, y: p.y * mh }));
    ok(near(Math.abs(shoelaceArea(rotM)), Math.abs(shoelaceArea(rectCornersM)), 1e-4), "Slice4: a 30° building rotation preserves AREA in the land metre frame (rigid)");
    // centre invariant: the rotated quad's centroid-bbox centre equals the original rect centre (rotation in place)
    const cx = (Math.min(...rot.points.map((p) => p.x)) + Math.max(...rot.points.map((p) => p.x))) / 2;
    const cy = (Math.min(...rot.points.map((p) => p.y)) + Math.max(...rot.points.map((p) => p.y))) / 2;
    ok(near(cx, 0.45, 1e-9) && near(cy, 0.45, 1e-9), "Slice4: rotation pivots about the building's own centre (0.45, 0.45) — hugs in place");
    // anti-skew: adjacent edges stay perpendicular in METRES (a non-square land frame would shear a naive rotate)
    const e01 = { x: rotM[1].x - rotM[0].x, y: rotM[1].y - rotM[0].y };
    const e12 = { x: rotM[2].x - rotM[1].x, y: rotM[2].y - rotM[1].y };
    const cosang = (e01.x * e12.x + e01.y * e12.y) / (Math.hypot(e01.x, e01.y) * Math.hypot(e12.x, e12.y));
    ok(near(cosang, 0, 1e-6), "Slice4: a rotated building stays rectangular in metre space (no shear on a non-square plot)");
  }
}

// --- scalePolyAboutCentroid (#3): first child = parent plate ×0.8, same shape, inset about the centroid ---
const sq = [ { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 } ]; // centroid (0.5, 0.5)
const inset = scalePolyAboutCentroid(sq, 0.8);
ok(inset.length === 4, "scalePolyAboutCentroid keeps the vertex count (same shape)");
ok(near(inset[0].x, 0.26) && near(inset[0].y, 0.26), "scalePolyAboutCentroid: 0.2 → 0.5 + (0.2-0.5)*0.8 = 0.26 (inset about centroid)");
ok(near(inset[2].x, 0.74) && near(inset[2].y, 0.74), "scalePolyAboutCentroid: the far corner insets symmetrically to 0.74");
// area scales by factor² → 0.8² = 0.64 of the original
ok(near(shoelaceArea(inset) / shoelaceArea(sq), 0.64, 0.001), "scalePolyAboutCentroid: area = 0.8² = 0.64 of the parent");
ok(scalePolyAboutCentroid([{ x: 0, y: 0 }, { x: 1, y: 0 }], 0.8).length === 0, "scalePolyAboutCentroid: < 3 points → [] (nothing to inset)");
// an L-shape keeps its shape (the notch stays), just smaller
const lInset = scalePolyAboutCentroid(lshape, 0.8);
ok(lInset.length === lshape.length, "scalePolyAboutCentroid preserves an L-shape's vertices (notch kept)");

// --- pointInPoly / polyInPoly (slice 3 containment) ---
const unitSq = [ { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 } ];
ok(pointInPoly({ x: 0.5, y: 0.5 }, unitSq) === true, "pointInPoly: centre is inside");
ok(pointInPoly({ x: 1.5, y: 0.5 }, unitSq) === false, "pointInPoly: a point to the right is outside");
ok(pointInPoly({ x: 0.5, y: 0.5 }, [{ x: 0, y: 0 }, { x: 1, y: 0 }]) === false, "pointInPoly: < 3 pts → false");
// a small inner square well within the unit square is contained; one straddling the edge is not
ok(polyInPoly([ { x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 } ], unitSq) === true, "polyInPoly: an inner square is contained");
ok(polyInPoly([ { x: 0.8, y: 0.3 }, { x: 1.3, y: 0.3 }, { x: 1.3, y: 0.6 }, { x: 0.8, y: 0.6 } ], unitSq) === false, "polyInPoly: a square poking out the right edge is NOT contained");

// --- unitsFitInFloorShape + the floor shrink-guard (reject-the-shrink / enlarge-ok) ---
// NOTE on frames: a floor's CHILDREN are laid against the floor's shape NORMALIZED to its own bbox (0..1) — the
// same way RefFrame/the canvas render it. So a convex reshape (rect/quad) always holds everything; the meaningful
// orphan case is a CONCAVITY (an L-notch) cutting through a unit — that's what "reject the shrink" guards.
let fitIds = new Set<string>();
const fitBldg = makeNode("building", undefined, { metreW: 40, metreH: 25, rect: { x: 0, y: 0, w: 1, h: 1 } }, fitIds); fitIds.add(fitBldg.id);
const fitFloor = makeNode("floor", fitBldg.id, { rect: { x: 0, y: 0, w: 1, h: 1 } }, fitIds); fitIds.add(fitFloor.id);
// a unit sitting in the TOP-RIGHT quadrant of the floor frame
const fuTR: GeoNode = { id: "futr", name: "TR", kind: "unit", parentId: fitFloor.id, footprint: { shape: "rect", rect: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 } } };
const fitPack: Pack = { ...emptyPack("Floor Fit"), geo: [fitBldg, fitFloor, fuTR] };
ok(unitsFitInFloorShape(fitPack, fitFloor.id, { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } }) === true, "unitsFitInFloorShape: a full-frame (convex) floor holds the unit — enlarge/convex always ok");
// an L-shaped floor whose notch is cut out of the TOP-RIGHT (where the unit sits) → orphans it → reject
const lNotchTR: Footprint = { shape: "poly", points: [ { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 1, y: 1 }, { x: 0, y: 1 } ] };
ok(unitsFitInFloorShape(fitPack, fitFloor.id, lNotchTR) === false, "unitsFitInFloorShape: an L-notch cut through the unit's corner orphans it → false (reject the shrink)");
// the SAME L-notch but the unit sits safely in the BODY (bottom-left) → still contained → allowed
const fuBL: GeoNode = { id: "fubl", name: "BL", kind: "unit", parentId: fitFloor.id, footprint: { shape: "rect", rect: { x: 0.1, y: 0.6, w: 0.3, h: 0.3 } } };
ok(unitsFitInFloorShape({ ...fitPack, geo: [fitBldg, fitFloor, fuBL] }, fitFloor.id, lNotchTR) === true, "unitsFitInFloorShape: a unit clear of the notch stays contained → allowed");
// a floor with NO units never blocks
ok(unitsFitInFloorShape({ ...fitPack, geo: [fitBldg, fitFloor] }, fitFloor.id, lNotchTR) === true, "unitsFitInFloorShape: an empty floor never blocks a reshape");

// --- writeSubtypePlanPatch (slice 5): markers + backdrop land on the SUBTYPE plan, shared by all its units ---
// reuse the twoPack from slice 4 (two units of subtype {studio, a}); first author a footprint so a plan exists
const planned = writeSubtypePlanFootprint(twoPack, uA, editedPoly);
// add a door marker via a patch — it lands on the shared plan, so BOTH units resolve it
const withDoor = writeSubtypePlanPatch(planned, uA, { markers: [{ kind: "door", at: { x: 0.3, y: 0.9 } }] });
ok(withDoor !== planned, "writeSubtypePlanPatch: a marker patch returns a new pack");
ok(resolvePlan(withDoor, uA)?.markers?.length === 1 && resolvePlan(withDoor, uB)?.markers?.length === 1, "markers land on the SHARED plan — both units of the subtype see the door");
ok(resolvePlan(withDoor, uA)?.footprint.points.length === 6, "a marker patch PRESERVES the footprint (merge, not replace)");
// add a backdrop — coexists with markers
const withBackdrop = writeSubtypePlanPatch(withDoor, uA, { backdrop: { dataUrl: "data:image/png;base64,AAAA", mime: "image/png" } });
ok(resolvePlan(withBackdrop, uA)?.backdrop?.mime === "image/png", "backdrop lands on the plan");
ok(resolvePlan(withBackdrop, uA)?.markers?.length === 1, "adding a backdrop preserves existing markers");
// a plan-less subtype: a marker patch with NO footprint is a no-op (markers need a shape first)
ok(writeSubtypePlanPatch(twoPack, uA, { markers: [{ kind: "window", at: { x: 0.5, y: 0.5 } }] }) === twoPack, "writeSubtypePlanPatch: markers without a footprint-bearing plan → no-op (author the shape first)");
// an unbound node → no-op
ok(writeSubtypePlanPatch(planned, plainUnit, { markers: [] }) === planned, "writeSubtypePlanPatch: no subtypeRef → no-op");

// --- parcelFootprintForBuilding: a building takes its land parcel's traced outline (inset) as its footprint ---
let mpIds = new Set<string>();
const mpLand = makeNode("land", undefined, { metreW: 100, metreH: 80, rect: { x: 0, y: 0, w: 1, h: 1 } }, mpIds); mpIds.add(mpLand.id);
// give the land a traced parcel footprint (a non-rectangular quad, 0..1 in its own bbox)
const mpLandPoly: GeoNode = { ...mpLand, footprint: { shape: "poly", points: [ { x: 0, y: 0.2 }, { x: 0.8, y: 0 }, { x: 1, y: 0.7 }, { x: 0.3, y: 1 } ] } };
const mpBld = makeNode("building", mpLandPoly.id, { rect: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } }, mpIds); mpIds.add(mpBld.id);
const mpPack: Pack = { ...emptyPack("Match Parcel"), geo: [mpLandPoly, mpBld] };
const mpFp = parcelFootprintForBuilding(mpPack, mpBld.id);
ok(mpFp?.shape === "poly" && mpFp.points.length === 4, "parcelFootprintForBuilding: returns the land parcel's 4 points as a poly");
// inset (default 0.85) → strictly inside the parcel's bbox (not edge-to-edge), same point count
const mpXs = mpFp!.points.map((p) => p.x), mpYs = mpFp!.points.map((p) => p.y);
ok(Math.min(...mpXs) > 0 && Math.max(...mpXs) < 1 && Math.min(...mpYs) > 0 && Math.max(...mpYs) < 1, "parcelFootprintForBuilding: default inset pulls the outline inside the 0..1 frame (a setback)");
// inset=1 → exactly the parcel outline (edge-to-edge, same shape)
const mpFull = parcelFootprintForBuilding(mpPack, mpBld.id, 1);
ok(mpFull?.points[1].x === 0.8 && mpFull?.points[2].y === 0.7, "parcelFootprintForBuilding: inset=1 copies the parcel outline verbatim");
// a land with only a RECT footprint (no traced parcel) → nothing to match → undefined
ok(parcelFootprintForBuilding({ ...mpPack, geo: [mpLand, mpBld] }, mpBld.id) === undefined, "parcelFootprintForBuilding: a rect (untraced) land → undefined (nothing to match)");
// a non-building node → undefined
ok(parcelFootprintForBuilding(mpPack, mpLandPoly.id) === undefined, "parcelFootprintForBuilding: only a building can match a parcel → undefined for the land itself");

// ---: parentShapeInChildFrame (the general primitive) + level-aware inset + canMatchParentShape ---
// level-aware inset: building nests (setback), floor = full plate (no shrink)
ok(insetForParentShape("building") === 0.85, "insetForParentShape: building nests in the parcel → 0.85 setback");
ok(insetForParentShape("floor") === 1, "insetForParentShape: a floor IS the full building plate → inset 1 (no shrink)");
// THE FRAME-CORRECTNESS TEST — a floor under an INSET polygon building must get the full plate at 0..1, NOT shrunk
// to the building's position-in-land. Build: land(poly 0..1) → building(poly INSET to 0.2..0.8 in the land) → floor.
let s278 = new Set<string>();
const s278Land = makeNode("land", undefined, { metreW: 100, metreH: 80, rect: { x: 0, y: 0, w: 1, h: 1 } }, s278); s278.add(s278Land.id);
// building is a parallelogram INSET within the land (points occupy 0.2..0.8, i.e. NOT self-normalized)
const s278Bld: GeoNode = { id: "s278-bld", name: "B", kind: "building", parentId: s278Land.id, footprint: { shape: "poly", points: [ { x: 0.2, y: 0.3 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.7 }, { x: 0.2, y: 0.8 } ] } };
const s278Floor: GeoNode = { id: "s278-flr", name: "F1", kind: "floor", parentId: s278Bld.id, footprint: { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } } };
const s278Pack: Pack = { ...emptyPack("S278"), geo: [s278Land, s278Bld, s278Floor] };
const flrShape = parentShapeInChildFrame(s278Pack, s278Floor.id); // floor default inset = 1 (full plate)
ok(flrShape?.shape === "poly" && flrShape.points.length === 4, "parentShapeInChildFrame: a floor gets the building's 4-pt plate");
// self-normalized → the plate must span the FULL 0..1 frame (bbox 0..1), NOT the building's 0.2..0.8 position
const fXs = flrShape!.points.map((p) => p.x), fYs = flrShape!.points.map((p) => p.y);
ok(Math.min(...fXs) === 0 && Math.max(...fXs) === 1 && Math.min(...fYs) === 0 && Math.max(...fYs) === 1, "parentShapeInChildFrame: the floor plate is SELF-NORMALIZED to 0..1 (full plate), not shrunk to the building's inset position — the frame-correctness guarantee");
// the SHAPE is preserved (a parallelogram, not an axis-aligned rect): the top edge still slopes
ok(flrShape!.points[0].y !== flrShape!.points[1].y, "parentShapeInChildFrame: the plate keeps the building's real (sloped) shape, not a bounding rect");
// canMatchParentShape: true for the floor (poly building parent), false for a UNIT (tiles, never inherits)
ok(canMatchParentShape(s278Pack, s278Floor.id) === true, "canMatchParentShape: a floor under a polygon building CAN match the plate");
const s278Unit: GeoNode = { id: "s278-u", name: "U", kind: "unit", parentId: s278Floor.id, footprint: { shape: "rect", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } } };
ok(canMatchParentShape({ ...s278Pack, geo: [...s278Pack.geo!, s278Unit] }, s278Unit.id) === false, "canMatchParentShape: a UNIT never inherits its floor shape (it tiles) → false");
// a floor under a RECT building → nothing to inherit (parent isn't a polygon) → false / undefined
const rectBldPack: Pack = { ...emptyPack("rect"), geo: [ s278Land, { ...s278Bld, footprint: { shape: "rect", rect: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } } }, s278Floor ] };
ok(canMatchParentShape(rectBldPack, s278Floor.id) === false, "canMatchParentShape: a rect building parent offers nothing to inherit → false");
ok(parentShapeInChildFrame(rectBldPack, s278Floor.id) === undefined, "parentShapeInChildFrame: a rect parent at the floor's default inset 1 → undefined (a floor already fills a rect building)");

// ---: seedRectFloorsUnderPolyBuilding — floors born at building ×0.8 the moment the building becomes a poly ---
// A poly building with two RECT floors + one already-shaped POLY floor + one FOREIGN floor (other building).
const sfBld: GeoNode = { id: "sf-bld", name: "B", kind: "building", parentId: "sf-land", footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 } ] } };
const sfF1: GeoNode = { id: "sf-f1", name: "F1", kind: "floor", parentId: "sf-bld", footprint: { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } } };
const sfF2: GeoNode = { id: "sf-f2", name: "F2", kind: "floor", parentId: "sf-bld", footprint: { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } } };
const sfShaped: GeoNode = { id: "sf-f3", name: "F3", kind: "floor", parentId: "sf-bld", footprint: { shape: "poly", points: [ { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 } ] } };
const sfForeign: GeoNode = { id: "sf-fx", name: "FX", kind: "floor", parentId: "other-bld", footprint: { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } } };
const sfIn = [sfBld, sfF1, sfF2, sfShaped, sfForeign];
const sfOut = seedRectFloorsUnderPolyBuilding(sfIn, "sf-bld");
const sfF1Out = sfOut.find((n) => n.id === "sf-f1")!;
ok(sfF1Out.footprint?.shape === "poly", "seedRectFloors: a rect floor under the poly building becomes a polygon");
ok(sfOut.find((n) => n.id === "sf-f2")!.footprint?.shape === "poly", "seedRectFloors: ALL rect floors under the building are seeded");
// the seed = building ×0.8 about the centroid: a 0..1 square → 0.1..0.9 (0.5 + (0-0.5)*0.8 = 0.1)
if (sfF1Out.footprint?.shape === "poly") {
  const xs = sfF1Out.footprint.points.map((p) => p.x);
  ok(Math.abs(Math.min(...xs) - 0.1) < 1e-9 && Math.abs(Math.max(...xs) - 0.9) < 1e-9, `seedRectFloors: the seed is building ×${FLOOR_SEED_INSET} (0..1 → 0.1..0.9)`);
}
// an already-shaped POLY floor is NEVER overwritten (seed-once, don't ripple over edits)
ok(sfOut.find((n) => n.id === "sf-f3") === sfShaped, "seedRectFloors: a floor the user already shaped is left UNTOUCHED (same reference)");
// a floor under a DIFFERENT building is untouched
ok(sfOut.find((n) => n.id === "sf-fx") === sfForeign, "seedRectFloors: a floor under another building is not touched");
// a building that is STILL a rect → nothing to inherit → the same array reference back (no churn)
const sfRectBld = [{ ...sfBld, footprint: { shape: "rect" as const, rect: { x: 0, y: 0, w: 1, h: 1 } } }, sfF1, sfF2];
ok(seedRectFloorsUnderPolyBuilding(sfRectBld, "sf-bld") === sfRectBld, "seedRectFloors: a rect building has no shape to inherit → floors untouched, same array returned");
// no-op idempotence: running again over the SEEDED output changes nothing (all floors are poly now)
ok(seedRectFloorsUnderPolyBuilding(sfOut, "sf-bld") === sfOut, "seedRectFloors: idempotent — a second run over seeded floors is a no-op (same reference)");

// --- (parked item 2): seedNextFloorFromApproved — approve a floor → confirm it + seed the NEXT floor up ---
// a poly floor f1, a RECT floor f2 right after it, a POLY floor f3 after that (already shaped). approving f1 must:
// mark f1 confirmed, seed f2 from f1's shape (it's a rect), and NOT touch f3 (not the immediate next). Reuse fixtures:
// f1 = sfShaped's shape on sf-f1, f2 = rect, f3 = rect-but-we'll-shape to test the guard.
const afF1: GeoNode = { id: "af-f1", name: "F1", kind: "floor", parentId: "af-bld", footprint: { shape: "poly", points: [ { x: 0.2, y: 0.1 }, { x: 0.8, y: 0.2 }, { x: 0.7, y: 0.9 }, { x: 0.1, y: 0.8 } ] } };
const afF2: GeoNode = { id: "af-f2", name: "F2", kind: "floor", parentId: "af-bld", footprint: { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } } };
const afF3: GeoNode = { id: "af-f3", name: "F3", kind: "floor", parentId: "af-bld", footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 } ] } };
const afIn = [afF1, afF2, afF3];
const afOut = seedNextFloorFromApproved(afIn, "af-f1");
ok(afOut.find((n) => n.id === "af-f1")!.confirmed === true, "approveFloor: the approved floor is marked confirmed");
const afF2Out = afOut.find((n) => n.id === "af-f2")!;
ok(afF2Out.footprint?.shape === "poly", "approveFloor: the next floor (a rect) is seeded as a polygon");
if (afF2Out.footprint?.shape === "poly" && afF1.footprint?.shape === "poly") {
  ok(JSON.stringify(afF2Out.footprint.points) === JSON.stringify(afF1.footprint.points), "approveFloor: the next floor's shape is a direct copy of the approved floor's (same plate frame)");
}
ok(afOut.find((n) => n.id === "af-f3") === afF3, "approveFloor: a floor TWO up (not the immediate next) is untouched (same reference)");
// guard: if the next floor is ALREADY a poly, approving confirms but NEVER overwrites it (seed-once-then-independent)
const afIn2 = [afF1, { ...afF2, footprint: { shape: "poly" as const, points: [ { x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 } ] } }, afF3];
const afOut2 = seedNextFloorFromApproved(afIn2, "af-f1");
ok(afOut2.find((n) => n.id === "af-f2")!.footprint === afIn2[1].footprint, "approveFloor: an already-shaped next floor is NOT overwritten (seed-once)");
// approving the LAST floor (no next) just confirms it, no crash
const afOut3 = seedNextFloorFromApproved([afF1], "af-f1");
ok(afOut3[0].confirmed === true && afOut3.length === 1, "approveFloor: approving a floor with no next floor just confirms it");

// --- Slice 3: the legacy bbox ancestor stack (ancestorBackdropPoly + ancestorLayers) is DELETED ---
// Those self-norm/inverse-bbox helpers are gone — `ancestorLayersMetric` (below) is the sole backdrop path, and
// the load-time hydrate guarantees every level carries metres so it always resolves. The framing behaviour they
// tested (an inset parent blowing up to frame its child; a cumulative floor+building+land stack) is now asserted
// on the metre-native variant. We keep a bare no-metre rect chain around for the "bail to []" assertion below.
const alLand: GeoNode = { id: "al-land", name: "L", kind: "land", footprint: { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } } };
const alBld: GeoNode = { id: "al-bld", name: "B", kind: "building", parentId: alLand.id, footprint: { shape: "poly", points: [ { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 } ] } };
const alPack: Pack = { ...emptyPack("al"), geo: [alLand, alBld] };

// --- Slice 1: ancestorLayersMetric (the metre-native backdrop — no bbox distortion) ---
// A metre-anchored chain: land 100×100 m (metre-native) → building inset 0.2..0.8 (so 60×60 m at offset 20,20).
const amLand: GeoNode = { id: "am-land", name: "L", kind: "land", metreW: 100, metreH: 100,
  footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 } ],
    pointsM: [ { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 } ] } };
const amBld: GeoNode = { id: "am-bld", name: "B", kind: "building", parentId: amLand.id,
  footprint: { shape: "poly", points: [ { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 } ] } };
const amPack: Pack = { ...emptyPack("am"), geo: [amLand, amBld] };
// focus the building (60×60 m, its own metre frame). The land (100×100) sits at metre offset (-20,-20) relative to
// the building's min-corner → in the building's 0..1 frame (÷60): corner (0,0)→(-20/60,-20/60)=(-1/3,-1/3),
// corner (100,100)→((100-20)/60)=(80/60=+4/3). Same framing as the bbox path, but derived from METRES, not a bbox.
const amB = ancestorLayersMetric(amPack, amBld.id);
ok(amB.length === 1 && amB[0].kind === "land", "ancestorLayersMetric: focus building → 1 ancestor (land), from metres");
ok(Math.abs(Math.min(...amB[0].points.map((p) => p.x)) - (-1/3)) < 1e-6, "ancestorLayersMetric: land origin at -1/3 (metre offset -20 ÷ 60 m building frame)");
ok(Math.abs(Math.max(...amB[0].points.map((p) => p.x)) - (4/3)) < 1e-6, "ancestorLayersMetric: land far corner at +4/3 (80 ÷ 60) — frames the building, no distortion");
// THE KEY PROPERTY (finding): an IRREGULAR ancestor keeps its TRUE metre shape in the backdrop — the bbox path
// would self-normalize it to its bounding box; the metric path preserves the real outline. L-shaped land (notch).
const amLandL: GeoNode = { id: "am-landL", name: "L", kind: "land", metreW: 100, metreH: 100,
  footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 1 } ],
    pointsM: [ { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 } ] } };
const amPackL: Pack = { ...emptyPack("amL"), geo: [amLandL, { ...amBld, parentId: amLandL.id }] };
const amBL = ancestorLayersMetric(amPackL, amBld.id);
ok(amBL.length === 1 && amBL[0].points.length === 6, "ancestorLayersMetric: an L-shaped ancestor keeps all 6 vertices (its TRUE outline, not a 4-pt bbox)");
// the notch vertex (50,50)m → building frame: ((50-20)/60, (50-20)/60) = (0.5, 0.5)
const notch = amBL[0].points[3];
ok(Math.abs(notch.x - 0.5) < 1e-6 && Math.abs(notch.y - 0.5) < 1e-6, "ancestorLayersMetric: the L-notch sits at its true metre position (0.5,0.5), not a bbox corner");
// no metre anchor anywhere → [] (no backdrop). there's no legacy fallback anymore; a real project's nodes
// always carry metres (the load-time hydrate guarantees it), so [] here means only a pathological metre-less tree.
ok(ancestorLayersMetric(alPack, alBld.id).length === 0, "ancestorLayersMetric: no metres anywhere → [] (no backdrop; no legacy fallback post-Slice-3)");
ok(ancestorLayersMetric(amPack, amLand.id).length === 0, "ancestorLayersMetric: the root land → no ancestors");

// --- Slice 2: nodePosM / derivePosM (explicit metre POSITION) ---
// Reuse the amPack chain: building inset 0.2..0.8 inside 100×100 m land → its min-corner sits at (20,20) m in parent.
const dp = derivePosM(amPack, amBld.id);
ok(dp !== undefined && Math.abs(dp.x - 20) < 1e-6 && Math.abs(dp.y - 20) < 1e-6, "derivePosM: building min-corner at (20,20) m (0.2 × 100 m land)");
// nodePosM with NO stored posM === derivePosM (the legacy/un-migrated path is behaviour-identical to pre-Slice-2).
const posNp = nodePosM(amPack, amBld.id);
ok(posNp !== undefined && Math.abs(posNp.x - 20) < 1e-6 && Math.abs(posNp.y - 20) < 1e-6, "nodePosM: no stored posM → derives (20,20), identical to derivePosM");
// STORED posM WINS over the derived fraction (the Slice-2 authoritative-field semantics).
const amBldPinned: GeoNode = { ...amBld, posM: { x: 33, y: 44 } };
const amPackPinned: Pack = { ...amPack, geo: [amLand, amBldPinned] };
const npStored = nodePosM(amPackPinned, amBldPinned.id);
ok(npStored !== undefined && Math.abs(npStored.x - 33) < 1e-6 && Math.abs(npStored.y - 44) < 1e-6, "nodePosM: STORED posM (33,44) wins over the 0..1-derived (20,20)");
// derivePosM IGNORES stored posM (it is the always-derive stamp source — so authoring never re-reads a stale value).
const dpStored = derivePosM(amPackPinned, amBldPinned.id);
ok(dpStored !== undefined && Math.abs(dpStored.x - 20) < 1e-6, "derivePosM: ignores stored posM, always re-derives (20,20) from the points");
// ancestorLayersMetric READS the stored posM (the Slice-2 rewire): pin the building 10 m further right than its
// fraction → the land backdrop shifts left by 10/60 in the building frame (land origin -33/60 instead of -20/60).
const amBldShift: GeoNode = { ...amBld, posM: { x: 30, y: 20 } }; // +10 m east of the 20 m fraction
const amPackShift: Pack = { ...amPack, geo: [amLand, amBldShift] };
const amShiftB = ancestorLayersMetric(amPackShift, amBldShift.id);
ok(amShiftB.length === 1 && Math.abs(Math.min(...amShiftB[0].points.map((p) => p.x)) - (-30/60)) < 1e-6, "ancestorLayersMetric: stored posM (30,_) shifts the backdrop (land origin -30/60, not -20/60) — proves it reads nodePosM");
// root / no parent → undefined (no position within a parent).
ok(derivePosM(amPack, amLand.id) === undefined, "derivePosM: root land has no parent → undefined");
ok(nodePosM(amPack, amLand.id) === undefined, "nodePosM: root land → undefined");

// ===========================================================================
// METRE-NATIVE representation (D- step 1) — toMetrePoly / fromMetrePoly.
// The lossless bridge between the stored 0..1 self-normalized frame and ONE shape in real metres. STEP 1 proves
// the round-trip preserves SHAPE + REAL DIMENSIONS exactly, on the cheap one-node slice, before any consumer moves.
// ===========================================================================

// --- core round-trip: the half×half poly floor in the 40×25 m building → metres (0,0)(20,0)(20,12.5)(0,12.5) ---
const mpoly = toMetrePoly(pPack, polyUnit.id)!;
ok(!!mpoly && mpoly.pointsM.length === 4, "toMetrePoly: returns the shape's metre points");
ok(near(mpoly.wM, 20) && near(mpoly.hM, 12.5), "toMetrePoly: metre extent = realMetres (20 × 12.5)");
ok(near(mpoly.pointsM[2].x, 20) && near(mpoly.pointsM[2].y, 12.5), "toMetrePoly: far corner sits at (20, 12.5) m — aspect TRUE, not 0..1");
const mBack = fromMetrePoly(mpoly)!;
ok(!!mBack && mBack.footprint.points.length === 4, "fromMetrePoly: recovers a 4-pt poly footprint");
ok(near(mBack.wM, 20) && near(mBack.hM, 12.5), "fromMetrePoly: recovers the metre extent (20 × 12.5)");
// the recovered footprint is the self-normalized shape — compare to footprintSelfNorm of the original
const origSelf = footprintSelfNorm((polyUnit.footprint as any))!;
ok(mBack.footprint.points.every((p, i) => near(p.x, origSelf[i].x, 1e-6) && near(p.y, origSelf[i].y, 1e-6)), "ROUND-TRIP LOSSLESS: fromMetrePoly(toMetrePoly) recovers the self-normalized shape bit-for-bit (r4)");

// --- the disease the refactor kills: per-axis self-norm makes 50×38 and 38×50 IDENTICAL; metres keep them apart ---
const bWide = makeNode("building", undefined, { metreW: 50, metreH: 38, rect: { x: 0, y: 0, w: 1, h: 1 } }, new Set<string>());
const bTall = makeNode("building", undefined, { metreW: 38, metreH: 50, rect: { x: 0, y: 0, w: 1, h: 1 } }, new Set<string>());
const Lpoints = [ { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 1 } ]; // same 0..1 L-shape in both
const lWide: GeoNode = { id: "lw", name: "LW", kind: "floor", parentId: bWide.id, footprint: { shape: "poly", points: Lpoints } };
const lTall: GeoNode = { id: "lt", name: "LT", kind: "floor", parentId: bTall.id, footprint: { shape: "poly", points: Lpoints } };
const mWide = toMetrePoly({ ...emptyPack("w"), geo: [bWide, lWide] }, lWide.id)!;
const mTall = toMetrePoly({ ...emptyPack("t"), geo: [bTall, lTall] }, lTall.id)!;
ok(footprintSelfNorm((lWide.footprint as any))!.every((p, i) => near(p.x, footprintSelfNorm((lTall.footprint as any))![i].x) && near(p.y, footprintSelfNorm((lTall.footprint as any))![i].y)), "self-norm: 50×38 and 38×50 normalize to IDENTICAL points (the aspect-loss disease)");
ok(!(near(mWide.wM, mTall.wM) && near(mWide.hM, mTall.hM)), "toMetrePoly: 50×38 vs 38×50 are now DISTINCT metre shapes (aspect restored — the disease is cured)");
ok(near(mWide.wM, 50) && near(mWide.hM, 38) && near(mTall.wM, 38) && near(mTall.hM, 50), "toMetrePoly: each carries its TRUE metre dimensions");

// --- reads the EFFECTIVE (subtype-shared) shape, not the unit's own rect (D-) ---
// sUnit (own rect 0.3×0.3) is bound to subtype {studio,a} whose plan = subPlanPoly (span 0.5×0.4 of the 40×25 bld).
const mShared = toMetrePoly(sPack, sUnit.id)!;
ok(mShared.pointsM.length === 4, "toMetrePoly: a subtype-bound unit resolves the SHARED plan's shape, not its own rect");
// the plan poly spans 0.5 (x) × 0.4 (y); through the unit's realMetres (0.3×40=12, 0.3×25=7.5) the self-normed shape scales to that extent
ok(near(mShared.wM, 12) && near(mShared.hM, 7.5), "toMetrePoly(shared): metre extent = the unit's own realMetres (0.3×40 × 0.3×25 = 12 × 7.5)");
const sharedBack = fromMetrePoly(mShared)!;
ok(near(sharedBack.wM, 12) && near(sharedBack.hM, 7.5), "ROUND-TRIP(shared): fromMetrePoly recovers the metre extent through the shared-plan path");

// --- absent-safe: no metre anchor, a point, and < 3 metre points → undefined (metres not-yet-known, like deriveSqm) ---
ok(toMetrePoly({ ...pPack, geo: [{ ...polyUnit, parentId: undefined }] }, polyUnit.id) === undefined, "toMetrePoly: no metre anchor → undefined");
const pointUnit: GeoNode = { ...polyUnit, id: "pt", footprint: { shape: "point" } };
ok(toMetrePoly({ ...pPack, geo: [pBuilding, pointUnit] }, pointUnit.id) === undefined, "toMetrePoly: a point footprint → undefined (no outline to measure)");
ok(fromMetrePoly({ pointsM: [{ x: 0, y: 0 }, { x: 1, y: 0 }], wM: 1, hM: 0 }) === undefined, "fromMetrePoly: < 3 points → undefined");
ok(fromMetrePoly({ pointsM: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], wM: 10, hM: 0 }) === undefined, "fromMetrePoly: a degenerate (zero-height) poly → undefined");

// ---------------------------------------------------------------------------
// METRE-NATIVE step 4 (D-) — MEASURE reads metres. deriveSqm's poly area + edgeLengthsMetres now read the
// metre-native shape (toMetrePoly), the aspect-true primitive step 5 stores. These assert the migration is
// behaviour-INVISIBLE: the metre-native path equals the legacy polyMetrePoints path AND the direct shoelace of
// toMetrePoly, including an L-shape (where the destroyed-aspect disease would bite) and the shared-plan path.
// ---------------------------------------------------------------------------
// (1) rect-poly unit: deriveSqm == shoelace(toMetrePoly) == shoelace(polyMetrePoints) — all three agree.
ok(near(deriveSqm(pPack, polyUnit.id)!, shoelaceArea(toMetrePoly(pPack, polyUnit.id)!.pointsM)), "step4: deriveSqm(poly) == shoelace(toMetrePoly.pointsM)");
ok(near(shoelaceArea(toMetrePoly(pPack, polyUnit.id)!.pointsM), shoelaceArea(polyMetrePoints(pPack, polyUnit.id)!)), "step4: toMetrePoly area == legacy polyMetrePoints area (translation-invariant — same shape)");
// (2) an L-shaped unit (4×4 building, L = 16 − 4 = 12 m² at full extent → scaled into the unit's own metre bbox).
// The L fills a 4×4 bbox; as a self-norm 0..1 L scaled to the unit's realMetres it stays an L (area < bbox) — proves
// toMetrePoly carries true aspect, not a bbox-filling rect. Unit = full 20×12.5 m bbox → L area = (1 − 4/16)·(20·12.5).
const lBuilding = makeNode("building", undefined, { metreW: 40, metreH: 25, rect: { x: 0, y: 0, w: 1, h: 1 } }, new Set<string>());
const lNorm = lshape.map((p) => ({ x: p.x / 4, y: p.y / 4 })); // the 4×4 L self-normalized to 0..1
const lUnit: GeoNode = { id: "l-1", name: "L", kind: "floor", parentId: lBuilding.id, footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 } ] } };
// give the L its own shape by swapping points to the normalized L (its bbox is the full 0.5×0.5 placement → realMetres 20×12.5)
const lUnitL: GeoNode = { ...lUnit, footprint: { shape: "poly", points: lNorm.map((p) => ({ x: p.x * 0.5, y: p.y * 0.5 })) } };
const lPack: Pack = { ...emptyPack("L Test"), geo: [lBuilding, lUnitL] };
const lMetre = toMetrePoly(lPack, lUnitL.id)!;
ok(near(lMetre.wM, 20) && near(lMetre.hM, 12.5), "step4(L): toMetrePoly bbox = the unit's realMetres (20 × 12.5), aspect true");
ok(near(deriveSqm(lPack, lUnitL.id)!, (1 - 4 / 16) * 20 * 12.5), "step4(L): deriveSqm reads the TRUE L area (bbox minus the notch), not the bbox — aspect preserved");
ok(near(deriveSqm(lPack, lUnitL.id)!, shoelaceArea(polyMetrePoints(lPack, lUnitL.id)!)), "step4(L): metre-native area == legacy path (behaviour-invisible)");
// (3) shared-plan unit: deriveSqm (declared size wins for a unit) vs the SHAPE path agree where geometry is the source.
// sUnit is a UNIT bound to a subtype plan; deriveSqm short-circuits to the declared/plan size. Assert the metre SHAPE
// the editor measures (edgeLengthsMetres via toMetrePoly) is non-empty and matches the shared plan's 4 edges.
const elShared = edgeLengthsMetres(sPack, sUnit.id);
ok(elShared.length === 4 && elShared.every((l) => l > 0), "step4(shared): edgeLengthsMetres reads the shared-plan shape through toMetrePoly (4 live edges)");

// ---------------------------------------------------------------------------
// METRE-NATIVE step 5a (D-) — stored pointsM is the SOURCE OF TRUTH. A poly footprint may carry metre-native
// vertices (pointsM); when present, toMetrePoly reads THEM (no anchor walk), and fromMetrePoly EMITS them, so a
// shape built metre-native round-trips through storage. Legacy blobs (no pointsM) still derive — back-compat.
// ---------------------------------------------------------------------------
// (1) fromMetrePoly emits pointsM (min-corner origin) alongside the legacy 0..1 points.
const fmOut = fromMetrePoly({ pointsM: [ { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12.5 }, { x: 0, y: 12.5 } ], wM: 20, hM: 12.5 })!;
ok(!!fmOut.footprint.pointsM && fmOut.footprint.pointsM.length === 4, "step5a: fromMetrePoly emits pointsM on the footprint");
ok(near(fmOut.footprint.pointsM![2].x, 20) && near(fmOut.footprint.pointsM![2].y, 12.5), "step5a: emitted pointsM carry the true metres (20 × 12.5), min-corner origin");
// (2) STORED metres WIN over the 0..1+anchor derivation. Build a unit whose 0..1 points + anchor would derive a
// 20×12.5 shape, but stamp a DIFFERENT pointsM (30×10). toMetrePoly must report the STORED 30×10 — proof it's truth.
const storedUnit: GeoNode = { ...polyUnit, footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 } ], pointsM: [ { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 0, y: 10 } ] } };
const storedPack: Pack = { ...pPack, geo: [pBuilding, storedUnit] };
const storedMp = toMetrePoly(storedPack, storedUnit.id)!;
ok(near(storedMp.wM, 30) && near(storedMp.hM, 10), "step5a: stored pointsM WIN — toMetrePoly reads 30×10 (not the 0..1+anchor-derived 20×12.5)");
ok(near(deriveSqm(storedPack, storedUnit.id)!, 300), "step5a: deriveSqm reads the STORED metre shape (30 × 10 = 300 m²)");
// (3) round-trip through storage is lossless: toMetrePoly(node-with-stored-pointsM) == the stored metres.
const rtMp = fromMetrePoly(toMetrePoly(storedPack, storedUnit.id))!;
ok(near(rtMp.wM, 30) && near(rtMp.hM, 10), "step5a: round-trip through stored pointsM recovers 30×10");
// (4) a DEGENERATE or length-mismatched pointsM falls back to the legacy derivation (never a silent bad shape).
const badStored: GeoNode = { ...polyUnit, footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 } ], pointsM: [ { x: 0, y: 0 }, { x: 5, y: 0 } ] } }; // only 2 metre pts (≠ 4 points)
const badPack: Pack = { ...pPack, geo: [pBuilding, badStored] };
ok(near(toMetrePoly(badPack, badStored.id)!.wM, 20) && near(toMetrePoly(badPack, badStored.id)!.hM, 12.5), "step5a: a length-mismatched pointsM is ignored → falls back to the 0..1+anchor derivation (20 × 12.5)");

// ---------------------------------------------------------------------------
// METRE-NATIVE step 5b (D-) — authoring WRITES pointsM. The two pure write helpers patchPoly uses to persist
// an edit metre-native: footprintWithStoredMetres (own footprint, resolves via toMetrePoly+anchor) and
// planFootprintWithStoredMetres (shared plan, self-contained points × a given metre extent). Both must stamp the
// TRUE metres and must NOT run on a node with no anchor (leave 0..1).
// ---------------------------------------------------------------------------
// (1) footprintWithStoredMetres: stamps pointsM onto the own footprint from the resolved anchor (20×12.5 here).
const wsmFp = footprintWithStoredMetres(pPack, polyUnit.id, polyUnit.footprint);
ok(wsmFp?.shape === "poly" && !!wsmFp.pointsM && wsmFp.pointsM.length === 4, "step5b: footprintWithStoredMetres stamps pointsM onto the own footprint");
ok(wsmFp?.shape === "poly" && near(Math.max(...wsmFp.pointsM!.map((p) => p.x)), 20) && near(Math.max(...wsmFp.pointsM!.map((p) => p.y)), 12.5), "step5b: stamped pointsM carry the TRUE metres (20 × 12.5)");
// round-trips with toMetrePoly: a node whose footprint now carries the stamped pointsM reads back the same metres.
const wsmPack: Pack = { ...pPack, geo: [pBuilding, { ...polyUnit, footprint: wsmFp }] };
ok(near(toMetrePoly(wsmPack, polyUnit.id)!.wM, 20) && near(toMetrePoly(wsmPack, polyUnit.id)!.hM, 12.5), "step5b: a stamped footprint reads back 20×12.5 through toMetrePoly (stored-metres path)");
// no metre anchor → returns the footprint UNCHANGED (stays 0..1, no fabricated metres).
const noAnchorFp = footprintWithStoredMetres({ ...pPack, geo: [{ ...polyUnit, parentId: undefined }] }, polyUnit.id, polyUnit.footprint);
ok(noAnchorFp?.shape === "poly" && !noAnchorFp.pointsM, "step5b: no metre anchor → footprintWithStoredMetres leaves the footprint 0..1 (no pointsM)");
// (2) planFootprintWithStoredMetres: self-contained plan points × a given extent → pointsM. Plan spans 0.5×0.4 of
// its own frame, but self-norm fills 0..1 → extent 12×7.5 → pointsM bbox = 12×7.5 (aspect from the extent, not the span).
const planFp = { shape: "poly" as const, points: [ { x: 0.1, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.6, y: 0.5 }, { x: 0.1, y: 0.5 } ] };
const planWithM = planFootprintWithStoredMetres(planFp, { w: 12, h: 7.5 });
ok(!!planWithM.pointsM && planWithM.pointsM.length === 4, "step5b: planFootprintWithStoredMetres stamps pointsM on the plan");
const pwx = planWithM.pointsM!.map((p) => p.x), pwy = planWithM.pointsM!.map((p) => p.y);
ok(near(Math.max(...pwx) - Math.min(...pwx), 12) && near(Math.max(...pwy) - Math.min(...pwy), 7.5), "step5b: plan pointsM bbox = the given extent (12 × 7.5), self-norm fills it");
ok(planFootprintWithStoredMetres(planFp, undefined) === planFp, "step5b: planFootprintWithStoredMetres with no extent → unchanged (no fabricated metres)");

// ---------------------------------------------------------------------------
// METRE-NATIVE step 5c (D-) — LAZY-HYDRATE at projection: hydrateGeoMetres fills pointsM on un-migrated OWN-poly
// geo nodes from the resolved Pack (toMetrePoly+anchor), so an existing import upgrades on first projectToPack with
// no explicit edit. PURE + NON-MUTATING; skips bound units (shape lives on the shared plan) + already-metre nodes.
// ---------------------------------------------------------------------------
// (1) a legacy own-poly (no pointsM) hydrates to its true metres (polyUnit: 20×12.5 in the 40×25 building).
const legacyPoly = (pPack.geo!.find((n) => n.id === polyUnit.id)!.footprint as any);
ok(!legacyPoly.pointsM, "step5c: the import fixture starts legacy (no pointsM — nothing written in-place yet)");
const hydrated = hydrateGeoMetres(pPack);
const hpFp = hydrated.find((n) => n.id === polyUnit.id)!.footprint as any;
ok(!!hpFp.pointsM && hpFp.pointsM.length === 4, "step5c: hydrateGeoMetres stamps pointsM on a legacy own-poly node");
ok(near(Math.max(...hpFp.pointsM.map((p: any) => p.x)), 20) && near(Math.max(...hpFp.pointsM.map((p: any) => p.y)), 12.5), "step5c: hydrated pointsM carry the TRUE metres (20 × 12.5), derived via the anchor");
// a hydrated node reads back the same metres through the stored-metres path of toMetrePoly.
ok(near(toMetrePoly({ ...pPack, geo: hydrated }, polyUnit.id)!.wM, 20) && near(toMetrePoly({ ...pPack, geo: hydrated }, polyUnit.id)!.hM, 12.5), "step5c: a hydrated node reads back 20×12.5 (stored-metres path, same value as the derive)");
// (2) NON-MUTATING: the input geo + its footprint are untouched (so p.geo, the authored truth, is never corrupted).
ok((pPack.geo!.find((n) => n.id === polyUnit.id)!.footprint as any).pointsM === undefined, "step5c: hydrateGeoMetres does NOT mutate the input footprint (authored truth stays legacy)");
ok(hydrated !== pPack.geo, "step5c: returns a FRESH geo array when something hydrated");
// (3) idempotent: a second pass over the already-hydrated geo returns the SAME reference (no needless churn).
ok(hydrateGeoMetres({ ...pPack, geo: hydrated }) === hydrated, "step5c: re-hydrating an already-metre tree is a no-op (same reference back)");
// (3b, Slice 3) the SAME pass also stamps posM (POSITION truth) on a legacy child — == derivePosM, and the
// authored input stays posM-less (non-mutating). The idempotent re-pass still returns the same ref (posM done too).
const hPos = hydrated.find((n) => n.id === polyUnit.id)!;
const dPos = derivePosM(pPack, polyUnit.id)!;
ok(!!hPos.posM && near(hPos.posM.x, dPos.x) && near(hPos.posM.y, dPos.y), "step5c: hydrateGeoMetres stamps posM == derivePosM on a legacy child node");
ok(pPack.geo!.find((n) => n.id === polyUnit.id)!.posM === undefined, "step5c: posM stamp is NON-MUTATING (authored input node stays posM-less)");
// (4) a BOUND unit is SKIPPED — its shape lives on the shared plan (D-), so its own footprint must not be
//     stamped with the plan's metres. Give the bound unit an OWN poly to prove the gate is resolvePlan, not an
//     accidental rect/length guard. hydrate must leave that own poly's pointsM absent.
const boundOwnPoly: GeoNode = { ...sUnit, id: "s-unit-ownpoly", footprint: { shape: "poly", points: [ { x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.3 }, { x: 0, y: 0.3 } ] } };
const sPackBound: Pack = { ...sPack, geo: [sBuilding, sFloor, boundOwnPoly] };
const hBound = hydrateGeoMetres(sPackBound);
ok(resolvePlan(sPackBound, boundOwnPoly) != null, "step5c(guard): the bound unit DOES resolve a shared plan (the gate's precondition)");
ok((hBound.find((n) => n.id === boundOwnPoly.id)!.footprint as any).pointsM === undefined, "step5c: a plan-bound node is SKIPPED — its own footprint is never stamped with the plan's metres (D-S339)");
// (5) a node with NO anchor stays 0..1 (no fabricated metres), and the whole tree returns unchanged.
const noAnchorPack: Pack = { ...emptyPack("na"), geo: [{ ...polyUnit, parentId: undefined }] };
ok(hydrateGeoMetres(noAnchorPack) === noAnchorPack.geo, "step5c: no anchor anywhere → nothing hydrates (same reference, no fabricated metres)");

// ---------------------------------------------------------------------------
// SQUARE-GRID DE-SKEW (the design docs Slice 1) — the deed shape is authored SQUARE with
// the building FRONT facing screen-DOWN; the one real-world rotation (bearingDeg = front-vector azimuth from north)
// is applied map-side ONLY. These pure fns convert map-oriented ⇄ square-authored losslessly. Tests ARE the gate.
// ---------------------------------------------------------------------------
// (1) bearingFromVectorMetres: compass azimuth (clockwise from north=screen-up, y-DOWN space).
ok(near(bearingFromVectorMetres(0, -1), 0), "deskew: a vector pointing screen-UP (−y) = north = 0°");
ok(near(bearingFromVectorMetres(1, 0), 90), "deskew: a vector pointing screen-RIGHT (+x) = east = 90°");
ok(near(bearingFromVectorMetres(0, 1), 180), "deskew: a vector pointing screen-DOWN (+y) = south = 180°");
ok(near(bearingFromVectorMetres(-1, 0), 270), "deskew: a vector pointing screen-LEFT (−x) = west = 270°");

// (2) polyCentroid: average of vertices.
const sqM = [ { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 } ];
const ctr = polyCentroid(sqM);
ok(near(ctr.x, 5) && near(ctr.y, 3), "deskew: polyCentroid of a 10×6 rect = (5,3)");

// (3) deskewToFrontDown brings a front pointing at `bearingDeg` round to screen-DOWN (south=180°). Model the front
// as the TOP edge's outward normal: for an axis-aligned rect the top edge faces −y (north, bearing 0). Deskew with
// bearing 0 should rotate it 180° so that edge now faces +y (down). Check the former-top midpoint ends up at bottom.
const topMid0 = { x: 5, y: 0 }; // midpoint of the top edge (faces north, bearing 0)
const des0 = deskewToFrontDown(sqM, 0);
// after a 180° rotation about centre (5,3), (5,0) → (5,6)
const desTopMid = rotatePointsAboutCentre([topMid0], 180 - 0, ctr)[0];
ok(near(desTopMid.x, 5) && near(desTopMid.y, 6), "deskew: front at bearing 0 (north) rotates to face screen-DOWN (midpoint 5,0 → 5,6)");
ok(des0.length === 4, "deskew: deskewToFrontDown preserves vertex count");

// (4) a RIGID transform — edge lengths + area are preserved (no skew), for an arbitrary bearing.
const quad = [ { x: 0, y: 0 }, { x: 12, y: 2 }, { x: 14, y: 9 }, { x: 1, y: 8 } ];
const area0 = shoelaceArea(quad);
const desQuad = deskewToFrontDown(quad, 37);
ok(near(shoelaceArea(desQuad), area0, 1e-2), "deskew: deskewToFrontDown is RIGID — area preserved (no skew) at bearing 37°");
const elen = (p: {x:number;y:number}[]) => p.map((q, i) => { const r = p[(i + 1) % p.length]; return Math.hypot(r.x - q.x, r.y - q.y); });
const e0 = elen(quad), e1 = elen(desQuad);
ok(e0.every((l, i) => near(l, e1[i], 1e-2)), "deskew: every edge length is preserved by deskewToFrontDown (rigid)");

// (5) reskewForMap is the exact INVERSE of deskewToFrontDown (round-trip identity up to float, for any bearing).
for (const b of [0, 17, 90, 128.5, 270]) {
  const round = reskewForMap(deskewToFrontDown(quad, b), b);
  ok(quad.every((q, i) => near(q.x, round[i].x, 1e-6) && near(q.y, round[i].y, 1e-6)), `deskew: reskew∘deskew == identity at bearing ${b}°`);
}

// (6) bearingFromLongestEdgeMetres: the plot's azimuth from its longest edge (the road-side convenience default).
// quad's longest edge is corner2→corner3 (14,9)→(1,8), length ≈13.04, delta (−13,−1) → west-ish ≈ 265.6°.
const lb = bearingFromLongestEdgeMetres(quad);
ok(near(lb, bearingFromVectorMetres(-13, -1), 1e-2), "deskew: bearingFromLongestEdgeMetres = the longest edge's azimuth (road-side default)");
ok(lb >= 0 && lb < 360, "deskew: bearingFromLongestEdgeMetres is a 0..360 compass bearing");

// ---------------------------------------------------------------------------
// DE-TILT THE IMPORT (Slice 2, the design docs §A/§C) — a traced GPS parcel must become a
// SQUARE authoring footprint + its de-tilted metre extent + the plot bearing, NOT a tilted bbox-normalized shape.
// The plot's real-world rotation lives ONLY in bearingDeg (→ siteGeo.northBearingDeg), re-applied map-side.
// ---------------------------------------------------------------------------
// Build a KNOWN parcel: a 60×40 m rectangle, rotated to a known bearing, projected to lat/lng about a pin, so we can
// assert the de-tilt recovers (a) the bearing, (b) the 60×40 extent (de-tilted), (c) the area 2400 m².
const detiltPin: [number, number] = [12.9218, 100.862];
const mPerLat = (6378137 * Math.PI) / 180;
const mPerLng = mPerLat * Math.cos(detiltPin[0] * (Math.PI / 180));
// a 60-wide × 40-tall rect centred at origin in metres (y-down), then rotate CLOCKWISE by 25° (the "plot tilt").
const rectMetres = [ { x: -30, y: -20 }, { x: 30, y: -20 }, { x: 30, y: 20 }, { x: -30, y: 20 } ];
const tiltDeg = 25;
const tiltedMetres = rotatePointsAboutCentre(rectMetres, tiltDeg, { x: 0, y: 0 });
// metres (x east, y DOWN) → lat/lng about the pin (north = −y).
const tiltedLatLng: [number, number][] = tiltedMetres.map((p) => [
  detiltPin[0] + (-p.y) / mPerLat,
  detiltPin[1] + p.x / mPerLng,
]);

// (1) latLngPolygonToMetrePoints recovers the tilted metre rect (about the geographic centroid = the pin).
const backMetres = latLngPolygonToMetrePoints(tiltedLatLng);
ok(backMetres.every((p, i) => near(p.x, tiltedMetres[i].x, 1e-2) && near(p.y, tiltedMetres[i].y, 1e-2)),
  "detilt: latLngPolygonToMetrePoints recovers the local metre shape (round-trip through lat/lng)");

// (2) bearingFromLatLngPolygon extracts the plot's azimuth from the longest edge. The 60-wide edges are longest;
// edge 0→1 was (−30,−20)→(30,20) direction (60,0) rotated 25° CW = azimuth of that vector.
const expectBearing = bearingFromVectorMetres(60 * Math.cos(tiltDeg * Math.PI / 180), 60 * Math.sin(tiltDeg * Math.PI / 180));
const gotBearing = bearingFromLatLngPolygon(tiltedLatLng);
ok(near(gotBearing, expectBearing, 0.5), "detilt: bearingFromLatLngPolygon extracts the plot's longest-edge azimuth (~the tilt)");

// (3) latLngPolygonToSquareFootprint → a SQUARE footprint + de-tilted extent + the bearing. The de-tilted extent
// must be the HONEST 60×40 (not the rotated bbox ~72×54), and the shoelace area ≈ 2400 m².
const detiltSq = latLngPolygonToSquareFootprint(tiltedLatLng);
ok(!!detiltSq, "detilt: latLngPolygonToSquareFootprint returns a result for a valid parcel");
if (detiltSq) {
  const { w, h } = { w: Math.max(detiltSq.metreW, detiltSq.metreH), h: Math.min(detiltSq.metreW, detiltSq.metreH) };
  ok(near(w, 60, 0.3) && near(h, 40, 0.3), "detilt: de-tilted metre extent is the HONEST 60×40 (not the rotated bbox)");
  ok(near(detiltSq.bearingDeg, expectBearing, 0.5), "detilt: the stored bearing = the plot's azimuth");
  // the footprint is self-normalized 0..1 → scale back to metres via the extent and shoelace: ≈ 2400 m².
  const fpM = detiltSq.footprint.points.map((p) => ({ x: p.x * detiltSq.metreW, y: p.y * detiltSq.metreH }));
  ok(near(shoelaceArea(fpM), 2400, 20), "detilt: area preserved through the de-tilt (≈ 2400 m²)");
  // (4) the authored shape is SQUARE: a de-tilted rectangle self-normalizes to the unit-square corners (axis-aligned).
  const xs = detiltSq.footprint.points.map((p) => p.x), ys = detiltSq.footprint.points.map((p) => p.y);
  ok(near(Math.min(...xs), 0, 1e-3) && near(Math.max(...xs), 1, 1e-3) && near(Math.min(...ys), 0, 1e-3) && near(Math.max(...ys), 1, 1e-3),
    "detilt: the de-tilted rectangle authors as an axis-aligned unit square (no residual tilt)");
}

// (5) degenerate guards.
ok(latLngPolygonToSquareFootprint(undefined) === undefined, "detilt: undefined for no polygon");
ok(latLngPolygonToSquareFootprint([[12.92, 100.88], [12.92, 100.881]]) === undefined, "detilt: undefined for < 3 corners");
ok(bearingFromLatLngPolygon(undefined) === 0, "detilt: bearingFromLatLngPolygon = 0 for no polygon");

console.log(`geo.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
