"use client";

// SiteMap — the MM Studio-face "Site & location" map (slice 2.5, §6). Ported from the portal's SitePlanMap
// pattern: a Leaflet map (ssr:false dynamic import — Leaflet touches `window`) that captures GEOGRAPHIC TRUTH
// on the land/site node — the pin (center), the land PARCEL polygon (whose metre extent seeds the §4d metre
// anchor), and the north BEARING (kept separate from the editor's rotation). The in-editor footprint is drawn
// independently; this map is where real-world scale + orientation come from for a real project.
//
//   <SiteMap value={node.siteGeo} onChange={(g, extent) => …} />
//
// Illustration-grade: no geoman/vertex-handle machinery — click to drop pin / add a parcel corner,
// drag the pin, a slider for north. The polygon editor owns precise footprint shaping, not this map.

import dynamic from "next/dynamic";
import type { SiteGeo } from "@/lib/pack";

export interface SiteMapChange {
  siteGeo: SiteGeo;
  /** Real metre extent (W×H) of the parcel bbox — the metre anchor the land node should adopt (undefined if < 2 corners). */
  metreExtent?: { w: number; h: number };
}

const Inner = dynamic(() => import("./SiteMap.inner"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: 300,
        borderRadius: 10,
        border: "1px solid var(--line, #334155)",
        background: "var(--frame-bg, #0e1626)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted, #94a3b8)",
        fontSize: 13,
      }}
    >
      loading map…
    </div>
  ),
});

export default function SiteMap({
  value,
  onChange,
  height,
}: {
  value: SiteGeo | undefined;
  onChange: (change: SiteMapChange) => void;
  height?: number;
}) {
  return <Inner value={value} onChange={onChange} height={height} />;
}
