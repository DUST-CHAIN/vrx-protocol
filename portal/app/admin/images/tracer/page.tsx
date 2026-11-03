"use client";

// /admin/images/tracer — SVG FLOOR-PLAN TRACER. Slice 1: the coordinate-lock skeleton.
//
// THE CORE PRINCIPLE (why this exists / what fixed MM's "jumping" bug): the trace is stored in IMAGE-PIXEL
// space, NEVER in screen/window space. The view (pan + zoom) is a SEPARATE transform applied only at render
// time. A point clicked at image-pixel (120, 340) stays at (120, 340) forever — zooming, panning, or resizing
// the window changes the VIEW, not the stored geometry. px->metre calibration is a THIRD, independent mapping
// (one scalar: metresPerPixel) so real-world lengths are derived, never baked into the stored points.
//
//   screen = image * view.scale + view.offset        (render)
//   image  = (screen - view.offset) / view.scale      (hit-testing a click)
//   metres = imageDistance * metresPerPixel           (calibration, independent)
//
// Standalone (not coupled to MM's node/pack engine) but SVG-compatible so MM can absorb the output later.
// Exports BOTH an editable .svg (the trace as real SVG geometry, metre-aware) + a flattened .png (trace on a
// white ground). Sandbox tool — reachable from /admin/images; no new API route (export is client-side).
//
// Slice 1 scope: load a backdrop image (via ?img=<url> or file picker) -> pan/zoom the VIEW while the trace
// stays locked to image space -> click to lay polygon wall points -> calibrate px->metre by clicking a known
// dimension and typing its real length -> export SVG + PNG. Slices 2/3 add wall poché, door arcs, furniture,
// parametric edge editing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { T } from "@/lib/theme";
import { readOperatorSecret } from "@/lib/operator-secret";
import { tracerToUnitPlan } from "@/lib/tracer-to-unitplan";

// ── geometry types (image-pixel space is the single source of truth) ──────────────────────────────
type Pt = { x: number; y: number }; // ALWAYS image-pixel coordinates
type View = { scale: number; tx: number; ty: number }; // screen = image*scale + (tx,ty)
type Mode = "trace" | "calibrate" | "pan" | "text" | "door" | "window" | "furniture" | "wall";

/** A door: anchored at (x,y) on a wall, `w` = opening width (image-px), `rot` = wall orientation (deg),
 * `flip` = swing side, `mirror` = hinge end — two independent axes for all 4 orientations.
 *  Rendered as a leaf line + a quarter-circle swing arc (half-open). */
type Door = { x: number; y: number; w: number; rot: number; flip: boolean; mirror: boolean };
/** A window: anchored at (x,y) on a wall, `w` = opening width (image-px), `rot` = wall orientation (deg).
 * Rendered as a double parallel line (the glazing) spanning the opening — no swing, so no flip/mirror. (.) */
type Win = { x: number; y: number; w: number; rot: number };

/** A furniture symbol: a `kind` from the library, placed at (x,y) with size (w,h in image-px) + rotation. */
type FurnitureKind = "bed" | "sofa" | "table" | "toilet" | "sink" | "stove" | "tub" | "fridge" | "column" | "cabinet";
type Furniture = { kind: FurnitureKind; x: number; y: number; w: number; h: number; rot: number };

/** A placed text label in IMAGE-pixel space (room names, notes). size is a metre/px-independent font size in px.
 *  rot = rotation in degrees about the label anchor (0 = horizontal, -90 = read-up vertical). */
type TextLabel = { x: number; y: number; text: string; size: number; rot: number };

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

function screenToImage(sx: number, sy: number, v: View): Pt {
  return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
}
function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── DECORATIVE SYMBOL LIBRARY ──────────────────────────────────────────────────────────────────────
// Each furniture symbol is drawn in a LOCAL unit box [0..w]×[0..h] (origin top-left) as plain SVG primitives
// with thin black strokes, matching the reference plans (outline furniture, solid-black walls). The caller
// wraps the returned inner markup in a <g transform="translate+rotate"> so it lands in image space at any angle.
// Pure string builders → identical output on the live canvas and in the export (one source of truth).
const STROKE = "#1a1a1a";

