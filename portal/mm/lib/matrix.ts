// §4a matrix.csv — the 2D stacking-plan PROJECTION of the §4d nested-geometry tree (MM_ENGINE_AND_FACES §4a).
//
// This is a PROJECTION, not a second authoring surface: the geo tree (floors + unit footprints, authored in
// the Studio draw board) serializes DOWN to the operator catalog's floor×column CSV grammar. Nothing is authored twice — the
// unit rects + statuses already live in pack.geo[]; here we read them and lay them onto a shared column grid.
//
// the operator catalog grammar (verified from resources/{complex}/{building}/matrix/1.csv + views/unit/matrix.php, §4a):
//   - ONE ROW PER FLOOR, top floor first; the LAST row is a positional header "Unit 1,Unit 2,…,Unit N".
//   - A cell = a unit's identity (unitNumber || id) · empty "" to the RIGHT of a unit = colspan (wide unit) ·
//     empty "" BELOW the same value = rowspan (duplex/penthouse) · "x" = invisible spacer (wing gap / irregular).
//     (s=stairwell / l=lift / free text label are human-authored extras; a pure geo projection emits unit/x only.)
//
// The shared column grid is what makes columns align across floors: we collect every unit's left+right edge
// (x-fractions within the building) across ALL floors, dedupe to column boundaries, and each unit spans the
// columns its rect covers. This mirrors the operator catalog's fixed 74px grid where a wide unit occupies consecutive cells.
//
// PURE (Pack + building geo-node id -> csv text) so it's unit-testable with no zip/browser, same as export.ts.

import type { GeoNode, Pack } from "./pack";
import { childrenOf, footprintRect, nodeById, type Rect } from "./geo";

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** The floors of a building geo node, ordered TOP FLOOR FIRST (matrix grammar: top row = highest floor). */
export function floorsTopFirst(pack: Pack, buildingNodeId: string): GeoNode[] {
  const floors = childrenOf(pack, buildingNodeId).filter((n) => n.kind === "floor");
  // Order by vertical position: a lower y-fraction sits higher on the canvas = a higher floor. Ties broken by
  // heightM accumulation is overkill here — the canvas y IS the stacking order. Fall back to insertion order.
  return floors.slice().sort((a, b) => {
    const ya = footprintRect(a.footprint).y;
    const yb = footprintRect(b.footprint).y;
    if (ya !== yb) return ya - yb;
    return 0;
  });
}

/** Absolute x-left/x-right of a unit WITHIN ITS BUILDING (compose the floor's x-offset, since a unit rect is
 *  a fraction of its FLOOR). Floors typically span the full building width, but compose defensively. */
function unitSpanInBuilding(pack: Pack, unit: GeoNode): { left: number; right: number } {
  const u = footprintRect(unit.footprint);
  const floor = nodeById(pack, unit.parentId);
  const f: Rect = floor ? footprintRect(floor.footprint) : { x: 0, y: 0, w: 1, h: 1 };
  const left = f.x + u.x * f.w;
  const right = f.x + (u.x + u.w) * f.w;
  return { left: r4(left), right: r4(right) };
}

/** A unit cell's identity in the matrix (the operator catalog uses the unit number; fall back to a short id). */
export function unitCellValue(u: GeoNode): string {
  // name is the most human; if it's a bare number use it, else prefer a trailing number in the name, else id.
  const name = (u.name || "").trim();
  if (/^\d+$/.test(name)) return name;
  const m = name.match(/(\d+)\s*$/);
  if (m) return m[1];
  return name || u.id;
}

/**
 * Build the shared COLUMN GRID for a building: the sorted unique set of every unit edge (left+right) across
 * all floors, snapped to `tol` so near-equal edges (the §4b column snap already pulled them close) collapse to
 * ONE boundary. Returns the boundary x-fractions; N boundaries => N-1 columns.
 */
export function columnBoundaries(pack: Pack, buildingNodeId: string, tol = 0.012): number[] {
  const floors = childrenOf(pack, buildingNodeId).filter((n) => n.kind === "floor");
  const raw: number[] = [];
  for (const f of floors) {
    for (const u of childrenOf(pack, f.id).filter((n) => n.kind === "unit")) {
      const { left, right } = unitSpanInBuilding(pack, u);
      raw.push(left, right);
    }
  }
  if (!raw.length) return [];
  raw.sort((a, b) => a - b);
  // collapse near-equal boundaries to one (first-seen wins as the canonical boundary)
  const bounds: number[] = [raw[0]];
  for (const v of raw) {
    if (Math.abs(v - bounds[bounds.length - 1]) > tol) bounds.push(v);
  }
  return bounds;
}

