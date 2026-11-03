// REUSE OPS — export / import / duplicate / save-as-template at EVERY level (developer · complex · building).
// the design docs §2a + §3a, stage 3. Reuse is the whole point of the tree: a complex of 4
// near-identical buildings = author one, export it, re-import to clone; a developer+empty-complex saved once is
// reloaded next session instead of re-entered.
//
// ONE generic pattern applied at three levels (craft rule: build the reusable seam once, not the Nth instance):
//   exportEntity(node)          → a self-contained, versioned JSON envelope for ANY level
//   importEntity(project, env)  → fold a building/complex/developer envelope INTO the current project (fresh ids)
//   duplicateBuilding(project)  → importEntity(exportEntity(active building)) into the same complex ("Copy of …")
//
// The pure core (this top half) is React-free + unit-tested. The TEMPLATE SLOT store (bottom half) is the one
// impure corner (localStorage) — named exported-entity JSON under mm:tpl:<level>:<name> — kept thin + separable.

import {
  type AuthoredProject, type AuthoredDeveloper, type AuthoredComplex, type AuthoredBuilding,
  activeBuilding, activeComplex, allBuildings, newBuilding,
} from "./project";
import type { GeoNode, ViewOverride } from "./pack";
import { slugify } from "./pack";

// ---------------------------------------------------------------------------
// The envelope — a versioned, level-tagged JSON wrapper so an import knows what it holds
// ---------------------------------------------------------------------------

export type EntityLevel = "developer" | "complex" | "building";

export interface EntityEnvelope<L extends EntityLevel = EntityLevel> {
  mm: "entity"; // a cheap magic marker so we can reject arbitrary JSON on import
  v: 1;
  level: L;
  exportedAt: string; // ISO — informational only
  data: L extends "developer" ? AuthoredDeveloper
      : L extends "complex" ? AuthoredComplex
      : AuthoredBuilding;
  // The §4d drawn geometry (Studio footprints) travels on a COMPLEX export ONLY, so cloning a whole development
  // carries its land + building footprints (geo-reuse). It's the PROJECT-ROOT tree (AuthoredProject.geo) —
  // geo nodes are a parallel tree not id-linked to authored buildings, so we carry the whole tree, not a per-
  // building subtree. On import its node ids are freshened to avoid colliding with any geo already in the target.
  // Omitted (undefined) for developer/building exports + for a complex with no drawn geo.
  geo?: GeoNode[];
  overrides?: ViewOverride[];
}

// ---------------------------------------------------------------------------
// exportEntity — snapshot any level as a self-contained envelope
// ---------------------------------------------------------------------------

export function exportDeveloper(dev: AuthoredDeveloper): EntityEnvelope<"developer"> {
  return envelope("developer", clone(dev));
}

/** A complex envelope carries ITS buildings (so a 4-building development clones whole) AND the project's drawn
 *  §4d geo tree when present (footprints travel with the development). `geo`/`overrides` come from the project
 *  root (the store passes `p.geo`/`p.overrides`); omit them to export a complex without its footprints. */
export function exportComplex(cx: AuthoredComplex, geo?: GeoNode[], overrides?: ViewOverride[]): EntityEnvelope<"complex"> {
  const env = envelope("complex", clone(cx));
  if (geo?.length) env.geo = clone(geo);
  if (overrides?.length) env.overrides = clone(overrides);
  return env;
}

/** A building envelope is self-contained (types+matrix+overrides+layouts+media). It does NOT carry geo — a drawn
 * footprint is a parallel tree not keyed to one authored building, so geo reuse rides the COMPLEX level. */
export function exportBuilding(b: AuthoredBuilding): EntityEnvelope<"building"> {
  return envelope("building", clone(b));
}

/** Export the project's ACTIVE building (convenience for the duplicate/export-this-building affordance). */
export function exportActiveBuilding(p: AuthoredProject): EntityEnvelope<"building"> | undefined {
  const b = activeBuilding(p);
  return b ? exportBuilding(b) : undefined;
}

function envelope<L extends EntityLevel>(level: L, data: EntityEnvelope<L>["data"]): EntityEnvelope<L> {
  return { mm: "entity", v: 1, level, exportedAt: new Date().toISOString(), data } as EntityEnvelope<L>;
}

// ---------------------------------------------------------------------------
// importEntity — fold an envelope into the current project, with FRESH ids
// ---------------------------------------------------------------------------

/** Validate an untrusted JSON blob as an entity envelope. Returns null (never throws) for anything unexpected. */
export function parseEnvelope(json: unknown): EntityEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const e = json as Partial<EntityEnvelope>;
  if (e.mm !== "entity" || e.v !== 1) return null;
  if (e.level !== "developer" && e.level !== "complex" && e.level !== "building") return null;
  if (!e.data || typeof e.data !== "object") return null;
  return e as EntityEnvelope;
}

