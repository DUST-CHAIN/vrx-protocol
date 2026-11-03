"use client";

// Central Pack state + the selection model for the Structured face. One source of truth: every form edits
// through these setters (immutable updates) so the tree, editor, and validation rail never drift.

import { useCallback, useMemo, useState } from "react";
import {
  type Building,
  type Company,
  type Complex,
  type Domain,
  type Pack,
  type MediaItem,
  type Unit,
  type UnitType,
  emptyPack,
  slugify,
} from "@/lib/pack";
import { seedPack } from "@/lib/seed";
import { miracleTowerPack, MIRACLE_TOWER_ID } from "@/lib/from-catalog";
import { generateBuilding, type GenerateBuildingOpts } from "@/lib/generate-building";
import { projectToPackAll } from "@/lib/project-pack";
import type { AuthoredProject } from "@/lib/project";

/** What the center editor is focused on. The left tree sets this; the editor reads it. */
export type Selection =
  | { kind: "developer" }
  | { kind: "company"; id: string }
  | { kind: "complex"; id: string }
  | { kind: "building"; id: string }
  | { kind: "units"; buildingId: string }
  | { kind: "terms"; id: string }
  | { kind: "texts" };

export interface PackApi {
  pack: Pack;
  selection: Selection;
  select: (s: Selection) => void;
  // whole-pack
  loadSeed: () => void;
  loadEmpty: () => void;
  loadMiracleTower: () => string; // load the real demo building; returns its id
  loadGenerated: (opts?: GenerateBuildingOpts) => string; //  dev test-data faucet; returns the building id
  loadProject: (proj: AuthoredProject) => string; //  load any ready AuthoredProject (IFC import); returns active building id
  setPack: (p: Pack) => void;
  // project settings
  setDomain: (d: Domain) => void;
  // developer
  patchDeveloper: (patch: Partial<Pack["developer"]>) => void;
  // companies
  addCompany: () => string;
  patchCompany: (id: string, patch: Partial<Company>) => void;
  removeCompany: (id: string) => void;
  // complexes
  addComplex: () => string;
  patchComplex: (id: string, patch: Partial<Complex>) => void;
  removeComplex: (id: string) => void;
  // buildings
  addBuilding: (complexId?: string) => string;
  patchBuilding: (id: string, patch: Partial<Building>) => void;
  removeBuilding: (id: string) => void;
  setUnitTypes: (buildingId: string, types: UnitType[]) => void;
  /** Replace a type's SUBTYPES (the real units — each carries its own size). The type's sqmMin/sqmMax derive from
 * these, so the Structured editor edits subtypes and the range is read-only.. */
  setUnitSubtypes: (buildingId: string, typeKey: string, subtypes: import("@/lib/ai-build").AiUnitSubtype[]) => void;
  /**  persist a SUBTYPE's shared PLAN (footprint/markers/backdrop) to the DURABLE authored model — the geo
   *  Studio writes it here (NOT via setPack, which only carries geo), so the plan survives re-projection + reload
   *  and every unit of the subtype renders it. `plan: undefined` clears it. A no-op if the type/subtype is unknown. */
  setSubtypePlan: (buildingId: string, typeKey: string, subtypeKey: string, plan: import("@/lib/pack").UnitPlan | undefined) => void;
  /** The per-floor UNIT GRID (matrix[floorIdx][unitIdx] = {typeKey, subtypeKey}). The Structured paint-grid writes
   *  here; projecting the building turns painted cells into real units. Shape = building.floors × unitsPerFloor. */
  unitMatrix: (buildingId: string) => import("@/lib/authoring").UnitCell[][];
  setUnitMatrix: (buildingId: string, matrix: import("@/lib/authoring").UnitCell[][]) => void;
  /** change the grid SHAPE (floors / units-per-floor), resizing the matrix (preserves painted overlap). */
  setGridShape: (buildingId: string, shape: { floors?: number; unitsPerFloor?: number }) => void;
  // units
  setUnits: (buildingId: string, units: Unit[]) => void;
  // media (marketing images — source-agnostic; one item per building+slot)
  setMedia: (item: MediaItem) => void;
  /** the DESCRIPTION for an image slot (building + slotKey) — editable before an image exists; feeds AI-generate. */
  setSlotCaption: (buildingId: string, slotKey: string, caption: string) => void;
  /** read a slot's description (building + slotKey). */
  slotCaption: (buildingId: string, slotKey: string) => string;
  removeMedia: (buildingId: string, slotKey: string) => void;
  // terms
  addTerms: () => string;
  patchTerms: (id: string, data: Record<string, unknown>) => void;
  removeTerms: (id: string) => void;
  // texts
  setText: (key: string, value: string) => void;
  removeText: (key: string) => void;
}

