// §4d geometry-engine tests (lib/geo.ts). Pure, no I/O. Run via tsx.
// Covers: clampRect containment, the nested-fraction metre derivation + deriveSqm, constrainToSqm,
// the named factories (valid shapes, child-kind depth), and tree navigation over pack.geo[].

import { emptyPack, type GeoNode, type Pack } from "./pack";
import {
  CHILD_KIND,
  childrenOf,
  clampRect,
  constrainPolySqm,
  constrainToSqm,
  deriveSqm,
  detectEdgeLinks,
  edgeLengthsMetres,
  floorSummary,
  haversineMetres,
  makeNode,
  metreExtentFromLatLngPolygon,
  polyMetrePoints,
  realMetres,
  rootNodes,
  setEdgeLengthMetres,
  shoelaceArea,
  snapToColumns,
  STATUS_FILL,
  toggleInSet,
  UNIT_STATUSES,
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

// poly m² pin: scale the 250 m² poly to 1000 m² (k=2), shape kept similar
const pinned = constrainPolySqm(pPack, polyUnit.id, 1000);
const pPackP: Pack = { ...pPack, geo: [pBuilding, { ...polyUnit, footprint: { shape: "poly", points: pinned } }] };
ok(near(deriveSqm(pPackP, polyUnit.id)!, 1000, 1), "constrainPolySqm: pinned to 1000 m² yields ~1000 m²");
const elP = edgeLengthsMetres(pPackP, polyUnit.id);
ok(near(elP[0] / elP[1], el[0] / el[1], 0.02), "constrainPolySqm keeps the shape (edge ratio preserved)");

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

console.log(`geo.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
