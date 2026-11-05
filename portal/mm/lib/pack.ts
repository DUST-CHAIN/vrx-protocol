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
    };

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
  status?: UnitStatus; // units carry a sale status (the at-a-glance fill channel — the operator catalog grammar)
  price?: NodePrice; // ANY node may carry a price (rule 2)
  siteGeo?: SiteGeo; // geographic truth from the map (land/site nodes, slice 2.5) — seeds the metre anchor
  factoryName?: string; // AI/toolbar picks a factory NAME, never raw geometry (clipper bet)
  // source/mask/frame (clipper DNA) added when the richer drawing board lands (later slice).
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
  subtype?: string;
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
