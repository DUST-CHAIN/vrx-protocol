// §4d nested-geometry engine — the PURE spine behind the slice-2 drawing board.
//
// The model (lib/pack.ts GeoNode) is authored ONCE as a Russian-doll tree:
//   project → land → building → floor → unit → prop
// Every node's footprint rect is stored in FRACTIONS of its parent (clipper's 0..1 model). Real-world size
// enters at a single METRE ANCHOR on a node (its real width/height in metres); descendants inherit it by
// multiplying fractions down the chain. So:
//   - fractions keep nesting/clamping trivial and matrix-ready (clipper's clampRect verbatim), AND
//  - an object can still be CONSTRAINED to a real metre size (the call) — constrainToSqm adjusts the
//     fraction so the DERIVED m² hits a target, non-destructively.
//
// DERIVED-AND-ADJUSTED (D-): m²/price are AUTHORED TRUTH read from the real polygon × metre anchor —
// never from a per-view display tweak. This engine computes the truth; ViewOverride (pack.ts) is display only.
//
// Reuses clipper's bet (C:\Home\clipper\src\shared\regions.js): named factories seed valid nodes so a
// toolbar click OR the AI can place a node by NAME + params and CANNOT emit an impossible shape; clampRect
// keeps every child inside its parent. Generalized here from one frame to a tree (clampToParent).

import type { Camera, Footprint, GeoKind, GeoNode, Pack, Transform, UnitStatus } from "./pack";

export type { UnitStatus };

// ---------------------------------------------------------------------------
// Status labels + at-a-glance fill colours (the operator catalog grammar). The UnitStatus TYPE lives in pack.ts (the model);
// its drawing-board presentation (label/fill) lives here. Status is the primary fill channel — the operator catalog uses
// fillcolor for sale status (MM_ENGINE_AND_FACES §4b verified table).
// ---------------------------------------------------------------------------

export const UNIT_STATUSES: UnitStatus[] = [
  "available",
  "reserved-minus",
  "reserved-plus",
  "sale-minus",
  "sale-plus",
  "blocked",
  "resale",
];

/** Human label per status (the the operator catalog grammar: Resv− / Sale+ …). */
export const STATUS_LABEL: Record<UnitStatus, string> = {
  available: "Available",
  "reserved-minus": "Resv−",
  "reserved-plus": "Resv+",
  "sale-minus": "Sale−",
  "sale-plus": "Sale+",
  blocked: "Block",
  resale: "Resale",
};

/** At-a-glance fill (the primary channel — the operator catalog uses fillcolor for status). Readable in light + dark. */
export const STATUS_FILL: Record<UnitStatus, string> = {
  available: "#22c55e",
  "reserved-minus": "#eab308",
  "reserved-plus": "#f59e0b",
  "sale-minus": "#2dd4bf",
  "sale-plus": "#0d9488",
  blocked: "#94a3b8",
  resale: "#a855f7",
};

// ---------------------------------------------------------------------------
// Rect helpers — clipper's clampRect, generalized. A footprint rect is always 0..1 within its parent.
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const c01 = (n: number) => Math.max(0, Math.min(1, n));
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6; // lat/lng precision (~0.1 m) — r4 would snap to ~11 m

/** Clamp a rect to 0..1 and keep it from protruding past the parent edge (clipper's clampRect). */
export function clampRect(r: Rect): Rect {
  let x = c01(r.x);
  let y = c01(r.y);
  let w = c01(r.w);
  let h = c01(r.h);
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  // a degenerate (zero/negative) box is never useful — floor to a visible minimum
  w = Math.max(0.01, w);
  h = Math.max(0.01, h);
  if (x + w > 1) x = 1 - w;
  if (y + h > 1) y = 1 - h;
  return { x: r4(x), y: r4(y), w: r4(w), h: r4(h) };
}

