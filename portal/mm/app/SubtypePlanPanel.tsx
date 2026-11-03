"use client";

// The per-subtype PLAN-AUTHORING panel (Slice B — design: the design docs §7).
// A building-level SURFACE in the Studio right rail: for the active building, list every {type, subtype}, show
// which have a shared plan authored (the "4 / 6 authored" gauge the field test, finding #2, asked for), and
// let root jump straight to authoring one (Author) or un-shape it (Clear) — WITHOUT hunting for a unit on the
// canvas. It is a navigation + management layer over the EXISTING write path: Author selects a representative unit
// (the inspector's existing subtype-plan editor takes over); Clear calls api.setSubtypePlan(…, undefined). It adds
// NO new write path (the second-source-of-truth trap) and NO per-unit override (deferred, §7(c)).

import { useState } from "react";
import type { PackApi } from "./usePack";
import type { GeoApi } from "./useGeo";
import { subtypePlanCoverage, type SubtypePlanCoverageRow } from "@/lib/subtype-plan-coverage";
import { ancestorsOf, nodeById } from "@/lib/geo";
import type { GeoNode } from "@/lib/pack";

/** The pack building the panel scopes to: the building ancestor of the active geo node, else the first building.
 *  Returns undefined when the project has no buildings at all (the panel then renders nothing). */
function activeBuildingId(api: PackApi, geo: GeoApi): string | undefined {
  const node = nodeById(api.pack, geo.selectedId) || nodeById(api.pack, geo.focusId);
  const bld = node && [node, ...ancestorsOf(api.pack, node.id)].find((n) => n.kind === "building");
  // ⚠ the geo building node id is `${packBuildingId}-bld` (geo.ts subtypePlanTarget strips the suffix).
  if (bld) return bld.id.replace(/-bld$/, "");
  return api.pack.buildings[0]?.id;
}

/** The first placed geo UNIT node of a subtype under the given building — the "Author" focus target (§8). The geo
 *  building node is `${buildingId}-bld`; a unit is under it iff that building node is in its ancestor chain. */
function representativeUnit(
  api: PackApi,
  buildingId: string,
  typeKey: string,
  subtypeKey: string
): GeoNode | undefined {
  const bldNodeId = `${buildingId}-bld`;
  for (const n of api.pack.geo || []) {
    if (n.kind !== "unit") continue;
    const ref = n.subtypeRef;
    if (!ref || ref.typeKey !== typeKey || ref.subtypeKey !== subtypeKey) continue;
    // confirm it lives under THIS building (the geo tree can hold many buildings)
    const underThis = [n, ...ancestorsOf(api.pack, n.id)].some((a) => a.id === bldNodeId);
    if (underThis) return n;
  }
  return undefined;
}

