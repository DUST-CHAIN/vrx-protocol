"use client";

// The BOARD SHELL — a fixed 1760×900 non-responsive canvas where every UI GROUP is an absolutely-
// positioned, draggable <div> layer. designs the layout by dragging groups in DESIGN MODE; positions
// persist (localStorage) and export to a committable JSON. In LOCKED mode (normal use) groups are fixed. The
// group CONTENT is supplied by the page via `renderGroup(id)`; this shell owns geometry, dragging + persistence.

import { useRef, type ReactNode } from "react";
import { BOARD_W, BOARD_H, type BoardLayout, type GroupRect, useBoardLayout } from "@/lib/board-layout";
// Palette now lives in the shared theme module (visual unification) — one look across every MM shell.
import { T as C } from "@/lib/theme";

/** The board. `renderGroup(id)` returns the content for a placed group; unknown ids render an empty placeholder. */
export function Board({ renderGroup }: { renderGroup: (id: string) => ReactNode }) {
  const { layout, design, setDesign, moveGroup, resizeGroup, exportJson, reset } = useBoardLayout();

  async function copyLayout() {
    const json = exportJson();
    try { await navigator.clipboard.writeText(json); } catch { /* clipboard blocked — fall through to the prompt */ }
    // always also surface it so it's never lost (and works without clipboard permission)
    window.prompt("Board layout JSON — paste into lib/board-layout.ts DEFAULT_LAYOUT to lock it in:", json);
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" }}>
      {/* design toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: C.accent, display: "inline-block" }} />
        <b style={{ fontSize: 14 }}>VRX Model Maker</b>
        <span style={{ color: C.faint, fontSize: 12 }}>authoring board · fixed {BOARD_W}×{BOARD_H}</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: design ? C.vetted : C.dim, cursor: "pointer" }}>
            <input type="checkbox" checked={design} onChange={(e) => setDesign(e.target.checked)} />
            Design mode {design ? "· drag groups to arrange" : ""}
          </label>
          {design && <button onClick={copyLayout} style={tbtn(C.accent)}>⭳ Export layout</button>}
          {design && <button onClick={reset} style={tbtn()} title="discard local changes, back to the committed layout">↺ Reset</button>}
        </div>
      </div>

      {/* the fixed board — centred; a subtle grid in design mode. Groups are absolute layers within it. */}
      <div style={{ display: "flex", justifyContent: "center", padding: "12px 0" }}>
        <div style={{
          position: "relative", width: BOARD_W, height: BOARD_H, flex: `0 0 ${BOARD_W}px`,
          background: C.board, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden",
          backgroundImage: design ? `linear-gradient(${C.borderSoft} 1px, transparent 1px), linear-gradient(90deg, ${C.borderSoft} 1px, transparent 1px)` : "none",
          backgroundSize: "20px 20px",
        }}>
          {layout.groups.map((g) => (
            <GroupLayer key={g.id} g={g} design={design} onMove={moveGroup} onResize={resizeGroup}>{renderGroup(g.id)}</GroupLayer>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One group layer: absolute-positioned at its rect; in design mode, draggable by its title bar + resizable by a
 *  bottom-right corner handle. Both persist via onMove/onResize. */
function GroupLayer({ g, design, onMove, onResize, children }: {
  g: GroupRect; design: boolean;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, w: number, h: number) => void;
  children: ReactNode;
}) {
  const move = useRef<{ dx: number; dy: number } | null>(null);
  const size = useRef<{ x0: number; y0: number; w0: number; h0: number } | null>(null);

  // capture the pointer so the drag keeps tracking outside the element; never let a capture failure abort the drag
  const capture = (e: React.PointerEvent) => { try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* no active pointer (synthetic) — fine */ } };
  const release = (e: React.PointerEvent) => { try { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* ignore */ } };

  // drag (title bar) — reposition
  function barDown(e: React.PointerEvent) {
    if (!design) return;
    move.current = { dx: e.clientX - g.x, dy: e.clientY - g.y };
    capture(e);
  }
  function barMove(e: React.PointerEvent) {
    if (!move.current) return;
    onMove(g.id, e.clientX - move.current.dx, e.clientY - move.current.dy);
  }
  function barUp(e: React.PointerEvent) {
    move.current = null;
    release(e);
  }

  // resize (corner handle) — change w/h from the drag delta
  function cornerDown(e: React.PointerEvent) {
    if (!design) return;
    e.stopPropagation();
    size.current = { x0: e.clientX, y0: e.clientY, w0: g.w, h0: g.h };
    capture(e);
  }
  function cornerMove(e: React.PointerEvent) {
    if (!size.current) return;
    e.stopPropagation();
    onResize(g.id, size.current.w0 + (e.clientX - size.current.x0), size.current.h0 + (e.clientY - size.current.y0));
  }
  function cornerUp(e: React.PointerEvent) {
    size.current = null;
    release(e);
  }

  return (
    <div style={{
      position: "absolute", left: g.x, top: g.y, width: g.w, height: g.h,
      border: `1px solid ${design ? C.accent : C.border}`, borderRadius: 9, background: C.panel,
      boxShadow: design ? `0 0 0 1px ${C.accent}22` : "none", display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* title/drag bar — only interactive (and visible as a handle) in design mode */}
      <div onPointerDown={barDown} onPointerMove={barMove} onPointerUp={barUp}
        style={{
          flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6, padding: "4px 9px",
          borderBottom: `1px solid ${C.borderSoft}`, cursor: design ? "grab" : "default",
          background: design ? "#18202f" : "transparent", userSelect: "none",
        }}>
        {design && <span style={{ color: C.accent, fontSize: 12 }}>⠿</span>}
        <span style={{ color: C.faint, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em" }}>{g.title}</span>
        {design && <span style={{ marginLeft: "auto", color: C.faint, fontSize: 10, fontFamily: C.mono }}>{Math.round(g.w)}×{Math.round(g.h)} · {Math.round(g.x)},{Math.round(g.y)}</span>}
      </div>
      {/* content — scrolls within the fixed group box */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children}</div>
      {/* resize handle (bottom-right corner) — design mode only */}
      {design && (
        <div onPointerDown={cornerDown} onPointerMove={cornerMove} onPointerUp={cornerUp}
          title="drag to resize"
          style={{
            position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize",
            background: `linear-gradient(135deg, transparent 45%, ${C.accent} 45%, ${C.accent} 60%, transparent 60%, transparent 72%, ${C.accent} 72%, ${C.accent} 86%, transparent 86%)`,
            borderBottomRightRadius: 9,
          }} />
      )}
    </div>
  );
}

function tbtn(bg?: string): React.CSSProperties {
  return { background: bg || C.panel2, color: bg ? "#fff" : C.text, border: `1px solid ${bg || C.border}`, borderRadius: 7, padding: "4px 11px", fontSize: 12.5, cursor: "pointer", fontWeight: 500 };
}