/** The rect carried by a node's footprint (point → a tiny box; poly → its bounding box; rect → itself). */
export function footprintRect(fp: Footprint | undefined): Rect {
  if (!fp) return { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
  if (fp.shape === "rect") return fp.rect;
  if (fp.shape === "poly" && fp.points.length) {
    const xs = fp.points.map((p) => p.x);
    const ys = fp.points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  // a point → a small marker box so it's still grabbable on the canvas
  return { x: 0.46, y: 0.46, w: 0.08, h: 0.08 };
}

/** Scale a footprint's FRACTION coords about the parent-frame ORIGIN (0,0) by `f` — position AND extent (a rect's
 *  x/y/w/h, a poly's points). Leaves `pointsM` UNTOUCHED (the child's own metre shape is fixed; only its slot in the
 * parent frame moves). A point has no extent → unchanged. Used by INDEPENDENT ANCHORS (D-): when an anchor's
 *  metreW/H grow by k, each direct child's footprint is scaled by 1/k so its real size (fraction × anchor metres)
 *  stays invariant. PURE — returns a new footprint, never mutates. */
export function scaleFootprintAboutOrigin(fp: Footprint | undefined, f: number): Footprint | undefined {
  if (!fp || !(f > 0) || f === 1) return fp;
  if (fp.shape === "rect") {
    return { shape: "rect", rect: { x: r4(fp.rect.x * f), y: r4(fp.rect.y * f), w: r4(fp.rect.w * f), h: r4(fp.rect.h * f) } };
  }
  if (fp.shape === "poly") {
    return { ...fp, points: fp.points.map((p) => ({ x: r4(p.x * f), y: r4(p.y * f) })) };
  }
  return fp; // point — no extent
}

// ---------------------------------------------------------------------------
// Tree navigation over Pack.geo[] (a flat array with parentId — matches the stored shape).
// ---------------------------------------------------------------------------

export function geoNodes(pack: Pack): GeoNode[] {
  return pack.geo || [];
}

export function nodeById(pack: Pack, id: string | undefined): GeoNode | undefined {
  if (!id) return undefined;
  return geoNodes(pack).find((n) => n.id === id);
}

/** Is this node's GEOMETRY locked? (a locked shape can't be dragged/resized/vertex-edited.) PURE. */
export function isLocked(pack: Pack, id: string | undefined): boolean {
  return nodeById(pack, id)?.locked === true;
}

export function childrenOf(pack: Pack, parentId: string | undefined): GeoNode[] {
  return geoNodes(pack).filter((n) => n.parentId === parentId);
}

/** Root-level nodes (the land/project level — no parent). */
export function rootNodes(pack: Pack): GeoNode[] {
  const ids = new Set(geoNodes(pack).map((n) => n.id));
  return geoNodes(pack).filter((n) => !n.parentId || !ids.has(n.parentId));
}

/** Ancestor chain, nearest parent first (excludes the node itself). */
export function ancestorsOf(pack: Pack, id: string | undefined): GeoNode[] {
  const out: GeoNode[] = [];
  let cur = nodeById(pack, id);
  const guard = new Set<string>();
  while (cur?.parentId && !guard.has(cur.parentId)) {
    guard.add(cur.parentId);
    const parent = nodeById(pack, cur.parentId);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// METRE ANCHOR + derived m² — the "fractions nest, metres enter at an anchor" rule (#1).
// A node may carry a real-world metre size via metreW/metreH (added to pack.ts GeoNode). The nearest
// ancestor (or self) that declares a metre anchor supplies the real scale; a node's real width = that
// anchor's metres × the product of fraction-widths from the anchor down to the node. m² = realW × realH.
// ---------------------------------------------------------------------------

/** Find the nearest metre anchor at-or-above a node: {node, metreW, metreH}. Undefined if none set. */
export function metreAnchor(
  pack: Pack,
  id: string | undefined
): { anchor: GeoNode; metreW: number; metreH: number } | undefined {
  const self = nodeById(pack, id);
  const chain = self ? [self, ...ancestorsOf(pack, id)] : [];
  for (const n of chain) {
    if (n.metreW != null && n.metreH != null && n.metreW > 0 && n.metreH > 0) {
      return { anchor: n, metreW: n.metreW, metreH: n.metreH };
    }
  }
  return undefined;
}

/** Real-world width/height in METRES of a node, derived from the nearest anchor × nested fractions. */
export function realMetres(pack: Pack, id: string | undefined): { w: number; h: number } | undefined {
  const anchor = metreAnchor(pack, id);
  if (!anchor) return undefined;
  // fraction product from the anchor DOWN to the node (anchor itself contributes 1)
  let fw = 1;
  let fh = 1;
  let cur = nodeById(pack, id);
  const guard = new Set<string>();
  while (cur && cur.id !== anchor.anchor.id && !guard.has(cur.id)) {
    guard.add(cur.id);
    const fr = footprintRect(cur.footprint);
    fw *= fr.w;
    fh *= fr.h;
    cur = nodeById(pack, cur.parentId);
  }
  return { w: anchor.metreW * fw, h: anchor.metreH * fh };
}

/**  (B3 "the world") — pick a HUMAN metre step for the metric grid: the largest 1/2/5×10ⁿ value that still
 *  gives at least `minDivs` gridlines across `extentM` (the frame's larger real dimension). So a ~60 m frame →
 *  5 m squares, a ~600 m parcel → 50 m, a ~6 m room → 0.5 m. Returns undefined for a non-finite/≤0 extent (no
 *  metre anchor yet → no grid). PURE — the grid component multiplies the result by the metre→px scale. */
export function niceMetreStep(extentM: number | undefined, minDivs = 8): number | undefined {
  if (!extentM || !isFinite(extentM) || extentM <= 0) return undefined;
  const rough = extentM / Math.max(1, minDivs); // target step so ~minDivs squares fit
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow; // 1..10
  const nice = norm >= 5 ? 5 : norm >= 2 ? 2 : 1; // snap down to 1/2/5 so the step reads cleanly
  return nice * pow;
}

/**
 * AUTHORED-TRUTH m² of a node, from its real geometry × metre anchor (never a display tweak).
 * - rect/point footprint → bounding-box metres (realMetres: w × h).
 * - poly footprint       → TRUE polygon area (shoelace) in metres² — a drawn L/T shape is less than its bbox.
 * Returns undefined when no metre anchor is set anywhere above — m² is simply not-yet-known, not zero.
 */
export function deriveSqm(pack: Pack, id: string | undefined): number | undefined {
  const node = nodeById(pack, id);
  // (the "7 units = 5,110 m²?!" bug) A UNIT's area is its AUTHORED/DECLARED size, NOT the schematic
  // grid-cell geometry. A placed unit sits in a placeholder box (e.g. 0.33×0.33 of the plate ≈ 731 m²) that says
  // NOTHING about the real unit size (40/48/56 m²) — the grid is LAYOUT (where the box is), not SIZE. The declared
  // size is the sales/legal truth (the caption already shows it); geometry is only a fallback for a hand-drawn unit
  // with no declared size. Order: subtype's locked size (the binding area every unit of the subtype shares) →
  // node.sqm → geometry. (Floors/buildings/land keep geometric derivation — their size genuinely IS their shape.)
  if (node?.kind === "unit") {
    const declared = subtypeLockedSqm(pack, id) ?? node.sqm;
    if (declared != null && declared > 0) return r4(declared);
  }
  const fp = effectiveFootprint(pack, node);
  if (fp?.shape === "poly" && fp.points.length >= 3) {
    // (D- metre-native step 4 — MEASURE reads metres) Area comes from the metre-native shape
    // (`toMetrePoly`), the aspect-true primitive we're consolidating MEASURE onto, NOT the 0..1 self-norm
    // frame. `toMetrePoly` and the legacy `polyMetrePoints` give the SAME shape+dimensions (own-frame vs
    // parent-frame metres differ only by a translation, which shoelace area is invariant to) — so this is
    // behaviour-invisible on healthy data, but it reads the representation step 5 will store and step 6 keeps.
    const mp = toMetrePoly(pack, id);
    if (!mp) return undefined;
    return r4(shoelaceArea(mp.pointsM));
  }
  const m = realMetres(pack, id);
  if (!m) return undefined;
  return r4(m.w * m.h);
}

// ---------------------------------------------------------------------------
// SUBTYPE-PLAN resolution. A placed unit node may carry `subtypeRef` {typeKey, subtypeKey} — the STABLE
// link to its unit SUBTYPE. The subtype owns the canonical UnitPlan (shared by every placed unit of it), so a
// node resolves its SHAPE from the subtype's plan, not from a per-node copy ("plans belong to the VARIATION",
// FLOORPLAN_ENGINE_DESIGN.md:126). Pure + absent-safe: no subtypeRef, or no plan on the subtype → the node's
// own footprint is used verbatim (the behaviour, so every legacy node renders exactly as before).
// Resolution is a global search of pack.buildings[].unitTypes[].subtypes[] by the stable {typeKey,subtypeKey}
// pair (MM packs are single-building; a cross-building key collision would just mean the same subtype label).
// ---------------------------------------------------------------------------

/** The subtype a node points at (if any), or undefined. Searches all buildings' unit types by the STABLE pair. */
export function subtypeForNode(
  pack: Pack,
  node: GeoNode | undefined
): import("./ai-build").AiUnitSubtype | undefined {
  const ref = node?.subtypeRef;
  if (!ref) return undefined;
  for (const b of pack.buildings || []) {
    const t = (b.unitTypes || []).find((ut) => ut.key === ref.typeKey);
    const s = t?.subtypes?.find((x) => x.key === ref.subtypeKey);
    if (s) return s;
  }
  return undefined;
}

/** The canonical shared PLAN for a node's subtype (if the subtype declares one). PURE. */
export function resolvePlan(pack: Pack, node: GeoNode | undefined): import("./pack").UnitPlan | undefined {
  return subtypeForNode(pack, node)?.plan;
}

/** (D-) Does a poly-shape edit of this node write ONLY the subtype's shared plan, leaving the node's own
 *  footprint (its on-floor placement) untouched? TRUE once the node's subtype ALREADY has a shared plan: the focus
 *  editor shows + edits that plan (effectiveFootprint), so its points are in the PLAN's frame — writing them onto the
 * own footprint would clobber the unit's placement (D- "shape shared / position own"). FALSE when there is no
 *  plan yet (the first author seeds the plan FROM the own footprint) or the node isn't subtype-bound. PURE. */
export function editsSharedPlanOnly(pack: Pack, node: GeoNode | undefined): boolean {
  return resolvePlan(pack, node) != null;
}

/** (D-) MARKERS-FIRST LEVEL VIEW decision: on the level overview, should this unit draw as its real
 *  SHAPE (vs a marker/pin)? A unit with a shape draws as a SHAPE iff it has a real poly AND it's either been
 *  APPROVED into the plan or its `representation` override forces "shape"; the override can also force a shape back
 *  to a marker. Default (no flags) = marker, so an imported building reads as clean pins, not a wall of overlapping
 *  room fills. `hasPoly` = does renderFootprint(pack, node) resolve a poly (own or shared plan). PURE. Non-units are
 *  out of scope (they always draw their own footprint); callers gate this on node.kind === "unit". */
export function unitShownAsShape(node: GeoNode | undefined, hasPoly: boolean): boolean {
  if (!hasPoly) return false;
  if (node?.representation === "shape") return true;
  if (node?.representation === "marker") return false;
  return node?.approved === true;
}

/** Is a point inside a polygon? Standard ray-casting (even-odd). Points on the boundary count as inside
 *  (illustration-grade — we're fitting plans, not doing exact CAD). PURE. Works in any consistent 2-D space. */
export function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    const intersects = (a.y > pt.y) !== (b.y > pt.y) &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Does `inner` sit inside `outer`? Illustration-grade (matching the rest of the engine, — plausible, not
 *  survey-exact): we sample the inner polygon's VERTICES and its EDGE MIDPOINTS and require them all inside
 *  `outer` (with a small tolerance so a shape resting exactly on the boundary still counts as contained). This
 *  catches a unit pushed outside a reshaped floor without a full polygon-clipping solver. PURE. */
export function polyInPoly(inner: Pt[], outer: Pt[], tol = 0.01): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  // grow `outer` slightly about its centroid so boundary-resting points count as inside (tolerance)
  const grown = tol > 0 ? scalePolyAboutCentroid(outer, 1 + tol) : outer;
  const samples: Pt[] = [];
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i], b = inner[(i + 1) % inner.length];
    samples.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return samples.every((p) => pointInPoly(p, grown));
}

/** Scale a polygon's points by `factor` about their CENTROID (mean of points), clamped to 0..1. factor 0.8 =
 * an inset copy of the same shape (the first child starts as the parent plate, 20% smaller, so
 *  "how the inside level fits" is obvious). PURE; returns [] for < 3 points. */
export function scalePolyAboutCentroid(points: Pt[], factor: number): Pt[] {
  if (points.length < 3) return [];
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.map((p) => ({ x: c01(cx + (p.x - cx) * factor), y: c01(cy + (p.y - cy) * factor) }));
}

/** (kill-the-bbox arc Slice 3) `ancestorBackdropPoly` + `childInverseBboxStep` DELETED here — the
 *  inverse-bbox render path they fed (`ancestorLayers`) is superseded by the metre-native `ancestorLayersMetric`
 *  (Slice 1), now the SOLE backdrop path in Canvas. Metre space makes parent↔child a pure translation, so a
 * rotated/irregular ancestor can't distort the backdrop (the finding). See MM_KILL_BBOX_SLICE3_CUTPLAN_S303. */

/** One ANCESTOR layer to draw behind the focused node — its outline in the focused node's own 0..1 frame + its kind
 * (so Canvas colours it by the kind grammar: land=blue, building=green, floor=yellow). cumulative-layers. */
export interface AncestorLayer { id: string; kind: GeoKind; name: string; points: Pt[] }

/** (kill-the-bbox arc Slice 1 — the metre-native backdrop) The ancestor chain expressed in the focused node's
 *  own 0..1 METRE frame, WITHOUT the bbox self-normalization that `ancestorLayers` uses. The insight: in real-metre
 *  space, a parent↔child relationship is a PURE TRANSLATION (metres are absolute — a child's own metre shape doesn't
 *  rescale to its parent's bbox; it just sits at a metre offset). So each ancestor's outline = its own metre points
 *  (`toMetrePoly`, re-origined to its own min-corner) shifted by the cumulative metre offset from that ancestor DOWN
 *  to the focus, then divided by the focus's metre extent to land in the focus's 0..1 frame (which the Canvas metre
 * frame depicts 1:1). No inverse-bbox step → a rotated/irregular ancestor can't distort the backdrop (the
 * finding). Returns nearest-first. Returns [] when any level lacks metres — Slice 3 made this the SOLE
 *  backdrop path (the legacy bbox fallback is gone; the load-time hydrate guarantees every level carries metres,
 *  so [] now means only a pathological metre-less tree → no backdrop). PURE — render-only, never written.
 *
 *  Metre offset of a child C inside parent P: C's own footprint occupies bbox [cMin..] in P's self-normalized frame,
 *  so C's min-corner sits at `cMin × P.metreExtent` metres from P's min-corner. Walking focus→…→ancestor, we sum
 *  these offsets (each in the SAME metre units) to get where the ancestor's origin sits relative to the focus's. */
/** (kill-the-bbox arc Slice 2) A node's POSITION inside its parent, in PARENT metres — the metres from the
 *  parent's own min-corner to the node's footprint min-corner. STORED `posM` is the source of truth (authoring writes
 * it, D-); absent → DERIVE it from the 0..1 bbox fraction × the parent's metre extent (`cMin × parentMetreExtent`
 *  — the exact formula the self-norm frame implied), so a legacy/un-migrated project behaves EXACTLY as before. Returns
 *  undefined for a root node (no parent) or when the parent lacks metres / the node has no ≥3-corner footprint. PURE. */
export function nodePosM(pack: Pack, id: string | undefined): { x: number; y: number } | undefined {
  const node = nodeById(pack, id);
  if (!node?.parentId) return undefined;
  if (node.posM && Number.isFinite(node.posM.x) && Number.isFinite(node.posM.y)) return node.posM; // stored wins
  return derivePosM(pack, id); // legacy/un-migrated → derive from the 0..1 fraction (identical to pre-Slice-2)
}

/** (Slice 2) ALWAYS derive a node's parent-metre position from its 0..1 bbox fraction × the parent metre extent
 *  — IGNORING any stored `posM`. This is the one-way derive used BOTH as the legacy fallback in `nodePosM` AND as the
 *  stamp source when authoring writes a fresh `posM` (compute-from-the-new-points, never re-read a stale stored value —
 *  the same discipline footprintWithStoredMetres uses for pointsM). Returns undefined for a root / no-metre parent /
 *  no-area footprint. PURE. */
export function derivePosM(pack: Pack, id: string | undefined): { x: number; y: number } | undefined {
  const node = nodeById(pack, id);
  if (!node?.parentId) return undefined;
  const parentM = toMetrePoly(pack, node.parentId);
  if (!parentM || !(parentM.wM > 0) || !(parentM.hM > 0)) return undefined;
  const cfp = effectiveFootprint(pack, node);
  const cpts = cfp?.shape === "poly" ? cfp.points
    : cfp?.shape === "rect"
      ? (() => { const { x, y, w, h } = cfp.rect; return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]; })()
      : undefined;
  if (!cpts || cpts.length < 3) return undefined;
  const cMinX = Math.min(...cpts.map((p) => p.x)), cMinY = Math.min(...cpts.map((p) => p.y));
  return { x: r4(cMinX * parentM.wM), y: r4(cMinY * parentM.hM) };
}

export function ancestorLayersMetric(pack: Pack, focusId: string | undefined): AncestorLayer[] {
  const focus = nodeById(pack, focusId);
  if (!focus?.parentId) return [];
  const focusM = toMetrePoly(pack, focus.id);
  if (!focusM || !(focusM.wM > 0) || !(focusM.hM > 0)) return [];
  const out: AncestorLayer[] = [];
  // cumulative metre offset of the CURRENT child's min-corner, expressed in the FOCUS's metre frame (0,0 = focus min-
  // corner). Start at the focus (offset 0). Each step up adds where the child sat inside its parent, in parent metres.
  let offX = 0, offY = 0;
  let childId: string | undefined = focus.id;
  const guard = new Set<string>();
  while (childId && !guard.has(childId)) {
    guard.add(childId);
    const child = nodeById(pack, childId);
    if (!child?.parentId) break;
    const parent = nodeById(pack, child.parentId);
    if (!parent) break;
    const parentM = toMetrePoly(pack, parent.id);
    if (!parentM || !(parentM.wM > 0) || !(parentM.hM > 0)) return []; // a level without metres → bail to legacy
    // where the child's min-corner sits inside the parent, in PARENT metres (Slice 2: STORED posM, else the derived
    // 0..1-fraction × parent-metre-extent — nodePosM is the one seam, so authoring a real posM moves the backdrop too).
    const childPos = nodePosM(pack, child.id);
    if (!childPos) return [];
    // the parent's min-corner, in the FOCUS frame, is the child's min-corner MINUS the child's offset inside the parent.
    offX -= childPos.x;
    offY -= childPos.y;
    // the parent's outline, in its OWN metre frame, shifted by (offX,offY) into the focus frame, then → focus 0..1.
    out.push({
      id: parent.id, kind: parent.kind, name: parent.name,
      points: parentM.pointsM.map((p) => ({ x: (p.x + offX) / focusM.wM, y: (p.y + offY) / focusM.hM })),
    });
    childId = child.parentId;
  }
  return out;
}

/** (kill-the-bbox arc Slice 3) `ancestorLayers` (the legacy self-norm cumulative ancestor stack) DELETED —
 *  `ancestorLayersMetric` above is the sole backdrop path. It was only a Canvas fallback for metre-less levels;
 *  the Slice-3 load-time hydrate (`hydrateGeoMetres` stamps pointsM + posM) makes the metric path always resolve. */

/** The footprint a node should MEASURE by: the subtype's shared plan polygon when present, else the node's own
 *  footprint (back-compat). This is the ONE place shape-OWNERSHIP is decided. PURE. ⚠ For RENDERING a unit on a
 *  floor use `renderFootprint` instead — the shared plan carries SHAPE, but each unit keeps its OWN position. */
export function effectiveFootprint(pack: Pack, node: GeoNode | undefined): Footprint | undefined {
  const plan = resolvePlan(pack, node);
  if (plan) return plan.footprint;
  return node?.footprint;
}

/** (the shared-shape/own-position model, D-) The footprint a node should RENDER by on its parent's
 *  canvas. A subtype's shared plan contributes the OUTLINE (shape), but every unit of that subtype keeps its OWN
 *  position + size on the floor — "same unit type, different rooms". So: take the plan's SELF-NORMALIZED shape and
 *  place it into THIS node's own footprint rect (its pin/placed location + size). Units with no plan, and non-units,
 *  render their own footprint unchanged. This is why resolving the plan in the renderer does NOT make siblings
 *  overlap at the authored unit's spot (the bug that would have appeared with a naive effectiveFootprint render). PURE. */
export function renderFootprint(pack: Pack, node: GeoNode | undefined): Footprint | undefined {
  const plan = resolvePlan(pack, node);
  // (kill-the-bbox arc Slice 4) ROTATION IS A FIRST-CLASS NODE TRANSFORM. A node with NO shared plan
  // (building/floor/land, or an unbound unit) renders its OWN footprint — but still honours `rotationDeg` now,
  // so a building can be rotated to HUG a tilted plot (the Skyline deed case that opened the arc). Before
  // this early-return dropped the rotation for every non-plan node; now it applies the same metre-space rigid
  // rotate used for placed units (no plan to place into — we rotate the own footprint's own points directly).
  if (!plan || plan.footprint.shape !== "poly") {
    const deg = node?.rotationDeg || 0;
    const ownPts = footprintPolyPoints(node?.footprint);
    if (!deg || !ownPts || ownPts.length < 3) return node?.footprint;
    const rotated = rotatePolyInParentMetres(pack, node?.parentId, ownPts, deg);
    return { shape: "poly", points: rotated };
  }
  const selfNorm = footprintSelfNorm(plan.footprint); // the shared OUTLINE, 0..1 in its own bbox
  if (!selfNorm || selfNorm.length < 3) return node?.footprint;
  const r = footprintRect(node?.footprint); // THIS unit's own placed position + size on the floor
  const points = selfNorm.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
  //  apply the unit's own ON-FLOOR rotation about its rect centre — per-instance pose, shared shape unchanged.
  const deg = node?.rotationDeg || 0;
  if (deg) {
    // A ROTATED shape is RIGID — do NOT clamp its vertices to [0,1] (per-coordinate clamping would SHEAR a corner
    // the moment a rotation pushes it past the floor edge — the skew caught). Overflow = move it.
    return { shape: "poly", points: rotatePolyInParentMetres(pack, node?.parentId, points, deg) };
  }
  // Unrotated: the shape sits in its own placement rect; clamp to the frame (back-compat with the path).
  return { shape: "poly", points: points.map((p) => ({ x: c01(p.x), y: c01(p.y) })) };
}

/** A footprint's points as a flat poly (rect → its 4 corners; poly → its points; else undefined). The points are
 *  in the PARENT's own 0..1 frame (the frame the canvas renders into). PURE. */
function footprintPolyPoints(fp: Footprint | undefined): Pt[] | undefined {
  if (!fp) return undefined;
  if (fp.shape === "rect") { const { x, y, w, h } = fp.rect; return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]; }
  if (fp.shape === "poly" && fp.points.length >= 3) return fp.points;
  return undefined;
}

