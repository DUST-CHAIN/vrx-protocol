// MM pack model — the in-memory authored state that exports to a VRX ingest-pack ZIP.
//
// TWO LAYERS in ONE model:
//   1. The TEXTUAL spine (developer -> companies -> complexes -> buildings -> unitTypes -> units + terms).
//      Maps 1:1 to ../ingest-pack/schema/{pack,building}.schema.json + unit.columns.md. This is what
//  slice-1's Structured-face UI edits, and what toZip emits.
//   2. The GEOMETRY-READY §4d "Russian-doll" spine (GeoNode tree). Every node MAY carry a footprint
//      (>= a point), a height, an sqm, and a PRICE — so the same objects are both geometry and priced
//      inventory. The drawing-board UI + matrix/3D projections are LATER slices; the fields exist NOW so
//  nothing needs re-modeling. See the design docs §4d.
//
// DERIVED-AND-ADJUSTED: a GeoNode holds the AUTHORED TRUTH. Per-view display tweaks live in a
// SEPARATE `overrides` channel keyed by view — a visual exaggeration (e.g. a taller 3D floor) must NEVER
// mutate the authored heightM/sqm that drive price. So price/area always read from the node, never a view.

import type { FloorLayouts } from "./floorplan-layout"; // hand-authored floor arrangement; type-only (no runtime cycle)

// ---------------------------------------------------------------------------
// §4d geometry primitives (present from day 1; UI comes in slice 2)
// ---------------------------------------------------------------------------

/** A footprint is at minimum a point; a rect for simple boxes; a polygon for L-shapes.
 *  A poly may carry FROZEN vertices/edges (right-click in the editor) — a frozen part holds still while
 * the rest is adjusted. Illustration-grade dimensioned editing, not a survey-exact CAD solver. */
export type Footprint =
  | { shape: "point" }
  | { shape: "rect"; rect: { x: number; y: number; w: number; h: number } }
  | {
      shape: "poly";
      points: Array<{ x: number; y: number }>;
      frozenVerts?: number[]; // vertex indices that never move
      frozenEdges?: number[]; // edge indices whose length is held (both ends pinned together)
      // METRE-NATIVE (D- metre-native step 5) — the shape's vertices in REAL METRES from the shape's own
      // min-corner origin (aspect TRUE by construction; the metres ARE in the points, no separate anchor walk).
      // This is the SOURCE OF TRUTH when present; `points` (0..1 self-norm) is the legacy derived view kept for
      // back-compat. `pointsM[i]` corresponds to `points[i]` 1:1. Absent on legacy blobs → readers derive it from
      // `points` × the metre anchor (lib/geo.ts toMetrePoly), so an un-migrated project behaves exactly as before.
      pointsM?: Array<{ x: number; y: number }>;
    };

/** A door/window/wall marker on a unit PLAN (illustration-grade). Lives on the SUBTYPE plan (shared by
 *  every unit of that subtype), drawn as SVG on the canvas — a door/window is NOT priced inventory, so it's a
 *  flat array, never a GeoNode. Points are 0..1 in the plan's own frame. All absent-safe. (Slice 5.) */
export type PlanMarker =
  | { kind: "door"; at: { x: number; y: number }; widthM?: number; facingDeg?: number }
  | { kind: "window"; at: { x: number; y: number }; widthM?: number }
  | { kind: "wall"; a: { x: number; y: number }; b: { x: number; y: number }; thickM?: number };

/** The canonical floor-plan of ONE unit SUBTYPE (type+subtype), authored once and shared across every placed
 * unit of that subtype (the design docs:126 — "plans belong to the VARIATION, not per-unit").
 *  The polygon is the irregular real shape; its area is CONSTRAINED to the subtype's declared sqm (the binding
 *  legal size), never free-resized. A placed unit GeoNode points here via `subtypeRef` and renders this shape;
 * only pose/status/price/area-scalars live per-instance. Everything absent-safe. */
export interface UnitPlan {
  footprint: Extract<Footprint, { shape: "poly" }>; // the authored irregular polygon (0..1 in the unit frame)
  markers?: PlanMarker[]; // doors/windows/walls — shared by every unit of the subtype (Slice 5)
  // (Slice 5) a TRACE-OVER backdrop: the architect's floor-plan image, shown DIM behind the plan so the author
  // can trace the real shape + place markers over it. Stored INLINE (base64 data URL) — it is REFERENCE ONLY,
  // never exported, never priced, so it deliberately does NOT go through the marketing pack.media[] slot system.
  backdrop?: { dataUrl: string; mime: string };
}

