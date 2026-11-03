// The AUTHORED PROJECT TREE — the ONE shared authored truth (the design docs).
//
// Supersedes the four-islands architecture: developer → complex → buildings[], with ONE active building the
// per-building flows/view-modes edit. Pack becomes the EXPORT PROJECTION of this (lib/project-pack.ts, stage 2);
// this module is the authored truth + its PURE helpers. React-free so it unit-tests with no DOM.
//
// A building's SHAPE+MATRIX reuses the existing BuildingAuthoring grid vocabulary UNCHANGED (lib/authoring.ts):
// the grid logic (emptyGrid/resizeGrid/autoFillTypes/fillColumn/authoringSummary/toUnits/toSpec) already exists
// and is tested — an AuthoredBuilding simply CARRIES a BuildingAuthoring-shaped grid + its tree context + the
// sparse per-unit detail overlay + floor layouts + media/texts/money. See §3 of the design doc.

import type { AuthoringType, UnitCell, BuildingAuthoring } from "./authoring";
import { emptyGrid, defaultTypes, resizeGrid } from "./authoring";
import type { Unit, MediaItem, Quota, GeoNode, ViewOverride } from "./pack";
import type { FloorLayouts } from "./floorplan-layout";
import { slugify } from "./pack";

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** The owner company. Reusable: saved/loaded as a template so it isn't re-entered each session. */
export interface AuthoredDeveloper {
  id: string;
  name: string;
  holdingCompany?: string;
  nearAccount?: string;
  companyDetails?: string; // free text pasted in flow 2 (registration / address / contact prose)
  logo?: string;
  contact?: Record<string, unknown>; // PII — stays off-chain (Pack.Developer.contact); carried, never exported to chain
}

/** A legal/selling company under the developer. Mirrors Pack.Company (id · name · registration). A complex may
 *  point at one via AuthoredComplex.companyId; a building may override it via AuthoredBuilding.companyId. These
 *  live at the PROJECT ROOT (not inside the developer) so the companyId references resolve 1:1 to Pack. */
export interface AuthoredCompany {
  id: string;
  name: string;
  registration?: string;
}

/** A reusable payment-terms block (terms/<id>.json). Opaque to MM — carried verbatim, VRX interprets it.
 *  Mirrors Pack.PaymentTerms; a building references one via AuthoredBuilding.termsRef. Project-root so refs resolve. */
export interface AuthoredPaymentTerms {
  id: string;
  data: Record<string, unknown>;
}

/** A development/complex — a plot of land holding one or more buildings. A project now holds N of these
 *  (Stage 3c-iii); mirrors Pack.Complex. Carries the land plot + centre pin (flow 2) and its buildings. */
export interface AuthoredComplex {
  id: string;
  name: string;
  companyId?: string; // the owning company (→ one of AuthoredProject.companies); mirrors Pack.Complex.companyId
  area?: string;
  amenities?: string[];
  land?: ComplexLand;
  buildings: AuthoredBuilding[];
}

/** The geographic truth for the complex (flow 2). Mirrors pack.ts SiteGeo, lifted to the complex. */
export interface ComplexLand {
  centerLatLng?: [number, number]; // the site pin [lat, lng]
  landPolygon?: [number, number][]; // parcel boundary [lat,lng][]
  northBearingDeg?: number; // 0..359, 0 = geographic north
}

