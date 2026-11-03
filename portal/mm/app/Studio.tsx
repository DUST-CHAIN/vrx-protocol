"use client";

// The STUDIO face (slice 2) — the §4d nested drawing board. Canvas (center) + GeoInspector (right). The left
// FRAME is shared (page.tsx). "Add first node" seeds a root land/building when the project has no geometry.

import type { ReactNode } from "react";
import type { PackApi } from "./usePack";
import { type GeoApi, nextChildKind } from "./useGeo";
import { Canvas } from "./Canvas";
import { GeoInspector } from "./GeoInspector";
import { SubtypePlanPanel } from "./SubtypePlanPanel";
import { KIND_LABEL } from "@/lib/geo";

export function Studio({ api, geo, railSplitter }: { api: PackApi; geo: GeoApi; railSplitter?: ReactNode }) {
  const hasGeo = (api.pack.geo || []).length > 0;
  const addKind = nextChildKind(api.pack, geo.focusId);

  return (
    <>
      <main className="mm-main mm-main--canvas">
        {hasGeo ? (
          <Canvas pack={api.pack} geo={geo} />
        ) : (
          <div className="mm-canvas-empty">
            <h1 className="mm-main__title">Drawing board</h1>
            <p>
              Lay out the building as nested regions — land → building → floor → unit → prop — each posed inside
              its parent. Area and price roll up the tree; every box carries a size and a price even before it is
              drawn in detail.
            </p>
            <button className="mm-btn mm-btn--primary" onClick={() => geo.addRoot()}>
              + Add {KIND_LABEL[addKind || "land"].toLowerCase()}
            </button>
          </div>
        )}
      </main>
      {railSplitter}
      {/*  the right rail is a column: the building-level SUBTYPE-PLAN panel (coverage + Author/Clear) sits
 above the per-node inspector. A dedicated Studio pane (the §7(a) pick) without restructuring faces —
          the panel is building-scoped (derives from the active node), the inspector is node-scoped. */}
      <div className="mm-rail-col">
        <SubtypePlanPanel api={api} geo={geo} />
        <GeoInspector pack={api.pack} geo={geo} />
      </div>
    </>
  );
}
