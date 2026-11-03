// Building AUTHORING model — the real, granular definition of a building (: the form must capture
// how many floors, m² per floor, units per floor, then set which units are what TYPE (manually or by script),
// and assign SUBTYPES per unit per floor). PURE + testable; the /studio-ai step form edits this, then toSpec
// + the authored Unit[] drive assembleBuildingPack for FULL per-unit fidelity (not a guessed type ratio).
//
// Structure: a building shape + a per-floor grid of unit CELLS. Each cell has a type (studio|1br|2br|shop…) and
// a subtype (a|b|c…). "Script proposes, human adjusts": autoFillTypes lays a sensible pattern (shops
// low, a mix above, subtypes cycled) that the human then edits cell by cell.

import type { AiBuildingSpec, AiUnitSubtype } from "./ai-build";
import type { Unit } from "./pack";

/** A type the building offers. kind "unit" = sellable inventory; kind "core" = structural (elevator/stairs) —
 *  takes a whole COLUMN, is NOT sellable, and (coreSkipsTop) usually has no unit on the top floor (engine room
 *  above). */
export interface AuthoringType {
  key: string;            // studio | 1br | 2br | 3br | shop | elevator …
  label: string;          // "Studio", "1 Bedroom", "Elevator" …
  sqm: number;            // nominal area (a cell may override via its subtype)
  basePriceUsd: number;   // headline price at a low floor (0 for core)
  subtypes: AiUnitSubtype[]; // the layout variations (A/B/C …); at least one implied
  kind?: "unit" | "core"; // default "unit"; "core" = elevator/stairs (whole column, non-sellable)
  coreSkipsTop?: boolean; // a core that has no unit on the TOP floor (engine room above) — default true for core
  span?: number;          // vertical floors this unit occupies (default 1). span 2 = a DUPLEX: one atomic unit over
                          // two floors; the upper cell is a CONTINUATION (UnitCell.cont), not a separate unit.
}

/** One unit cell on a floor: which TYPE it is + which SUBTYPE (layout). */
export interface UnitCell {
  typeKey: string;        // references an AuthoringType.key; "" = empty slot (no unit)
  subtypeKey: string;     // references a subtype of that type; "" = the type's first/Standard
  cont?: boolean;         // true = this cell is the UPPER half of a duplex below it — occupies space, NOT its own unit
}

export interface BuildingAuthoring {
  // identity (carried into the spec scaffold)
  developerName: string;
  complexName: string;
  buildingName: string;
  area?: string;
  premiumView?: string;
  // shape
  floors: number;         // number of floors
  floorAreaM2: number;    // m² PER FLOOR (the real plate area)
  unitsPerFloor: number;  // cells per floor
  // the palette of types the building offers
  types: AuthoringType[];
  // the per-floor grid: grid[floorIndex][unitIndex] — floorIndex 0 = floor 1
  grid: UnitCell[][];
}

// ── construction + the auto-fill script ──────────────────────────────────────

/** A sensible default type palette ("script proposes"). Every type ships with 3 layouts A/B/C so the common
 *  shape is there to adjust or delete (delete is easier than create). A PUBLIC SPACE core (elevator/lobby/gym…) is
 *  non-sellable but occupies floor space; a DUPLEX is one atomic unit spanning two floors (span: 2). */
export function defaultTypes(): AuthoringType[] {
  const abc = (sqm: number, step = 0): AiUnitSubtype[] => [
    { key: "a", label: "Type A", sqm },
    { key: "b", label: "Type B", sqm: sqm + step },
    { key: "c", label: "Type C", sqm: sqm + step * 2 },
  ];
  return [
    // Public space = any non-sellable shared area (elevator, lobby, gym, stairs…). Occupies a cell; its LOCATION
    // matters; never counted as inventory. 3 layouts A/B/C to pick the kind of space.
    { key: "public", label: "Public space", sqm: 20, basePriceUsd: 0, kind: "core", coreSkipsTop: true, subtypes: [
      { key: "a", label: "Elevator" }, { key: "b", label: "Lobby" }, { key: "c", label: "Gym" },
    ] },
    { key: "shop", label: "Shop", sqm: 45, basePriceUsd: 90000, subtypes: abc(40, 8) },
    { key: "studio", label: "Studio", sqm: 34, basePriceUsd: 55000, subtypes: abc(30, 4) },
    { key: "1br", label: "1 Bedroom", sqm: 48, basePriceUsd: 82000, subtypes: abc(44, 4) },
    { key: "2br", label: "2 Bedroom", sqm: 75, basePriceUsd: 140000, subtypes: abc(70, 6) },
    { key: "3br", label: "3 Bedroom", sqm: 105, basePriceUsd: 210000, subtypes: abc(100, 10) },
    { key: "penthouse", label: "Penthouse", sqm: 180, basePriceUsd: 480000, subtypes: abc(170, 25) },
    // Duplex = ONE atomic unit over two floors (span: 2). Painting places the lower cell + a continuation above.
    { key: "duplex", label: "Duplex", sqm: 150, basePriceUsd: 420000, span: 2, subtypes: abc(140, 20) },
  ];
}

