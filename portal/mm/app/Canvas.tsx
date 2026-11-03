"use client";

// The §4d drawing board (slice 2). An SVG canvas showing the FOCUSED node's frame with its CHILD nodes as
// rectangles (fractions-of-parent → pixels). Interactions:
//   - click a child          → select it (inspector opens)
//   - drag a child           → move (clamped inside the frame — "never protrude", §4d rule 1)
//   - drag the SE handle      → resize (clamped)
//   - double-click a child   → ZOOM IN (focus it; draw its children)
//   - drag on empty canvas   → draw a NEW child of the next kind (land→building→floor→unit→prop)
//   - breadcrumb             → ZOOM OUT to any ancestor / root
// Everything writes pack.geo[] via useGeo; m²/status come from lib/geo (authored truth).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Footprint, GeoKind, GeoNode, Pack, PlanMarker } from "@/lib/pack";
import {
  ancestorLayersMetric,
  ancestorsOf,
  childrenOf,
  compass16,
  deriveSqm,
  edgeLengthsMetres,
  effectiveFootprint,
  facingFromVector,
  facingVectorTip,
  floorSummary,
  footprintRect,
  frustumPoints,
  KIND_LABEL,
  nodeById,
  niceMetreStep,
  realMetres,
  renderFootprint,
  resolvePlan,
  rootNodes,
  snapToColumns,
  STATUS_FILL,
  STATUS_LABEL,
  unitShownAsShape,
  UNIT_STATUSES,
  type Rect,
} from "@/lib/geo";
import type { GeoApi } from "./useGeo";
import { nextChildKind } from "./useGeo";
import { propIcon, type PropIcon } from "@/lib/furniture";

const PAD = 24; // px padding around the frame inside the SVG viewport

// (D- metre-native refactor STEP 2) RENDER the frame from the focused node's REAL METRE extent via ONE
// uniform metres→px scale, behind this flag. OFF = the exact aspect-letterbox path (unchanged). ON = the
// frame px rect is derived as (metreExtent × a single scale s), so the x- and y- metre→px scales are EQUAL BY
// CONSTRUCTION (sx === sy) — not merely reconciled after the fact (the grid-honesty patch). On healthy data
// the metre aspect == the frozen frameAspect, so fb0 is numerically equivalent (the migration's safety proof);
// the real gain is the render now thinks in a true uniform metre scale, the coordinate system steps 3–4 write/read.
// Defaults ON (verify visually; flip to false to A/B against the old path during live-verify).
const METRE_NATIVE_RENDER = true;
// (Slice 1 → Slice 3) The ancestor BACKDROP is drawn from real-metre offsets (`ancestorLayersMetric`).
// In metre space parent↔child is a pure translation → a rotated/irregular ancestor can't distort the backdrop (the
//  Skyline finding). Slice 3 made it the SOLE path (the legacy bbox `ancestorLayers` fallback + this flag are
// gone — the load-time hydrate guarantees every level carries metres, so the metric variant always resolves).

/** The drawing FRAME in px — a letterboxed rect inside the padded viewport whose ASPECT matches the focused
 * node's real metre shape. Before this, the 0..1 footprint stretched to fill the whole panel, so a
 *  130×150 m parcel looked square/distorted vs the accurate map. We fit the largest aspect-correct rect inside the
 *  padded viewport and centre it, so what you draw matches the real proportions (and the map). aspect = w/h
 *  (undefined → fall back to the full padded box, i.e. the old behaviour). */
interface FrameBox { x: number; y: number; w: number; h: number; }
function frameBox(box: { width: number; height: number }, aspect: number | undefined): FrameBox {
  const availW = Math.max(0, box.width - PAD * 2);
  const availH = Math.max(0, box.height - PAD * 2);
  if (!aspect || !(aspect > 0) || availW <= 0 || availH <= 0) {
    return { x: PAD, y: PAD, w: availW, h: availH };
  }
  // largest w×h with w/h = aspect that fits in avail
  let w = availW;
  let h = w / aspect;
  if (h > availH) { h = availH; w = h * aspect; }
  return { x: PAD + (availW - w) / 2, y: PAD + (availH - h) / 2, w, h };
}

/** (D- STEP 2) The metre-native frame: fit the focused node's real metre extent (wM×hM) into the padded
 *  viewport by ONE uniform scale s = min(availW/wM, availH/hM), then centre it. The returned FrameBox depicts
 *  exactly wM×hM metres, so metres→px is a SINGLE scalar `s` in both axes — squares are square and the scale bar
 *  is honest by construction, with no separate reconcile step. `scale` (px per metre) is returned alongside so
 *  callers can project metre points directly. Falls back to the aspect-letterbox box when the metre extent is
 *  unknown (no anchor yet), so behaviour degrades to the old path rather than vanishing. */
interface MetreFrameBox extends FrameBox { scale: number; wM: number; hM: number; }
function metreFrameBox(
  box: { width: number; height: number },
  metres: { w: number; h: number } | undefined,
  aspectFallback: number | undefined,
): MetreFrameBox {
  const availW = Math.max(0, box.width - PAD * 2);
  const availH = Math.max(0, box.height - PAD * 2);
  if (!metres || !(metres.w > 0) || !(metres.h > 0) || availW <= 0 || availH <= 0) {
    const fb = frameBox(box, aspectFallback); // no metres yet → the old aspect-fit (or full box)
    return { ...fb, scale: 0, wM: 0, hM: 0 };
  }
  const s = Math.min(availW / metres.w, availH / metres.h); // ONE uniform px-per-metre → sx === sy
  const w = metres.w * s, h = metres.h * s;
  return { x: PAD + (availW - w) / 2, y: PAD + (availH - h) / 2, w, h, scale: s, wM: metres.w, hM: metres.h };
}

/** (B3b "the world") the viewport transform — Adobe-style pan/zoom OVER the aspect-fitted frame. Identity
 *  ({zoom:1,panX:0,panY:0}) = the old behaviour (the frame already fits the focus, so B3a's per-focus fit stands).
 *  Because frameBox→fb0 is the one place every projection reads its frame from, we zoom/pan by TRANSFORMING fb0:
 *  scale about the viewport centre, then translate by pan. Every affine consumer (toPx/toFrac/vPx + all box={fb0}
 *  renderers + hit-tests) then moves together with zero per-consumer change — the whole "world" transforms as one. */
interface Viewport { zoom: number; panX: number; panY: number; }
const IDENTITY_VP: Viewport = { zoom: 1, panX: 0, panY: 0 };
const ZOOM_MIN = 0.2, ZOOM_MAX = 12;
/** Apply the viewport transform to the aspect-fitted frame. The scale pivot is the padded-viewport centre; pan
 *  shifts afterwards. Keeping the pivot fixed means zoom=1/pan=0 is EXACTLY the untransformed frame. */
function viewFrame(base: FrameBox, box: { width: number; height: number }, vp: Viewport): FrameBox {
  const cx = box.width / 2, cy = box.height / 2;
  return {
    x: cx + (base.x - cx) * vp.zoom + vp.panX,
    y: cy + (base.y - cy) * vp.zoom + vp.panY,
    w: base.w * vp.zoom,
    h: base.h * vp.zoom,
  };
}
const HANDLE = 12; // px resize handle
const PIN_RADIUS_M = 3; // (Slice C) a unit pin's natural radius in floor-METRES — it GROWS WITH ZOOM (× the
// frame metre→px scale) but is CLAMPED to a px band (below) so it stays a readable position MARKER. It is NOT tied
// to the unit's own placement rect — that rect is re-fitted by moveResize on every drag, which made the pin change
// size each time you moved it. A fixed metre size is stable across a move.
const PIN_RADIUS_MIN_PX = 14; // never vanish at tiny zoom
const PIN_RADIUS_MAX_PX = 38; // never balloon on a zoomed-in floor

type Drag =
  | { mode: "move"; id: string; startX: number; startY: number; orig: Rect }
  | { mode: "resize"; id: string; orig: Rect }
  | { mode: "vertex"; id: string; index: number }
  | { mode: "self-vertex"; id: string; index: number; min: { x: number; y: number }; span: { x: number; y: number } } // edit the FOCUSED node's own vertex (display is self-normalized → map back to stored by display*span+min)
  | { mode: "facing"; id: string; cx: number; cy: number } // drag the arrow tip; cx/cy = node centre in px
  | { mode: "rotate"; id: string; cx: number; cy: number } // drag the rotate knob; cx/cy = unit centre in px → angle = rotationDeg
  | { mode: "camera-move"; id: string } // drag the camera pin (writes x/y in frame fractions)
  | { mode: "camera-aim"; id: string; ax: number; ay: number } // drag the aim handle; ax/ay = pin px
  | { mode: "draw"; startX: number; startY: number }
  | { mode: "marker"; unitId: string; index: number; end?: "a" | "b" } //  slice 5 — drag a door/window/wall
  | { mode: "pan"; startX: number; startY: number; orig: { panX: number; panY: number } } // Space/middle-drag to pan the world
  | null;

