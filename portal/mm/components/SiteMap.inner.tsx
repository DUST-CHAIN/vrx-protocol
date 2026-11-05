"use client";

// SiteMap INNER — the actual Leaflet map (react-leaflet 5). Client-only; always loaded via ./SiteMap
// (ssr:false). Captures the land node's geographic truth:
//   • pin        → siteGeo.centerLatLng          (drag, or "pin" draw click)
//   • parcel     → siteGeo.landPolygon           (click to add corners) → its metre bbox = the metre anchor
//   • north      → siteGeo.northBearingDeg        (slider; SEPARATE from the editor rotation — they compose)
// Illustration-grade: click-to-add-corner + draggable pin (no geoman handles — the polygon editor owns
// precise footprint shaping). Reuses the portal's self-hosted marker icons (public/leaflet/) — no CDN request.

import { useMemo, useState } from "react";
import { MapContainer, TileLayer, LayersControl, Marker, Polygon, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { SiteGeo } from "@/lib/pack";
import { metreExtentFromLatLngPolygon } from "@/lib/geo";
import type { SiteMapChange } from "./SiteMap";

const ICON = L.icon({
  iconUrl: "/leaflet/marker-icon.png",
  iconRetinaUrl: "/leaflet/marker-icon-2x.png",
  shadowUrl: "/leaflet/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

// Default view when a node has no location yet — Pattaya (the the operator catalog beachhead), same as the portal's default.
const DEFAULT_CENTER: [number, number] = [12.9236, 100.8825];

type DrawTarget = "pin" | "parcel";

/** Map-click router: a click dispatches to whatever draw target is active. */
function ClickCatcher({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

const PARCEL_STYLE: L.PathOptions = { color: "#e0953a", weight: 2, fillColor: "#f0b24a", fillOpacity: 0.18, dashArray: "6 4" };

export default function SiteMapInner({
  value,
  onChange,
  height = 300,
}: {
  value: SiteGeo | undefined;
  onChange: (change: SiteMapChange) => void;
  height?: number;
}) {
  const g = value ?? {};
  const [target, setTarget] = useState<DrawTarget>(g.landPolygon?.length ? "pin" : "parcel");

  const center = useMemo<[number, number]>(() => g.centerLatLng ?? DEFAULT_CENTER, [g.centerLatLng]);
  const parcel = g.landPolygon ?? [];
  const hasBearing = typeof g.northBearingDeg === "number";

  // Emit a new SiteGeo + the recomputed metre extent of the parcel (what the land node adopts as its anchor).
  function emit(next: SiteGeo) {
    onChange({ siteGeo: next, metreExtent: metreExtentFromLatLngPolygon(next.landPolygon) });
  }

  function onMapClick(lat: number, lng: number) {
    if (target === "pin") return emit({ ...g, centerLatLng: [lat, lng] });
    if (target === "parcel") return emit({ ...g, landPolygon: [...parcel, [lat, lng]] });
  }

  function setBearing(deg: number) {
    emit({ ...g, northBearingDeg: ((deg % 360) + 360) % 360 });
  }

  const extent = metreExtentFromLatLngPolygon(parcel);

  return (
    <div>
      {/* Dark-theme the Leaflet chrome to match MM. Attribution is licence-required → keep it, make it subtle. */}
      <style>{`
        .mm-sitemap .leaflet-control-attribution {
          background: rgba(10,13,22,0.6); color: #8892a8; font-size: 9px; padding: 0 4px;
        }
        .mm-sitemap .leaflet-control-attribution a { color: #9aa4bf; }
        .mm-sitemap .leaflet-bar a, .mm-sitemap .leaflet-control-layers-toggle {
          background-color: rgba(14,17,25,0.85); color: #cfe0ff; border-color: #232a3b;
        }
        .mm-sitemap .leaflet-bar a:hover { background-color: rgba(26,37,64,0.9); }
        .mm-sitemap .leaflet-control-layers { background: rgba(14,17,25,0.92); color: #dfe5f5; border-color: #232a3b; }
      `}</style>

      <div className="mm-sitemap" style={{ height, borderRadius: 10, overflow: "hidden", border: "1px solid var(--line, #334155)", position: "relative" }}>
        <MapContainer center={center} zoom={16} maxZoom={21} style={{ height: "100%", width: "100%" }} scrollWheelZoom={false}>
          <LayersControl position="topright">
            <LayersControl.BaseLayer checked name="Satellite">
              <TileLayer
                attribution="Tiles &copy; Esri"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                maxNativeZoom={19}
                maxZoom={21}
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name="Street">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                maxNativeZoom={19}
                maxZoom={21}
              />
            </LayersControl.BaseLayer>
          </LayersControl>

          {parcel.length >= 3 && <Polygon positions={parcel} pathOptions={PARCEL_STYLE} interactive={false} />}

          {g.centerLatLng && (
            <Marker
              position={g.centerLatLng}
              icon={ICON}
              draggable={target === "pin"}
              eventHandlers={
                target === "pin"
                  ? {
                      dragend(e: L.LeafletEvent) {
                        const p = (e.target as L.Marker).getLatLng();
                        emit({ ...g, centerLatLng: [p.lat, p.lng] });
                      },
                    }
                  : undefined
              }
            />
          )}

          <ClickCatcher onClick={onMapClick} />
        </MapContainer>

        {hasBearing && <OrientationBadge bearing={g.northBearingDeg as number} />}
      </div>

      {/* Toolbar */}
      <div style={{ marginTop: 8, fontSize: 13, color: "var(--text, #e2e8f0)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ color: "var(--muted, #94a3b8)", marginRight: 4 }}>Set:</span>
          {(["pin", "parcel"] as DrawTarget[]).map((t) => (
            <button key={t} type="button" onClick={() => setTarget(t)} style={target === t ? sActive : sIdle}>
              {TARGET_LABEL[t]}
            </button>
          ))}
        </div>

        <p style={{ color: "var(--muted, #94a3b8)", margin: "6px 0", fontSize: 12 }}>{TARGET_HINT[target]}</p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {target === "pin" && (
            <span style={{ color: "var(--muted, #94a3b8)" }}>
              {g.centerLatLng ? `${g.centerLatLng[0].toFixed(5)}, ${g.centerLatLng[1].toFixed(5)}` : "click the map to drop the pin"}
            </span>
          )}
          {target === "parcel" && (
            <>
              <button type="button" onClick={() => emit({ ...g, landPolygon: [] })} style={sEdit}>clear parcel</button>
              <button type="button" onClick={() => parcel.length && emit({ ...g, landPolygon: parcel.slice(0, -1) })} style={sEdit}>undo corner</button>
              <span style={{ color: "var(--muted, #94a3b8)" }}>
                {parcel.length} corner{parcel.length === 1 ? "" : "s"}
                {extent ? ` · ${extent.w.toFixed(0)} × ${extent.h.toFixed(0)} m` : ""}
              </span>
            </>
          )}
        </div>

        {/* North bearing — kept SEPARATE from the editor's rotation (they compose at render). */}
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ color: "var(--muted, #94a3b8)" }}>Geographic north:</span>
          <input
            type="range"
            min={0}
            max={359}
            value={hasBearing ? (g.northBearingDeg as number) : 0}
            onChange={(e) => setBearing(Number(e.target.value))}
            style={{ flex: "1 1 160px", minWidth: 120 }}
          />
          <span style={{ color: "var(--text, #e2e8f0)", minWidth: 110 }}>
            {hasBearing ? `${Math.round(g.northBearingDeg as number)}° (${compass(g.northBearingDeg as number)})` : "not set"}
          </span>
          {hasBearing && (
            <button type="button" onClick={() => emit({ ...g, northBearingDeg: undefined })} style={sEdit}>clear</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A compact compass badge: a north arrow rotated to the bearing (map-north = up). */
function OrientationBadge({ bearing }: { bearing: number }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        zIndex: 500,
        background: "rgba(14,17,25,0.85)",
        borderRadius: 8,
        border: "1px solid #232a3b",
        padding: "6px 8px",
        textAlign: "center",
        pointerEvents: "none",
        fontSize: 11,
        color: "#cfe0ff",
        lineHeight: 1.2,
      }}
    >
      <svg width="46" height="46" viewBox="0 0 54 54" style={{ display: "block", margin: "0 auto" }}>
        <g transform="translate(27,27)">
          <line x1="0" y1="0" x2="0" y2="-20" stroke="#6b7a99" strokeWidth="1" />
          <text x="-3" y="-21" fontSize="8" fill="#9aa4bf">N</text>
          <g transform={`rotate(${bearing})`}>
            <polygon points="0,-18 5,2 0,-3 -5,2" fill="#e0953a" />
          </g>
        </g>
      </svg>
      <div style={{ marginTop: 2 }}>north {compass(bearing)}</div>
    </div>
  );
}

/** 16-point compass label for a bearing in degrees (0 = N). */
function compass(deg: number): string {
  const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

const TARGET_LABEL: Record<DrawTarget, string> = {
  pin: "📍 pin",
  parcel: "▱ land parcel",
};
const TARGET_HINT: Record<DrawTarget, string> = {
  pin: "Click the map (or drag the pin) to place the site centre.",
  parcel: "Click around the plot boundary to trace the land parcel. Its size sets the real metre scale for the drawing board.",
};

const editBtn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--line, #334155)",
  background: "var(--frame-bg, #0e1626)",
  color: "var(--text, #e2e8f0)",
  cursor: "pointer",
  fontSize: 12,
};
const sEdit = editBtn;
const tabBtn: React.CSSProperties = {
  padding: "3px 9px",
  borderRadius: 14,
  border: "1px solid var(--line, #334155)",
  background: "var(--frame-bg, #0e1626)",
  color: "var(--text, #e2e8f0)",
  cursor: "pointer",
  fontSize: 12,
};
const sIdle = tabBtn;
const sActive: React.CSSProperties = {
  ...tabBtn,
  background: "var(--accent, #0d9488)",
  color: "#fff",
  borderColor: "var(--accent, #0d9488)",
};
