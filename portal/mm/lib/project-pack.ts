// The ROUND-TRIP between the authored truth (AuthoredProject) and the export projection (Pack).
// the design docs §3b, stage 2. PURE + React-free → heavily unit-testable.
//
//   projectToPack(project) → Pack        the single EXPORT projection (folds in assembleBuildingPack)
//   packToProject(pack)    → AuthoredProject   the NEW back-converter (recovers the grid from a pack's units)
//   specToProject(spec, project)         the AI path: an AiBuildingSpec → an authored building in the tree
//
// WHY three: Stage 1 made AuthoredBuilding the TRUTH; Pack is a projection. So the AI flow generates into the
// AUTHORED model (specToProject) and we only project to Pack at export (projectToPack). packToProject exists for
// importing an EXTERNAL pack/ZIP back into the editor (the grid must be recoverable — it's the missing direction).

import type { Pack, Unit, UnitType, Complex } from "./pack";
import type { AiBuildingSpec, AiUnitType } from "./ai-build";
import { assembleBuildingPack } from "./ai-build";
import type { AuthoringType, UnitCell } from "./authoring";
import { emptyGrid, toSpec, toUnits } from "./authoring";
import {
  type AuthoredProject, type AuthoredBuilding, type AuthoredComplex,
  newProject, newBuilding, toAuthoring, allBuildings, complexOfBuilding, activeComplex,
} from "./project";
import { slugify } from "./pack";
import { hydrateGeoMetres } from "./geo";

// ---------------------------------------------------------------------------
// projectToPack — the export projection (authored truth → the flat Pack)
// ---------------------------------------------------------------------------

/** Project ONE building of an AuthoredProject into a complete, exportable Pack (the single-building EXPORT
 *  contract). Finds the building in whatever complex holds it; uses the existing assembleBuildingPack with the
 *  authored grid's EXPLICIT units (full fidelity). PURE. */
export function projectToPack(p: AuthoredProject, buildingId?: string): Pack {
  const b = buildingId ? allBuildings(p).find((x) => x.id === buildingId) : allBuildings(p)[0];
  const cx = b ? (complexOfBuilding(p, b.id) ?? activeComplex(p)) : activeComplex(p);
  if (!b) return overlayTree(assembleBuildingPack(emptySpec(p)).pack, p, undefined, cx);
  const a = toAuthoring(p, b);
  const spec: AiBuildingSpec = { ...toSpec(a), premiumView: undefined };
  const explicit = applyOverrides(toUnits(a), b.unitOverrides);
  const { pack } = assembleBuildingPack(spec, explicit);
  // "No data preloaded": an UNAUTHORED building (empty matrix — no painted cells) projects to ZERO
  // units, not a fabricated demo mix. assembleBuildingPack fabricates from the type palette × stories when given no
  // explicit units (the AI/spec path wants that); the authored-grid path does NOT — an empty grid means the user
  // hasn't placed any units yet, so the tree/preview must honestly show none. (The AI path stacks a real matrix via
  // specToProject, so it still carries its units; this only blanks a building no one has authored.)
  const hasPainted = (b.matrix || []).some((row) => row.some((c) => !!c && !!c.typeKey));
  if (!hasPainted && pack.buildings[0]) {
    const bId = pack.buildings[0].id;
    pack.buildingUnits[bId] = [];
    pack.buildings[0].units = 0;
  }
  return overlayTree(pack, p, b, cx);
}

/** Overlay the AUTHORED tree data (companies · terms · developer contact · the OWNING complex's identity + fields
 *  · the full building field set · media · layouts · texts · domain) onto the spec-assembled pack, so projectToPack
 *  is LOSSLESS for everything the Structured shell authors — the assembler only fabricates identity/company/terms,
 * which the authored values REPLACE when present. PURE (mutates only the freshly-assembled pack)..
 *  `src` is the authored complex that OWNS this building (so its real id/name win — see the id note below). */
