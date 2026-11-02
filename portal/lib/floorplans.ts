// Per-unit floor-plan resolver. Maps a catalog unit to its floor-plan image URL(s) under
// level plans by FLOOR. So a unit typically has TWO plans: (1) its unit floor plan, then (2) the level
// plan for its floor. Missing plans (e.g. penthouses have no unit plan; a floor with no level image)
// are simply omitted — the caller falls back to marketing images. Client-safe (imports only JSON).

import manifest from "./floorplans-manifest.json";
import type { Unit } from "./catalog-client";

// null and resolve to no unit plan (graceful — the level plan and marketing images still show).
const TYPE_PREFIX: Record<string, string | null> = {
  studio: "STD",
  "1br": "1BR",
  "2br": "2BR",
  shop: "SHP",
  duplex: "DPX",
  penthouse: "PTH", // The Cloud ships PTH_A/PTH_B plans; other buildings have none → resolves to null
};

// Generic minimalist SVG floor plans used as the graceful fallback when a building has no
// bespoke plan image for a unit type / floor. These are clean, brand-free line diagrams that
// ship with the repo — a demo always shows a tasteful plan rather than a blank slot.
const SVG_DIR = "/floorplans/_svg";
const TYPE_SVG: Record<string, string> = {
  studio: "unit-studio.svg",
  "1br": "unit-1br.svg",
  "2br": "unit-2br.svg",
  shop: "unit-shop.svg",
  duplex: "unit-duplex.svg",
  penthouse: "unit-penthouse.svg",
};
const LEVEL_SVG = "level-generic.svg";

type BuildingPlans = { units: Record<string, string>; levels: Record<string, string> };
const M = manifest as Record<string, BuildingPlans>;

function base(buildingId: string): string {
  return `/floorplans/${buildingId}`;
}

/** The unit floor plan URL for this unit's type+subtype. Falls back to a generic brand-free
 *  SVG for the unit type when no bespoke image exists (null only for an unknown type). */
export function unitPlanUrl(buildingId: string, unit: Unit): string | null {
  const b = M[buildingId];
  const prefix = TYPE_PREFIX[unit.type] ?? null;
  if (b && prefix) {
    const sub = (unit.subtype || "A").toUpperCase();
    const file = b.units[`${prefix}_${sub}`];
    if (file) return `${base(buildingId)}/units/${file}`;
  }
  const svg = TYPE_SVG[unit.type];
  return svg ? `${SVG_DIR}/${svg}` : null;
}

/** The level (per-floor) plan URL for this unit's floor. Falls back to a generic brand-free
 *  floor-plate SVG when no bespoke level image exists. */
export function levelPlanUrl(buildingId: string, unit: Unit): string | null {
  const b = M[buildingId];
  if (b && unit.floor) {
    const file = b.levels[String(unit.floor)];
    if (file) return `${base(buildingId)}/levels/${file}`;
  }
  return `${SVG_DIR}/${LEVEL_SVG}`;
}

export type FloorPlan = { url: string; kind: "unit" | "level"; label: string };

/** Both plans for a unit, in display order: unit plan first, level plan last. Empty if neither exists. */
export function floorPlansFor(buildingId: string, unit: Unit): FloorPlan[] {
  const out: FloorPlan[] = [];
  const u = unitPlanUrl(buildingId, unit);
  if (u) out.push({ url: u, kind: "unit", label: "Unit floor plan" });
  const l = levelPlanUrl(buildingId, unit);
  if (l) out.push({ url: l, kind: "level", label: `Floor ${unit.floor} layout` });
  return out;
}

/** Whether a unit has at least one floor plan (drives showing the tab / jump button). */
export function hasFloorPlans(buildingId: string, unit: Unit): boolean {
  return floorPlansFor(buildingId, unit).length > 0;
}