/** The result of an import: the new project + the id of whatever was added (so the UI can select it). */
export interface ImportResult {
  project: AuthoredProject;
  addedId: string | null; // the fresh building id (building/complex imports) — null for a developer swap
  level: EntityLevel;
}

/**
 * Fold an envelope INTO the current project:
 *  - building  → ADD a copy to the ACTIVE complex (fresh id, "Copy of …" if a clash), select it.
 *  - complex   → ADD the development as a NEW complex (fresh complex id + fresh building ids), select its first
 * building. (with N complexes, importing a development ADDS it rather than replacing — clone a
 *                4-building complex, re-import to stand up a sibling development.)
 *  - developer → REPLACE the developer identity block (buildings untouched).
 * Pure. Never mutates the input project. Fresh ids come from the existing names via slugify + a uniqueness pass,
 * deduped across EVERY complex so the flat Pack projection never collides.
 */
export function importEntity(p: AuthoredProject, env: EntityEnvelope): ImportResult {
  if (env.level === "developer") {
    const dev = clone(env.data as AuthoredDeveloper);
    return { project: { ...p, developer: { ...dev, id: p.developer.id } }, addedId: null, level: "developer" };
  }
  if (env.level === "complex") {
    const cx = clone(env.data as AuthoredComplex);
    const usedCx = new Set(p.complexes.map((c) => c.id));
    const usedB = new Set(allBuildings(p).map((b) => b.id));
    const buildings = (cx.buildings || []).map((b) => freshBuilding(b, usedB));
    if (!buildings.length) buildings.push(freshBuilding(newBuilding(), usedB));
    const newCx: AuthoredComplex = { ...cx, id: uniqueId(slugify(cx.name || cx.id || "development"), usedCx), buildings };
    // fold the carried §4d geo into the target (fresh node ids so it never collides with the target's own geo)
    const { geo, overrides } = mergeGeo(p.geo, p.overrides, env.geo, env.overrides);
    return {
      project: {
        ...p,
        complexes: [...p.complexes, newCx],
        activeBuildingId: newCx.buildings[0]?.id || p.activeBuildingId,
        geo, overrides,
      },
      addedId: newCx.buildings[0]?.id ?? null,
      level: "complex",
    };
  }
  // building — add a copy to the ACTIVE complex
  const cx = activeComplex(p);
  if (!cx) return { project: p, addedId: null, level: "building" };
  const used = new Set(allBuildings(p).map((b) => b.id)); // dedup across ALL complexes (flat pack ids)
  const copy = freshBuilding(clone(env.data as AuthoredBuilding), used, cx.buildings);
  return {
    project: {
      ...p,
      complexes: p.complexes.map((c) => (c.id === cx.id ? { ...c, buildings: [...c.buildings, copy] } : c)),
      activeBuildingId: copy.id,
    },
    addedId: copy.id,
    level: "building",
  };
}

// ---------------------------------------------------------------------------
// duplicateBuilding — the headline reuse op (guarded: needs something loaded)
// ---------------------------------------------------------------------------

/**
 * Duplicate the active building within the current complex: exportBuilding → importEntity (building). The copy
 * gets a fresh id + a "Copy of …" name and becomes active. ⚠ Guarded: a no-op (returns the same project, addedId
 * null) if nothing is loaded (: "duplicate can't work if data isn't yet loaded"). Pure.
 */
export function duplicateBuilding(p: AuthoredProject): ImportResult {
  const env = exportActiveBuilding(p);
  if (!env) return { project: p, addedId: null, level: "building" };
  return importEntity(p, env);
}

// ---------------------------------------------------------------------------
// id + name freshness
// ---------------------------------------------------------------------------

/** Clone a building, giving it a unique id (and, if it would clash by NAME with a sibling, a "Copy of …" name). */
function freshBuilding(b: AuthoredBuilding, used: Set<string>, siblings?: AuthoredBuilding[]): AuthoredBuilding {
  const nameClash = siblings?.some((s) => s.name === b.name) ?? false;
  const name = nameClash ? copyName(b.name, siblings!) : b.name;
  const id = uniqueId(slugify(name || b.id || "building"), used);
  used.add(id);
  return { ...b, id, name };
}

// ---------------------------------------------------------------------------
// geo merge — fold a carried §4d geo tree into the target with FRESH node ids
// ---------------------------------------------------------------------------