export function Canvas({ pack, geo }: { pack: Pack; geo: GeoApi }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [drawRect, setDrawRect] = useState<Rect | null>(null);
  // (perf) during a move/resize drag, hold the dragged RECT node's live position LOCALLY and commit to the
  // store only on mouseUp — so we don't re-run projectToPackAll (the whole 193-unit tree) on every mousemove frame
  // (: "snappy + heavy, want smooth + light on CPU"). { id, rect } while dragging; null otherwise.
  const [liveRect, setLiveRect] = useState<{ id: string; rect: Rect } | null>(null);
  const [snap, setSnap] = useState(true); // §4b: default snap units to building-wide columns; toggle to nudge off-grid
  // (slice 5) plan DETAILING — the active marker tool + the pending first click of a 2-click wall. Markers go
  // on the FOCUSED unit's SUBTYPE plan (you focus INTO a unit → its plan is the frame → drop doors/windows/walls).
  const [markerTool, setMarkerTool] = useState<"door" | "window" | "wall" | null>(null);
  const [wallStart, setWallStart] = useState<{ x: number; y: number } | null>(null);
  const markerMoved = useRef(false); // distinguishes a marker DRAG (don't remove on mouseup) from a click (remove)

  // (B3b "the world") the Adobe pan/zoom viewport over the aspect-fitted frame. zoom=1/pan=0 = the untransformed
  // frame (B3a's per-focus fit). Space holds pan-mode (like a design tool); wheel zooms about the cursor.
  const [vp, setVp] = useState<Viewport>(IDENTITY_VP);
  const [spaceHeld, setSpaceHeld] = useState(false);
  // reset the viewport to identity whenever the FOCUS changes — each level opens framed-to-fit, then the user can
  // pan/zoom within it (the "stable viewport, no auto-fit jitter" rule holds: we only reset on an explicit focus change).
  const lastFocusRef = useRef<string | undefined>(geo.focusId);
  if (lastFocusRef.current !== geo.focusId) {
    lastFocusRef.current = geo.focusId;
    if (vp !== IDENTITY_VP) setVp(IDENTITY_VP);
  }
  // Space = pan modifier (held). Listen on window so it works regardless of focus; ignore while typing in a field.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.code === "Space") { setSpaceHeld(true); e.preventDefault(); return; }
      // (polish) Esc = ZOOM OUT ONE LEVEL — the Adobe-world convention: back out of the focused node to its
      // parent (unit→floor→building→land→root), deselecting as we go. Reads the CURRENT focus via a ref so the []-dep
      // listener never goes stale. A no-op at the root (nothing above to back out to).
      if (e.code === "Escape") { zoomOutRef.current(); e.preventDefault(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const focusNode = nodeById(pack, geo.focusId);
  // (polish) keep a live "zoom out one level" fn behind a ref so the []-dep keydown listener always runs the
  // current one. Esc focuses the focused node's PARENT (or clears focus at a root node); always clears selection.
  const zoomOutRef = useRef<() => void>(() => {});
  zoomOutRef.current = () => {
    geo.selectNode(undefined);
    if (focusNode?.parentId) geo.focus(focusNode.parentId);
    else if (geo.focusId) geo.focus(undefined);
  };
  const children = geo.focusId ? childrenOf(pack, geo.focusId) : rootNodes(pack);
  const childKind = nextChildKind(pack, geo.focusId);

  // (slice 5) marker detailing is active when we've FOCUSED INTO a unit that has a plan — the RefFrame shows
  // its plan and the frame IS the unit's own 0..1 space, so dropped markers land in the right coordinates.
  const planUnit = focusNode?.kind === "unit" ? focusNode : undefined;
  const unitPlan = planUnit ? resolvePlan(pack, planUnit) : undefined;
  const markers = unitPlan?.markers ?? [];
  const planDetailing = !!planUnit && !!unitPlan;
  const activeTool = planDetailing ? markerTool : null; // a tool is only live while we're inside a plan

  // (Slice D) we FOCUSED INTO a unit that still has NO polygon (it was a pin on the floor) → the frame is empty
  // and there's nothing to measure. Offer a loud call-to-action to AUTHOR its real shape: toPoly seeds an editable
  // quad (from the subtype's shared plan if one exists, else the pin's box) → the measured-edge editor takes over
  // (drag corners + set each edge's metres in the inspector). This is the pin→polygon bridge (D-): the authored
  // poly then REPLACES the pin on the floor. Not shown once the unit already has a poly (then it's just editing).
  //  a unit "needs a shape" only if NEITHER its own footprint NOR its shared SUBTYPE PLAN is a polygon —
  // a subtype's authored shape belongs to EVERY unit of that type (D-), so resolve through effectiveFootprint,
  // never the bare node.footprint (that was the Floor-4-Studio-B-stayed-a-pin bug).
  const focusedUnitNeedsShape = focusNode?.kind === "unit" && effectiveFootprint(pack, focusNode)?.shape !== "poly";

  // (#4) LEVEL ISOLATION — when several children fill the whole frame they STACK (e.g. every floor is a
  // full-frame rect, so their labels + outlines pile up and you can't edit one level). If ≥2 children stack AND
  // one is selected, we render ONLY the selected one (level-by-level editing); deselecting shows them all again.
  //  "fills the plate" — a floor that occupies essentially the whole frame, so stacking it in the building
  // view just buries the footprint. The old threshold (x/y ≤ 0.02, w/h ≥ 0.96) was TOO STRICT: Skyline's floors are
  // authored with a small inset (bbox 0.04–0.96 → span 0.92), so NONE matched → all 20 floors rendered stacked as a
  // solid orange block over the building footprint. Loosen to a sane inset tolerance: any floor whose
  // footprint starts near the origin and spans most of the frame counts as a full plate.
  const isFullFrame = (n: GeoNode) => {
    const r = footprintRect(n.footprint);
    return r.x <= 0.08 && r.y <= 0.08 && r.w >= 0.85 && r.h >= 0.85;
  };
  const stackingCount = children.filter(isFullFrame).length;
  const selectedIsStacking = !!geo.selectedId && children.some((n) => n.id === geo.selectedId && isFullFrame(n));
  const stackIsolateActive = stackingCount >= 2 && selectedIsStacking;

  // (Slice A) BUILDING VIEW = edit the building FOOTPRINT over the land, NOT a pile of identical floors. Every
  // floor is the same constant plate (D-), so at the building level the 34 full-frame floor blocks bury the
  // footprint + the land backdrop (the screenshot-2 complaint). Hide the full-frame floor children here — you
  // dive INTO a floor to work on it. Non-full-frame children (a floor the user has reshaped smaller) still show.
  const hideStackedFloors = focusNode?.kind === "building";

  // The real aspect (w/h) of the FOCUSED node, so the frame is drawn true-to-proportion. At the
  // root (no focus) there's no single node — use the land's aspect if one exists, else none (square-free panel).
  // (: "auto sizing of the entire viewport on any change of objects — waste and confusing") the aspect
  // is FROZEN PER FOCUS: we compute it once when the focus changes and HOLD it while you edit inside that focus, so
  // dragging a vertex (which changes the node's realMetres) no longer resizes/reflows the whole frame mid-edit. It
  // re-measures only when you navigate to a different node. (Pan/zoom is the user's explicit viewport control.)
  const liveAspect = (() => {
    const rm = geo.focusId ? realMetres(pack, geo.focusId) : realMetres(pack, rootNodes(pack).find((n) => n.kind === "land")?.id);
    return rm && rm.w > 0 && rm.h > 0 ? rm.w / rm.h : undefined;
  })();
  const aspectRef = useRef<{ focusId: string | undefined; aspect: number | undefined }>({ focusId: geo.focusId, aspect: liveAspect });
  if (aspectRef.current.focusId !== geo.focusId) {
    aspectRef.current = { focusId: geo.focusId, aspect: liveAspect };
  } else if (aspectRef.current.aspect === undefined && liveAspect !== undefined) {
    // first time the metre anchor becomes known for this focus (e.g. land traced) — adopt it, then hold.
    aspectRef.current = { focusId: geo.focusId, aspect: liveAspect };
  }
  const frameAspect = aspectRef.current.aspect;

  // (D- STEP 2) the focused node's real metre EXTENT, frozen per-focus the same way the aspect is (anti-jitter:
  // editing a vertex changes realMetres, but we hold the frame stable until you navigate to a different node). The
  // metre-native frame fits THIS extent by one uniform scale. Frozen alongside the aspect so the two never disagree.
  const liveMetres = geo.focusId
    ? realMetres(pack, geo.focusId)
    : realMetres(pack, rootNodes(pack).find((n) => n.kind === "land")?.id);
  const metresRef = useRef<{ focusId: string | undefined; metres: { w: number; h: number } | undefined }>({ focusId: geo.focusId, metres: liveMetres });
  if (metresRef.current.focusId !== geo.focusId) {
    metresRef.current = { focusId: geo.focusId, metres: liveMetres };
  } else if (metresRef.current.metres === undefined && liveMetres !== undefined) {
    metresRef.current = { focusId: geo.focusId, metres: liveMetres }; // anchor just became known — adopt, then hold
  }
  const frameMetresFrozen = metresRef.current.metres;

  // (D- STEP 2) THE ONE place the base (pre-vp) frame is computed — flag-gated. ON → metre-native (uniform
  // metre→px scale over the frozen metre extent); OFF → the aspect-letterbox. Every projection/hit-test reads
  // this, so the flag flips the whole render coherently and the two paths can never drift apart within a frame.
  const baseFrame = useCallback(
    (box: { width: number; height: number }): FrameBox =>
      METRE_NATIVE_RENDER ? metreFrameBox(box, frameMetresFrozen, frameAspect) : frameBox(box, frameAspect),
    [frameMetresFrozen, frameAspect]
  );

  // Column-snap a unit rect to its SIBLINGS' edges (exclude the one being edited). Only active for units.
  const snapUnitRect = useCallback(
    (r: Rect, selfId?: string): Rect => {
      if (!snap || childKind !== "unit") return r;
      const sibs = children.filter((n) => n.kind === "unit" && n.id !== selfId).map((n) => footprintRect(n.footprint));
      return snapToColumns(r, sibs);
    },
    [snap, childKind, children]
  );

  // frame rect in px — a 0..1 box occupies the padded viewport, THEN the viewport transform (zoom/pan) is applied.
  // We read the live SVG size at event time. toPx/toFrac go through viewFrame so hit-tests + projections use
  // the SAME transformed frame the renderers draw into — they can never drift from the displayed world.
  const toPx = useCallback((r: Rect, box: DOMRect) => {
    const f = viewFrame(baseFrame(box), box, vp);
    return { x: f.x + r.x * f.w, y: f.y + r.y * f.h, w: r.w * f.w, h: r.h * f.h };
  }, [baseFrame, vp]);
  const toFrac = useCallback((px: number, py: number, box: DOMRect) => {
    const f = viewFrame(baseFrame(box), box, vp);
    return { x: (px - f.x) / f.w, y: (py - f.y) / f.h };
  }, [baseFrame, vp]);

  const box = () => svgRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 800, 600);
  const localXY = (e: React.MouseEvent) => {
    const b = box();
    return { x: e.clientX - b.left, y: e.clientY - b.top, b };
  };

  //  start a world-pan from a mouse event (Space-hand / middle-drag). Shared so pan works over a child too.
  const startPan = (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = localXY(e);
    setDrag({ mode: "pan", startX: x, startY: y, orig: { panX: vp.panX, panY: vp.panY } });
  };

  const onChildDown = (e: React.MouseEvent, n: GeoNode) => {
    e.stopPropagation();
    if (spaceHeld || e.button === 1) { startPan(e); return; } // Space-hand pans even over a node
    geo.selectNode(n.id);
    if (n.locked) return; // a locked shape selects but doesn't drag (unlock to move it)
    //  a POLYGON is edited VERTEX-ONLY — dragging its BODY must NOT move it (that collapsed it to a
    // square + made it easy to knock a placed footprint out of position). Body-down on a poly just SELECTS; only the
    // corner handles move points. Rect nodes still drag-to-move (that's how you position a unit box).
    if (n.footprint?.shape === "poly") return;
    const { x, y } = localXY(e);
    setDrag({ mode: "move", id: n.id, startX: x, startY: y, orig: footprintRect(n.footprint) });
  };
  const onResizeDown = (e: React.MouseEvent, n: GeoNode) => {
    e.stopPropagation();
    geo.selectNode(n.id);
    setDrag({ mode: "resize", id: n.id, orig: footprintRect(n.footprint) });
  };
  const onCanvasDown = (e: React.MouseEvent) => {
    //  PAN — Space held OR middle mouse button → drag the world. Takes priority over draw/marker/deselect.
    if (spaceHeld || e.button === 1) { startPan(e); return; }
    // (slice 5) a marker tool is active → a click DROPS a marker into the plan (instead of drawing a child).
    // Door/window = one click; wall = click start, then click end. Points are the plan's own 0..1 fractions.
    if (activeTool && planUnit) {
      const { x, y, b } = localXY(e);
      const fr = toFrac(x, y, b);
      const at = { x: Math.max(0, Math.min(1, fr.x)), y: Math.max(0, Math.min(1, fr.y)) };
      if (activeTool === "wall") {
        if (!wallStart) { setWallStart(at); return; }
        geo.addMarker(planUnit.id, { kind: "wall", a: wallStart, b: at });
        setWallStart(null);
        return;
      }
      geo.addMarker(planUnit.id, { kind: activeTool, at });
      return;
    }
    if (!childKind) return; // max depth — nothing to draw
    const { x, y } = localXY(e);
    setDrag({ mode: "draw", startX: x, startY: y });
  };

  // vertex handlers (a selected poly shows draggable corners + midpoint add-dots)
  const onVertexDown = (e: React.MouseEvent, id: string, index: number) => {
    e.stopPropagation();
    geo.selectNode(id);
    setDrag({ mode: "vertex", id, index });
  };

  // (spine) FOCUSED-NODE vertex drag. The focused node fills the view self-normalized (bbox→0..1), but its
  // STORED points live in the parent's frame. So capture the node's bbox {min,span}; onMove maps the display point
  // (0..1 in the focus frame) back to a stored point by display*span+min, then writes via geo.moveVertex.
  const onSelfVertexDown = (e: React.MouseEvent, id: string, index: number, min: { x: number; y: number }, span: { x: number; y: number }) => {
    e.stopPropagation();
    geo.selectNode(id);
    setDrag({ mode: "self-vertex", id, index, min, span });
  };

  // facing handle: drag the arrow tip around the node centre to set facingDeg. cx/cy = centre in px.
  const onFacingDown = (e: React.MouseEvent, id: string, cx: number, cy: number) => {
    e.stopPropagation();
    geo.selectNode(id);
    setDrag({ mode: "facing", id, cx, cy });
  };

  // rotate knob: drag it around the unit centre to set the unit's on-floor rotation. cx/cy = centre in px.
  const onRotateDown = (e: React.MouseEvent, id: string, cx: number, cy: number) => {
    e.stopPropagation();
    geo.selectNode(id);
    setDrag({ mode: "rotate", id, cx, cy });
  };

  // camera handles: drag the pin to move the viewpoint; drag the aim handle to rotate it. ax/ay = pin px.
  const onCameraMoveDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    geo.selectNode(id);
    setDrag({ mode: "camera-move", id });
  };
  const onCameraAimDown = (e: React.MouseEvent, id: string, ax: number, ay: number) => {
    e.stopPropagation();
    geo.selectNode(id);
    setDrag({ mode: "camera-aim", id, ax, ay });
  };

  const onMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const { x, y, b } = localXY(e);
    if (drag.mode === "move") {
      //  only RECT nodes reach move mode (a poly body-down is select-only). Update the LOCAL live rect only —
      // no store write per frame (smooth + light on CPU); the real commit happens once on mouseUp.
      const d = toFrac(x, y, b);
      const s = toFrac(drag.startX, drag.startY, b);
      setLiveRect({ id: drag.id, rect: { x: drag.orig.x + (d.x - s.x), y: drag.orig.y + (d.y - s.y), w: drag.orig.w, h: drag.orig.h } });
    } else if (drag.mode === "resize") {
      const f = toFrac(x, y, b);
      setLiveRect({ id: drag.id, rect: { x: drag.orig.x, y: drag.orig.y, w: f.x - drag.orig.x, h: f.y - drag.orig.y } });
    } else if (drag.mode === "vertex") {
      geo.moveVertex(drag.id, drag.index, toFrac(x, y, b));
    } else if (drag.mode === "self-vertex") {
      // display (0..1 in the focus frame) → stored point in the parent frame: display*span + min
      const disp = toFrac(x, y, b);
      geo.moveVertex(drag.id, drag.index, { x: disp.x * drag.span.x + drag.min.x, y: disp.y * drag.span.y + drag.min.y });
    } else if (drag.mode === "marker") {
      markerMoved.current = true; // a real drag → suppress the click-to-remove on mouseup
      const f = toFrac(x, y, b);
      const at = { x: Math.max(0, Math.min(1, f.x)), y: Math.max(0, Math.min(1, f.y)) };
      geo.moveMarker(drag.unitId, drag.index, drag.end ? { [drag.end]: at } : { at });
    } else if (drag.mode === "facing") {
      geo.setFacing(drag.id, facingFromVector(drag.cx, drag.cy, x, y));
    } else if (drag.mode === "rotate") {
      //  the knob's bearing from the unit centre IS the rotation angle (0 = up/north, clockwise) — same
      // convention as facing. renderFootprint rotates the shared shape about the centre by this much.
      geo.setRotation(drag.id, facingFromVector(drag.cx, drag.cy, x, y));
    } else if (drag.mode === "camera-move") {
      geo.patchCamera(drag.id, toFrac(x, y, b)); // pin follows the cursor (clamped to 0..1 in the store)
    } else if (drag.mode === "camera-aim") {
      geo.patchCamera(drag.id, { facingDeg: facingFromVector(drag.ax, drag.ay, x, y) });
    } else if (drag.mode === "pan") {
      //  shift the world by the raw px delta — pan is in screen space, independent of zoom.
      setVp((v) => ({ ...v, panX: drag.orig.panX + (x - drag.startX), panY: drag.orig.panY + (y - drag.startY) }));
    } else if (drag.mode === "draw") {
      const a = toFrac(drag.startX, drag.startY, b);
      const c = toFrac(x, y, b);
      setDrawRect({ x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) });
    }
  };

  const onUp = () => {
    if (drag?.mode === "draw" && drawRect && drawRect.w > 0.02 && drawRect.h > 0.02 && childKind) {
      const id = geo.addChild(childKind);
      geo.moveResize(id, snapUnitRect(drawRect, id));
    } else if (drag?.mode === "draw" && (!drawRect || drawRect.w <= 0.02 || drawRect.h <= 0.02)) {
      //  a bare click on empty canvas (no real drag-rect) = DESELECT (Adobe "click empty to deselect").
      if (geo.selectedId) geo.selectNode(undefined);
    } else if ((drag?.mode === "move" || drag?.mode === "resize") && drag.id && liveRect && liveRect.id === drag.id) {
      // (perf) COMMIT the drag ONCE here — the single projectToPackAll for the whole gesture, not per frame.
      // Settle onto the column grid on release (soft snap — no-op when snap is off / not a unit).
      geo.moveResize(drag.id, snapUnitRect(liveRect.rect, drag.id));
    }
    setLiveRect(null);
    setDrag(null);
    setDrawRect(null);
  };

  //  WHEEL = zoom about the cursor — the frame-fraction under the pointer stays put (standard design-tool
  // feel). The cursor maps to fraction frac=(s−f.x)/f.w in the CURRENT frame; after zooming we choose pan so the
  // SAME fraction lands back under s: f.x' = s − frac·f.w', and pan' = f.x' − pivot(z'). (The pivot term depends on
  // z, so pan'=s−k·(s−pan) was wrong — it ignored the pivot's z-change; here we recompute against the real frame.)
  const onWheel = (e: React.WheelEvent) => {
    const { x, y, b } = localXY(e);
    const base = baseFrame(b);
    const cxv = b.width / 2, cyv = b.height / 2;
    setVp((v) => {
      const z2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom * Math.exp(-e.deltaY * 0.0015)));
      const fNow = viewFrame(base, b, v);
      const fracX = fNow.w > 0 ? (x - fNow.x) / fNow.w : 0;
      const fracY = fNow.h > 0 ? (y - fNow.y) / fNow.h : 0;
      // desired new frame top-left so (x,y) stays at the same fraction, then back out pan from the pivot form.
      const newW = base.w * z2, newH = base.h * z2;
      const newFx = x - fracX * newW, newFy = y - fracY * newH;
      const panX = newFx - (cxv + (base.x - cxv) * z2);
      const panY = newFy - (cyv + (base.y - cyv) * z2);
      return { zoom: z2, panX, panY };
    });
  };

  //  FRAME — fit the viewport to the SELECTED node (or the focus if none selected). The selected node lives
  // the current frame at a known rect; we compute the zoom+pan that centres it with padding. FRAME ALL = identity
  // (the aspect-fitted frame already shows the whole focused level — B3a).
  const frameSelection = () => {
    const sel = geo.selectedId ? nodeById(pack, geo.selectedId) : undefined;
    const b = box();
    const base = baseFrame(b);
    if (!sel || base.w <= 0 || base.h <= 0) { setVp(IDENTITY_VP); return; }
    // the selected node's rect in the UNTRANSFORMED frame (0..1 → base px)
    const r = footprintRect(sel.footprint);
    const rx = base.x + r.x * base.w, ry = base.y + r.y * base.h;
    const rw = Math.max(1, r.w * base.w), rh = Math.max(1, r.h * base.h);
    const cx = b.width / 2, cy = b.height / 2;
    // zoom so the node fills ~70% of the viewport's smaller axis
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min((b.width * 0.7) / rw, (b.height * 0.7) / rh)));
    // centre the node: after scale-about-centre by z then +pan, the node centre must land on the viewport centre.
    const ncx = rx + rw / 2, ncy = ry + rh / 2;
    const panX = cx - (cx + (ncx - cx) * z);
    const panY = cy - (cy + (ncy - cy) * z);
    setVp({ zoom: z, panX, panY });
  };

  const b0 = box();
  //  the aspect-correct, centred drawing frame in px, THEN the pan/zoom viewport transform. Every renderer
  // reading box={fb0} (ancestors, the self RefFrame, poly bodies/handles, markers, props, the grid) draws into this
  // one transformed frame → pan/zoom moves the whole world coherently with zero per-consumer wiring.
  const fb0 = viewFrame(baseFrame(b0), b0, vp);
  // (B3 "the world") the focused frame's REAL metre size, so the metric grid draws at a true metre step and
  // the legend reads the scale. At the root (no focus) fall back to the land's metres. undefined → no metre anchor
  // yet → no grid (the frame still draws). metreW/H span exactly fb0.w/fb0.h px, so the metre→px scale is fb0.w/mW.
  // (D- STEP 2) when metre-native render is ON, the frame IS the frozen metre extent fitted by one uniform
  // scale, so sx === sy by construction — frameMetres is simply that extent, and the reconcile-hack (below,
  // kept for the OFF path) is unnecessary: the grid honesty the hack chased is now structural, not patched.
  const frameMetres = METRE_NATIVE_RENDER
    ? frameMetresFrozen
    : (() => {
        const realFrameMetres = geo.focusId
          ? realMetres(pack, geo.focusId)
          : realMetres(pack, rootNodes(pack).find((n) => n.kind === "land")?.id);
        // (grid-honesty fix — caught it) the frame box fb0 is drawn to the FROZEN `frameAspect` (
        // anti-jitter), but realMetres keeps changing as you edit → frame-aspect and metre-aspect DIVERGE mid-edit,
        // so a naive grid gets sx≠sy: squares become rectangles and the "N m" legend (which only tracks the X step)
        // lies. Reconcile: the metre extent the frame ACTUALLY depicts has the frozen aspect — keep the real width,
        // derive the height from frameAspect (w/h = aspect). Then sx === sy by construction: honest legend, no jitter.
        return realFrameMetres && frameAspect && frameAspect > 0
          ? { w: realFrameMetres.w, h: realFrameMetres.w / frameAspect }
          : realFrameMetres;
      })();
  // (Slice C) px-per-metre in the CURRENT frame (fb0.w spans frameMetres.w). A unit PIN is a fixed 4 m radius
  // in floor-metre space, so pinRadiusPx = PIN_RADIUS_M × this scale → it scales with the grid at any zoom. undefined
  // (no metre anchor) → fall back to a modest fixed px so pins still render on a floor without a traced parcel.
  const metrePxX = frameMetres && frameMetres.w > 0 ? fb0.w / frameMetres.w : undefined;

  return (
    <div className="mm-canvas-wrap">
      <Breadcrumb pack={pack} geo={geo} focusNode={focusNode} />

      <div className="mm-canvas-host">
        <svg
          ref={svgRef}
          className={`mm-canvas ${spaceHeld || drag?.mode === "pan" ? "is-panning" : ""}`}
          onMouseDown={onCanvasDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          onWheel={onWheel}
        >
          {/* the frame = the focused node's interior, at its TRUE aspect — letterboxed + centred so
              the drawn shape matches the real metre proportions (and the map), not stretched to the panel. */}
          <rect className="mm-canvas__frame" x={fb0.x} y={fb0.y} width={Math.max(0, fb0.w)} height={Math.max(0, fb0.h)} />

          {/* (B3 "the world") the METRIC GRID — squares at a real metre step over the frame, so the author
              reads SIZE at a glance (the pin/shape sizes mean something). Clipped to the frame; pointer-events none
              so it never intercepts a drag/select. A scale LEGEND (below, in the overlay) names the square. */}
          <MetreGrid frame={fb0} metres={frameMetres} />

          {/* (slice 5) TRACE-OVER backdrop — the architect's floor-plan image, dim behind the plan, so the
              author can trace the real shape + place markers over it. Reference only (never exported). */}
          {planDetailing && unitPlan?.backdrop && (
            <image
              href={unitPlan.backdrop.dataUrl}
              x={fb0.x} y={fb0.y} width={Math.max(0, fb0.w)} height={Math.max(0, fb0.h)}
              //  PRESERVE the image's real proportions — a trace-over reference MUST NOT be stretched to the
              // frame (a wide floor-plan squashed into a near-square plan frame deformed it, caught it live).
              // "meet" letterboxes: fit inside the frame, centred, aspect kept — the only correct mode for tracing.
              preserveAspectRatio="xMidYMid meet" opacity={0.32} pointerEvents="none"
            />
          )}

          {/* (slice C) TITLE-DEED reference — the surveyed plot drawing, dim behind the LAND in its own focus
 view, so the author traces the real parcel over it (the authority is the deed, not the map).
              Same letterbox contract as the unit trace backdrop — never stretched. Reference only, never exported. */}
          {focusNode?.kind === "land" && focusNode.deedImage && (
            <image
              href={focusNode.deedImage.dataUrl}
              x={fb0.x} y={fb0.y} width={Math.max(0, fb0.w)} height={Math.max(0, fb0.h)}
              preserveAspectRatio="xMidYMid meet" opacity={0.32} pointerEvents="none"
            />
          )}

          {/* (Slice B) CUMULATIVE ANCESTOR STACK — every ancestor of the focused node, drawn behind it, framing
              it (deeper = more context: a floor shows building + land; a unit shows floor + building + land). Each is
              kind-coloured (land=blue, building=green, floor=yellow) + labelled, dim + locked. Points fall outside
              0..1 (ancestors are bigger) — vPx maps them linearly, clipped by the SVG viewport.
  EXCEPTION — a focused UNIT shows ONLY its own shape: editing a unit is about the unit's
              plan, not where it sits on the floor (that's the floor view's job). So we drop the ancestor frames here
              — no land/building/floor outlines behind the unit, just the clean plan to trace + detail. */}
          {focusNode && focusNode.kind !== "unit" && <AncestorStack pack={pack} focusId={focusNode.id} box={fb0} />}

          {/* (spine) THE FOCUSED NODE'S OWN SHAPE — selectable + lock-gated editable in its own view. Click
              to select it; when selected + UNLOCKED, its vertices appear (self-normalized display, mapped back to
              stored points on drag). This is what makes every level editable (building/floor/unit). Locked or
              unselected → just the kind-coloured outline (the old RefFrame). */}
          {focusNode && (
            <PolyEditor
              node={focusNode}
              box={fb0}
              mode="focus"
              selected={geo.selectedId === focusNode.id}
              editable={geo.selectedId === focusNode.id && !focusNode.locked}
              onSelect={() => geo.selectNode(focusNode.id)}
              onVertexDown={onSelfVertexDown}
              onEdgeAdd={(e, id, i) => { e.stopPropagation(); geo.addVertex(id, i); }}
              edgeMetres={edgeLengthsMetres(pack, focusNode.id)}
              footprint={effectiveFootprint(pack, focusNode)}
            />
          )}

          {/* (slice 5) DOOR / WINDOW / WALL markers on the unit plan (shared across the subtype). */}
          {planDetailing && planUnit && (
            <PlanMarkers
              markers={markers}
              box={fb0}
              tool={activeTool}
              onMarkerDown={(e, i, end) => { e.stopPropagation(); if (!activeTool) { markerMoved.current = false; setDrag({ mode: "marker", unitId: planUnit.id, index: i, end }); } }}
              onRemove={(i) => { if (!markerMoved.current) geo.removeMarker(planUnit.id, i); }}
            />
          )}

          {children.map((n) => {
            // (#4) LEVEL ISOLATION — floors (and any siblings) that fill the whole frame STACK on top of each
            // other, so their outlines + labels overlap and you can't read/edit one level. When several siblings
            // fill the frame AND one is selected, show ONLY the selected one; deselect to see them all again. This
            // is 's "select level by level and edit its plan while the other levels are hidden".
            if (stackIsolateActive && n.id !== geo.selectedId) return null;
            // (the final call) the BUILDING view shows the footprint over the land — NO floors drawn (the
            // 34 identical plates just clutter). You EDIT a floor by going INTO its own view (double-click → the floor
            // is focused over the building+land backdrop → unlock → edit its vertices). edit-in-own-view, one at a time.
            if (hideStackedFloors && n.kind === "floor" && isFullFrame(n)) return null;
            // (perf) while THIS node is being dragged, render from the LOCAL live rect (no store write per frame)
            const baseRect = liveRect && liveRect.id === n.id ? liveRect.rect : footprintRect(n.footprint);
            const r = toPx(baseRect, b0);
            const selected = geo.selectedId === n.id;
            const sqm = deriveSqm(pack, n.id);
            // (Slice B) a UNIT reads as light-purple (its KIND) so it's distinct from the green building /
            // yellow floor layers; its STATUS is shown as a small corner dot instead of driving the box colour.
            const statusColor = n.kind === "unit" && n.status ? STATUS_FILL[n.status] : undefined;
            const fill = n.kind === "unit" ? "var(--mm-kind-unit)" : undefined;
            // (D-) RESOLVE the render footprint: a unit bound to a subtype draws its subtype's shared SHAPE
            // placed at its OWN position (renderFootprint), so authoring one Studio B shapes EVERY Studio B — each at
            // its own spot, not overlapping. Non-units / unplanned units → their own footprint. isPoly + the points
            // the poly renderers draw BOTH read this one resolved footprint, so a bound unit can never be "not a pin"
            // yet have no shape to draw (the scatter that stranded Floor 4's Studio B as a pin).
            const efp = renderFootprint(pack, n);
            const hasPoly = efp?.shape === "poly";
            const isProp = n.kind === "prop";
            const locked = n.locked === true; // a locked shape shows no edit handles
            // (D-) MARKERS-FIRST LEVEL VIEW. A unit that HAS a real polygon still draws as a MARKER on the
            // level overview until it's part of the official plan — otherwise an imported building reads as a wall of
            // overlapping semi-transparent room fills ("full pink floor"). A unit shows its real SHAPE here iff it's
            // APPROVED (brought into the plan, D- pt2) OR its `representation` override forces "shape" (pt3). The
            // override can also force a shape BACK to a marker. The FOCUSED unit is drawn by the separate focus path
            // above, so drilling in always shows/edits the shape regardless of this overview choice.
            const showAsShape = unitShownAsShape(n, hasPoly); // pure decision (lib/geo), tested
            // non-units draw their poly as before; a unit draws as a poly only when it's shown as a shape (else a pin).
            const isPoly = n.kind === "unit" ? showAsShape : hasPoly;
            // (Slice C — the units=PINS reframe, D-) a UNIT drawn as a POSITION (no shape yet, or held as
            // a marker) → a round PIN (a 4 m-radius metre-space dot + number/m² label), movable, NOT resizable.
            // Double-click → focus the unit → author/approve its real polygon. So: unit && !showAsShape → pin.
            const isUnitPin = n.kind === "unit" && !showAsShape;
            return (
              <g key={n.id} className={`mm-geo mm-geo--${n.kind} ${selected ? "is-selected" : ""} ${locked ? "is-locked" : ""}`}>
                {isProp ? (
                  // §4d LOD: a prop is DATA, not a mesh — a schematic icon + "name · $price", not a status box.
                  <PropBody
                    node={n}
                    box={fb0}
                    onBodyDown={(e) => onChildDown(e, n)}
                  />
                ) : isUnitPin ? (
                  // (Slice C) a shapeless unit = a PIN: a 4 m metre-space dot + number/m² label at the unit's
                  // placed centre. Movable (drag the dot), NOT resizable. Double-click → author its real polygon.
                  <UnitPin
                    centerX={r.x + r.w / 2}
                    centerY={r.y + r.h / 2}
                    //  radius = a fixed METRE size × the frame's metre→px scale → it grows with ZOOM but is
                    // INDEPENDENT of the unit's own placement rect. (Earlier it was 44% of the cell `r`, but a bound
                    // unit's rect is re-fitted by moveResize on every drag → the pin changed size each time you moved
                    // it.: "each time i move them they seem to change size." The metre size is stable across a
                    // move.) Clamped to a readable px band.
                    radiusPx={Math.max(PIN_RADIUS_MIN_PX, Math.min(PIN_RADIUS_MAX_PX, metrePxX ? PIN_RADIUS_M * metrePxX : 16))}
                    label={clipLabel(n.name, 160)}
                    sqm={sqm}
                    statusColor={statusColor}
                    statusLabel={n.status ? STATUS_LABEL[n.status] : undefined}
                    selected={selected}
                    onBodyDown={(e) => onChildDown(e, n)}
                    onDouble={() => geo.focus(n.id)}
                  />
                ) : isPoly ? (
                  <PolyBody
                    node={n}
                    box={fb0}
                    fill={fill}
                    footprint={efp}
                    onBodyDown={(e) => onChildDown(e, n)}
                    onDouble={() => geo.focus(n.id)}
                  />
                ) : (
                  <rect
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                    rx={4}
                    className="mm-geo__rect"
                    style={fill ? { fill, fillOpacity: 0.55, stroke: fill } : undefined}
                    onMouseDown={(e) => onChildDown(e, n)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      geo.focus(n.id);
                    }}
                  />
                )}
                {/* (Slice B) STATUS DOT — a unit's box colour is its KIND (light purple); its status is this
                    small dot (available/reserved/sold…), so kind + status both read without clashing.
  sits RIGHT BEFORE the unit label (top-left), not floating on the opposite corner —
                    dot + name read as one tag. Falls back to the top-left corner when the box is too small for a label.
  a PIN carries its own status dot + label, so skip the generic ones for a pin. */}
                {n.kind === "unit" && !isUnitPin && statusColor && r.w >= 20 && r.h >= 16 && (
                  <circle cx={r.x + 11} cy={r.y + 12} r={4} fill={statusColor} stroke="var(--panel)" strokeWidth={1} pointerEvents="none">
                    <title>{n.status ? STATUS_LABEL[n.status] : ""}</title>
                  </circle>
                )}
                {/* label legibility: only draw the name on a box tall/wide enough; m² sub-line needs more room.
                    Props carry their own label inside PropBody (name · price), so skip the generic labels.
  a THIN stacked floor only labels itself when SELECTED — else 34 identical labels pile up.
  a PIN draws its own label beside the dot — skip the generic box label. */}
                {!isProp && !isUnitPin && r.h >= 18 && r.w >= 34 && (() => {
                  //  when a unit shows a status dot, start the name AFTER it so dot + name read as one tag;
                  // otherwise keep the label flush-left at the usual inset.
                  const hasDot = n.kind === "unit" && statusColor && r.w >= 20 && r.h >= 16;
                  const labelX = hasDot ? r.x + 20 : r.x + 6;
                  return (
                    <text x={labelX} y={r.y + 16} className="mm-geo__label">
                      {clipLabel(n.name, r.w - (hasDot ? 14 : 0))}
                    </text>
                  );
                })()}
                {!isProp && !isUnitPin && sqm != null && r.h >= 34 && r.w >= 60 && (
                  <text x={r.x + 6} y={r.y + 30} className="mm-geo__sub">
                    {sqm.toLocaleString()} m²{n.kind === "unit" && n.status ? ` · ${STATUS_LABEL[n.status]}` : ""}
                  </text>
                )}
                {/* rect resize handle — hidden when the shape is locked OR it's a pin (a pin has no size to resize) */}
                {selected && !isPoly && !isUnitPin && !locked && (
                  <rect
                    x={r.x + r.w - HANDLE}
                    y={r.y + r.h - HANDLE}
                    width={HANDLE}
                    height={HANDLE}
                    className="mm-geo__handle"
                    onMouseDown={(e) => onResizeDown(e, n)}
                  />
                )}
                {/* poly vertex + edge handles (selected + unlocked only) */}
                {selected && isPoly && !locked && n.footprint?.shape === "poly" && (
                  <PolyEditor
                    node={n}
                    box={fb0}
                    mode="child"
                    editable
                    footprint={n.footprint}
                    frozenVerts={n.footprint.frozenVerts}
                    frozenEdges={n.footprint.frozenEdges}
                    onVertexDown={(e, id, i) => onVertexDown(e, id, i)}
                    onVertexContext={(e, id, i) => { e.preventDefault(); geo.toggleFreezeVert(id, i); }}
                    onVertexDouble={(e, id, i) => { e.stopPropagation(); geo.removeVertex(id, i); }}
                    onEdgeContext={(e, id, i) => { e.preventDefault(); geo.toggleFreezeEdge(id, i); }}
                    onEdgeAdd={(e, id, i) => { e.stopPropagation(); geo.addVertex(id, i); }}
                  />
                )}
                {/* facing arrow: a draggable orientation vector from the node centre. Shown when the node
                    is SELECTED (draggable) or has a facing SET (a static hint). Props don't carry a facing.
  a PIN is pre-shape ("position known, shape not yet") — facing/camera/lock are shape-stage
                    concerns, so keep the pin clean: no facing arrow / camera / lock glyph on a pin.
  EDIT-IN-OWN-VIEW: nodes in THIS loop are CHILDREN of the focused node. A UNIT's
 pose IS edited at its parent-floor level (that's the model — facing/rotate a unit on its
                    floor), so a unit child keeps an interactive facing arrow. But a BUILDING/FLOOR/LAND child must
                    NOT be pose-editable from the parent's view (the "rotate the building from LAND view" leak) —
                    its facing is a concern of its OWN view, so render a STATIC hint only (interactive=false).
                    Dive in (double-click) to edit a non-unit child's facing. */}
                {!isProp && !isUnitPin && (selected || n.facingDeg != null) && (
                  <FacingArrow
                    node={n}
                    centerX={r.x + r.w / 2}
                    centerY={r.y + r.h / 2}
                    radius={Math.max(16, Math.min(r.w, r.h) * 0.42)}
                    interactive={selected && n.kind === "unit"}
                    onTipDown={(e) => onFacingDown(e, n.id, r.x + r.w / 2, r.y + r.h / 2)}
                  />
                )}
                {/* camera / frustum: a placeable interior viewpoint on a room node (unit/floor). Shown
                    whenever a camera is placed; interactive (draggable pin + aim handle) when selected. */}
                {!isProp && !isUnitPin && n.camera && (
                  <CameraFrustum
                    camera={n.camera}
                    frameX={r.x}
                    frameY={r.y}
                    frameW={r.w}
                    frameH={r.h}
                    interactive={selected}
                    onPinDown={(e) => onCameraMoveDown(e, n.id)}
                    onAimDown={(e, ax, ay) => onCameraAimDown(e, n.id, ax, ay)}
                  />
                )}
                {/*  ROTATE KNOB — a placed, shaped unit rotates as a rigid whole on its floor. Shown when the
                    unit is selected + shaped + subtype-bound + NOT position-locked. A pos-locked unit shows a 📌 pin
                    glyph instead (its pose is pinned). The shared SHAPE is untouched — this is per-instance pose.
 (kill-the-bbox arc Slice 4) ROTATION IS NOW A FIRST-CLASS NODE TRANSFORM: a BUILDING / FLOOR
                    / LAND node also shows the knob (not pos-locked, not shape-locked), so a building can be rotated to
                    HUG a tilted plot. renderFootprint applies the same rigid metre-space rotation — the stored
                    footprint is untouched (rotation ≠ reshape), identical to the unit path. */}
                {selected && !n.posLocked && !locked && !isProp && !isUnitPin && n.footprint &&
                  ((n.kind === "unit" && isPoly && n.subtypeRef) ||
                    (n.kind === "building" || n.kind === "floor" || n.kind === "land")) && (
                  <RotateKnob
                    node={n}
                    centerX={r.x + r.w / 2}
                    centerY={r.y + r.h / 2}
                    radius={Math.max(18, Math.min(r.w, r.h) * 0.55)}
                    onKnobDown={(e) => onRotateDown(e, n.id, r.x + r.w / 2, r.y + r.h / 2)}
                  />
                )}
                {n.kind === "unit" && isPoly && n.subtypeRef && n.posLocked && r.w >= 20 && r.h >= 16 && (
                  <text className="mm-geo__poslock" x={r.x + 6} y={r.y + r.h - 6} pointerEvents="none">
                    <title>Position locked on this floor</title>📌
                  </text>
                )}
                {/* lock toggle — a small glyph top-right of the box; click flips locked (visible on select OR when locked) */}
                {!isProp && !isUnitPin && (selected || locked) && r.w >= 24 && r.h >= 16 && (
                  <text
                    className="mm-geo__lock"
                    x={r.x + r.w - 5}
                    y={r.y + 13}
                    textAnchor="end"
                    onMouseDown={(e) => { e.stopPropagation(); geo.selectNode(n.id); geo.setLocked(n.id, !locked); }}
                  >
                    <title>{locked ? "Locked — click to unlock this shape" : "Click to lock this shape"}</title>
                    {locked ? "🔒" : "🔓"}
                  </text>
                )}
                {/* locked + selected: a LOUD click-to-edit pill so a locked shape is never a silent dead-end — this
 is what bit: he selected a locked building, saw no edit handles, and couldn't tell
                    the shape was locked, not broken. Clicking the pill unlocks it in place. */}
                {!isProp && selected && locked && r.w >= 70 && r.h >= 22 && (
                  <g
                    className="mm-geo__unlock-pill"
                    onMouseDown={(e) => { e.stopPropagation(); geo.setLocked(n.id, false); }}
                  >
                    <title>This shape is locked — click to unlock and edit it</title>
                    <rect x={r.x + r.w / 2 - 62} y={r.y + r.h / 2 - 11} width={124} height={22} rx={11} />
                    <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 4} textAnchor="middle">🔒 Locked — click to edit</text>
                  </g>
                )}
              </g>
            );
          })}

          {/* live draw-preview */}
          {drawRect && (() => {
            const r = toPx(drawRect, b0);
            return <rect x={r.x} y={r.y} width={r.w} height={r.h} className="mm-geo__draw" rx={4} />;
          })()}

          {/* (Slice D) PIN → POLYGON bridge: focused inside a unit that has no shape yet → the frame is empty.
              A loud centred CTA seeds the editable polygon (toPoly) so the measured-edge editor appears. */}
          {focusedUnitNeedsShape && focusNode && (() => {
            const cx = fb0.x + fb0.w / 2, cy = fb0.y + fb0.h / 2;
            return (
              <g className="mm-draw-shape-cta" onMouseDown={(e) => { e.stopPropagation(); geo.toPoly(focusNode.id); geo.selectNode(focusNode.id); }}>
                <rect x={cx - 120} y={cy - 24} width={240} height={48} rx={10} />
                <text x={cx} y={cy - 2} textAnchor="middle" className="mm-draw-shape-cta__t1">✎ Draw this unit&apos;s shape</text>
                <text x={cx} y={cy + 15} textAnchor="middle" className="mm-draw-shape-cta__t2">then drag corners &amp; set edge metres</text>
              </g>
            );
          })()}
        </svg>

        {/* (B3b) the "world" navigation toolbar — Frame the selection / Frame-All (reset to the fitted level) +
            a live zoom read-out. Pan = hold Space (or middle-drag); wheel = zoom about the cursor. */}
        <div className="mm-world-bar">
          <button type="button" className="mm-world-btn" onClick={frameSelection} disabled={!geo.selectedId}
            title="Fit the viewport to the selected node">⊡ Frame</button>
          <button type="button" className="mm-world-btn" onClick={() => setVp(IDENTITY_VP)}
            title="Reset the viewport to the whole focused level">⊞ Frame all</button>
          <span className="mm-world-zoom" title="Current zoom (wheel to change)">{Math.round(vp.zoom * 100)}%</span>
          <span className="mm-world-hint">Space-drag pans · wheel zooms</span>
        </div>

        {/* colour grammar — decode which coloured shape is which kind (land/building/floor/unit). */}
        <KindLegend />

        {/* unit-status colour key — the full status vocabulary (decode half); shown when units are in view. */}
        <StatusLegend pack={pack} focusId={geo.focusId} />

        {/* floor roll-up — "read availability at a glance" (§4b). Shows when the focused node holds units. */}
        <FloorLegend pack={pack} focusId={geo.focusId} />

        {/* (#4) when level-isolation is hiding the stacked siblings, say so + offer a one-click way back. */}
        {stackIsolateActive && (
          <div className="mm-canvas__isolate" role="status">
            <span>Editing one level — {stackingCount - 1} other{stackingCount - 1 === 1 ? "" : "s"} hidden</span>
            <button className="mm-btn" onClick={() => geo.selectNode(undefined)}>Show all levels</button>
          </div>
        )}

        {/* (slice 5) marker toolbar — shown only INSIDE a unit's plan. Pick a tool, click the plan to drop. */}
        {planDetailing && (
          <div className="mm-marker-bar">
            <span className="mm-marker-bar__label">Add to plan:</span>
            {(["door", "window", "wall"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`mm-marker-tool ${markerTool === t ? "is-on" : ""}`}
                onClick={() => { setMarkerTool((cur) => (cur === t ? null : t)); setWallStart(null); }}
                title={t === "wall" ? "Wall — click a start point, then an end point" : `${t} — click on the plan to place`}
              >
                {t === "door" ? "⌫ Door" : t === "window" ? "▭ Window" : "— Wall"}
              </button>
            ))}
            {markerTool && (
              <span className="mm-marker-bar__hint">
                {markerTool === "wall"
                  ? (wallStart ? "click the wall's END point" : "click the wall's START point")
                  : `click on the plan to place a ${markerTool}`}
                {" · "}<button type="button" className="mm-link-btn" onClick={() => { setMarkerTool(null); setWallStart(null); }}>done</button>
              </span>
            )}
            {!markerTool && markers.length > 0 && (
              <span className="mm-marker-bar__hint">{markers.length} marker{markers.length === 1 ? "" : "s"} · click one to remove, drag to move</span>
            )}
          </div>
        )}

        <div className="mm-canvas__hint">
          {focusedUnitNeedsShape
            ? "This unit has no shape yet — click “Draw this unit’s shape” to author its outline"
            : childKind
            ? `Drag on empty space to draw a ${KIND_LABEL[childKind].toLowerCase()} · double-click a box to go inside · drag to move / resize`
            : "Deepest level (prop) — nothing nests here"}
          {childKind === "unit" && (
            <button
              type="button"
              className={`mm-snap-toggle ${snap ? "is-on" : ""}`}
              onClick={() => setSnap((s) => !s)}
              title="Snap unit edges to building-wide columns (§4b). Turn off to nudge a unit off-grid."
            >
              {snap ? "⊞ Column snap: on" : "⊡ Column snap: off"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Truncate a label to roughly fit a box of `wPx` wide (≈6px/char at 11px font, 12px padding). */
function clipLabel(name: string, wPx: number): string {
  const max = Math.max(2, Math.floor((wPx - 12) / 6));
  return name.length > max ? name.slice(0, Math.max(1, max - 1)) + "…" : name;
}

/** On-canvas roll-up of the focused node's unit children: count, total m², per-status swatches (§4b at-a-glance). */
function FloorLegend({ pack, focusId }: { pack: Pack; focusId?: string }) {
  const s = floorSummary(pack, focusId);
  if (s.units === 0) return null;
  return (
    <div className="mm-floor-legend" aria-label="Floor summary">
      <div className="mm-floor-legend__head">
        <strong>{s.units}</strong> unit{s.units === 1 ? "" : "s"}
        {s.totalSqm > 0 && <span className="mm-floor-legend__total"> · {s.totalSqm.toLocaleString()} m²</span>}
      </div>
      <div className="mm-floor-legend__row">
        {s.byStatus.map((t) => (
          <span key={t.status} className="mm-floor-legend__chip" title={`${STATUS_LABEL[t.status]}: ${t.count}`}>
            <span className="mm-floor-legend__sw" style={{ background: STATUS_FILL[t.status] }} />
            {STATUS_LABEL[t.status]} <b>{t.count}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

// The nesting-colour grammar (land=blue/building=green/floor=yellow/unit=purple) as a tiny at-a-glance
// legend — so a reader can decode a freshly-imported building's coloured shapes without guessing. Swatches
// read the SAME --mm-kind-* vars the Canvas strokes with (one source of truth). Props read by glyph, not
// colour, so they're not in the grammar. Fixed content → no props. (-polish.)
const KIND_LEGEND: { kind: GeoKind; label: string }[] = [
  { kind: "land", label: "Land" },
  { kind: "building", label: "Building" },
  { kind: "floor", label: "Floor" },
  { kind: "unit", label: "Unit" },
];
function KindLegend() {
  return (
    <div className="mm-kind-legend" aria-label="Colour grammar">
      {KIND_LEGEND.map((k) => (
        <span key={k.kind} className="mm-kind-legend__chip">
          <span className="mm-kind-legend__sw" style={{ background: `var(--mm-kind-${k.kind})` }} />
          {k.label}
        </span>
      ))}
    </div>
  );
}

// The full unit-STATUS colour key (all of UNIT_STATUSES, swatch + label, no counts) — the static decode half of the
// status grammar. FloorLegend shows the statuses PRESENT on the current floor WITH counts; this shows the whole
// vocabulary so a reader can decode a colour they haven't met yet (e.g. a Sale+ unit on a floor that has none). Same
// chip styling as KindLegend (one visual language). Shown only when units are in view (focused on a floor). (
// -polish, companion to KindLegend.) Reads STATUS_FILL/STATUS_LABEL — one source of truth with the Canvas fills.
function StatusLegend({ pack, focusId }: { pack: Pack; focusId?: string }) {
  if (floorSummary(pack, focusId).units === 0) return null;
  return (
    <div className="mm-kind-legend" aria-label="Unit status colours">
      {UNIT_STATUSES.map((s) => (
        <span key={s} className="mm-kind-legend__chip" title={STATUS_LABEL[s]}>
          <span className="mm-kind-legend__sw" style={{ background: STATUS_FILL[s] }} />
          {STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

// Fraction point → px. (A tiny closure so both poly components share the frame mapping.)
type ToPx = (fr: { x: number; y: number }) => { x: number; y: number };
const vPx = (f: FrameBox): ToPx => (fr) => ({
  x: f.x + fr.x * f.w,
  y: f.y + fr.y * f.h,
});

/** (B3 "the world") The METRIC GRID — real-metre squares over the focused frame + a scale legend. `metres`
 *  is the frame's real width/height (realMetres); the frame px (fb0) spans exactly that, so the metre→px scale is
 *  fb0.w/metres.w. A "nice" step (niceMetreStep) gives ~8+ squares across the larger side. Non-interactive
 *  (pointer-events none) so it never steals a drag/select. Renders nothing without a metre anchor. */
function MetreGrid({ frame, metres }: { frame: FrameBox; metres: { w: number; h: number } | undefined }) {
  if (!metres || !(metres.w > 0) || !(metres.h > 0) || frame.w <= 0 || frame.h <= 0) return null;
  const step = niceMetreStep(Math.max(metres.w, metres.h));
  if (!step) return null;
  const sx = frame.w / metres.w; // px per metre, x
  const sy = frame.h / metres.h; // px per metre, y
  const stepPxX = step * sx;
  const stepPxY = step * sy;
  if (!(stepPxX > 1) || !(stepPxY > 1)) return null; // degenerate — skip rather than draw thousands of lines
  const verticals: number[] = [];
  for (let m = 0; m <= metres.w + 1e-6; m += step) verticals.push(frame.x + m * sx);
  const horizontals: number[] = [];
  for (let m = 0; m <= metres.h + 1e-6; m += step) horizontals.push(frame.y + m * sy);
  const legendStr = step >= 1 ? `${step} m` : `${step} m`;
  return (
    <g className="mm-grid" pointerEvents="none">
      {verticals.map((x, i) => (
        <line key={`v${i}`} x1={x} y1={frame.y} x2={x} y2={frame.y + frame.h} className="mm-grid__line" />
      ))}
      {horizontals.map((y, i) => (
        <line key={`h${i}`} x1={frame.x} y1={y} x2={frame.x + frame.w} y2={y} className="mm-grid__line" />
      ))}
      {/* scale legend — a labelled reference bar one grid-square wide, bottom-left of the frame */}
      <g transform={`translate(${frame.x + 8}, ${frame.y + frame.h - 14})`}>
        <line x1={0} y1={0} x2={stepPxX} y2={0} className="mm-grid__scalebar" />
        <line x1={0} y1={-3} x2={0} y2={3} className="mm-grid__scalebar" />
        <line x1={stepPxX} y1={-3} x2={stepPxX} y2={3} className="mm-grid__scalebar" />
        <text x={stepPxX / 2} y={-5} textAnchor="middle" className="mm-grid__scalelabel">{legendStr}</text>
      </g>
    </g>
  );
}

/**
 * The REFERENCE FRAME — the focused node's own footprint shape, drawn as a dim, locked, non-interactive
 * backdrop so children are laid out inside the true plate (e.g. an L-shaped floor), not a lying rectangle.
 * The focused node fills the 0..1 frame, so we NORMALIZE its polygon to its own bounding box (bbox → 0..1).
 * Only drawn for a POLY footprint — a rect footprint already matches the rectangular frame, nothing to add.
 */
/**
 * (Slice B) The CUMULATIVE ANCESTOR STACK framing the focused node — every ancestor (land behind a building,
 * building+land behind a floor, floor+building+land behind a unit), each in the focused node's own 0..1 frame
 * (blown up past 0..1 because ancestors are bigger). Kind-coloured per the grammar (land=blue, building=green,
 * floor=yellow) + labelled, dim + locked. Non-interactive. Drawn farthest-ancestor FIRST so nearer layers sit on top.
 */
function AncestorStack({ pack, focusId, box }: { pack: Pack; focusId: string; box: FrameBox }) {
  // (Slice 3) the metre-native backdrop is now the SOLE path — the legacy bbox `ancestorLayers` fallback is
  // deleted (the load-time hydrate stamps pointsM+posM so every level resolves metres; metre space = no distortion).
  const layers = ancestorLayersMetric(pack, focusId);
  if (!layers.length) return null;
  const p = vPx(box);
  // farthest-first (land ... then building) so the nearer, smaller frames paint on top
  const ordered = [...layers].reverse();
  return (
    <g className="mm-canvas__ancestors" pointerEvents="none">
      {ordered.map((layer) => {
        if (layer.points.length < 3) return null;
        const d = layer.points.map((pt) => p(pt)).map((q) => `${q.x},${q.y}`).join(" ");
        const tag = layer.points.reduce((lo, pt) => (pt.y < lo.y ? pt : lo), layer.points[0]);
        const tp = p(tag);
        return (
          <g key={layer.id} className={`mm-anc mm-anc--${layer.kind}`}>
            <polygon className="mm-anc__poly" points={d} />
            <text x={tp.x + 4} y={tp.y - 4} className="mm-anc__tag">{layer.name}</text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * THE ONE POLY EDITOR — consolidated from RefFrame (the focused-node editor) + PolyHandles (the child
 * editor), which had drifted into two near-identical vertex/edge editors (the duplication that let the
 * shared-shape bug hide). One component now, parameterized by `mode`:
 *   - mode="focus": the FOCUSED node drawn in its OWN view, bbox self-normalized to the 0..1 frame. Its stored
 *     points live in the PARENT frame, so a vertex drag maps display→stored via {min,span} (handed to onVertexDown
 *     so the Canvas drag-handler can remap). Renders a selectable kind-coloured outline (click = select).
 *   - mode="child": a CHILD poly whose points are ALREADY in the parent 0..1 frame → straight vPx, no remap
 *     (onVertexDown's min/span are the identity {0,0}/{1,1} and ignored by the child handler). No outline here
 *     (the child body is drawn separately by PolyBody); this component is handles-only when mode="child".
 * Both modes share the FULL handle set: drag vertices · edge-midpoint add-vertex · right-click freeze vertex/edge ·
 * double-click delete vertex · per-edge metre labels. `footprint` is the resolved points to display+edit (the
 * subtype's SHARED plan for a bound focused node, else the node's own) — display and edit read the one source so
 * they can't drift. Lock-gating (focus mode) is the caller's call via `editable`.
 */
function PolyEditor({
  node, box, footprint, mode, selected, editable, onSelect,
  onVertexDown, onVertexContext, onVertexDouble, onEdgeAdd, onEdgeContext,
  edgeMetres, frozenVerts, frozenEdges,
}: {
  node: GeoNode;
  box: FrameBox;
  footprint?: Footprint; // resolved display/edit source (SHARED plan for a bound focused node, else own)
  mode: "focus" | "child";
  selected?: boolean;
  editable?: boolean; // handles shown? (focus = selected && !locked; child = caller already gates selected && !locked)
  onSelect?: () => void; // focus mode only — the outline is click-to-select
  onVertexDown: (e: React.MouseEvent, id: string, index: number, min: { x: number; y: number }, span: { x: number; y: number }) => void;
  onVertexContext?: (e: React.MouseEvent, id: string, index: number) => void;
  onVertexDouble?: (e: React.MouseEvent, id: string, index: number) => void;
  onEdgeAdd?: (e: React.MouseEvent, id: string, afterIndex: number) => void;
  onEdgeContext?: (e: React.MouseEvent, id: string, index: number) => void;
  edgeMetres?: number[];
  frozenVerts?: number[];
  frozenEdges?: number[];
}) {
  const fp0 = footprint ?? node.footprint;
  if (fp0?.shape !== "poly" || fp0.points.length < 3) return null;
  const pts = fp0.points;
  const p = vPx(box);
  // FOCUS: self-normalize the bbox to the 0..1 frame + remap drags via {min,span}. CHILD: points are already in the
  // parent frame → identity mapping (min 0, span 1), displayed straight through vPx.
  let min = { x: 0, y: 0 }, span = { x: 1, y: 1 };
  let disp = pts;
  if (mode === "focus") {
    const xs = pts.map((pt) => pt.x), ys = pts.map((pt) => pt.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(1e-6, Math.max(...xs) - minX), h = Math.max(1e-6, Math.max(...ys) - minY);
    min = { x: minX, y: minY }; span = { x: w, y: h };
    disp = pts.map((pt) => ({ x: (pt.x - minX) / w, y: (pt.y - minY) / h }));
  }
  const d = disp.map((pt) => p(pt)).map((q) => `${q.x},${q.y}`).join(" ");
  const fV = new Set(frozenVerts || []);
  const fE = new Set(frozenEdges || []);
  const groupCls = mode === "focus"
    ? `mm-canvas__self mm-self--${node.kind} ${selected ? "is-selected" : ""}`
    : "mm-poly-handles";
  return (
    <g className={groupCls}>
      {/* FOCUS: a selectable kind-coloured outline (land=blue, building=green, floor=yellow). CHILD: no outline —
          PolyBody draws the child's fill separately; this component is handles-only there. */}
      {mode === "focus" && (
        <polygon
          className={`mm-canvas__refframe mm-refframe--${node.kind}`}
          points={d}
          onMouseDown={(e) => { e.stopPropagation(); onSelect?.(); }}
          style={{ cursor: node.locked ? "default" : "pointer" }}
        />
      )}
      {/* per-edge METRE LENGTH labels while editing — read a wall dimension straight off the canvas.
 OFFSET OUTWARD from the edge midpoint along the outward normal (fix) so the text clears the
          add-vertex / vertex handle dots that sit ON the midpoint — previously it rendered on top of them,
          unreadable + hiding the grab target. Outward = away from the polygon's centroid (px space). */}
      {editable && edgeMetres && edgeMetres.length === disp.length && (() => {
        const ptsPx = disp.map((pt) => p(pt));
        const cx = ptsPx.reduce((s, q) => s + q.x, 0) / ptsPx.length;
        const cy = ptsPx.reduce((s, q) => s + q.y, 0) / ptsPx.length;
        const OFFSET = 13; // px clear of the r≈6 vertex + r≈4.5 edge dots
        return disp.map((pt, i) => {
          const a = ptsPx[i];
          const b = ptsPx[(i + 1) % ptsPx.length];
          const len = edgeMetres[i];
          if (!(len > 0)) return null;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          // edge direction → perpendicular; pick the normal pointing away from the centroid.
          const ex = b.x - a.x, ey = b.y - a.y;
          const nLen = Math.hypot(ex, ey) || 1;
          let nx = -ey / nLen, ny = ex / nLen;
          if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
          return (
            <text
              key={`edge-${i}`}
              x={mx + nx * OFFSET}
              y={my + ny * OFFSET}
              className={`mm-self__edgelen mm-self__edgelen--${node.kind}`}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {len.toFixed(1)}m
            </text>
          );
        });
      })()}
      {/* EDGE-MIDPOINT handles — single-click adds a vertex (geo.addVertex splits edge i at its midpoint in the
          stored frame, so no self-norm mapping is needed); right-click freezes the edge. */}
      {editable && onEdgeAdd && disp.map((pt, i) => {
        const a = p(pt);
        const b = p(disp[(i + 1) % disp.length]);
        return (
          <circle
            key={`e${i}`}
            cx={(a.x + b.x) / 2}
            cy={(a.y + b.y) / 2}
            r={4.5}
            className={`mm-poly__edge ${fE.has(i) ? "is-frozen" : ""}`}
            onMouseDown={(e) => onEdgeAdd(e, node.id, i)}
            onContextMenu={onEdgeContext ? (e) => onEdgeContext(e, node.id, i) : undefined}
          >
            <title>{fE.has(i) ? "Edge frozen — right-click to unfreeze" : onEdgeContext ? "Click to add a vertex · right-click to freeze this edge" : "Click to add a point on this edge"}</title>
          </circle>
        );
      })}
      {/* VERTICES — drag to move; right-click freeze; double-click delete. */}
      {editable && disp.map((pt, i) => {
        const q = p(pt);
        return (
          <circle
            key={`v${i}`}
            cx={q.x}
            cy={q.y}
            r={6}
            className={`mm-poly__vert ${fV.has(i) ? "is-frozen" : ""}`}
            onMouseDown={(e) => onVertexDown(e, node.id, i, min, span)}
            onContextMenu={onVertexContext ? (e) => onVertexContext(e, node.id, i) : undefined}
            onDoubleClick={onVertexDouble ? (e) => onVertexDouble(e, node.id, i) : undefined}
          >
            <title>{fV.has(i) ? "Vertex frozen — right-click to unfreeze" : "Drag to move · right-click to freeze · double-click to delete"}</title>
          </circle>
        );
      })}
    </g>
  );
}

/**
 * (slice 5) DOOR / WINDOW / WALL markers drawn on a unit plan — illustration-grade schematic symbols, not
 * CAD: a door = a dot + a quarter-circle swing; a window = a short double bar; a wall = a thick line between two
 * endpoints. Each is draggable (handled by the parent via onMarkerDown); clicking one with NO tool active removes
 * it. Points are the plan's own 0..1 fractions, mapped straight through the frame box.
 */
function PlanMarkers({
  markers, box, tool, onMarkerDown, onRemove,
}: {
  markers: PlanMarker[];
  box: FrameBox;
  tool: "door" | "window" | "wall" | null;
  onMarkerDown: (e: React.MouseEvent, index: number, end?: "a" | "b") => void;
  onRemove: (index: number) => void;
}) {
  const p = vPx(box);
  const handle = (i: number, end?: "a" | "b") => ({
    onMouseDown: (e: React.MouseEvent) => onMarkerDown(e, i, end),
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); if (!tool) onRemove(i); },
    style: { cursor: tool ? "copy" : "pointer" } as React.CSSProperties,
  });
  return (
    <g className="mm-plan-markers">
      {markers.map((m, i) => {
        if (m.kind === "wall") {
          const a = p(m.a), bb = p(m.b);
          return (
            <g key={i} className="mm-mark mm-mark--wall">
              <line x1={a.x} y1={a.y} x2={bb.x} y2={bb.y} className="mm-mark__wall" {...handle(i)} />
              <circle cx={a.x} cy={a.y} r={4} className="mm-mark__end" {...handle(i, "a")} />
              <circle cx={bb.x} cy={bb.y} r={4} className="mm-mark__end" {...handle(i, "b")} />
            </g>
          );
        }
        const c = p(m.at);
        if (m.kind === "door") {
          // a dot + a quarter-circle swing (fixed schematic radius in px)
          const R = 16;
          return (
            <g key={i} className="mm-mark mm-mark--door" {...handle(i)}>
              <path d={`M ${c.x} ${c.y} h ${R} A ${R} ${R} 0 0 1 ${c.x} ${c.y + R}`} className="mm-mark__swing" />
              <circle cx={c.x} cy={c.y} r={4.5} className="mm-mark__dot" />
            </g>
          );
        }
        // window — a short double bar centred on the point
        const W = 13;
        return (
          <g key={i} className="mm-mark mm-mark--window" {...handle(i)}>
            <line x1={c.x - W} y1={c.y - 2} x2={c.x + W} y2={c.y - 2} className="mm-mark__win" />
            <line x1={c.x - W} y1={c.y + 2} x2={c.x + W} y2={c.y + 2} className="mm-mark__win" />
          </g>
        );
      })}
    </g>
  );
}

/**
 * The FACING arrow — a draggable orientation vector drawn from a node's centre. 0° points up
 * (top-of-frame), clockwise. When the node has NO facing yet but is selected, we draw a faint "unset" arrow
 * pointing up so there's a tip to grab (dragging it sets facingDeg). When facing IS set, the arrow is solid
 * and shows a compass label. The tip circle is the drag handle; the shaft is non-interactive.
 */
function FacingArrow({
  node, centerX, centerY, radius, interactive, onTipDown,
}: {
  node: GeoNode;
  centerX: number;
  centerY: number;
  radius: number;
  interactive: boolean;
  onTipDown: (e: React.MouseEvent) => void;
}) {
  const set = node.facingDeg != null;
  const deg = set ? node.facingDeg! : 0; // unset → a grabbable up-pointing default
  const { dx, dy } = facingVectorTip(deg, radius);
  const tipX = centerX + dx;
  const tipY = centerY + dy;
  return (
    <g className={`mm-geo__facing ${set ? "is-set" : "is-unset"}`} pointerEvents="none">
      <line x1={centerX} y1={centerY} x2={tipX} y2={tipY} className="mm-geo__facing-shaft" />
      {/* a little arrowhead at the tip, rotated to the facing (0 = up) */}
      <g transform={`translate(${tipX},${tipY}) rotate(${deg})`}>
        <polygon points="0,-6 4,4 0,1 -4,4" className="mm-geo__facing-head" />
      </g>
      {set && (
        <text x={centerX} y={centerY - radius - 6} textAnchor="middle" className="mm-geo__facing-label">
          {compass16(deg)} · {Math.round(deg)}°
        </text>
      )}
      {/* the drag handle — only when selected (interactive); a fat invisible hit-circle over the tip */}
      {interactive && (
        <circle
          cx={tipX}
          cy={tipY}
          r={9}
          className="mm-geo__facing-grip"
          pointerEvents="all"
          onMouseDown={onTipDown}
        >
          <title>Drag to set which way this {KIND_LABEL[node.kind].toLowerCase()} faces</title>
        </circle>
      )}
    </g>
  );
}

/**
 * The ROTATE KNOB — a draggable handle on a ring around a placed unit's centre; dragging it sets the
 * unit's on-floor rotationDeg (0 = up, clockwise). Shown only on a selected, shaped, NOT-position-locked unit.
 * A faint ring shows the rotation orbit; the knob sits at the current angle so it reads as a dial. When the
 * position is LOCKED the knob is hidden (the caller gates on posLocked) and a 📌 glyph marks the pinned pose.
 */
function RotateKnob({
  node, centerX, centerY, radius, onKnobDown,
}: {
  node: GeoNode;
  centerX: number;
  centerY: number;
  radius: number;
  onKnobDown: (e: React.MouseEvent) => void;
}) {
  const deg = node.rotationDeg ?? 0;
  const { dx, dy } = facingVectorTip(deg, radius);
  const kx = centerX + dx, ky = centerY + dy;
  return (
    <g className="mm-geo__rotate" >
      <circle cx={centerX} cy={centerY} r={radius} className="mm-geo__rotate-ring" pointerEvents="none" />
      <text x={centerX} y={centerY - radius - 6} textAnchor="middle" className="mm-geo__rotate-label" pointerEvents="none">
        ⟳ {Math.round(deg)}°
      </text>
      <circle cx={kx} cy={ky} r={7} className="mm-geo__rotate-knob" pointerEvents="all" onMouseDown={onKnobDown}>
        <title>Drag to rotate this unit on the floor ({Math.round(deg)}°)</title>
      </circle>
    </g>
  );
}

/**
 * The CAMERA / frustum — a placeable interior viewpoint drawn inside a node's footprint box. The camera's
 * {x,y} are 0..1 fractions of the NODE's own rect (where in the room you stand), so we scale by the node px rect,
 * not the whole canvas frame. Renders: the view-cone (a filled triangle to the two frustum edges), a pin dot at
 * the apex (drag to move), and an aim handle on the facing ray (drag to rotate). The cone length is a fraction of
 * the node box so it reads as "looking across the room". Non-selected = a dim static hint; selected = interactive.
 */
function CameraFrustum({
  camera, frameX, frameY, frameW, frameH, interactive, onPinDown, onAimDown,
}: {
  camera: import("@/lib/pack").Camera;
  frameX: number; frameY: number; frameW: number; frameH: number;
  interactive: boolean;
  onPinDown: (e: React.MouseEvent) => void;
  onAimDown: (e: React.MouseEvent, ax: number, ay: number) => void;
}) {
  // map a {x,y} in node-fraction space → px within this node's box
  const toPxN = (p: { x: number; y: number }) => ({ x: frameX + p.x * frameW, y: frameY + p.y * frameH });
  const coneLen = 0.6; // in frame fractions — the cone reaches ~60% across the room
  const f = frustumPoints(camera, coneLen);
  const apex = toPxN(f.apex);
  const left = toPxN(f.left);
  const right = toPxN(f.right);
  // aim handle sits along the centre facing ray, a bit past the apex
  const aimV = facingVectorTip(camera.facingDeg, coneLen * 0.55);
  const aimTip = toPxN({ x: f.apex.x + aimV.dx, y: f.apex.y + aimV.dy });
  return (
    <g className={`mm-geo__cam ${interactive ? "is-live" : ""}`} pointerEvents="none">
      <polygon points={`${apex.x},${apex.y} ${left.x},${left.y} ${right.x},${right.y}`} className="mm-geo__cam-cone" />
      <line x1={apex.x} y1={apex.y} x2={aimTip.x} y2={aimTip.y} className="mm-geo__cam-ray" />
      <circle cx={apex.x} cy={apex.y} r={5} className="mm-geo__cam-pin" />
      {interactive && (
        <>
          {/* pin drag handle — fat invisible hit-circle over the apex */}
          <circle cx={apex.x} cy={apex.y} r={10} className="mm-geo__cam-grip" pointerEvents="all" onMouseDown={onPinDown}>
            <title>Drag to move the camera within the room</title>
          </circle>
          {/* aim drag handle — rotate the view */}
          <circle cx={aimTip.x} cy={aimTip.y} r={7} className="mm-geo__cam-aim" pointerEvents="all" onMouseDown={(e) => onAimDown(e, apex.x, apex.y)}>
            <title>Drag to rotate which way the camera looks</title>
          </circle>
        </>
      )}
    </g>
  );
}

/**
 * (Slice C — the units=PINS reframe, D-) A unit that has no authored polygon yet is a POSITION, not a
 * shape — so it draws as a round PIN: a 4 m-radius metre-space dot (radiusPx = PIN_RADIUS_M × the floor's metre→px
 * scale, so it scales with the grid at any zoom) in the unit kind colour (light purple), with a number/m² label
 * beside it + a small status ring. It is OBVIOUSLY not the final outline, so nothing (code or user) treats it as
 * geometry: no resize, no area-lock, no overlap flag. Drag the dot to reposition (handled by the group's rect-move);
 * double-click → author the real polygon (Slice D), whose poly then REPLACES the pin.
 */
function UnitPin({
  centerX, centerY, radiusPx, label, sqm, statusColor, statusLabel, selected, onBodyDown, onDouble,
}: {
  centerX: number; centerY: number; radiusPx: number;
  label: string; sqm: number | undefined;
  statusColor?: string; statusLabel?: string;
  selected: boolean;
  onBodyDown: (e: React.MouseEvent) => void;
  onDouble: () => void;
}) {
  const r = Math.max(5, radiusPx); // never vanish at tiny zoom
  //  the m² NUMBER sits INSIDE the dot (the key figure, scaled to the dot so it grows with zoom), and the NAME
  // sits BELOW the dot (horizontal room → full name, unclipped, steady readable size). Cramming the name inside the
  // circle forced truncation ("1B…",: "not readable"); this split keeps both legible.
  //  m² INSIDE the dot (the key figure, scaled with the dot); the NAME below — with its trailing size token
  // STRIPPED so the m² isn't shown twice (: "the m2 is double"; the name "1BR B 35m²" already ends in the size).
  const sqmText = sqm != null ? `${sqm.toLocaleString()} m²` : undefined;
  const sqmFont = Math.max(9, Math.min(15, r * 0.4)); // inside-the-dot m² number, scales with the dot
  // drop a trailing "<n> m²" / "<n>m²" (and the common "mÂ²" mojibake variant) from the displayed name.
  const nameOnly = label.replace(/\s*\d[\d.,]*\s*m(?:²|Â²|2)\s*$/i, "").trim() || label;
  const nameFont = 15; // name below the dot — steady readable size
  const nameY = centerY + r + nameFont + 2;
  //  COLOUR BY STATUS (: "don't like the colors… status borders so thin"). The dot FILL = the unit's
  // status colour (available=green, sold=blue, …) so availability reads at a glance — not a uniform purple blob with
  // a hairline ring. A thick WHITE border (scaled with the dot) separates it from the plate + from neighbours. When
  // the unit has no status, fall back to the kind-purple.
  const dotFill = statusColor ?? "var(--mm-kind-unit)";
  const borderW = Math.max(2, r * 0.14);
  return (
    <g className={`mm-pin ${selected ? "is-selected" : ""}`}
      onMouseDown={onBodyDown}
      onDoubleClick={(e) => { e.stopPropagation(); onDouble(); }}
    >
      <circle cx={centerX} cy={centerY} r={r} fill={dotFill} fillOpacity={0.95}
        stroke={selected ? "#fff" : "var(--panel)"} strokeWidth={selected ? borderW + 1 : borderW} />
      {/* full name + m² + status available on hover */}
      <title>{[label, sqmText, statusLabel].filter(Boolean).join(" · ")}</title>
      {/* the m² number INSIDE the dot (when the dot is big enough); halo scales with the font */}
      {sqmText && r >= 13 && (
        <text x={centerX} y={centerY + sqmFont * 0.35} className="mm-pin__label" textAnchor="middle" fontSize={sqmFont} strokeWidth={Math.max(3, sqmFont * 0.22)} pointerEvents="none">
          {sqmText}
        </text>
      )}
      {/* the NAME (size stripped) below the dot */}
      <text x={centerX} y={nameY} className="mm-pin__label" textAnchor="middle" fontSize={nameFont} strokeWidth={3} pointerEvents="none">
        {nameOnly}
      </text>
    </g>
  );
}

/** The polygon body (fill + outline), with status fill when it's a unit. Reuses the group's click/zoom. */
function PolyBody({
  node, box, fill, onBodyDown, onDouble, footprint,
}: {
  node: GeoNode;
  box: FrameBox;
  fill?: string;
  onBodyDown: (e: React.MouseEvent) => void;
  onDouble: () => void;
  footprint?: Footprint; //  RENDER override — the resolved subtype-shape-at-own-position; defaults to node's own
}) {
  const fp = footprint ?? node.footprint;
  if (fp?.shape !== "poly") return null;
  const p = vPx(box);
  const pts = fp.points.map((pt) => p(pt));
  const d = pts.map((q) => `${q.x},${q.y}`).join(" ");
  return (
    <polygon
      points={d}
      className="mm-geo__rect"
      style={fill ? { fill, fillOpacity: 0.55, stroke: fill } : undefined}
      onMouseDown={onBodyDown}
      onDoubleClick={(e) => { e.stopPropagation(); onDouble(); }}
    />
  );
}

/**
 * A furniture PROP rendered schematically (§4d LOD: props are data, not meshes). Draws a light footprint box,
 * a tiny glyph for the prop type, and a "name · $price" caption under it. Draggable/resizable via the shared
 * handlers (the group still gets the resize handle). Scaled to the unit because the footprint is unit-fraction.
 */
function PropBody({
  node, box, onBodyDown,
}: {
  node: GeoNode;
  box: FrameBox;
  onBodyDown: (e: React.MouseEvent) => void;
}) {
  const p = vPx(box);
  const r = node.footprint?.shape === "rect" ? node.footprint.rect : footprintRect(node.footprint);
  const tl = p({ x: r.x, y: r.y });
  const w = r.w * box.w;
  const h = r.h * box.h;
  const icon = propIcon(node);
  const price = node.price?.amountUsd;
  const caption = `${clipLabel(node.name, Math.max(w, 48) + 24)}${price != null ? ` · $${price.toLocaleString()}` : ""}`;
  return (
    <g className="mm-prop" onMouseDown={onBodyDown}>
      <rect x={tl.x} y={tl.y} width={Math.max(2, w)} height={Math.max(2, h)} rx={3} className="mm-prop__box" />
      <g transform={`translate(${tl.x},${tl.y})`} className="mm-prop__glyph">
        {propGlyph(icon, Math.max(2, w), Math.max(2, h))}
      </g>
      {/* caption sits just below the footprint so dense layouts stay readable */}
      <text x={tl.x + 1} y={tl.y + Math.max(2, h) + 11} className="mm-prop__cap">{caption}</text>
    </g>
  );
}

/** Schematic SVG glyph per prop icon, drawn to fit a w×h box. Kept simple — a plan symbol, not a picture. */
function propGlyph(icon: PropIcon | undefined, w: number, h: number) {
  const inset = 2;
  const x0 = inset;
  const y0 = inset;
  const iw = Math.max(2, w - inset * 2);
  const ih = Math.max(2, h - inset * 2);
  const cx = w / 2;
  const cy = h / 2;
  switch (icon) {
    case "bed":
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={2} />
          {/* pillow line */}
          <line x1={x0} y1={y0 + ih * 0.3} x2={x0 + iw} y2={y0 + ih * 0.3} />
          <line x1={cx} y1={y0} x2={cx} y2={y0 + ih * 0.3} />
        </g>
      );
    case "sofa":
      return (
        <g>
          <rect x={x0} y={y0 + ih * 0.3} width={iw} height={ih * 0.7} rx={2} />
          <rect x={x0} y={y0} width={iw} height={ih * 0.35} rx={2} />
          <line x1={cx} y1={y0 + ih * 0.3} x2={cx} y2={y0 + ih} />
        </g>
      );
    case "chair":
      return (
        <g>
          <rect x={x0} y={y0 + ih * 0.35} width={iw} height={ih * 0.65} rx={1} />
          <line x1={x0} y1={y0} x2={x0 + iw} y2={y0} />
        </g>
      );
    case "table":
      return <rect x={x0} y={y0} width={iw} height={ih} rx={2} />;
    case "desk":
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih * 0.55} rx={1} />
        </g>
      );
    case "wardrobe":
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={1} />
          <line x1={cx} y1={y0} x2={cx} y2={y0 + ih} />
        </g>
      );
    case "kitchen":
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={1} />
          <circle cx={x0 + iw * 0.25} cy={cy} r={Math.min(iw, ih) * 0.12} />
          <circle cx={x0 + iw * 0.6} cy={cy} r={Math.min(iw, ih) * 0.12} />
        </g>
      );
    case "tv":
      return <rect x={x0} y={y0} width={iw} height={ih} rx={1} />;
    case "bath":
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={Math.min(iw, ih) * 0.3} />
          <circle cx={x0 + iw * 0.8} cy={cy} r={Math.min(iw, ih) * 0.1} />
        </g>
      );
    case "rug":
      return <rect x={x0} y={y0} width={iw} height={ih} rx={1} strokeDasharray="3 2" />;
    case "plant":
      return (
        <g>
          <circle cx={cx} cy={cy - ih * 0.1} r={Math.min(iw, ih) * 0.35} />
          <line x1={cx} y1={cy} x2={cx} y2={y0 + ih} />
        </g>
      );
    // ---- (Slice E) bedroom ----
    case "dresser":
      // a low chest: a box with two drawer divisions
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={1} />
          <line x1={x0} y1={cy} x2={x0 + iw} y2={cy} />
          <line x1={cx} y1={y0} x2={cx} y2={cy} />
        </g>
      );
    case "nightstand":
      // a small square side table with a drawer line
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={1} />
          <line x1={x0} y1={y0 + ih * 0.35} x2={x0 + iw} y2={y0 + ih * 0.35} />
        </g>
      );
    // ---- (Slice E) kitchen ----
    case "counter":
      // a counter run: a long thin bar with a seam
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={1} />
          <line x1={cx} y1={y0} x2={cx} y2={y0 + ih} />
        </g>
      );
    case "stove":
      // a hob: a square with four burner circles
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={1} />
          <circle cx={x0 + iw * 0.3} cy={y0 + ih * 0.3} r={Math.min(iw, ih) * 0.12} />
          <circle cx={x0 + iw * 0.7} cy={y0 + ih * 0.3} r={Math.min(iw, ih) * 0.12} />
          <circle cx={x0 + iw * 0.3} cy={y0 + ih * 0.7} r={Math.min(iw, ih) * 0.12} />
          <circle cx={x0 + iw * 0.7} cy={y0 + ih * 0.7} r={Math.min(iw, ih) * 0.12} />
        </g>
      );
    case "sink":
      // a basin: a rounded rect with a centred bowl circle
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={2} />
          <circle cx={cx} cy={cy} r={Math.min(iw, ih) * 0.28} />
        </g>
      );
    case "fridge":
      // a tall box with a freezer divider line near the top
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={2} />
          <line x1={x0} y1={y0 + ih * 0.35} x2={x0 + iw} y2={y0 + ih * 0.35} />
        </g>
      );
    // ---- (Slice E) bathroom ----
    case "shower":
      // a square tray with a corner shower head dot + a diagonal drain
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={1} />
          <circle cx={x0 + iw * 0.2} cy={y0 + ih * 0.2} r={Math.min(iw, ih) * 0.1} />
          <line x1={x0} y1={y0} x2={x0 + iw} y2={y0 + ih} strokeDasharray="2 2" />
        </g>
      );
    case "toilet":
      // a bowl (ellipse) with a tank bar behind it
      return (
        <g>
          <rect x={x0 + iw * 0.15} y={y0} width={iw * 0.7} height={ih * 0.28} rx={1} />
          <ellipse cx={cx} cy={y0 + ih * 0.65} rx={iw * 0.32} ry={ih * 0.3} />
        </g>
      );
    case "washbasin":
      // a wall basin: a rounded trapezoid-ish rect with a bowl
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={Math.min(iw, ih) * 0.35} />
          <circle cx={cx} cy={cy} r={Math.min(iw, ih) * 0.22} />
        </g>
      );
    // ---- (Slice E) circulation ----
    case "stairs":
      // a flight of steps: an outline box with evenly spaced tread lines + an up-arrow
      return (
        <g>
          <rect x={x0} y={y0} width={iw} height={ih} rx={1} />
          {[0.2, 0.4, 0.6, 0.8].map((f) => (
            <line key={f} x1={x0} y1={y0 + ih * f} x2={x0 + iw} y2={y0 + ih * f} />
          ))}
          <line x1={cx} y1={y0 + ih * 0.9} x2={cx} y2={y0 + ih * 0.1} />
          <path d={`M ${cx - iw * 0.08} ${y0 + ih * 0.25} L ${cx} ${y0 + ih * 0.1} L ${cx + iw * 0.08} ${y0 + ih * 0.25}`} fill="none" />
        </g>
      );
    default:
      return <rect x={x0} y={y0} width={iw} height={ih} rx={2} />;
  }
}

function Breadcrumb({ pack, geo, focusNode }: { pack: Pack; geo: GeoApi; focusNode?: GeoNode }) {
  const chain = focusNode ? [...ancestorsOf(pack, focusNode.id).reverse(), focusNode] : [];
  return (
    <div className="mm-crumbs">
      <button className={`mm-crumb ${!focusNode ? "is-here" : ""}`} onClick={() => geo.focus(undefined)}>
        Site
      </button>
      {chain.map((n) => (
        <span key={n.id} className="mm-crumb-sep">
          <span className="mm-crumb-arrow">›</span>
          <button className={`mm-crumb ${geo.focusId === n.id ? "is-here" : ""}`} onClick={() => geo.focus(n.id)}>
            {n.name}
          </button>
        </span>
      ))}
    </div>
  );
}
