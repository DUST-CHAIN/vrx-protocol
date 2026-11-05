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

import type { Footprint, GeoKind, GeoNode, Pack, Transform, UnitStatus } from "./pack";

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
  "sale-minus": "#38bdf8",
  "sale-plus": "#2563eb",
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

/**
 * AUTHORED-TRUTH m² of a node, from its real geometry × metre anchor (never a display tweak).
 * - rect/point footprint → bounding-box metres (realMetres: w × h).
 * - poly footprint       → TRUE polygon area (shoelace) in metres² — a drawn L/T shape is less than its bbox.
 * Returns undefined when no metre anchor is set anywhere above — m² is simply not-yet-known, not zero.
 */
export function deriveSqm(pack: Pack, id: string | undefined): number | undefined {
  const node = nodeById(pack, id);
  if (node?.footprint?.shape === "poly" && node.footprint.points.length >= 3) {
    const mp = polyMetrePoints(pack, id);
    if (!mp) return undefined;
    return r4(shoelaceArea(mp));
  }
  const m = realMetres(pack, id);
  if (!m) return undefined;
  return r4(m.w * m.h);
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
  if (node?.footprint?.shape !== "poly") return undefined;
  const parentM = node.parentId ? realMetres(pack, node.parentId) : metreAnchor(pack, id) && { w: metreAnchor(pack, id)!.metreW, h: metreAnchor(pack, id)!.metreH };
  if (!parentM) return undefined;
  return node.footprint.points.map((p) => ({ x: r4(p.x * parentM.w), y: r4(p.y * parentM.h) }));
}

/** Per-edge length in METRES (edge i = points[i] → points[i+1], wrapping). Empty if no metre anchor. */
export function edgeLengthsMetres(pack: Pack, id: string | undefined): number[] {
  const mp = polyMetrePoints(pack, id);
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
  if (node?.footprint?.shape !== "poly") return [];
  const pts = node.footprint.points;
  const ext = parentMetreExtent(pack, id);
  if (!ext || pts.length < 2 || !(targetMetres > 0)) return pts;
  const frozenV = new Set(node.footprint.frozenVerts || []);
  const frozenE = new Set(node.footprint.frozenEdges || []);
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

/**
 * CONSTRAIN a poly to a target m² (the original idea: "give it a constraint m² and the shape stays similar
 * but the size is accurate"). Uniformly scales ALL points about the polygon centroid so the shoelace area hits
 * `targetSqm` — shape (and every angle) preserved, only absolute size changes. FROZEN vertices are left in
 * place (the scale still targets the area; frozen points just don't move — illustration-grade). Returns new
 * FRACTION points; input unchanged when there's no metre anchor or a degenerate area.
 */
export function constrainPolySqm(pack: Pack, id: string, targetSqm: number): Array<{ x: number; y: number }> {
  const node = nodeById(pack, id);
  if (node?.footprint?.shape !== "poly") return [];
  const pts = node.footprint.points;
  const ext = parentMetreExtent(pack, id);
  const mp = polyMetrePoints(pack, id);
  if (!ext || !mp || mp.length < 3 || !(targetSqm > 0)) return pts;
  const cur = shoelaceArea(mp);
  if (cur <= 0) return pts;
  const k = Math.sqrt(targetSqm / cur); // area scales with k²
  const cx = mp.reduce((s, p) => s + p.x, 0) / mp.length;
  const cy = mp.reduce((s, p) => s + p.y, 0) / mp.length;
  const frozenV = new Set(node.footprint.frozenVerts || []);
  const scaled = mp.map((p, i) =>
    frozenV.has(i) ? p : { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }
  );
  return scaled.map((p) => ({ x: r4(p.x / ext.w), y: r4(p.y / ext.h) }));
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