/** Which column index a given x-fraction belongs to (the last boundary at-or-left-of x). */
function colIndex(bounds: number[], x: number, tol = 0.012): number {
  let idx = 0;
  for (let i = 0; i < bounds.length; i++) {
    if (x >= bounds[i] - tol) idx = i;
    else break;
  }
  return idx;
}

export interface MatrixCell {
  value: string; // unit identity | "x" spacer | "" (colspan/rowspan continuation)
}

/**
 * Project a building geo node to the the operator catalog matrix grid (rows = floors top-first; columns = shared grid).
 * Returns a rectangular grid of cells. A unit occupies its first column with its value and leaves trailing
 * spanned columns EMPTY (colspan). Columns a floor doesn't fill become "x" spacers. Rowspan (a unit value
 * repeated directly below) is blanked so the CSV encodes the span the operator catalog-style.
 */
export function buildMatrixGrid(pack: Pack, buildingNodeId: string): MatrixCell[][] {
  const bounds = columnBoundaries(pack, buildingNodeId);
  const nCols = Math.max(0, bounds.length - 1);
  const floors = floorsTopFirst(pack, buildingNodeId);
  if (!nCols || !floors.length) return [];

  const grid: MatrixCell[][] = [];
  for (const f of floors) {
    const row: MatrixCell[] = Array.from({ length: nCols }, () => ({ value: "x" })); // default spacer
    const units = childrenOf(pack, f.id)
      .filter((n) => n.kind === "unit")
      .map((u) => ({ u, span: unitSpanInBuilding(pack, u) }))
      .sort((a, b) => a.span.left - b.span.left);
    for (const { u, span } of units) {
      const startCol = colIndex(bounds, span.left);
      const endColExclusive = Math.max(startCol + 1, colIndex(bounds, span.right));
      row[startCol] = { value: unitCellValue(u) };
      for (let c = startCol + 1; c < endColExclusive && c < nCols; c++) row[c] = { value: "" }; // colspan
    }
    grid.push(row);
  }

  // Rowspan: a unit value directly below an identical value (duplex/penthouse spanning floors) blanks the LOWER
  // cell — the operator catalog reads "same value as the row above" via an empty cell below the anchor. We walk top->down.
  for (let c = 0; c < nCols; c++) {
    for (let rIdx = 1; rIdx < grid.length; rIdx++) {
      const here = grid[rIdx][c].value;
      const above = grid[rIdx - 1][c].value;
      if (here && here !== "x" && here === above) grid[rIdx][c] = { value: "" };
    }
  }

  return grid;
}

/** Escape one CSV field (quote if it contains comma/quote/newline) — same rule as units-csv.ts. */
function csvField(v: string): string {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

/**
 * Serialize a building geo node to a the operator catalog-grammar matrix.csv string (top floor first + a positional header row
 * "Unit 1,…,Unit N" last). Empty string when the building has no geo floors/units (law #2: caller just omits
 * the file). PURE.
 */
export function serializeMatrixCsv(pack: Pack, buildingNodeId: string): string {
  const grid = buildMatrixGrid(pack, buildingNodeId);
  if (!grid.length) return "";
  const nCols = grid[0].length;
  const rows = grid.map((row) => row.map((cell) => csvField(cell.value)).join(","));
  const header = Array.from({ length: nCols }, (_, i) => `Unit ${i + 1}`).join(",");
  return [...rows, header].join("\n") + "\n";
}

/**
 * The building geo nodes a pack can project to a matrix (kind === "building", has >=1 floor child with >=1
 * unit). Used by export to know which matrix.csv files to emit. Returns the geo-node ids.
 */
export function matrixableBuildingNodes(pack: Pack): GeoNode[] {
  return (pack.geo || []).filter((n) => {
    if (n.kind !== "building") return false;
    const floors = childrenOf(pack, n.id).filter((c) => c.kind === "floor");
    return floors.some((f) => childrenOf(pack, f.id).some((u) => u.kind === "unit"));
  });
}
