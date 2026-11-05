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

import { useCallback, useRef, useState } from "react";
import type { GeoNode, Pack } from "@/lib/pack";
import {
  ancestorsOf,
  childrenOf,
  deriveSqm,
  floorSummary,
  footprintRect,
  KIND_LABEL,
  nodeById,
  rootNodes,
  snapToColumns,
  STATUS_FILL,
  STATUS_LABEL,
  type Rect,
} from "@/lib/geo";
import type { GeoApi } from "./useGeo";
import { nextChildKind } from "./useGeo";
import { propIcon, type PropIcon } from "@/lib/furniture";

const PAD = 24; // px padding around the frame inside the SVG viewport
const HANDLE = 12; // px resize handle

type Drag =
  | { mode: "move"; id: string; startX: number; startY: number; orig: Rect }
  | { mode: "resize"; id: string; orig: Rect }
  | { mode: "vertex"; id: string; index: number }
  | { mode: "draw"; startX: number; startY: number }
  | null;

export function Canvas({ pack, geo }: { pack: Pack; geo: GeoApi }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [drawRect, setDrawRect] = useState<Rect | null>(null);
  const [snap, setSnap] = useState(true); // §4b: default snap units to building-wide columns; toggle to nudge off-grid

  const focusNode = nodeById(pack, geo.focusId);
  const children = geo.focusId ? childrenOf(pack, geo.focusId) : rootNodes(pack);
  const childKind = nextChildKind(pack, geo.focusId);

  // Column-snap a unit rect to its SIBLINGS' edges (exclude the one being edited). Only active for units.
  const snapUnitRect = useCallback(
    (r: Rect, selfId?: string): Rect => {
      if (!snap || childKind !== "unit") return r;
      const sibs = children.filter((n) => n.kind === "unit" && n.id !== selfId).map((n) => footprintRect(n.footprint));
      return snapToColumns(r, sibs);
    },
    [snap, childKind, children]
  );

  // frame rect in px — a 0..1 box occupies the padded viewport. We read the live SVG size at event time.
  const toPx = useCallback((r: Rect, box: DOMRect) => {
    const w = box.width - PAD * 2;
    const h = box.height - PAD * 2;
    return { x: PAD + r.x * w, y: PAD + r.y * h, w: r.w * w, h: r.h * h };
  }, []);
  const toFrac = useCallback((px: number, py: number, box: DOMRect) => {
    const w = box.width - PAD * 2;
    const h = box.height - PAD * 2;
    return { x: (px - PAD) / w, y: (py - PAD) / h };
  }, []);

  const box = () => svgRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 800, 600);
  const localXY = (e: React.MouseEvent) => {
    const b = box();
    return { x: e.clientX - b.left, y: e.clientY - b.top, b };
  };

  const onChildDown = (e: React.MouseEvent, n: GeoNode) => {
    e.stopPropagation();
    geo.selectNode(n.id);
    const { x, y } = localXY(e);
    setDrag({ mode: "move", id: n.id, startX: x, startY: y, orig: footprintRect(n.footprint) });
  };
  const onResizeDown = (e: React.MouseEvent, n: GeoNode) => {
    e.stopPropagation();
    geo.selectNode(n.id);
    setDrag({ mode: "resize", id: n.id, orig: footprintRect(n.footprint) });
  };
  const onCanvasDown = (e: React.MouseEvent) => {
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

  const onMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const { x, y, b } = localXY(e);
    if (drag.mode === "move") {
      const d = toFrac(x, y, b);
      const s = toFrac(drag.startX, drag.startY, b);
      geo.moveResize(drag.id, { x: drag.orig.x + (d.x - s.x), y: drag.orig.y + (d.y - s.y), w: drag.orig.w, h: drag.orig.h });
    } else if (drag.mode === "resize") {
      const f = toFrac(x, y, b);
      geo.moveResize(drag.id, { x: drag.orig.x, y: drag.orig.y, w: f.x - drag.orig.x, h: f.y - drag.orig.y });
    } else if (drag.mode === "vertex") {
      geo.moveVertex(drag.id, drag.index, toFrac(x, y, b));
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
    } else if ((drag?.mode === "move" || drag?.mode === "resize") && drag.id) {
      // settle the final position onto the column grid (soft snap — no-op when snap is off / not a unit)
      const n = nodeById(pack, drag.id);
      if (n && n.footprint?.shape === "rect") geo.moveResize(drag.id, snapUnitRect(footprintRect(n.footprint), drag.id));
    }
    setDrag(null);
    setDrawRect(null);
  };

  const b0 = box();

  return (
    <div className="mm-canvas-wrap">
      <Breadcrumb pack={pack} geo={geo} focusNode={focusNode} />

      <div className="mm-canvas-host">
        <svg
          ref={svgRef}
          className="mm-canvas"
          onMouseDown={onCanvasDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
        >
          {/* the frame = the focused node's interior (or the world at root) */}
          <rect className="mm-canvas__frame" x={PAD} y={PAD} width={Math.max(0, b0.width - PAD * 2)} height={Math.max(0, b0.height - PAD * 2)} />

          {children.map((n) => {
            const r = toPx(footprintRect(n.footprint), b0);
            const selected = geo.selectedId === n.id;
            const sqm = deriveSqm(pack, n.id);
            const fill = n.kind === "unit" && n.status ? STATUS_FILL[n.status] : undefined;
            const isPoly = n.footprint?.shape === "poly";
            const isProp = n.kind === "prop";
            return (
              <g key={n.id} className={`mm-geo mm-geo--${n.kind} ${selected ? "is-selected" : ""}`}>
                {isProp ? (
                  // §4d LOD: a prop is DATA, not a mesh — a schematic icon + "name · $price", not a status box.
                  <PropBody
                    node={n}
                    box={b0}
                    onBodyDown={(e) => onChildDown(e, n)}
                  />
                ) : isPoly ? (
                  <PolyBody
                    node={n}
                    box={b0}
                    fill={fill}
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
                {/* label legibility: only draw the name on a box tall/wide enough; m² sub-line needs more room.
                    Props carry their own label inside PropBody (name · price), so skip the generic labels. */}
                {!isProp && r.h >= 18 && r.w >= 34 && (
                  <text x={r.x + 6} y={r.y + 16} className="mm-geo__label">
                    {clipLabel(n.name, r.w)}
                  </text>
                )}
                {!isProp && sqm != null && r.h >= 34 && r.w >= 60 && (
                  <text x={r.x + 6} y={r.y + 30} className="mm-geo__sub">
                    {sqm.toLocaleString()} m²{n.kind === "unit" && n.status ? ` · ${STATUS_LABEL[n.status]}` : ""}
                  </text>
                )}
                {/* rect resize handle */}
                {selected && !isPoly && (
                  <rect
                    x={r.x + r.w - HANDLE}
                    y={r.y + r.h - HANDLE}
                    width={HANDLE}
                    height={HANDLE}
                    className="mm-geo__handle"
                    onMouseDown={(e) => onResizeDown(e, n)}
                  />
                )}
                {/* poly vertex + edge handles (selected only) */}
                {selected && isPoly && n.footprint?.shape === "poly" && (
                  <PolyHandles
                    node={n}
                    box={b0}
                    onVertexDown={(e, i) => onVertexDown(e, n.id, i)}
                    onVertexContext={(e, i) => { e.preventDefault(); geo.toggleFreezeVert(n.id, i); }}
                    onVertexDouble={(e, i) => { e.stopPropagation(); geo.removeVertex(n.id, i); }}
                    onEdgeContext={(e, i) => { e.preventDefault(); geo.toggleFreezeEdge(n.id, i); }}
                    onEdgeAdd={(e, i) => { e.stopPropagation(); geo.addVertex(n.id, i); }}
                  />
                )}
              </g>
            );
          })}

          {/* live draw-preview */}
          {drawRect && (() => {
            const r = toPx(drawRect, b0);
            return <rect x={r.x} y={r.y} width={r.w} height={r.h} className="mm-geo__draw" rx={4} />;
          })()}
        </svg>

        {/* floor roll-up — "read availability at a glance" (§4b). Shows when the focused node holds units. */}
        <FloorLegend pack={pack} focusId={geo.focusId} />

        <div className="mm-canvas__hint">
          {childKind
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

// Fraction point → px. (A tiny closure so both poly components share the frame mapping.)
type ToPx = (fr: { x: number; y: number }) => { x: number; y: number };
const vPx = (box: DOMRect): ToPx => (fr) => ({
  x: PAD + fr.x * (box.width - PAD * 2),
  y: PAD + fr.y * (box.height - PAD * 2),
});

/** The polygon body (fill + outline), with status fill when it's a unit. Reuses the group's click/zoom. */
function PolyBody({
  node, box, fill, onBodyDown, onDouble,
}: {
  node: GeoNode;
  box: DOMRect;
  fill?: string;
  onBodyDown: (e: React.MouseEvent) => void;
  onDouble: () => void;
}) {
  if (node.footprint?.shape !== "poly") return null;
  const p = vPx(box);
  const pts = node.footprint.points.map((pt) => p(pt));
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
  box: DOMRect;
  onBodyDown: (e: React.MouseEvent) => void;
}) {
  const p = vPx(box);
  const r = node.footprint?.shape === "rect" ? node.footprint.rect : footprintRect(node.footprint);
  const tl = p({ x: r.x, y: r.y });
  const w = r.w * (box.width - PAD * 2);
  const h = r.h * (box.height - PAD * 2);
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
    default:
      return <rect x={x0} y={y0} width={iw} height={ih} rx={2} />;
  }
}

/** Vertex dots (drag to move, right-click to freeze, double-click to delete) + edge-midpoint add-dots. */
function PolyHandles({
  node, box, onVertexDown, onVertexContext, onVertexDouble, onEdgeContext, onEdgeAdd,
}: {
  node: GeoNode;
  box: DOMRect;
  onVertexDown: (e: React.MouseEvent, i: number) => void;
  onVertexContext: (e: React.MouseEvent, i: number) => void;
  onVertexDouble: (e: React.MouseEvent, i: number) => void;
  onEdgeContext: (e: React.MouseEvent, i: number) => void;
  onEdgeAdd: (e: React.MouseEvent, i: number) => void;
}) {
  if (node.footprint?.shape !== "poly") return null;
  const p = vPx(box);
  const fp = node.footprint;
  const pts = fp.points.map((pt) => p(pt));
  const frozenV = new Set(fp.frozenVerts || []);
  const frozenE = new Set(fp.frozenEdges || []);
  return (
    <g className="mm-poly-handles">
      {/* edge midpoints: single-click adds a vertex; right-click freezes the edge */}
      {pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        return (
          <circle
            key={`e${i}`}
            cx={mx}
            cy={my}
            r={4.5}
            className={`mm-poly__edge ${frozenE.has(i) ? "is-frozen" : ""}`}
            onMouseDown={(e) => onEdgeAdd(e, i)}
            onContextMenu={(e) => onEdgeContext(e, i)}
          >
            <title>{frozenE.has(i) ? "Edge frozen — right-click to unfreeze" : "Click to add a vertex · right-click to freeze this edge"}</title>
          </circle>
        );
      })}
      {/* vertices: drag to move; right-click freeze; double-click delete */}
      {pts.map((q, i) => (
        <circle
          key={`v${i}`}
          cx={q.x}
          cy={q.y}
          r={6}
          className={`mm-poly__vert ${frozenV.has(i) ? "is-frozen" : ""}`}
          onMouseDown={(e) => onVertexDown(e, i)}
          onContextMenu={(e) => onVertexContext(e, i)}
          onDoubleClick={(e) => onVertexDouble(e, i)}
        >
          <title>{frozenV.has(i) ? "Vertex frozen — right-click to unfreeze" : "Drag to move · right-click to freeze · double-click to delete"}</title>
        </circle>
      ))}
    </g>
  );
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
