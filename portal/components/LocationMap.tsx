"use client";

// LocationMap — the public entry for the OSM/Leaflet map. Dynamic-imports the real map
// (./LocationMap.inner) with ssr:false because Leaflet touches `window`, which would crash SSR. Render this
// anywhere a building/unit (or a captured GPS point) is shown; it is ABSENT-SAFE — pass `geo={undefined}` and
// it renders nothing, so every pre-geo building behaves exactly as before.
//
//   <LocationMap geo={building.geo} />                       read-only (marker + access roads)
//   <LocationMap geo={geo} editable onChange={setGeo} />     developer authoring
//
// OFF-CHAIN, public building context. (A buyer's captured KYC GPS, is party-scoped PII shown only
// the reveal-gated pre-sign view — but it's the same read-only map component, just a different point.)

import dynamic from "next/dynamic";
import type { BuildingGeo } from "@/lib/catalog-client";

const Inner = dynamic(() => import("./LocationMap.inner"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: 260,
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
      loading map…
    </div>
  ),
});

export default function LocationMap({
  geo,
  editable,
  onChange,
  height,
  zoom,
}: {
  geo: BuildingGeo | undefined;
  editable?: boolean;
  onChange?: (geo: BuildingGeo) => void;
  height?: number;
  zoom?: number;
}) {
  // Absent-safe: no location → render nothing (read-only). In editable mode we need a starting point, so a
  // caller that wants to AUTHOR a new location must seed geo (e.g. a sensible default center) first.
  if (!geo) return null;
  return <Inner geo={geo} editable={editable} onChange={onChange} height={height} zoom={zoom} />;
}