/** An empty grid (floors × unitsPerFloor) of empty cells. */
export function emptyGrid(floors: number, unitsPerFloor: number): UnitCell[][] {
  const f = Math.max(1, Math.floor(floors));
  const u = Math.max(1, Math.floor(unitsPerFloor));
  return Array.from({ length: f }, () => Array.from({ length: u }, () => ({ typeKey: "", subtypeKey: "" })));
}

/** A fresh authoring state from the building shape (empty grid + default palette). */
export function newAuthoring(init: Partial<BuildingAuthoring> = {}): BuildingAuthoring {
  const floors = init.floors ?? 10;
  const unitsPerFloor = init.unitsPerFloor ?? 6;
  return {
    developerName: init.developerName ?? "New Developer",
    complexName: init.complexName ?? "New Development",
    buildingName: init.buildingName ?? "Building A",
    area: init.area,
    premiumView: init.premiumView,
    floors, floorAreaM2: init.floorAreaM2 ?? 1100, unitsPerFloor,
    types: init.types ?? defaultTypes(),
    grid: init.grid ?? emptyGrid(floors, unitsPerFloor),
  };
}

/** Resize the grid to match the current floors × unitsPerFloor, preserving existing cells where they overlap. */
export function resizeGrid(a: BuildingAuthoring): UnitCell[][] {
  const next = emptyGrid(a.floors, a.unitsPerFloor);
  for (let f = 0; f < next.length; f++) {
    for (let u = 0; u < next[f].length; u++) {
      const old = a.grid[f]?.[u];
      if (old) next[f][u] = { ...old };
    }
  }
  return next;
}

export interface AutoFillOptions {
  shopFloors?: number;        // how many LOW floors are all shops (default 0)
  elevator?: boolean;         // place a core/elevator column if the palette has one (default true when present)
  mix?: Record<string, number>; // relative weights per residential type key (default from palette)
}

/**
 * "Script proposes" — COLUMN-STACKED, how buildings are really laid out: the SAME unit type stacks
 * vertically up a column (the corner 2BR is always position 1 on every floor), not re-dealt per floor. The
 * script: (1) assigns a residential type to each COLUMN by a weighted mix; (2) if the palette has a CORE
 * (elevator), one column is that core (same position every floor, skipping the TOP floor — engine room above);
 * (3) the low `shopFloors` are all shops across the columns (ground retail). Each column's SUBTYPE cycles across
 * its type's subtypes so a 1BR column alternates A/B up the stack. Deterministic; the human then edits/empties
 * any cell (an empty cell = no unit there, e.g. a tapered upper floor). PURE.
 */