function overlayTree(pack: Pack, p: AuthoredProject, b: AuthoredBuilding | undefined, src?: AuthoredComplex): Pack {
  // developer identity — the authored values WIN (the assembler only synthesizes a name/id from the spec).
  // holdingCompany/nearAccount/logo were NOT being carried, so the Developer form's edits to them silently vanished
  // on re-projection (the fields looked un-editable). Carry them now so the form round-trips.
  if (p.developer.contact) pack.developer.contact = p.developer.contact;
  if (p.developer.holdingCompany !== undefined) pack.developer.holdingCompany = p.developer.holdingCompany;
  if (p.developer.nearAccount !== undefined) pack.developer.nearAccount = p.developer.nearAccount;
  if (p.developer.logo !== undefined) pack.developer.logo = p.developer.logo;
  // companies — authored list wins when present (else keep the assembler's synthesized one)
  if (p.companies.length) pack.companies = p.companies.map((c) => ({ id: c.id, name: c.name, registration: c.registration }));
  // the owning complex. with N complexes the assembler's name-derived id can COLLIDE across complexes (two
  // developments sharing a name) and doesn't match the authored id — so we now set the AUTHORED id+name here and
  // re-point building.complexId to match (both sides rewritten together → the ref stays valid, no dangle). The
  //  "don't rewrite cx.id" warning only held while id was overwritten on ONE side; here it's consistent.
  const cx = pack.complexes[0];
  if (cx) {
    if (src) { cx.id = src.id; cx.name = src.name; }
    cx.companyId = src?.companyId ?? cx.companyId;
    cx.area = src?.area ?? cx.area;
    cx.amenities = src?.amenities ?? cx.amenities;
  }
  // the building's full authored field set (the spec path only reconstructs a subset)
  const bld = pack.buildings[0];
  if (bld && cx) bld.complexId = cx.id; // keep the building pointed at the (now authored-id) complex
  //  FIX (the "Loading building…" freeze): pin the projected building id to the STABLE authored/store id.
  // The assembler derives bld.id from slugify(name), so it CHANGED on every keystroke in the Name field → the
  // tree selection (holding the old projected id) dangled for a render → the Editor showed "Loading building…".
  // With the id pinned to the store id, typing a name no longer moves the id, so the selection stays valid.
  // (buildingUnits is keyed by the pack building id, so re-key it to match.) This also makes the adapter's
  // projected→store id map an identity for buildings.
  if (bld && b && bld.id !== b.id) {
    const oldId = bld.id;
    const units = pack.buildingUnits[oldId];
    delete pack.buildingUnits[oldId];
    bld.id = b.id;
    if (units) pack.buildingUnits[b.id] = units;
    // re-point every reference to the old projected id so nothing dangles (validation checks these):
    //  • the complex's building-id list (complex.buildings) · the schematic geo building node + its parentId chain.
    if (cx) cx.buildings = cx.buildings.map((bid) => (bid === oldId ? b.id : bid));
    const oldGeoBldId = `${oldId}-bld`;
    const newGeoBldId = `${b.id}-bld`;
    if (pack.geo?.length) {
      pack.geo = pack.geo.map((n) =>
        n.id === oldGeoBldId ? { ...n, id: newGeoBldId }
        : n.parentId === oldGeoBldId ? { ...n, parentId: newGeoBldId }
        : n
      );
    }
  }
  if (bld && b) {
    bld.companyId = b.companyId ?? bld.companyId;
    bld.type = b.type ?? bld.type;
    bld.area = b.area ?? bld.area;
    bld.address = b.address ?? bld.address;
    bld.tagline = b.tagline ?? bld.tagline;
    bld.completion = b.completion ?? bld.completion;
    bld.constructionEnd = b.constructionEnd ?? bld.constructionEnd;
    bld.transferFeePct = b.transferFeePct ?? bld.transferFeePct;
    if (b.amenities) bld.amenities = b.amenities;
    if (b.quota) bld.quota = b.quota;
    if (b.declaredTotalUnits != null) bld.units = b.declaredTotalUnits;
    bld.reservationFeeUsd = b.reservationFeeUsd ?? bld.reservationFeeUsd;
    bld.bookingDepositUsd = b.bookingDepositUsd ?? bld.bookingDepositUsd;
    bld.maintenancePerSqmUsd = b.maintenancePerSqmUsd ?? bld.maintenancePerSqmUsd;
    bld.sinkingFundPerSqmUsd = b.sinkingFundPerSqmUsd ?? bld.sinkingFundPerSqmUsd;
    if (b.termsRef) bld.termsRef = b.termsRef;
  }
  // payment terms — authored blocks win when present (else keep the assembler's synthesized standard block)
  if (p.terms.length) pack.terms = p.terms.map((t) => ({ id: t.id, data: t.data }));
  if (b?.media?.length) pack.media = [...(pack.media || []), ...b.media];
  if (b?.floorLayouts) pack.floorLayouts = b.floorLayouts;
  if (b?.texts) pack.texts = { ...(pack.texts || {}), ...b.texts };
  // durable §4d geo tree + view overrides (3c-iv) — project-root, so it rides every projection path. The Studio
  // drawing board reads/writes pack.geo; authored truth is the store's p.geo (projectToPackAll keeps it, not the
  // per-building merge — a project has ONE geo tree spanning land → buildings → floors → units).
  if (p.geo?.length) pack.geo = p.geo;
  // (D- metre-native step 5c) LAZY-HYDRATE un-migrated footprints with their stored metres now that a resolved
  // Pack exists (toMetrePoly/realMetres need the tree — migrateProject can't, it runs pre-Pack: the 5a finding).
  // hydrateGeoMetres is NON-MUTATING → p.geo (the store's authored truth) is never edited in place; a fresh geo
  // array is produced only when something hydrated, else the same reference flows through untouched.
  if (pack.geo?.length) pack.geo = hydrateGeoMetres(pack);
  if (p.overrides?.length) pack.overrides = p.overrides;
  pack.domain = p.domain;
  return pack;
}

