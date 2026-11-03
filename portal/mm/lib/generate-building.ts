// generateBuilding(opts) — a TEST-DATA FAUCET (the steer: "generate building data, don't nurse the
// fixture"). Emits a fresh, fully METRE-NATIVE AuthoredProject on demand so every verify loop is cheap + repeatable
// instead of re-running the Skyline localStorage dance ("a trip around the universe"). The output is position-
// authoritative on LOAD — every geo node is born carrying `pointsM` (SHAPE truth) + `posM` (POSITION truth) +
// the land's `metreW/metreH` anchor — so NO load-time hydrate is needed (unlike a legacy blob).
//
// REAL = sizes + geometry (honest, to-scale — MM geometry drives real on-chain inventory). FAKE = name / developer
// / prices / availability (synthetic, deterministic from `seed`). NEVER any buyer PII. The `plotRotationDeg` option
// emits a TILTED land quad so the "building on a tilted plot" case (kill-the-bbox arc Slice 4: rotation as a first-
// class node transform) is reproducible on demand — the exact thing the Skyline deed forced us to nurse by hand.
//
// PURE + React-free (unit-tests with no DOM). The dev-only "⚡ Generate test building" button (Frame.tsx) calls a
// thin store wrapper (usePackStore loadGenerated) around this; it is invisible in the hosted /vrx/mm build.

import type { AuthoredProject, AuthoredBuilding } from "./project";
import { newBuilding } from "./project";
import { defaultTypes, type UnitCell } from "./authoring";
import type { GeoNode, Footprint, NodePrice } from "./pack";
import type { Pt } from "./geo";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GenerateBuildingOpts {
  /** Number of floors (default 6). */
  floors?: number;
  /** Units per floor (default 4). */
  unitsPerFloor?: number;
  /** Land plot size in metres (default 60 × 44). The building insets inside it. */
  landW?: number;
  landH?: number;
  /** Building footprint size in metres (default: ~0.6 of the land, centred). */
  buildingW?: number;
  buildingH?: number;
  /** TILT the whole land plot by this many degrees (clockwise), about the plot centre. 0 = axis-aligned (default).
   *  This is the Slice-4 hook: a non-zero tilt gives a rotated plot to re-fit a building onto ("building-hugs-plot").
   *  The building + floors + units are emitted AXIS-ALIGNED inside the (untilted) land frame — Slice 4's node
   *  rotation is what rotates the building to hug the tilted plot; the generator just supplies the tilted land. */
  plotRotationDeg?: number;
  /** Deterministic seed for the synthetic prices/status (default 1). Same seed → identical project. */
  seed?: number;
  /** Building display name (FAKE — default "Test Tower"). */
  name?: string;
}

const DEFAULTS = {
  floors: 6,
  unitsPerFloor: 4,
  landW: 60,
  landH: 44,
  plotRotationDeg: 0,
  seed: 1,
  name: "Test Tower",
} as const;

// ---------------------------------------------------------------------------
// Small deterministic RNG (mulberry32) — so a given seed reproduces the same prices/status. PURE.
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const money = (usd: number): NodePrice => ({ amountUsd: Math.round(usd) });

// ---------------------------------------------------------------------------
// Metre-native node builders — each node is born with points + pointsM + posM so it loads position-authoritative.
// ---------------------------------------------------------------------------

/** A metre-native poly footprint from own-frame metre points: emits BOTH the 0..1 self-norm `points` (legacy view)
 *  and the metre-native `pointsM` (source of truth, min-corner origin) — exactly like `fromMetrePoly`. The caller
 *  passes points already in the node's OWN metre frame (min-corner need not be origin; we re-origin here). PURE. */
function metrePoly(pointsM: Pt[]): Extract<Footprint, { shape: "poly" }> {
  const xs = pointsM.map((p) => p.x), ys = pointsM.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const wM = Math.max(...xs) - minX, hM = Math.max(...ys) - minY;
  const w = Math.max(1e-6, wM), h = Math.max(1e-6, hM);
  const points = pointsM.map((p) => ({ x: r4((p.x - minX) / w), y: r4((p.y - minY) / h) }));
  const originM = pointsM.map((p) => ({ x: r4(p.x - minX), y: r4(p.y - minY) }));
  return { shape: "poly", points, pointsM: originM };
}

/** An axis-aligned rectangle's 4 corners in metres (top-left, CW). PURE. */
function rectCorners(w: number, h: number): Pt[] {
  return [ { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h } ];
}