function uniqueId(base: string, taken: Set<string>): string {
  const root = slugify(base);
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n++;
  return `${root}-${n}`;
}

/** A one-shot handoff from the MM-by-AI page (app/ai): a generated Pack stashed in sessionStorage. Consumed
 *  (and cleared) on the editor's first load so "Open in MM editor →" lands on the generated building. */
function readHandoffPack(): Pack | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem("mm:handoff-pack");
    if (!raw) return null;
    sessionStorage.removeItem("mm:handoff-pack");
    const p = JSON.parse(raw) as Pack;
    return p && p.developer && Array.isArray(p.buildings) ? p : null;
  } catch {
    return null;
  }
}

export function usePack(initial: "seed" | "empty" = "seed", initialPack?: Pack): PackApi {
  //  stage-2 bridge: the Structured shell seeds from the SHARED STORE's active building (initialPack) so /
  // opens on the same building the other shells authored — no longer a separate island. Falls back to the
  // handoff/seed/empty when no store building is supplied.
  const [pack, setPackState] = useState<Pack>(() => initialPack ?? readHandoffPack() ?? (initial === "seed" ? seedPack() : emptyPack()));
  const [selection, setSelection] = useState<Selection>({ kind: "developer" });

  const select = useCallback((s: Selection) => setSelection(s), []);
  const setPack = useCallback((p: Pack) => setPackState(p), []);

  const loadSeed = useCallback(() => {
    setPackState(seedPack());
    setSelection({ kind: "developer" });
  }, []);
  const loadEmpty = useCallback(() => {
    setPackState(emptyPack());
    setSelection({ kind: "developer" });
  }, []);
  // Load the real demo building (Miracle Tower, 476 units) straight from the VRX catalog — for Preview.
  const loadMiracleTower = useCallback(() => {
    const p = miracleTowerPack();
    setPackState(p);
    setSelection({ kind: "building", id: MIRACLE_TOWER_ID });
    return MIRACLE_TOWER_ID;
  }, []);
  //  dev test-data faucet. This legacy Pack-state hook is retired (the live path is usePackStore); kept
  // only so the PackApi type is satisfied. Projects a generated AuthoredProject to a Pack and sets it.
  const loadGenerated = useCallback((opts?: GenerateBuildingOpts) => {
    const proj = generateBuilding(opts);
    setPackState(projectToPackAll(proj));
    setSelection({ kind: "building", id: proj.activeBuildingId });
    return proj.activeBuildingId;
  }, []);
  //  Load any ready AuthoredProject (the IFC import's output). Legacy hook — retired path; kept for the type.
  const loadProject = useCallback((proj: AuthoredProject) => {
    setPackState(projectToPackAll(proj));
    setSelection({ kind: "building", id: proj.activeBuildingId });
    return proj.activeBuildingId;
  }, []);

  const setDomain = useCallback((d: Domain) => {
    setPackState((p) => ({ ...p, domain: d }));
  }, []);

  const patchDeveloper = useCallback((patch: Partial<Pack["developer"]>) => {
    setPackState((p) => ({ ...p, developer: { ...p.developer, ...patch } }));
  }, []);

  // ---- companies ----
  const addCompany = useCallback(() => {
    let id = "";
    setPackState((p) => {
      id = uniqueId("company", new Set(p.companies.map((c) => c.id)));
      return { ...p, companies: [...p.companies, { id, name: "New company" }] };
    });
    return id;
  }, []);
  const patchCompany = useCallback((id: string, patch: Partial<Company>) => {
    setPackState((p) => ({ ...p, companies: p.companies.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  }, []);
  const removeCompany = useCallback((id: string) => {
    setPackState((p) => ({ ...p, companies: p.companies.filter((c) => c.id !== id) }));
  }, []);

  // ---- complexes ----
  const addComplex = useCallback(() => {
    let id = "";
    setPackState((p) => {
      id = uniqueId("complex", new Set(p.complexes.map((c) => c.id)));
      return { ...p, complexes: [...p.complexes, { id, name: "New complex", buildings: [] }] };
    });
    return id;
  }, []);
  const patchComplex = useCallback((id: string, patch: Partial<Complex>) => {
    setPackState((p) => ({ ...p, complexes: p.complexes.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  }, []);
  const removeComplex = useCallback((id: string) => {
    setPackState((p) => ({ ...p, complexes: p.complexes.filter((c) => c.id !== id) }));
  }, []);

  // ---- buildings ----
  const addBuilding = useCallback((complexId?: string) => {
    let id = "";
    setPackState((p) => {
      id = uniqueId("building", new Set(p.buildings.map((b) => b.id)));
      const cx = complexId || p.complexes[0]?.id || "";
      const building: Building = { id, name: "New building", complexId: cx, type: "High Rise", stories: 1 };
      const complexes = p.complexes.map((c) =>
        c.id === cx ? { ...c, buildings: [...c.buildings, id] } : c
      );
      return { ...p, buildings: [...p.buildings, building], complexes, buildingUnits: { ...p.buildingUnits, [id]: [] } };
    });
    return id;
  }, []);
  const patchBuilding = useCallback((id: string, patch: Partial<Building>) => {
    setPackState((p) => ({ ...p, buildings: p.buildings.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  }, []);
  const removeBuilding = useCallback((id: string) => {
    setPackState((p) => {
      const { [id]: _drop, ...buildingUnits } = p.buildingUnits;
      return {
        ...p,
        buildings: p.buildings.filter((b) => b.id !== id),
        complexes: p.complexes.map((c) => ({ ...c, buildings: c.buildings.filter((bid) => bid !== id) })),
        buildingUnits,
      };
    });
  }, []);
  const setUnitTypes = useCallback((buildingId: string, types: UnitType[]) => {
    setPackState((p) => ({ ...p, buildings: p.buildings.map((b) => (b.id === buildingId ? { ...b, unitTypes: types } : b)) }));
  }, []);
  // usePack is the retired non-store path (only its TYPE is used now); subtypes/matrix aren't modeled on a flat
  // Pack, so these are no-ops/empties to satisfy the interface. The live store path (usePackStore) is real.
  const setUnitSubtypes = useCallback((_b: string, _k: string, _s: import("@/lib/ai-build").AiUnitSubtype[]) => {}, []);
  // plain Pack impl: subtypes live on pack.buildings[].unitTypes directly, so write the plan there.
  const setSubtypePlan = useCallback((buildingId: string, typeKey: string, subtypeKey: string, plan: import("@/lib/pack").UnitPlan | undefined) => {
    setPackState((p) => ({
      ...p,
      buildings: p.buildings.map((b) =>
        b.id !== buildingId || !b.unitTypes ? b : {
          ...b,
          unitTypes: b.unitTypes.map((t) =>
            t.key !== typeKey || !t.subtypes ? t : {
              ...t,
              subtypes: t.subtypes.map((s) => (s.key === subtypeKey ? { ...s, plan } : s)),
            }
          ),
        }
      ),
    }));
  }, []);
  const unitMatrix = useCallback((_b: string): import("@/lib/authoring").UnitCell[][] => [], []);
  const setUnitMatrix = useCallback((_b: string, _m: import("@/lib/authoring").UnitCell[][]) => {}, []);
  const setGridShape = useCallback((_b: string, _s: { floors?: number; unitsPerFloor?: number }) => {}, []);

  // ---- units ----
  const setUnits = useCallback((buildingId: string, units: Unit[]) => {
    setPackState((p) => ({ ...p, buildingUnits: { ...p.buildingUnits, [buildingId]: units } }));
  }, []);

  // ---- media (marketing images) ----
  // One real item per building+slot: setMedia replaces any existing item for that slot (upload/generated).
  const setMedia = useCallback((item: MediaItem) => {
    setPackState((p) => {
      const rest = (p.media || []).filter((m) => !(m.buildingId === item.buildingId && m.slotKey === item.slotKey));
      return { ...p, media: [...rest, item] };
    });
  }, []);
  const removeMedia = useCallback((buildingId: string, slotKey: string) => {
    setPackState((p) => ({ ...p, media: (p.media || []).filter((m) => !(m.buildingId === buildingId && m.slotKey === slotKey)) }));
  }, []);
  // retired path: slot captions aren't modeled on the flat Pack — no-ops to satisfy the interface.
  const setSlotCaption = useCallback((_b: string, _k: string, _c: string) => {}, []);
  const slotCaption = useCallback((_b: string, _k: string) => "", []);

  // ---- terms ----
  const addTerms = useCallback(() => {
    let id = "";
    setPackState((p) => {
      id = uniqueId("terms", new Set(p.terms.map((t) => t.id)));
      return { ...p, terms: [...p.terms, { id, data: {} }] };
    });
    return id;
  }, []);
  const patchTerms = useCallback((id: string, data: Record<string, unknown>) => {
    setPackState((p) => ({ ...p, terms: p.terms.map((t) => (t.id === id ? { ...t, data } : t)) }));
  }, []);
  const removeTerms = useCallback((id: string) => {
    setPackState((p) => ({ ...p, terms: p.terms.filter((t) => t.id !== id) }));
  }, []);

  // ---- texts ----
  const setText = useCallback((key: string, value: string) => {
    setPackState((p) => ({ ...p, texts: { ...(p.texts || {}), [key]: value } }));
  }, []);
  const removeText = useCallback((key: string) => {
    setPackState((p) => {
      const { [key]: _drop, ...rest } = p.texts || {};
      return { ...p, texts: rest };
    });
  }, []);

  return useMemo<PackApi>(
    () => ({
      pack, selection, select, loadSeed, loadEmpty, loadMiracleTower, loadGenerated, loadProject, setPack,
      setDomain, patchDeveloper,
      addCompany, patchCompany, removeCompany,
      addComplex, patchComplex, removeComplex,
      addBuilding, patchBuilding, removeBuilding, setUnitTypes, setUnitSubtypes, setSubtypePlan,
      unitMatrix, setUnitMatrix, setGridShape,
      setUnits,
      setMedia, removeMedia, setSlotCaption, slotCaption,
      addTerms, patchTerms, removeTerms,
      setText, removeText,
    }),
    [
      pack, selection, select, loadSeed, loadEmpty, loadMiracleTower, loadGenerated, loadProject, setPack, setDomain, patchDeveloper,
      addCompany, patchCompany, removeCompany, addComplex, patchComplex, removeComplex,
      addBuilding, patchBuilding, removeBuilding, setUnitTypes, setUnitSubtypes, setSubtypePlan, unitMatrix, setUnitMatrix, setGridShape, setUnits,
      setMedia, removeMedia, setSlotCaption, slotCaption,
      addTerms, patchTerms, removeTerms, setText, removeText,
    ]
  );
}