/** Rotate poly `points` (in the parent's 0..1 frame) by `deg` about their OWN centroid-bbox centre, RIGIDLY IN
 * METRE SPACE (anti-skew, generalized). The parent's 0..1 frame is anisotropic (1 x-unit ≠ 1 y-unit
 *  metres unless the parent is square), so rotating fraction coords directly SHEARS the shape. Scale x/y by the
 *  parent's real metre extent → isotropic → rotate (rigid, area-preserved) → scale back. Falls back to a plain
 *  fraction-space rotate when the parent's metres are unknown (best effort; exact for a square parent). The centre
 *  is the shape's own rect-bbox centre, so rotation is about the shape itself (building-hugs-plot pivots in place).
 *  Returns UNCLAMPED points (a rigid rotation can push a corner outside the frame; clamping would deform it). PURE. */
function rotatePolyInParentMetres(pack: Pack, parentId: string | undefined, points: Pt[], deg: number): Pt[] {
  if (!deg) return points;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const fm = realMetres(pack, parentId); // the parent's real metre w/h = the x:y scale of this frame
  if (fm && fm.w > 0 && fm.h > 0) {
    const toM = points.map((p) => ({ x: (p.x - cx) * fm.w, y: (p.y - cy) * fm.h })); // centre-relative metres
    const rot = rotatePointsAboutCentre(toM, deg, { x: 0, y: 0 });                    // rigid rotate in metres
    return rot.map((p) => ({ x: cx + p.x / fm.w, y: cy + p.y / fm.h }));              // back to fraction space
  }
  return rotatePointsAboutCentre(points, deg, { x: cx, y: cy });
}

/** Rotate points by `deg` (clockwise in SVG's y-down space) about `centre`. deg=0 is identity. PURE. The clamp to
 *  0..1 is left to the caller (a rotation can push a corner outside the floor frame; renderFootprint clamps). */
export function rotatePointsAboutCentre(points: Pt[], deg: number, centre: Pt): Pt[] {
  if (!deg) return points;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return points.map((p) => {
    const dx = p.x - centre.x, dy = p.y - centre.y;
    return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
  });
}

/** A footprint's points, NORMALIZED to its own bounding box (→ 0..1 in its own frame). A poly is normalized by
 *  its bbox (same as RefFrame draws it); a rect becomes the unit square; a point → undefined. This is the frame
 *  a floor's CHILDREN live in (their 0..1 footprints are relative to the floor's interior), so it's the space to
 *  test containment in. PURE. */
export function footprintSelfNorm(fp: Footprint | undefined): Pt[] | undefined {
  if (!fp) return undefined;
  if (fp.shape === "rect") return [ { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 } ];
  if (fp.shape !== "poly" || fp.points.length < 3) return undefined;
  const xs = fp.points.map((p) => p.x), ys = fp.points.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(1e-6, Math.max(...xs) - minX), h = Math.max(1e-6, Math.max(...ys) - minY);
  return fp.points.map((p) => ({ x: (p.x - minX) / w, y: (p.y - minY) / h }));
}

/** Would every child UNIT of `floorId` still fit inside the floor if its footprint were `proposed`? (#3/#4
 *  containment — a locked floor "can only be enlarged, must still hold all units".) Children's 0..1 footprints are
 *  relative to the floor interior, so we test them against the PROPOSED floor shape normalized to its own bbox.
 *  A rect proposal is the full 0..1 frame → everything fits (enlarging to a rect never orphans). Only UNIT children
 *  are checked (props/furniture are decoration). Returns true (nothing to violate) when there are no unit children.
 * PURE — used by useGeo to REJECT a floor shrink that would push a unit outside (the "reject the shrink"). */
export function unitsFitInFloorShape(pack: Pack, floorId: string, proposed: Footprint): boolean {
  const outer = footprintSelfNorm(proposed);
  if (!outer) return true; // can't resolve a shape → don't block
  const units = childrenOf(pack, floorId).filter((n) => n.kind === "unit");
  for (const u of units) {
    const inner = footprintPointsInParentFrame(effectiveFootprint(pack, u));
    if (inner && !polyInPoly(inner, outer)) return false;
  }
  return true;
}

/** A node's footprint as its points IN ITS PARENT'S FRAME (its real 0..1 position, NOT self-normalized — where
 *  the unit sits within the floor is exactly what containment tests). A rect → its 4 corners; a poly → its points.
 *  PURE. */
function footprintPointsInParentFrame(fp: Footprint | undefined): Pt[] | undefined {
  if (!fp) return undefined;
  if (fp.shape === "rect") {
    const r = fp.rect;
    return [ { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h } ];
  }
  if (fp.shape === "poly" && fp.points.length >= 3) return fp.points;
  return undefined;
}

/** Write a poly footprint onto a node's SUBTYPE as its shared plan (slice 4) — so editing ONE unit's
 *  polygon authors the plan EVERY unit of that subtype renders (effectiveFootprint). Returns a NEW pack with the
 *  matching subtype's `plan.footprint` set (creating `plan` if absent, preserving its markers/backdrop). A no-op
 *  (returns the same pack) if the node has no subtypeRef or the footprint isn't a poly. PURE. The subtype plan is
 *  the single source of truth for the shape; the edited node's own footprint is just the live editing surface. */
export function writeSubtypePlanFootprint(
  pack: Pack,
  node: GeoNode | undefined,
  footprint: Footprint | undefined
): Pack {
  if (footprint?.shape !== "poly") return pack;
  return patchSubtypePlan(pack, node, { footprint });
}

/** Patch ANY field(s) of a node's SUBTYPE plan (slice 5 — markers/backdrop share the exact write-back the
 *  footprint uses, so authoring doors/windows on one unit applies to EVERY unit of the subtype). Merges `patch`
 *  onto the existing plan (creating it if absent, preserving the other fields — footprint/markers/backdrop).
 *  Returns a NEW pack, or the same pack if the node has no subtypeRef / matches no subtype. PURE.
 *  ⚠ The plan REQUIRES a footprint; a patch with no footprint onto a plan-less subtype is a no-op (nothing to
 *  attach markers to yet — author the shape first). */
export function writeSubtypePlanPatch(
  pack: Pack,
  node: GeoNode | undefined,
  patch: Partial<import("./pack").UnitPlan>
): Pack {
  return patchSubtypePlan(pack, node, patch);
}

/** Resolve the DURABLE write target for a subtype-plan edit: the (projected) building id + the stable type/subtype
 *  keys + the MERGED plan (current plan ⊕ patch). The store persists via this target (setSubtypePlan) instead of
 * setPack, which only carries geo (persistence fix). Returns undefined if the node isn't subtype-bound, no
 *  building ancestor is found, or the merge has no footprint yet (a plan needs a shape before markers/backdrop).
 *  The building id = the building geo-node id with its `-bld` suffix stripped (the projected pack building id). PURE. */
export function subtypePlanTarget(
  pack: Pack,
  node: GeoNode | undefined,
  patch: Partial<import("./pack").UnitPlan>
): { buildingId: string; typeKey: string; subtypeKey: string; plan: import("./pack").UnitPlan } | undefined {
  const ref = node?.subtypeRef;
  if (!ref) return undefined;
  const bldNode = node && [node, ...ancestorsOf(pack, node.id)].find((n) => n.kind === "building");
  if (!bldNode) return undefined;
  const buildingId = bldNode.id.replace(/-bld$/, "");
  const cur = subtypeForNode(pack, node)?.plan;
  const merged = { ...(cur || {}), ...patch };
  if (!merged.footprint) return undefined; // a plan needs a footprint first (markers/backdrop key off a shape)
  return { buildingId, typeKey: ref.typeKey, subtypeKey: ref.subtypeKey, plan: merged as import("./pack").UnitPlan };
}

function patchSubtypePlan(
  pack: Pack,
  node: GeoNode | undefined,
  patch: Partial<import("./pack").UnitPlan>
): Pack {
  const ref = node?.subtypeRef;
  if (!ref) return pack;
  let changed = false;
  const buildings = (pack.buildings || []).map((b) => {
    if (!b.unitTypes?.some((t) => t.key === ref.typeKey)) return b;
    const unitTypes = b.unitTypes.map((t) => {
      if (t.key !== ref.typeKey || !t.subtypes) return t;
      const subtypes = t.subtypes.map((s) => {
        if (s.key !== ref.subtypeKey) return s;
        const merged = { ...(s.plan || {}), ...patch };
        // a plan is only valid WITH a footprint — don't create a footprint-less plan (markers need a shape first)
        if (!merged.footprint) return s;
        changed = true;
        return { ...s, plan: merged as import("./pack").UnitPlan };
      });
      return { ...t, subtypes };
    });
    return { ...b, unitTypes };
  });
  return changed ? { ...pack, buildings } : pack;
}

/** The DECLARED size a node is LOCKED to (its subtype's sqm — the binding legal area), or undefined if the node
 * isn't subtype-bound to a fixed size. item #1: a unit can't be free-resized off its subtype area —
 *  every unit of a subtype shares one declared size. PURE. (A node with no subtypeRef / subtype-without-sqm is
 *  free, as before.) Used by useGeo.moveResize to re-constrain the size after a drag (position stays free). */
export function subtypeLockedSqm(pack: Pack, id: string | undefined): number | undefined {
  const node = nodeById(pack, id);
  const sub = subtypeForNode(pack, node);
  return sub && sub.sqm != null && sub.sqm > 0 ? sub.sqm : undefined;
}

/** Re-scale a rect (keeping its TOP-LEFT and ASPECT) so its DERIVED m² hits `targetSqm` under the node's metre
 *  anchor. The position the user dragged to is honoured; only the size snaps to the declared area. Returns the
 *  input unchanged if there's no metre anchor or target ≤ 0. PURE — mirrors constrainToSqm but anchored at the
 *  top-left (drag intent), not the centre. */
export function constrainRectSqmAtOrigin(pack: Pack, id: string, rect: Rect, targetSqm: number): Rect {
  if (!(targetSqm > 0)) return rect;
  const anchor = metreAnchor(pack, id);
  if (!anchor) return rect;
  // real metres-per-fraction at this node = anchor metres × (fraction product of ANCESTORS, excluding self size).
  // realMetres(self) folds in the node's own footprint; we want the parent frame's metres, so divide it back out.
  const self = nodeById(pack, id);
  const selfFr = footprintRect(self?.footprint);
  const selfM = realMetres(pack, id);
  if (!selfM || selfFr.w <= 0 || selfFr.h <= 0) return rect;
  const parentMPerFracW = selfM.w / selfFr.w; // metres per 1.0 of x-fraction in this node's parent frame
  const parentMPerFracH = selfM.h / selfFr.h;
  const curSqm = rect.w * parentMPerFracW * rect.h * parentMPerFracH;
  if (!(curSqm > 0)) return rect;
  const s = Math.sqrt(targetSqm / curSqm);
  return { x: rect.x, y: rect.y, w: rect.w * s, h: rect.h * s };
}

