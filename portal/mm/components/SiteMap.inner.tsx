"use client";

// SiteMap INNER — the actual Leaflet map (react-leaflet 5). Client-only; always loaded via ./SiteMap
// (ssr:false). Captures the land node's geographic truth:
//   • pin        → siteGeo.centerLatLng          (drag, or "pin" draw click)
//   • parcel     → siteGeo.landPolygon           (click to add corners) → its metre bbox = the metre anchor
//   • north      → KNOWN from the map (north-up) — no manual bearing; the building's FACING is the real orientation
// Illustration-grade: click-to-add-corner + draggable pin (no geoman handles — the polygon editor owns
// precise footprint shaping). Reuses the portal's self-hosted marker icons (public/leaflet/) — no CDN request.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, LayersControl, Marker, Polygon, Polyline, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { SiteGeo, Footprint } from "@/lib/pack";
import { metreExtentFromLatLngPolygon, footprintToLatLngParcel } from "@/lib/geo";
import type { SiteMapChange } from "./SiteMap";

// basePath-aware asset prefix: the marker PNGs are root-absolute URLs that IGNORE Next's basePath, so under the
// static-export subpath ("/vrx/mm") a bare "/leaflet/…" 404s → broken-image marker. Prefix with the base (= "" in
// dev), same fix as the web-ifc WASM path in lib/ifc-browser.ts.
const ASSET_BASE = process.env.NEXT_PUBLIC_MM_BASE_PATH || "";
const ICON = L.icon({
  iconUrl: `${ASSET_BASE}/leaflet/marker-icon.png`,
  iconRetinaUrl: `${ASSET_BASE}/leaflet/marker-icon-2x.png`,
  shadowUrl: `${ASSET_BASE}/leaflet/marker-shadow.png`,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

// Default view when a node has no location yet — Pattaya (the the operator catalog beachhead), same as the portal's default.
const DEFAULT_CENTER: [number, number] = [12.9236, 100.8825];

// A draggable corner handle: a numbered light-blue dot (a divIcon so it can be a draggable Leaflet Marker —
// CircleMarker can't drag). The number shows the trace order; the whole dot is the grab target.
function cornerIcon(n: number): L.DivIcon {
  return L.divIcon({
    className: "mm-corner-handle",
    html: `<span>${n}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

type DrawTarget = "pin" | "parcel";

/** Leaflet sizes itself on mount; when its container grows (the expand modal), it keeps the old size and the
 *  tiles fill only a corner. Recompute on every `expanded` change (next frame, after the DOM has resized). */
// Keep the map sized to its container AND framed to the parcel. Recomputes on every `when` change (expand/
// collapse — the container resizes) and on mount: invalidateSize first (so Leaflet knows the real size),
// then fitBounds to the parcel so the land fills the view at any size. Also hands a `fit` callback
// up (via onReady) so the manual "fit to land" button can re-frame on demand.
function MapController({
  when,
  parcel,
  onReady,
}: {
  when: unknown;
  parcel: [number, number][];
  onReady?: (fit: () => void) => void;
}) {
  const map = useMap();
  const fit = useCallback(() => {
    if (parcel.length >= 2) {
      map.fitBounds(L.latLngBounds(parcel as L.LatLngExpression[]), { padding: [24, 24], animate: false });
    }
  }, [map, parcel]);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      map.invalidateSize();
      fit();
    });
    return () => cancelAnimationFrame(id);
  }, [map, when, fit]);
  useEffect(() => {
    onReady?.(fit);
  }, [onReady, fit]);
  return null;
}

// --- front-vector (FACING) on the map ---------------------------------------------------------
// A tip handle at distance `d` (deg) from an anchor, in a compass bearing (0 = N/up, clockwise). Flat-earth
// (illustration-grade): north steps lat, east steps lng/cos(lat). Pairs with bearingDeg (its inverse).
function tipLatLng(anchor: [number, number], bearingDeg: number, d: number): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = Math.cos(rad) * d;
  const dLng = (Math.sin(rad) * d) / Math.max(0.01, Math.cos((anchor[0] * Math.PI) / 180));
  return [anchor[0] + dLat, anchor[1] + dLng];
}
/** Compass bearing (0..359, 0 = N, clockwise) from anchor → point. The inverse of tipLatLng. */
function bearingDeg(anchor: [number, number], pt: [number, number]): number {
  const dLat = pt[0] - anchor[0];
  const dLng = (pt[1] - anchor[1]) * Math.cos((anchor[0] * Math.PI) / 180);
  const deg = (Math.atan2(dLng, dLat) * 180) / Math.PI; // atan2(east, north) → 0=N, clockwise
  return ((deg % 360) + 360) % 360;
}
/** Centroid of a lat/lng polygon (simple average — good enough to anchor the arrow). */
function polyCentroid(poly: [number, number][]): [number, number] | undefined {
  if (!poly.length) return undefined;
  const lat = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const lng = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return [lat, lng];
}
const FACING_TIP_ICON = L.divIcon({
  className: "mm-facing-tip",
  html: `<span></span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/** Map-click router: a click dispatches to whatever draw target is active. */
function ClickCatcher({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// Strong light-blue so the parcel reads clearly over satellite imagery. The filled polygon (≥3
// corners) and the open polyline (first 2 corners, before it closes) share the stroke so the drawing looks
// continuous as you click. A dark casing under the bright line keeps it legible over any tile colour.
const PARCEL_LINE = "#38bdf8";      // light blue (sky-400)
const PARCEL_CASING = "#0b1220";    // dark halo under the line
const PARCEL_STYLE: L.PathOptions = { color: PARCEL_LINE, weight: 3, fillColor: PARCEL_LINE, fillOpacity: 0.15 };
const PARCEL_CASING_STYLE: L.PathOptions = { color: PARCEL_CASING, weight: 6, opacity: 0.55, fill: false };

export default function SiteMapInner({
  value,
  onChange,
  height = 360,
  facingDeg,
  onFacingChange,
  footprint,
  metreW,
  metreH,
}: {
  value: SiteGeo | undefined;
  onChange: (change: SiteMapChange) => void;
  height?: number;
  // BUILDING-on-the-map mode: when onFacingChange is given, the map shows the land's parcel as
  // read-only CONTEXT and a draggable FRONT-vector arrow for the selected building, so you orient it against the
  // real streets. Parcel tracing is disabled in this mode (the parcel belongs to the land node).
  facingDeg?: number;
  onFacingChange?: (deg: number) => void;
  //  the land's ALREADY-DRAWN footprint + real metre size — "⬇ Place my drawn shape" projects it onto the
  // map at the pin so the user never re-traces a shape they already drew.
  footprint?: Footprint;
  metreW?: number;
  metreH?: number;
}) {
  const g = value ?? {};
  const facingMode = typeof onFacingChange === "function";
  const [target, setTarget] = useState<DrawTarget>(g.landPolygon?.length ? "pin" : "parcel");
  // Expand the cramped inspector map into a full-screen modal for comfortable tracing. The map
  // state is the same `value`/`onChange` either way — only the container size changes.
  const [expanded, setExpanded] = useState(false);
  // The MapController hands up its fitBounds callback so the manual "fit to land" button can re-frame on demand.
  const fitRef = useRef<(() => void) | null>(null);
  const handleFitReady = useCallback((fit: () => void) => { fitRef.current = fit; }, []);

  const center = useMemo<[number, number]>(() => g.centerLatLng ?? DEFAULT_CENTER, [g.centerLatLng]);
  const parcel = g.landPolygon ?? [];

  // Front-vector arrow geometry (building mode): anchor at the parcel centroid (else the pin/map centre), tip at
  // a fixed small distance in the current facing bearing. The arrow length scales with the parcel so it reads at
  // any zoom; a short default when there's no parcel.
  const facingAnchor = useMemo<[number, number]>(
    () => polyCentroid(parcel) ?? g.centerLatLng ?? center,
    [parcel, g.centerLatLng, center]
  );
  const facingLen = useMemo(() => {
    if (parcel.length >= 2) {
      const lats = parcel.map((p) => p[0]);
      const lngs = parcel.map((p) => p[1]);
      return Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs)) * 0.55 || 0.0006;
    }
    return 0.0006;
  }, [parcel]);
  const facingTip = useMemo<[number, number]>(
    () => tipLatLng(facingAnchor, facingDeg ?? 0, facingLen),
    [facingAnchor, facingDeg, facingLen]
  );

  // Emit a new SiteGeo + the recomputed metre extent of the parcel (what the land node adopts as its anchor).
  function emit(next: SiteGeo) {
    onChange({ siteGeo: next, metreExtent: metreExtentFromLatLngPolygon(next.landPolygon) });
  }

  // (D- metre-native step 3c) A RAW parcel-corner edit on the map (trace a corner, drag a corner, undo a
  // corner). Here the user is reshaping the RING DIRECTLY — the map becomes the source of truth for the shape
  // (D-), so the editor re-imports it (no preserveFootprint) AND we CLEAR `northBearingDeg`: a hand-edited ring
  // defines its own orientation by its geometry, so a stale placement bearing must not linger (else the editor→map
  // sync's rigid branch would re-project at that bearing and disagree with the ring the user just dragged). Bearing
  // is meaningful only for a place-drawn shape (set by placeDrawnShape); any manual ring edit resets it to north-up.
  function emitParcelEdit(landPolygon: [number, number][]) {
    emit({ ...g, landPolygon, northBearingDeg: 0 });
  }

  //  Project the land's ALREADY-DRAWN footprint onto the map as the parcel, centred at `at`. The user drew
  // the accurate shape in the editor — they should NOT re-trace it here; drop the pin, the shape lands + can be
  // dragged/rotated. `bearingDeg` 0 = the drawn "up" points north; corner-drag then fine-tunes on the map.
  const canPlaceDrawn = !!footprint && (metreW ?? 0) > 0 && (metreH ?? 0) > 0;
  // (D- metre-native step 3c) The placed ring is a DERIVED VIEW of the editor's metre shape — NOT a new source
  // of truth. We persist the rotation in `northBearingDeg` (the schema field for exactly this) and emit with
  // `preserveFootprint` so the return leg (setSiteGeo) records the geography WITHOUT re-importing the rotated ring
  // through latLngPolygonToFootprint (which would re-normalize it per-axis and distort the shape — the drift).
  // The editor metre footprint + northBearingDeg stay the one truth; footprintToLatLngParcel re-derives the ring.
  function placeDrawnShape(at: [number, number], bearing = g.northBearingDeg ?? 0) {
    const ring = footprintToLatLngParcel(footprint, metreW, metreH, at, bearing);
    if (ring) {
      onChange({
        siteGeo: { ...g, centerLatLng: at, landPolygon: ring, northBearingDeg: bearing },
        preserveFootprint: true,
      });
    }
  }

  function onMapClick(lat: number, lng: number) {
    if (target === "pin") {
      // first pin drop with a drawn shape + no parcel yet → auto-PLACE the drawn shape (#3). Otherwise just
      // move the pin (don't silently reshape a parcel the user is already tuning).
      if (canPlaceDrawn && !(parcel.length >= 3)) return placeDrawnShape([lat, lng]);
      return emit({ ...g, centerLatLng: [lat, lng] });
    }
    if (target === "parcel") return emitParcelEdit([...parcel, [lat, lng]]);
  }

  // Undo the last traced corner — easy to misplace a point, so this is the reflex action.
  // Exposed as a button AND a keyboard shortcut (Ctrl/⌘-Z or Backspace) while the parcel target is active.
  function undoCorner() {
    if (parcel.length) emitParcelEdit(parcel.slice(0, -1));
  }

  // Move an already-placed corner by dragging it (a misplaced point was previously unfixable except
  // by undo). Replaces corner `i` with the dragged lat/lng, keeping all the others.
  function moveCorner(i: number, lat: number, lng: number) {
    const next = parcel.map((c, j) => (j === i ? ([lat, lng] as [number, number]) : c));
    emitParcelEdit(next);
  }

  useEffect(() => {
    if (target !== "parcel") return;
    function onKey(e: KeyboardEvent) {
      // don't hijack typing in a field
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const isUndo = (e.key === "z" && (e.ctrlKey || e.metaKey)) || e.key === "Backspace";
      if (isUndo) {
        e.preventDefault();
        undoCorner();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, parcel.length, g]);

  const extent = metreExtentFromLatLngPolygon(parcel);
  // In the expanded modal the map fills most of the viewport; inline it uses the `height` prop.
  const mapHeight = expanded ? "min(78vh, 900px)" : height;

  return (
    <div
      style={
        expanded
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 4000,
              background: "rgba(5,7,12,0.82)",
              backdropFilter: "blur(2px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            }
          : undefined
      }
      onClick={expanded ? (e) => { if (e.target === e.currentTarget) setExpanded(false); } : undefined}
    >
      <div
        style={
          expanded
            ? {
                width: "min(1100px, 94vw)",
                maxHeight: "94vh",
                overflow: "auto",
                background: "var(--frame-bg, #0e1626)",
                border: "1px solid var(--line, #334155)",
                borderRadius: 14,
                padding: 16,
                boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
              }
            : undefined
        }
      >
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
        /* draggable FRONT-vector tip handle (building mode) */
        .mm-sitemap .mm-facing-tip { cursor: grab; }
        .mm-sitemap .mm-facing-tip:active { cursor: grabbing; }
        .mm-sitemap .mm-facing-tip span {
          display: block; width: 16px; height: 16px; margin: 3px; border-radius: 50%;
          background: #ffd166; border: 2px solid #0b1220; box-shadow: 0 1px 4px rgba(0,0,0,0.6);
        }
        /* draggable numbered corner handles on the parcel trace */
        .mm-sitemap .mm-corner-handle { cursor: grab; }
        .mm-sitemap .mm-corner-handle:active { cursor: grabbing; }
        .mm-sitemap .mm-corner-handle span {
          display: flex; align-items: center; justify-content: center;
          width: 18px; height: 18px; border-radius: 50%;
          background: #38bdf8; color: #0b1220; border: 2px solid #fff;
          font-size: 10px; font-weight: 700; line-height: 1;
          box-shadow: 0 1px 4px rgba(0,0,0,0.6);
        }
      `}</style>

      <div className="mm-sitemap" style={{ height: mapHeight, borderRadius: 10, overflow: "hidden", border: "1px solid var(--line, #334155)", position: "relative" }}>
        {/* Expand / collapse the map into a full-screen modal for comfortable tracing. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Close full-screen map" : "Expand map full-screen"}
          style={{
            position: "absolute", top: 8, right: 52, zIndex: 500,
            background: "rgba(14,17,25,0.9)", color: "#cfe0ff", border: "1px solid #232a3b",
            borderRadius: 8, padding: "4px 9px", cursor: "pointer", fontSize: 12, lineHeight: 1.2,
          }}
        >
          {expanded ? "✕ close" : "⤢ expand"}
        </button>
        {/* Manual re-frame: snap the view back to the land parcel. */}
        {parcel.length >= 2 && (
          <button
            type="button"
            onClick={() => fitRef.current?.()}
            title="Fit the view to the land parcel"
            style={{
              position: "absolute", top: 8, right: expanded ? 120 : 128, zIndex: 500,
              background: "rgba(14,17,25,0.9)", color: "#cfe0ff", border: "1px solid #232a3b",
              borderRadius: 8, padding: "4px 9px", cursor: "pointer", fontSize: 12, lineHeight: 1.2,
            }}
          >
            ⊡ fit land
          </button>
        )}
        <MapContainer center={center} zoom={16} maxZoom={21} style={{ height: "100%", width: "100%" }} scrollWheelZoom={expanded}>
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

          {/* Parcel boundary. ≥3 corners → a closed filled polygon; exactly 2 → an open line so the second
              click already shows an edge; a dark casing underneath keeps the bright line legible on any tile. */}
          {parcel.length >= 3 && (
            <>
              <Polygon positions={parcel} pathOptions={PARCEL_CASING_STYLE} interactive={false} />
              <Polygon positions={parcel} pathOptions={PARCEL_STYLE} interactive={false} />
            </>
          )}
          {parcel.length === 2 && (
            <>
              <Polyline positions={parcel} pathOptions={PARCEL_CASING_STYLE} interactive={false} />
              <Polyline positions={parcel} pathOptions={PARCEL_STYLE} interactive={false} />
            </>
          )}

          {/* Corner handles — visible from the FIRST click, numbered in trace order, and DRAGGABLE so a
 misplaced point can be nudged into place. Drag updates that corner's lat/lng.
              Hidden in facing mode (the parcel is the land's read-only context there). */}
          {target === "parcel" && !facingMode &&
            parcel.map((c, i) => (
              <Marker
                key={`corner-${i}`}
                position={c}
                icon={cornerIcon(i + 1)}
                draggable
                eventHandlers={{
                  dragend(e: L.LeafletEvent) {
                    const p = (e.target as L.Marker).getLatLng();
                    moveCorner(i, p.lat, p.lng);
                  },
                }}
              />
            ))}

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

          {/* FRONT-vector arrow (building mode): a draggable arrow from the building's anchor in the facing
 bearing — orient the building against the real streets. Dragging the tip sets facingDeg. */}
          {facingMode && (
            <>
              <Polyline positions={[facingAnchor, facingTip]} pathOptions={{ color: PARCEL_CASING, weight: 7, opacity: 0.5 }} interactive={false} />
              <Polyline positions={[facingAnchor, facingTip]} pathOptions={{ color: "#ffd166", weight: 3 }} interactive={false} />
              <Marker
                position={facingTip}
                icon={FACING_TIP_ICON}
                draggable
                eventHandlers={{
                  dragend(e: L.LeafletEvent) {
                    const p = (e.target as L.Marker).getLatLng();
                    onFacingChange?.(Math.round(bearingDeg(facingAnchor, [p.lat, p.lng])));
                  },
                }}
              />
            </>
          )}

          {!facingMode && <ClickCatcher onClick={onMapClick} />}
          <MapController when={expanded} parcel={parcel} onReady={handleFitReady} />
        </MapContainer>

        <NorthBadge />
      </div>

      {/* Toolbar */}
      <div style={{ marginTop: 8, fontSize: 13, color: "var(--text, #e2e8f0)" }}>
        {/* Building (facing) mode: no parcel tracing — just the front-vector readout + how-to. */}
        {facingMode && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ color: "#ffd166", fontWeight: 700 }}>▸ Front</span>
            <span style={{ color: "var(--text, #e2e8f0)" }}>{Math.round(facingDeg ?? 0)}° ({compass16Local(facingDeg ?? 0)})</span>
            <span style={{ color: "var(--muted, #94a3b8)" }}>— drag the yellow arrow to point the building&apos;s front at the street.</span>
          </div>
        )}

        {!facingMode && (
        <>
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
            <>
              <span style={{ color: "var(--muted, #94a3b8)" }}>
                {g.centerLatLng ? `${g.centerLatLng[0].toFixed(5)}, ${g.centerLatLng[1].toFixed(5)}` : "click the map to drop the pin"}
              </span>
              {/*  place/redo the drawn shape as the parcel — no re-tracing. Shows when the land has a drawn
                  footprint + a real metre size; places at the pin (or map-centre default if no pin yet). */}
              {canPlaceDrawn && (
                <button
                  type="button"
                  onClick={() => placeDrawnShape(g.centerLatLng ?? center)}
                  title="Put the shape you already drew onto the map at the pin — then drag its corners to fine-tune. No need to re-trace."
                  style={{ ...sEdit, border: "1px solid #38bdf8", background: "rgba(56,189,248,0.12)", color: "#9bd8fb", fontWeight: 600 }}
                >
                  {parcel.length >= 3 ? "⟲ Re-place my drawn shape" : "⬇ Place my drawn shape"}
                </button>
              )}
            </>
          )}
          {target === "parcel" && (
            <>
              <button
                type="button"
                onClick={undoCorner}
                disabled={!parcel.length}
                title="Remove the last corner (Ctrl/⌘-Z or Backspace)"
                style={{ ...sEdit, ...(parcel.length ? sUndo : { ...sEdit, opacity: 0.45, cursor: "default" }) }}
              >
                ↶ undo corner
              </button>
              <button type="button" onClick={() => emit({ ...g, landPolygon: [] })} disabled={!parcel.length} style={{ ...sEdit, ...(parcel.length ? {} : { opacity: 0.45, cursor: "default" }) }}>clear parcel</button>
              <span style={{ color: "var(--muted, #94a3b8)" }}>
                {parcel.length} corner{parcel.length === 1 ? "" : "s"}
                {extent ? ` · ${extent.w.toFixed(0)} × ${extent.h.toFixed(0)} m` : ""}
              </span>
            </>
          )}
        </div>
        </>
        )}

        {/* North is KNOWN from the map: a web map is north-up, so geographic north is simply "up" —
            there's nothing to set manually. Read-only note; the building's FRONT vector (which way it faces) is the
            real orientation to author, and it lives on the building node (the FACING control / its on-map arrow). */}
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "var(--muted, #94a3b8)" }}>
          <span style={{ color: "#38bdf8", fontWeight: 700 }}>↑ N</span>
          <span>North is up on the map — taken from the geography automatically.</span>
        </div>
      </div>
      </div>
    </div>
  );
}

/** 16-point compass label for the front-vector bearing (0 = N). */
function compass16Local(deg: number): string {
  const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** A fixed north badge — a web map is north-up, so north always points up. No bearing to set. */
function NorthBadge() {
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
      <svg width="34" height="34" viewBox="0 0 54 54" style={{ display: "block", margin: "0 auto" }}>
        <g transform="translate(27,27)">
          <polygon points="0,-18 5,2 0,-3 -5,2" fill="#38bdf8" />
          <text x="-3" y="-20" fontSize="9" fill="#cfe0ff">N</text>
        </g>
      </svg>
    </div>
  );
}

const TARGET_LABEL: Record<DrawTarget, string> = {
  pin: "📍 pin",
  parcel: "▱ land parcel",
};
const TARGET_HINT: Record<DrawTarget, string> = {
  pin: "Click the map (or drag the pin) to place the site centre.",
  parcel: "Click around the plot boundary to trace the land parcel. Misplaced a corner? Press Ctrl/⌘-Z or Backspace (or ↶ undo corner). Its size sets the real metre scale for the drawing board.",
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
// A prominent undo (the reflex action while tracing) — light-blue accent to match the parcel line.
const sUndo: React.CSSProperties = {
  border: "1px solid #38bdf8",
  background: "rgba(56,189,248,0.12)",
  color: "#9bd8fb",
  fontWeight: 600,
};
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
  // use the `border` SHORTHAND (not `borderColor`) so toggling sIdle↔sActive doesn't mix shorthand + longhand on
  // the same element (React warns: removing borderColor while a border shorthand is set).
  border: "1px solid var(--accent, #0d9488)",
};