/** A building node — the thing the flows author, duplicate, and export as self-contained JSON. */
export interface AuthoredBuilding {
  id: string;
  name: string;
  companyId?: string; // overrides the complex's owning company for this building (mirrors Pack.Building.companyId)
  type?: string; // "High Rise" | "Low Rise" (free label — mirrors Pack.Building.type; projection defaults it)
  area?: string;
  address?: string;
  tagline?: string;
  completion?: string; // completion blurb (Pack.Building.completion)
  constructionEnd?: string; // YYYY-MM-DD (Pack.Building.constructionEnd)
  transferFeePct?: string; // e.g. "6.30%" (Pack.Building.transferFeePct)
  amenities?: string[]; // building-level amenities (distinct from the complex's)
  quota?: Quota; // foreign-ownership quota block (Pack.Building.quota) — opaque, carried verbatim
  // shape — the matrix exists the moment floors × unitsPerFloor is known
  floors: number;
  unitsPerFloor: number;
  floorAreaM2?: number;
  declaredTotalUnits?: number; // what the user SAYS (verify vs computed; red on mismatch) ↔ Pack.Building.units
  // the type palette + the MATRIX (= the existing BuildingAuthoring.grid, unchanged)
  types: AuthoringType[];
  matrix: UnitCell[][];
  // sparse per-unit DETAIL overlay (flow 3 CSV / manual edits), keyed by a stable cell id (floor*100+slot)
  unitOverrides?: Record<string, Partial<Unit>>;
  // geometry / floor plans (unchanged)
  floorLayouts?: FloorLayouts;
  // presentation + money
  media?: MediaItem[];
  /** per image-slot DESCRIPTION (keyed by MediaSlot.key) — the prompt/caption for that image, editable even before
 * an image exists (so the future AI-generate button has something to work).. */
  slotCaptions?: Record<string, string>;
  texts?: Record<string, string>;
  reservationFeeUsd?: number;
  bookingDepositUsd?: number;
  maintenancePerSqmUsd?: number;
  sinkingFundPerSqmUsd?: number;
  termsRef?: string;
}

export type Domain = "realestate" | "art" | "tickets";

/** The store's root — the whole authored tree + which complex/building is active.
 *  Stage 3c-iii: the project holds N complexes. The ACTIVE pointer is a single `activeBuildingId`; the active
 *  complex is DERIVED as the one containing that building (a building belongs to exactly one complex, so no
 *  second active pointer — and thus no sync invariant to keep). Companies, payment terms, developer contact, and
 *  the full building field set live at the project root so the Structured shell maps onto the store LOSSLESSLY.
 * ⚠ MIGRATION: pre-3c-iii blobs carry a singleton `complex` (not `complexes[]`); hydrate upgrades them. */
export interface AuthoredProject {
  v: 1; // schema version (future migrations). complexes[] + geo/overrides added as back-compatible
  //  shape changes — hydrate upgrades a legacy `complex` singleton, so no stored-blob discard / version bump.
  domain: Domain;
  developer: AuthoredDeveloper;
  companies: AuthoredCompany[]; // project-root (so complex/building companyId refs resolve 1:1 to Pack)
  complexes: AuthoredComplex[]; // N developments; each holds its own buildings (Stage 3c-iii)
  terms: AuthoredPaymentTerms[]; // project-root reusable payment-terms blocks (building.termsRef points here)
  activeBuildingId: string; // the active complex is the one containing this building (derived, not stored)
  // The DURABLE §4d geometry (Studio drawing board) — Stage 3c-iv. ONE flat Russian-doll tree at project root:
  // project → land → building → floor → unit → prop (lib/pack.ts GeoNode, parentId chains). This models exactly
  // what stated — a project has ONE land; the land holds one or more BUILDINGS, each with its own footprint
  // inside it — in a single structure, so no per-building split is needed (a node's building is its ancestry).
  // Before 3c-iv these edits lived in a session-only overlay in usePackStore and were lost on reload; now they
  // persist to the store + round-trip through Pack (projectToPackAll reads geo; packToProject recovers it).
  geo?: GeoNode[];
  overrides?: ViewOverride[]; // per-view display tweaks (NEVER read for price/area — authored truth is in geo)
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** A fresh, blank-but-valid building node from a shape. Grid is empty (void slots) + the default palette. */
export function newBuilding(init: Partial<AuthoredBuilding> = {}): AuthoredBuilding {
  const floors = init.floors ?? 10;
  const unitsPerFloor = init.unitsPerFloor ?? 6;
  return {
    id: init.id || "building",
    name: init.name ?? "Building A",
    companyId: init.companyId,
    type: init.type,
    area: init.area,
    address: init.address,
    tagline: init.tagline,
    completion: init.completion,
    constructionEnd: init.constructionEnd,
    transferFeePct: init.transferFeePct,
    amenities: init.amenities,
    quota: init.quota,
    floors,
    unitsPerFloor,
    floorAreaM2: init.floorAreaM2 ?? 1100,
    declaredTotalUnits: init.declaredTotalUnits,
    types: init.types ?? defaultTypes(),
    matrix: init.matrix ?? emptyGrid(floors, unitsPerFloor),
    unitOverrides: init.unitOverrides,
    floorLayouts: init.floorLayouts,
    media: init.media,
    texts: init.texts,
    reservationFeeUsd: init.reservationFeeUsd,
    bookingDepositUsd: init.bookingDepositUsd,
    maintenancePerSqmUsd: init.maintenancePerSqmUsd,
    sinkingFundPerSqmUsd: init.sinkingFundPerSqmUsd,
    termsRef: init.termsRef,
  };
}

/** A fresh project tree with one blank developer, one blank complex, and one active building. */
export function newProject(init: Partial<AuthoredProject> = {}): AuthoredProject {
  const complexes: AuthoredComplex[] = init.complexes ?? [
    { id: "development", name: "New Development", buildings: [newBuilding()] },
  ];
  return {
    v: 1,
    domain: init.domain ?? "realestate",
    developer: init.developer ?? { id: "new-developer", name: "New Developer" },
    companies: init.companies ?? [],
    complexes,
    terms: init.terms ?? [],
    activeBuildingId: init.activeBuildingId || complexes[0]?.buildings[0]?.id || "",
  };
}

/** A fresh, blank-but-valid complex (one default building) with a unique id against `used`. PURE. */
export function newComplex(init: Partial<AuthoredComplex> = {}, used: Set<string> = new Set()): AuthoredComplex {
  const id = uniqueSlug(slugify(init.id || init.name || "development"), used);
  return {
    id,
    name: init.name ?? "New Development",
    companyId: init.companyId,
    area: init.area,
    amenities: init.amenities,
    land: init.land,
    buildings: init.buildings ?? [newBuilding()],
  };
}

/** Upgrade a legacy singleton-`complex` blob (pre-3c-iii) to the `complexes[]` shape. Idempotent — a project that
 *  already has `complexes` passes through. Returns a well-formed AuthoredProject (back-compat for hydrate). PURE. */
export function migrateProject(raw: unknown): AuthoredProject | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || !p.developer) return null;
  // already new shape
  if (Array.isArray(p.complexes)) {
    if (!p.complexes.length) return null;
    return p as unknown as AuthoredProject;
  }
  // legacy: a single `complex` object → wrap it in complexes[]
  const legacy = p.complex as AuthoredComplex | undefined;
  if (!legacy || !Array.isArray(legacy.buildings)) return null;
  const { complex: _drop, ...rest } = p as Record<string, unknown> & { complex?: unknown };
  return { ...(rest as object), complexes: [legacy] } as unknown as AuthoredProject;
}