//  Reverse of portal/lib/floorplans.ts TYPE_PREFIX: the filename PREFIX in a unit-plan path → a human label.
// Lets the tracer name a traced outline after the UNIT it belongs to (from the ?img=…/units/<PREFIX>_<SUB>.jpg
// path) instead of a generic "ROOM" — we already know the type+subtype, so use it. Unknown prefix → "ROOM".
const PLAN_PREFIX_LABEL: Record<string, string> = {
  STD: "STUDIO", "1BR": "1 BEDROOM", "2BR": "2 BEDROOM", "3BR": "3 BEDROOM", "4BR": "4 BEDROOM",
  SHP: "SHOP", DPX: "DUPLEX", PTH: "PENTHOUSE",
};
/** Parse a unit-plan relPath → "1 BEDROOM B" (type label + subtype letter), or null if it isn't a units/ path. */
function unitLabelFromPath(src: string | null): string | null {
  if (!src) return null;
  const m = src.replace(/^\//, "").split("?")[0].match(/\/units\/([A-Za-z0-9]+)_([A-Za-z0-9]+)\.(jpe?g|png|webp)$/i);
  if (!m) return null;
  const base = PLAN_PREFIX_LABEL[m[1].toUpperCase()] || "ROOM";
  const sub = m[2].toUpperCase();
  return sub && sub !== "A" ? `${base} ${sub}` : base; // "A" is the default/only variant → omit the letter
}

function furnitureInner(kind: FurnitureKind, w: number, h: number): string {
  const r = (n: number) => n.toFixed(1);
  const rect = (x: number, y: number, ww: number, hh: number, rx = 0) =>
    `<rect x="${r(x)}" y="${r(y)}" width="${r(ww)}" height="${r(hh)}"${rx ? ` rx="${r(rx)}"` : ""} fill="none" stroke="${STROKE}" stroke-width="2"/>`;
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${STROKE}" stroke-width="1.5"/>`;
  const circle = (cx: number, cy: number, rad: number) =>
    `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad)}" fill="none" stroke="${STROKE}" stroke-width="1.5"/>`;
  const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
    `<ellipse cx="${r(cx)}" cy="${r(cy)}" rx="${r(rx)}" ry="${r(ry)}" fill="none" stroke="${STROKE}" stroke-width="1.5"/>`;
  switch (kind) {
    case "bed": {
      // mattress + two pillows at the head (top edge)
      const pad = w * 0.06;
      return (
        rect(0, 0, w, h, w * 0.04) +
        rect(pad, pad, w / 2 - pad * 1.5, h * 0.2, 3) +
        rect(w / 2 + pad * 0.5, pad, w / 2 - pad * 1.5, h * 0.2, 3) +
        line(pad, h * 0.3, w - pad, h * 0.3) // blanket fold line
      );
    }
    case "sofa": {
      const arm = w * 0.12;
      return (
        rect(0, 0, w, h, 6) + // back + base
        rect(arm, h * 0.28, w - 2 * arm, h * 0.72 - 4, 4) + // seat
        line(w / 3, h * 0.28, w / 3, h) +
        line((2 * w) / 3, h * 0.28, (2 * w) / 3, h)
      );
    }
    case "table": {
      const out: string[] = [rect(w * 0.18, h * 0.18, w * 0.64, h * 0.64, 4)];
      // four chairs
      out.push(rect(w * 0.3, 0, w * 0.4, h * 0.14, 2));
      out.push(rect(w * 0.3, h * 0.86, w * 0.4, h * 0.14, 2));
      out.push(rect(0, h * 0.3, w * 0.14, h * 0.4, 2));
      out.push(rect(w * 0.86, h * 0.3, w * 0.14, h * 0.4, 2));
      return out.join("");
    }
    case "toilet":
      return rect(w * 0.2, 0, w * 0.6, h * 0.28, 3) + ellipse(w / 2, h * 0.62, w * 0.34, h * 0.36);
    case "sink":
      return rect(0, 0, w, h, 5) + ellipse(w / 2, h * 0.52, w * 0.33, h * 0.33) + circle(w / 2, h * 0.14, Math.min(w, h) * 0.05);
    case "stove": {
      const out = [rect(0, 0, w, h, 3)];
      const cx = [w * 0.3, w * 0.7];
      const cy = [h * 0.3, h * 0.7];
      for (const x of cx) for (const y of cy) out.push(circle(x, y, Math.min(w, h) * 0.13));
      return out.join("");
    }
    case "tub":
      return rect(0, 0, w, h, 8) + rect(w * 0.1, h * 0.1, w * 0.8, h * 0.8, w * 0.3) + circle(w * 0.82, h * 0.18, Math.min(w, h) * 0.05);
    case "fridge":
      return rect(0, 0, w, h, 3) + line(0, h * 0.5, w, h * 0.5) + line(w * 0.82, h * 0.12, w * 0.82, h * 0.38);
    case "column":
      return `<rect x="0" y="0" width="${r(w)}" height="${r(h)}" fill="${STROKE}" stroke="${STROKE}"/>`; // solid structural column
    case "cabinet": {
      // resizable wall cabinet: box with diagonal hatch (the reference's wardrobe look)
      const out = [rect(0, 0, w, h)];
      const n = Math.max(3, Math.round(w / 22));
      for (let i = 0; i <= n; i++) { const x = (w * i) / n; out.push(line(x, 0, Math.max(0, x - h), h)); }
      return out.join("");
    }
    default:
      return rect(0, 0, w, h);
  }
}
/** Door inner markup in a local frame where the opening runs along +x from (0,0) to (w,0).
 *  TWO independent mirror axes give all four swing orientations (a door in any corner):
 *    flip   — swing side: the leaf sweeps DOWN (+y) when true, UP (−y) when false.
 *    mirror — hinge end: the leaf pivots from the RIGHT end (x=w) when true, the LEFT end (x=0) when false.
 * Compose with `rot` to aim the opening along any wall. (.) */
function doorInner(w: number, flip: boolean, mirror: boolean): string {
  const r = (n: number) => n.toFixed(1);
  const sy = flip ? 1 : -1; // swing down (+y) or up (−y)
  const hx = mirror ? w : 0; // hinge x — right end when mirrored, else left
  const fx = mirror ? 0 : w; // free (latch) end x — the opposite end, where the arc springs from
  // leaf (open 90°) hinged at (hx,0) sweeping to (hx, sy·w); the quarter-circle arc runs from the free end to the leaf tip.
  // sweep-flag flips with BOTH axes (hinge side XOR swing side) so the arc always bows the correct way.
  const sweep = (flip ? 1 : 0) ^ (mirror ? 1 : 0);
  return (
    `<line x1="${r(hx)}" y1="0" x2="${r(hx)}" y2="${r(sy * w)}" stroke="${STROKE}" stroke-width="2"/>` +
    `<path d="M ${r(fx)} 0 A ${r(w)} ${r(w)} 0 0 ${sweep} ${r(hx)} ${r(sy * w)}" fill="none" stroke="${STROKE}" stroke-width="1.5" stroke-dasharray="4 4"/>`
  );
}
/** Window inner markup: the opening runs along +x from (0,0) to (w,0). Drawn as the architectural convention —
 * two end jambs + a double parallel glazing line across the gap (the panes). No swing. (.) */
function windowInner(w: number): string {
  const r = (n: number) => n.toFixed(1);
  const g = 2.5; // half-gap between the two glazing lines (image-px)
  return (
    `<line x1="0" y1="${r(-g * 1.6)}" x2="0" y2="${r(g * 1.6)}" stroke="${STROKE}" stroke-width="2"/>` + // left jamb
    `<line x1="${r(w)}" y1="${r(-g * 1.6)}" x2="${r(w)}" y2="${r(g * 1.6)}" stroke="${STROKE}" stroke-width="2"/>` + // right jamb
    `<line x1="0" y1="${r(-g)}" x2="${r(w)}" y2="${r(-g)}" stroke="${STROKE}" stroke-width="1.2"/>` + // outer pane line
    `<line x1="0" y1="${r(g)}" x2="${r(w)}" y2="${r(g)}" stroke="${STROKE}" stroke-width="1.2"/>` // inner pane line
  );
}
const FURNITURE_KINDS: FurnitureKind[] = ["bed", "sofa", "table", "toilet", "sink", "stove", "tub", "fridge", "column", "cabinet"];
// Real-world default sizes in METRES (a double bed is 1.5×2.0 m, a sofa 2.0×0.9 m, etc.). When the plan is
// calibrated these place to-scale (px = metres / metresPerPixel); uncalibrated, metres are treated as px.
const FURNITURE_DEFAULT_M: Record<FurnitureKind, { w: number; h: number }> = {
  bed: { w: 1.5, h: 2.0 }, sofa: { w: 2.0, h: 0.9 }, table: { w: 1.4, h: 1.4 }, toilet: { w: 0.5, h: 0.7 },
  sink: { w: 0.6, h: 0.45 }, stove: { w: 0.6, h: 0.6 }, tub: { w: 0.75, h: 1.7 }, fridge: { w: 0.7, h: 0.7 },
  column: { w: 0.4, h: 0.4 }, cabinet: { w: 1.8, h: 0.55 },
};

// ── PURE geometry (lifted from portal/mm/lib/geo.ts — decoupled from MM's Pack/node model so they operate on
// raw image-pixel points). These are the proven cores behind MM's area/snap/edge editing. ─────────────────
/** Shoelace area (abs) of a polygon in whatever units `points` are in. */
function polyArea(points: Pt[]): number {
  if (points.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}
/** Centroid (vertex average — matches MM's constrainPolySqm anchor). */
function polyCentroid(points: Pt[]): Pt {
  const n = points.length || 1;
  return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
}
/** Scale a polygon about its centroid by factor k (the core of MM's constrainPolySqm). Frozen verts stay put. */
function scaleAboutCentroid(points: Pt[], k: number, frozen?: Set<number>): Pt[] {
  const c = polyCentroid(points);
  return points.map((p, i) => (frozen?.has(i) ? p : { x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));
}
/** Snap a polygon to an exact target area by uniform scale about the centroid. area ∝ k² ⇒ k = √(target/current). */
function snapPolyToArea(points: Pt[], targetArea: number): Pt[] {
  const cur = polyArea(points);
  if (cur <= 0 || !(targetArea > 0)) return points;
  return scaleAboutCentroid(points, Math.sqrt(targetArea / cur));
}
/** Resize edge i→i+1 to an exact length, keeping vertex i pinned and sliding i+1 along the edge direction. */
function setEdgeLength(points: Pt[], i: number, newLen: number): Pt[] {
  const n = points.length;
  const a = points[i];
  const b = points[(i + 1) % n];
  const d = dist(a, b);
  if (d <= 0 || !(newLen > 0)) return points;
  const ux = (b.x - a.x) / d;
  const uy = (b.y - a.y) / d;
  const out = points.slice();
  out[(i + 1) % n] = { x: a.x + ux * newLen, y: a.y + uy * newLen };
  return out;
}

export default function TracerPage() {
  // useSearchParams must be under a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div style={{ padding: 24, color: T.dim }}>Loading tracer…</div>}>
      <Tracer />
    </Suspense>
  );
}

function Tracer() {
  const params = useSearchParams();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [imgUrl, setImgUrl] = useState<string | null>(params.get("img"));
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [mode, setMode] = useState<Mode>("trace");
  const [expectedSqm, setExpectedSqm] = useState<number | null>(null); // the unit's size from the catalog data
  const [manualSqm, setManualSqm] = useState(""); // fallback when there's no data (user types it top-right)

  // look up the EXPECTED size (m²) from the catalog for the plan we opened — shown in the header + one-click apply.
  useEffect(() => {
    const src = params.get("img");
    if (!src) { setExpectedSqm(null); return; }
    const relPath = src.replace(/^\//, "").split("?")[0];
    fetch(`/api/admin/images/expected-area?relPath=${encodeURIComponent(relPath)}`)
      .then((r) => r.json())
      .then((j) => setExpectedSqm(j?.ok && typeof j.expected === "number" ? j.expected : null))
      .catch(() => setExpectedSqm(null));
  }, [params]);

  //  the UNIT's name derived from the deep-link path (e.g. "1 BEDROOM B") — the default room label, so a
  // trace opened for a specific unit auto-names after it instead of a generic "ROOM". null when opened from a
  // file picker / non-unit image → auto-label falls back to "ROOM".
  const unitLabel = useMemo(() => unitLabelFromPath(params.get("img")), [params]);

  // The trace: a list of polygons, each a list of image-space points. The last one is the "active" polygon
  // being drawn. Slice 1 treats every polygon as an (optionally closed) wall loop.
  const [polys, setPolys] = useState<Pt[][]>([[]]);
  // closed loops = all polys except the active (last) one. Derived — never a separate counter (that drifted under
  // React StrictMode's double-invoked updaters, reporting "2 loops" for one close).
  const closedCount = Math.max(0, polys.length - 1);

  // TEXT labels (room names / notes), placed in image space. Dragged like vertices; part of the SVG/PNG export.
  const [texts, setTexts] = useState<TextLabel[]>([]);
  const [selectedText, setSelectedText] = useState<number | null>(null);
  const textDragRef = useRef<number | null>(null);

  // DOORS + FURNITURE (decorative layers). Placed by clicking in door/furniture mode; drag to move; select for
  // rotate/resize. `style` toggles the WALL render: "schematic" (thin stroke, editing) vs "poché" (thick solid).
  const [doors, setDoors] = useState<Door[]>([]);
  const [windows, setWindows] = useState<Win[]>([]);
  const [furniture, setFurniture] = useState<Furniture[]>([]);
  const [selDoor, setSelDoor] = useState<number | null>(null);
  const [selWin, setSelWin] = useState<number | null>(null);
  const [selFurn, setSelFurn] = useState<number | null>(null);
  const [furnKind, setFurnKind] = useState<FurnitureKind>("bed");
  const [wallStyle, setWallStyle] = useState<"schematic" | "poche">("poche");
  const wallPx = 10; // poché EXTERIOR/structural wall thickness in image-px (room outlines — the building shell)
  const interiorWallPx = 6; //  thinner weight for internal partition walls — the architect's poché hierarchy
  //                           (exterior shell reads heavier than room dividers, like a professional plan)
  const decoDragRef = useRef<{ kind: "door" | "furn"; i: number } | null>(null);

  // INTERNAL WALLS / partition lines — OPEN polylines (not closed rooms). Click point-to-point in "wall" mode,
  // Enter or double-click to finish. Drawn as thick poché lines; vertices draggable; in undo + export.
  const [walls, setWalls] = useState<Pt[][]>([]);
  const wallDragRef = useRef<{ wall: number; vert: number } | null>(null);
  const [activeWall, setActiveWall] = useState<Pt[]>([]); // the partition being drawn

  // Presentation title band (16:9 export footer). Default pulled from the source plan filename; user-editable.
  const [title, setTitle] = useState("FLOOR PLAN");
  const [preview, setPreview] = useState(false); // show the 16:9 presentation render instead of the editor canvas

  // Right-rail width — user-resizable (drag the left edge), persisted. Clamped 280–560.
  const [railW, setRailW] = useState(375);
  const railDrag = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const saved = Number(localStorage.getItem("vrx.tracer.railW"));
    if (saved >= 280 && saved <= 560) setRailW(saved);
  }, []);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!railDrag.current) return;
      const w = Math.max(280, Math.min(560, railDrag.current.startW + (railDrag.current.startX - e.clientX)));
      setRailW(w);
    };
    const up = () => {
      if (railDrag.current) {
        localStorage.setItem("vrx.tracer.railW", String(Math.round(railW)));
        railDrag.current = null;
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [railW]);

  // ── UNDO/REDO history — a stack of {polys, texts} snapshots. We push BEFORE each discrete edit (a drag counts
  // once, snapshotted on drag-start), so Ctrl+Z steps back one operation. `redo` holds popped states. ───────
  type Snap = { polys: Pt[][]; texts: TextLabel[]; doors: Door[]; windows: Win[]; furniture: Furniture[]; walls: Pt[][] };
  const history = useRef<Snap[]>([]);
  const redo = useRef<Snap[]>([]);
  const [histLen, setHistLen] = useState(0); // drives the Undo button's enabled state
  const takeSnap = (): Snap => ({
    polys: polys.map((p) => p.map((pt) => ({ ...pt }))),
    texts: texts.map((t) => ({ ...t })),
    doors: doors.map((d) => ({ ...d })),
    windows: windows.map((w) => ({ ...w })),
    furniture: furniture.map((f) => ({ ...f })),
    walls: walls.map((w) => w.map((pt) => ({ ...pt }))),
  });
  const applySnap = (snap: Snap) => {
    setPolys(snap.polys);
    setTexts(snap.texts);
    setDoors(snap.doors);
    setWindows(snap.windows);
    setFurniture(snap.furniture);
    setWalls(snap.walls);
    setSelectedEdge(null);
  };
  const snapshot = useCallback(() => {
    history.current.push(takeSnap());
    if (history.current.length > 100) history.current.shift();
    redo.current = [];
    setHistLen(history.current.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polys, texts, doors, windows, furniture, walls]);
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) return;
    redo.current.push(takeSnap());
    applySnap(prev);
    setHistLen(history.current.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polys, texts, doors, windows, furniture, walls]);
  const redoOp = useCallback(() => {
    const next = redo.current.pop();
    if (!next) return;
    history.current.push(takeSnap());
    applySnap(next);
    setHistLen(history.current.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polys, texts, doors, windows, furniture, walls]);

  // Calibration: metres-per-pixel in IMAGE space. null = uncalibrated (shows px only).
  const [metresPerPixel, setMetresPerPixel] = useState<number | null>(null);
  const [calA, setCalA] = useState<Pt | null>(null); // first click of a calibration segment

  const [hoverImg, setHoverImg] = useState<Pt | null>(null);
  const [backdropOpacity, setBackdropOpacity] = useState(0.85); // slider: dial the reference image faint to see the trace
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);

  // EDIT state: which finished polygon is selected, and which of its vertices is being dragged.
  const [selected, setSelected] = useState<number | null>(null); // index into `polys` of a CLOSED poly (edit mode)
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null); // edge i of the selected poly (for length edit)
  const dragRef = useRef<{ poly: number; vert: number } | null>(null);
  const HIT_PX = 10; // screen-pixel hit radius for grabbing a vertex

  const active = polys[polys.length - 1];

  // ── load the backdrop image to learn its natural pixel size (the image-space extent) ──────────────
  //  EXTENSION FALLBACK: a deep-link from MM guesses.jpg, but a unit plan may actually be.png/.webp on disk
  // (MM can't read the portal's files). If the given URL 404s, try the sibling extensions and ADOPT the one that
  // loads (updating imgUrl so the rendered backdrop <img> uses it too). Only when all fail do we treat it as "no
  // image" (→ the create-a-new-plan path). Guarded against loops: we only re-derive from the *original* stem.
  useEffect(() => {
    if (!imgUrl) {
      setImgSize(null);
      return;
    }
    let cancelled = false;
    const exts = ["jpg", "jpeg", "png", "webp"];
    const stem = imgUrl.replace(/\.(jpe?g|png|webp)$/i, "");
    const hadExt = stem !== imgUrl;
    // candidate list: the URL as given first, then sibling extensions (only if it looked like an image path)
    const candidates = hadExt ? [imgUrl, ...exts.map((e) => `${stem}.${e}`).filter((u) => u !== imgUrl)] : [imgUrl];
    const tryAt = (i: number) => {
      if (cancelled || i >= candidates.length) { if (!cancelled) setImgSize(null); return; }
      const im = new Image();
      im.onload = () => {
        if (cancelled) return;
        setImgSize({ w: im.naturalWidth, h: im.naturalHeight });
        if (candidates[i] !== imgUrl) setImgUrl(candidates[i]); // adopt the extension that actually exists
      };
      im.onerror = () => tryAt(i + 1);
      im.src = candidates[i];
    };
    tryAt(0);
    return () => { cancelled = true; };
  }, [imgUrl]);

  // ── fit the image to the viewport once we know both sizes (initial view only) ─────────────────────
  const fitView = useCallback(() => {
    const el = svgRef.current;
    if (!el || !imgSize) return;
    const r = el.getBoundingClientRect();
    const pad = 40;
    const scale = Math.min((r.width - pad) / imgSize.w, (r.height - pad) / imgSize.h);
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    setView({ scale: s, tx: (r.width - imgSize.w * s) / 2, ty: (r.height - imgSize.h * s) / 2 });
  }, [imgSize]);
  useEffect(() => {
    fitView();
  }, [fitView]);

  // ── screen (client) coords -> local SVG coords (account for the element's position on the page) ───
  const localXY = useCallback((e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }, []);

  // ── wheel = zoom the VIEW about the cursor; the trace does not move in image space ────────────────
  // Attached as a NON-passive native listener (React's onWheel is passive → preventDefault is a no-op and the
  // page would scroll while zooming). The handler keeps the image point under the cursor fixed.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
        const k = next / v.scale;
        // screen = image*scale + t  =>  t' = screen - (screen - t)*k  (cursor-anchored zoom)
        return { scale: next, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // ── pointer handlers ──────────────────────────────────────────────────────────────────────────────
  const spaceDown = useRef(false);
  useEffect(() => {
    const d = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = true;
      // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoOp();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoOp();
        return;
      }
      if (e.key === "Enter") { if (mode === "wall") finishWall(); else closeActive(); }
      if (e.key === "Escape") { setCalA(null); setActiveWall([]); }
      // Backspace = drop the last point of the active (in-progress) loop or wall.
      if (e.key === "Backspace") {
        if (mode === "wall") setActiveWall((w) => w.slice(0, -1));
        else undoPoint();
      }
    };
    const u = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = false;
    };
    window.addEventListener("keydown", d);
    window.addEventListener("keyup", u);
    return () => {
      window.removeEventListener("keydown", d);
      window.removeEventListener("keyup", u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, calA, undo, redoOp, activeWall, walls]);

  /** Find the closest vertex (across ALL polys) within HIT_PX screen pixels of (sx,sy). */
  function hitVertex(sx: number, sy: number): { poly: number; vert: number } | null {
    let bestPoly = -1;
    let bestVert = -1;
    let bestD = HIT_PX;
    for (let pi = 0; pi < polys.length; pi++) {
      const poly = polys[pi];
      for (let vi = 0; vi < poly.length; vi++) {
        const p = poly[vi];
        const scr = { x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty };
        const d = Math.hypot(scr.x - sx, scr.y - sy);
        if (d <= bestD) {
          bestD = d;
          bestPoly = pi;
          bestVert = vi;
        }
      }
    }
    return bestPoly >= 0 ? { poly: bestPoly, vert: bestVert } : null;
  }
  /** Is (image-space) point inside a closed polygon? (ray cast) — for click-to-select. */
  function pointInPoly(pt: Pt, poly: Pt[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  /** Hit-test a text label near (sx,sy) screen px — a generous box around its anchor scaled by its font size. */
  function hitText(sx: number, sy: number): number | null {
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      const scrX = t.x * view.scale + view.tx;
      const scrY = t.y * view.scale + view.ty;
      const halfW = Math.max(30, t.text.length * t.size * 0.3) * view.scale;
      const halfH = Math.max(14, t.size * 0.7) * view.scale;
      if (Math.abs(sx - scrX) <= halfW && Math.abs(sy - scrY) <= halfH) return i;
    }
    return null;
  }
  /** Hit a door/furniture anchor within a generous radius (screen px). */
  function hitDeco(sx: number, sy: number): { kind: "door" | "furn"; i: number } | null {
    for (let i = furniture.length - 1; i >= 0; i--) {
      const f = furniture[i];
      const cx = (f.x + f.w / 2) * view.scale + view.tx;
      const cy = (f.y + f.h / 2) * view.scale + view.ty;
      const hw = (f.w / 2 + 8) * view.scale, hh = (f.h / 2 + 8) * view.scale;
      if (Math.abs(sx - cx) <= hw && Math.abs(sy - cy) <= hh) return { kind: "furn", i };
    }
    for (let i = doors.length - 1; i >= 0; i--) {
      const d = doors[i];
      const cx = d.x * view.scale + view.tx, cy = d.y * view.scale + view.ty;
      if (Math.hypot(sx - cx, sy - cy) <= (d.w + 12) * view.scale) return { kind: "door", i };
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent) {
    const { sx, sy } = localXY(e);
    const panning = mode === "pan" || spaceDown.current || e.button === 1 || e.button === 2;
    if (panning) {
      panRef.current = { sx, sy, tx: view.tx, ty: view.ty };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    const p = screenToImage(sx, sy, view);
    if (mode === "calibrate") {
      if (!calA) setCalA(p);
      else {
        const px = dist(calA, p);
        setCalA(null);
        if (px > 2) promptCalibration(px);
      }
      return;
    }

    // TEXT labels: grabbing an existing label (to drag it) takes priority in ANY mode.
    const ti = hitText(sx, sy);
    if (ti != null) {
      snapshot();
      textDragRef.current = ti;
      setSelectedText(ti);
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (mode === "text") {
      placeText(p); // click empty space in text mode → place a new label here
      return;
    }

    // DOORS + FURNITURE: grab an existing one to drag (priority), else click places a new one in that mode.
    const dh = hitDeco(sx, sy);
    if (dh) {
      snapshot();
      decoDragRef.current = dh;
      if (dh.kind === "door") { setSelDoor(dh.i); setSelFurn(null); } else { setSelFurn(dh.i); setSelDoor(null); }
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (mode === "door") { placeDoor(p); return; }
    if (mode === "window") { placeWindow(p); return; }
    if (mode === "furniture") { placeFurniture(p); return; }

    // INTERNAL WALL mode: grab a finished-wall vertex to drag, else append a point (SHIFT = ortho-lock).
    if (mode === "wall") {
      for (let wi = 0; wi < walls.length; wi++) {
        for (let vi = 0; vi < walls[wi].length; vi++) {
          const q = walls[wi][vi];
          if (Math.hypot(q.x * view.scale + view.tx - sx, q.y * view.scale + view.ty - sy) <= HIT_PX) {
            snapshot();
            wallDragRef.current = { wall: wi, vert: vi };
            (e.target as Element).setPointerCapture?.(e.pointerId);
            return;
          }
        }
      }
      let np = p;
      if (e.shiftKey && activeWall.length > 0) {
        const prev = activeWall[activeWall.length - 1];
        np = Math.abs(p.x - prev.x) >= Math.abs(p.y - prev.y) ? { x: p.x, y: prev.y } : { x: prev.x, y: p.y };
      }
      setActiveWall((w) => [...w, np]);
      return;
    }

    // LINE-TRACING close: while actively drawing (open loop, ≥3 pts), clicking the START dot closes the loop.
    // This takes priority over vertex-grab so the start point acts as "finish here", not "drag me".
    if (mode === "trace" && active.length >= 3) {
      const start = active[0];
      const startScr = { x: start.x * view.scale + view.tx, y: start.y * view.scale + view.ty };
      if (Math.hypot(startScr.x - sx, startScr.y - sy) <= HIT_PX + 4) {
        closeActive();
        return;
      }
    }

    // EDIT/TRACE: try to GRAB a vertex (drag it) — works on the active poly AND any closed poly.
    const hit = hitVertex(sx, sy);
    if (hit) {
      snapshot(); // one undo step per drag (snapshot at drag-start, before the move stream)
      dragRef.current = hit;
      setSelected(hit.poly < polys.length - 1 ? hit.poly : null);
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }

    // Click inside a CLOSED poly → select it for editing (area/edge/snap) instead of adding a point.
    const closedHit = polys.slice(0, polys.length - 1).findIndex((poly) => poly.length >= 3 && pointInPoly(p, poly));
    if (mode === "trace" && active.length === 0 && closedHit >= 0) {
      setSelected(closedHit);
      setSelectedEdge(null);
      return;
    }

    if (mode !== "trace") return;
    // If a room is SELECTED, a click on empty space just DESELECTS (don't surprise-start a new trace).
    if (selected != null) {
      setSelected(null);
      setSelectedEdge(null);
      return;
    }
    // trace mode, empty space, nothing selected: append a point to the active polygon (extend the current loop).
    // SHIFT = axis-constrain (ortho-lock): snap the new point horizontal/vertical to the previous one — the
    // standard CAD affordance for drawing straight walls.
    let np = p;
    if (e.shiftKey && active.length > 0) {
      const prev = active[active.length - 1];
      if (Math.abs(p.x - prev.x) >= Math.abs(p.y - prev.y)) np = { x: p.x, y: prev.y };
      else np = { x: prev.x, y: p.y };
    }
    snapshot();
    setPolys((ps) => {
      const copy = ps.map((poly) => poly.slice());
      copy[copy.length - 1] = [...copy[copy.length - 1], np];
      return copy;
    });
  }

  function onPointerMove(e: React.PointerEvent) {
    const { sx, sy } = localXY(e);
    if (panRef.current) {
      const d = panRef.current;
      setView((v) => ({ ...v, tx: d.tx + (sx - d.sx), ty: d.ty + (sy - d.sy) }));
      return;
    }
    // DRAGGING a vertex: move it to the cursor in IMAGE space (stays coordinate-locked).
    if (dragRef.current) {
      const img = screenToImage(sx, sy, view);
      const { poly, vert } = dragRef.current;
      setPolys((ps) => {
        const copy = ps.map((p) => p.slice());
        copy[poly][vert] = img;
        return copy;
      });
      return;
    }
    // DRAGGING a text label.
    if (textDragRef.current != null) {
      const img = screenToImage(sx, sy, view);
      const ti = textDragRef.current;
      setTexts((ts) => ts.map((t, j) => (j === ti ? { ...t, x: img.x, y: img.y } : t)));
      return;
    }
    // DRAGGING a door (anchor) or furniture (top-left kept so centre follows cursor).
    if (decoDragRef.current) {
      const img = screenToImage(sx, sy, view);
      const { kind, i } = decoDragRef.current;
      if (kind === "door") setDoors((ds) => ds.map((d, j) => (j === i ? { ...d, x: img.x, y: img.y } : d)));
      else setFurniture((fs) => fs.map((f, j) => (j === i ? { ...f, x: img.x - f.w / 2, y: img.y - f.h / 2 } : f)));
      return;
    }
    // DRAGGING an internal-wall vertex.
    if (wallDragRef.current) {
      const img = screenToImage(sx, sy, view);
      const { wall, vert } = wallDragRef.current;
      setWalls((ws) => ws.map((w, j) => (j === wall ? w.map((pt, k) => (k === vert ? img : pt)) : w)));
      return;
    }
    setHoverImg(screenToImage(sx, sy, view));
  }

  function onPointerUp(e: React.PointerEvent) {
    if (panRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      panRef.current = null;
    }
    if (dragRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
    if (textDragRef.current != null) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      textDragRef.current = null;
    }
    if (decoDragRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      decoDragRef.current = null;
    }
    if (wallDragRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      wallDragRef.current = null;
    }
  }

  // ── trace editing ─────────────────────────────────────────────────────────────────────────────────
  function closeActive() {
    if (active.length < 3) return;
    snapshot();
    setPolys((ps) => {
      if (ps[ps.length - 1].length < 3) return ps;
      return [...ps, []]; // start a fresh active polygon (closed count is derived from polys.length)
    });
  }
  function undoPoint() {
    setPolys((ps) => {
      const copy = ps.map((poly) => poly.slice());
      const last = copy[copy.length - 1];
      if (last.length > 0) last.pop();
      else if (copy.length > 1) copy.pop(); // drop back into the previous (closed) polygon to keep editing it
      return copy;
    });
  }
  function clearAll() {
    snapshot();
    setPolys([[]]);
    setTexts([]);
    setDoors([]);
    setWindows([]);
    setFurniture([]);
    setWalls([]);
    setActiveWall([]);
    setSelected(null);
    setSelectedEdge(null);
    setSelDoor(null);
    setSelWin(null);
    setSelFurn(null);
  }
  function deleteSelectedVertex() {
    if (selected == null || selectedEdge == null) return;
    snapshot();
    setPolys((ps) => {
      const copy = ps.map((p) => p.slice());
      // delete the LAST-touched vertex is ambiguous; instead we delete via the selected edge's start vertex if set.
      if (selectedEdge != null && copy[selected].length > 3) copy[selected].splice(selectedEdge, 1);
      return copy;
    });
    setSelectedEdge(null);
  }

  // ── EDIT ops (operate on the SELECTED closed polygon) — reuse MM's pure geometry cores ───────────────
  /**
   * Set the room's total area to an exact value (e.g. the plan's stated 33.27 m²).
   *  • UNCALIBRATED: typing the area CALIBRATES the whole plan FROM it — metresPerPixel is derived so this
   *    room measures exactly what you typed, the SHAPE is untouched, and EVERYTHING (labels, title band, other
   *    rooms) flips to m². This is why you never have to hunt for a wall dimension: the area IS the scale.
   *  • CALIBRATED: scales the shape uniformly about its centroid to hit the target area (shape proportions kept).
   */
  /** Core: make the SELECTED room measure exactly `targetM2`. Uncalibrated → derive the plan scale from it (shape
   *  untouched); calibrated → scale the shape about its centroid to hit the target. Shared by the prompt + the
   *  one-click "use the data's size". */
  function applyAreaToSelected(targetM2: number) {
    if (selected == null || !(targetM2 > 0)) return;
    const areaPx = polyArea(polys[selected]);
    if (areaPx <= 0) return;
    if (!metresPerPixel) {
      setMetresPerPixel(Math.sqrt(targetM2 / areaPx)); // area_m² = area_px·mpp² ⇒ mpp = √(target/area_px)
      return;
    }
    const targetPx = targetM2 / (metresPerPixel * metresPerPixel);
    snapshot();
    setPolys((ps) => {
      const copy = ps.map((p) => p.slice());
      copy[selected] = snapPolyToArea(copy[selected], targetPx);
      return copy;
    });
  }
  function snapSelectedToArea() {
    if (selected == null) return;
    const areaPx = polyArea(polys[selected]);
    if (areaPx <= 0) return;
    const cur = metresPerPixel ? (areaPx * metresPerPixel * metresPerPixel).toFixed(2) : "";
    const suggest = expectedSqm != null ? String(expectedSqm) : cur;
    const raw = window.prompt(
      metresPerPixel
        ? `Set the total area of this room (m²).\nCurrent: ${cur} m²${expectedSqm != null ? `\nData says: ${expectedSqm} m²` : ""}`
        : `What is this room's real area, in m²?${expectedSqm != null ? `\n(the data says ${expectedSqm})` : " (e.g. 33.27)"}\n\nThis sets the scale for the WHOLE plan.`,
      suggest
    );
    if (raw == null) return;
    const target = parseFloat(raw.replace(",", "."));
    if (isFinite(target) && target > 0) applyAreaToSelected(target);
  }
  /** Edit the length of the SELECTED edge (far end moves, start vertex pinned). */
  function editSelectedEdgeLength() {
    if (selected == null || selectedEdge == null) return;
    const poly = polys[selected];
    const a = poly[selectedEdge];
    const b = poly[(selectedEdge + 1) % poly.length];
    const curPx = dist(a, b);
    const cur = metresPerPixel ? curPx * metresPerPixel : curPx;
    const unit = metresPerPixel ? "m" : "px";
    const raw = window.prompt(`Set this edge length (${unit}).\nCurrent: ${cur.toFixed(2)} ${unit}`, cur.toFixed(2));
    if (raw == null) return;
    const val = parseFloat(raw.replace(",", "."));
    if (!isFinite(val) || val <= 0) return;
    const newLenPx = metresPerPixel ? val / metresPerPixel : val;
    snapshot();
    setPolys((ps) => {
      const copy = ps.map((p) => p.slice());
      copy[selected] = setEdgeLength(copy[selected], selectedEdge, newLenPx);
      return copy;
    });
  }
  /** Insert a vertex at the midpoint of edge i of the selected poly (MM's edge-midpoint add). */
  function addVertexOnEdge(polyIdx: number, edgeIdx: number) {
    snapshot();
    setPolys((ps) => {
      const copy = ps.map((p) => p.slice());
      const poly = copy[polyIdx];
      const a = poly[edgeIdx];
      const b = poly[(edgeIdx + 1) % poly.length];
      poly.splice(edgeIdx + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      return copy;
    });
  }

  // ── TEXT labels ───────────────────────────────────────────────────────────────────────────────────
  const DEFAULT_TEXT_SIZE = 34; // image-px font size; scales with the plan on export
  function placeText(at: Pt, initial = "") {
    const value = window.prompt("Label text (room name or note):", initial);
    if (value == null || value.trim() === "") return;
    snapshot();
    setTexts((ts) => [...ts, { x: at.x, y: at.y, text: value.trim().toUpperCase(), size: DEFAULT_TEXT_SIZE, rot: 0 }]);
  }
  function editText(i: number) {
    const cur = texts[i];
    const value = window.prompt("Edit label (empty to delete):", cur.text);
    if (value == null) return;
    snapshot();
    if (value.trim() === "") setTexts((ts) => ts.filter((_, j) => j !== i));
    else setTexts((ts) => ts.map((t, j) => (j === i ? { ...t, text: value.trim().toUpperCase() } : t)));
    setSelectedText(null);
  }
  function resizeSelectedText(delta: number) {
    if (selectedText == null) return;
    snapshot();
    setTexts((ts) => ts.map((t, j) => (j === selectedText ? { ...t, size: Math.max(8, t.size + delta) } : t)));
  }
  /** Cycle a label's rotation 0 → -90 → 180 → 90 → 0 (one-click vertical/horizontal flip). */
  function rotateSelectedText() {
    if (selectedText == null) return;
    snapshot();
    setTexts((ts) => ts.map((t, j) => (j === selectedText ? { ...t, rot: ((t.rot - 90) % 360) } : t)));
  }
  /** Auto-label the SELECTED room: drop its name + area at the centroid (the common case). */
  function labelSelectedRoom() {
    if (selected == null) return;
    const poly = polys[selected];
    const c = polyCentroid(poly);
    const name = window.prompt("Room name (e.g. BEDROOM):", unitLabel || "");
    if (name == null || name.trim() === "") return;
    const areaPx = polyArea(poly);
    const area = metresPerPixel ? areaPx * metresPerPixel * metresPerPixel : areaPx;
    const areaStr = metresPerPixel ? `${area.toFixed(1)} m²` : `${Math.round(area)} px²`;
    snapshot();
    setTexts((ts) => [
      ...ts,
      { x: c.x, y: c.y - 14, text: name.trim().toUpperCase(), size: DEFAULT_TEXT_SIZE, rot: 0 },
      { x: c.x, y: c.y + 26, text: areaStr, size: Math.round(DEFAULT_TEXT_SIZE * 0.6), rot: 0 },
    ]);
  }
  /** AUTO-LABEL every closed room that doesn't already have a label near its centroid: drop "ROOM" + its area at
   *  each centroid, for the user to rename in place (double-click) or move. Names are AUTHORED here (MM has no
   *  per-room names — only the unit total). Idempotent-ish: skips rooms that already have text near their centre. */
  function autoLabelAllRooms() {
    const rooms = polys.slice(0, polys.length - 1).filter((p) => p.length >= 3);
    if (rooms.length === 0) return;
    const near = 40; // px: a room counts as "already labelled" if any text sits within this of its centroid
    //  The UNIT name (from the deep-link path) is the right label for the WHOLE unit — so when the trace is a
    // SINGLE outline it names that outline (e.g. "1 BEDROOM B"). With several rooms we can't know which interior
    // room is which from a flat image, so only the LARGEST gets the unit name; the rest default to "ROOM" to rename.
    const largestIdx = rooms.reduce((best, p, i) => (polyArea(p) > polyArea(rooms[best]) ? i : best), 0);
    const additions: TextLabel[] = [];
    rooms.forEach((poly, i) => {
      const c = polyCentroid(poly);
      const has = texts.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < near);
      if (has) return;
      const areaPx = polyArea(poly);
      const area = metresPerPixel ? areaPx * metresPerPixel * metresPerPixel : areaPx;
      const areaStr = metresPerPixel ? `${area.toFixed(1)} m²` : `${Math.round(area)} px²`;
      const name = i === largestIdx && unitLabel ? unitLabel : "ROOM";
      additions.push({ x: c.x, y: c.y - 14, text: name, size: DEFAULT_TEXT_SIZE, rot: 0 });
      additions.push({ x: c.x, y: c.y + 26, text: areaStr, size: Math.round(DEFAULT_TEXT_SIZE * 0.6), rot: 0 });
    });
    if (additions.length === 0) return;
    snapshot();
    setTexts((ts) => [...ts, ...additions]);
  }

  // ── DOORS + FURNITURE (decorative placement) ────────────────────────────────────────────────────────
  function placeDoor(at: Pt) {
    snapshot();
    const wpx = metresPerPixel ? 0.9 / metresPerPixel : 70; // ~0.9 m opening
    setDoors((ds) => [...ds, { x: at.x, y: at.y, w: wpx, rot: 0, flip: false, mirror: false }]);
    setSelDoor(doors.length);
    setSelFurn(null);
  }
  function placeFurniture(at: Pt) {
    snapshot();
    const def = FURNITURE_DEFAULT_M[furnKind];
    // metres → px when calibrated (to-scale); uncalibrated → treat the metre numbers as a sensible px default ×60.
    const wpx = metresPerPixel ? def.w / metresPerPixel : def.w * 60;
    const hpx = metresPerPixel ? def.h / metresPerPixel : def.h * 60;
    setFurniture((fs) => [...fs, { kind: furnKind, x: at.x, y: at.y, w: wpx, h: hpx, rot: 0 }]);
    setSelFurn(furniture.length);
    setSelDoor(null);
  }
  /** Set the SELECTED furniture's real W×H in metres (requires calibration). */
  function setSelFurnSize() {
    if (selFurn == null) return;
    const f = furniture[selFurn];
    if (!metresPerPixel) {
      window.alert("Calibrate the plan first (or use Set area on a room) so sizes are in metres.");
      return;
    }
    const curW = (f.w * metresPerPixel).toFixed(2);
    const curH = (f.h * metresPerPixel).toFixed(2);
    const raw = window.prompt(`Size of this ${f.kind}, in metres as  W x H  (e.g. 2.0 x 0.9):`, `${curW} x ${curH}`);
    if (raw == null) return;
    const m = raw.toLowerCase().replace(",", ".").split(/[x×*]/).map((s) => parseFloat(s.trim()));
    if (m.length !== 2 || !m.every((n) => isFinite(n) && n > 0)) return;
    snapshot();
    setFurniture((fs) => fs.map((ff, i) => (i === selFurn ? { ...ff, w: m[0] / metresPerPixel, h: m[1] / metresPerPixel } : ff)));
  }
  function rotateSelDoor() { if (selDoor == null) return; snapshot(); setDoors((ds) => ds.map((d, i) => (i === selDoor ? { ...d, rot: (d.rot + 15) % 360 } : d))); }
  function flipSelDoor() { if (selDoor == null) return; snapshot(); setDoors((ds) => ds.map((d, i) => (i === selDoor ? { ...d, flip: !d.flip } : d))); }
  function mirrorSelDoor() { if (selDoor == null) return; snapshot(); setDoors((ds) => ds.map((d, i) => (i === selDoor ? { ...d, mirror: !d.mirror } : d))); }
  function resizeSelDoor(f: number) { if (selDoor == null) return; snapshot(); setDoors((ds) => ds.map((d, i) => (i === selDoor ? { ...d, w: Math.max(10, d.w * f) } : d))); }
  function delSelDoor() { if (selDoor == null) return; snapshot(); setDoors((ds) => ds.filter((_, i) => i !== selDoor)); setSelDoor(null); }
  // ── WINDOWS (double-line glazing in a wall) — parallel to doors but no swing ──
  function placeWindow(at: Pt) {
    snapshot();
    const wpx = metresPerPixel ? 1.2 / metresPerPixel : 90; // ~1.2 m window
    setWindows((ws) => [...ws, { x: at.x, y: at.y, w: wpx, rot: 0 }]);
    setSelWin(windows.length);
    setSelDoor(null); setSelFurn(null);
  }
  function rotateSelWin() { if (selWin == null) return; snapshot(); setWindows((ws) => ws.map((w, i) => (i === selWin ? { ...w, rot: (w.rot + 15) % 360 } : w))); }
  function resizeSelWin(f: number) { if (selWin == null) return; snapshot(); setWindows((ws) => ws.map((w, i) => (i === selWin ? { ...w, w: Math.max(10, w.w * f) } : w))); }
  function delSelWin() { if (selWin == null) return; snapshot(); setWindows((ws) => ws.filter((_, i) => i !== selWin)); setSelWin(null); }
  function rotateSelFurn() { if (selFurn == null) return; snapshot(); setFurniture((fs) => fs.map((f, i) => (i === selFurn ? { ...f, rot: (f.rot + 15) % 360 } : f))); }
  function resizeSelFurn(f: number) { if (selFurn == null) return; snapshot(); setFurniture((fs) => fs.map((ff, i) => (i === selFurn ? { ...ff, w: Math.max(8, ff.w * f), h: Math.max(8, ff.h * f) } : ff))); }
  function delSelFurn() { if (selFurn == null) return; snapshot(); setFurniture((fs) => fs.filter((_, i) => i !== selFurn)); setSelFurn(null); }

  // ── INTERNAL WALLS (partition polylines) ──────────────────────────────────────────────────────────
  function finishWall() {
    if (activeWall.length < 2) { setActiveWall([]); return; }
    snapshot();
    setWalls((ws) => [...ws, activeWall]);
    setActiveWall([]);
  }
  function clearActiveWall() { setActiveWall([]); }

  // ── calibration ───────────────────────────────────────────────────────────────────────────────────
  function promptCalibration(px: number) {
    const raw = window.prompt(
      `That segment is ${px.toFixed(1)} image-pixels long.\nType its REAL length in metres (e.g. 4.2):`,
      metresPerPixel ? (px * metresPerPixel).toFixed(2) : ""
    );
    if (raw == null) return;
    const metres = parseFloat(raw.replace(",", "."));
    if (!isFinite(metres) || metres <= 0) return;
    setMetresPerPixel(metres / px);
  }

  // ── derived: fmt a length in the current unit ─────────────────────────────────────────────────────
  const fmtLen = useCallback(
    (px: number) => (metresPerPixel ? `${(px * metresPerPixel).toFixed(2)} m` : `${px.toFixed(0)} px`),
    [metresPerPixel]
  );

  // ── polygon area in m² (shoelace on image px, scaled) ─────────────────────────────────────────────
  const areaOf = useCallback(
    (poly: Pt[]) => {
      if (poly.length < 3) return 0;
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        a += p.x * q.y - q.x * p.y;
      }
      const px2 = Math.abs(a) / 2;
      return metresPerPixel ? px2 * metresPerPixel * metresPerPixel : px2;
    },
    [metresPerPixel]
  );

  // ── EXPORT: build the SVG string in IMAGE space (viewBox = image extent) ───────────────────────────
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /** Build all drawable layers (floorspace/doors/furniture/text) under a coordinate transform TX/TY + scale k.
   *  Identity (k=1, TX=x) for the raw export; the 16:9 builder passes its fit transform. One source of truth. */
  const buildLayers = useCallback(
    (TX: (x: number) => number, TY: (y: number) => number, k: number) => {
      const finished = polys.slice(0, polys.length - 1).concat(active.length >= 3 ? [active] : []);
      const ptsStr = (poly: Pt[]) => poly.map((p) => `${TX(p.x).toFixed(2)},${TY(p.y).toFixed(2)}`).join(" ");
      // #floorspace — poché = thick wall band + white fill; schematic = thin line.
      const roomEls = finished
        .map((poly) => {
          const pts = ptsStr(poly);
          return wallStyle === "poche"
            ? `    <polygon points="${pts}" fill="#ffffff" stroke="${STROKE}" stroke-width="${(wallPx * k).toFixed(1)}" stroke-linejoin="round"/>`
            : `    <polygon points="${pts}" fill="#eef1f5" stroke="${STROKE}" stroke-width="${(2 * k).toFixed(1)}" stroke-linejoin="round"/>`;
        })
        .join("\n");
      const furnEls = furniture
        .map((f) => {
          const cx = TX(f.x) + (f.w * k) / 2, cy = TY(f.y) + (f.h * k) / 2;
          return `    <g transform="rotate(${f.rot} ${cx.toFixed(1)} ${cy.toFixed(1)}) translate(${TX(f.x).toFixed(1)} ${TY(f.y).toFixed(1)}) scale(${k.toFixed(4)})">${furnitureInner(f.kind, f.w, f.h)}</g>`;
        })
        .join("\n");
      const doorEls = doors
        .map((d) => `    <g transform="translate(${TX(d.x).toFixed(1)} ${TY(d.y).toFixed(1)}) rotate(${d.rot}) scale(${k.toFixed(4)})">${doorInner(d.w, d.flip, d.mirror)}</g>`)
        .join("\n");
      const winEls = windows
        .map((wn) => `    <g transform="translate(${TX(wn.x).toFixed(1)} ${TY(wn.y).toFixed(1)}) rotate(${wn.rot}) scale(${k.toFixed(4)})">${windowInner(wn.w)}</g>`)
        .join("\n");
      const wallEls = walls
        .map((w) => {
          const dPath = w.map((p, j) => `${j === 0 ? "M" : "L"}${TX(p.x).toFixed(1)},${TY(p.y).toFixed(1)}`).join(" ");
          // internal partitions render at the THINNER interior weight (poché hierarchy: shell > dividers)
          const sw = wallStyle === "poche" ? interiorWallPx * k : 2 * k;
          return `    <path d="${dPath}" fill="none" stroke="${STROKE}" stroke-width="${sw.toFixed(1)}" stroke-linecap="square" stroke-linejoin="round"/>`;
        })
        .join("\n");
      const textEls = texts
        .map((t) => {
          const x = TX(t.x), y = TY(t.y), fs = (t.size * k).toFixed(1);
          return (
            `    <text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs}" font-weight="700" ` +
            `font-family="'Helvetica Neue',Arial,sans-serif" letter-spacing="1" text-anchor="middle" dominant-baseline="middle" ` +
            `fill="#1a1a1a" paint-order="stroke" stroke="#fff" stroke-width="${Math.max(2, t.size * k * 0.1).toFixed(1)}"` +
            `${t.rot ? ` transform="rotate(${t.rot} ${x.toFixed(1)} ${y.toFixed(1)})"` : ""}>${esc(t.text)}</text>`
          );
        })
        .join("\n");
      return (
        `  <g id="floorspace">\n${roomEls}\n  </g>\n` +
        `  <g id="walls">\n${wallEls}\n  </g>\n` +
        `  <g id="furniture">\n${furnEls}\n  </g>\n` +
        `  <g id="doors">\n${doorEls}\n  </g>\n` +
        `  <g id="windows">\n${winEls}\n  </g>\n` +
        `  <g id="text">\n${textEls}\n  </g>\n`
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [polys, active, texts, doors, windows, furniture, walls, wallStyle]
  );

  const buildSvgString = useCallback((): string => {
    const w = imgSize?.w ?? 1000;
    const h = imgSize?.h ?? 1000;
    const mpp = metresPerPixel ?? 0;
    const meta =
      `  <metadata>\n    <vrx:tracer xmlns:vrx="https://vrx.vettedrealty.com/ns" metresPerPixel="${mpp}" ` +
      `imageWidth="${w}" imageHeight="${h}" source="${esc(imgUrl || "")}"/>\n  </metadata>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n` +
      meta +
      `\n  <rect width="${w}" height="${h}" fill="#ffffff"/>\n` +
      buildLayers((x) => x, (y) => y, 1) +
      `</svg>\n`
    );
  }, [imgSize, metresPerPixel, imgUrl, buildLayers]);

  /** Total area across all closed rooms, in the current unit (used in the title band). */
  const totalAreaLabel = useCallback((): string => {
    const finished = polys.slice(0, polys.length - 1).concat(active.length >= 3 ? [active] : []);
    const px2 = finished.reduce((n, p) => n + polyArea(p), 0);
    if (px2 <= 0) return "";
    return metresPerPixel ? `${(px2 * metresPerPixel * metresPerPixel).toFixed(2)} m²` : `${Math.round(px2)} px²`;
  }, [polys, active, metresPerPixel]);

  /** PRESENTATION SVG — a 16:9 "TV slide": plan cropped to its bbox, centered with margins, title band at the
   *  bottom. All geometry + text transformed into the frame. This is the LOCKED, shown-to-buyers artifact. */
  const buildPresentationSvg = useCallback((): string => {
    const W = 1920, H = 1080;
    const bandH = 150; // title band at the bottom
    const pad = 80;
    const finished = polys.slice(0, polys.length - 1).concat(active.length >= 3 ? [active] : []);
    // bbox over all room points + text anchors + furniture extents (so nothing is clipped)
    const allPts: Pt[] = [
      ...finished.flat(),
      ...texts.map((t) => ({ x: t.x, y: t.y })),
      ...furniture.flatMap((f) => [{ x: f.x, y: f.y }, { x: f.x + f.w, y: f.y + f.h }]),
      ...doors.map((d) => ({ x: d.x, y: d.y })),
      ...walls.flat(),
    ];
    if (allPts.length === 0) return buildSvgString();
    const minX = Math.min(...allPts.map((p) => p.x)), maxX = Math.max(...allPts.map((p) => p.x));
    const minY = Math.min(...allPts.map((p) => p.y)), maxY = Math.max(...allPts.map((p) => p.y));
    const planW = Math.max(1, maxX - minX), planH = Math.max(1, maxY - minY);
    const availW = W - 2 * pad, availH = H - bandH - 2 * pad;
    const k = Math.min(availW / planW, availH / planH); // uniform fit (preserve proportions)
    const offX = pad + (availW - planW * k) / 2 - minX * k;
    const offY = pad + (availH - planH * k) / 2 - minY * k;
    const TX = (x: number) => x * k + offX;
    const TY = (y: number) => y * k + offY;

    const layers = buildLayers(TX, TY, k);
    const area = totalAreaLabel();
    const caption = area ? `${esc(title)}  ·  ${area}` : esc(title);
    const band =
      `  <g id="title">\n` +
      `    <line x1="${pad}" y1="${H - bandH}" x2="${W - pad}" y2="${H - bandH}" stroke="#d6dbe3" stroke-width="2"/>\n` +
      `    <text x="${W / 2}" y="${H - bandH / 2 + 14}" font-size="42" font-weight="700" letter-spacing="3" ` +
      `font-family="'Helvetica Neue',Arial,sans-serif" text-anchor="middle" fill="#1a1a1a">${caption}</text>\n` +
      `  </g>`;
    const mpp = metresPerPixel ?? 0;
    const meta = `  <metadata><vrx:tracer xmlns:vrx="https://vrx.vettedrealty.com/ns" metresPerPixel="${mpp}" presentation="16:9"/></metadata>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
      meta +
      `\n  <rect width="${W}" height="${H}" fill="#ffffff"/>\n` +
      layers +
      band +
      `\n</svg>\n`
    );
  }, [polys, active, texts, doors, furniture, walls, metresPerPixel, title, totalAreaLabel, buildSvgString, buildLayers]);

  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportSvg() {
    downloadBlob(new Blob([buildPresentationSvg()], { type: "image/svg+xml" }), "floorplan.svg");
  }

  /** Rasterize the presentation SVG → PNG blob (shared by Download-PNG and the lock→replace flow). */
  async function renderPresentationPng(): Promise<Blob | null> {
    const svg = buildPresentationSvg();
    const W = 1920, H = 1080;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const im = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(im, 0, 0, W, H);
      return await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  }
  async function exportPng() {
    const b = await renderPresentationPng();
    if (b) downloadBlob(b, "floorplan.png");
  }

  const [lockMsg, setLockMsg] = useState<string | null>(null);
  /** LOCK → use the vector plan INSTEAD of the raster: flatten to PNG and overwrite the original image file.
   *  The original served image was ?img=<url> (e.g. /floorplans/.../1BR_A.jpg). We can only replace a file that
   *  lives under floorplans/ or renderings/ (the replace route fences this). The user chooses keep-.bak vs prune:
   *  the replace route always backs up to <file>.bak on first overwrite, so "keep" is the default + reversible. */
  async function lockAndReplace() {
    const src = params.get("img");
    if (!src) {
      setLockMsg("No source image to replace — this plan was opened from a file picker, not an /admin/images card. Use Download PNG instead.");
      return;
    }
    const relPath = src.replace(/^\//, "").split("?")[0];
    if (!/^(floorplans|renderings)\//.test(relPath)) {
      setLockMsg(`Can't replace ${relPath} — only images under floorplans/ or renderings/ can be locked in place. Use Download PNG.`);
      return;
    }
    //  The backdrop never loaded (imgSize null) → the target image is MISSING. If it's a well-formed
    // unit-plan slot (floorplans/<building>/units/<X>.ext) the server accepts allowCreate, so a plan DRAWN FROM
    // BLANK can fill a gap that has no source image yet. This is the MM "deep-link to a unit with no plan → draw
    // one" path: MM links here with ?img=<the expected slot>, the slot 404s, the user traces + locks = created.
    const isUnitPlanSlot = /^floorplans\/[^/]+\/units\/[^/]+\.(jpe?g|png|webp)$/i.test(relPath);
    const creating = imgSize == null && isUnitPlanSlot;
    const keep = creating
      ? window.confirm(
          `This unit plan slot has no image yet:\n\n${relPath}\n\n` +
            `OK = SAVE your drawn plan as the new plan for this unit.\n` +
            `Cancel = stop (nothing changes).`
        )
      : window.confirm(
          `Replace the ORIGINAL image with your traced plan?\n\n${relPath}\n\n` +
            `OK = keep the original as a hidden .bak reference (reversible).\n` +
            `Cancel = stop (nothing changes).`
        );
    if (!keep) return;
    const png = await renderPresentationPng();
    if (!png) {
      setLockMsg("Could not render the plan PNG.");
      return;
    }
    setLockMsg("Replacing…");
    try {
      const fd = new FormData();
      fd.set("relPath", relPath);
      if (creating) fd.set("allowCreate", "true"); // fill a missing unit-plan slot with the drawn plan
      fd.set("file", new File([png], relPath.split("/").pop() || "plan.png", { type: "image/png" }));
      const op = readOperatorSecret(); // demo users have no key → server 403s (view + trace is fine, saving isn't)
      const j = await fetch("/api/admin/images/replace", { method: "POST", body: fd, headers: op ? { "x-vrx-operator": op } : {} }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "replace failed");
      setLockMsg(
        creating
          ? `✅ Created. ${relPath} now has your drawn plan (${j.sizeKb} KB) — this unit had no plan before; buyers now see it.`
          : `✅ Locked in. ${relPath} now shows your traced plan (${j.sizeKb} KB). Original backed up as ${relPath}.bak — buyers see only the new plan.`
      );
    } catch (e) {
      setLockMsg(`Error: ${e instanceof Error ? e.message : "replace failed"}`);
    }
  }

  // ── Send the traced structure INTO MM's data (D-) ───────────────────────────────────────────
  // The data-merge: instead of only flattening the trace to a PNG (lockAndReplace), capture the room SHAPE +
  // doors/windows/walls as a serializable UnitPlan and persist it as a sidecar keyed by this unit-plan path. MM
  // reads it back and feeds it to setSubtypePlan, so the geometry becomes AI-readable node data, not pixels.
  // Only works on a unit-plan slot (floorplans/<building>/units/<X>.ext) — that path binds it to a type+subtype.
  async function sendPlanToMm() {
    const src = params.get("img");
    const relPath = (src || "").replace(/^\//, "").split("?")[0];
    if (!/^floorplans\/[^/]+\/units\/[^/]+\.(jpe?g|png|webp)$/i.test(relPath)) {
      setLockMsg("Send to MM needs a unit-plan image (opened from a unit card, e.g. .../units/1BR_A.jpg) — that path binds the plan to its type+subtype.");
      return;
    }
    // Convert the authored geometry → a UnitPlan (closed rooms minus the active/empty one; the largest is the
    // unit shell). metresPerPixel gives real marker widths; expectedSqm is the binding size carried for MM.
    const plan = tracerToUnitPlan({
      rooms: polys.slice(0, Math.max(0, polys.length - 1)),
      doors,
      windows,
      walls,
      metresPerPixel: metresPerPixel ?? undefined,
      targetSqm: expectedSqm ?? undefined,
    });
    if (!plan) {
      setLockMsg("Nothing to send yet — trace at least one closed room first (the largest becomes the unit outline).");
      return;
    }
    setLockMsg("Sending plan to MM…");
    try {
      const op = readOperatorSecret(); // demo users have no key → server 403s (trace is fine, persisting isn't)
      const j = await fetch("/api/admin/images/plan", {
        method: "POST",
        headers: { "content-type": "application/json", ...(op ? { "x-vrx-operator": op } : {}) },
        body: JSON.stringify({ relPath, plan }),
      }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "send failed");
      const nMarkers = plan.markers?.length ?? 0;
      setLockMsg(`✅ Sent to MM. The traced outline${nMarkers ? ` + ${nMarkers} door/window/wall marker${nMarkers === 1 ? "" : "s"}` : ""} is now this subtype's plan data — open it in MM to import. (Rooms/furniture aren't carried yet; that's a planned upgrade.)`);
    } catch (e) {
      setLockMsg(`Error: ${e instanceof Error ? e.message : "send failed"}`);
    }
  }

  // ── render helpers (image -> screen) ──────────────────────────────────────────────────────────────
  const s = view.scale;
  const toScreen = (p: Pt) => ({ x: p.x * s + view.tx, y: p.y * s + view.ty });

  const finishedPolys = polys.slice(0, polys.length - 1);
  const totalArea = useMemo(
    () => finishedPolys.reduce((n, p) => n + areaOf(p), 0) + (active.length >= 3 ? areaOf(active) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [polys, metresPerPixel]
  );

  // group separator for the vertical rail
  const Sep = () => <div style={{ height: 1, background: T.border, margin: "8px 0 2px" }} />;
  const GroupLabel = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.accent, margin: "4px 0 3px" }}>{children}</div>
  );
  // 2-column grid for related same-size actions (keeps the rail short).
  const Grid = ({ children, cols = 2 }: { children: React.ReactNode; cols?: number }) => (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 6 }}>{children}</div>
  );

  // context-sensitive help text (shown as a small box at the BOTTOM of the rail, not a full-width strip).
  // the TARGET size — data if present, else the manual input (parsed). Drives the one-click button + auto-label.
  const targetSqm: number | null = expectedSqm ?? (parseFloat(manualSqm.replace(",", ".")) > 0 ? parseFloat(manualSqm.replace(",", ".")) : null);

  const hintText =
    mode === "trace"
      ? selected != null
        ? "Editing a room: DRAG vertices to fit the walls · click an EDGE then Set edge… · click a green ＋ to add a vertex · ⊞ Set area → type the real m². Click empty space to deselect."
        : active.length >= 3
        ? "Keep clicking to add wall points — hold SHIFT for straight H/V walls · click the green START dot (or Enter) to CLOSE · Backspace undoes · right-drag/Space to pan."
        : "Click point-to-point to trace the walls (hold SHIFT for straight lines). Click INSIDE a finished room to select + edit it. DRAG any vertex. Right-drag (or Space) to pan."
      : mode === "text"
      ? "Labels for every room were auto-placed (ROOM + area) — DOUBLE-CLICK one to rename, drag to move. Click empty space to add more. ⟳ Re-label adds any new rooms."
      : mode === "wall"
      ? "Draw INTERNAL partition walls: click point-to-point (hold SHIFT for straight) → press Enter (or ✓ Finish wall) to end it. Drag a vertex to adjust. Backspace undoes the last point."
      : mode === "door"
      ? "Click on a wall to drop a door (swing arc). Select it to Turn / Flip / Mirror / resize. Drag to reposition."
      : mode === "window"
      ? "Click on a wall to drop a window (double-line glazing). Select it to Turn / resize / delete."
      : mode === "furniture"
      ? "Pick a symbol above, then click to place it. Drag to move; select to Turn / resize / delete."
      : mode === "calibrate"
      ? calA
        ? "Now click the OTHER end of a known dimension…"
        : "Click one end of a known dimension (e.g. a labelled wall), then the other, then type its real length."
      : "Drag to pan. Wheel to zoom.";

  return (
    <main style={{ background: T.bg, color: T.text, height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui, sans-serif" }}>
      {/* slim header */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 16px", borderBottom: `1px solid ${T.border}` }}>
        <a href="/admin/images" style={{ color: T.dim, fontSize: 13, textDecoration: "none" }}>← Images</a>
        <strong style={{ fontSize: 15 }}>Floor-plan tracer</strong>
        <span style={{ color: T.faint, fontSize: 12 }}>coordinate-locked</span>
        {/* TARGET size — from the catalog data if we have it, else a manual input (the no-data fallback) */}
        {expectedSqm != null ? (
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.vetted, background: "#102a20", border: `1px solid ${T.vetted}`, borderRadius: 6, padding: "2px 9px" }}>
            Target: {expectedSqm} m²{" "}
            <span style={{ color: T.dim, fontWeight: 400 }}>(from data)</span>
          </span>
        ) : (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: T.dim }}>
            Target m²:
            <input
              type="number"
              step="0.01"
              min="0"
              value={manualSqm}
              onChange={(e) => setManualSqm(e.target.value)}
              placeholder="e.g. 33.27"
              title="No size in the data — type the unit's total area; used as the target + the one-click Set-area value."
              style={{ width: 90, padding: "3px 8px", background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 12.5 }}
            />
          </label>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: T.faint, fontFamily: T.mono }}>
          {metresPerPixel ? `scale ✓ ${(1 / metresPerPixel).toFixed(1)} px/m` : "uncalibrated"} · {closedCount} loop{closedCount === 1 ? "" : "s"} · {totalArea > 0 ? (metresPerPixel ? `${totalArea.toFixed(1)} m²` : `${Math.round(totalArea)} px²`) : "—"}
        </span>
      </div>

      {/* BODY = canvas (left) + control rail (right) */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>

      {/* ── RIGHT CONTROL RAIL ── resizable: drag the left edge. */}
      <aside style={{ order: 2, position: "relative", width: railW, flexShrink: 0, borderLeft: `1px solid ${T.border}`, background: T.bg2, padding: "14px 16px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {/* drag handle on the left edge */}
        <div
          onPointerDown={(e) => { railDrag.current = { startX: e.clientX, startW: railW }; }}
          title="Drag to resize the panel"
          style={{ position: "absolute", left: -3, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: 5 }}
        />

        <GroupLabel>Tool</GroupLabel>
        <Grid cols={2}>
          {(["trace", "wall", "door", "window", "furniture", "text", "calibrate", "pan"] as const).map((m) => (
            <ToolBtn key={m} on={mode === m} onClick={() => { if (mode === "wall" && m !== "wall") finishWall(); setMode(m); setCalA(null); setActiveWall([]); setSelectedText(null); setSelDoor(null); setSelWin(null); setSelFurn(null); if (m === "text") autoLabelAllRooms(); }}>
              {m === "trace" ? "✏ Room" : m === "wall" ? "┤ Wall" : m === "door" ? "🚪 Door" : m === "window" ? "🪟 Window" : m === "furniture" ? "🛋 Furniture" : m === "text" ? "🅣 Text" : m === "calibrate" ? "📏 Calibrate" : "✋ Pan"}
            </ToolBtn>
          ))}
        </Grid>
        {mode === "wall" && (
          <ToolBtn on={activeWall.length >= 2} onClick={finishWall} disabled={activeWall.length < 2} title="Finish this partition (or press Enter)">
            {activeWall.length >= 2 ? "✓ Finish wall (Enter)" : "Click to start a wall…"}
          </ToolBtn>
        )}
        {mode === "text" && (
          <ToolBtn onClick={autoLabelAllRooms} title="Add a ROOM + area label at every traced room that doesn't have one yet">⟳ Re-label all rooms</ToolBtn>
        )}

        {mode === "furniture" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            {FURNITURE_KINDS.map((fk) => (
              <button
                key={fk}
                onClick={() => setFurnKind(fk)}
                title={fk}
                style={{ padding: "4px 8px", fontSize: 11, borderRadius: 6, cursor: "pointer", border: `1px solid ${furnKind === fk ? T.accent : T.border}`, background: furnKind === fk ? T.accentSoft : T.panel2, color: furnKind === fk ? "#fff" : T.text }}
              >
                {fk}
              </button>
            ))}
          </div>
        )}

        <Sep />
        <GroupLabel>Walls style</GroupLabel>
        <Grid cols={2}>
          <ToolBtn on={wallStyle === "poche"} onClick={() => setWallStyle("poche")} title="Thick solid walls (final look)">▮ Poché</ToolBtn>
          <ToolBtn on={wallStyle === "schematic"} onClick={() => setWallStyle("schematic")} title="Thin outline (easier to edit)">╎ Line</ToolBtn>
        </Grid>

        <Sep />
        <GroupLabel>View</GroupLabel>
        <Grid cols={2}>
          <ToolBtn onClick={() => fileRef.current?.click()}>🖼 Open</ToolBtn>
          <ToolBtn onClick={fitView} disabled={!imgSize} title="Zoom the view to fit the plan (does NOT change your drawing)">⤢ Zoom fit</ToolBtn>
        </Grid>
        <label title="Backdrop image opacity" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: T.dim, opacity: imgSize ? 1 : 0.4 }}>
          👁
          <input type="range" min={0} max={100} value={Math.round(backdropOpacity * 100)} disabled={!imgSize} onChange={(e) => setBackdropOpacity(Number(e.target.value) / 100)} style={{ flex: 1, minWidth: 0 }} />
          <span style={{ width: 32, fontFamily: T.mono, textAlign: "right" }}>{Math.round(backdropOpacity * 100)}%</span>
        </label>

        <Sep />
        <GroupLabel>Edit</GroupLabel>
        <Grid cols={2}>
          <ToolBtn onClick={closeActive} disabled={active.length < 3}>⏎ Close loop</ToolBtn>
          <ToolBtn onClick={clearAll}>🗑 Clear</ToolBtn>
          <ToolBtn onClick={undo} disabled={histLen === 0} title="Undo (Ctrl+Z)">↺ Undo</ToolBtn>
          <ToolBtn onClick={redoOp} disabled={redo.current.length === 0} title="Redo (Ctrl+Shift+Z)">↻ Redo</ToolBtn>
        </Grid>

        <Sep />
        <GroupLabel>Selected room</GroupLabel>
        {targetSqm != null && (
          <ToolBtn accent onClick={() => applyAreaToSelected(targetSqm)} disabled={selected == null} title="One click: make the selected room exactly the target size (sets the plan scale too).">
            ⊞ Set to {targetSqm} m² {expectedSqm != null ? "(from data)" : "(target)"}
          </ToolBtn>
        )}
        <ToolBtn onClick={snapSelectedToArea} disabled={selected == null} title="Type the room's real area in m² — sets the plan scale (and resizes the shape to match when already calibrated).">⊞ Set area (m²)…</ToolBtn>
        <Grid cols={2}>
          <ToolBtn onClick={labelSelectedRoom} disabled={selected == null} title="Drop the room name + area at its centre">🏷 Label</ToolBtn>
          <ToolBtn onClick={editSelectedEdgeLength} disabled={selected == null || selectedEdge == null}>📐 Set edge…</ToolBtn>
        </Grid>
        <ToolBtn onClick={deleteSelectedVertex} disabled={selected == null || selectedEdge == null}>✖ Del vertex</ToolBtn>

        {selectedText != null && (
          <>
            <Sep />
            <GroupLabel>Selected label</GroupLabel>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ flex: 1 }}><ToolBtn onClick={() => resizeSelectedText(4)} title="Bigger text">🅐+</ToolBtn></span>
              <span style={{ flex: 1 }}><ToolBtn onClick={() => resizeSelectedText(-4)} title="Smaller text">🅐−</ToolBtn></span>
            </div>
            <ToolBtn onClick={rotateSelectedText} title="Rotate 90° (or use the ↻ pin on the label)">↻ Rotate 90°</ToolBtn>
            <ToolBtn onClick={() => editText(selectedText)} title="Edit / delete this label">✎ Edit text</ToolBtn>
          </>
        )}

        {selDoor != null && (
          <>
            <Sep />
            <GroupLabel>Selected door</GroupLabel>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ flex: 1 }}><ToolBtn onClick={rotateSelDoor} title="Rotate 15°">↻ Turn</ToolBtn></span>
              <span style={{ flex: 1 }}><ToolBtn onClick={flipSelDoor} title="Flip the swing to the OTHER side of the opening (in/out)">⇅ Flip</ToolBtn></span>
              <span style={{ flex: 1 }}><ToolBtn onClick={mirrorSelDoor} title="Move the HINGE to the other end (left/right)">⇄ Mirror</ToolBtn></span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ flex: 1 }}><ToolBtn onClick={() => resizeSelDoor(1.15)}>＋ Wider</ToolBtn></span>
              <span style={{ flex: 1 }}><ToolBtn onClick={() => resizeSelDoor(0.87)}>－ Narrower</ToolBtn></span>
            </div>
            <ToolBtn onClick={delSelDoor} title="Delete this door">✖ Delete door</ToolBtn>
          </>
        )}
        {selWin != null && (
          <>
            <Sep />
            <GroupLabel>Selected window</GroupLabel>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ flex: 1 }}><ToolBtn onClick={rotateSelWin} title="Rotate 15° (align to the wall)">↻ Turn</ToolBtn></span>
              <span style={{ flex: 1 }}><ToolBtn onClick={() => resizeSelWin(1.15)}>＋ Wider</ToolBtn></span>
              <span style={{ flex: 1 }}><ToolBtn onClick={() => resizeSelWin(0.87)}>－ Narrower</ToolBtn></span>
            </div>
            <ToolBtn onClick={delSelWin} title="Delete this window">✖ Delete window</ToolBtn>
          </>
        )}
        {selFurn != null && (
          <>
            <Sep />
            <GroupLabel>Selected furniture</GroupLabel>
            {/* live W×H readout (metres when calibrated, else px) */}
            <div style={{ fontSize: 12, color: T.dim, fontFamily: T.mono, padding: "2px 2px 4px" }}>
              {furniture[selFurn].kind} ·{" "}
              {metresPerPixel
                ? `${(furniture[selFurn].w * metresPerPixel).toFixed(2)} × ${(furniture[selFurn].h * metresPerPixel).toFixed(2)} m`
                : `${Math.round(furniture[selFurn].w)} × ${Math.round(furniture[selFurn].h)} px`}
            </div>
            <ToolBtn onClick={setSelFurnSize} title="Type the real width × height in metres">📐 Set size (W×H)…</ToolBtn>
            <ToolBtn onClick={rotateSelFurn} title="Rotate 15°">↻ Turn</ToolBtn>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ flex: 1 }}><ToolBtn onClick={() => resizeSelFurn(1.12)} title="Bigger">⤢＋</ToolBtn></span>
              <span style={{ flex: 1 }}><ToolBtn onClick={() => resizeSelFurn(0.9)} title="Smaller">⤡－</ToolBtn></span>
            </div>
            <ToolBtn onClick={delSelFurn} title="Delete this item">✖ Delete item</ToolBtn>
          </>
        )}

        <Sep />
        <GroupLabel>Presentation</GroupLabel>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Plan title…"
          title="Caption shown in the title band of the exported 16:9 plan"
          style={{ padding: "7px 10px", background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 12.5 }}
        />
        <ToolBtn on={preview} onClick={() => setPreview((v) => !v)} title="Preview the 16:9 presentation layout">🖥 {preview ? "Exit preview" : "Preview 16:9"}</ToolBtn>
        <div style={{ display: "flex", gap: 6 }}>
          <span style={{ flex: 1 }}><ToolBtn onClick={exportSvg} accent>⬇ SVG</ToolBtn></span>
          <span style={{ flex: 1 }}><ToolBtn onClick={exportPng} accent>⬇ PNG</ToolBtn></span>
        </div>
        <ToolBtn onClick={lockAndReplace} accent title="Export the 16:9 plan and replace the original image with it">🔒 Lock → use as plan</ToolBtn>
        <ToolBtn onClick={sendPlanToMm} title="Capture the traced outline + door/window/wall markers as this subtype's MM plan DATA (not just a picture), so MM + the AI can read the real shape">🧩 Send plan to MM</ToolBtn>

        {/* contextual help — lives at the bottom of the rail so it never steals canvas height */}
        <div style={{ marginTop: "auto", paddingTop: 10 }}>
          <GroupLabel>Tip</GroupLabel>
          <div style={{ fontSize: 11.5, lineHeight: 1.5, color: T.dim, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px" }}>
            {hintText}
          </div>
        </div>
      </aside>

      {/* ── LEFT: canvas ── */}
      <div style={{ order: 1, flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>

      {lockMsg && (
        <div style={{ padding: "8px 16px", fontSize: 13, background: lockMsg.startsWith("Error") || lockMsg.startsWith("No source") || lockMsg.startsWith("Can't") ? "#3a1620" : "#132a20", color: lockMsg.startsWith("Error") || lockMsg.startsWith("No source") || lockMsg.startsWith("Can't") ? T.danger : T.vetted, borderBottom: `1px solid ${T.border}` }}>
          {lockMsg} <button onClick={() => setLockMsg(null)} style={{ marginLeft: 8, background: "none", border: "none", color: "inherit", cursor: "pointer", textDecoration: "underline" }}>dismiss</button>
        </div>
      )}

      {/* canvas */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "#0d1017" }}>
        {/* PRESENTATION PREVIEW — the 16:9 "TV slide" as it will export/lock. Overlays the editor. */}
        {preview && (
          <div style={{ position: "absolute", inset: 0, zIndex: 20, background: "#11151f", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <div
              style={{ width: "min(100%, calc((100vh - 220px) * 1.7778))", aspectRatio: "16 / 9", boxShadow: "0 8px 40px rgba(0,0,0,0.6)", borderRadius: 6, overflow: "hidden", background: "#fff" }}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: buildPresentationSvg().replace(/width="1920" height="1080"/, 'width="100%" height="100%"') }}
            />
          </div>
        )}
        {!imgUrl && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, color: T.dim }}>
            <div style={{ fontSize: 15 }}>No backdrop image.</div>
            <div style={{ fontSize: 13 }}>Open one, or come from an image card in /admin/images.</div>
            <ToolBtn onClick={() => fileRef.current?.click()} accent>🖼 Open image</ToolBtn>
          </div>
        )}
        <svg
          ref={svgRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: mode === "pan" ? "grab" : "crosshair", touchAction: "none" }}
        >
          {/* backdrop image rendered in VIEW space (image rect * scale + offset) — opacity via the toolbar slider */}
          {imgUrl && imgSize && backdropOpacity > 0 && (
            <image
              href={imgUrl}
              x={view.tx}
              y={view.ty}
              width={imgSize.w * s}
              height={imgSize.h * s}
              preserveAspectRatio="none"
              style={{ opacity: backdropOpacity }}
            />
          )}

          {/* finished + active polygons. Index i = position in `polys` (active = last). */}
          {polys.map((p, i) => {
            if (p.length === 0) return null;
            const closed = i < polys.length - 1; // all but the active poly are closed loops
            const isSel = selected === i;
            const scr = p.map(toScreen);
            const d = scr.map((q, j) => `${j === 0 ? "M" : "L"}${q.x},${q.y}`).join(" ") + (closed ? " Z" : "");
            return (
              <g key={i}>
                {/* POCHÉ wall underlay — thick dark stroke behind the editing outline (decorative wall band) */}
                {closed && wallStyle === "poche" && (
                  <path d={d} fill="#eef1f5" stroke={STROKE} strokeWidth={wallPx * s} strokeLinejoin="round" />
                )}
                <path
                  d={d}
                  fill={closed ? (wallStyle === "poche" ? "none" : isSel ? "rgba(61,125,255,0.18)" : "rgba(61,125,255,0.08)") : "none"}
                  stroke={isSel ? T.vetted : wallStyle === "poche" ? "transparent" : T.accent}
                  strokeWidth={isSel ? 2.5 : 2}
                  strokeLinejoin="round"
                />
                {/* clickable EDGES (select an edge → enables Set-edge / Del-vertex). Only for closed polys. */}
                {closed &&
                  scr.map((q, j) => {
                    const next = scr[(j + 1) % scr.length];
                    const edgeSel = isSel && selectedEdge === j;
                    return (
                      <line
                        key={`e${j}`}
                        x1={q.x}
                        y1={q.y}
                        x2={next.x}
                        y2={next.y}
                        stroke={edgeSel ? T.hold : "transparent"}
                        strokeWidth={edgeSel ? 3 : 12}
                        style={{ cursor: "pointer" }}
                        onPointerDown={(ev) => {
                          ev.stopPropagation();
                          setSelected(i);
                          setSelectedEdge(j);
                        }}
                      />
                    );
                  })}
                {/* edge-MIDPOINT add-vertex handles (selected closed poly only) — click to split the edge */}
                {closed &&
                  isSel &&
                  scr.map((q, j) => {
                    const next = scr[(j + 1) % scr.length];
                    const mx = (q.x + next.x) / 2;
                    const my = (q.y + next.y) / 2;
                    return (
                      <rect
                        key={`m${j}`}
                        x={mx - 3}
                        y={my - 3}
                        width={6}
                        height={6}
                        fill={T.bg}
                        stroke={T.vetted}
                        strokeWidth={1.5}
                        style={{ cursor: "copy" }}
                        onPointerDown={(ev) => {
                          ev.stopPropagation();
                          addVertexOnEdge(i, j);
                        }}
                      />
                    );
                  })}
                {/* "close here" halo on the active loop's START point once it has ≥3 pts (click it to close) */}
                {!closed && p.length >= 3 && (
                  <circle cx={scr[0].x} cy={scr[0].y} r={10} fill="none" stroke={T.vetted} strokeWidth={2} strokeDasharray="3 3" style={{ pointerEvents: "none" }} />
                )}
                {/* vertices — bigger grab handles when the poly is selected */}
                {scr.map((q, j) => (
                  <circle
                    key={`v${j}`}
                    cx={q.x}
                    cy={q.y}
                    r={isSel ? 6 : 4}
                    fill={j === 0 && !closed ? T.vetted : isSel ? T.accent : "#fff"}
                    stroke={isSel ? "#fff" : T.accent}
                    strokeWidth={1.5}
                    style={{ cursor: "grab" }}
                  />
                ))}
                {/* edge-length labels */}
                {scr.map((q, j) => {
                  const next = closed ? scr[(j + 1) % scr.length] : scr[j + 1];
                  if (!next) return null;
                  const ip = p[j];
                  const inext = closed ? p[(j + 1) % p.length] : p[j + 1];
                  const mx = (q.x + next.x) / 2;
                  const my = (q.y + next.y) / 2;
                  const edgeSel = isSel && selectedEdge === j;
                  return (
                    <text key={`l${j}`} x={mx} y={my - 8} fontSize={edgeSel ? 13 : 11} fontWeight={edgeSel ? 700 : 400} fill={edgeSel ? T.hold : "#cfe0ff"} textAnchor="middle" style={{ paintOrder: "stroke", stroke: "#0d1017", strokeWidth: 3, pointerEvents: "none" }}>
                      {fmtLen(dist(ip, inext))}
                    </text>
                  );
                })}
                {/* room area label at centroid (closed polys) */}
                {closed &&
                  p.length >= 3 &&
                  (() => {
                    const c = toScreen(polyCentroid(p));
                    const areaPx = polyArea(p);
                    const area = metresPerPixel ? areaPx * metresPerPixel * metresPerPixel : areaPx;
                    return (
                      <text x={c.x} y={c.y} fontSize={13} fontWeight={700} fill={isSel ? T.vetted : "#9fc0ff"} textAnchor="middle" style={{ paintOrder: "stroke", stroke: "#0d1017", strokeWidth: 3, pointerEvents: "none" }}>
                        {metresPerPixel ? `${area.toFixed(1)} m²` : `${Math.round(area)} px²`}
                      </text>
                    );
                  })()}
              </g>
            );
          })}

          {/* INTERNAL WALLS (partition polylines) — thick poché line; vertices draggable in wall mode. */}
          {walls.map((w, wi) => {
            const scr = w.map(toScreen);
            const d = scr.map((q, j) => `${j === 0 ? "M" : "L"}${q.x},${q.y}`).join(" ");
            return (
              <g key={`w${wi}`}>
                <path d={d} fill="none" stroke={STROKE} strokeWidth={wallStyle === "poche" ? interiorWallPx * s : 3} strokeLinecap="square" strokeLinejoin="round" />
                {mode === "wall" && scr.map((q, j) => <circle key={j} cx={q.x} cy={q.y} r={5} fill="#fff" stroke={T.accent} strokeWidth={1.5} style={{ cursor: "grab" }} />)}
              </g>
            );
          })}
          {/* the active wall being drawn — solid for placed segments, a faint rubber-band to the cursor */}
          {activeWall.length > 0 && (() => {
            const scr = activeWall.map(toScreen);
            const placed = scr.map((q, j) => `${j === 0 ? "M" : "L"}${q.x},${q.y}`).join(" ");
            const last = scr[scr.length - 1];
            const cur = hoverImg && mode === "wall" ? toScreen(hoverImg) : null;
            return (
              <g style={{ pointerEvents: "none" }}>
                {/* placed segments: solid */}
                <path d={placed} fill="none" stroke={T.accent} strokeWidth={2.5} />
                {/* rubber-band to the cursor: faint dashed (clearly a preview, not a wall) */}
                {cur && <line x1={last.x} y1={last.y} x2={cur.x} y2={cur.y} stroke={T.accent} strokeWidth={1.5} strokeDasharray="4 5" opacity={0.6} />}
                {scr.map((q, j) => <circle key={j} cx={q.x} cy={q.y} r={4} fill={j === 0 ? T.vetted : T.accent} stroke="#fff" strokeWidth={1.5} />)}
                {/* "press Enter to finish" chip near the last placed point */}
                {activeWall.length >= 2 && (
                  <g transform={`translate(${last.x + 12} ${last.y - 10})`}>
                    <rect x={0} y={-12} width={150} height={20} rx={5} fill={T.vetted} opacity={0.95} />
                    <text x={8} y={2} fontSize={12} fontWeight={700} fill="#06281d">↵ Enter to finish</text>
                  </g>
                )}
              </g>
            );
          })()}

          {/* FURNITURE symbols — drawn in a local box then placed/scaled/rotated into view space. */}
          {furniture.map((f, i) => {
            const scrX = f.x * s + view.tx;
            const scrY = f.y * s + view.ty;
            const sel = selFurn === i;
            const cx = scrX + (f.w * s) / 2, cy = scrY + (f.h * s) / 2;
            return (
              <g key={`f${i}`} transform={`rotate(${f.rot} ${cx} ${cy})`}>
                {sel && <rect x={scrX - 3} y={scrY - 3} width={f.w * s + 6} height={f.h * s + 6} fill="none" stroke={T.vetted} strokeWidth={1.5} strokeDasharray="4 3" />}
                <g
                  transform={`translate(${scrX} ${scrY}) scale(${s})`}
                  style={{ cursor: "move" }}
                  dangerouslySetInnerHTML={{ __html: furnitureInner(f.kind, f.w, f.h) }}
                />
              </g>
            );
          })}
          {/* DOORS — leaf + swing arc, placed on a wall. */}
          {doors.map((d, i) => {
            const scrX = d.x * s + view.tx;
            const scrY = d.y * s + view.ty;
            const sel = selDoor === i;
            return (
              <g key={`d${i}`} transform={`translate(${scrX} ${scrY}) rotate(${d.rot})`}>
                {sel && <circle cx={0} cy={0} r={6} fill="none" stroke={T.vetted} strokeWidth={1.5} />}
                <g transform={`scale(${s})`} style={{ cursor: "move" }} dangerouslySetInnerHTML={{ __html: doorInner(d.w, d.flip, d.mirror) }} />
              </g>
            );
          })}

          {/* WINDOWS — double-line glazing, placed on a wall (no swing). */}
          {windows.map((wn, i) => {
            const scrX = wn.x * s + view.tx;
            const scrY = wn.y * s + view.ty;
            const sel = selWin === i;
            return (
              <g
                key={`w${i}`}
                transform={`translate(${scrX} ${scrY}) rotate(${wn.rot})`}
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => { e.stopPropagation(); setSelWin(i); setSelDoor(null); setSelFurn(null); }}
              >
                {sel && <circle cx={0} cy={0} r={6} fill="none" stroke={T.vetted} strokeWidth={1.5} />}
                <g transform={`scale(${s})`} dangerouslySetInnerHTML={{ __html: windowInner(wn.w) }} />
              </g>
            );
          })}

          {/* TEXT labels — placed in image space, scale with the view. Click to select, drag to move, pin to rotate. */}
          {texts.map((t, i) => {
            const scrX = t.x * s + view.tx;
            const scrY = t.y * s + view.ty;
            const sel = selectedText === i;
            const fs = t.size * s;
            return (
              <g key={`t${i}`} transform={`rotate(${t.rot} ${scrX} ${scrY})`}>
                <text
                  x={scrX}
                  y={scrY}
                  fontSize={fs}
                  fontWeight={700}
                  fill={sel ? T.vetted : "#1a1a1a"}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={{
                    cursor: "move",
                    fontFamily: "'Helvetica Neue', Arial, sans-serif",
                    letterSpacing: "0.08em",
                    paintOrder: "stroke",
                    stroke: "#fff",
                    strokeWidth: Math.max(2, fs * 0.1),
                    userSelect: "none",
                  }}
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    snapshot();
                    textDragRef.current = i;
                    setSelectedText(i);
                    (ev.target as Element).setPointerCapture?.(ev.pointerId);
                  }}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation();
                    editText(i);
                  }}
                >
                  {t.text}
                </text>
                {/* ROTATE PIN — a small ↻ handle above a SELECTED label; click to rotate it 90° (one tap = vertical) */}
                {sel && (
                  <g
                    transform={`translate(${scrX} ${scrY - Math.max(18, fs * 0.75)})`}
                    style={{ cursor: "pointer" }}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      rotateSelectedText();
                    }}
                  >
                    <circle r={9} fill={T.vetted} stroke="#fff" strokeWidth={1.5} />
                    <text x={0} y={0} fontSize={12} fill="#06281d" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none", userSelect: "none" }}>
                      ↻
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* calibration first point */}
          {calA && (
            <circle cx={toScreen(calA).x} cy={toScreen(calA).y} r={5} fill="none" stroke={T.hold} strokeWidth={2} />
          )}
          {calA && hoverImg && (
            <line x1={toScreen(calA).x} y1={toScreen(calA).y} x2={toScreen(hoverImg).x} y2={toScreen(hoverImg).y} stroke={T.hold} strokeWidth={1.5} strokeDasharray="4 4" />
          )}
        </svg>

        {/* readout */}
        {hoverImg && (
          <div style={{ position: "absolute", bottom: 10, left: 12, fontSize: 11, fontFamily: T.mono, color: T.faint, background: "rgba(0,0,0,0.4)", padding: "3px 8px", borderRadius: 6 }}>
            img {hoverImg.x.toFixed(0)}, {hoverImg.y.toFixed(0)} · zoom {(s * 100).toFixed(0)}%
          </div>
        )}
      </div>
      </div>{/* /LEFT column */}
      </div>{/* /BODY flex */}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/svg+xml"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setImgUrl(URL.createObjectURL(f));
          e.target.value = "";
        }}
      />
    </main>
  );
}

function ToolBtn({ children, onClick, on, accent, disabled, title }: { children: React.ReactNode; onClick?: () => void; on?: boolean; accent?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: "100%",
        padding: "8px 12px",
        borderRadius: 7,
        fontSize: 13,
        fontWeight: on || accent ? 600 : 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        border: `1px solid ${on ? T.accent : accent ? T.accent : T.border}`,
        background: on ? T.accentSoft : accent ? T.accentSoft : T.panel2,
        color: on || accent ? "#ffffff" : T.text,
        whiteSpace: "nowrap",
        textAlign: "center",
      }}
    >
      {children}
    </button>
  );
}