/** Rotate points `deg` clockwise (SVG y-down) about `centre`. PURE (mirrors geo.ts rotatePointsAboutCentre). */
function rotateAbout(points: Pt[], deg: number, centre: Pt): Pt[] {
  if (!deg) return points;
  const rad = (deg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  return points.map((p) => {
    const dx = p.x - centre.x, dy = p.y - centre.y;
    return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
  });
}

// ---------------------------------------------------------------------------
// The matrix — a simple, varied, valid grid (not the sample's full constant-plate model). PURE.
// ---------------------------------------------------------------------------

/** A per-floor band: lower floors = smaller mix, upper floors = larger. Keeps the output readable + varied. */
function genMatrix(floors: number, perFloor: number): UnitCell[][] {
  const grid: UnitCell[][] = [];
  for (let f = 0; f < floors; f++) {
    const row: UnitCell[] = Array.from({ length: perFloor }, (_, c) => {
      // grade the mix: ground = shops, lower = studio/1br, upper = 2br/3br
      const type =
        f === 0 ? "shop" :
        f < floors * 0.4 ? (c % 2 === 0 ? "studio" : "1br") :
        f < floors * 0.8 ? (c % 2 === 0 ? "1br" : "2br") :
        (c % 2 === 0 ? "2br" : "3br");
      const sub = (["a", "b", "c"] as const)[c % 3];
      return { typeKey: type, subtypeKey: sub };
    });
    grid.push(row);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// The geo tree — land → building → floors → units, all metre-native.
// ---------------------------------------------------------------------------

/** Nominal sellable size per type (m²) — REAL geometry, matched to the default palette. */
const TYPE_SQM: Record<string, number> = { shop: 45, studio: 34, "1br": 48, "2br": 75, "3br": 105 };

function buildGeo(
  buildingId: string,
  floors: number,
  perFloor: number,
  landW: number,
  landH: number,
  bW: number,
  bH: number,
  plotRotationDeg: number,
  rand: () => number
): GeoNode[] {
  const nodes: GeoNode[] = [];
  const landId = `${buildingId}-land`;
  const bNodeId = `${buildingId}-bld`;

  // LAND — the outer shell + the metre anchor. A tilted plot (plotRotationDeg ≠ 0) is a rotated quad about its
  // centre; the footprint pointsM carry the real tilted shape, so the backdrop + area are honest. metreW/metreH are
  // the anchor extent (bbox of the possibly-tilted quad) so children's metres resolve.
  const landPts = rotateAbout(rectCorners(landW, landH), plotRotationDeg, { x: landW / 2, y: landH / 2 });
  const landFp = metrePoly(landPts);
  const landBbox = bboxWH(landPts); // the anchor extent = the (possibly tilted) quad's bbox
  nodes.push({
    id: landId, name: "Generated plot", kind: "land",
    metreW: r4(landBbox.w), metreH: r4(landBbox.h),
    footprint: landFp,
    targetAreaSqm: r4(landW * landH), // the true (untilted) plot area — the authoritative "deed" size to match
  });

  // BUILDING — its OWN metre anchor (decoupled from the land, like Skyline Slice E) so resizing the plot doesn't
  // inflate the tower. Centred in the land bbox, AXIS-ALIGNED (Slice 4 rotates it to hug a tilted plot). posM =
  // where its min-corner sits in the land bbox, in land metres.
  const bFp = metrePoly(rectCorners(bW, bH));
  const bPosX = (landBbox.w - bW) / 2, bPosY = (landBbox.h - bH) / 2;
  nodes.push({
    id: bNodeId, name: "Building", kind: "building", parentId: landId,
    footprint: bFp,
    posM: { x: r4(bPosX), y: r4(bPosY) },
    metreW: r4(bW), metreH: r4(bH),
    heightM: floors * 3.2,
  });

  // FLOORS — each fills the building plate (same footprint), stacked (same posM 0,0 inside the building). A floor's
  // own metres == the building's, so units nest correctly.
  for (let f = 1; f <= floors; f++) {
    const floorId = `${buildingId}-f${f}`;
    nodes.push({
      id: floorId, name: `Floor ${f}`, kind: "floor", parentId: bNodeId,
      footprint: metrePoly(rectCorners(bW, bH)),
      posM: { x: 0, y: 0 },
      metreW: r4(bW), metreH: r4(bH),
      heightM: 3.2,
    });
    // UNITS — a simple grid inside the floor plate. Each unit's own metre size ≈ its type sqm (square-ish cell),
    // positioned on a row/col lattice. posM = its min-corner in floor metres.
    const cols = Math.max(1, Math.ceil(Math.sqrt(perFloor)));
    const cellW = bW / cols;
    const rowsN = Math.ceil(perFloor / cols);
    const cellH = bH / rowsN;
    const matrixRow = genMatrixRow(f - 1, floors, perFloor);
    for (let i = 0; i < perFloor; i++) {
      const col = i % cols, row = Math.floor(i / cols);
      const type = matrixRow[i].typeKey, sub = matrixRow[i].subtypeKey;
      const sqm = TYPE_SQM[type] ?? 48;
      // size the drawn cell to the type sqm (square-ish), clamped to the lattice cell so units don't overlap
      const side = Math.min(Math.sqrt(sqm), cellW * 0.92, cellH * 0.92);
      const uFp = metrePoly(rectCorners(r4(side), r4(side)));
      const px = col * cellW + (cellW - side) / 2;
      const py = row * cellH + (cellH - side) / 2;
      const basePrice = (TYPE_SQM[type] ?? 48) * 4200 * (1 + f * 0.015); // synthetic $/m² curve, grades up by floor
      nodes.push({
        id: `${floorId}-u${i + 1}`, name: `${shortLabel(type)} ${sub.toUpperCase()} ${sqm}m²`, kind: "unit",
        parentId: floorId,
        footprint: uFp,
        posM: { x: r4(px), y: r4(py) },
        sqm,
        status: rand() < 0.75 ? "available" : "reserved-plus", // FAKE availability
        price: money(basePrice * (0.95 + rand() * 0.1)),   // FAKE price (deterministic from seed)
      });
    }
  }
  return nodes;
}

function bboxWH(pts: Pt[]): { w: number; h: number } {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function shortLabel(type: string): string {
  if (type === "studio") return "Studio";
  if (type === "shop") return "Shop";
  const m = type.match(/^(\d+)br$/);
  return m ? `${m[1]}BR` : type;
}

/** One floor's row of the matrix (same grading as genMatrix, extracted so geo + matrix agree). PURE. */
function genMatrixRow(fIdx: number, floors: number, perFloor: number): UnitCell[] {
  return Array.from({ length: perFloor }, (_, c) => {
    const type =
      fIdx === 0 ? "shop" :
      fIdx < floors * 0.4 ? (c % 2 === 0 ? "studio" : "1br") :
      fIdx < floors * 0.8 ? (c % 2 === 0 ? "1br" : "2br") :
      (c % 2 === 0 ? "2br" : "3br");
    const sub = (["a", "b", "c"] as const)[c % 3];
    return { typeKey: type, subtypeKey: sub };
  });
}

// ---------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------

/** Build a fresh, fully metre-native AuthoredProject (a developer + one development + one building with a complete
 *  land→building→floor→unit geo tree). PURE + deterministic (same opts → identical project). The geo tree is set
 *  directly (position-authoritative on load — no hydrate needed), so projectToPackAll uses it verbatim. */
export function generateBuilding(opts: GenerateBuildingOpts = {}): AuthoredProject {
  const floors = Math.max(1, Math.floor(opts.floors ?? DEFAULTS.floors));
  const perFloor = Math.max(1, Math.floor(opts.unitsPerFloor ?? DEFAULTS.unitsPerFloor));
  const landW = opts.landW ?? DEFAULTS.landW;
  const landH = opts.landH ?? DEFAULTS.landH;
  const bW = opts.buildingW ?? r4(landW * 0.6);
  const bH = opts.buildingH ?? r4(landH * 0.6);
  const plotRotationDeg = opts.plotRotationDeg ?? DEFAULTS.plotRotationDeg;
  const seed = opts.seed ?? DEFAULTS.seed;
  const name = opts.name ?? DEFAULTS.name;
  const rand = rng(seed);

  const buildingId = "building";
  const building: AuthoredBuilding = newBuilding({
    id: buildingId,
    name,
    type: "High Rise",
    tagline: `A generated ${floors}-floor test building (${plotRotationDeg ? `tilted ${plotRotationDeg}° plot` : "axis-aligned plot"}).`,
    floors,
    unitsPerFloor: perFloor,
    floorAreaM2: r4(bW * bH),
    types: defaultTypes(),
    matrix: genMatrix(floors, perFloor),
    reservationFeeUsd: 2000,
    bookingDepositUsd: 10000,
    maintenancePerSqmUsd: 1.5,
    transferFeePct: "6.30%",
    amenities: ["Pool", "Gym", "24h security"],
  });

  const geo = buildGeo(buildingId, floors, perFloor, landW, landH, bW, bH, plotRotationDeg, rand);

  return {
    v: 1,
    domain: "realestate",
    developer: { id: "test-developer", name: "Test Developer" },
    companies: [{ id: "test-co", name: "Test Co., Ltd" }],
    complexes: [{
      id: "test-development",
      name: "Test Development",
      companyId: "test-co",
      buildings: [building],
      land: { northBearingDeg: plotRotationDeg || undefined },
    }],
    terms: [],
    activeBuildingId: buildingId,
    geo,
  };
}
