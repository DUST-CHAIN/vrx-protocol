"use client";

// The SHARED PROJECT STORE (stage 1, the design docs §4) — the single source of truth every
// MM route reads/writes. Mounted ONCE in the root layout (ProjectProvider wrapping {children}); every view-mode
// consumes it via useProject. This is what kills the data-loss bug: navigating between shells no longer drops
// the building because there is only ONE state object, lifted above the router, and persisted to localStorage so
// a refresh survives too.
//
// The tree + its pure updates live in lib/project.ts (React-free, unit-tested). This file is the thin React shell:
// Context + the setter wrappers + debounced persistence with a media size guard (R1).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type AuthoredProject, type AuthoredBuilding, type AuthoredDeveloper, type AuthoredComplex,
  type AuthoredCompany, type AuthoredPaymentTerms, type Domain,
  newProject, migrateProject, activeBuilding as activeOf, activeComplex as activeComplexOf,
  updateActiveBuilding, patchBuilding as patchBuildingPure,
  updateBuildingById, allBuildings,
  addBuilding as addBuildingPure, removeBuilding as removeBuildingPure,
  addComplex as addComplexPure, patchComplex as patchComplexPure, removeComplex as removeComplexPure,
  moveBuildingToComplex as moveBuildingToComplexPure,
  addCompany as addCompanyPure, patchCompany as patchCompanyPure, removeCompany as removeCompanyPure,
  addTerms as addTermsPure, patchTerms as patchTermsPure, removeTerms as removeTermsPure,
  setGeo as setGeoPure,
} from "@/lib/project";
import type { GeoNode, ViewOverride } from "@/lib/pack";
import {
  type EntityEnvelope, type EntityLevel, type ImportResult,
  exportDeveloper, exportComplex, exportActiveBuilding,
  importEntity, duplicateBuilding as duplicateBuildingPure,
} from "@/lib/project-reuse";

const LS_KEY = "mm:project";
// Rough localStorage budget (most browsers ~5MB). If the serialized project exceeds this we persist WITHOUT media
// (building data still saved; media stays in-memory for the session) rather than throw. IndexedDB is deferred (R1).
const LS_BUDGET = 4_500_000;

export interface ProjectApi {
  project: AuthoredProject;
  activeBuilding: AuthoredBuilding | undefined;
  /** true once we've hydrated from localStorage (avoids a flash of the fresh default before restore). */
  hydrated: boolean;
  // whole-tree
  setProject: (p: AuthoredProject) => void;
  loadNew: () => void; // fresh blank tree
  save: () => void; // explicit persist now (persistence is also automatic/debounced)
  reload: () => void; // re-hydrate from localStorage, dropping in-memory changes
  // tree-level patches
  patchDeveloper: (patch: Partial<AuthoredDeveloper>) => void;
  /** Patch the ACTIVE complex (the one holding the active building) — convenience for the single-complex callers. */
  patchComplex: (patch: Partial<AuthoredComplex>) => void;
  setDomain: (d: Domain) => void;
  // complexes (N; Stage 3c-iii)
  addComplex: (init?: Partial<AuthoredComplex>) => string; // returns the NEW complex's id (to select it in the tree)
  patchComplexById: (id: string, patch: Partial<AuthoredComplex>) => void;
  removeComplex: (id: string) => void;
  // active-building edits (the per-building flows write through these)
  updateBuilding: (fn: (b: AuthoredBuilding) => AuthoredBuilding) => void;
  patchBuilding: (patch: Partial<AuthoredBuilding>) => void;
  setActiveBuilding: (id: string) => void;
  // building-by-id edits (the Structured tree edits whichever building is selected, not just the active one)
  updateBuildingById: (id: string, fn: (b: AuthoredBuilding) => AuthoredBuilding) => void;
  addBuilding: (init?: Partial<AuthoredBuilding>, complexId?: string) => string;
  removeBuilding: (id: string) => void;
  moveBuilding: (buildingId: string, toComplexId: string) => void; // move across complexes (3c-iii)
  // companies (project-root)
  addCompany: (init?: Partial<AuthoredCompany>) => string;
  patchCompany: (id: string, patch: Partial<AuthoredCompany>) => void;
  removeCompany: (id: string) => void;
  // payment terms (project-root)
  addTerms: (init?: Partial<AuthoredPaymentTerms>) => string;
  patchTerms: (id: string, data: Record<string, unknown>) => void;
  removeTerms: (id: string) => void;
  // durable §4d geo (Studio drawing board) — the whole flat tree + view overrides, project-root (Stage 3c-iv)
  setGeo: (geo: GeoNode[], overrides?: ViewOverride[]) => void;
  // reuse ops (lib/project-reuse) — thin store wrappers that commit the pure result + return what changed so the
  // project-manager view can select/announce. See the design docs §3a.
  exportEntity: (level: EntityLevel) => EntityEnvelope | undefined;
  importEntity: (env: EntityEnvelope) => ImportResult;
  duplicateBuilding: () => ImportResult;
}