export function autoFillTypes(a: BuildingAuthoring, opts: AutoFillOptions = {}): UnitCell[][] {
  const shopFloors = Math.max(0, opts.shopFloors ?? 0);
  const cols = Math.max(1, a.unitsPerFloor);
  const floors = Math.max(1, a.floors);
  const shop = a.types.find((t) => t.key === "shop");
  const core = a.types.find((t) => t.kind === "core");
  const wantCore = (opts.elevator ?? true) && !!core;

  const residential = a.types.filter((t) => t.kind !== "core" && t.key !== "shop");
  const weights = opts.mix ?? Object.fromEntries(residential.map((t) => [t.key, t.key === "studio" ? 2 : t.key === "1br" ? 2 : 1]));
  const bag: string[] = [];
  for (const t of residential) for (let i = 0; i < (weights[t.key] ?? 1); i++) bag.push(t.key);
  const seq = bag.length ? bag : residential.map((t) => t.key);

  // 1. assign a TYPE to each column (residential), and pick ONE column for the core (a middle column).
  const coreCol = wantCore ? Math.floor(cols / 2) : -1;
  const colType: string[] = [];
  for (let c = 0, r = 0; c < cols; c++) {
    if (c === coreCol) { colType[c] = core!.key; continue; }
    colType[c] = seq[r % seq.length]; r++;
  }
  // 2. a stable SUBTYPE per column (cycles so adjacent columns of the same type differ A/B).
  const subCursor: Record<string, number> = {};
  const colSub: string[] = colType.map((typeKey) => {
    const t = a.types.find((x) => x.key === typeKey);
    const subs = t?.subtypes?.length ? t.subtypes : [{ key: "a" }];
    const i = (subCursor[typeKey] ?? 0) % subs.length;
    subCursor[typeKey] = (subCursor[typeKey] ?? 0) + 1;
    return subs[i].key;
  });

  // 3. stack: each column is the same type on every floor (shops override the low floors; core skips the top).
  const topIdx = floors - 1;
  const grid = emptyGrid(floors, cols);
  for (let f = 0; f < floors; f++) {
    const isShopFloor = f < shopFloors && !!shop;
    for (let c = 0; c < cols; c++) {
      if (colType[c] === core?.key) {
        if (core?.coreSkipsTop && f === topIdx) { grid[f][c] = { typeKey: "", subtypeKey: "" }; continue; } // no unit atop the core
        grid[f][c] = { typeKey: core!.key, subtypeKey: colSub[c] };
        continue;
      }
      if (isShopFloor) { grid[f][c] = { typeKey: shop!.key, subtypeKey: shop!.subtypes[0]?.key ?? "a" }; continue; }
      grid[f][c] = { typeKey: colType[c], subtypeKey: colSub[c] };
    }
  }
  return grid;
}

// ── projection: authoring → the type palette (AiBuildingSpec) + the explicit authored units ──

/** The spec SCAFFOLD (dev/company/complex/building + the type palette) — units come from toUnits below. */
export function toSpec(a: BuildingAuthoring): AiBuildingSpec {
  return {
    developerName: a.developerName,
    complexName: a.complexName,
    buildingName: a.buildingName,
    area: a.area,
    stories: Math.max(1, Math.floor(a.floors)),
    premiumView: a.premiumView,
    unitTypes: a.types.map((t) => ({
      key: t.key, label: t.label,
      sqmMin: Math.min(...subSqms(t)), sqmMax: Math.max(...subSqms(t)),
      perFloor: 1, // placeholder — the authored units override the generated ones
      basePriceUsd: t.basePriceUsd,
      subtypes: t.subtypes,
      span: t.span,
      kind: t.kind,
    })),
  };
}

function subSqms(t: AuthoringType): number[] {
  const s = (t.subtypes || []).map((x) => x.sqm ?? t.sqm).filter((n) => n > 0);
  return s.length ? s : [t.sqm];
}

/**
 * The EXPLICIT per-unit list straight from the authored grid — full fidelity (each cell = one real unit with its
 * chosen type + subtype, sized/priced/viewed by its subtype, escalating by floor). This is what assembleBuilding
 * Pack uses when authored, so what you set per floor/per unit is EXACTLY what ships. PURE.
 */
export function toUnits(a: BuildingAuthoring): Unit[] {
  const stories = Math.max(1, Math.floor(a.floors));
  const topThird = Math.ceil(stories * (2 / 3));
  const units: Unit[] = [];
  for (let f = 0; f < a.grid.length; f++) {
    const floor = f + 1;
    // POSITION-FIXED numbering: a unit's number is its GRID COLUMN slot, not a dense count of filled
    // cells. So a hole keeps its slot number — position 5 is always "05" even if 1-4 are empty — which makes the
    // unitNumber a STABLE address VRX can keep adding to after import (a filled hole never renumbers its neighbours).
    // This also matches cellId/packToProject, which were already slot-based (the old dense `n` silently drifted
    // from them → overrides could attach to the wrong unit on a sparse grid). slot is 0-based → number = slot+1.
    for (let u = 0; u < a.grid[f].length; u++) {
      const cell = a.grid[f][u];
      if (!cell.typeKey) continue; // empty slot = no unit (a tapered upper floor leaves slots empty)
      if (cell.cont) continue; // the upper half of a duplex below — occupies space but is NOT its own unit
      const t = a.types.find((x) => x.key === cell.typeKey);
      if (!t || t.kind === "core") continue; // a core (elevator/stairs) is structural, NOT sellable inventory
      const pos = u + 1; // the fixed 1-based grid position (the column this unit sits in)
      const subs = t.subtypes?.length ? t.subtypes : [{ key: "a", label: t.label } as AiUnitSubtype];
      const sub = subs.find((s) => s.key === cell.subtypeKey) ?? subs[0];
      const hasVariants = (t.subtypes?.length ?? 0) > 1;
      const sqm = sub.sqm ?? t.sqm;
      const floorBump = 1 + 0.012 * (floor - 1);
      const highFloor = floor >= topThird;
      const view = sub.view || (highFloor && a.premiumView && !hasVariants ? a.premiumView : undefined);
      const viewBump = view ? 1.08 : 1;
      const priceUsd = Math.round(t.basePriceUsd * floorBump * viewBump * (sub.priceMult ?? 1));
      // unitNumber = the real-estate floor-prefixed NUMBER, now by FIXED position (floor 55, slot 36 → 5536). The
      // human-readable ID spells floor + position SEPARATELY (F55-36) so a tall tower never reads like a 5-digit count.
      const unitNumber = floor * 100 + pos;
      const posLabel = `F${floor}-${String(pos).padStart(2, "0")}`;
      units.push({
        id: `${t.key}-${sub.key}-${posLabel}`,
        type: t.key,
        subtype: hasVariants ? (sub.label || sub.key) : t.label,
        subtypeKey: sub.key, //  the STABLE subtype key — the geo tree links to the shared plan by this
        floor,
        unitNumber,
        sqm,
        priceUsd,
        view,
        baths: t.key === "studio" ? 1 : undefined,
      });
    }
  }
  return units;
}