/** A node's pose RELATIVE to its parent (clamped to fit inside — "never protrude"). */
export interface Transform {
  x: number; // fraction/metre offset within parent
  y: number;
  scale: number; // default 1
  rotation: number; // degrees, default 0 — the EDITOR rotation (drawing convenience), NOT the geographic
  //                    bearing. Real-world north comes from SiteGeo.northBearingDeg; the two compose.
}

/**
 * GEOGRAPHIC truth captured on a land/site node from the map (slice 2.5, §6). The ONE principle:
 * the MAP is the geographic source of truth (center, parcel corners, north bearing, and the real metre scale
 * derived from the parcel's geographic extent) while the in-editor footprint is drawn/rotated INDEPENDENTLY.
 * At render, real-world north = `northBearingDeg` here, NOT `Transform.rotation` (editor-rotation ≠ geo-rotation).
 * All fields absent-safe — a node with no SiteGeo behaves exactly as before. lat/lng pairs match Leaflet order.
 */
export interface SiteGeo {
  centerLatLng?: [number, number]; // the site pin [lat, lng]
  landPolygon?: [number, number][]; // parcel boundary [lat,lng][] — its metre extent seeds the metre anchor
  footprintPolygon?: [number, number][]; // optional building outline traced on the map (reference only)
  northBearingDeg?: number; // 0..359, 0 = geographic north; kept SEPARATE from Transform.rotation
}

/**
 * A CAMERA / viewpoint placed INSIDE a node — "stand here, look that way, see this much". Position is
 * in the node's own 0..1 fraction frame (x,y within the room); `facingDeg` reuses the editor convention
 * (0 = up/top-of-frame, clockwise); `fovDeg` is the horizontal field of view (the cone's opening angle). The
 * canvas draws it as a pin + a view-cone (frustum); lib/geo turns it into an accurate-angle phrase for the AI
 * room-image prompt. All real-world refs stay implicit — nothing geographic here, just the interior pose.
 */
export interface Camera {
  x: number; // 0..1 within the node's frame — where the viewer stands
  y: number;
  facingDeg: number; // 0..359, editor space (0 = up, clockwise) — which way the viewer looks
  fovDeg: number; // horizontal field of view, degrees (clamped to a sane range in lib/geo)
}

/** Every priced object carries this — even an undrawn one ("TV 55\" • $X" is a point + a price). */
export interface NodePrice {
  amountUsd: number;
  label?: string; // e.g. 'TV 55"', 'Reservation fee'
}

export type GeoKind = "project" | "land" | "building" | "floor" | "unit" | "prop";

/** Sale status (the operator catalog real enum — MM_ENGINE_AND_FACES §4). The at-a-glance fill channel on a unit node.
 *  Labels/colours live in lib/geo.ts (a drawing-board concern); the type lives here so GeoNode can carry it. */
export type UnitStatus =
  | "available"
  | "reserved-minus"
  | "reserved-plus"
  | "sale-minus"
  | "sale-plus"
  | "blocked"
  | "resale";

/**
 * One node of the Russian-doll tree. Generalizes clipper's Region{id,name,rect,source...} from a single
 * frame to a RELATIVE-NESTED tree. Authored truth only — display tweaks go in Pack.overrides, not here.
 */
