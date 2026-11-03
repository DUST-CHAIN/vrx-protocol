// ─────────────────────────────────────────────────────────────────────────────
// lib/ifc-to-project.ts — IFC-import arc Slice 2: map an IfcSlice → MM's AuthoredProject.
//
// Slice 1 (lib/ifc-import.ts) gives a faithful intermediate `IfcSlice` (storeys + space footprints in
// METRES + openings). This module turns that into a metre-native AuthoredProject with a land→building→
// floor→unit geo tree — so a real CAD building imports straight into the Studio for review-then-accept.
//
// It is the TWIN of lib/generate-building.ts: same metre-native node discipline (every node born with
// `points` + `pointsM` SHAPE truth + `posM` POSITION truth + a metre anchor), so projectToPackAll reads
// the output verbatim and NO load-time hydrate is needed. The ONLY difference is the source — real IFC
// space polygons instead of synthetic rects. No new write path (trap); the output is a plain
// AuthoredProject the existing loadGenerated-style store loader consumes.
//
// ── The room→unit decision (confirmed with, on real Schependomlaan data) ──
// An IfcSpace here is a ROOM, and the space Name is `<floor>.<seq>` (e.g. "3.08" = floor 3, space 08) — the
// prefix is the FLOOR (already resolved structurally by the extractor), NOT an apartment id, so there is no
// trustworthy key to auto-group rooms into apartments. Decision: map 1 IfcSpace → 1 MM unit, FILTER
// circulation (A-prefixed stairwells + tiny slivers), invent nothing. Grouping stays a later slice.
//
// PURE + React-free (unit-tests with no DOM / no WASM). The WASM lives behind Slice 1's IfcReader seam.
// ─────────────────────────────────────────────────────────────────────────────

import type { IfcSlice, IfcSpaceRec, Pt2 } from "./ifc-import";
import type { AuthoredProject, AuthoredBuilding } from "./project";
import { newBuilding } from "./project";
import { defaultTypes, emptyGrid } from "./authoring";
import type { GeoNode, Footprint } from "./pack";

// ---------------------------------------------------------------------------
// Options + report
// ---------------------------------------------------------------------------

export interface IfcToProjectOpts {
  /** Spaces smaller than this (m²) are dropped as slivers (toilet/technical) and reported. Default 3. */
  minAreaSqm?: number;
  /** Building display name (default "Imported building"). The IFC carries geometry, not a product name. */
  name?: string;
  /** Margin (m) of generated land around the building bbox on each side. Default 6. */
  landMarginM?: number;
}

/** Why a space was excluded from the sellable units. */
export interface DroppedSpace {
  expressID: number;
  name: string;
  reason: "circulation" | "too-small" | "no-storey" | "degenerate";
  areaSqm: number;
}

/** What the mapping did — surfaced to the Slice-3 review UI (and asserted by tests). Nothing silent. */
export interface MapReport {
  storeysKept: number;
  storeysSkipped: Array<{ expressID: number; name: string }>; // storeys with no kept spaces (foundation/roof)
  unitsCreated: number;
  dropped: DroppedSpace[];
  warnings: string[]; // the extractor's warnings carried through + any mapping warnings
}

const DEFAULTS = { minAreaSqm: 3, name: "Imported building", landMarginM: 6 } as const;

const r4 = (n: number) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// Metre-native poly builder (mirrors generate-building.ts `metrePoly`): emits BOTH the 0..1 self-norm
// `points` (legacy view) and the metre-native `pointsM` (source of truth, min-corner origin). The caller
// passes points in ANY metre frame; we re-origin to the shape's own min-corner. PURE.
// ---------------------------------------------------------------------------

function metrePoly(pointsM: Pt2[]): { footprint: Extract<Footprint, { shape: "poly" }>; minX: number; minY: number; wM: number; hM: number } {
  const xs = pointsM.map((p) => p.x), ys = pointsM.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const wM = Math.max(...xs) - minX, hM = Math.max(...ys) - minY;
  const w = Math.max(1e-6, wM), h = Math.max(1e-6, hM);
  const points = pointsM.map((p) => ({ x: r4((p.x - minX) / w), y: r4((p.y - minY) / h) }));
  const originM = pointsM.map((p) => ({ x: r4(p.x - minX), y: r4(p.y - minY) }));
  return { footprint: { shape: "poly", points, pointsM: originM }, minX, minY, wM: r4(wM), hM: r4(hM) };
}

