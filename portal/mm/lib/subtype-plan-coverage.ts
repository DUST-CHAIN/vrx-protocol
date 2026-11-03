// Per-subtype plan COVERAGE selector (Slice A of the subtype-plan-authoring panel —
// design: the design docs).
//
// A PURE, advisory read over a Pack: for the given building, list every {type, subtype} with whether it has a
// shared UnitPlan authored yet + how many units carry it. This is the DATA the panel (Slice B) renders — the
// "4 / 6 subtypes have a plan" coverage the field test (finding #2) asked for. No UI, no browser, testable.
//
// SOURCE OF TRUTH: the subtype PLAN lives on `building.unitTypes[].subtypes[].plan` (the projected mirror of the
// durable authored palette `b.types[].subtypes[].plan` that api.setSubtypePlan writes). We read the Pack
// (projected) so a caller passes exactly what the editor renders. A subtype with a truthy `.plan` is "authored".
//
// UNIT COUNT: prefer the STABLE key. The projected Unit carries `subtypeKey` (the a|b|std… key the geo
// tree binds by); when present it is binding-ACCURATE, so we count by it. Only when a unit lacks a
// subtypeKey do we fall back to matching `Unit.subtype` (a DISPLAY LABEL — pack.ts warns it's not a stable id).
// A unit with neither falls under the type's sole subtype iff the type is single-variant (the common case);
// otherwise it can't be attributed and is reported as `unattributedUnits` (a data-quality signal), never guessed.

import type { Pack, Building } from "./pack";
import type { AiUnitSubtype } from "./ai-build";

/** One row of the coverage report: a single {type, subtype} of a building + its plan state. */
export interface SubtypePlanCoverageRow {
  typeKey: string;
  subtypeKey: string;
  /** Human label for the row, e.g. "Studio B" (falls back to the subtype key, then the type label). */
  label: string;
  /** This subtype's declared area, if set (sqm) — lets the panel author the high-impact ones first. */
  sqm?: number;
  /** True when a shared UnitPlan is authored on this subtype (building.unitTypes[].subtypes[].plan is present). */
  hasPlan: boolean;
  /** Best-effort count of units attributed to this subtype by DISPLAY LABEL (see file header caveat). */
  units: number;
}

/** The whole report for one building: the rows + headline coverage counts for the panel gauge. */
export interface SubtypePlanCoverage {
  buildingId: string;
  rows: SubtypePlanCoverageRow[];
  /** Headline gauge: subtypes that have a plan / total subtypes. */
  counts: { authored: number; total: number };
  /** Units whose Unit.subtype label matched NO declared subtype (data-quality signal for the panel). */
  unattributedUnits: number;
}

/** The label a subtype presents under (matches how the Structured editor labels it). */
function subtypeLabel(type: { label?: string }, s: AiUnitSubtype): string {
  return (s.label && s.label.trim()) || s.key || type.label || "Standard";
}

/**
 * Build the per-subtype plan coverage for ONE building of a pack. PURE. Returns an empty report (no rows) if the
 * building is unknown or has no unitTypes. A type with no `subtypes` contributes nothing (there is no subtype to
 * author a shared plan for — a bare type's units own their footprints directly).
 */
export function subtypePlanCoverage(pack: Pack, buildingId: string): SubtypePlanCoverage {
  const building: Building | undefined = pack.buildings.find((b) => b.id === buildingId);
  const empty: SubtypePlanCoverage = { buildingId, rows: [], counts: { authored: 0, total: 0 }, unattributedUnits: 0 };
  if (!building || !building.unitTypes?.length) return empty;

  const units = pack.buildingUnits[buildingId] ?? [];
  const rows: SubtypePlanCoverageRow[] = [];
  let unattributed = 0;

  for (const type of building.unitTypes) {
    const subtypes = type.subtypes ?? [];
    if (!subtypes.length) continue; // a bare type has no shared-plan surface

    // Units of THIS type. Count by the STABLE subtypeKey when present (binding-accurate); else by the display
    // LABEL; a unit with neither is "" (attributable only to a single-variant type's sole subtype).
    const typeUnits = units.filter((u) => u.type === type.key);
    const countByKey = new Map<string, number>();   // keyed by subtype.key
    const countByLabel = new Map<string, number>(); // keyed by display label (fallback)
    let blank = 0;                                   // units with neither key nor label
    for (const u of typeUnits) {
      if (u.subtypeKey && u.subtypeKey.trim()) {
        const k = u.subtypeKey.trim();
        countByKey.set(k, (countByKey.get(k) ?? 0) + 1);
      } else if (u.subtype && u.subtype.trim()) {
        const l = u.subtype.trim();
        countByLabel.set(l, (countByLabel.get(l) ?? 0) + 1);
      } else {
        blank++;
      }
    }

    // A single-variant type absorbs its UNLABELLED units into that one subtype (the common case); a multi-variant
    // type cannot attribute a blank unit, so those are reported as unattributed rather than guessed.
    const soleSubtype = subtypes.length === 1 ? subtypes[0] : undefined;

    const matchedKeys = new Set<string>();
    const matchedLabels = new Set<string>();
    for (const s of subtypes) {
      const label = subtypeLabel(type, s);
      let count = (countByKey.get(s.key) ?? 0) + (countByLabel.get(label) ?? 0);
      matchedKeys.add(s.key);
      matchedLabels.add(label);
      if (soleSubtype && s === soleSubtype) count += blank;
      rows.push({
        typeKey: type.key,
        subtypeKey: s.key,
        label,
        sqm: typeof s.sqm === "number" && s.sqm > 0 ? s.sqm : undefined,
        hasPlan: !!s.plan,
        units: count,
      });
    }

    // Honesty: units whose stable key / label matched NO declared subtype would otherwise VANISH from every
    // tally. Count them as unattributed (a stale-binding data-quality signal) rather than silently drop them.
    for (const [k, n] of countByKey) if (!matchedKeys.has(k)) unattributed += n;
    for (const [l, n] of countByLabel) if (!matchedLabels.has(l)) unattributed += n;
    if (!soleSubtype) unattributed += blank;
  }

  const authored = rows.filter((r) => r.hasPlan).length;
  return {
    buildingId,
    rows,
    counts: { authored, total: rows.length },
    unattributedUnits: unattributed,
  };
}