/** Summary counts for the form — SELLABLE units only (a core/elevator is structural, not inventory). */
export function authoringSummary(a: BuildingAuthoring): { total: number; byType: Record<string, number>; filledFloors: number } {
  const byType: Record<string, number> = {};
  const coreKeys = new Set(a.types.filter((t) => t.kind === "core").map((t) => t.key));
  let total = 0;
  let filledFloors = 0;
  for (const row of a.grid) {
    let any = false;
    for (const c of row) {
      if (!c.typeKey || coreKeys.has(c.typeKey)) continue; // skip empty + core
      total++; byType[c.typeKey] = (byType[c.typeKey] ?? 0) + 1; any = true;
    }
    if (any) filledFloors++;
  }
  return { total, byType, filledFloors };
}

/**
 * Proportional WIDTHS for a floor's cells (the arrange step): each unit's display width is derived
 * its SIZE relative to the others on that floor (a 2BR is wider than a studio). Returns a width FRACTION (0..1)
 * per cell index; empty cells get 0. The sum of non-empty widths is 1. PURE — the UI multiplies by the row width.
 */
export function floorWidths(a: BuildingAuthoring, floorIndex: number): number[] {
  const row = a.grid[floorIndex] || [];
  const sizes = row.map((cell) => {
    if (!cell.typeKey) return 0;
    const t = a.types.find((x) => x.key === cell.typeKey);
    if (!t) return 0;
    const sub = t.subtypes.find((s) => s.key === cell.subtypeKey);
    return (sub?.sqm ?? t.sqm) || 1;
  });
  const total = sizes.reduce((s, n) => s + n, 0);
  if (total <= 0) return sizes.map(() => 0);
  return sizes.map((s) => s / total);
}

// NOTE: the drag-swap `moveCell` was REMOVED here — units are NOT reordered by swapping grid slots
// (the correction). Arrangement is now a per-floor LAYOUT (along-axis nudge, size-locked width)
// lib/floorplan-layout.ts, authored on the drawn SVG floor plan. See docs/.md D-.

// ── subtype SIZES editor (the right pane,: "right pane, sizes only") ──────────────────────────────────
/** The hard cap on subtypes per type (: "max 20"). */
export const MAX_SUBTYPES = 20;

/** The next free subtype key for a type (a, b, …, z, then a1, b1 …). PURE. */
function nextSubtypeKey(existing: AiUnitSubtype[]): string {
  const taken = new Set(existing.map((s) => s.key.toLowerCase()));
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 26; i++) {
      const k = String.fromCharCode(97 + i) + (round === 0 ? "" : String(round));
      if (!taken.has(k)) return k;
    }
  }
  return `s${existing.length + 1}`;
}

/** Add a subtype to a type (capped at MAX_SUBTYPES), seeded at the type's nominal sqm. Returns a NEW types[]. PURE. */
export function addSubtype(types: AuthoringType[], typeKey: string): AuthoringType[] {
  return types.map((t) => {
    if (t.key !== typeKey) return t;
    if (t.subtypes.length >= MAX_SUBTYPES) return t;
    const key = nextSubtypeKey(t.subtypes);
    const next: AiUnitSubtype = { key, label: `Type ${key.toUpperCase()}`, sqm: t.sqm };
    return { ...t, subtypes: [...t.subtypes, next] };
  });
}

