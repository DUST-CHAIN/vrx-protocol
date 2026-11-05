"use client";

// SitePlanMap — the OSM/Leaflet "site plan" map (layer 1). An EXTENSION of <LocationMap>: same
// ssr:false dynamic-import (Leaflet touches `window`), same editable/read-only split, same ABSENT-SAFE
// contract — it renders only the layers present on `geo`, so a building (point + roads only)
// behaves exactly as the old map did.
//
// Layers it adds over LocationMap:
//   • land PARCEL polygon         geo.landPolygon
//   • building FOOTPRINT polygon  geo.footprintPolygon
//   • orientation north arrow + sunrise(E)/sunset(W) marks   geo.northBearing
//
//   <SitePlanMap geo={building.geo} />                        read-only (agent + customer)
//   <SitePlanMap geo={geo} editable onChange={setGeo} />      developer authoring
//
// This is the reusable map that will later host layer 2 (a georeferenced level-plan image aligned onto the
// footprint) and layer 3 (the map mounted as a "third plan" view). OFF-CHAIN, public building context (
// family). (Buyer KYC GPS stays on the simpler read-only <LocationMap>, a single party-scoped point.)

import dynamic from "next/dynamic";
import type { BuildingGeo } from "@/lib/catalog-client";
import type { SitePlanTheme } from "./SitePlanMap.inner";

export type { SitePlanTheme };

const Inner = dynamic(() => import("./SitePlanMap.inner"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: 320,
        borderRadius: 10,
        border: "1px solid #eee",
        background: "#f6f6f6",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#999",
        fontSize: 13,
      }}
    >
      loading site plan…
    </div>
  ),
});

export default function SitePlanMap({
  geo,
  editable,
  onChange,
  height,
  zoom,
  theme,
  thumbnail,
}: {
  geo: BuildingGeo | undefined;
  editable?: boolean;
  onChange?: (geo: BuildingGeo) => void;
  height?: number;
  zoom?: number;
  theme?: SitePlanTheme;
  thumbnail?: boolean;
}) {
  // Absent-safe: no location → nothing to render (read-only). An authoring caller must seed `geo` with at
  // least a center {lat,lng} before entering editable mode (same contract as LocationMap).
  if (!geo) return null;
  return <Inner geo={geo} editable={editable} onChange={onChange} height={height} zoom={zoom} theme={theme} thumbnail={thumbnail} />;
}
