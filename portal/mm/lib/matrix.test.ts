// §4a matrix.csv projection tests (lib/matrix.ts). Pure, no I/O. Run via tsx.
// Covers: top-floor-first row order, shared column grid, colspan (wide unit -> trailing empty), rowspan
// (same value directly below -> blanked), "x" spacer for gaps, the positional "Unit N" header row,
// unitCellValue extraction, matrixableBuildingNodes detection, and export.ts emitting the file.

import { emptyPack, type GeoNode, type Pack } from "./pack";
import {
  buildMatrixGrid,
  columnBoundaries,
  floorsTopFirst,
  matrixableBuildingNodes,
  serializeMatrixCsv,
  unitCellValue,
} from "./matrix";
import { buildPackFiles } from "./export";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// Tiny node builder (explicit footprints so we control column positions exactly).
function node(id: string, kind: GeoNode["kind"], parentId: string | undefined, rect: { x: number; y: number; w: number; h: number }, name = id, status?: GeoNode["status"]): GeoNode {
  return { id, name, kind, parentId, footprint: { shape: "rect", rect }, status };
}

// --- A building with 2 floors on a 4-column grid (boundaries at 0.25.5.75, 1) ---
//   topFloor (y=0):   unit 201 (cols 0-1, WIDE = colspan) | unit 202 (col 2) | unit 203 (col 3)
//   lowFloor (y=0.5): unit 201 (cols 0-1, duplex below 201 = ROWSPAN) | GAP (col 2) | unit 103 (col 3)
const building = node("b1", "building", undefined, { x: 0, y: 0, w: 1, h: 1 });
const fTop = node("f-top", "floor", "b1", { x: 0, y: 0, w: 1, h: 0.5 }, "Floor 2");
const fLow = node("f-low", "floor", "b1", { x: 0, y: 0.5, w: 1, h: 0.5 }, "Floor 1");
// units are fractions of their FLOOR (floor is full width, so unit x within floor == x within building)
const u201t = node("u201t", "unit", "f-top", { x: 0,    y: 0, w: 0.5,  h: 1 }, "201", "available"); // cols 0-1
const u202t = node("u202t", "unit", "f-top", { x: 0.5,  y: 0, w: 0.25, h: 1 }, "202", "sale-plus");  // col 2
const u203t = node("u203t", "unit", "f-top", { x: 0.75, y: 0, w: 0.25, h: 1 }, "203", "reserved-minus"); // col 3
const u201l = node("u201l", "unit", "f-low", { x: 0,    y: 0, w: 0.5,  h: 1 }, "201", "available"); // cols 0-1 (duplex)
// col 2 on the low floor is a GAP (no unit) -> "x"
const u103l = node("u103l", "unit", "f-low", { x: 0.75, y: 0, w: 0.25, h: 1 }, "103", "blocked"); // col 3

const pack: Pack = { ...emptyPack("Matrix Test"), geo: [building, fTop, fLow, u201t, u202t, u203t, u201l, u103l] };

// --- top floor first ---
const floors = floorsTopFirst(pack, "b1");
ok(floors.length === 2 && floors[0].id === "f-top" && floors[1].id === "f-low", "floorsTopFirst: top (lower y) first");

// --- column grid: edges at 0.5.75, 1 (dedup of all unit edges) => 3 columns ---
const bounds = columnBoundaries(pack, "b1");
ok(bounds.length === 4, `columnBoundaries dedups to 4 boundaries (got ${bounds.length}: ${bounds.join(",")})`);

const grid = buildMatrixGrid(pack, "b1");
ok(grid.length === 2, "grid has one row per floor");
const nCols = grid[0]?.length ?? 0;
ok(nCols === 3, `grid width = 3 columns (got ${nCols})`);

// top row: [201, "" (colspan), 202, 203] -> but 201 spans cols 0-1, so col0=201 col1="" col2=202... wait 3 cols
// boundaries 0.5.75,1 => col0=[0.5) col1=[.5.75) col2=[.75,1). 201 spans col0 only (0..0.5). 202 col1. 203 col2.
ok(grid[0][0].value === "201", "top row col0 = 201");
ok(grid[0][1].value === "202", "top row col1 = 202");
ok(grid[0][2].value === "203", "top row col2 = 203");