// ---------------------------------------------------------------------------
// POLYGON geometry (slice 2.x — the constraint-based footprint editor, illustration-grade: plausible, not
// survey-exact). Points live in the footprint as FRACTIONS of the PARENT frame (same space as a
// rect, so nesting/clamp stay uniform); the editor works in METRE space via the parent's metre extent, then
// writes fractions back. No closure solver — editing slides the far vertex along the edge; the user FREEZES
// vertices/edges to hold the parts they like (right-click), and parallel+equal edges auto-link to scale together.
// ---------------------------------------------------------------------------

export interface Pt {
  x: number;
  y: number;
}

/** |signed area| of a closed polygon by the shoelace formula (works in any units → that unit²). */
export function shoelaceArea(pts: Pt[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/**
 * The polygon's points in METRES, mapped through the PARENT frame's real metre extent. A point at
 * parent-fraction (fx,fy) sits at (fx×parentW, fy×parentH) metres. Returns undefined with no metre anchor.
 */
export function polyMetrePoints(pack: Pack, id: string | undefined): Pt[] | undefined {
  const node = nodeById(pack, id);
  // (D-) a subtype-bound unit's SHAPE is the shared plan (effectiveFootprint), not its own footprint —
  // which is now its on-floor placement rect, not a poly. Measure the plan's edges so the focus editor's metre
  // labels/edge-length edit stay live on bound units after the plan-only write. Non-bound → the own footprint.
  const src = effectiveFootprint(pack, node);
  if (src?.shape !== "poly") return undefined;
  const parentM = node?.parentId ? realMetres(pack, node.parentId) : metreAnchor(pack, id) && { w: metreAnchor(pack, id)!.metreW, h: metreAnchor(pack, id)!.metreH };
  if (!parentM) return undefined;
  return src.points.map((p) => ({ x: r4(p.x * parentM.w), y: r4(p.y * parentM.h) }));
}

// ---------------------------------------------------------------------------
// METRE-NATIVE representation (D- the metre-native refactor — STEP 1).
//
// The root disease (the design docs): a footprint is stored 0..1 PER-AXIS-bbox-normalized
// (footprintSelfNorm), with the real size held SEPARATELY as a metre anchor up the tree. Per-axis normalization
// DESTROYS the real aspect ratio inside the points — a 50×38 m shape and a 38×50 m shape have IDENTICAL normalized
// points; the proportion lives only in metreW/H. Any op reading points without the exact matching metre context
// works in a distorted space (the rotation-skew disease, the map⇄studio drift, corner-drag badness).
//
// The target: ONE shape in REAL METRES. `toMetrePoly` resolves a node's shape into its OWN LOCAL METRE FRAME —
// points are metres from the node's own min-corner origin, aspect TRUE by construction (the metres ARE in the
// points; no separate anchor needed). `fromMetrePoly` is the exact inverse back to the stored self-normalized poly
// + its metre extent. This pair is the lossless bridge between the two worlds; later steps migrate consumers onto
// the metre side one seam at a time. Step 1 adds them ALONGSIDE the old frame and proves the round-trip lossless —
// NOTHING is ripped out, no consumer is touched yet.
//
// Contract (what "lossless" means here): the metre poly preserves a node's SHAPE and REAL DIMENSIONS exactly.
// `fromMetrePoly(toMetrePoly(node))` recovers the self-normalized shape (bit-identical up to r4) and the metre
// extent (w,h). It deliberately does NOT round-trip the node's POSITION-in-parent — placement lives in the own
// footprint rect and is a separate concern (the map-bridge isometry, step 3). This is the honest invariant to
// prove on the cheap one-node slice before migrating the 18 consumers.
// ---------------------------------------------------------------------------

/** A shape in its OWN LOCAL METRE FRAME: `pointsM` = metres from the node's own min-corner origin (aspect true),
 *  with `wM`×`hM` = the metre bbox span (== the node's realMetres). This is the metre-native representation. */
export interface MetrePoly {
  pointsM: Pt[]; // metres from the shape's own min-corner (0,0); aspect-true (unlike the 0..1 self-norm frame)
  wM: number; // metre bbox width  (== realMetres(node).w)
  hM: number; // metre bbox height (== realMetres(node).h)
}

/**
 * Resolve a node's effective shape into its OWN LOCAL METRE FRAME (D- step 1). Self-normalized outline ×
 * the node's REAL metre extent → metre points with aspect restored. A rect → its 4 metre corners; a poly → its
 * metre vertices; a point (or a node with no metre anchor) → undefined (metres not-yet-known, same as deriveSqm).
 * Reads the EFFECTIVE footprint (subtype-shared plan for a bound unit, D-), consistent with polyMetrePoints.
 * PURE. The forward half of the lossless bridge; `fromMetrePoly` is its inverse.
 */
export function toMetrePoly(pack: Pack, id: string | undefined): MetrePoly | undefined {
  const node = nodeById(pack, id);
  const efp = effectiveFootprint(pack, node);
  // (D- step 5) STORED metres win: if the effective footprint already carries metre-native vertices, they ARE
  // the source of truth — re-origin them to the shape's own min-corner (the MetrePoly contract) and read the extent
  // straight from the points (no anchor walk, aspect true by construction). Legacy blobs have no pointsM → derive.
  if (efp?.shape === "poly" && efp.pointsM && efp.pointsM.length >= 3 && efp.pointsM.length === efp.points.length) {
    const xs = efp.pointsM.map((p) => p.x), ys = efp.pointsM.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const wM = Math.max(...xs) - minX, hM = Math.max(...ys) - minY;
    if (wM > 0 && hM > 0) {
      return { pointsM: efp.pointsM.map((p) => ({ x: r4(p.x - minX), y: r4(p.y - minY) })), wM: r4(wM), hM: r4(hM) };
    }
    // a degenerate stored poly falls through to the derived path (never silently return a bad shape)
  }
  const self = footprintSelfNorm(efp); // 0..1 in the shape's own bbox (aspect destroyed)
  if (!self || self.length < 3) return undefined;
  const m = realMetres(pack, id); // the node's OWN real metre extent — restores the aspect the self-norm dropped
  if (!m || !(m.w > 0) || !(m.h > 0)) return undefined;
  const pointsM = self.map((p) => ({ x: r4(p.x * m.w), y: r4(p.y * m.h) }));
  return { pointsM, wM: r4(m.w), hM: r4(m.h) };
}

/**
 * The inverse of `toMetrePoly` (D- step 1): a metre poly → the stored self-normalized poly footprint + its
 * metre extent. Re-derives the bbox span from the metre points (wM/hM) and divides back to 0..1 — so
 * `fromMetrePoly(toMetrePoly(node))` recovers the SHAPE and DIMENSIONS exactly (not the in-parent position; see
 * the header). Returns undefined for < 3 points or a degenerate (zero-span) poly. PURE.
 */
export function fromMetrePoly(mp: MetrePoly | undefined): { footprint: Extract<Footprint, { shape: "poly" }>; wM: number; hM: number } | undefined {
  if (!mp || mp.pointsM.length < 3) return undefined;
  const xs = mp.pointsM.map((p) => p.x), ys = mp.pointsM.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const wM = Math.max(...xs) - minX, hM = Math.max(...ys) - minY;
  if (!(wM > 0) || !(hM > 0)) return undefined;
  const points = mp.pointsM.map((p) => ({ x: r4((p.x - minX) / wM), y: r4((p.y - minY) / hM) }));
  // (D- step 5) emit BOTH representations: the 0..1 legacy view (points) AND the metre-native source of truth
  // (pointsM, re-origined to the shape's own min-corner). A footprint built via fromMetrePoly is thus born
  // metre-native, so toMetrePoly round-trips through the STORED metres, not a re-derivation.
  const pointsM = mp.pointsM.map((p) => ({ x: r4(p.x - minX), y: r4(p.y - minY) }));
  return { footprint: { shape: "poly", points, pointsM }, wM: r4(wM), hM: r4(hM) };
}

/**
 * (D- metre-native step 5b) Stamp a node's STORED METRES onto its own poly footprint — the write half of
 * step 5. Given a pack where node `id` already has FRESH 0..1 `points` (and NO stale `pointsM`), derive the metre
 * poly (`toMetrePoly`, which falls back to the 0..1+anchor path when pointsM is absent) and attach it as `pointsM`
 * so the edit is PERSISTED metre-native. Returns the updated poly footprint, or the input footprint unchanged when
 * the node isn't a derivable poly (no anchor yet / not a poly) — a shape with no metre context simply stays 0..1
 * until an anchor exists. 1:1 point order (toMetrePoly preserves footprintSelfNorm order). PURE.
 *
 * ⚠ Call this AFTER writing the new `points` (so toMetrePoly derives from them) and only on a footprint whose
 * `pointsM` was cleared/absent — stamping over a STALE pointsM would re-read the stale metres. patchPoly guarantees
 * this by building the footprint without pointsM before calling here.
 */
export function footprintWithStoredMetres(
  pack: Pack,
  id: string | undefined,
  fp: Footprint | undefined
): Footprint | undefined {
  if (fp?.shape !== "poly") return fp;
  const mp = toMetrePoly(pack, id);
  if (!mp || mp.pointsM.length !== fp.points.length) return fp; // no metres yet (or a mismatch) → leave 0..1
  return { ...fp, pointsM: mp.pointsM };
}

/**
 * (D- step 5b) The metre-native version of a poly footprint whose points are SELF-CONTAINED (0..1 in their
 * OWN frame, like a subtype PLAN footprint), given the shape's real metre extent `{w,h}`. Self-normalizes the
 * points (so a plan whose points aren't bbox-filling still scales right) × the extent → `pointsM` (min-corner
 * origin, 1:1 order). Used for the shared-plan write path where `realMetres` of the editing unit is the extent and
 * there's no node to resolve through `toMetrePoly`. Returns the footprint unchanged when the extent is unknown/≤0.
 * PURE. Same stale-pointsM caution as `footprintWithStoredMetres`: feed FRESH points, never a spread with old pointsM.
 */
export function planFootprintWithStoredMetres(
  fp: Extract<Footprint, { shape: "poly" }>,
  extent: { w: number; h: number } | undefined
): Extract<Footprint, { shape: "poly" }> {
  if (!extent || !(extent.w > 0) || !(extent.h > 0) || fp.points.length < 3) return fp;
  const self = footprintSelfNorm(fp);
  if (!self || self.length !== fp.points.length) return fp;
  const pointsM = self.map((p) => ({ x: r4(p.x * extent.w), y: r4(p.y * extent.h) }));
  return { ...fp, pointsM };
}

/**
 * (D- metre-native step 5c; EXTENDED Slice 3 to stamp `posM` too) LAZY-HYDRATE un-migrated nodes with
 * their metre-native geometry truth, at projection time. The design's literal "migrateProject hydrates old blobs"
 * is unbuildable (migrateProject runs on the raw blob BEFORE a Pack exists, but toMetrePoly/realMetres/derivePosM
 * need the RESOLVED tree — the 5a finding). So we hydrate HERE, where a Pack exists: an un-migrated project's geo
 * nodes get `pointsM` (SHAPE truth) + `posM` (POSITION truth, D-) filled the first time they project. This
 * upgrades the existing Skyline import (all polys still legacy) + any old blob, with no explicit edit — the
 * projectToPack analogue of the complexes[] back-compat hydrate, metre-side.
 *
 * ⭐ WHY posM too (Slice 3): making posM a STORED fact at load time is what lets the kill-the-bbox arc delete
 * the legacy bbox `ancestorLayers` fallback in Canvas — `ancestorLayersMetric` bails ([]) when a level lacks
 * metres, and a derive-at-render posM is fine, but hydrating it once up front guarantees the metric path always
 * resolves AND makes a shape edit stop moving the node (the 0..1 bbox fraction shifted when you dragged a vertex;
 * an explicit stored metre position doesn't — the "manual tuning just works" target). pointsM + posM stamp
 * INDEPENDENTLY: a Slice-2-authored node may already carry pointsM but still derive posM, and vice-versa.
 *
 * Scope (deliberate, S292e): OWN-footprint polys of geo nodes that resolve NO shared plan (standalone land/
 * building/floor/unit shapes). A bound unit's OWN footprint is its placement (its SHAPE is the subtype plan's,
 * D-) → we must not stamp a plan's metres onto it; `resolvePlan == null` is the precise gate (not the
 * accidental length-mismatch guard in footprintWithStoredMetres). Subtype PLAN footprints are NOT hydrated here —
 * they derive losslessly from a bound unit's realMetres at read time (behavior-identical), and get stamped at the
 * 5b authoring seam. `posM` is stamped on the SAME standalone nodes (derivePosM is the stamp source — it always
 * derives from the fresh 0..1 fraction × the parent metre extent, never a stale stored value).
 *
 * PURE + NON-MUTATING: the caller passes `pack.geo` which aliases the store's AuthoredProject truth — so we return
 * FRESH nodes/footprints and never touch an input in place (mutating p.geo would corrupt the authored source). The
 * SAME `geo` reference is returned when nothing needed hydrating (no needless churn / store identity preserved).
 * pointsM and posM both derive only from a node's own footprint+anchor and its PARENT's metres (never siblings),
 * so computing both in one pass over the input pack is order-independent — no half-hydrated-pack hazard.
 */
export function hydrateGeoMetres(pack: Pack): GeoNode[] {
  const geo = geoNodes(pack);
  if (!geo.length) return geo;
  let changed = false;
  const out = geo.map((n) => {
    const fp = n.footprint;
    // only an OWN poly that resolves no shared plan is a hydration target (shape lives on this node, not the plan)
    if (fp?.shape !== "poly") return n;
    if (resolvePlan(pack, n) != null) return n; // shape lives on the shared plan, not this node's own footprint
    let node = n;
    // (5c) SHAPE: stamp pointsM when absent/stale, from this node's own footprint × its metre anchor.
    if (!(fp.pointsM && fp.pointsM.length === fp.points.length)) {
      const stamped = footprintWithStoredMetres(pack, n.id, fp);
      if (stamped !== fp) { node = { ...node, footprint: stamped }; changed = true; }
    }
    // (Slice 3) POSITION: stamp posM when absent, from the fresh 0..1 fraction × the parent metre extent.
    if (!(n.posM && Number.isFinite(n.posM.x) && Number.isFinite(n.posM.y))) {
      const pos = derivePosM(pack, n.id); // undefined for a root / no-metre parent → leave to derive at read time
      if (pos) { node = { ...node, posM: pos }; changed = true; }
    }
    return node;
  });
  return changed ? out : geo;
}

/** Per-edge length in METRES (edge i = points[i] → points[i+1], wrapping). Empty if no metre anchor.
 * (D- metre-native step 4) Reads the metre-native shape (`toMetrePoly`); edge lengths are
 *  translation-invariant, so own-frame vs parent-frame metres give identical results — same consolidation
 *  as deriveSqm onto the representation step 5 stores. */
export function edgeLengthsMetres(pack: Pack, id: string | undefined): number[] {
  const mp = toMetrePoly(pack, id)?.pointsM;
  if (!mp || mp.length < 2) return [];
  const out: number[] = [];
  for (let i = 0; i < mp.length; i++) {
    const a = mp[i];
    const b = mp[(i + 1) % mp.length];
    out.push(r4(Math.hypot(b.x - a.x, b.y - a.y)));
  }
  return out;
}

const DEG = 180 / Math.PI;
/** Edge orientation in degrees, folded to 0..180 (direction-agnostic — a wall and its opposite share an axis). */
function edgeAxisDeg(a: Pt, b: Pt): number {
  let d = (Math.atan2(b.y - a.y, b.x - a.x) * DEG + 180) % 180;
  if (d < 0) d += 180;
  return d;
}

/**
 * Auto-detect links: edges that are PARALLEL (same axis within `axisTol`°) AND EQUAL length (within `lenTol`,
 * relative) are grouped so editing one scales its partner(s) together. Returns groups of edge indices (size ≥ 2).
 * Illustration-grade — a cheap grouping, not a constraint graph. Index space = edgeLengthsMetres' indices.
 */
export function detectEdgeLinks(pack: Pack, id: string | undefined, axisTol = 4, lenTol = 0.04): number[][] {
  const mp = polyMetrePoints(pack, id);
  if (!mp || mp.length < 3) return [];
  const edges = mp.map((a, i) => {
    const b = mp[(i + 1) % mp.length];
    return { i, axis: edgeAxisDeg(a, b), len: Math.hypot(b.x - a.x, b.y - a.y) };
  });
  const used = new Set<number>();
  const groups: number[][] = [];
  for (const e of edges) {
    if (used.has(e.i) || e.len < 1e-6) continue;
    const g = [e.i];
    used.add(e.i);
    for (const f of edges) {
      if (used.has(f.i) || f.len < 1e-6) continue;
      const dAxis = Math.min(Math.abs(e.axis - f.axis), 180 - Math.abs(e.axis - f.axis));
      const dLen = Math.abs(e.len - f.len) / Math.max(e.len, f.len);
      if (dAxis <= axisTol && dLen <= lenTol) {
        g.push(f.i);
        used.add(f.i);
      }
    }
    if (g.length >= 2) groups.push(g);
  }
  return groups;
}

/** The metre extent of the PARENT frame a poly lives in (what fraction↔metre conversion divides/multiplies by). */
function parentMetreExtent(pack: Pack, id: string | undefined): { w: number; h: number } | undefined {
  const node = nodeById(pack, id);
  if (!node) return undefined;
  if (node.parentId) return realMetres(pack, node.parentId);
  const a = metreAnchor(pack, id);
  return a ? { w: a.metreW, h: a.metreH } : undefined;
}

/**
 * SET edge `edgeIndex` to `targetMetres` (illustration-grade). The edge keeps its DIRECTION; its
 * far vertex (points[edgeIndex+1]) slides along the edge to the new length. Edges auto-linked to this one
 * (parallel+equal — detectEdgeLinks) scale to the SAME length the same way. A FROZEN vertex never moves (we
 * then slide the NEAR end instead); a FROZEN edge is skipped entirely. Returns new FRACTION points, or the
 * input unchanged when there's no metre anchor / bad index. No closure solve — freeze holds what you like.
 */
export function setEdgeLengthMetres(
  pack: Pack,
  id: string,
  edgeIndex: number,
  targetMetres: number
): Array<{ x: number; y: number }> {
  const node = nodeById(pack, id);
  // (D-) edit the EFFECTIVE shape — the shared plan for a subtype-bound unit (whose own footprint is now
  // the placement rect), else the own poly. The returned points land on the plan via patchPoly's plan-only write.
  const src = effectiveFootprint(pack, node);
  if (src?.shape !== "poly") return [];
  const pts = src.points;
  const ext = parentMetreExtent(pack, id);
  if (!ext || pts.length < 2 || !(targetMetres > 0)) return pts;
  const frozenV = new Set(src.frozenVerts || []);
  const frozenE = new Set(src.frozenEdges || []);
  const n = pts.length;

  // to metres, mutate, back to fractions
  const m = pts.map((p) => ({ x: p.x * ext.w, y: p.y * ext.h }));
  const links = detectEdgeLinks(pack, id);
  const linked = links.find((g) => g.includes(edgeIndex));
  const targets = new Set<number>(linked ? linked : [edgeIndex]);

  for (const ei of targets) {
    if (frozenE.has(ei)) continue; // a frozen edge holds its length
    const ai = ei;
    const bi = (ei + 1) % n;
    const a = m[ai];
    const b = m[bi];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const cur = Math.hypot(dx, dy);
    if (cur < 1e-6) continue;
    const ux = dx / cur;
    const uy = dy / cur;
    if (!frozenV.has(bi)) {
      // slide the FAR end to the new length (keep near end fixed)
      m[bi] = { x: a.x + ux * targetMetres, y: a.y + uy * targetMetres };
    } else if (!frozenV.has(ai)) {
      // far end frozen → slide the NEAR end instead (edge still takes the new length)
      m[ai] = { x: b.x - ux * targetMetres, y: b.y - uy * targetMetres };
    } // both ends frozen → cannot change; leave it
  }

  return m.map((p) => ({ x: r4(p.x / ext.w), y: r4(p.y / ext.h) }));
}

/** The result of `constrainPolySqm` — either new FRACTION points to write (non-anchor node), or a metre-anchor
 * SCALE factor to apply to the node's own `metreW`/`metreH` (anchor node). (D- metre-native step 6.) */
export type PolySqmConstraint =
  | { kind: "points"; points: Array<{ x: number; y: number }> }
  // `scaleChildren` = a NON-leaf anchor: scaling its metreW/H by k would ripple to every descendant that derives its
  // metres from it. INDEPENDENT ANCHORS (D- "all direct children fixed"): resizing an anchor is a
  // PLOT-boundary op — nothing nested should change real size. So the caller ALSO divides every direct child's
  // footprint by k (about the anchor's fixed origin), cancelling the land's ×k → each child's real metres invariant.
  | { kind: "anchorScale"; k: number; scaleChildren?: boolean };

/**
 * CONSTRAIN a poly to a target m² (the original idea: "give it a constraint m² and the shape stays similar
 * but the size is accurate"). Uniformly targets the shoelace area at `targetSqm` — shape (and every angle)
 * preserved, only absolute size changes.
 *
 * (D- metre-native step 6 — fixes the Pin-m²-on-anchor NO-OP quirk flagged d.) Where the SCALE
 * lives depends on the node: a NON-ANCHOR node's size is its fraction of the parent, so we scale its points (and
 * `patchPoly` re-stamps the metres). But an ANCHOR node (the land IS its own metre anchor) holds its scale in
 * `metreW`/`metreH`, NOT in its points — scaling+renormalizing the points there is a no-op (toMetrePoly re-reads
 * the UNCHANGED anchor × the self-normalized points → the scale is erased; that was the quirk). So for an anchor
 * node we return a SCALE factor `k` to apply to BOTH metreW and metreH (preserving aspect, area → k²·old = target),
 * and leave the points untouched. FROZEN vertices only matter in the point-scaling branch (illustration-grade).
 * Returns a no-op `{kind:"points", points: pts}` when there's no metre context or a degenerate area.
 */
export function constrainPolySqm(pack: Pack, id: string, targetSqm: number): PolySqmConstraint {
  const node = nodeById(pack, id);
  // (D-) constrain the EFFECTIVE shape (shared plan for a bound unit) — matches polyMetrePoints below.
  const src = effectiveFootprint(pack, node);
  if (src?.shape !== "poly") return { kind: "points", points: [] };
  const pts = src.points;
  const ext = parentMetreExtent(pack, id);
  const mp = polyMetrePoints(pack, id);
  if (!ext || !mp || mp.length < 3 || !(targetSqm > 0)) return { kind: "points", points: pts };
  const cur = shoelaceArea(mp);
  if (cur <= 0) return { kind: "points", points: pts };
  const k = Math.sqrt(targetSqm / cur); // area scales with k²
  // ANCHOR node: the scale is the anchor, not the points. Scale metreW/metreH by k (points stay put). This branch
  // only fires when the node IS its own anchor AND isn't subtype-bound (a bound unit measures the shared plan, whose
  // scale lives in the unit's realMetres, i.e. its parent chain — not an anchor on the unit itself → the point path).
  const anchor = metreAnchor(pack, id);
  if (anchor && anchor.anchor.id === id && !resolvePlan(pack, node)) {
    // INDEPENDENT ANCHORS (D-). Scaling an anchor's metreW/H by k ripples to every descendant that
    // derives its metres from it. the semantics: resizing an anchor is a PLOT-boundary op — "resize the plot, not
    // the tower" — so NOTHING nested should change real size. A LEAF anchor scales cleanly (no descendants to ripple).
    // A NON-LEAF anchor needs the caller to ALSO divide every direct child's footprint by k (about the anchor's fixed
    // origin), which exactly cancels the land's ×k → each child's real metres (child_fraction × land_metres) invariant.
    if (childrenOf(pack, id).length > 0) return { kind: "anchorScale", k: r4(k), scaleChildren: true };
    return { kind: "anchorScale", k: r4(k) };
  }
  // NON-ANCHOR node: scale the parent-frame metre points about the centroid, renormalize to fractions.
  const cx = mp.reduce((s, p) => s + p.x, 0) / mp.length;
  const cy = mp.reduce((s, p) => s + p.y, 0) / mp.length;
  const frozenV = new Set(src.frozenVerts || []);
  const scaled = mp.map((p, i) =>
    frozenV.has(i) ? p : { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }
  );
  return { kind: "points", points: scaled.map((p) => ({ x: r4(p.x / ext.w), y: r4(p.y / ext.h) })) };
}

/** Toggle a value in an optional number[] (freeze set), returned sorted & de-duped (undefined when empty). */
export function toggleInSet(arr: number[] | undefined, v: number): number[] | undefined {
  const s = new Set(arr || []);
  if (s.has(v)) s.delete(v);
  else s.add(v);
  const out = Array.from(s).sort((a, b) => a - b);
  return out.length ? out : undefined;
}

/**
 * CONSTRAIN a node to a target m² (: "if we use #1 we can still constrain an object to a size
 * metres"). We keep the node's aspect ratio and scale its footprint rect so the derived m² hits `targetSqm`.
 * Returns the adjusted footprint rect (clamped to the parent) — non-destructive: caller stores it.
 * No-op (returns the current rect) when there's no metre anchor to measure against.
 */
export function constrainToSqm(pack: Pack, id: string, targetSqm: number): Rect {
  const node = nodeById(pack, id);
  const cur = footprintRect(node?.footprint);
  const current = deriveSqm(pack, id);
  if (!node || current == null || current <= 0 || !(targetSqm > 0)) return cur;
  // area scales with w*h; keep aspect → scale both by sqrt(target/current), anchored at the rect's centre
  const k = Math.sqrt(targetSqm / current);
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  const w = cur.w * k;
  const h = cur.h * k;
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h });
}