/** Project the WHOLE tree — every building in every complex — into one Pack. The Structured shell's tree shows all
 *  complexes + buildings, so the adapter needs a multi-complex / multi-building Pack (projectToPack, the EXPORT
 *  projection, stays single-building by its contract — export is one building). Builds each building's pack via the
 *  single-building path (which overlays that building's OWNING complex), then merges: buildings[]/buildingUnits/
 *  media accumulate; developer/companies/terms/geo are project-root/shared and come from the first. pack.complexes[]
 *  gets ONE entry per authored complex (from each complex's first building's projection, or a synthesized empty
 * shell for a 0-building complex), each listing its own building ids. PURE. → (N complexes). */
export function projectToPackAll(p: AuthoredProject): Pack {
  const buildings = allBuildings(p);
  if (buildings.length === 0) {
    // Empty tree → an empty pack (no fabricated building). projectToPack would synthesize a placeholder building
    // from emptySpec; the adapter's tree must show ZERO buildings, so strip them + carry empty complex shells.
    const pack = projectToPack(p);
    return {
      ...pack,
      buildings: [],
      buildingUnits: {},
      complexes: p.complexes.map((c) => emptyComplexShell(c)),
    };
  }
  // Seed from the first building's full projection (carries developer, companies, terms, geo, domain + its complex).
  const base = projectToPack(p, buildings[0].id);
  // Merge each additional building's projection onto the base. Each building's projection synthesizes its OWN
  // per-building standard terms block (id "<buildingId>-standard") that its termsRef points at — so we must carry
  // every building's terms across, de-duped by id, or the 2nd+ building's termsRef dangles (validation error).
  const termIds = new Set(base.terms.map((t) => t.id));
  const cxById = new Map<string, Complex>();
  for (const c of base.complexes) cxById.set(c.id, c);
  for (let i = 1; i < buildings.length; i++) {
    const next = projectToPack(p, buildings[i].id);
    const nb = next.buildings[0];
    if (!nb) continue;
    base.buildings.push(nb);
    base.buildingUnits[nb.id] = next.buildingUnits[nb.id] || [];
    for (const t of next.terms) if (!termIds.has(t.id)) { base.terms.push(t); termIds.add(t.id); }
    if (next.media?.length) base.media = [...(base.media || []), ...next.media];
    // collect this building's owning complex (its projection carries the authored-id complex via overlayTree)
    for (const c of next.complexes) if (!cxById.has(c.id)) cxById.set(c.id, c);
    // geo/overrides are PROJECT-ROOT (p.geo), carried once by `base`'s overlayTree — do NOT re-merge per building
    // (every building's projection re-applies the same p.geo, so merging would duplicate the whole tree).
    if (next.texts) base.texts = { ...(base.texts || {}), ...next.texts };
  }
  // One pack complex per AUTHORED complex, in authored order (including any 0-building complex the loop never saw).
  base.complexes = p.complexes.map((c) => cxById.get(c.id) ?? emptyComplexShell(c));
  // Point each complex at its own buildings (group by the building's complexId).
  for (const c of base.complexes) c.buildings = base.buildings.filter((b) => b.complexId === c.id).map((b) => b.id);
  return base;
}