export interface GeoNode {
  id: string;
  name: string;
  kind: GeoKind;
  parentId?: string;
  transform?: Transform; // relative to parent; absent = not placed yet
  footprint?: Footprint; // >= a point
  // METRE ANCHOR (slice 2): a node may declare its real-world size in metres. Fractions nest underneath;
  // the nearest anchor at-or-above a node supplies the real scale, so m² = metre-anchor × nested fractions
  // (lib/geo.ts realMetres/deriveSqm). Only a few nodes (typically a building or floor) set this.
  metreW?: number; // real width in metres (authored truth)
  metreH?: number; // real depth in metres (authored truth)
  heightM?: number; // floors carry height -> 3D extrusion (authored truth, NOT a display value)
  sqm?: number; // AI-computed from the polygon when drawn; authored truth
  targetAreaSqm?: number; //  the AUTHORITATIVE title/record area this node should match — e.g. a land
  // parcel's deed area (Skyline = 1,808 m², 1 Rai 52 wah, the operator catalog 006_drt.sql complex id=2). The HUD shows
  // target-vs-drawn so the author aligns BY AREA even without the number at hand; snap-to-size (slice D)
  // scales the drawn shape to equal it. Baked into the model so it travels with export/import. Absent = no
  // known target (the free-authoring default — the HUD then shows only the drawn area). Back-compat.
  status?: UnitStatus; // units carry a sale status (the at-a-glance fill channel — the operator catalog grammar)
  price?: NodePrice; // ANY node may carry a price (rule 2)
  locked?: boolean; // GEOMETRY lock: when true the footprint can't be dragged/resized/vertex-edited —
  // "lock the shape when it's correct". Name/price/status stay editable. Absent = unlocked (back-compat).
  facingDeg?: number; // FACING vector: which way this node "looks", 0..359 in EDITOR space (0 = up/
  // top-of-frame, clockwise). POSE metadata, NOT footprint geometry — a locked SHAPE can still be re-faced;
  // kept SEPARATE from Transform.rotation (editor draw-rotation) AND SiteGeo.northBearingDeg (geographic north).
  // Feeds the camera/frustum arc (a camera needs a facing). Absent = unset (back-compat).
  deedImage?: { dataUrl: string; mime: string }; // (slice C) a LAND node's TITLE-DEED reference image — the
  // surveyed plot drawing the user traces the parcel over (the authority is the deed, not the map).
  // Drawn dim behind the land in its own focus view, like the unit-plan trace backdrop. Reference only, never
  // exported (it's a scan the author traces, not product data). Absent = no deed uploaded. Back-compat.
  siteGeo?: SiteGeo; // geographic truth from the map (land/site nodes, slice 2.5) — seeds the metre anchor
  camera?: Camera; // CAMERA/frustum: a placeable interior viewpoint (unit/floor rooms) — position +
  // facing + field-of-view — rendered as a pin + view-cone, and turned into an accurate-angle phrase that
  // enriches the AI room-image prompt (slotImagePrompt). POSE metadata, editable even when the shape is
  // locked (reuses the facing convention). Absent = no camera placed (back-compat).
  factoryName?: string; // AI/toolbar picks a factory NAME, never raw geometry (clipper bet)
  // source/mask/frame (clipper DNA) added when the richer drawing board lands (later slice).
  confirmed?: boolean; //  FLOOR approve-checkpoint: the author marked this floor's shape "good" → it SEEDS
  // the next floor up (once, if that floor is still an unshaped rect) + clears its "unconfirmed" badge. Soft/Law#1:
  // purely additive — never gates clicking ahead, never ripples lower-floor edits upward. Absent = not yet approved.
  approved?: boolean; // (D-) UNIT approve-gate: the author marked this unit's room shape "good" → it is
  // BROUGHT INTO the level plan (renders as its real shape in the level overview instead of a marker). Mirrors the
  // floor `confirmed` checkpoint. Soft/Law#1: purely additive, never gates navigation. Absent = draft (shown as a
  // marker on the level overview unless `representation` forces a shape). The seam between "draft room geometry just
  // imported" and "part of the official level plan".
  representation?: "marker" | "shape"; // (D-) UNIT display override on the LEVEL OVERVIEW: force this unit
  // to draw as a MARKER (a pin at its centre) or as its real SHAPE, regardless of the approve-gate. Absent = AUTO:
  // draw as a shape iff `approved`, else a marker. Lets a user toggle one unit marker⇄shape ("that would be cool",
  // ). Does NOT affect the FOCUSED unit (drilling into a unit always shows + edits its shape). Back-compat.
  subtypeRef?: { typeKey: string; subtypeKey: string }; //  the STABLE link from a placed unit node to its
  // SUBTYPE, so the shared UnitPlan can be resolved + the sqm kept equal to the subtype's declared size. Resolve
  // by this pair, NEVER by Unit.subtype (that holds a display LABEL — renaming a subtype would break resolution).
  // Absent = a standalone node that owns its own footprint (back-compat; the behaviour).
  rotationDeg?: number; //  a placed unit's ON-FLOOR rotation, 0..359 clockwise, about its own footprint
  // centre. PER-INSTANCE POSE (position-like) — NOT on the shared UnitPlan, so each unit of a subtype rotates
  // independently while all share one OUTLINE (the shared-shape/own-position model, D-). renderFootprint
  // applies it when placing the self-normalized shared shape into this unit's rect. Absent = 0 (back-compat).
  posLocked?: boolean; //  "Lock position on level": when true, this unit can't be TRANSLATED or ROTATED on
  // its floor (its placed pose is pinned). DISTINCT from `locked` (which locks the SHAPE / vertex-editing): a
  // position-locked unit can still have its shared plan re-shaped (that authors the subtype, not this instance's
  // pose), and a shape-locked unit can still be re-positioned. Absent = free to move (back-compat).
  posM?: { x: number; y: number }; // (kill-the-bbox arc Slice 2) the node's POSITION as real metres: where
  // its footprint's min-corner sits inside its PARENT, measured in PARENT metres from the parent's own min-corner.
  // The metre-native counterpart of the 0..1 bbox fraction (`cMin`) the self-norm frame used to derive position from.
  // Storing it explicitly means a shape edit no longer moves the node (the bbox fraction shifted when you dragged a
  // vertex; an explicit metre position doesn't) — the "manual tuning just works" target (D-). SHAPE truth is
  // `footprint.pointsM` (min-corner-origin metres); POSITION truth is this. Absent on legacy blobs → readers derive
  // it from `cMin × parentMetreExtent` (lib/geo.ts nodePosM), so an un-migrated project behaves exactly as before.
}

