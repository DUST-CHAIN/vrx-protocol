"use client";

// SitePlanMap INNER — the actual Leaflet map (react-leaflet 5). Client-only; always loaded via
//./SitePlanMap (ssr:false). Builds on LocationMap.inner's pin+road logic and adds the layer-1 site
// layers: land + footprint polygons and an orientation overlay (north arrow + E/W sun marks).
// Two modes (the LocationMap editable/read-only split):
// read-only (agent + customer) — marker + roads + polygons + orientation drawn; no editing.
// editable (developer) — a DRAW TARGET selector routes map clicks: move pin / trace road /
// draw land polygon / draw footprint polygon; a bearing slider sets north.
// ABSENT-SAFE: every layer renders only if its data is present.

import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, LayersControl, Marker, Polyline, Polygon, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import type { BuildingGeo } from "@/lib/catalog-client";

const ICON = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

/** Toolbar styling the host app can supply so the draw controls match its theme (the console is DARK; the
 * default below is the light fallback used by read-only/other callers). All optional — unset fields fall
 * back to the light defaults, so existing callers are unaffected. */
export type SitePlanTheme = {
  tabIdle?: React.CSSProperties;
  tabActive?: React.CSSProperties;
  editBtn?: React.CSSProperties;
  mutedText?: string; // hints + counters
  labelText?: string; // "Draw:" / "Orientation" labels
};

export type SitePlanMapProps = {
  geo: BuildingGeo;
  editable?: boolean;
  onChange?: (geo: BuildingGeo) => void;
  height?: number;
  zoom?: number;
  theme?: SitePlanTheme;
  /** Thumbnail mode: render just the map (no read-only OSM-link footer) so it fits a fixed-height card. */
  thumbnail?: boolean;
};

/** What a map click does in editable mode. */
type DrawTarget = "pin" | "road" | "land" | "footprint";

