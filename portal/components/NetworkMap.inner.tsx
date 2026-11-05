"use client";

// NetworkMap INNER — the VRX ecosystem map. Client-only (Leaflet touches `window`); never
// imported directly — always via ./NetworkMap (dynamic, ssr:false).
//
// WHAT IT SHOWS (a promo-grade picture buyers see too):
//   • COUNTRY choropleth — the node countries' borders + name + GDP (lib/node-licenses.nodeCountries +
//     the vendored /node-countries.geojson), shaded so "where VRX operates" reads at a glance.
//   • NODE markers (Bitcoin-orange) at each license's real city, with the MESH lines between them (the
//     node-to-node network). Click → popup: name, city, GPS, price, status + the minted-on-BTC card image
//     (tap it to pop out zoomable — onZoom hands the image up to the page's Lightbox).
//   • AGENCY markers (blue) — the ecosystem's reach today; more nodes + agencies arrive as it grows.
//
// HONEST: node coords are the real cities from the on-chain asset metadata; GDP is approximate (IMF/WB 2024).
// The buy still happens on tokenscan (the popup links out) — VRX custodies nothing.

import { useEffect, useMemo } from "react";
import { MapContainer, CircleMarker, Polyline, Popup, Tooltip, GeoJSON, useMap } from "react-leaflet";
import L from "leaflet";
import type { GeoJsonObject } from "geojson";
import "leaflet/dist/leaflet.css";
import { T } from "@/lib/theme";
import {
  nodeLicenses,
  ecosystemAgencies,
  nodeCountries,
  formatBtc,
  type NodeLicense,
} from "@/lib/node-licenses";

const BTC = "#f7931a"; // node marker (real Bitcoin asset)
const AGENCY = "#3d7dff"; // agency marker (the VRX blue)
const BUILDING = "#e8b84b"; // building marker (amber — real property locations, public/buyer-safe)
const MESH = T.vetted; // soft mesh lines in the VRX verification green

// A soft CURVED mesh link: a quadratic bezier from a→b, bowed perpendicular to its midpoint so the network
// reads as gentle arcs (not hard straight lines). Returns a sampled polyline that Leaflet renders smooth.
function curve(a: [number, number], b: [number, number], steps = 20): Array<[number, number]> {
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // Perpendicular offset, scaled to the link length so long links bow more (a pleasing, consistent curvature).
  const dLat = b[0] - a[0];
  const dLng = b[1] - a[1];
  const len = Math.hypot(dLat, dLng) || 1;
  const bow = len * 0.12; // curvature factor
  const ctrl: [number, number] = [mid[0] + (-dLng / len) * bow, mid[1] + (dLat / len) * bow];
  const pts: Array<[number, number]> = [];
  for (let t = 0; t <= steps; t++) {
    const u = t / steps;
    const lat = (1 - u) * (1 - u) * a[0] + 2 * (1 - u) * u * ctrl[0] + u * u * b[0];
    const lng = (1 - u) * (1 - u) * a[1] + 2 * (1 - u) * u * ctrl[1] + u * u * b[1];
    pts.push([lat, lng]);
  }
  return pts;
}

// Fixes the pinch-zoom OFFSET: Leaflet caches the map's pixel origin at init; if the container's
// on-screen position shifts afterwards (images above it finishing load, fonts reflowing, the rounded wrapper),
// touch gestures compute against a stale origin → the zoom lands offset. Re-running invalidateSize after
// mount + whenever the container resizes keeps Leaflet's geometry in sync, so pinch zooms to the right point.
function KeepSized() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const fix = () => map.invalidateSize({ animate: false });
    fix();
    const t = setTimeout(fix, 300); // after images/fonts above settle
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fix) : null;
    ro?.observe(el);
    window.addEventListener("orientationchange", fix);
    return () => {
      clearTimeout(t);
      ro?.disconnect();
      window.removeEventListener("orientationchange", fix);
    };
  }, [map]);
  return null;
}

// Graticule: the equator (lat 0) + timezone meridians every 15° (24 zones). Faint reference lines so the map
// reads as Earth, and the viewer can place themselves. Built once — plain lat/lng polylines.
const EQUATOR: Array<[number, number]> = [[0, -180], [0, 180]];
const MERIDIANS: Array<Array<[number, number]>> = Array.from({ length: 24 }, (_, i) => {
  const lng = -180 + i * 15;
  return [[-85, lng], [85, lng]] as Array<[number, number]>;
});

