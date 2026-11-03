// TRACER → MM UnitPlan adapter (D- the design docs). PURE, no React, no DOM.
//
// WHAT THIS IS. The floor-plan tracer (portal/app/admin/images/tracer) authors room-level geometry in
// IMAGE-PIXEL space — room polygons, doors, windows, interior walls — but today it only PUBLISHES a flat PNG
// (lock→replace), throwing the structure away. MM's node model has a durable home for a unit's shape: the
// SUBTYPE plan `b.types[].subtypes[].plan` (pack.ts UnitPlan: a 0..1-normalized footprint + door/window/wall
// markers + a backdrop). This adapter converts the tracer's state into a serializable UnitPlan so the detail
// becomes AI-readable MM data instead of pixels (the "AI-editable building model" direction).
//
// WHY A SEPARATE SHAPE HERE (the app-boundary constraint, D-). MM's `@/` alias is scoped to portal/mm, so
// portal/app (the tracer) CANNOT import portal/mm/lib/pack (UnitPlan) nor geo (footprintSelfNorm). So: (1) the
// normalization math is re-implemented here, self-contained + pure (bbox→0..1, the same formula as
// mm/lib/geo.footprintSelfNorm — kept in lock-step by hand, a documented dup); (2) we emit a STRUCTURALLY
// matching plain shape (TracedUnitPlan) that MM reads back via the server sidecar and feeds to setSubtypePlan.
// The shape is a subset by design (option 1, lossy): rooms/furniture/labels have no home in UnitPlan yet — the
// full-fidelity extension (rooms[]+furniture[]) is a later arc (the design docs §Future).
//
// NUMBER HANDLING (stated at build time per the craft rule):
//  • The UNIT SHELL = the LARGEST closed room polygon (matches the tracer's auto-label "largest = the unit"
//    rule). Its bbox defines the 0..1 frame EVERYTHING else normalizes into, so doors/windows/walls land in the
//    same frame as the footprint. A single traced outline IS the shell.
//  • Points normalize to the shell bbox: (p - min) / extent, clamped [0,1]. Absolute scale is intentionally
//    dropped — the subtype's declared sqm is the binding size at render (UnitPlan contract), carried as
//    `targetSqm` for the importer, NOT baked into the shape here.
//  • Marker widths/wall thickness convert px→metre via metresPerPixel (0 / absent ⇒ omitted, never a fake 0).
//  • Door `facingDeg` / wall orientation reuse the tracer's `rot` verbatim (editor degrees).

export type Pt = { x: number; y: number };

/** The tracer's door: anchored at (x,y) image-px, `w` opening width px, `rot` wall orientation deg. */
export type TracerDoor = { x: number; y: number; w: number; rot: number };
/** The tracer's window: same anchor/width/rot, no swing. */
export type TracerWin = { x: number; y: number; w: number; rot: number };

/** A plan marker — STRUCTURALLY matches mm/lib/pack.PlanMarker (door/window/wall). Points 0..1 in the plan frame. */
export type TracedMarker =
  | { kind: "door"; at: Pt; widthM?: number; facingDeg?: number }
  | { kind: "window"; at: Pt; widthM?: number }
  | { kind: "wall"; a: Pt; b: Pt; thickM?: number };

/** A serializable UnitPlan — STRUCTURALLY matches mm/lib/pack.UnitPlan (footprint poly + markers + backdrop),
 *  plus `targetSqm` (the subtype's binding size, for the importer) and `source` provenance. MM reads this back
 *  and feeds the pack.UnitPlan subset to setSubtypePlan. */
export type TracedUnitPlan = {
  footprint: { shape: "poly"; points: Pt[] };
  markers?: TracedMarker[];
  backdrop?: { dataUrl: string; mime: string };
  /** The subtype's declared m² (the binding size); the importer constrains the footprint to this. */
  targetSqm?: number;
  /** Provenance so MM/the operator can see where a plan came from. */
  source: "tracer";
  at: number;
};