/** A per-view, non-destructive display override. NEVER read for price/area. */
export interface ViewOverride {
  nodeId: string;
  view: "matrix" | "plan" | "3d";
  // Only display-affecting fields; deliberately NOT heightM/sqm/price.
  transform?: Partial<Transform>;
  displayHeightM?: number; // e.g. exaggerate a floor in the 3D x-ray — display only
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// The TEXTUAL spine — mirrors ingest-pack/schema (keep in lockstep)
// ---------------------------------------------------------------------------

export interface Developer {
  id: string; // ^[a-z0-9-]+$
  name: string;
  holdingCompany?: string;
  nearAccount?: string;
  logo?: string;
  contact?: Record<string, unknown>; // PII — stays off-chain; not exported to chain
}

export interface Company {
  id: string;
  name: string;
  registration?: string;
}

export interface Complex {
  id: string;
  name: string;
  companyId?: string;
  area?: string;
  amenities?: string[];
  buildings: string[]; // building ids
}

export interface UnitType {
  key: string; // studio/1br/2br/shop/duplex/penthouse
  label: string;
  sqmMin: number;
  sqmMax: number;
  /** The layout VARIATIONS (the real units — each its own size/view/price). sqmMin/sqmMax DERIVE from these.
 * Optional + ignored by export/validate; carried so the Structured editor can edit the real units.. */
  subtypes?: import("./ai-build").AiUnitSubtype[];
  /** Vertical floors this unit occupies (default 1). span 2 = a DUPLEX. Optional + ignored by export/validate;
 * carried so the Structured paint grid knows to place a two-floor unit in one click.. */
  span?: number;
  /** "core" = structural PUBLIC SPACE (elevator/lobby/gym…) — occupies a cell but is NOT sellable inventory.
 * Optional + ignored by export/validate; carried so the Structured editor can mark it.. */
  kind?: "unit" | "core";
}

export interface Quota {
  sellableSqm?: number;
  foreignQuotaPct?: number; // default 49
  foreignSoldSqm?: number;
  foreignCommittedSqm?: number;
  localSoldSqm?: number;
  stage?: "presale" | "built" | "final";
  labels?: { freehold?: string; company?: string; private?: string };
}

export interface Building {
  id: string;
  name: string;
  complexId: string;
  companyId?: string;
  tagline?: string;
  developer?: string;
  area?: string;
  address?: string;
  type: string; // "High Rise" | "Low Rise" (free label in practice)
  stories: number;
  units?: number;
  completion?: string;
  constructionEnd?: string;
  reservationFeeUsd?: number;
  bookingDepositUsd?: number;
  maintenancePerSqmUsd?: number;
  sinkingFundPerSqmUsd?: number;
  transferFeePct?: string;
  amenities?: string[];
  unitTypes?: UnitType[];
  termsRef?: string;
  quota?: Quota;
}

/** One unit row — mirrors unit.columns.md (keep in lockstep). */
export interface Unit {
  id: string;
  type: string;
  subtype?: string; // the subtype's display LABEL (e.g. "Corner — sea view") — NOT a stable id; see subtypeKey
  subtypeKey?: string; //  the STABLE subtype key (a|b|c|std…) — the geo tree links units to the shared
  // subtype plan by {type, subtypeKey}, never by the label above. Optional + not a CSV column (carried in-pack).
  floor: number;
  unitNumber?: number;
  sqm: number;
  sqmBefore?: number;
  sqmAfter?: number;
  sqmFinal?: number;
  priceUsd: number;
  priceFreehold?: number;
  priceCompany?: number;
  view?: string;
  corner?: boolean;
  baths?: number;
  note?: string;
  termsRef?: string;
}

/** The AUTHORITATIVE size of a unit (m²), resolving the three area sources in legal-priority order:
 *  the Land-Office FINAL measurement if it has arrived, else the ARCHITECT's staged size, else the current
 *  `sqm` (which the subtype's declared size is baked into at build time). The VISUAL plan area (deriveSqm of
 *  the drawn polygon) is illustration-grade and NEVER prices — only these authored numbers do. One place so
 *  the most legally-correct number available flows into price + $/m² automatically as measurements arrive. */
export function unitSqm(u: Unit): number {
  return u.sqmFinal ?? u.sqmBefore ?? u.sqm;
}

/** Reusable PaymentTerms block (terms/<id>.json). Stored opaque to MM — we carry it, VRX interprets. */
export interface PaymentTerms {
  id: string;
  data: Record<string, unknown>;
}

/**
 * The whole authored state of one pack-in-progress. `buildingUnits` keys by building id -> its rows
 * (becomes each building's units.csv). `geo`/`overrides` are the §4d spine (unused by slice-1 UI).
 */
/** The domain re-skins labels/templates/archetypes; to the engine a unit is a unit (§2 Domain switch). */
export type Domain = "realestate" | "art" | "tickets";

export interface Pack {
  domain?: Domain; // project-scoped setting (default "realestate"); lives in project settings, not app chrome
  developer: Developer;
  companies: Company[];
  complexes: Complex[];
  buildings: Building[];
  buildingUnits: Record<string, Unit[]>; // buildingId -> units
  terms: PaymentTerms[];
  texts?: Record<string, string>; // free marketing/contract texts authored on the frame (law: always valid)
  // §4d geometry-ready spine (day-1 fields; drawing board is slice 2):
  geo?: GeoNode[];
  overrides?: ViewOverride[];
  // Marketing images. Source-agnostic MediaItem[] (upload now, Gemini-generated later). Empty slots
  // are placeholder-backfilled at EXPORT — the Pack only stores real (upload/generated) items. See lib/media.ts.
  media?: MediaItem[];
  // Hand-authored floor ARRANGEMENT. Keyed by floor signature (the ordered type:subtype mix) so floors
  // with the same mix share one layout. Per-unit along-axis offsets override the engine's auto-derived pins;
  // width stays size-computed. Optional (back-compat). See lib/floorplan-layout.ts.
  floorLayouts?: FloorLayouts;
}

/** Source of a stored image. "placeholder" is export-only backfill — never stored in pack.media[]. */
export type MediaSource = "upload" | "generated" | "placeholder";

/**
 * One stored marketing image. SOURCE-AGNOSTIC: an uploaded blob and a (future) Gemini-generated blob are the
 * same shape — the Gemini integration later just writes a MediaItem with source:"generated" (lib/media.ts).
 * Bytes live as base64 so the whole Pack stays plain-JSON serializable.
 */
export interface MediaItem {
  id: string;
  buildingId: string; // the (textual) building this image belongs to
  slotKey: string; // matches a MediaSlot.key within the building (lib/media.ts requiredSlots)
  source: MediaSource;
  mime: string; // image/jpeg | image/png | image/webp
  dataB64: string; // raw bytes, base64 (no data: prefix)
  caption?: string;
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

/** URL-safe id, matching the schema pattern ^[a-z0-9-]+$. */
export function slugify(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";
}

/** A fresh, minimal-but-valid-in-progress pack. Law #2: even empty, it can export (backfilled). */
export function emptyPack(developerName = "New Developer"): Pack {
  const id = slugify(developerName);
  return {
    domain: "realestate",
    developer: { id, name: developerName },
    companies: [],
    complexes: [],
    buildings: [],
    buildingUnits: {},
    terms: [],
    texts: {},
    geo: [],
    overrides: [],
  };
}

/** Total declared unit count across all buildings (for the validation rail / UI). */
export function totalUnits(pack: Pack): number {
  return Object.values(pack.buildingUnits).reduce((n, rows) => n + rows.length, 0);
}
