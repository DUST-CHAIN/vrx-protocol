"use client";

// usePackStore — the STORE-BACKED PackApi (Stage 3c-ii, the design docs §9a).
//
// The Structured shell (Frame · Editor · Rail · Studio · Preview) is written against the PackApi interface
// (usePack). This adapter implements that SAME interface over the shared AuthoredProject store (useProject), so
// every edit on /structured writes through to the ONE live tree — the shell becomes a second LENS on the store
// instead of a seeded Pack island. usePack retires from /structured; the components are UNCHANGED.
//
// HOW THE SHAPES BRIDGE:
//  • .pack is a DERIVED projection — projectToPackAll(store.project), recomputed on every store change, with a
//    local session-only overlay for the §4d geo tree (see below). It is never stored; the store is the truth.
//  • The PROJECTED Pack ids differ from the store ids for BUILDINGS (the assembler derives a building's pack id
//    from slugify(name)); companies / payment-terms / the single complex keep their ids 1:1. So building setters
//    translate the projected id → the store id via a built id map; the rest route straight through.
//  • setPack is used ONLY by useGeo (the Studio drawing board), which writes {...pack, geo}. Since Stage 3c-iv the
//    §4d geo tree + view overrides persist to the STORE (AuthoredProject.geo/overrides, project-root) via
//    store.setGeo — so Studio edits survive a reload and round-trip through Pack. Every OTHER field setPack could
//    touch is already covered by a targeted store setter, so Studio never needs setPack for the structured spine.
//
// N complexes (3c-iii): the store holds complexes[]; add/patch/remove-complex route through real store ops.
//    The projected pack complex id EQUALS the authored complex id (overlayTree sets it), so complex ids are 1:1
//    (no id map) — only BUILDING ids need the projected→store translation.

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  Building, Company, Complex, Domain, MediaItem, Pack, Unit, UnitType,
} from "@/lib/pack";
import { slugify } from "@/lib/pack";
import { type AuthoredBuilding, type AuthoredComplex, type AuthoredProject, allBuildings } from "@/lib/project";
import { resizeGrid } from "@/lib/authoring";
import { sampleProject, sampleMediaItems } from "@/lib/sample-building";
import { generateBuilding, type GenerateBuildingOpts } from "@/lib/generate-building";
import { projectToPack, projectToPackAll } from "@/lib/project-pack";
import { useProject } from "./useProject";
import type { PackApi, Selection } from "./usePack";

