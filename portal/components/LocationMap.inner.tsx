"use client";

// LocationMap INNER — the actual Leaflet map (react-leaflet 5). Client-only; never imported directly by a
// page — always via./LocationMap (which dynamic-imports this with ssr:false, because Leaflet touches
// `window`). Two modes:
// read-only — a marker at {lat,lng} + the access-road polylines overlaid + an "open in OSM" link.
// editable — drag the marker to set lat/lng; click the map to append points to the CURRENT access road;
// "new road" starts another; "undo"/"clear" edit the drawing. Emits onChange(geo).
// OFF-CHAIN, public building context. Buyer GPS rides in read-only mode as a single marker.

import { useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { BuildingGeo, AccessRoad } from "@/lib/catalog-client";

// Leaflet's default marker icons resolve to bundler-broken asset URLs under Next/webpack. Point them at the
// CDN copies so the pin actually renders (the well-known react-leaflet + Next fix).
const ICON = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export type LocationMapProps = {
  geo: BuildingGeo;
  editable?: boolean;
  /** Called on any edit (pin move / road draw) when editable. */
  onChange?: (geo: BuildingGeo) => void;
  /** Map pixel height. */
  height?: number;
  /** Initial zoom. */
  zoom?: number;
};

/** Click-to-draw helper: in editable mode, a map click appends a point to the last access road (creating one
 * if none). Lives inside MapContainer so it can use the map-events hook. */
function DrawCatcher({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function LocationMapInner({ geo, editable, onChange, height = 260, zoom = 15 }: LocationMapProps) {
  const [draft, setDraft] = useState<BuildingGeo>(geo);
  const g = editable ? draft : geo;

  const center = useMemo<[number, number]>(() => [g.lat, g.lng], [g.lat, g.lng]);
  const roads = g.accessRoads ?? [];

  function emit(next: BuildingGeo) {
    setDraft(next);
    onChange?.(next);
  }

  function movePin(lat: number, lng: number) {
    emit({ ...g, lat, lng });
  }

  function appendPoint(lat: number, lng: number) {
    const rs = roads.slice();
    if (rs.length === 0) rs.push({ path: [] });
    const last = { ...rs[rs.length - 1], path: [...rs[rs.length - 1].path, [lat, lng] as [number, number]] };
    rs[rs.length - 1] = last;
    emit({ ...g, accessRoads: rs });
  }

  function newRoad() {
    emit({ ...g, accessRoads: [...roads, { path: [] }] });
  }
  function undoPoint() {
    if (roads.length === 0) return;
    const rs = roads.slice();
    const last = { ...rs[rs.length - 1], path: rs[rs.length - 1].path.slice(0, -1) };
    if (last.path.length === 0) rs.pop();
    else rs[rs.length - 1] = last;
    emit({ ...g, accessRoads: rs });
  }
  function clearRoads() {
    emit({ ...g, accessRoads: [] });
  }

  return (
    <div>
      <div style={{ height, borderRadius: 10, overflow: "hidden", border: "1px solid #ddd" }}>
        <MapContainer center={center} zoom={zoom} style={{ height: "100%", width: "100%" }} scrollWheelZoom={false}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Marker
            position={center}
            icon={ICON}
            draggable={!!editable}
            eventHandlers={
              editable
                ? {
                    dragend(e: L.LeafletEvent) {
                      const m = e.target as L.Marker;
                      const p = m.getLatLng();
                      movePin(p.lat, p.lng);
                    },
                  }
                : undefined
            }
          />
          {roads.map((r, i) =>
            r.path.length >= 2 ? (
              <Polyline key={i} positions={r.path} pathOptions={{ color: "#1a7f3c", weight: 4, opacity: 0.8 }} />
            ) : r.path.length === 1 ? (
              <Marker key={i} position={r.path[0]} icon={ICON} />
            ) : null
          )}
          {editable && <DrawCatcher onClick={appendPoint} />}
        </MapContainer>
      </div>

      {editable ? (
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 13 }}>
          <span style={{ color: "#666" }}>
            Drag the pin to place the building; click the map to trace an access road.
          </span>
          <button type="button" onClick={newRoad} style={editBtn}>
            + new road
          </button>
          <button type="button" onClick={undoPoint} style={editBtn}>
            undo point
          </button>
          <button type="button" onClick={clearRoads} style={editBtn}>
            clear roads
          </button>
          <span style={{ color: "#999", marginLeft: "auto" }}>
            {g.lat.toFixed(5)}, {g.lng.toFixed(5)}
          </span>
        </div>
      ) : (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <a
            href={`https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lng}#map=16/${g.lat}/${g.lng}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#1a7f3c" }}
          >
            Open in OpenStreetMap ↗
          </a>
          {g.label && <span style={{ color: "#777", marginLeft: 10 }}>{g.label}</span>}
        </div>
      )}
    </div>
  );
}

const editBtn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid #ccc",
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};

export type { BuildingGeo, AccessRoad };