/** A Pack Complex shell for an authored complex that has NO buildings yet (so the tree still shows it). PURE. */
function emptyComplexShell(c: AuthoredComplex): Complex {
  return { id: c.id, name: c.name, companyId: c.companyId, area: c.area, amenities: c.amenities, buildings: [] };
}

/** Apply the sparse per-unit overrides onto the grid-derived units, keyed by unitNumber (the cell id). PURE. */
function applyOverrides(units: Unit[], overrides?: Record<string, Partial<Unit>>): Unit[] {
  if (!overrides) return units;
  return units.map((u) => {
    const ov = u.unitNumber != null ? overrides[String(u.unitNumber)] : undefined;
    return ov ? { ...u, ...ov } : u;
  });
}

function emptySpec(p: AuthoredProject): AiBuildingSpec {
  return { developerName: p.developer.name, complexName: activeComplex(p)?.name ?? "Development", buildingName: "Building", stories: 1, unitTypes: [] };
}

// ---------------------------------------------------------------------------
// specToProject — the AI path (an AiBuildingSpec → an authored building in the tree)
// ---------------------------------------------------------------------------

/** Turn an AI spec into an AuthoredProject: the tree identity from the spec, the type palette from its unitTypes,
 *  and a matrix stacked from each type's perFloor count across the stories (the same stacking assembleBuildingPack
 *  uses, but as the AUTHORED grid so the result opens editable). PURE. */
export function specToProject(spec: AiBuildingSpec, base?: AuthoredProject): AuthoredProject {
  const floors = Math.max(1, Math.floor(spec.stories));
  const types = spec.unitTypes.map(aiTypeToAuthoring);
  const unitsPerFloor = Math.max(1, spec.unitTypes.reduce((n, t) => n + Math.max(0, Math.floor(t.perFloor || 0)), 0));
  const matrix = stackMatrix(spec.unitTypes, floors, unitsPerFloor);
  const b = newBuilding({
    id: slugify(spec.buildingName || "building"),
    name: spec.buildingName || "Building",
    area: spec.area,
    address: spec.address,
    tagline: spec.tagline,
    floors,
    unitsPerFloor,
    types,
    matrix,
    reservationFeeUsd: spec.reservationFeeUsd,
    bookingDepositUsd: spec.bookingDepositUsd,
  });
  const p = base ?? newProject();
  // The AI brief authors ONE development at a time: seed the active complex (the first) from the spec with this
  // building. Other complexes (if the user built some) are preserved untouched..
  const first = activeComplex(p) ?? p.complexes[0];
  const complexes = p.complexes.length
    ? p.complexes.map((c) =>
        c.id === first?.id
          ? { ...c, name: spec.complexName || c.name, area: spec.area, amenities: spec.complexAmenities, buildings: [b] }
          : c
      )
    : [{ id: "development", name: spec.complexName || "Development", area: spec.area, amenities: spec.complexAmenities, buildings: [b] }];
  return {
    ...p,
    developer: { ...p.developer, name: spec.developerName || p.developer.name, holdingCompany: spec.holdingCompany, nearAccount: spec.nearAccount },
    complexes,
    activeBuildingId: b.id,
  };
}

function aiTypeToAuthoring(t: AiUnitType): AuthoringType {
  return {
    key: t.key,
    label: t.label,
    sqm: Math.round((t.sqmMin + t.sqmMax) / 2) || t.sqmMin || 30,
    basePriceUsd: t.basePriceUsd,
    subtypes: t.subtypes?.length ? t.subtypes : [{ key: "a", label: "Standard" }],
    span: t.span,
    kind: t.kind,
  };
}

/** Lay each type's perFloor count into stacked columns, cycling subtypes — the same shape as the assembler. PURE. */
function stackMatrix(types: AiUnitType[], floors: number, unitsPerFloor: number): UnitCell[][] {
  // build one floor's column assignment (type+subtype per slot), then stack it on every floor
  const floorCols: UnitCell[] = [];
  for (const t of types) {
    const subs = t.subtypes?.length ? t.subtypes : [{ key: "a" }];
    for (let k = 0; k < Math.max(0, Math.floor(t.perFloor || 0)); k++) {
      floorCols.push({ typeKey: t.key, subtypeKey: subs[k % subs.length].key });
    }
  }
  const grid = emptyGrid(floors, unitsPerFloor);
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < unitsPerFloor && c < floorCols.length; c++) {
      grid[f][c] = { ...floorCols[c] };
    }
  }
  return grid;
}