export function usePackStore(): PackApi {
  const store = useProject();
  const p = store.project;

  const [selection, setSelection] = useState<Selection>({ kind: "developer" });
  const select = useCallback((s: Selection) => setSelection(s), []);

  // The derived Pack: the whole tree projected. The §4d geo tree + view overrides are DURABLE in the store
  // (3c-iv) and projectToPackAll already folds them in — no session overlay anymore.
  const pack = useMemo<Pack>(() => projectToPackAll(p), [p]);

  // projected-building-id → store-building-id. The assembler re-derives a building's pack id from slugify(name),
  // so the tree/Editor speak in projected ids; we translate back to the store id to route edits. Recomputed when
  // the building set changes (id/name). Kept in a ref so the setter callbacks don't churn on every keystroke.
  const idMapRef = useRef<Map<string, string>>(new Map());
  idMapRef.current = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of allBuildings(p)) {
      const projectedId = projectToPack(p, b.id).buildings[0]?.id;
      if (projectedId) m.set(projectedId, b.id);
    }
    return m;
  }, [p]);
  const storeBuildingId = useCallback((projectedId: string) => idMapRef.current.get(projectedId) ?? projectedId, []);

  // ---- whole-pack ops (the Structured shell's "load" affordances) ----
  const loadEmpty = useCallback(() => { store.loadNew(); setSelection({ kind: "developer" }); }, [store]);
  const loadSeed = useCallback(() => { store.loadNew(); setSelection({ kind: "developer" }); }, [store]);
  // Load the SAMPLE building — a large, rich tower (shops→penthouse + duplexes) authored directly in the store so
  // it opens fully editable in every face. (: make "Load sample" a real, interesting, complete building).
  // Images are attached asynchronously after the project is set (fetched + base64-encoded from /public/renderings),
  // best-effort so the load is instant and a missing file just leaves a placeholder.
  const loadMiracleTower = useCallback(() => {
    const proj = sampleProject();
    store.setProject(proj);
    try { localStorage.setItem("mm.started", "1"); } catch { /* ignore */ }
    void sampleMediaItems().then((items) => {
      if (!items.length) return;
      store.updateBuildingById(proj.activeBuildingId, (b) => {
        const have = new Set(items.map((m) => m.slotKey));
        const rest = (b.media || []).filter((m) => !have.has(m.slotKey));
        return { ...b, media: [...rest, ...items.map((m) => ({ ...m, buildingId: proj.activeBuildingId }))] };
      });
    });
    return proj.activeBuildingId;
  }, [store]);
  //  Load a freshly GENERATED, fully metre-native test building (dev-only "⚡ Generate test building"). The
  // generator emits the geo tree directly (position-authoritative on load — no hydrate), so projectToPackAll uses
  // it verbatim. Deterministic from opts.seed. REAL geometry, FAKE names/prices; never PII.
  const loadGenerated = useCallback((opts?: GenerateBuildingOpts) => {
    const proj = generateBuilding(opts);
    store.setProject(proj);
    try { localStorage.setItem("mm.started", "1"); } catch { /* ignore */ }
    return proj.activeBuildingId;
  }, [store]);
  //  Load any ready-made AuthoredProject into the store — the generic seam the IFC import (ifcSliceToProject)
  // consumes. Same shape as loadGenerated: the project is already metre-native (geo tree born points+pointsM+posM),
  // so projectToPackAll reads it verbatim (no hydrate, no new write path). Returns the active building id to select.
  const loadProject = useCallback((proj: AuthoredProject) => {
    store.setProject(proj);
    try { localStorage.setItem("mm.started", "1"); } catch { /* ignore */ }
    return proj.activeBuildingId;
  }, [store]);
  // setPack is used ONLY by useGeo (Studio). Persist the geo/overrides to the store (3c-iv); the rest of the pack
  // is derived from the store and can't be replaced wholesale (no round-trip without data loss on cores/voids).
  const setPack = useCallback((next: Pack) => {
    store.setGeo(next.geo || [], next.overrides);
  }, [store]);

  const setDomain = useCallback((d: Domain) => store.setDomain(d), [store]);

  // ---- developer (singleton, id 1:1) ----
  const patchDeveloper = useCallback((patch: Partial<Pack["developer"]>) => {
    store.patchDeveloper(patch);
  }, [store]);

  // ---- companies (project-root, id 1:1) ----
  const addCompany = useCallback(() => store.addCompany(), [store]);
  const patchCompany = useCallback((id: string, patch: Partial<Company>) => store.patchCompany(id, patch), [store]);
  const removeCompany = useCallback((id: string) => store.removeCompany(id), [store]);

  // ---- complexes (N; Stage 3c-iii). The projected pack complex id now EQUALS the authored complex id
  // (overlayTree sets the authored id), so complex ids route 1:1 — no id map needed for complexes. ----
  const addComplex = useCallback(() => {
    // Add a fresh development (one default building). The store RETURNS the new complex's authored id (the dedup
    // can't be predicted from the name — e.g. "development-2"); the projected pack complex id EQUALS that authored
    // id (overlayTree), so return it straight for the caller's select({kind:"complex", id}).
    return store.addComplex();
  }, [store]);
  const patchComplex = useCallback((id: string, patch: Partial<Complex>) => {
    // Route to the specific complex by id (1:1). Copy ONLY the keys the patch actually carries — a Pack Complex has
    // `buildings: string[]` (an id list) that the authored complex doesn't, and passing absent keys as `undefined`
    // would clobber the stored id/name on a partial edit (e.g. a name-only change must not blank the id).
    const next: Partial<AuthoredComplex> = {};
    if (patch.id !== undefined) next.id = patch.id; // `id` in the patch renames the complex's store id
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.companyId !== undefined) next.companyId = patch.companyId;
    if (patch.area !== undefined) next.area = patch.area;
    if (patch.amenities !== undefined) next.amenities = patch.amenities;
    store.patchComplexById(id, next);
  }, [store]);
  const removeComplex = useCallback((id: string) => store.removeComplex(id), [store]);

  // ---- buildings (projected id → store id) ----
  const addBuilding = useCallback((complexId?: string) => {
    // Add to the given complex (projected id == authored id, 3c-iii) via the store; return the PROJECTED id so the
    // caller's select lands on the right tree node. The assembler derives a building's pack id from slugify(name)
    // — the store update is async (setState), so mirror that derivation from the known name instead.
    store.addBuilding({ name: "New building" }, complexId);
    return slugify("New building");
  }, [store]);
  const patchBuilding = useCallback((id: string, patch: Partial<Building>) => {
    const sid = storeBuildingId(id);
    // complexId is OWNERSHIP, not a field on AuthoredBuilding — a change moves the building between complexes
    // (the projected complex id == the authored complex id, 3c-iii, so route straight through).
    if (patch.complexId != null) store.moveBuilding(sid, patch.complexId);
    const { complexId: _drop, ...rest } = patch;
    if (Object.keys(rest).length) store.updateBuildingById(sid, (b) => applyBuildingPatch(b, rest));
  }, [store, storeBuildingId]);
  const removeBuilding = useCallback((id: string) => {
    store.removeBuilding(storeBuildingId(id));
  }, [store, storeBuildingId]);
  const setUnitTypes = useCallback((buildingId: string, types: UnitType[]) => {
    const sid = storeBuildingId(buildingId);
    // Pack UnitType (key/label/sqmMin/sqmMax) → the authoring palette carries richer fields; preserve existing
    // palette entries by key and only update the declared range, so we never clobber subtypes/price on edit.
    store.updateBuildingById(sid, (b) => ({ ...b, types: mergeUnitTypes(b, types) }));
  }, [store, storeBuildingId]);
  // Edit a type's SUBTYPES directly (the real units; each carries its own size). The type's sqmMin/sqmMax DERIVE
  // from these (toSpec: min/max of the subtype sqms), so the editor edits subtypes and shows the range read-only.
  const setUnitSubtypes = useCallback((buildingId: string, typeKey: string, subtypes: import("@/lib/ai-build").AiUnitSubtype[]) => {
    const sid = storeBuildingId(buildingId);
    store.updateBuildingById(sid, (b) => ({
      ...b,
      types: b.types.map((t) => (t.key === typeKey ? { ...t, subtypes: subtypes.length ? subtypes : [{ key: "a", label: "Standard" }] } : t)),
    }));
  }, [store, storeBuildingId]);

  //  write a subtype's shared PLAN to the DURABLE authored palette (b.types[].subtypes[].plan). toSpec carries
  // subtypes verbatim → the assembler + overlayTree project the plan into pack.buildings[].unitTypes[].subtypes[].plan,
  // so every unit of the subtype renders it (effectiveFootprint) AND it survives reload. This is the fix for the
  // Studio writing the plan onto the projected pack via setPack, which only persists geo (persistence bug).
  const setSubtypePlan = useCallback((buildingId: string, typeKey: string, subtypeKey: string, plan: import("@/lib/pack").UnitPlan | undefined) => {
    const sid = storeBuildingId(buildingId);
    store.updateBuildingById(sid, (b) => ({
      ...b,
      types: b.types.map((t) =>
        t.key !== typeKey ? t : { ...t, subtypes: t.subtypes.map((s) => (s.key === subtypeKey ? { ...s, plan } : s)) }
      ),
    }));
  }, [store, storeBuildingId]);

  // ---- units (per building; projected id → store id). The Pack units are grid-derived; edits land as overrides
  // keyed by unitNumber so the exact value survives the next projection (the same channel packToProject uses). ----
  const setUnits = useCallback((buildingId: string, units: Unit[]) => {
    const sid = storeBuildingId(buildingId);
    store.updateBuildingById(sid, (b) => ({ ...b, unitOverrides: unitsToOverrides(units, b.unitOverrides) }));
  }, [store, storeBuildingId]);

  // ---- media (per building) ----
  const setMedia = useCallback((item: MediaItem) => {
    const sid = storeBuildingId(item.buildingId);
    store.updateBuildingById(sid, (b) => {
      const rest = (b.media || []).filter((m) => !(m.slotKey === item.slotKey));
      return { ...b, media: [...rest, { ...item, buildingId: sid }] };
    });
  }, [store, storeBuildingId]);
  const removeMedia = useCallback((buildingId: string, slotKey: string) => {
    const sid = storeBuildingId(buildingId);
    store.updateBuildingById(sid, (b) => ({ ...b, media: (b.media || []).filter((m) => m.slotKey !== slotKey) }));
  }, [store, storeBuildingId]);
  // per-slot DESCRIPTION (editable without an image; feeds the stubbed AI-generate). Stored on the building.
  const setSlotCaption = useCallback((buildingId: string, slotKey: string, caption: string) => {
    const sid = storeBuildingId(buildingId);
    store.updateBuildingById(sid, (b) => {
      const next = { ...(b.slotCaptions || {}) };
      if (caption) next[slotKey] = caption; else delete next[slotKey];
      return { ...b, slotCaptions: Object.keys(next).length ? next : undefined };
    });
  }, [store, storeBuildingId]);
  const slotCaption = useCallback((buildingId: string, slotKey: string) => {
    const sid = storeBuildingId(buildingId);
    const b = allBuildings(p).find((x) => x.id === sid);
    return b?.slotCaptions?.[slotKey] ?? "";
  }, [p, storeBuildingId]);

  // ---- the per-floor UNIT GRID (the Structured paint-matrix; the store building already holds matrix[][]) ----
  const unitMatrix = useCallback((buildingId: string) => {
    const b = allBuildings(p).find((x) => x.id === storeBuildingId(buildingId));
    return b?.matrix ?? [];
  }, [p, storeBuildingId]);
  const setUnitMatrix = useCallback((buildingId: string, matrix: import("@/lib/authoring").UnitCell[][]) => {
    store.updateBuildingById(storeBuildingId(buildingId), (b) => ({ ...b, matrix }));
  }, [store, storeBuildingId]);
  const setGridShape = useCallback((buildingId: string, shape: { floors?: number; unitsPerFloor?: number }) => {
    store.updateBuildingById(storeBuildingId(buildingId), (b) => {
      const floors = Math.max(1, Math.floor(shape.floors ?? b.floors));
      const unitsPerFloor = Math.max(1, Math.floor(shape.unitsPerFloor ?? b.unitsPerFloor));
      const matrix = resizeGrid({ floors, unitsPerFloor, grid: b.matrix } as never);
      return { ...b, floors, unitsPerFloor, matrix };
    });
  }, [store, storeBuildingId]);

  // ---- terms (project-root, id 1:1) ----
  const addTerms = useCallback(() => store.addTerms(), [store]);
  const patchTerms = useCallback((id: string, data: Record<string, unknown>) => store.patchTerms(id, data), [store]);
  const removeTerms = useCallback((id: string) => store.removeTerms(id), [store]);

  // ---- texts (building-level in the store; the single active building carries project texts) ----
  const setText = useCallback((key: string, value: string) => {
    const sid = store.activeBuilding?.id;
    if (!sid) return;
    store.updateBuildingById(sid, (b) => ({ ...b, texts: { ...(b.texts || {}), [key]: value } }));
  }, [store]);
  const removeText = useCallback((key: string) => {
    const sid = store.activeBuilding?.id;
    if (!sid) return;
    store.updateBuildingById(sid, (b) => {
      const { [key]: _drop, ...rest } = b.texts || {};
      return { ...b, texts: rest };
    });
  }, [store]);

  return useMemo<PackApi>(() => ({
    pack, selection, select,
    loadSeed, loadEmpty, loadMiracleTower, loadGenerated, loadProject, setPack,
    setDomain, patchDeveloper,
    addCompany, patchCompany, removeCompany,
    addComplex, patchComplex, removeComplex,
    addBuilding, patchBuilding, removeBuilding, setUnitTypes, setUnitSubtypes, setSubtypePlan,
    unitMatrix, setUnitMatrix, setGridShape,
    setUnits,
    setMedia, removeMedia, setSlotCaption, slotCaption,
    addTerms, patchTerms, removeTerms,
    setText, removeText,
  }), [
    pack, selection, select, loadSeed, loadEmpty, loadMiracleTower, loadGenerated, loadProject, setPack, setDomain, patchDeveloper,
    addCompany, patchCompany, removeCompany, addComplex, patchComplex, removeComplex,
    addBuilding, patchBuilding, removeBuilding, setUnitTypes, setUnitSubtypes, setSubtypePlan, setUnits, setMedia, removeMedia,
    addTerms, patchTerms, removeTerms, setText, removeText,
  ]);
}

