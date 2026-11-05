"use client";

// NetworkMap — public entry for the VRX ecosystem map. Dynamic-imports the Leaflet map
// (./NetworkMap.inner, ssr:false — Leaflet touches `window`), fetches the vendored country-borders GeoJSON
// once, renders a legend, and owns the zoomable card Lightbox (a node popup's card pops out here).
//
// Buyers see this too — it doubles as a system promo: "here's the real, global, Bitcoin-funded node network."

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { GeoJsonObject } from "geojson";
import { T } from "@/lib/theme";
import Lightbox from "@/components/Lightbox";
import { nodeLicenses, formatBtc, type NodeLicense } from "@/lib/node-licenses";

const Inner = dynamic(() => import("./NetworkMap.inner"), {
  ssr: false,
  loading: () => (
    <div style={{ height: 420, borderRadius: 12, background: "#0b1020", border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: T.faint, fontSize: 13 }}>
      loading the network map…
    </div>
  ),
});

const BTC = "#f7931a";
const AGENCY = "#3d7dff";
const BUILDING = "#e8b84b";
const MESH = "#38d39f"; // VRX vetted green — must match NetworkMap.inner MESH

type MapBuilding = { id: string; name: string; area: string; lat: number; lng: number };

export default function NetworkMap({ height = 420 }: { height?: number }) {
  const [geojson, setGeojson] = useState<GeoJsonObject | null>(null);
  const [worldGeo, setWorldGeo] = useState<GeoJsonObject | null>(null);
  const [buildings, setBuildings] = useState<MapBuilding[]>([]);
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [zoom, setZoom] = useState<NodeLicense | null>(null);

  useEffect(() => {
    let alive = true;
    // Node countries (highlighted) + the faint full-world outline (so it reads as Earth).
    fetch("/node-countries.geojson")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setGeojson(j as GeoJsonObject); })
      .catch(() => { /* borders are decoration — markers + mesh still render without them */ });
    fetch("/world-outline.geojson")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setWorldGeo(j as GeoJsonObject); })
      .catch(() => { /* outline is decoration */ });
    // REAL building locations (public, safe for buyers — /api/network-map).
    fetch("/api/network-map")
      .then((r) => (r.ok ? r.json() : { buildings: [] }))
      .then((j) => { if (alive) setBuildings((j.buildings ?? []) as MapBuilding[]); })
      .catch(() => { /* buildings are additive — map still renders without them */ });
    // "Where the user is" — best-effort, non-blocking; silently skipped if denied/unsupported.
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => { if (alive) setUserPos([p.coords.latitude, p.coords.longitude]); },
        () => { /* denied/unavailable — no marker, no nag */ },
        { timeout: 8000, maximumAge: 600000 }
      );
    }
    return () => { alive = false; };
  }, []);

  // The zoomable Lightbox shows the node cards; opening from a popup starts on that node.
  const nodes = nodeLicenses();
  const images = nodes.map((n) => n.image);
  const captions = nodes.map((n) => `${n.name} · ${n.code} · ${formatBtc(n.priceBtc)} ₿`);
  const startIndex = zoom ? Math.max(0, nodes.findIndex((n) => n.asset === zoom.asset)) : 0;

  return (
    <div>
      <Inner geojson={geojson} worldGeo={worldGeo} buildings={buildings} userPos={userPos} onZoom={setZoom} height={height} />
      {/* Legend — so the colors read clearly (promo clarity). */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8, fontSize: 12, color: T.dim }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: BTC, border: "1.5px solid #fff", display: "inline-block" }} /> Node (Bitcoin license)
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: AGENCY, display: "inline-block" }} /> Agency
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: BUILDING, display: "inline-block" }} /> Building
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 3, background: MESH, opacity: 0.6, display: "inline-block" }} /> Mesh link
        </span>
        <span style={{ color: T.faint }}>Hover a country for its GDP · click a node for details</span>
      </div>
      {zoom && (
        <Lightbox images={images} start={startIndex} caption={captions[startIndex]} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}