// ---------------------------------------------------------------------------
// packToProject — the back-converter (recover the editable tree from an external Pack)
// ---------------------------------------------------------------------------

/** Recover an AuthoredProject from a Pack (import a ZIP/entity back into the editor). Rebuilds the matrix by
 *  placing each SELLABLE unit contiguously (slot = unitNumber − floor*100 − 1) and the type palette from the
 *  building's unitTypes + the distinct subtypes seen in the units. Per-unit price/sqm/view become sparse
 *  overrides so the exact values survive. PURE.
 *
 *  ⚠ A Pack is a LOSSY projection of the authored grid: it drops non-sellable STRUCTURE (the elevator/core
 *  column) and EMPTY slots, and re-sequences unitNumber on sellable units only. So packToProject recovers the
 *  sellable inventory faithfully but NOT the original void/core slot positions (a foreign pack doesn't carry
 *  them). This is why our OWN shells never round-trip through Pack — they keep AuthoredProject as the truth and
 *  only project to Pack at EXPORT (one-way). packToProject is for importing a FOREIGN pack/ZIP, where contiguous
 *  best-effort recovery is the right behaviour. Do NOT "fix" it to reconstruct cores — the info isn't in the pack. */
export function packToProject(pack: Pack): AuthoredProject {
  // Recover EVERY building (grouped under its complex by complexId) so a multi-complex pack round-trips. Media/
  // floorLayouts are pack-global in the projection → attach them to the first building only (the projection's
  // inverse; our own projectToPackAll accumulates them from the per-building overlays, first wins on recovery).
  const recovered = pack.buildings.map((b, i) => recoverBuilding(pack, b, i === 0));
  const byId = new Map(recovered.map((r) => [r.id, r]));

  // one authored complex per pack complex, each holding its own buildings (by complexId)
  const complexes: AuthoredComplex[] = (pack.complexes.length ? pack.complexes : [{ id: "development", name: "Development", buildings: [] }]).map((cx) => {
    const buildings = pack.buildings.filter((b) => b.complexId === cx.id).map((b) => byId.get(b.id)!).filter(Boolean);
    return {
      id: cx.id || "development",
      name: cx.name || "Development",
      companyId: cx.companyId,
      area: cx.area,
      amenities: cx.amenities,
      buildings,
    };
  });
  // any building whose complexId matched no complex → park under the first complex so nothing is dropped
  const placed = new Set(complexes.flatMap((c) => c.buildings.map((b) => b.id)));
  const orphans = recovered.filter((r) => !placed.has(r.id));
  if (orphans.length && complexes[0]) complexes[0].buildings.push(...orphans);
  // a complex must have ≥1 building for a valid tree; synthesize a blank one for any empty complex
  for (const c of complexes) if (!c.buildings.length) c.buildings.push(newBuilding());

  return {
    v: 1,
    domain: pack.domain || "realestate",
    developer: {
      id: pack.developer.id, name: pack.developer.name,
      holdingCompany: pack.developer.holdingCompany, nearAccount: pack.developer.nearAccount,
      logo: pack.developer.logo, contact: pack.developer.contact,
    },
    companies: (pack.companies || []).map((c) => ({ id: c.id, name: c.name, registration: c.registration })),
    complexes: complexes.length ? complexes : [{ id: "development", name: "Development", buildings: [newBuilding()] }],
    terms: (pack.terms || []).map((t) => ({ id: t.id, data: t.data })),
    activeBuildingId: complexes[0]?.buildings[0]?.id || "",
    // recover the durable §4d geo tree + view overrides (3c-iv) — project-root, round-trips verbatim
    geo: pack.geo?.length ? pack.geo : undefined,
    overrides: pack.overrides?.length ? pack.overrides : undefined,
  };
}

/** Recover ONE AuthoredBuilding from a pack building + its units (contiguous best-effort — see packToProject's
 *  caveat about lossy void/core recovery). `withGlobals` attaches the pack-global media/floorLayouts/texts (the
 *  projection emits them once; the first building carries them back). PURE. */