// ---------------------------------------------------------------------------
// Active-complex / active-building access + immutable updates (pure — the store wraps these in setState)
// ---------------------------------------------------------------------------

/** Every building across every complex, flat (handy for lookups that don't care which complex). PURE. */
export function allBuildings(p: AuthoredProject): AuthoredBuilding[] {
  return p.complexes.flatMap((c) => c.buildings);
}

/** The complex that CONTAINS the active building (the single source of "which complex is active" — no separate
 *  pointer, so no sync invariant). Falls back to the first complex when the active id resolves nowhere. PURE. */
export function activeComplex(p: AuthoredProject): AuthoredComplex | undefined {
  return p.complexes.find((c) => c.buildings.some((b) => b.id === p.activeBuildingId)) ?? p.complexes[0];
}

/** The complex that contains a given building id (or undefined). PURE. */
export function complexOfBuilding(p: AuthoredProject, buildingId: string): AuthoredComplex | undefined {
  return p.complexes.find((c) => c.buildings.some((b) => b.id === buildingId));
}

/** The currently-active building (within the active complex; falls back to that complex's first). PURE. */
export function activeBuilding(p: AuthoredProject): AuthoredBuilding | undefined {
  const cx = activeComplex(p);
  if (!cx) return undefined;
  return cx.buildings.find((b) => b.id === p.activeBuildingId) ?? cx.buildings[0];
}

/** Map one complex by id via an updater. Returns a NEW project. PURE. */
function mapComplex(
  p: AuthoredProject,
  complexId: string,
  fn: (c: AuthoredComplex) => AuthoredComplex
): AuthoredProject {
  return { ...p, complexes: p.complexes.map((c) => (c.id === complexId ? fn(c) : c)) };
}

/** Replace the active building via an updater. Returns a NEW project (immutable). PURE. */
export function updateActiveBuilding(
  p: AuthoredProject,
  fn: (b: AuthoredBuilding) => AuthoredBuilding
): AuthoredProject {
  const activeId = activeBuilding(p)?.id;
  if (!activeId) return p;
  return updateBuildingById(p, activeId, fn);
}