// ---------------------------------------------------------------------------
// Pack-edit → store-building translation (pure helpers)
// ---------------------------------------------------------------------------

/** Apply a Pack Building patch onto an AuthoredBuilding (the fields map near 1:1; stories ↔ floors, units ↔
 *  declaredTotalUnits). Shape changes (floors) flow through the authoring grid elsewhere; here we only carry the
 *  scalar/metadata fields the Structured forms edit. */
function applyBuildingPatch(b: AuthoredBuilding, patch: Partial<Building>): AuthoredBuilding {
  const next: AuthoredBuilding = { ...b };
  if (patch.name != null) next.name = patch.name;
  if (patch.id != null) next.id = slugify(patch.id); // keep the store id url-safe + in sync with the form
  if (patch.companyId !== undefined) next.companyId = patch.companyId;
  if (patch.type != null) next.type = patch.type;
  if (patch.area !== undefined) next.area = patch.area;
  if (patch.address !== undefined) next.address = patch.address;
  if (patch.tagline !== undefined) next.tagline = patch.tagline;
  if (patch.completion !== undefined) next.completion = patch.completion;
  if (patch.constructionEnd !== undefined) next.constructionEnd = patch.constructionEnd;
  if (patch.transferFeePct !== undefined) next.transferFeePct = patch.transferFeePct;
  if (patch.amenities !== undefined) next.amenities = patch.amenities;
  if (patch.quota !== undefined) next.quota = patch.quota;
  if (patch.units !== undefined) next.declaredTotalUnits = patch.units;
  if (patch.stories != null) next.floors = patch.stories;
  if (patch.reservationFeeUsd !== undefined) next.reservationFeeUsd = patch.reservationFeeUsd;
  if (patch.bookingDepositUsd !== undefined) next.bookingDepositUsd = patch.bookingDepositUsd;
  if (patch.maintenancePerSqmUsd !== undefined) next.maintenancePerSqmUsd = patch.maintenancePerSqmUsd;
  if (patch.sinkingFundPerSqmUsd !== undefined) next.sinkingFundPerSqmUsd = patch.sinkingFundPerSqmUsd;
  if (patch.termsRef !== undefined) next.termsRef = patch.termsRef;
  return next;
}