/** An axis-aligned rectangle's 4 corners in metres (top-left, CW), origin at (0,0). PURE. */
function rectCornersAt(w: number, h: number): Pt2[] {
  return [ { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h } ];
}

/** The bbox of a set of points (metres). PURE. */
function bbox(pts: Pt2[]): { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------------------
// Filtering: which spaces become sellable units
// ---------------------------------------------------------------------------

/** A per-floor circulation/stairwell in this dataset has an `A`-prefixed name (A0.01, A1.01, …). PURE. */
function isCirculation(name: string): boolean {
  return /^A/i.test(name.trim());
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/**
 * Map an extracted IfcSlice into a metre-native AuthoredProject (one developer → one development → one
 * building with a full land→building→floor→unit geo tree) + a MapReport of every decision.
 *
 * Geometry is REAL (the architect's space footprints, to scale). Names/prices are left blank/synthetic —
 * the IFC carries the building, not the deal, so nothing about the sale is invented.
 *
 * PURE + deterministic. Node ids are derived from IFC express ids so they're stable across re-imports.
 */
export function ifcSliceToProject(
  slice: IfcSlice,
  opts: IfcToProjectOpts = {}
): { project: AuthoredProject; report: MapReport } {
  const minAreaSqm = opts.minAreaSqm ?? DEFAULTS.minAreaSqm;
  const name = opts.name ?? DEFAULTS.name;
  const landMarginM = opts.landMarginM ?? DEFAULTS.landMarginM;

  const report: MapReport = {
    storeysKept: 0,
    storeysSkipped: [],
    unitsCreated: 0,
    dropped: [],
    warnings: [...slice.warnings],
  };

  const buildingId = "building";
  const bNodeId = `${buildingId}-bld`;
  const landId = `${buildingId}-land`;

  // ── 1. filter spaces → the kept (sellable) set, grouped by storey ──
  const keptByStorey = new Map<number, IfcSpaceRec[]>();
  for (const sp of slice.spaces) {
    if (sp.polygon.length < 3 || !(sp.areaSqm > 0)) {
      report.dropped.push({ expressID: sp.expressID, name: sp.name, reason: "degenerate", areaSqm: sp.areaSqm });
      continue;
    }
    if (isCirculation(sp.name)) {
      report.dropped.push({ expressID: sp.expressID, name: sp.name, reason: "circulation", areaSqm: sp.areaSqm });
      continue;
    }
    if (sp.areaSqm < minAreaSqm) {
      report.dropped.push({ expressID: sp.expressID, name: sp.name, reason: "too-small", areaSqm: sp.areaSqm });
      continue;
    }
    if (sp.storeyExpressID == null) {
      report.dropped.push({ expressID: sp.expressID, name: sp.name, reason: "no-storey", areaSqm: sp.areaSqm });
      continue;
    }
    const arr = keptByStorey.get(sp.storeyExpressID) ?? [];
    arr.push(sp);
    keptByStorey.set(sp.storeyExpressID, arr);
  }

  // ── 2. building bbox = the bbox of ALL kept space polygons (so every floor + unit nests) ──
  const allKept = [...keptByStorey.values()].flat();
  const allPts: Pt2[] = allKept.flatMap((s) => s.polygon);
  const bb = allPts.length >= 3 ? bbox(allPts) : { minX: 0, minY: 0, maxX: 10, maxY: 10, w: 10, h: 10 };
  const bW = r4(Math.max(1, bb.w));
  const bH = r4(Math.max(1, bb.h));
  if (allKept.length === 0) report.warnings.push("no sellable spaces after filtering — empty building");

  // storeys that actually carry kept spaces, in the slice's elevation order
  const keptStoreys = slice.storeys.filter((st) => (keptByStorey.get(st.expressID)?.length ?? 0) > 0);
  for (const st of slice.storeys) {
    if ((keptByStorey.get(st.expressID)?.length ?? 0) === 0) {
      report.storeysSkipped.push({ expressID: st.expressID, name: st.name });
    }
  }
  report.storeysKept = keptStoreys.length;

  // ── 3. the geo tree ──
  const nodes: GeoNode[] = [];

  // LAND — a generated envelope around the building bbox (IFC carries no parcel). The user replaces it with
  // the real deed later, exactly like the generate-building faucet's plot.
  const landW = r4(bW + landMarginM * 2);
  const landH = r4(bH + landMarginM * 2);
  const land = metrePoly(rectCornersAt(landW, landH));
  nodes.push({
    id: landId, name: "Imported site", kind: "land",
    metreW: landW, metreH: landH,
    footprint: land.footprint,
    targetAreaSqm: r4(landW * landH),
  });

  // BUILDING — footprint = the building bbox (origin-normalized), its own metre anchor, centred in the land.
  const bFp = metrePoly(rectCornersAt(bW, bH));
  nodes.push({
    id: bNodeId, name, kind: "building", parentId: landId,
    footprint: bFp.footprint,
    posM: { x: r4(landMarginM), y: r4(landMarginM) }, // centred: (landW-bW)/2 == landMarginM by construction
    metreW: bW, metreH: bH,
    heightM: r4(Math.max(1, keptStoreys.length) * 3.2),
  });

  // FLOORS + UNITS — one floor node per kept storey; one unit node per kept space, carrying its REAL polygon.
  // All space polygons share the building frame (Slice 1 applied world placement), so we subtract the building
  // bbox min-corner to put every unit into the building/floor frame (floors fill the plate at posM 0,0).
  for (let fi = 0; fi < keptStoreys.length; fi++) {
    const st = keptStoreys[fi];
    const floorId = `${buildingId}-f${st.expressID}`;
    const floorPlate = metrePoly(rectCornersAt(bW, bH));
    nodes.push({
      id: floorId, name: st.name || `Floor ${fi + 1}`, kind: "floor", parentId: bNodeId,
      footprint: floorPlate.footprint,
      posM: { x: 0, y: 0 },
      metreW: bW, metreH: bH,
      heightM: 3.2,
    });

    const spaces = keptByStorey.get(st.expressID) ?? [];
    for (const sp of spaces) {
      // the space polygon in the FLOOR frame = world metres minus the building bbox min-corner
      const inFrame = sp.polygon.map((p) => ({ x: p.x - bb.minX, y: p.y - bb.minY }));
      const poly = metrePoly(inFrame);
      nodes.push({
        id: `${floorId}-u${sp.expressID}`, name: sp.name || `Space ${sp.expressID}`, kind: "unit",
        parentId: floorId,
        footprint: poly.footprint,
        posM: { x: r4(poly.minX), y: r4(poly.minY) }, // min-corner in floor metres
        sqm: r4(sp.areaSqm),
        status: "available",
      });
      report.unitsCreated++;
    }
  }

  // ── 4. building scalars + matrix (so the Structured face isn't empty) ──
  const floors = Math.max(1, keptStoreys.length);
  const unitsPerFloor = Math.max(1, ...keptStoreys.map((st) => keptByStorey.get(st.expressID)?.length ?? 0));

  const building: AuthoredBuilding = newBuilding({
    id: buildingId,
    name,
    type: "High Rise",
    tagline: `Imported from IFC (${slice.schema}) — ${report.unitsCreated} spaces across ${floors} floor(s).`,
    floors,
    unitsPerFloor,
    floorAreaM2: r4(bW * bH),
    types: defaultTypes(),
    matrix: emptyGrid(floors, unitsPerFloor),
  });

  const project: AuthoredProject = {
    v: 1,
    domain: "realestate",
    developer: { id: "imported-developer", name: "Imported Developer" },
    companies: [],
    complexes: [{
      id: "imported-development",
      name: "Imported Development",
      buildings: [building],
    }],
    terms: [],
    activeBuildingId: buildingId,
    geo: nodes,
  };

  return { project, report };
}
