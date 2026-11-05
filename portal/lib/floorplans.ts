// Per-unit floor-plan resolver. Maps a catalog unit to its floor-plan image URL(s) under
// /public/floorplans (copied from the the operator catalog resources\ folder by scripts/copy-floorplans.mjs — the
// deploy-safe path, no runtime dependency on the local the operator catalog machine).
//
// the operator catalog keys unit floor plans by TYPE+SUBTYPE (one plan shared by every unit of that type+subtype), and
// level plans by FLOOR. So a unit typically has TWO plans: (1) its unit floor plan, then (2) the level
// plan for its floor. Missing plans (e.g. penthouses have no unit plan; a floor with no level image)
// are simply omitted — the caller falls back to marketing images. Client-safe (imports only JSON).

import manifest from "./floorplans-manifest.json";
import type { Unit } from "./catalog-client";

// Catalog unit `type` -> the the operator catalog filename PREFIX. Types without a floor-plan family (penthouse) map to
// null and resolve to no unit plan (graceful — the level plan and marketing images still show).
const TYPE_PREFIX: Record<string, string | null> = {
  studio: "STD",
  "1br": "1BR",
  "2br": "2BR",
  shop: "SHP",
  duplex: "DPX",
  penthouse: "PTH", // The Cloud ships PTH_A/PTH_B plans; other buildings have none → resolves to null
};

type BuildingPlans = { units: Record<string, string>; levels: Record<string, string> };
const M = manifest as Record<string, BuildingPlans>;

function base(buildingId: string): string {
  return `/floorplans/${buildingId}`;
}

/** The unit floor plan URL for this unit's type+subtype, or null if none exists. */
export function unitPlanUrl(buildingId: string, unit: Unit): string | null {
  const b = M[buildingId];
  if (!b) return null;
  const prefix = TYPE_PREFIX[unit.type] ?? null;
  if (!prefix) return null;
  const sub = (unit.subtype || "A").toUpperCase();
  const key = `${prefix}_${sub}`;
  const file = b.units[key];
  return file ? `${base(buildingId)}/units/${file}` : null;
}

/** The level (per-floor) plan URL for this unit's floor, or null if that floor has no image. */
export function levelPlanUrl(buildingId: string, unit: Unit): string | null {
  const b = M[buildingId];
  if (!b || !unit.floor) return null;
  const file = b.levels[String(unit.floor)];
  return file ? `${base(buildingId)}/levels/${file}` : null;
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