function recoverBuilding(pack: Pack, b: Pack["buildings"][number], withGlobals: boolean): AuthoredBuilding {
  const units = pack.buildingUnits[b.id] || [];
  const floors = Math.max(1, b?.stories || maxFloor(units));
  const unitsPerFloor = Math.max(1, maxSlotsPerFloor(units));

  const types = recoverTypes(b?.unitTypes || [], units);
  const matrix = emptyGrid(floors, unitsPerFloor);
  const overrides: Record<string, Partial<Unit>> = {};
  for (const u of units) {
    const f = u.floor - 1;
    const slot = (u.unitNumber ?? u.floor * 100 + 1) - u.floor * 100 - 1;
    if (f < 0 || f >= floors || slot < 0 || slot >= unitsPerFloor) continue;
    const subtypeKey = subtypeKeyFor(types, u.type, u.subtype);
    matrix[f][slot] = { typeKey: u.type, subtypeKey };
    if (u.unitNumber != null) overrides[String(u.unitNumber)] = { priceUsd: u.priceUsd, sqm: u.sqm, view: u.view, subtype: u.subtype };
  }
  return newBuilding({
    id: b?.id || "building",
    name: b?.name || "Building",
    companyId: b?.companyId,
    type: b?.type,
    area: b?.area,
    address: b?.address,
    tagline: b?.tagline,
    completion: b?.completion,
    constructionEnd: b?.constructionEnd,
    transferFeePct: b?.transferFeePct,
    amenities: b?.amenities,
    quota: b?.quota,
    declaredTotalUnits: b?.units,
    floors,
    unitsPerFloor,
    types,
    matrix,
    unitOverrides: Object.keys(overrides).length ? overrides : undefined,
    media: withGlobals && pack.media?.length ? pack.media : undefined,
    floorLayouts: withGlobals ? pack.floorLayouts : undefined,
    texts: withGlobals ? pack.texts : undefined,
    reservationFeeUsd: b?.reservationFeeUsd,
    bookingDepositUsd: b?.bookingDepositUsd,
    maintenancePerSqmUsd: b?.maintenancePerSqmUsd,
    sinkingFundPerSqmUsd: b?.sinkingFundPerSqmUsd,
    termsRef: b?.termsRef,
  });
}

function maxFloor(units: Unit[]): number {
  return units.reduce((m, u) => Math.max(m, u.floor), 1);
}
/** The grid width needed to hold every unit at its FIXED position (unitNumber is slot-based: floor*100 + pos).
 * Must size by the max POSITION, not the count — a sparse floor (holes/core) can put a unit past the count.. */
function maxSlotsPerFloor(units: Unit[]): number {
  let max = 1;
  for (const u of units) {
    const pos = u.unitNumber != null ? u.unitNumber - u.floor * 100 : 1; // 1-based slot position
    if (pos > max) max = pos;
  }
  return max;
}

/** Recover the authoring type palette from the building's declared unitTypes + the distinct subtype labels seen. */
function recoverTypes(unitTypes: UnitType[], units: Unit[]): AuthoringType[] {
  const byType = new Map<string, AuthoringType>();
  for (const t of unitTypes) {
    byType.set(t.key, {
      key: t.key, label: t.label,
      sqm: Math.round((t.sqmMin + t.sqmMax) / 2) || t.sqmMin || 30,
      basePriceUsd: 0,
      subtypes: [],
    });
  }
  // discover subtypes + a representative price/sqm from the units
  for (const u of units) {
    let t = byType.get(u.type);
    if (!t) { t = { key: u.type, label: u.type, sqm: u.sqm || 30, basePriceUsd: u.priceUsd || 0, subtypes: [] }; byType.set(u.type, t); }
    if (!t.basePriceUsd && u.priceUsd) t.basePriceUsd = u.priceUsd;
    const label = u.subtype || t.label;
    const key = slugify(label).slice(0, 8) || "a";
    if (!t.subtypes.some((s) => s.key === key)) t.subtypes.push({ key, label, sqm: u.sqm });
  }
  for (const t of byType.values()) if (!t.subtypes.length) t.subtypes.push({ key: "a", label: "Standard" });
  return [...byType.values()];
}

/** The subtype key for a unit's (type, subtype label) against the recovered palette (falls back to the first). */
function subtypeKeyFor(types: AuthoringType[], typeKey: string, subtypeLabel?: string): string {
  const t = types.find((x) => x.key === typeKey);
  if (!t) return "";
  if (!subtypeLabel) return t.subtypes[0]?.key || "";
  const want = slugify(subtypeLabel).slice(0, 8);
  return t.subtypes.find((s) => s.key === want || s.label === subtypeLabel)?.key || t.subtypes[0]?.key || "";
}