/** Replace a building BY ID via an updater, wherever it lives (searches every complex). Returns a NEW project.
 *  PURE. The Structured shell edits whichever building the tree selected, which may differ from the active one. */
export function updateBuildingById(
  p: AuthoredProject,
  id: string,
  fn: (b: AuthoredBuilding) => AuthoredBuilding
): AuthoredProject {
  return {
    ...p,
    complexes: p.complexes.map((c) =>
      c.buildings.some((b) => b.id === id)
        ? { ...c, buildings: c.buildings.map((b) => (b.id === id ? fn(b) : b)) }
        : c
    ),
  };
}

/** Add a fresh building to a complex (defaults to the active complex) with a project-unique id. Returns the new
 *  project + the new building's id so the caller can select it. PURE. Ids are unique across ALL complexes so the
 *  flat Pack projection never collides. */
export function addBuilding(
  p: AuthoredProject,
  init: Partial<AuthoredBuilding> = {},
  complexId?: string
): { project: AuthoredProject; id: string } {
  const cxId = complexId ?? activeComplex(p)?.id;
  const cx = p.complexes.find((c) => c.id === cxId);
  if (!cx) return { project: p, id: "" };
  const used = new Set(allBuildings(p).map((b) => b.id));
  const base = slugify(init.name || init.id || "building");
  const id = uniqueSlug(base, used);
  const b = newBuilding({ ...init, id, name: init.name ?? "New building", companyId: init.companyId ?? cx.companyId });
  return {
    project: { ...mapComplex(p, cx.id, (c) => ({ ...c, buildings: [...c.buildings, b] })), activeBuildingId: id },
    id,
  };
}

/** Remove a building by id (wherever it lives); re-point the active building to a survivor (or "") if the removed
 *  one was active. PURE. */
export function removeBuilding(p: AuthoredProject, id: string): AuthoredProject {
  const next = {
    ...p,
    complexes: p.complexes.map((c) => ({ ...c, buildings: c.buildings.filter((b) => b.id !== id) })),
  };
  const activeBuildingId = p.activeBuildingId === id ? (allBuildings(next)[0]?.id || "") : p.activeBuildingId;
  return { ...next, activeBuildingId };
}

/** Move a building to a different complex (by ids). The active pointer follows it. No-op if either id is unknown
 *  or the building is already there. PURE. (The Structured BuildingForm exposes this via a "Complex" dropdown.) */
export function moveBuildingToComplex(p: AuthoredProject, buildingId: string, toComplexId: string): AuthoredProject {
  const from = complexOfBuilding(p, buildingId);
  if (!from || from.id === toComplexId) return p;
  const b = from.buildings.find((x) => x.id === buildingId);
  const dest = p.complexes.find((c) => c.id === toComplexId);
  if (!b || !dest) return p;
  return {
    ...p,
    complexes: p.complexes.map((c) => {
      if (c.id === from.id) return { ...c, buildings: c.buildings.filter((x) => x.id !== buildingId) };
      if (c.id === dest.id) return { ...c, buildings: [...c.buildings, b] };
      return c;
    }),
    activeBuildingId: p.activeBuildingId === buildingId ? buildingId : p.activeBuildingId,
  };
}

// ---- complexes (N; Stage 3c-iii) ----

/** Add a fresh complex (with one default building) with a project-unique id. Returns the new project + the new
 *  complex id AND the new building's id so the caller can select straight into it. PURE. */
export function addComplex(
  p: AuthoredProject,
  init: Partial<AuthoredComplex> = {}
): { project: AuthoredProject; id: string; buildingId: string } {
  const usedCx = new Set(p.complexes.map((c) => c.id));
  const usedB = new Set(allBuildings(p).map((b) => b.id));
  // de-dup the default building's id against every existing building (not just this complex's)
  const base = init.buildings ?? [newBuilding({ id: uniqueSlug("building", usedB) })];
  const buildings = base.map((b) => ({ ...b, id: uniqueSlug(slugify(b.id || b.name || "building"), usedB) }));
  for (const b of buildings) usedB.add(b.id);
  const cx = newComplex({ ...init, buildings }, usedCx);
  return {
    project: { ...p, complexes: [...p.complexes, cx], activeBuildingId: cx.buildings[0]?.id || p.activeBuildingId },
    id: cx.id,
    buildingId: cx.buildings[0]?.id || "",
  };
}