const Ctx = createContext<ProjectApi | null>(null);

/** Strip media from a project (for the size-guard fallback persist). */
function stripMedia(p: AuthoredProject): AuthoredProject {
  return {
    ...p,
    complexes: p.complexes.map((c) => ({ ...c, buildings: c.buildings.map((b) => ({ ...b, media: undefined })) })),
  };
}

/** Persist the project, dropping media if it would blow the localStorage budget. Returns what happened. */
function persist(p: AuthoredProject): "saved" | "saved-without-media" | "failed" {
  try {
    const full = JSON.stringify(p);
    if (full.length <= LS_BUDGET) {
      localStorage.setItem(LS_KEY, full);
      return "saved";
    }
    localStorage.setItem(LS_KEY, JSON.stringify(stripMedia(p)));
    return "saved-without-media";
  } catch {
    return "failed";
  }
}

function hydrate(): AuthoredProject | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    // migrateProject upgrades a legacy singleton-`complex` blob (pre-3c-iii) to complexes[]; returns null on junk.
    return migrateProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  // Start from the fresh default on the server + first client render (SSR-safe); hydrate from localStorage in an
  // effect so client and server markup match (no hydration mismatch).
  const [project, setProjectState] = useState<AuthoredProject>(() => newProject());
  const [hydrated, setHydrated] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const restored = hydrate();
    if (restored) setProjectState(restored);
    setHydrated(true);
  }, []);

  // debounced auto-persist on every change (after hydration, so we never overwrite the stored tree with the
  // transient default before restore runs)
  useEffect(() => {
    if (!hydrated) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(project), 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [project, hydrated]);

  const setProject = useCallback((p: AuthoredProject) => setProjectState(p), []);
  const loadNew = useCallback(() => setProjectState(newProject()), []);
  const save = useCallback(() => persist(project), [project]);
  const reload = useCallback(() => { const r = hydrate(); if (r) setProjectState(r); }, []);

  const patchDeveloper = useCallback((patch: Partial<AuthoredDeveloper>) => {
    setProjectState((p) => ({ ...p, developer: { ...p.developer, ...patch } }));
  }, []);
  // patch the ACTIVE complex (convenience for single-complex callers)
  const patchComplex = useCallback((patch: Partial<AuthoredComplex>) => {
    setProjectState((p) => { const cx = activeComplexOf(p); return cx ? patchComplexPure(p, cx.id, patch) : p; });
  }, []);
  // N complexes (3c-iii). Returns the NEW complex's id (captured from the pure result — the dedup can't be
  // predicted by the caller, so the store is the authority) so the UI can select({kind:"complex", id}).
  const addComplex = useCallback((init?: Partial<AuthoredComplex>) => {
    let cid = "";
    setProjectState((p) => { const r = addComplexPure(p, init); cid = r.id; return r.project; });
    return cid;
  }, []);
  const patchComplexById = useCallback((id: string, patch: Partial<AuthoredComplex>) => {
    setProjectState((p) => patchComplexPure(p, id, patch));
  }, []);
  const removeComplex = useCallback((id: string) => {
    setProjectState((p) => removeComplexPure(p, id));
  }, []);
  const updateBuilding = useCallback((fn: (b: AuthoredBuilding) => AuthoredBuilding) => {
    setProjectState((p) => updateActiveBuilding(p, fn));
  }, []);
  const patchBuilding = useCallback((patch: Partial<AuthoredBuilding>) => {
    setProjectState((p) => updateActiveBuilding(p, (b) => patchBuildingPure(b, patch)));
  }, []);
  const setActiveBuilding = useCallback((id: string) => {
    setProjectState((p) => (allBuildings(p).some((b) => b.id === id) ? { ...p, activeBuildingId: id } : p));
  }, []);
  const setDomain = useCallback((d: Domain) => {
    setProjectState((p) => ({ ...p, domain: d }));
  }, []);

  // building-by-id (the Structured tree selects any building, then edits it)
  const updateBuildingByIdCb = useCallback((id: string, fn: (b: AuthoredBuilding) => AuthoredBuilding) => {
    setProjectState((p) => updateBuildingById(p, id, fn));
  }, []);
  const addBuilding = useCallback((init?: Partial<AuthoredBuilding>, complexId?: string) => {
    let id = "";
    setProjectState((p) => { const r = addBuildingPure(p, init, complexId); id = r.id; return r.project; });
    return id;
  }, []);
  const removeBuilding = useCallback((id: string) => {
    setProjectState((p) => removeBuildingPure(p, id));
  }, []);
  const moveBuilding = useCallback((buildingId: string, toComplexId: string) => {
    setProjectState((p) => moveBuildingToComplexPure(p, buildingId, toComplexId));
  }, []);

  // companies
  const addCompany = useCallback((init?: Partial<AuthoredCompany>) => {
    let id = "";
    setProjectState((p) => { const r = addCompanyPure(p, init); id = r.id; return r.project; });
    return id;
  }, []);
  const patchCompany = useCallback((id: string, patch: Partial<AuthoredCompany>) => {
    setProjectState((p) => patchCompanyPure(p, id, patch));
  }, []);
  const removeCompany = useCallback((id: string) => {
    setProjectState((p) => removeCompanyPure(p, id));
  }, []);

  // payment terms
  const addTerms = useCallback((init?: Partial<AuthoredPaymentTerms>) => {
    let id = "";
    setProjectState((p) => { const r = addTermsPure(p, init); id = r.id; return r.project; });
    return id;
  }, []);
  const patchTerms = useCallback((id: string, data: Record<string, unknown>) => {
    setProjectState((p) => patchTermsPure(p, id, data));
  }, []);
  const removeTerms = useCallback((id: string) => {
    setProjectState((p) => removeTermsPure(p, id));
  }, []);

  // durable geo (Studio) — the adapter calls this from setPack with the new geo/overrides
  const setGeo = useCallback((geo: GeoNode[], overrides?: ViewOverride[]) => {
    setProjectState((p) => setGeoPure(p, geo, overrides));
  }, []);

  // ---- reuse ops (pure core in lib/project-reuse) ----
  // export reads the CURRENT project (no state change). We read via a ref-free closure over `project` — the
  // callbacks are recreated when `project` changes (they depend on it), so they always see the live tree.
  const exportEntity = useCallback((level: EntityLevel): EntityEnvelope | undefined => {
    if (level === "developer") return exportDeveloper(project.developer);
    // a complex export carries the project's drawn §4d geo so a cloned development keeps its footprints
    if (level === "complex") { const cx = activeComplexOf(project); return cx ? exportComplex(cx, project.geo, project.overrides) : undefined; }
    return exportActiveBuilding(project); // building — the active one; undefined if nothing loaded
  }, [project]);

  const importEntityIntoStore = useCallback((env: EntityEnvelope): ImportResult => {
    const res = importEntity(project, env);
    setProjectState(res.project);
    return res;
  }, [project]);

  const duplicate = useCallback((): ImportResult => {
    const res = duplicateBuildingPure(project);
    setProjectState(res.project);
    return res;
  }, [project]);

  const api = useMemo<ProjectApi>(() => ({
    project,
    activeBuilding: activeOf(project),
    hydrated,
    setProject, loadNew, save, reload,
    patchDeveloper, patchComplex,
    setDomain,
    addComplex, patchComplexById, removeComplex,
    updateBuilding, patchBuilding, setActiveBuilding,
    updateBuildingById: updateBuildingByIdCb, addBuilding, removeBuilding, moveBuilding,
    addCompany, patchCompany, removeCompany,
    addTerms, patchTerms, removeTerms,
    setGeo,
    exportEntity, importEntity: importEntityIntoStore, duplicateBuilding: duplicate,
  }), [project, hydrated, setProject, loadNew, save, reload, patchDeveloper, patchComplex, setDomain, addComplex, patchComplexById, removeComplex, updateBuilding, patchBuilding, setActiveBuilding, updateBuildingByIdCb, addBuilding, removeBuilding, moveBuilding, addCompany, patchCompany, removeCompany, addTerms, patchTerms, removeTerms, setGeo, exportEntity, importEntityIntoStore, duplicate]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** Read the shared project store. Throws if used outside the provider (a wiring bug, surfaced loudly). */
export function useProject(): ProjectApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useProject must be used within <ProjectProvider> (mount it in app/layout.tsx)");
  return api;
}