export type MapBuilding = { id: string; name: string; area: string; lat: number; lng: number };

export default function NetworkMapInner({
  geojson,
  worldGeo,
  buildings,
  userPos,
  onZoom,
  height = 420,
}: {
  /** The vendored node-country GeoJSON (highlighted, filled). Null until loaded. */
  geojson: GeoJsonObject | null;
  /** The faint ALL-countries world outline (so it reads as Earth, not just the node countries). */
  worldGeo: GeoJsonObject | null;
  /** REAL building locations from the catalog (public, safe for buyers — /api/network-map). */
  buildings: MapBuilding[];
  /** The viewer's {lat,lng} if they granted geolocation — a "you are here" marker. */
  userPos: [number, number] | null;
  /** Hand a card image up to the page so it opens in the shared zoomable Lightbox. */
  onZoom?: (license: NodeLicense) => void;
  height?: number;
}) {
  const nodes = useMemo(() => nodeLicenses(), []);
  const agencies = useMemo(() => ecosystemAgencies(), []);
  const countries = useMemo(() => nodeCountries(), []);
  const gdpByIso = useMemo(() => Object.fromEntries(countries.map((c) => [c.iso3, c])), [countries]);

  // Mesh: connect every node to every other node — the "all nodes meshed" network. Each link is a SOFT CURVE
  // (sampled quadratic bezier) so the web reads as gentle arcs, not hard lines. (n=11 → 55 links.)
  const mesh = useMemo(() => {
    const links: Array<Array<[number, number]>> = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        links.push(curve([nodes[i].lat, nodes[i].lng], [nodes[j].lat, nodes[j].lng]));
      }
    }
    return links;
  }, [nodes]);

  return (
    <MapContainer
      // Equirectangular (EPSG:4326) instead of Leaflet's default Web Mercator — Mercator balloons high
      // latitudes (Russia smeared across the top); the plate-carrée projection flattens that so the world
      // reads true-to-shape for this promo map. Zoom levels differ under 4326 (whole world ~zoom 1),
      // so center/zoom are retuned to frame Europe → Russia → China → Thailand. (Globe view parked for later.)
      crs={L.CRS.EPSG4326}
      center={[34, 55]}
      zoom={1}
      minZoom={1}
      maxZoom={6}
      worldCopyJump
      style={{ height, width: "100%", borderRadius: 12, background: "#0b1020" }}
      scrollWheelZoom={false}
      touchZoom
      attributionControl={false}
    >
      <KeepSized />
      {/* NO tile layer by design: the free CARTO/OSM dark tiles now require an API key (they render an
          "API KEY REQUIRED" watermark). A keyless, always-works "dark globe with glowing borders" reads more
          premium for this promo map anyway — the country polygons below ARE the landmasses. */}

      {/* Graticule — equator + timezone meridians (every 15°). Faint reference lines so the map reads as Earth
          and the viewer can place themselves. Drawn first = underneath everything. */}
      <Polyline positions={EQUATOR} pathOptions={{ color: "#5b6b86", weight: 0.6, opacity: 0.4, dashArray: "4 5" }} />
      {MERIDIANS.map((m, i) => (
        <Polyline key={`tz${i}`} positions={m} pathOptions={{ color: "#3a4762", weight: 0.4, opacity: 0.3 }} />
      ))}

      {/* FAINT all-country world outline — so it looks like a map of Earth, not only the node countries.
          No fill, thin grey stroke; sits under the highlighted node countries. */}
      {worldGeo && (
        <GeoJSON
          data={worldGeo}
          interactive={false}
          style={() => ({ color: "#2f3e59", weight: 0.5, fill: false, opacity: 0.7 })}
        />
      )}

      {/* Country choropleth — node countries filled + a GDP/name tooltip on hover. The fill makes the
          landmass read without any basemap tiles. */}
      {geojson && (
        <GeoJSON
          data={geojson}
          style={() => ({ color: BTC, weight: 1.2, fillColor: "#1b2740", fillOpacity: 0.9 })}
          onEachFeature={(feature, layer) => {
            const iso = (feature.properties as { iso3?: string })?.iso3 ?? "";
            const c = gdpByIso[iso];
            if (c) layer.bindTooltip(`${c.name} — GDP ~$${c.gdpUsdTrillions}T`, { sticky: true });
          }}
        />
      )}

      {/* Soft curved mesh links in the VRX green. */}
      {mesh.map((pts, i) => (
        <Polyline
          key={`m${i}`}
          positions={pts}
          pathOptions={{ color: MESH, weight: 0.8, opacity: 0.3, lineCap: "round", lineJoin: "round" }}
        />
      ))}

      {/* Agency markers (blue). */}
      {agencies.map((a) => (
        <CircleMarker
          key={a.name}
          center={[a.lat, a.lng]}
          radius={5}
          pathOptions={{ color: AGENCY, fillColor: AGENCY, fillOpacity: 0.85, weight: 1 }}
        >
          <Tooltip>{a.name}</Tooltip>
          <Popup>
            <div style={{ fontSize: 13 }}>
              <strong>{a.name}</strong>
              <br />
              {a.city}
              <br />
              <span style={{ color: "#888" }}>Agency · {a.lat.toFixed(4)}, {a.lng.toFixed(4)}</span>
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* Building markers (amber) — REAL property locations from the catalog (public, safe for buyers). Small
          so the nodes stay the focus; a tooltip names the building + its area. */}
      {buildings.map((b) => (
        <CircleMarker
          key={`b-${b.id}`}
          center={[b.lat, b.lng]}
          radius={3.5}
          pathOptions={{ color: BUILDING, fillColor: BUILDING, fillOpacity: 0.85, weight: 0.8 }}
        >
          <Tooltip>{b.name}{b.area ? ` · ${b.area}` : ""}</Tooltip>
          <Popup>
            <div style={{ fontSize: 13 }}>
              <strong>{b.name}</strong>
              <br />
              {b.area}
              <br />
              <span style={{ color: "#888" }}>Building · {b.lat.toFixed(4)}, {b.lng.toFixed(4)}</span>
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* Node markers (orange) — the stars of the map. */}
      {nodes.map((n) => (
        <CircleMarker
          key={n.asset}
          center={[n.lat, n.lng]}
          radius={7}
          pathOptions={{ color: "#fff", weight: 1.5, fillColor: BTC, fillOpacity: 0.95 }}
        >
          <Tooltip>{n.name} · {formatBtc(n.priceBtc)} ₿</Tooltip>
          <Popup minWidth={220}>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={n.image}
                alt={`${n.name} node card`}
                onClick={() => onZoom?.(n)}
                style={{ width: "100%", borderRadius: 6, cursor: "zoom-in", marginBottom: 6, border: `1px solid ${T.border}` }}
              />
              <strong>{n.name}</strong>
              <br />
              <span style={{ color: "#555" }}>{n.code} · node operator license</span>
              <br />
              <span style={{ color: BTC, fontWeight: 700 }}>{formatBtc(n.priceBtc)} ₿</span>{" "}
              <span style={{ color: n.open ? "#1a9e6a" : "#999" }}>· {n.open ? "OPEN" : "CLOSED"}</span>
              <br />
              <span style={{ color: "#888", fontSize: 11 }}>GPS {n.lat.toFixed(4)}, {n.lng.toFixed(4)}</span>
              <br />
              <a href={n.url} target="_blank" rel="noopener noreferrer" style={{ color: BTC }}>
                Buy on tokenscan ↗
              </a>
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* "You are here" — the viewer's own location (if they granted geolocation), so they can place
          themselves relative to the network. A pulsing white ring, distinct from nodes/agencies. */}
      {userPos && (
        <CircleMarker
          center={userPos}
          radius={6}
          pathOptions={{ color: "#fff", weight: 2, fillColor: "#fff", fillOpacity: 0.5 }}
        >
          <Tooltip permanent direction="top" offset={[0, -8]}>You are here</Tooltip>
          <Popup>
            <div style={{ fontSize: 13 }}>
              <strong>You are here</strong>
              <br />
              <span style={{ color: "#888" }}>{userPos[0].toFixed(3)}, {userPos[1].toFixed(3)}</span>
            </div>
          </Popup>
        </CircleMarker>
      )}
    </MapContainer>
  );
}