/** Patch a complex's scalar fields by id (merges; buildings untouched). PURE. */
export function patchComplex(p: AuthoredProject, id: string, patch: Partial<AuthoredComplex>): AuthoredProject {
  return mapComplex(p, id, (c) => ({ ...c, ...patch, buildings: c.buildings }));
}

/** Remove a complex by id (and its buildings). Guarded: never removes the LAST complex (a project always has at
 *  least one). Re-points the active building to a survivor complex's first building if needed. PURE. */
export function removeComplex(p: AuthoredProject, id: string): AuthoredProject {
  if (p.complexes.length <= 1) return p; // can't delete the only development
  const complexes = p.complexes.filter((c) => c.id !== id);
  const stillLive = complexes.some((c) => c.buildings.some((b) => b.id === p.activeBuildingId));
  const activeBuildingId = stillLive ? p.activeBuildingId : (complexes[0]?.buildings[0]?.id || "");
  return { ...p, complexes, activeBuildingId };
}

// ---- companies (project-root; complex/building companyId refs point here) ----

/** Add a company with a unique id. Returns the new project + the id. PURE. */
export function addCompany(p: AuthoredProject, init: Partial<AuthoredCompany> = {}): { project: AuthoredProject; id: string } {
  const used = new Set(p.companies.map((c) => c.id));
  const id = uniqueSlug(slugify(init.id || init.name || "company"), used);
  const c: AuthoredCompany = { id, name: init.name ?? "New company", registration: init.registration };
  return { project: { ...p, companies: [...p.companies, c] }, id };
}