// ---------------------------------------------------------------------------
// GEOGRAPHIC → METRE scale (slice 2.5, §6). The map captures a land parcel as [lat,lng] corners; its real
// metre extent (width E–W, depth N–S) becomes the land node's metre ANCHOR, so the §4d fraction editor never
// forces the user to guess metres (: "the map is where the metre scale comes from for real projects").
// Illustration-grade: a flat-earth bounding-box of the parcel, NOT a projected survey area — plausible, not exact.
// ---------------------------------------------------------------------------

const EARTH_R = 6378137; // metres
const RAD = Math.PI / 180;

/** Great-circle distance in metres between two [lat,lng] points (haversine). */
export function haversineMetres(a: [number, number], b: [number, number]): number {
  const dLat = (b[0] - a[0]) * RAD;
  const dLng = (b[1] - a[1]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Real metre extent (W×H) of a lat/lng polygon's geographic BOUNDING BOX: W = east–west span at the mean
 * latitude, H = north–south span. This is the land's metre anchor — the §4d editor's fractions nest inside it.
 * Returns undefined for < 2 points. Deliberately the bbox (not the true parcel area): the editor's footprint
 * frame is a rect, so the anchor it needs is the parcel's bounding WxH, not its shoelace area.
 */
export function metreExtentFromLatLngPolygon(poly: [number, number][] | undefined): { w: number; h: number } | undefined {
  if (!poly || poly.length < 2) return undefined;
  const lats = poly.map((p) => p[0]);
  const lngs = poly.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  // W along a constant (mid) latitude; H along a constant longitude.
  const w = haversineMetres([midLat, minLng], [midLat, maxLng]);
  const h = haversineMetres([minLat, minLng], [maxLat, minLng]);
  if (!(w > 0) || !(h > 0)) return undefined;
  return { w: r4(w), h: r4(h) };
}

/**
 * MAP → EDITOR bridge (slice: draw-on-map first, D-). The parcel traced on the OSM map
 * (`siteGeo.landPolygon`, a [lat,lng][]) becomes the editor land node's BASE footprint: a 0..1
 * bbox-normalized `poly` in the SAME fraction frame every other node uses, so children lay out
 * inside the TRUE parcel plate (possibly L/T-shaped), not a lying rectangle. The parcel's metre
 * SCALE already transfers via metreExtentFromLatLngPolygon → the node's metre anchor; this carries
 * the SHAPE. Normalization is independent per-axis within the bbox (x,y each 0..1) — the real aspect
 * is held by metreW/metreH, exactly as the frame contract already treats the bbox (same as RefFrame).
 * North-up: higher latitude maps to a SMALLER y (editor y grows downward). Returns undefined for a
 * degenerate parcel (< 3 corners, or zero lat/lng span) — caller leaves the existing footprint alone.
 */
export function latLngPolygonToFootprint(
  poly: [number, number][] | undefined
): Extract<Footprint, { shape: "poly" }> | undefined {
  if (!poly || poly.length < 3) return undefined;
  const lats = poly.map((p) => p[0]);
  const lngs = poly.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const dLat = maxLat - minLat;
  const dLng = maxLng - minLng;
  if (!(dLat > 0) || !(dLng > 0)) return undefined;
  const points = poly.map(([lat, lng]) => ({
    x: r4(c01((lng - minLng) / dLng)),
    y: r4(c01((maxLat - lat) / dLat)), // north (max lat) → top (y=0)
  }));
  return { shape: "poly", points };
}

/**
 * EDITOR → MAP bridge: the inverse of latLngPolygonToFootprint. The land's ALREADY-DRAWN editor
 * footprint becomes the map parcel at a dropped pin — so the user NEVER re-traces a shape they already drew.
 * Takes the footprint (self-normalized to 0..1, y-DOWN like the editor), its real metre size (metreW×metreH),
 * the pin `center` [lat,lng], and an optional `bearingDeg` (clockwise, 0 = the drawn shape's "up" points north)
 * to rotate the placed parcel. Returns a closed-ring [lat,lng][] CENTRED on the pin. Flat-earth / illustration-
 * grade (metres → deg: lat is constant, lng divides by cos(lat)) — matches the map's own tipLatLng math. Returns
 * undefined for a degenerate footprint or non-positive metre size (caller leaves the parcel alone).
 */
export function footprintToLatLngParcel(
  fp: Footprint | undefined,
  metreW: number | undefined,
  metreH: number | undefined,
  center: [number, number] | undefined,
  bearingDeg = 0
): [number, number][] | undefined {
  const norm = footprintSelfNorm(fp); // 0..1, y-down; rect → 4 corners
  if (!norm || norm.length < 3 || !center) return undefined;
  const w = metreW ?? 0, h = metreH ?? 0;
  if (!(w > 0) || !(h > 0)) return undefined;
  const metrePerDegLat = (EARTH_R * RAD); // ≈ 111195 m per degree latitude
  const metrePerDegLng = metrePerDegLat * Math.cos(center[0] * RAD);
  const rad = (bearingDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return norm.map((p) => {
    // centre the shape on the pin: metre offset from the footprint's own centre (0.5,0.5).
    // east = +x·W; north = -y·H (editor y grows DOWN, so y=0/top = north/+lat).
    const ex = (p.x - 0.5) * w;
    const ny = (0.5 - p.y) * h;
    // rotate clockwise by bearing (east,north) → (east',north')
    const east = ex * cos + ny * sin;
    const north = -ex * sin + ny * cos;
    const lat = center[0] + north / metrePerDegLat;
    const lng = center[1] + east / Math.max(1e-6, metrePerDegLng);
    return [lat, lng] as [number, number];
  });
}

/** The LEVEL-AWARE default inset for "take my parent's shape" (the logic pass). The containment model is
 *  NOT uniform "child a bit smaller than parent": a BUILDING NESTS in its parcel (a real setback → inset), but a
 *  FLOOR *is* the building's full plate (the constant-plate model: "every floor is the SAME physical footprint") →
 *  NO inset. Units TILE the floor (they don't take the parent's shape at all — they subdivide it), so there is no
 *  entry for them here. PURE. */
export function insetForParentShape(childKind: GeoKind): number {
  if (childKind === "building") return 0.85; // building nests in the parcel — a realistic setback
  if (childKind === "floor") return 1; // "match the plate" EXACTLY = inset 1 (the deliberate copy-the-building action)
  return 0.9; // any other nested level (prop in a unit, say): a small inset so it reads as "inside"
}

/** the CREATION/seed inset for a floor = 0.8 (born 20% smaller than the building footprint — a visible
 *  setback that PROMPTS the user to unlock + vertex-edit it to the floor's real shape). Distinct from the "match the
 *  plate EXACTLY" button (inset 1): this is the born-shape, that is the deliberate copy-the-building action. */
export const FLOOR_SEED_INSET = 0.8;

/** The shape a CHILD should take to MATCH its parent, expressed as a 0..1 poly IN THE CHILD'S OWN FRAME (
 *  the general primitive behind both "building matches land parcel" and "floor matches building plate"). THE FRAME
 *  SUBTLETY that makes this correct (and a naive points-copy WRONG): a child's footprint lives in the parent's
 *  BBOX-normalized frame, not the parent's raw points. A building inset to {0.15..0.85} in the land, copied verbatim
 *  onto a floor, would shrink the floor to the building's position-in-land. So we take the parent's EFFECTIVE
 *  footprint and SELF-NORMALIZE it (footprintSelfNorm — the exact frame RefFrame draws + children live in), then
 *  inset about the centroid by `inset` (default = level-aware: setback for a building, full-plate for a floor).
 *  Returns undefined if there's no parent, the parent shape can't be resolved, or the parent is a plain rect with
 *  inset 1 (a rect child already fills its rect parent → nothing to gain). PURE — callers write via patchPoly. */
export function parentShapeInChildFrame(
  pack: Pack,
  childId: string,
  inset?: number
): Extract<Footprint, { shape: "poly" }> | undefined {
  const child = nodeById(pack, childId);
  if (!child?.parentId) return undefined;
  const parent = nodeById(pack, child.parentId);
  if (!parent) return undefined;
  const parentFp = effectiveFootprint(pack, parent); // the node object, NOT its id
  // "Take the parent's SHAPE" is only meaningful when the parent is a real POLYGON — a rect parent carries no shape
  // to inherit (an inset square is just a smaller rectangle, which toRect/the default footprint already give, and it
  // is NOT the "match the traced parcel/plate" the user asked for). So a rect/absent parent → nothing to match.
  if (parentFp?.shape !== "poly" || parentFp.points.length < 3) return undefined;
  const self = footprintSelfNorm(parentFp); // parent polygon in the CHILD's 0..1 frame (bbox-normalized)
  if (!self || self.length < 3) return undefined;
  const f = inset ?? insetForParentShape(child.kind);
  const points = f > 0 && f !== 1 ? scalePolyAboutCentroid(self, f) : self.map((p) => ({ ...p }));
  if (points.length < 3) return undefined;
  return { shape: "poly", points };
}

/** The parcel outline a BUILDING should take to MATCH its land. Now a thin wrapper over the general
 * parentShapeInChildFrame restricted to buildings — kept as a named entry point for the building inspector
 *  button + its tests. Default inset 0.85 = the building's setback inside its parcel. PURE. */
export function parcelFootprintForBuilding(
  pack: Pack,
  buildingId: string,
  inset = 0.85
): Extract<Footprint, { shape: "poly" }> | undefined {
  const node = nodeById(pack, buildingId);
  if (node?.kind !== "building") return undefined;
  return parentShapeInChildFrame(pack, buildingId, inset);
}

/**  — when a BUILDING becomes a polygon, every RECT floor directly under it is BORN (re)shaped as a
 *  building ×0.8 polygon: a visible setback that PROMPTS the user to unlock + vertex-edit it to that floor's real
 * outline. Returns a NEW geo array (or the same reference if nothing changed). The design decision:
 *  the ×0.8 seed is only meaningful once the building is a real polygon — `parentShapeInChildFrame` returns nothing
 *  for a rect parent, there being no shape to inherit — so this is called right after the building footprint is
 * written as a poly, NOT eagerly in buildGeoTree (that runs every projection → would WIPE edits, the D- footgun).
 *  ONLY rect floors are reshaped; a floor the user has already shaped into a poly is left untouched (seed-once, never
 *  ripple over edits). Floors under a still-rect building are left alone (they convert on unlock via setLocked). PURE. */
export function seedRectFloorsUnderPolyBuilding(geo: GeoNode[], buildingId: string): GeoNode[] {
  const pack = { geo } as Pack;
  const bld = nodeById(pack, buildingId);
  if (bld?.kind !== "building") return geo;
  const bldFp = effectiveFootprint(pack, bld);
  if (bldFp?.shape !== "poly" || bldFp.points.length < 3) return geo; // nothing to inherit yet
  let changed = false;
  const next = geo.map((n) => {
    if (n.parentId !== buildingId || n.kind !== "floor") return n;
    if (n.footprint?.shape === "poly") return n; // already shaped — never overwrite a user edit
    const seeded = parentShapeInChildFrame(pack, n.id, FLOOR_SEED_INSET);
    if (!seeded) return n;
    changed = true;
    return { ...n, footprint: { shape: "poly" as const, points: seeded.points } };
  });
  return changed ? next : geo;
}

/** (parked item 2) APPROVE-FLOOR → SEED-NEXT-FLOOR. Mark `floorId` confirmed and seed the NEXT floor sibling
 *  (next in geo order under the same building) from THIS floor's shape — ONCE, only if that next floor is still an
 *  unshaped rect (never overwrite a user edit = seed-once-then-independent). The author perfects floor 1, approves,
 *  and floor 2 starts as a copy of floor 1 (consecutive floors are usually alike). Soft/Law#1: purely additive —
 *  never blocks clicking ahead, never ripples lower-floor edits up. Both floors share the building plate frame, so a
 *  DIRECT point copy is frame-correct (a floor's self-normalized poly already IS "its shape within the plate"). PURE. */
export function seedNextFloorFromApproved(geo: GeoNode[], floorId: string): GeoNode[] {
  const pack = { geo } as Pack;
  const floor = nodeById(pack, floorId);
  if (floor?.kind !== "floor") return geo;
  const src = floor.footprint;
  // floors in this building, in geo (= birth/level) order; the "next up" is the one right after this id.
  const sibs = geo.filter((n) => n.parentId === floor.parentId && n.kind === "floor");
  const i = sibs.findIndex((n) => n.id === floorId);
  const nextFloor = i >= 0 ? sibs[i + 1] : undefined;
  let next = geo.map((n) => (n.id === floorId ? { ...n, confirmed: true } : n));
  // seed the next floor ONLY from a real source poly, and ONLY when it's still an unshaped rect.
  if (nextFloor && src?.shape === "poly" && src.points.length >= 3 && nextFloor.footprint?.shape !== "poly") {
    const pts = src.points.map((p) => ({ ...p }));
    next = next.map((n) => (n.id === nextFloor.id ? { ...n, footprint: { shape: "poly" as const, points: pts } } : n));
  }
  return next;
}

/** Can this node take its parent's shape? True when the parent resolves to a real POLYGON (a rect parent offers
 *  nothing to inherit) and the node is a kind that NESTS (building/floor/prop — NOT a unit, which tiles the floor
 * rather than copying it). PURE — gates the "Match the …" inspector button. */
export function canMatchParentShape(pack: Pack, id: string | undefined): boolean {
  const node = nodeById(pack, id);
  if (!node || node.kind === "unit" || node.kind === "land" || node.kind === "project") return false;
  if (!node.parentId) return false;
  const parent = nodeById(pack, node.parentId);
  const parentFp = effectiveFootprint(pack, parent); // the node object, NOT its id
  return parentFp?.shape === "poly" && parentFp.points.length >= 3;
}

/**
 * EDITOR → MAP bridge, the REVERSE of latLngPolygonToFootprint (draw-on-ref-then-align, D-). A land
 * footprint shaped/refined in the §4d editor (a 0..1 bbox-normalized `poly`) is projected BACK to real
 * [lat,lng][] parcel corners, so the map and the editor stay one truth. The forward pass dropped the absolute
 * geography (position + scale) — this re-injects it from an explicit geographic BBOX anchor (below), the SAME
 * {minLat,maxLat,minLng,maxLng} the forward pass bbox-normalized against. It is the exact algebraic inverse of
 * the lines above: lng = minLng + x·dLng, lat = maxLat − y·dLat (north-up: y=0 → maxLat). Round-trips to
 * identity with latLngPolygonToFootprint (within r4 rounding) for a footprint whose bbox is the full 0..1 frame.
 * Returns undefined for a degenerate footprint (< 3 pts) or a degenerate bbox (zero span). PURE.
 */
export function footprintToLatLngPolygon(
  footprint: Extract<Footprint, { shape: "poly" }> | undefined,
  bbox: GeoBBox | undefined
): [number, number][] | undefined {
  if (!footprint || footprint.points.length < 3) return undefined;
  if (!bbox) return undefined;
  const dLat = bbox.maxLat - bbox.minLat;
  const dLng = bbox.maxLng - bbox.minLng;
  if (!(dLat > 0) || !(dLng > 0)) return undefined;
  return footprint.points.map((p) => {
    const lng = bbox.minLng + c01(p.x) * dLng;
    const lat = bbox.maxLat - c01(p.y) * dLat; // y=0 (top) → maxLat (north)
    return [r6(lat), r6(lng)] as [number, number];
  });
}

/** A geographic bounding box — the anchor footprintToLatLngPolygon needs to place a 0..1 footprint on the map.
 *  It comes either from an already-traced parcel (refine case) or from the map pin + metre extent (originate). */
export interface GeoBBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** The geographic bbox of an already-traced parcel — the REFINE anchor (map→editor→map stays in sync). The
 *  same bbox latLngPolygonToFootprint normalizes against, so forward∘reverse is identity. undefined for < 2
 *  corners or a zero-span parcel. PURE. */
export function bboxFromLatLngPolygon(poly: [number, number][] | undefined): GeoBBox | undefined {
  if (!poly || poly.length < 2) return undefined;
  const lats = poly.map((p) => p[0]);
  const lngs = poly.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  if (!(maxLat - minLat > 0) || !(maxLng - minLng > 0)) return undefined;
  return { minLat, maxLat, minLng, maxLng };
}

/** The ORIGINATE anchor: a geographic bbox built from the map pin + a real metre extent, so the author can draw
 *  a parcel in the editor with NO prior trace and drop it on the map centred at the pin. Inverts haversine on a
 *  flat-earth approximation (the same illustration-grade model as metreExtentFromLatLngPolygon): Δlat spans
 *  metreH north–south, Δlng spans metreW east–west at the pin's latitude. undefined for a missing pin or a
 *  non-positive extent. PURE. */
export function bboxFromCenterMetres(
  center: [number, number] | undefined,
  metreW: number | undefined,
  metreH: number | undefined
): GeoBBox | undefined {
  if (!center || !(metreW && metreW > 0) || !(metreH && metreH > 0)) return undefined;
  const [lat, lng] = center;
  const dLat = metreH / (EARTH_R * RAD); // metres north–south → degrees latitude
  const cosLat = Math.cos(lat * RAD);
  if (!(cosLat > 0)) return undefined; // degenerate at the poles
  const dLng = metreW / (EARTH_R * RAD * cosLat); // metres east–west → degrees longitude at this latitude
  return {
    minLat: lat - dLat / 2,
    maxLat: lat + dLat / 2,
    minLng: lng - dLng / 2,
    maxLng: lng + dLng / 2,
  };
}

// ---------------------------------------------------------------------------
// FACING vector — which way a node "looks", in EDITOR space: 0° = up (top-of-frame), increasing
// CLOCKWISE (90° = right/east-of-frame, 180° = down, 270° = left). This is POSE metadata, independent of
// Transform.rotation (the editor draw-rotation) and SiteGeo.northBearingDeg (geographic north). It feeds the
// camera/frustum arc (a camera needs a facing). All pure — the Canvas arrow + the inspector share this trig.
// ---------------------------------------------------------------------------

/** Normalize any degrees to 0..359 (handles negatives + multiple turns). */
export function normDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * The screen offset of a facing arrow's TIP from a node centre, for a given facing + arm length `len`.
 * Screen y grows DOWNWARD, so 0° (up) → (0, −len); clockwise. Shared by the Canvas renderer AND the tests,
 * so the arrow and the stored degree can never drift. Returns a {dx, dy} in the SAME units as `len`.
 */
export function facingVectorTip(deg: number, len: number): { dx: number; dy: number } {
  const rad = (normDeg(deg) * Math.PI) / 180;
  return { dx: r4(Math.sin(rad) * len), dy: r4(-Math.cos(rad) * len) };
}

/**
 * The INVERSE of facingVectorTip: the facing degree (0..359) implied by dragging a tip to (tx,ty) relative to
 * a centre (cx,cy), in screen space (y down). The draggable arrow uses this to write facingDeg from a drag.
 * A zero-length drag (tip on the centre) → 0° (a stable default, no NaN).
 */
export function facingFromVector(cx: number, cy: number, tx: number, ty: number): number {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return 0;
  // screen y is down → up is −dy; atan2(east, north) with north = −dy gives 0=up, clockwise.
  return normDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/** 16-point compass label for a facing/bearing in degrees (0 = N/up). The canonical home for this label. */
export function compass16(deg: number): string {
  const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return pts[Math.round(normDeg(deg) / 22.5) % 16];
}

// ---------------------------------------------------------------------------
// CAMERA / frustum — a placeable interior viewpoint on a room node: position (0..1 in the node frame) +
// facing (the convention) + field of view. Pure: the canvas draws it (frustumPoints) and the AI prompt
// consumes it (cameraViewPhrase); building the phrase NOW (tested) makes the later AI half a one-line call.
// ---------------------------------------------------------------------------

export const CAMERA_FOV_MIN = 20;
export const CAMERA_FOV_MAX = 150;
/** A sensible default camera: centred, looking up, a natural ~60° interior lens. */
export const DEFAULT_CAMERA: Camera = { x: 0.5, y: 0.5, facingDeg: 0, fovDeg: 60 };

/** Clamp a camera into valid ranges: x/y into 0..1, facing normalized, fov into [MIN,MAX]. PURE. */
export function clampCamera(cam: Camera): Camera {
  return {
    x: r4(c01(cam.x)),
    y: r4(c01(cam.y)),
    facingDeg: normDeg(cam.facingDeg),
    fovDeg: r4(Math.max(CAMERA_FOV_MIN, Math.min(CAMERA_FOV_MAX, cam.fovDeg))),
  };
}

/**
 * The three points of a camera's view-cone (frustum) for drawing, each a {x,y} in the SAME frame as the camera
 * (0..1 node fractions, scaled by the caller to px): the APEX (where the viewer stands) and the two EDGE points
 * at facing ± fov/2, projected `len` out. Reuses facingVectorTip so the cone and the facing arrow never drift.
 * `len` is in frame units (e.g. 0.6 of the frame). PURE — shared by the Canvas overlay and the tests.
 */
export function frustumPoints(cam: Camera, len: number): { apex: { x: number; y: number }; left: { x: number; y: number }; right: { x: number; y: number } } {
  const half = clampCamera(cam).fovDeg / 2;
  const f = normDeg(cam.facingDeg);
  const le = facingVectorTip(f - half, len);
  const re = facingVectorTip(f + half, len);
  const apex = { x: r4(c01(cam.x)), y: r4(c01(cam.y)) };
  return {
    apex,
    left: { x: r4(apex.x + le.dx), y: r4(apex.y + le.dy) },
    right: { x: r4(apex.x + re.dx), y: r4(apex.y + re.dy) },
  };
}

/**
 * An accurate-angle phrase describing where the camera stands and what it looks at, for the AI room-image prompt
 * (slotImagePrompt) — e.g. "from the near-left of the room looking NE, ~60° wide view". PURE; the AI half
 * (next slice) just appends this to the unit prompt. Position reads in ROOM terms (near/far = y, left/right = x)
 * because a buyer thinks "from the doorway", not "x=0.2". Facing uses the 16-point compass (editor up = N).
 */
export function cameraViewPhrase(cam: Camera): string {
  const c = clampCamera(cam);
  // y: 0 = top-of-frame = FAR side of the room (you look "up" into the room from the near edge); 1 = NEAR.
  const near = c.y > 0.66 ? "near" : c.y < 0.34 ? "far" : "mid";
  const side = c.x < 0.34 ? "left" : c.x > 0.66 ? "right" : "centre";
  const spot = side === "centre" ? (near === "mid" ? "the centre of the room" : `the ${near} centre`) : `the ${near}-${side}`;
  const lens = c.fovDeg >= 100 ? "very wide" : c.fovDeg >= 75 ? "wide" : c.fovDeg <= 35 ? "tight" : "natural";
  return `from ${spot} looking ${compass16(c.facingDeg)}, a ${lens} ~${Math.round(c.fovDeg)}° field of view`;
}

// ---------------------------------------------------------------------------
// Containment — the "never protrude" rule (§4d rule 1). A child's footprint is already 0..1 within the
// parent, so clampRect IS containment; this just re-clamps on demand (e.g. after a drag).
// ---------------------------------------------------------------------------

export function clampToParent(r: Rect): Rect {
  return clampRect(r);
}

// ---------------------------------------------------------------------------
// Floor roll-up + column snapping (slice-2.x draw polish). Both PURE (UI stays thin). The roll-up gives the
// "read availability at a glance" promise (§4b); the column snap gives "default snap to building-wide columns,
// let the user nudge off-grid" (§4b hybrid rule) — a soft snap toward existing sibling-unit edges.
// ---------------------------------------------------------------------------

export interface StatusTally {
  status: UnitStatus;
  count: number;
  sqm: number; // summed derived m² for that status (0 when a unit has no metre anchor)
}

export interface FloorSummary {
  units: number;
  totalSqm: number;
  byStatus: StatusTally[]; // only statuses actually present, in UNIT_STATUSES order
}

/**
 * Roll up the UNIT children of a node (a floor): count, total derived m², and a per-status tally. Non-unit
 * children are ignored. m² sums the authored-truth deriveSqm (a unit with no metre anchor contributes 0 to
 * the total but still counts). Returns units:0 when there are no unit children (caller hides the overlay).
 */
export function floorSummary(pack: Pack, parentId: string | undefined): FloorSummary {
  const kids = childrenOf(pack, parentId).filter((n) => n.kind === "unit");
  const tally = new Map<UnitStatus, StatusTally>();
  let totalSqm = 0;
  for (const u of kids) {
    const st = u.status ?? "available";
    const sqm = deriveSqm(pack, u.id) ?? 0;
    totalSqm += sqm;
    const cur = tally.get(st) || { status: st, count: 0, sqm: 0 };
    cur.count += 1;
    cur.sqm += sqm;
    tally.set(st, cur);
  }
  const byStatus = UNIT_STATUSES.filter((s) => tally.has(s)).map((s) => {
    const t = tally.get(s)!;
    return { status: s, count: t.count, sqm: r4(t.sqm) };
  });
  return { units: kids.length, totalSqm: r4(totalSqm), byStatus };
}

/**
 * Snap a drawn/moved rect's LEFT and RIGHT edges toward the nearest sibling-unit edge within `tol` fractions
 * (a soft column snap — §4b). `siblings` = the other units already on the floor (exclude the one being moved).
 * Only x/w change (columns are vertical); y/h pass through. Each edge snaps independently to the closest
 * candidate edge; width is preserved on a left-edge snap (the box slides), recomputed on a right-edge snap.
 * No sibling within tolerance → the rect is returned unchanged (freehand). Pure; caller still clampRect's.
 */
export function snapToColumns(r: Rect, siblings: Rect[], tol = 0.02): Rect {
  if (!siblings.length) return r;
  const edges: number[] = [];
  for (const s of siblings) {
    edges.push(s.x, s.x + s.w);
  }
  const nearest = (v: number): number | undefined => {
    let best: number | undefined;
    let bestD = tol;
    for (const e of edges) {
      const d = Math.abs(e - v);
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  };
  let x = r.x;
  let w = r.w;
  const left = nearest(r.x);
  if (left != null) {
    w = w + (x - left); // keep the right edge put when the left snaps
    x = left;
  }
  const right = nearest(x + w);
  if (right != null) w = right - x;
  if (!(w > 0)) {
    x = r.x;
    w = r.w;
  }
  return { x: r4(x), y: r.y, w: r4(w), h: r.h };
}

// ---------------------------------------------------------------------------
// Named factories (clipper's fromFactory bet) — the ONLY way the toolbar/AI creates a node. Friendly params
// → a valid GeoNode seeded with a sensible footprint, so a fresh node reads well and no caller can author an
// impossible shape. Every factory stamps `factoryName` (the clipper convention).
// ---------------------------------------------------------------------------

/** Which kinds may nest under which (the Russian-doll depth order). */
export const CHILD_KIND: Record<GeoKind, GeoKind | null> = {
  project: "land",
  land: "building",
  building: "floor",
  floor: "unit",
  unit: "prop",
  prop: null,
};

const KIND_LABEL: Record<GeoKind, string> = {
  project: "Project",
  land: "Land parcel",
  building: "Building",
  floor: "Floor",
  unit: "Unit",
  prop: "Prop",
};

/** Default footprint per kind — a land fills most of the frame; a floor fills its building; a unit a slice. */
const DEFAULT_FP: Record<GeoKind, Rect> = {
  project: { x: 0.02, y: 0.02, w: 0.96, h: 0.96 },
  land: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  building: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
  floor: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  unit: { x: 0.05, y: 0.1, w: 0.25, h: 0.4 },
  prop: { x: 0.44, y: 0.44, w: 0.12, h: 0.12 },
};

function newId(kind: GeoKind, existing: Set<string>): string {
  let n = existing.size ? Array.from(existing).filter((i) => i.startsWith(kind)).length + 1 : 1;
  let id = `${kind}-${n}`;
  while (existing.has(id)) id = `${kind}-${++n}`;
  return id;
}

export interface MakeOpts {
  name?: string;
  rect?: Rect;
  metreW?: number;
  metreH?: number;
  heightM?: number;
  status?: UnitStatus;
  priceUsd?: number;
}

/** Build a GeoNode of `kind` under `parentId`. Pure — caller inserts it into pack.geo[]. */
export function makeNode(
  kind: GeoKind,
  parentId: string | undefined,
  opts: MakeOpts,
  existingIds: Iterable<string>
): GeoNode {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const rect = clampRect(opts.rect || DEFAULT_FP[kind]);
  const transform: Transform = { x: rect.x, y: rect.y, scale: 1, rotation: 0 };
  const node: GeoNode = {
    id: newId(kind, existing),
    name: opts.name || KIND_LABEL[kind],
    kind,
    parentId,
    transform,
    footprint: { shape: "rect", rect },
    factoryName: `make-${kind}`,
  };
  if (opts.metreW != null && opts.metreH != null) {
    node.metreW = opts.metreW;
    node.metreH = opts.metreH;
  }
  // floors carry a real height → the 3D extrusion input (a later projection; stored now).
  if (kind === "floor") node.heightM = opts.heightM ?? 3;
  if (kind === "unit") node.status = opts.status ?? "available";
  if (opts.priceUsd != null) node.price = { amountUsd: opts.priceUsd };
  return node;
}

export { KIND_LABEL };

// ---------------------------------------------------------------------------
// SQUARE-GRID DE-SKEW core (the design docs — the LOCKED model).
//
// The pain: authoring shapes against a map-tilted parent frame bakes the plot's real-world rotation INTO the
// authored geometry → skew. The fix (the call): the deed owns the SHAPE; the MAP owns placement + the
// front-vector; the STUDIO authors SQUARE with the building FRONT facing screen-DOWN. The one real-world rotation
// is `bearingDeg` = azimuth of the front-vector from map-north, set via the front-vector on the map and applied
// map-side ONLY. These pure fns convert between the map-oriented (real-world) metre shape and the square-authored
// (front-down) metre shape, losslessly. No consumer is wired yet (Slice 1 = the proven core, tests are the gate).
//
// Conventions (match the rest of geo.ts): metre points are y-DOWN like the editor/SVG; `rotatePointsAboutCentre`
// rotates CLOCKWISE in that y-down space. North = screen-up = −y. A front-vector "facing down" = +y = south on
// screen; the user looks AT the facade. `bearingDeg` is measured CLOCKWISE from true/map north to the front-vector
// (0 = front points north, 90 = front points east, 180 = front points south, …), matching compass convention.
// ---------------------------------------------------------------------------

/** Centroid of a metre polygon (average of vertices). PURE. */
export function polyCentroid(points: Pt[]): Pt {
  const n = points.length || 1;
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  return { x: cx / n, y: cy / n };
}

/** The bearing (deg CLOCKWISE from north=screen-up) of a front-vector given as a metre delta (dx east, dy y-DOWN).
 *  North is −y (screen-up), east is +x. atan2(east, north) with north = −dy. Returns 0..360. PURE. */
export function bearingFromVectorMetres(dx: number, dy: number): number {
  const east = dx, north = -dy; // y-down → north is −y
  let deg = Math.atan2(east, north) * DEG; // clockwise from north
  if (deg < 0) deg += 360;
  return r4(deg);
}

/** DE-SKEW: rotate a real-world-oriented metre polygon into the SQUARE authoring frame where the building FRONT
 *  faces screen-DOWN. `bearingDeg` = the front-vector's azimuth (deg clockwise from north). To bring the front
 *  (currently pointing at `bearingDeg`) to point DOWN (south = 180°), rotate the shape by (180 − bearingDeg) about
 *  its centroid. Returns the authored (square) metre points. PURE — the stored `bearingDeg` is what `reskewForMap`
 * uses to put it back. (Front-down because the user "looks at the building from the front";.) */
export function deskewToFrontDown(points: Pt[], bearingDeg: number): Pt[] {
  if (points.length < 3) return points;
  const rot = 180 - bearingDeg; // bring the front from `bearingDeg` round to 180° (screen-down)
  return rotatePointsAboutCentre(points, rot, polyCentroid(points));
}

/** RE-SKEW: the exact inverse of `deskewToFrontDown` — take a square-authored (front-down) metre polygon back to
 *  its real-world orientation for the map/illustration view (front points at `bearingDeg` again). Rotate by
 *  −(180 − bearingDeg) = (bearingDeg − 180) about the centroid. `deskew∘reskew` and `reskew∘deskew` are identity
 *  (up to float). Feeds `footprintToLatLngParcel` for the map placement. PURE. */
export function reskewForMap(points: Pt[], bearingDeg: number): Pt[] {
  if (points.length < 3) return points;
  const rot = bearingDeg - 180; // inverse of deskew's (180 − bearingDeg)
  return rotatePointsAboutCentre(points, rot, polyCentroid(points));
}

/** The plot's real-world bearing extracted from a deed/GPS polygon's LONGEST edge, as an azimuth (deg clockwise
 *  from north). A convenience when no explicit front-vector is set yet: many plots front onto their longest edge
 * (the road side). The caller can override with a user-set front-vector (preferred —: easy to set on the
 *  map relative to the pin/road). Metre points, y-DOWN. Returns 0..360, or 0 for a degenerate poly. PURE. */
export function bearingFromLongestEdgeMetres(points: Pt[]): number {
  if (points.length < 2) return 0;
  let bestLen = -1, bestDx = 0, bestDy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > bestLen) { bestLen = len; bestDx = dx; bestDy = dy; }
  }
  return bearingFromVectorMetres(bestDx, bestDy);
}

/** Project a lat/lng polygon to LOCAL STUDIO METRE points (x east, y DOWN) about its own geographic centroid, using
 *  the same flat-earth tangent-plane model as footprintToLatLngParcel (lat constant metres/deg; lng divides by
 *  cos(lat)). y-DOWN means north (higher lat) → smaller y, matching the editor's screen convention. PURE. */
export function latLngPolygonToMetrePoints(poly: [number, number][]): Pt[] {
  const lat0 = poly.reduce((s, p) => s + p[0], 0) / (poly.length || 1);
  const lng0 = poly.reduce((s, p) => s + p[1], 0) / (poly.length || 1);
  const mPerDegLat = EARTH_R * RAD;
  const mPerDegLng = mPerDegLat * Math.cos(lat0 * RAD);
  return poly.map(([lat, lng]) => ({
    x: (lng - lng0) * mPerDegLng,       // east
    y: -(lat - lat0) * mPerDegLat,      // north → up → smaller y (y grows DOWN)
  }));
}

/** The plot's real-world bearing extracted straight from a GPS/deed [lat,lng] polygon's longest edge (azimuth,
 *  deg clockwise from north). Convenience wrapper: project to local metres, then reuse bearingFromLongestEdgeMetres.
 *  Returns 0 for a degenerate parcel (< 2 corners). PURE — the ONE "where does the plot's tilt come from" seam. */
export function bearingFromLatLngPolygon(poly: [number, number][] | undefined): number {
  if (!poly || poly.length < 2) return 0;
  return bearingFromLongestEdgeMetres(latLngPolygonToMetrePoints(poly));
}

/** DE-TILT a traced GPS/deed parcel into a SQUARE authoring footprint + its de-tilted metre extent + the plot's
 * bearing (square-grid redesign, D-). The map is distorted/tilted; the deed is the authority. We:
 *    1. project the GPS corners to local studio metres (y-down),
 *    2. extract the plot BEARING (longest-edge azimuth — usually the road side),
 *    3. DE-SKEW the metre points to the front-down SQUARE frame (deskewToFrontDown, proven rigid — area + edges
 *       preserved), so authoring happens on an undistorted grid,
 *    4. read metreW×metreH from the DE-TILTED (axis-aligned) bbox — the honest extent, not the rotated bbox,
 *    5. self-normalize the de-skewed points into the node's 0..1 `poly` footprint.
 *  The returned `bearingDeg` is stored on the land's `siteGeo.northBearingDeg` and re-applied MAP-SIDE ONLY
 *  (footprintToLatLngParcel) — never folded back into the authored geometry (that feedback loop was the skew bug).
 *  This REPLACES the old latLngPolygonToFootprint path for fresh traces: that returned a TILTED bbox-normalized
 *  shape (born skewed). Returns undefined for a degenerate parcel (< 3 corners or zero metre span). PURE. */
export function latLngPolygonToSquareFootprint(
  poly: [number, number][] | undefined
): { footprint: Extract<Footprint, { shape: "poly" }>; metreW: number; metreH: number; bearingDeg: number } | undefined {
  if (!poly || poly.length < 3) return undefined;
  const metrePts = latLngPolygonToMetrePoints(poly);
  const bearingDeg = bearingFromLongestEdgeMetres(metrePts);
  const square = deskewToFrontDown(metrePts, bearingDeg); // rigid → area + edges preserved, now axis-friendly
  const xs = square.map((p) => p.x), ys = square.map((p) => p.y);
  const metreW = r4(Math.max(...xs) - Math.min(...xs));
  const metreH = r4(Math.max(...ys) - Math.min(...ys));
  if (!(metreW > 0) || !(metreH > 0)) return undefined;
  const points = footprintSelfNorm({ shape: "poly", points: square.map((p) => ({ x: r4(p.x), y: r4(p.y) })) });
  if (!points || points.length < 3) return undefined;
  return {
    footprint: { shape: "poly", points: points.map((p) => ({ x: r4(p.x), y: r4(p.y) })) },
    metreW,
    metreH,
    bearingDeg,
  };
}