/** Remove a subtype from a type (never below ONE — a type always has at least one layout). Returns a NEW types[].
 *  Does NOT touch the grid; cells still pointing at the removed key fall back to the type's first subtype at
 *  projection time (toUnits already does `?? subs[0]`). PURE. */
export function removeSubtype(types: AuthoringType[], typeKey: string, subtypeKey: string): AuthoringType[] {
  return types.map((t) => {
    if (t.key !== typeKey) return t;
    if (t.subtypes.length <= 1) return t;
    return { ...t, subtypes: t.subtypes.filter((s) => s.key !== subtypeKey) };
  });
}

/** Patch one field of one subtype (size / label / priceMult / view). Returns a NEW types[]. PURE. */
export function patchSubtype(types: AuthoringType[], typeKey: string, subtypeKey: string, patch: Partial<AiUnitSubtype>): AuthoringType[] {
  return types.map((t) => {
    if (t.key !== typeKey) return t;
    return { ...t, subtypes: t.subtypes.map((s) => (s.key === subtypeKey ? { ...s, ...patch } : s)) };
  });
}

// ── type (vocabulary) operations ─────────────────────────────────────────────
// Subtypes are layouts WITHIN a type; a TYPE is a whole unit category (Studio / 1BR / Shop …). The Build canvas
// lets you add/remove the type vocabulary from the SUBTYPE SIZES section. Removing a type is NOT like
// removing a subtype: a subtype has a `?? subs[0]` fallback, but a cell whose TYPE is gone has nothing to fall back
// to → removeType also CLEARS any grid cell painted with it (so the matrix never carries a dangling typeKey).

export const MAX_TYPES = 24;

/** The next free type key: new-type, new-type-2, … — url-safe + unique against the existing palette. PURE. */
function nextTypeKey(types: AuthoringType[]): string {
  const taken = new Set(types.map((t) => t.key));
  if (!taken.has("new-type")) return "new-type";
  for (let n = 2; ; n++) { const k = `new-type-${n}`; if (!taken.has(k)) return k; }
}

/** Add a fresh unit TYPE (one default subtype) to the palette, capped at MAX_TYPES. Returns a NEW types[]. PURE. */
export function addType(types: AuthoringType[]): AuthoringType[] {
  if (types.length >= MAX_TYPES) return types;
  const key = nextTypeKey(types);
  const next: AuthoringType = { key, label: "New type", sqm: 40, basePriceUsd: 60000, subtypes: [{ key: "a", label: "Type A" }] };
  return [...types, next];
}

/** Remove a TYPE from the palette (never below ONE — a building always offers at least one type) AND clear any grid
 *  cell painted with it (so the matrix never points at a removed type). Returns the NEW {types, grid}. PURE. */
export function removeType(types: AuthoringType[], grid: UnitCell[][], typeKey: string): { types: AuthoringType[]; grid: UnitCell[][] } {
  if (types.length <= 1 || !types.some((t) => t.key === typeKey)) return { types, grid };
  const nextTypes = types.filter((t) => t.key !== typeKey);
  const nextGrid = grid.map((row) => row.map((c) => (c.typeKey === typeKey ? { typeKey: "", subtypeKey: "" } : c)));
  return { types: nextTypes, grid: nextGrid };
}

// ── column operations (columns are the real unit of layout now) ──────────────────────────────────────
/** Fill a whole COLUMN (one unit position across every floor) with a type+subtype. A core type honors
 *  coreSkipsTop (leaves the top floor empty). An empty typeKey clears the column. Returns a NEW grid. PURE. */
export function fillColumn(a: BuildingAuthoring, col: number, typeKey: string, subtypeKey?: string): UnitCell[][] {
  const grid = a.grid.map((r) => r.slice());
  if (col < 0) return grid;
  const t = a.types.find((x) => x.key === typeKey);
  const sub = subtypeKey ?? t?.subtypes[0]?.key ?? (typeKey ? "a" : "");
  const topIdx = grid.length - 1;
  for (let f = 0; f < grid.length; f++) {
    if (!grid[f] || col >= grid[f].length) continue;
    if (typeKey && t?.kind === "core" && t.coreSkipsTop && f === topIdx) { grid[f][col] = { typeKey: "", subtypeKey: "" }; continue; }
    grid[f][col] = { typeKey, subtypeKey: typeKey ? sub : "" };
  }
  return grid;
}