/** Patch a company by id (merges). PURE. */
export function patchCompany(p: AuthoredProject, id: string, patch: Partial<AuthoredCompany>): AuthoredProject {
  return { ...p, companies: p.companies.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

/** Remove a company by id. PURE. (Does not scrub dangling companyId refs — they degrade gracefully at projection.) */
export function removeCompany(p: AuthoredProject, id: string): AuthoredProject {
  return { ...p, companies: p.companies.filter((c) => c.id !== id) };
}

// ---- payment terms (project-root; building.termsRef points here) ----

/** Add a payment-terms block with a unique id + empty data. Returns the new project + the id. PURE. */
export function addTerms(p: AuthoredProject, init: Partial<AuthoredPaymentTerms> = {}): { project: AuthoredProject; id: string } {
  const used = new Set(p.terms.map((t) => t.id));
  const id = uniqueSlug(slugify(init.id || "terms"), used);
  const t: AuthoredPaymentTerms = { id, data: init.data ?? {} };
  return { project: { ...p, terms: [...p.terms, t] }, id };
}

/** Replace a terms block's data by id, UPSERTING if it doesn't exist yet. A building's default payment plan is
 *  SYNTHESIZED by the projection (assembleBuildingPack), so it isn't in p.terms until the user edits it — on that
 * first edit we materialise it into the store (else the edit silently vanishes). PURE.. */
export function patchTerms(p: AuthoredProject, id: string, data: Record<string, unknown>): AuthoredProject {
  if (p.terms.some((t) => t.id === id))
    return { ...p, terms: p.terms.map((t) => (t.id === id ? { ...t, data } : t)) };
  return { ...p, terms: [...p.terms, { id, data }] };
}

/** Remove a terms block by id. PURE. */
export function removeTerms(p: AuthoredProject, id: string): AuthoredProject {
  return { ...p, terms: p.terms.filter((t) => t.id !== id) };
}

// ---- durable §4d geo (Studio drawing board; project-root flat tree) ----

/** Replace the project's geo tree (and optionally its view overrides). Empty arrays are stored as undefined so a
 *  cleared board serializes small. PURE. The adapter funnels every Studio edit (useGeo → setPack) through here. */
export function setGeo(p: AuthoredProject, geo: GeoNode[], overrides?: ViewOverride[]): AuthoredProject {
  return {
    ...p,
    geo: geo.length ? geo : undefined,
    overrides: overrides && overrides.length ? overrides : p.overrides,
  };
}

/** A slug that doesn't collide with `used` — appends -2, -3, … until free. PURE. */
export function uniqueSlug(base: string, used: Set<string>): string {
  const b = base || "item";
  if (!used.has(b)) return b;
  for (let n = 2; ; n++) {
    const candidate = `${b}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Patch a building's scalar fields; if floors/unitsPerFloor change, the matrix is resized preserving overlap. */
export function patchBuilding(b: AuthoredBuilding, patch: Partial<AuthoredBuilding>): AuthoredBuilding {
  const merged = { ...b, ...patch };
  const shapeChanged =
    (patch.floors != null && patch.floors !== b.floors) ||
    (patch.unitsPerFloor != null && patch.unitsPerFloor !== b.unitsPerFloor);
  if (!shapeChanged) return merged;
  // reuse the authoring grid resizer (it reads {floors, unitsPerFloor, grid})
  const resized = resizeGrid({ floors: merged.floors, unitsPerFloor: merged.unitsPerFloor, grid: merged.matrix } as never);
  // prune any unit override whose cell no longer exists on the smaller grid (R5)
  const overrides = merged.unitOverrides ? pruneOverrides(merged.unitOverrides, merged.floors, merged.unitsPerFloor) : undefined;
  return { ...merged, matrix: resized, unitOverrides: overrides };
}

/** The stable cell id for a slot (floor is 1-based; slot 0-based) — matches toUnits' unitNumber convention. */
export function cellId(floor: number, slotIndex: number): string {
  return String(floor * 100 + slotIndex + 1);
}

/** Drop overrides pointing at slots that no longer exist after a grid shrink. PURE. */
export function pruneOverrides(
  overrides: Record<string, Partial<Unit>>,
  floors: number,
  unitsPerFloor: number
): Record<string, Partial<Unit>> | undefined {
  const live: Record<string, Partial<Unit>> = {};
  for (let f = 1; f <= floors; f++) {
    for (let s = 0; s < unitsPerFloor; s++) {
      const id = cellId(f, s);
      if (overrides[id]) live[id] = overrides[id];
    }
  }
  return Object.keys(live).length ? live : undefined;
}

// ---------------------------------------------------------------------------
// Computed shape facts (shown pre-detail, flow 2)
// ---------------------------------------------------------------------------

/** Total SLOTS in the matrix (floors × unitsPerFloor) — available before any type is assigned. */
export function totalSlots(b: AuthoredBuilding): number {
  return Math.max(0, Math.floor(b.floors)) * Math.max(0, Math.floor(b.unitsPerFloor));
}

// ---------------------------------------------------------------------------
// Adapter to/from the existing BuildingAuthoring grid shape (lib/authoring.ts)
// ---------------------------------------------------------------------------
// The /studio-ai grid form is written against BuildingAuthoring. Rather than rewrite that whole surface in one
// slice, we PROJECT the active building (+ its tree context) to a BuildingAuthoring, let the form edit that, and
// fold the result back. This keeps the proven grid UI + its pure ops working while the store becomes the truth.

/** Project an AuthoredBuilding (+ developer/complex names) into the BuildingAuthoring the grid form edits. PURE.
 *  The complex name comes from the complex that CONTAINS the building (falls back to the active complex). */
export function toAuthoring(p: AuthoredProject, b: AuthoredBuilding): BuildingAuthoring {
  const cx = complexOfBuilding(p, b.id) ?? activeComplex(p);
  return {
    developerName: p.developer.name,
    complexName: cx?.name ?? "",
    buildingName: b.name,
    area: b.area,
    premiumView: undefined,
    floors: b.floors,
    floorAreaM2: b.floorAreaM2 ?? 1100,
    unitsPerFloor: b.unitsPerFloor,
    types: b.types,
    grid: b.matrix,
  };
}

/** Fold a BuildingAuthoring edit back onto the building node (grid → matrix, shape + types + name/area). PURE.
 *  developer/complex names are tree-level and written separately via patchDeveloper/patchComplex. */
export function fromAuthoring(b: AuthoredBuilding, a: BuildingAuthoring): AuthoredBuilding {
  const shapeChanged = a.floors !== b.floors || a.unitsPerFloor !== b.unitsPerFloor;
  const overrides = shapeChanged && b.unitOverrides
    ? pruneOverrides(b.unitOverrides, a.floors, a.unitsPerFloor)
    : b.unitOverrides;
  return {
    ...b,
    name: a.buildingName,
    area: a.area,
    floors: a.floors,
    floorAreaM2: a.floorAreaM2,
    unitsPerFloor: a.unitsPerFloor,
    types: a.types,
    matrix: a.grid,
    unitOverrides: overrides,
  };
}