export function SubtypePlanPanel({ api, geo }: { api: PackApi; geo: GeoApi }) {
  const buildingId = activeBuildingId(api, geo);
  // the arm-state for the two-step Clear (one subtype armed at a time; clicking the panel background disarms)
  const [clearArmed, setClearArmed] = useState<string | null>(null);

  if (!buildingId) return null;
  const cov = subtypePlanCoverage(api.pack, buildingId);
  if (cov.rows.length === 0) {
    // the building has no SUBTYPES to author a shared plan for (a bare-type building). Keep the panel quiet rather
    // than show an empty gauge — nothing to manage here.
    return null;
  }

  const building = api.pack.buildings.find((b) => b.id === buildingId);
  const { authored, total } = cov.counts;

  // Author: focus the subtype's representative unit so the inspector opens ITS existing shape editor. focus clears
  // selection, so it runs first, then selectNode. A subtype with no placed unit has no target → the row disables it.
  function author(row: SubtypePlanCoverageRow) {
    const unit = representativeUnit(api, buildingId!, row.typeKey, row.subtypeKey);
    if (!unit) return;
    geo.focus(unit.parentId); // show the unit among its floor siblings on the canvas
    geo.selectNode(unit.id); // open the inspector on it (its "Edit the unit plan" / subtype-plan editor)
  }

  // Clear: un-shape every unit of the subtype via the ONE durable choke-point (setSubtypePlan → undefined). Two-step
  // armed because it's destructive (§4.2). A no-op if the subtype has no plan (the button is hidden then anyway).
  function clear(row: SubtypePlanCoverageRow) {
    api.setSubtypePlan(buildingId!, row.typeKey, row.subtypeKey, undefined);
    setClearArmed(null);
  }

  return (
    <aside
      className="mm-rail mm-rail--subtypes"
      onClick={() => clearArmed && setClearArmed(null)}
      aria-label="Subtype plan coverage"
    >
      <div className="mm-rail__head">
        <h2 className="mm-rail__title">Subtype plans</h2>
      </div>

      <div className="mm-subtypes">
        <div className="mm-subtypes__gauge" title="How many of this building's subtypes have a shared floor plan authored">
          <b>{authored}</b> / {total} subtype{total === 1 ? "" : "s"} have a plan
          {building?.name ? <span className="mm-subtypes__bld"> · {building.name}</span> : null}
        </div>

        <div className="mm-subtypes__hint">
          Each row is a unit subtype of this building. Authoring a plan here edits the <b>shared</b> shape — it
          applies to <b>every</b> unit of that subtype. Pick the ones with the most units first.
        </div>

        {cov.rows.map((row) => {
          const key = `${row.typeKey}:${row.subtypeKey}`;
          const hasUnit = !!representativeUnit(api, buildingId, row.typeKey, row.subtypeKey);
          const isArmed = clearArmed === key;
          return (
            <div key={key} className="mm-subtype-row">
              <div className="mm-subtype-row__main">
                <span className="mm-subtype-row__label">{row.label}</span>
                {row.sqm != null && <span className="mm-subtype-row__sqm">{Math.round(row.sqm).toLocaleString()} m²</span>}
                <span className="mm-subtype-row__count" title={`${row.units} unit${row.units === 1 ? "" : "s"} of this subtype`}>
                  {row.units}u
                </span>
                <span
                  className={`mm-subtype-row__chip ${row.hasPlan ? "is-authored" : "is-none"}`}
                  title={row.hasPlan ? "A shared plan is authored for this subtype" : "No shared plan yet — still a bare pin/rect"}
                >
                  {row.hasPlan ? "✎ authored" : "＋ no plan yet"}
                </span>
              </div>
              <div className="mm-subtype-row__actions">
                <button
                  className="mm-btn mm-btn--mini"
                  disabled={!hasUnit}
                  title={hasUnit
                    ? "Focus a unit of this subtype and open its plan editor"
                    : "No units of this subtype are placed yet — add one on the canvas first"}
                  onClick={(e) => { e.stopPropagation(); author(row); }}
                >
                  {row.hasPlan ? "✎ Edit plan" : "✎ Author plan"}
                </button>
                {row.hasPlan && (
                  <button
                    className={`mm-btn mm-btn--mini ${isArmed ? "mm-btn--danger" : ""}`}
                    title={isArmed
                      ? `Click again to clear the shared plan — un-shapes all ${row.units} unit${row.units === 1 ? "" : "s"}`
                      : "Clear the shared plan for this subtype"}
                    onClick={(e) => { e.stopPropagation(); isArmed ? clear(row) : setClearArmed(key); }}
                  >
                    {isArmed ? `✓ clear ${row.units}u?` : "Clear"}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {cov.unattributedUnits > 0 && (
          <div className="mm-subtypes__warn" title="Units whose subtype binding matched no declared subtype — a data-quality signal, not a plan gap">
            ⚠ {cov.unattributedUnits} unit{cov.unattributedUnits === 1 ? "" : "s"} couldn&apos;t be attributed to a
            subtype (stale binding) — check their subtype in Structured.
          </div>
        )}
      </div>
    </aside>
  );
}
