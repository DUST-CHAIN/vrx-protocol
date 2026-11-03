// BOARD LAYOUT — the fixed-canvas, draggable-group UI system. The authoring UI is NOT responsive:
// it's a fixed 1760×900 board, and every UI GROUP (the building stack, the floor-plan editor, the palette, …)
// is its own absolutely-positioned <div> LAYER whose x/y/w/h come from a LAYOUT record. designs the UI by
// DRAGGING groups in a "design mode"; the result saves to a layout file. Normally the layout is LOCKED (groups
// fixed, read from the committed default) — it only changes when we deliberately go back to design mode.
//
// PERSISTENCE (: "we work it out, then save a layout; normally not changeable"): drags persist to
// localStorage instantly (survive reload) in design mode; an Export button hands the JSON to commit as the new
// locked default. So: committed DEFAULT_LAYOUT ships locked; a local override (if any) only exists while designing.
//
// Pure data + a small React hook. The board shell (app component) renders each group at its rect and, in design
// mode, makes it draggable. Group CONTENT is supplied by the shell (this module only owns geometry + persistence).

import { useCallback, useEffect, useState } from "react";

/** The fixed board size (px) — fits inside a 1920×1080 laptop with room for browser chrome + taskbar. */
export const BOARD_W = 1760;
export const BOARD_H = 900;

/** A placed UI group: an id + its rect on the board (px, board-local). `title` is the drag-handle label. */
export interface GroupRect {
  id: string;        // stable group id (matches a content key the shell knows how to render)
  title: string;     // shown on the drag handle in design mode
  x: number; y: number; w: number; h: number;
}

/** A whole board layout = the ordered groups + a schema version (so a committed file can migrate later). */
export interface BoardLayout {
  v: number;
  groups: GroupRect[];
}

/** The committed DEFAULT layout — the locked arrangement that ships. re-arranges this by designing + export.
 *  Seeded with the first real groups so the board is verifiable from day one; more groups get appended here. */
export const DEFAULT_LAYOUT: BoardLayout = {
  v: 1,
  groups: [
    // the designed arrangement (exported from design mode): a left rail (stack · detail · palette
    // stacked), the unit-grid MATRIX as the big center pane, and the floor-plan editor on the right.
    { id: "stack", title: "Building stack", x: 0, y: 2, w: 301, h: 436 },
    { id: "floor", title: "Floor-plan editor", x: 1021, y: 1, w: 724, h: 672 },
    { id: "detail", title: "Selection detail", x: 0, y: 448, w: 299, h: 246 },
    { id: "palette", title: "Palette & actions", x: 0, y: 697, w: 298, h: 199 },
    { id: "grid", title: "Unit grid (matrix)", x: 307, y: 0, w: 707, h: 895 },
  ],
};

const LS_KEY = "mm:board-layout-v1";

/** The smallest a group can be resized to (keeps the title bar + a little content usable). */
export const MIN_GROUP_W = 120, MIN_GROUP_H = 70;

/** Clamp a rect so a group can't be dragged/resized off the board (and stays >= the minimum size). */
function clampRect(r: GroupRect): GroupRect {
  const w = Math.max(MIN_GROUP_W, Math.min(r.w, BOARD_W));
  const h = Math.max(MIN_GROUP_H, Math.min(r.h, BOARD_H));
  const x = Math.max(0, Math.min(BOARD_W - w, r.x));
  const y = Math.max(0, Math.min(BOARD_H - h, r.y));
  return { ...r, w, h, x, y };
}

/**
 * The board-layout hook. Returns the current layout, a design-mode flag, and setters. In design mode, moveGroup
 * persists to localStorage; toggling OFF design mode leaves the saved positions in place (reload keeps them until
 * "reset to default"). `exportJson` returns the committable BoardLayout; `reset` clears the local override.
 */
export function useBoardLayout() {
  const [layout, setLayout] = useState<BoardLayout>(DEFAULT_LAYOUT);
  const [design, setDesign] = useState(false);

  // hydrate a saved override on mount (client-only; SSR renders the default, then this corrects it)
  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(LS_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as BoardLayout;
        if (parsed && Array.isArray(parsed.groups)) setLayout({ v: parsed.v ?? 1, groups: parsed.groups.map(clampRect) });
      }
    } catch { /* ignore a corrupt override — fall back to the default */ }
  }, []);

  const persist = useCallback((next: BoardLayout) => {
    setLayout(next);
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* storage full/blocked — in-memory only */ }
  }, []);

  /** Move one group to a new x/y (clamped). Only meaningful in design mode; persists. */
  const moveGroup = useCallback((id: string, x: number, y: number) => {
    persist({ ...layout, groups: layout.groups.map((g) => (g.id === id ? clampRect({ ...g, x, y }) : g)) });
  }, [layout, persist]);

  /** Resize one group to a new w/h (clamped to the board + the minimum). Design mode; persists. */
  const resizeGroup = useCallback((id: string, w: number, h: number) => {
    persist({ ...layout, groups: layout.groups.map((g) => (g.id === id ? clampRect({ ...g, w, h }) : g)) });
  }, [layout, persist]);

  /** The committable JSON (pretty) — paste into board-layout.ts DEFAULT_LAYOUT to lock it in. */
  const exportJson = useCallback(() => JSON.stringify(layout, null, 2), [layout]);

  /** Drop the local override → back to the committed default. */
  const reset = useCallback(() => {
    try { window.localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    setLayout(DEFAULT_LAYOUT);
  }, []);

  return { layout, design, setDesign, moveGroup, resizeGroup, exportJson, reset };
}

/** Look up a group's rect by id (or undefined if the layout doesn't place it). */
export function groupRect(layout: BoardLayout, id: string): GroupRect | undefined {
  return layout.groups.find((g) => g.id === id);
}