/** Merge edited Pack UnitType rows (key/label/sqmMin/sqmMax) into the authoring palette, preserving each type's
 *  richer fields (subtypes, price, kind) by key. New keys get a minimal single-subtype palette entry. */
function mergeUnitTypes(b: AuthoredBuilding, types: UnitType[]): AuthoredBuilding["types"] {
  return types.map((t) => {
    const existing = b.types.find((x) => x.key === t.key);
    const sqm = Math.round(((t.sqmMin || 0) + (t.sqmMax || 0)) / 2) || existing?.sqm || t.sqmMin || 30;
    if (existing) return { ...existing, key: t.key, label: t.label, sqm };
    return { key: t.key, label: t.label, sqm, basePriceUsd: 0, subtypes: [{ key: "a", label: "Standard" }] };
  });
}

/** Fold an edited Pack Unit list into the sparse per-unit override map, keyed by unitNumber (the cell id) — the
 *  same channel projectToPack reads back via applyOverrides, so the edited price/sqm/view survive re-projection. */
function unitsToOverrides(units: Unit[], prior?: Record<string, Partial<Unit>>): Record<string, Partial<Unit>> | undefined {
  const next: Record<string, Partial<Unit>> = { ...(prior || {}) };
  for (const u of units) {
    if (u.unitNumber == null) continue;
    next[String(u.unitNumber)] = {
      priceUsd: u.priceUsd, sqm: u.sqm, view: u.view, subtype: u.subtype,
      priceFreehold: u.priceFreehold, corner: u.corner, baths: u.baths, note: u.note, termsRef: u.termsRef,
    };
  }
  return Object.keys(next).length ? next : undefined;
}