export type TracerPlanInput = {
  /** Closed room polygons (the tracer's `polys` minus the active/empty one), image-px. */
  rooms: Pt[][];
  doors: TracerDoor[];
  windows: TracerWin[];
  /** Interior partition polylines (open), image-px — each becomes a chain of wall markers. */
  walls: Pt[][];
  /** px→metre scalar; 0/undefined ⇒ widths omitted (shape still converts; it's scale-free). */
  metresPerPixel?: number;
  /** The subtype's declared m² (from the catalog); carried through as the binding size. */
  targetSqm?: number;
  /** Optional trace-over image to keep as the plan backdrop (reference only). */
  backdrop?: { dataUrl: string; mime: string };
};

/** Polygon area (shoelace, absolute) in whatever units the points are in. */
export function polyArea(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(a) / 2;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The bbox of a set of points → a normalizer into 0..1 of that bbox (the footprintSelfNorm formula). */
function bboxNormalizer(pts: Pt[]): { norm: (p: Pt) => Pt; ok: boolean } {
  if (pts.length === 0) return { norm: (p) => p, ok: false };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(1e-6, Math.max(...xs) - minX), h = Math.max(1e-6, Math.max(...ys) - minY);
  return { norm: (p) => ({ x: clamp01((p.x - minX) / w), y: clamp01((p.y - minY) / h) }), ok: true };
}

/**
 * Convert the tracer's authored geometry into a serializable UnitPlan (option 1 — lossy adapter, no schema
 * change). Returns null if there is no usable closed room to use as the shell (nothing to send). PURE.
 *
 * The SHELL = the largest closed room (the unit outline); its bbox is the 0..1 frame. Doors/windows become
 * markers at their normalized anchor with a metre width; interior wall polylines become per-segment wall markers.
 * Rooms other than the shell, furniture and text labels are DROPPED (no home in UnitPlan yet — see the module
 * header + the future-arc design doc).
 */
export function tracerToUnitPlan(input: TracerPlanInput): TracedUnitPlan | null {
  const closed = (input.rooms || []).filter((p) => p.length >= 3);
  if (closed.length === 0) return null;

  // Shell = the largest closed poly (the unit outline, matching the tracer's auto-label rule).
  const shell = closed.reduce((best, p) => (polyArea(p) > polyArea(best) ? p : best), closed[0]);
  const { norm, ok } = bboxNormalizer(shell);
  if (!ok) return null;

  const mpp = typeof input.metresPerPixel === "number" && input.metresPerPixel > 0 ? input.metresPerPixel : 0;
  const widthM = (px: number): number | undefined => (mpp > 0 && px > 0 ? round4(px * mpp) : undefined);

  const markers: TracedMarker[] = [];
  for (const d of input.doors || []) {
    const m: TracedMarker = { kind: "door", at: norm({ x: d.x, y: d.y }) };
    const wM = widthM(d.w); if (wM !== undefined) m.widthM = wM;
    if (typeof d.rot === "number") m.facingDeg = ((d.rot % 360) + 360) % 360;
    markers.push(m);
  }
  for (const w of input.windows || []) {
    const m: TracedMarker = { kind: "window", at: norm({ x: w.x, y: w.y }) };
    const wM = widthM(w.w); if (wM !== undefined) m.widthM = wM;
    markers.push(m);
  }
  // Interior walls: each open polyline → a chain of segment wall markers (a→b per edge) in the shell frame.
  for (const wall of input.walls || []) {
    for (let i = 1; i < wall.length; i++) {
      markers.push({ kind: "wall", a: norm(wall[i - 1]), b: norm(wall[i]) });
    }
  }

  const plan: TracedUnitPlan = {
    footprint: { shape: "poly", points: shell.map(norm) },
    source: "tracer",
    at: Date.now(),
  };
  if (markers.length) plan.markers = markers;
  if (input.backdrop?.dataUrl) plan.backdrop = { dataUrl: input.backdrop.dataUrl, mime: input.backdrop.mime };
  if (typeof input.targetSqm === "number" && input.targetSqm > 0) plan.targetSqm = round4(input.targetSqm);
  return plan;
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
