// Render-set CATALOG + the DETERMINISTIC slot → file mapping. PURE, shared by the server (fs) and client
// (fetch) producers so BOTH map identically. Each entry is ONE COMPLETE building's image set (ported from a real
// the operator catalog building, brand-stripped, aliased) — real floor plans per floor, real unit layouts per type+subtype, real
// renders. NO round-robin (: "bad idea"): every slot maps to its ACTUAL file, so Floor N shows Floor N's
// plan and a 1BR-A shows the 1BR-A layout. A generated building PICKS a set (by name hash) so different
// buildings look different, each internally coherent.

import type { MediaSlot } from "./media";

/** One complete building's set + its real inventory (dir under public/renderings/). */
export interface RenderSet {
  dir: string;            // public/renderings/<dir>
  levels: number;         // levels/1..N.jpg
  units: string[];        // the TYPE_SUB layout files present (e.g. "1BR_A", "STD_A")
  renderings: { ext: number; int: number; fac: number }; // ext_1..N.png etc. (0 = none → fallback)
}

/** The catalog — each a complete the operator catalog building set (brand-stripped). Add a set by copying it in + an entry here. */
export const RENDER_SETS: RenderSet[] = [
  {
    dir: "skyline-tower", // ported from CGTower — the richest set (29 floors, interiors present)
    levels: 29,
    units: ["1BR_A", "1BR_B", "1BR_C", "1BR_D", "2BR_A", "2BR_B", "STD_A", "SHP_A"],
    renderings: { ext: 7, int: 16, fac: 13 },
  },
  {
    dir: "oceanview", // ported from Paradise Ocean View (7 floors, more 2BR variations, NO interiors → fallback)
    levels: 7,
    units: ["1BR_A", "1BR_B", "1BR_C", "1BR_D", "2BR_A", "2BR_B", "2BR_C", "2BR_D", "2BR_E", "2BR_F"],
    renderings: { ext: 4, int: 0, fac: 3 },
  },
];

/** Stable string hash → pick a set deterministically per building (same building always gets the same set). */
export function pickSet(buildingId: string): RenderSet {
  let h = 0;
  for (let i = 0; i < buildingId.length; i++) h = (h * 31 + buildingId.charCodeAt(i)) | 0;
  return RENDER_SETS[Math.abs(h) % RENDER_SETS.length];
}

/** MM uses STUDIO/SHOP in its type keys; the the operator catalog sets use STD/SHP. Map MM → file prefix. */
function typeAlias(t: string): string {
  const up = t.toUpperCase();
  if (up === "STUDIO") return "STD";
  if (up === "SHOP") return "SHP";
  return up;
}

/**
 * The relative file (within `set.dir`) for a required slot, or null if the set can't map it (→ fallback: the
 * next producer / the export placeholder). `rCursor` lets a category pick distinct heroes (each building has one
 * of each here, so it stays at index 1). Deterministic: a given (set, slot) always yields the same file.
 */
export function rendersetFileForSlot(set: RenderSet, slot: MediaSlot, rCursor: Record<string, number>): string | null {
  // level plan: levels/<floor> → the ACTUAL floor plan; clamp to the set's available range.
  if (slot.kind === "level") {
    const m = slot.key.match(/levels\/(\d+)/);
    if (!m || set.levels < 1) return null;
    const floor = Math.max(1, Math.min(set.levels, parseInt(m[1], 10)));
    return `levels/${floor}.jpg`;
  }

  // unit layout: units/<TYPE>_<SUB> → the ACTUAL type+subtype layout; fall back to <TYPE>_A, then the first unit.
  if (slot.kind === "unit") {
    const m = slot.key.match(/units\/(.+)/);
    if (!m || !set.units.length) return null;
    const raw = m[1].toUpperCase();
    const [typePart, subPart] = raw.includes("_") ? [raw.slice(0, raw.indexOf("_")), raw.slice(raw.indexOf("_") + 1)] : [raw, "A"];
    const type = typeAlias(typePart);
    const exact = `${type}_${subPart}`;
    if (set.units.includes(exact)) return `units/${exact}.jpg`;
    const typeA = `${type}_A`;
    if (set.units.includes(typeA)) return `units/${typeA}.jpg`;
    return `units/${set.units[0]}.jpg`; // unknown type → the set's first layout (never a broken map)
  }

  // building renderings: EXT_/INT_/FAC_ → that category's hero; a category the set lacks (count 0) → fallback.
  if (slot.kind === "rendering") {
    const cat = slot.key.includes("EXT_") ? "ext" : slot.key.includes("FAC_") ? "fac" : "int";
    const max = set.renderings[cat as keyof RenderSet["renderings"]];
    if (!max) return null; // e.g. Paradise has no interiors → INT_lobby falls back to Gemini/placeholder
    const i = ((rCursor[cat] ?? 0) % max) + 1;
    rCursor[cat] = (rCursor[cat] ?? 0) + 1;
    return `renderings/${cat}_${i}.png`;
  }

  return null;
}