/** Map-click router: in editable mode a click dispatches to whatever draw target is active. */
function DrawCatcher({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/** Offset a lat/lng by `meters` along a compass `bearing` (deg, 0=N, clockwise). Small-distance flat-earth
 * approximation — fine for a few-hundred-metre orientation cone. */
function offsetLatLng(lat: number, lng: number, bearing: number, meters: number): [number, number] {
  const R = 6378137; // earth radius (m)
  const rad = (bearing * Math.PI) / 180;
  const dLat = (meters * Math.cos(rad)) / R;
  const dLng = (meters * Math.sin(rad)) / (R * Math.cos((lat * Math.PI) / 180));
  return [lat + (dLat * 180) / Math.PI, lng + (dLng * 180) / Math.PI];
}

/** The building-FACING cone ( — "building facing should be a cone"). A translucent wedge drawn on
 * the map from the pin, pointing the way the building faces (`bearing`), spanning ±halfAngle. Because it's a
 * real geo polygon it rotates WITH the map, so the developer/agent literally sees the orientation. The sun
 * marks (sunrise ≈ due E, sunset ≈ due W — a sound approximation at Pattaya's tropical latitude) are drawn
 * as fixed E/W sun glyphs via the corner badge. */
function FacingCone({ lat, lng, bearing, meters = 120, halfAngle = 26 }: { lat: number; lng: number; bearing: number; meters?: number; halfAngle?: number }) {
  const pts: [number, number][] = [
    [lat, lng],
    offsetLatLng(lat, lng, bearing - halfAngle, meters),
    offsetLatLng(lat, lng, bearing, meters * 1.08),
    offsetLatLng(lat, lng, bearing + halfAngle, meters),
  ];
  return (
    <Polygon
      positions={pts}
      pathOptions={{ color: "#e0953a", weight: 1.5, fillColor: "#f0b24a", fillOpacity: 0.3, dashArray: "3 3" }}
      interactive={false}
    />
  );
}

/** Which site polygon a geoman layer represents (tagged on the layer so edits route back to the right field). */
type PolyKind = "land" | "footprint";
const POLY_STYLE: Record<PolyKind, L.PathOptions> = {
  land: { color: "#8a6d3b", weight: 2, fillColor: "#d9c38a", fillOpacity: 0.18, dashArray: "6 4" },
  footprint: { color: "#1a5fb4", weight: 2, fillColor: "#8fb8e8", fillOpacity: 0.35 },
};
/** Geoman's companion edit layers are INVISIBLE — they exist only to carry the drag handles. The actual
 * shape the user sees is the React <Polygon> underneath (fix: geoman owning the display dropped the
 * seeded land layer's stroke). Fully transparent so the two never double-render. */
const EDIT_LAYER_STYLE: L.PathOptions = { opacity: 0, fillOpacity: 0, weight: 0, interactive: true };

/** Geoman polygon editor (— "a tool to deep-zoom and draw perfectly"). In editable mode
 * geoman carries ONLY the drag HANDLES (draggable vertices, mid-edge add-points, drag-whole-shape, snapping,
 * all at any zoom) on INVISIBLE companion layers; the VISIBLE shape is the React <Polygon> rendered by the
 * parent in both modes. Every geoman create/edit/drag/remove re-reads BOTH layers and calls onChange, which
 * re-renders those React polygons live (fix — geoman used to own the display and dropped the seeded land
 * layer's stroke, leaving bare vertex dots). Pin + roads keep their own click flow (no vertex editing). */
function GeomanPolygons({
  land,
  footprint,
  activeKind,
  onChange,
}: {
  land: [number, number][];
  footprint: [number, number][];
  activeKind: PolyKind | null; // when "land"/"footprint", clicking draws THAT polygon
  onChange: (next: { land?: [number, number][]; footprint?: [number, number][] }) => void;
}) {
  const map = useMap();
  // The geoman layers we created, by kind, so we can read/replace them without touching others.
  const layersRef = useRef<Partial<Record<PolyKind, L.Polygon>>>({});
  // Latest onChange in a ref so geoman's long-lived event handlers always call the current one.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Read a geoman polygon layer back to a flat [lat,lng][] (outer ring only).
  function layerToPts(layer: L.Polygon): [number, number][] {
    const latlngs = layer.getLatLngs()[0] as L.LatLng[];
    return (latlngs ?? []).map((p) => [p.lat, p.lng] as [number, number]);
  }

  // Push BOTH layers' current coords up. Called after any geoman mutation.
  function emitAll() {
    const l = layersRef.current.land;
    const f = layersRef.current.footprint;
    onChangeRef.current({
      land: l ? layerToPts(l) : [],
      footprint: f ? layerToPts(f) : [],
    });
  }

  // ── One-time setup: seed existing polygons + wire global geoman events ──
  useEffect(() => {
    // Geoman vertex + draw-line styling FIRST (before any layer is seeded/enabled), so the markers are small
    const pmMap = (map as L.Map & { pm?: { setGlobalOptions?: (o: object) => void } }).pm;
    pmMap?.setGlobalOptions?.({
      markerStyle: { radius: 4, color: "#f5c518", fillColor: "#f5c518", fillOpacity: 1, weight: 1 },
      templineStyle: { color: "#f5c518", weight: 2 },
      hintlineStyle: { color: "#f5c518", weight: 2, dashArray: "4 4" },
      snappable: true,
      allowSelfIntersection: false,
    });

    // Seed a polygon layer for a kind if it has ≥3 points.
    function seed(kind: PolyKind, pts: [number, number][]) {
      if (pts.length < 3) return;
      const layer = L.polygon(pts, EDIT_LAYER_STYLE).addTo(map);
      // Tag the kind so create/remove events can route (geoman copies options onto its own layers).
      (layer as L.Polygon & { _pmKind?: PolyKind }).options = {
        ...(layer.options as L.PolylineOptions),
        pmKind: kind,
      } as L.PolylineOptions & { pmKind: PolyKind };
      layersRef.current[kind] = layer;
    }
    seed("land", land);
    seed("footprint", footprint);

    // When the user finishes DRAWING a new polygon, adopt it as whichever kind is active, replacing any
    // existing layer of that kind (one land + one footprint).
    function onCreate(ev: L.LeafletEvent) {
      const e = ev as unknown as { shape: string; layer: L.Layer };
      if (e.shape !== "Polygon") return;
      const kind = (activeKindRef.current ?? "land") as PolyKind;
      const prev = layersRef.current[kind];
      if (prev) map.removeLayer(prev);
      const layer = e.layer as L.Polygon;
      layer.setStyle(EDIT_LAYER_STYLE);
      (layer.options as L.PolylineOptions & { pmKind?: PolyKind }).pmKind = kind;
      layersRef.current[kind] = layer;
      emitAll();
    }
    function onRemove(ev: L.LeafletEvent) {
      const e = ev as unknown as { layer: L.Layer };
      const kind = (e.layer.options as L.PolylineOptions & { pmKind?: PolyKind }).pmKind;
      if (kind && layersRef.current[kind] === e.layer) delete layersRef.current[kind];
      emitAll();
    }
    // Vertex drag / mid-edge add / shape drag all fire pm:edit on the layer; also catch global edit/drag.
    function onEdit() {
      emitAll();
    }

    map.on("pm:create", onCreate);
    map.on("pm:remove", onRemove);
    map.on("pm:globaleditmodetoggled", onEdit);
    // Per-layer edits bubble to the map as pm:edit once editing completes.
    map.on("pm:edit", onEdit);
    // LIVE tracking: these fire continuously while a vertex / whole shape is being dragged, so the visible
    // React <Polygon> follows the handles in real time (the geoman companion layer itself is invisible).
    map.on("pm:markerdrag", onEdit);
    map.on("pm:markerdragend", onEdit);
    map.on("pm:drag", onEdit);

    return () => {
      map.off("pm:create", onCreate);
      map.off("pm:remove", onRemove);
      map.off("pm:globaleditmodetoggled", onEdit);
      map.off("pm:edit", onEdit);
      map.off("pm:markerdrag", onEdit);
      map.off("pm:markerdragend", onEdit);
      map.off("pm:drag", onEdit);
      for (const k of ["land", "footprint"] as PolyKind[]) {
        const lyr = layersRef.current[k];
        if (lyr) map.removeLayer(lyr);
      }
      layersRef.current = {};
    };
    // Setup runs once for the map instance; seeding uses the INITIAL polygons. Subsequent prop changes come
    // from our own onChange round-trip, so we must not re-seed (would fight the user's live geoman layers).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // Keep the active-kind available to the long-lived create handler without re-subscribing.
  const activeKindRef = useRef<PolyKind | null>(activeKind);
  activeKindRef.current = activeKind;

  // React to an externally CLEARED polygon (the "clear parcel/footprint" button sets the prop to []): remove
  // the geoman layer so it disappears. (Non-empty prop changes come from our own round-trip — ignore those.)
  useEffect(() => {
    const checks: [PolyKind, [number, number][]][] = [["land", land], ["footprint", footprint]];
    for (const [kind, pts] of checks) {
      if (pts.length === 0 && layersRef.current[kind]) {
        map.removeLayer(layersRef.current[kind]!);
        delete layersRef.current[kind];
      }
    }
  }, [land, footprint, map]);

  // Enable per-layer editing/dragging (vertices) always; the DRAW mode toggles with the active kind.
  useEffect(() => {
    // Make existing layers editable (draggable vertices + whole-shape drag), and RE-APPLY their stroke so the
    // polygon EDGE stays visible under the vertex markers (geoman can drop the original path style on enable).
    for (const k of ["land", "footprint"] as PolyKind[]) {
      const lyr = layersRef.current[k] as (L.Polygon & { pm?: { enable: (o?: object) => void }; setStyle?: (s: L.PathOptions) => void }) | undefined;
      lyr?.setStyle?.(EDIT_LAYER_STYLE);
      lyr?.pm?.enable({ allowSelfIntersection: false });
    }
    // Toggle DRAW mode: when a polygon kind is active, let the user draw a fresh one; else stop drawing.
    const pm = (map as L.Map & { pm?: { enableDraw: (s: string, o?: object) => void; disableDraw: () => void } }).pm;
    if (!pm) return;
    if (activeKind) pm.enableDraw("Polygon", { snappable: true, allowSelfIntersection: false });
    else pm.disableDraw();
    return () => pm.disableDraw();
  }, [activeKind, map]);

  return null;
}

export default function SitePlanMapInner({ geo, editable, onChange, height = 320, zoom = 16, theme, thumbnail }: SitePlanMapProps) {
  const [draft, setDraft] = useState<BuildingGeo>(geo);
  const [target, setTarget] = useState<DrawTarget>("pin");
  const g = editable ? draft : geo;

  // Resolve toolbar styling: host-supplied theme over the light defaults.
  const sIdle = { ...tabBtn, ...(theme?.tabIdle ?? null) };
  const sActive = { ...tabBtn, ...tabActive, ...(theme?.tabActive ?? null) };
  const sEdit = { ...editBtn, ...(theme?.editBtn ?? null) };
  const cMuted = theme?.mutedText ?? "#999";
  const cLabel = theme?.labelText ?? "#666";

  const center = useMemo<[number, number]>(() => [g.lat, g.lng], [g.lat, g.lng]);
  const roads = g.accessRoads ?? [];
  const land = g.landPolygon ?? [];
  const footprint = g.footprintPolygon ?? [];

  function emit(next: BuildingGeo) {
    setDraft(next);
    onChange?.(next);
  }

  // ── click routing ──
  function onMapClick(lat: number, lng: number) {
    if (target === "pin") return emit({ ...g, lat, lng });
    if (target === "road") return appendRoadPoint(lat, lng);
    if (target === "land") return emit({ ...g, landPolygon: [...land, [lat, lng]] });
    if (target === "footprint") return emit({ ...g, footprintPolygon: [...footprint, [lat, lng]] });
  }

  // ── roads (carried from LocationMap) ──
  function appendRoadPoint(lat: number, lng: number) {
    const rs = roads.slice();
    if (rs.length === 0) rs.push({ path: [] });
    rs[rs.length - 1] = { ...rs[rs.length - 1], path: [...rs[rs.length - 1].path, [lat, lng]] };
    emit({ ...g, accessRoads: rs });
  }
  function newRoad() {
    emit({ ...g, accessRoads: [...roads, { path: [] }] });
  }

  function undoRoadPoint() {
    if (roads.length === 0) return;
    const rs = roads.slice();
    const last = { ...rs[rs.length - 1], path: rs[rs.length - 1].path.slice(0, -1) };
    if (last.path.length === 0) rs.pop();
    else rs[rs.length - 1] = last;
    emit({ ...g, accessRoads: rs });
  }

  function setBearing(deg: number) {
    emit({ ...g, northBearing: ((deg % 360) + 360) % 360 });
  }

  const hasBearing = typeof g.northBearing === "number";

  return (
    <div>
      {/* Tone down Leaflet's default white chrome so it reads as unobtrusive dark text/controls over the
 satellite tiles. Attribution is license-required so we KEEP it — just make it tiny +
          low-contrast. The zoom +/− and layers-switch controls get a dark, subtle skin. */}
      <style>{`
        .leaflet-control-attribution {
          background: rgba(10,13,22,0.55); color: #8892a8; font-size: 9px; padding: 0 4px;
        }
        .leaflet-control-attribution a { color: #9aa4bf; }
        .leaflet-bar a, .leaflet-control-layers-toggle {
          background-color: rgba(14,17,25,0.82); color: #cfe0ff; border-color: #232a3b;
        }
        .leaflet-bar a:hover { background-color: rgba(26,37,64,0.9); }
        .leaflet-control-layers { background: rgba(14,17,25,0.92); color: #dfe5f5; border-color: #232a3b; }
      `}</style>
      <div style={{ height, borderRadius: 10, overflow: "hidden", border: "1px solid #ddd", position: "relative" }}>
        <MapContainer center={center} zoom={zoom} maxZoom={21} style={{ height: "100%", width: "100%" }} scrollWheelZoom={false}>
          {/* Satellite is the DEFAULT base (reads better for site plans); a street/satellite
              switch (LayersControl) lets the operator flip. OSM street caps ~19 native and
              upsamples to 21; Esri World Imagery (no key) goes ~19 native, upsamples to 21. */}
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

          {/* Polygons — the VISIBLE shape is ALWAYS a React <Polygon> (static fill + stroke), in BOTH modes.
              In editable mode geoman adds an INVISIBLE companion layer on top that owns ONLY the drag handles
              (vertices, mid-edge add-points, deep-zoom precision). Every geoman mutation flows back through
 onChange → these React polygons re-render live, so the edge is never lost (fix: geoman used
              to own the display and dropped the seeded land layer's stroke, leaving bare vertex dots). */}
          {land.length >= 3 && <Polygon positions={land} pathOptions={POLY_STYLE.land} interactive={false} />}
          {footprint.length >= 3 && <Polygon positions={footprint} pathOptions={POLY_STYLE.footprint} interactive={false} />}
          {editable && (
            <GeomanPolygons
              land={land}
              footprint={footprint}
              activeKind={target === "land" || target === "footprint" ? target : null}
              onChange={({ land: nl, footprint: nf }) =>
                emit({ ...g, landPolygon: nl ?? land, footprintPolygon: nf ?? footprint })
              }
            />
          )}

          {/* Building-facing cone — points the way the building faces (whenever an orientation is set). */}
          {hasBearing && <FacingCone lat={g.lat} lng={g.lng} bearing={g.northBearing as number} />}

          {/* The building pin */}
          <Marker
            position={center}
            icon={ICON}
            draggable={!!editable && target === "pin"}
            eventHandlers={
              editable && target === "pin"
                ? {
                    dragend(e: L.LeafletEvent) {
                      const p = (e.target as L.Marker).getLatLng();
                      emit({ ...g, lat: p.lat, lng: p.lng });
                    },
                  }
                : undefined
            }
          />

          {/* Access roads */}
          {roads.map((r, i) =>
            r.path.length >= 2 ? (
              <Polyline key={i} positions={r.path} pathOptions={{ color: "#1a7f3c", weight: 4, opacity: 0.8 }} />
            ) : r.path.length === 1 ? (
              <Marker key={i} position={r.path[0]} icon={ICON} />
            ) : null
          )}

          {editable && <DrawCatcher onClick={onMapClick} />}
        </MapContainer>

        {/* Orientation overlay — a small corner compass driven by northBearing (no date math; sunrise = E of
            north, sunset = W of north). Absolute over the map so it never blocks clicks. */}
        {hasBearing && <OrientationBadge bearing={g.northBearing as number} />}
      </div>

      {editable ? (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ color: cLabel, marginRight: 4 }}>Draw:</span>
            {(["pin", "road", "land", "footprint"] as DrawTarget[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTarget(t)}
                style={target === t ? sActive : sIdle}
              >
                {TARGET_LABEL[t]}
              </button>
            ))}
          </div>

          <p style={{ color: cMuted, margin: "6px 0", fontSize: 12 }}>{TARGET_HINT[target]}</p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            {target === "road" && (
              <>
                <button type="button" onClick={newRoad} style={sEdit}>+ new road</button>
                <button type="button" onClick={undoRoadPoint} style={sEdit}>undo point</button>
                <button type="button" onClick={() => emit({ ...g, accessRoads: [] })} style={sEdit}>clear roads</button>
              </>
            )}
            {target === "land" && (
              <>
                <button type="button" onClick={() => emit({ ...g, landPolygon: [] })} style={sEdit}>clear parcel</button>
                <span style={{ color: cMuted }}>{land.length} pts · drag a vertex to adjust, click to add</span>
              </>
            )}
            {target === "footprint" && (
              <>
                <button type="button" onClick={() => emit({ ...g, footprintPolygon: [] })} style={sEdit}>clear footprint</button>
                <span style={{ color: cMuted }}>{footprint.length} pts · drag a vertex to adjust, click to add</span>
              </>
            )}
            {target === "pin" && (
              <span style={{ color: cMuted }}>{g.lat.toFixed(5)}, {g.lng.toFixed(5)}</span>
            )}
          </div>

          {/* Orientation control — always available (independent of the draw target) */}
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ color: cLabel }}>Building faces (sun rises in the E ☀):</span>
            <input
              type="range"
              min={0}
              max={359}
              value={hasBearing ? (g.northBearing as number) : 0}
              onChange={(e) => setBearing(Number(e.target.value))}
              style={{ flex: "1 1 160px", minWidth: 120 }}
            />
            <span style={{ color: cLabel, minWidth: 96 }}>
              {hasBearing ? `${Math.round(g.northBearing as number)}° (${compass(g.northBearing as number)})` : "not set"}
            </span>
            {hasBearing && (
              <button type="button" onClick={() => emit({ ...g, northBearing: undefined })} style={sEdit}>clear</button>
            )}
          </div>
        </div>
      ) : thumbnail ? null : (
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
          {hasBearing && (
            <span style={{ color: "#777", marginLeft: 10 }}>· faces {compass(g.northBearing as number)}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** A compact compass badge: a north arrow rotated to the bearing + a sunrise(east)/sunset(west) label.
 * Sunrise is 90° clockwise from the building's facing north? No — we show true compass: the arrow points
 * to NORTH (so the map reader orients), and sun marks sit E/W of north. `bearing` is the direction the
 * building FACES; we annotate that below the compass. */
function OrientationBadge({ bearing }: { bearing: number }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 500,
        background: "rgba(255,255,255,0.9)",
        borderRadius: 8,
        border: "1px solid #ddd",
        padding: "6px 8px",
        textAlign: "center",
        pointerEvents: "none",
        fontSize: 11,
        color: "#555",
        lineHeight: 1.2,
      }}
    >
      <svg width="54" height="54" viewBox="0 0 54 54" style={{ display: "block", margin: "0 auto" }}>
        {/* Map north = up. Sunrise ☀ to the EAST (right), sunset ☾ to the WEST (left) — a sound approximation
            at this tropical latitude (the sun's bearing drifts only slightly across the year). */}
        <text x="44" y="31" fontSize="13">☀</text>
        <text x="2" y="31" fontSize="13">☾</text>
        <text x="46" y="42" fontSize="7" fill="#b8860b">E</text>
        <text x="4" y="42" fontSize="7" fill="#777">W</text>
        {/* North reference (thin, grey) so the reader orients the map. */}
        <g transform="translate(27,27)">
          <line x1="0" y1="0" x2="0" y2="-20" stroke="#aaa" strokeWidth="1" />
          <text x="-3" y="-21" fontSize="8" fill="#999">N</text>
          {/* FACING arrow (bold orange) — rotated to the direction the building faces. */}
          <g transform={`rotate(${bearing})`}>
            <polygon points="0,-18 5,2 0,-3 -5,2" fill="#e0953a" />
          </g>
        </g>
      </svg>
      <div style={{ marginTop: 2 }}>faces {compass(bearing)}</div>
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
  road: "🛣 road",
  land: "▱ land parcel",
  footprint: "▢ footprint",
};
const TARGET_HINT: Record<DrawTarget, string> = {
  pin: "Drag the pin to place the building.",
  road: "Click the map to trace an access road; “+ new road” starts another.",
  land: "Zoom in and click around the plot boundary to draw the land parcel. Then DRAG any vertex to fine-tune, or click a mid-edge dot to add a point.",
  footprint: "Zoom in and click around the building outline to draw its footprint. Then DRAG any vertex to fine-tune, or click a mid-edge dot to add a point.",
};

const editBtn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid #ccc",
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
const tabBtn: React.CSSProperties = {
  padding: "3px 9px",
  borderRadius: 14,
  border: "1px solid #ccc",
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
const tabActive: React.CSSProperties = {
  background: "#1a5fb4",
  color: "#fff",
  borderColor: "#1a5fb4",
};