// low row: col0 = 201 but it's directly below the top 201 => ROWSPAN => blanked ""
ok(grid[1][0].value === "", "low row col0 = '' (rowspan: duplex 201 continues below)");
// col1 on the low floor has no unit => "x" spacer
ok(grid[1][1].value === "x", "low row col1 = 'x' spacer (gap)");
ok(grid[1][2].value === "103", "low row col2 = 103");

// --- CSV serialization: rows + positional header last ---
const csv = serializeMatrixCsv(pack, "b1");
const lines = csv.trim().split("\n");
ok(lines.length === 3, "csv = 2 floor rows + 1 header row");
ok(lines[0] === "201,202,203", `row0 '${lines[0]}'`);
ok(lines[1] === ",x,103", `row1 '${lines[1]}'`);
ok(lines[2] === "Unit 1,Unit 2,Unit 3", `header '${lines[2]}'`);

// --- unitCellValue extraction ---
ok(unitCellValue({ ...u201t, name: "201" }) === "201", "unitCellValue: bare number");
ok(unitCellValue({ ...u201t, name: "Unit 305" }) === "305", "unitCellValue: trailing number in name");
ok(unitCellValue({ ...u201t, name: "Penthouse", id: "ph-1" }) === "Penthouse", "unitCellValue: falls back to name");

// --- explicit COLSPAN: a wide unit crossing >1 column boundary leaves trailing empty cells ---
// Grid from edges {0.25.5, 1}: penthouse spans 0..0.5 (2 columns), neighbour at.5..1 (last column).
// Boundaries 0.25.5,1 => col0=[0.25) col1=[.25.5) col2=[.5,1). PH covers col0+col1 => col0=PH, col1="".
const cb = node("cb", "building", undefined, { x: 0, y: 0, w: 1, h: 1 });
const cf = node("cf", "floor", "cb", { x: 0, y: 0, w: 1, h: 1 }, "Floor 1");
const cPh = node("c-ph", "unit", "cf", { x: 0,   y: 0, w: 0.5, h: 1 }, "901"); // spans col0+col1
const cNb = node("c-nb", "unit", "cf", { x: 0.5, y: 0, w: 0.5, h: 1 }, "502"); // col2
// a .25 boundary is forced by a NARROW unit on another floor so the grid has a mid column to span over
const cf2 = node("cf2", "floor", "cb", { x: 0, y: 0.5, w: 1, h: 1 }, "Floor 0");
const cNarrow = node("c-nar", "unit", "cf2", { x: 0.25, y: 0, w: 0.25, h: 1 }, "001"); // forces .25 + .5 edges
const colspanPack: Pack = { ...emptyPack("Colspan"), geo: [cb, cf, cf2, cPh, cNb, cNarrow] };
const cg = buildMatrixGrid(colspanPack, "cb");
const topRow = cg[0]; // Floor 1 (y=0) is top
ok(topRow.length === 3, `colspan grid 3 cols (got ${topRow.length})`);
ok(topRow[0].value === "901", "colspan: col0 = 901");
ok(topRow[1].value === "", "colspan: col1 = '' (PH1 spans into it)");
ok(topRow[2].value === "502", "colspan: col2 = 502");

// --- matrixableBuildingNodes: only buildings with floors+units ---
const mb = matrixableBuildingNodes(pack);
ok(mb.length === 1 && mb[0].id === "b1", "matrixableBuildingNodes finds the one with floors+units");
const emptyB: Pack = { ...emptyPack("Empty"), geo: [node("b2", "building", undefined, { x: 0, y: 0, w: 1, h: 1 })] };
ok(matrixableBuildingNodes(emptyB).length === 0, "a floorless/unitless building is NOT matrixable");
ok(serializeMatrixCsv(emptyB, "b2") === "", "serializeMatrixCsv returns '' for an empty building");

// --- export.ts emits buildings/<geoNodeId>/matrix.csv with a checksum ---
async function main() {
  const files = await buildPackFiles(pack);
  ok("buildings/b1/matrix.csv" in files, "export emits buildings/b1/matrix.csv");
  ok(files["buildings/b1/matrix.csv"] === csv, "exported matrix.csv matches serializeMatrixCsv");
  const manifest = JSON.parse(files["pack.json"]);
  ok("buildings/b1/matrix.csv" in (manifest.checksums || {}), "matrix.csv has a checksum in the manifest");

  console.log(`\nmatrix.test: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