/** Merge an incoming geo tree (+ its overrides) into the target project's geo. Every incoming node gets a FRESH
 *  unique id (so it can't collide with geo already in the target); parentId links and override nodeIds are rewritten
 *  through the SAME id map, so the subtree stays internally consistent (no orphaned parentId, no dangling override).
 *  Returns the combined {geo, overrides} (undefined when empty, matching the store's "cleared board → undefined").
 *  PURE. Note: geo nodes are a parallel tree not keyed to authored buildings, so there's nothing to re-link to the
 *  freshly-imported buildings — we carry the drawn footprints verbatim (just de-collided), which is the whole tree. */
export function mergeGeo(
  targetGeo: GeoNode[] | undefined,
  targetOverrides: ViewOverride[] | undefined,
  incomingGeo: GeoNode[] | undefined,
  incomingOverrides: ViewOverride[] | undefined,
): { geo: GeoNode[] | undefined; overrides: ViewOverride[] | undefined } {
  if (!incomingGeo?.length) {
    return { geo: targetGeo, overrides: targetOverrides };
  }
  const used = new Set((targetGeo || []).map((n) => n.id));
  const idMap = new Map<string, string>();
  for (const n of incomingGeo) {
    const fresh = uniqueId(n.id, used);
    used.add(fresh);
    idMap.set(n.id, fresh);
  }
  const remapped: GeoNode[] = incomingGeo.map((n) => ({
    ...n,
    id: idMap.get(n.id)!,
    parentId: n.parentId != null ? (idMap.get(n.parentId) ?? n.parentId) : undefined,
  }));
  const remappedOverrides: ViewOverride[] = (incomingOverrides || [])
    .filter((o) => idMap.has(o.nodeId)) // drop overrides whose node isn't in the carried tree
    .map((o) => ({ ...o, nodeId: idMap.get(o.nodeId)! }));

  const geo = [...(targetGeo || []), ...remapped];
  const overrides = [...(targetOverrides || []), ...remappedOverrides];
  return { geo: geo.length ? geo : undefined, overrides: overrides.length ? overrides : undefined };
}

/** "Tower A" → "Copy of Tower A", then "Copy of Tower A (2)" … avoiding existing sibling names. */
function copyName(name: string, siblings: AuthoredBuilding[]): string {
  const base = `Copy of ${name}`;
  if (!siblings.some((s) => s.name === base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!siblings.some((s) => s.name === candidate)) return candidate;
  }
}

/** A slug that doesn't collide with `used` — appends -2, -3, … until free. */
export function uniqueId(base: string, used: Set<string>): string {
  const b = base || "building";
  if (!used.has(b)) return b;
  for (let n = 2; ; n++) {
    const candidate = `${b}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Structured-clone the node so the import can never alias the source (JSON-safe tree, no functions/Dates inside). */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// Template slots — named exported-entity JSON in localStorage (the one impure corner)
// ---------------------------------------------------------------------------
// A template is just a named EntityEnvelope. save-as-template = exportEntity → a named slot; load-template =
// importEntity from the slot. Keyspace mm:tpl:<level>:<name>, separate from the mm:project store. Guarded for
// non-browser (tsx tests) — the pure ops above are what the tests exercise; these are thin wrappers.

const TPL_PREFIX = "mm:tpl:";
const tplKey = (level: EntityLevel, name: string) => `${TPL_PREFIX}${level}:${slugify(name)}`;

function ls(): Storage | null {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

/** Persist an envelope under a named template slot. Returns the storage key (or null if no localStorage). */
export function saveTemplate(name: string, env: EntityEnvelope): string | null {
  const store = ls();
  if (!store) return null;
  const key = tplKey(env.level, name);
  try { store.setItem(key, JSON.stringify({ name, ...env })); return key; } catch { return null; }
}

export interface TemplateMeta {
  key: string;
  level: EntityLevel;
  name: string;
  exportedAt?: string;
}

/** List saved templates (optionally filtered to one level), newest-stored first isn't guaranteed — sorted by name. */
export function listTemplates(level?: EntityLevel): TemplateMeta[] {
  const store = ls();
  if (!store) return [];
  const out: TemplateMeta[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.startsWith(TPL_PREFIX)) continue;
    const env = parseEnvelope(safeParse(store.getItem(key)));
    if (!env) continue;
    if (level && env.level !== level) continue;
    const named = safeParse(store.getItem(key)) as { name?: string } | null;
    out.push({ key, level: env.level, name: named?.name || key.slice(TPL_PREFIX.length), exportedAt: env.exportedAt });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a template envelope by its storage key (null if missing/corrupt). */
export function loadTemplate(key: string): EntityEnvelope | null {
  const store = ls();
  if (!store) return null;
  return parseEnvelope(safeParse(store.getItem(key)));
}

export function deleteTemplate(key: string): void {
  ls()?.removeItem(key);
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
