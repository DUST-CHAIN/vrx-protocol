// MM → Catalog ingest, step 3: the STAGING + ACTIVATION store (design: the design docs
// + ingest-pack/README.md §"How VRX imports it").
//
// SERVER-ONLY (file-backed, touches the filesystem — mirrors lib/applications.ts + lib/catalog.ts). An
// ingest pack is a PROPOSAL, not a live edit: root uploads it, VRX parses it into catalog entities (the
// PURE lib/ingest-pack.ts reader), and the result SITS STAGED here until root VETS + ACTIVATES each
// building selectively. Nothing reaches the live catalog (.data/catalog.json) until activation. This is
// the gate the README describes ("Unactivated packs sit staged; on activate, units become stampable").
//
// WHY A SEPARATE STORE (not a flag on catalog.ts): the live catalog is the ACTIVE, buyer/agent-visible
// surface — it must stay exactly what it is today (a flat Building[]). Staging is a holding area with its
// OWN lifecycle (pending → active/discarded) that never leaks a half-vetted developer into the live set.
// On activate we MERGE one building into the live catalog via the pure stageIntoCatalog (ingest-pack.ts)
// — same supersede-by-id behaviour the fixture tests freeze.
//
// FINDING-1 FIX (S294b, built as a first-class feature not a workaround): an MM pack can carry a generic
// building id (e.g. "building") that would APPEND instead of SUPERSEDING the DB-seeded one. So activation
// takes an OPTIONAL target id (`asId`) — root confirms/remaps the real catalog id at the vetting step,
// before anything goes live. The remap is a natural part of "vet before activate", so it lives here.
//
// PURE CORE + thin fs wrapper: every decision (stage a parse result, mark a building active, remap an id,
// compute what merges into the live catalog) is a PURE function over plain records, unit-testable without
// fs/zip/browser. The exported async fns are a thin persistence skin over those (same split as catalog.ts).

import { promises as fs } from "fs";
import path from "path";
import type { Building } from "./catalog";
import { stageIntoCatalog, type IngestError, type IngestResult, type PackDeveloper } from "./ingest-pack";

// ── the staged record ────────────────────────────────────────────────────────────────────────────────
/** One building inside a staged pack + its vetting state. The Building is the PARSED catalog entity (the
 *  ingest reader's output); `packId` is the id it carried in the pack (may be generic, e.g. "building");
 *  `targetId` is the live-catalog id root will activate it UNDER (defaults to packId, remappable). */
export type StagedBuilding = {
  /** The id this building carried in the pack (ingest-pack.ts Building.id). */
  packId: string;
  /** The live-catalog id to activate under (finding-1 remap; defaults to packId until root changes it). */
  targetId: string;
  /** Display name (for the admin list — avoids re-reading the whole Building to render a row). */
  name: string;
  /** Unit count (admin list convenience). */
  units: number;
  /** Vetting state. "pending" = staged, not live; "active" = merged into the live catalog; "discarded". */
  state: "pending" | "active" | "discarded";
  /** The full parsed catalog Building — what gets merged into the live catalog on activate. */
  building: Building;
};

/** A whole staged pack: the developer + its complexes + each building's vetting state. Append-only list
 *  in the store; a new upload is a new StagedPack (root can discard an old one). */
export type StagedPack = {
  /** Unguessable id for this staged pack (also the record key). */
  id: string;
  /** When the pack was staged (ms epoch). */
  stagedAt: number;
  /** The pack's developer manifest (id/name/holding) — PUBLIC context, not PII. */
  developer: PackDeveloper;
  /** Complex tree (for the admin preview grouping) — id + name + building ids. */
  complexes: { id: string; name: string; buildings: string[] }[];
  /** Each building + its vetting state. */
  buildings: StagedBuilding[];
  /** Parse-time problems the reader collected (shown in the admin preview, non-fatal). */
  errors: IngestError[];
};

// ── PURE core ────────────────────────────────────────────────────────────────────────────────────────

/** A short, URL-safe id for a staged pack. Deterministic input isn't needed (it's just a handle). */
export function newStagedPackId(now = Date.now()): string {
  return `pack-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turn a PURE ingest parse result into a StagedPack ready to persist. Every building starts `pending`
 * (nothing is live until root activates it) and its targetId defaults to its packId (root remaps as part
 * of vetting — finding-1). No fs, no zip. `id`/`now` are injectable for deterministic tests.
 */
export function toStagedPack(res: IngestResult, id = newStagedPackId(), now = Date.now()): StagedPack {
  return {
    id,
    stagedAt: now,
    developer: res.developer,
    complexes: res.complexes.map((c) => ({ id: c.id, name: c.name, buildings: c.buildings })),
    buildings: res.buildings.map((b) => ({
      packId: b.id,
      targetId: b.id,
      name: b.name,
      units: b.inventory.length,
      state: "pending" as const,
      building: b,
    })),
    errors: res.errors,
  };
}

/**
 * Remap a staged building's target catalog id (finding-1: the MM pack's building id may be the generic
 * "building"; root sets the real slug, e.g. "skyline-tower", BEFORE activation so it SUPERSEDES the seed
 * instead of appending a 10th building). PURE — returns a new pack; does not mutate. No-op (returns the
 * same pack) if the packId isn't found. The remap only governs the ACTIVATION target; the parsed
 * Building.id inside is rewritten to match at activation time (activatePackBuilding), so the live catalog
 * is self-consistent.
 */
export function remapStagedTarget(pack: StagedPack, packId: string, asId: string): StagedPack {
  const nextId = asId.trim();
  if (!nextId) return pack;
  let changed = false;
  const buildings = pack.buildings.map((sb) => {
    if (sb.packId !== packId || sb.targetId === nextId) return sb;
    changed = true;
    return { ...sb, targetId: nextId };
  });
  return changed ? { ...pack, buildings } : pack;
}

/** The Building that actually gets merged into the live catalog for a staged building: the parsed entity
 *  with its id rewritten to the (possibly remapped) targetId. PURE. */
export function buildingForActivation(sb: StagedBuilding): Building {
  return sb.targetId === sb.building.id ? sb.building : { ...sb.building, id: sb.targetId };
}

/**
 * Compute the live catalog AFTER activating one staged building — merge it (under its targetId) into the
 * existing catalog via the pure stageIntoCatalog (ingest-pack.ts: supersede-by-id, else append). PURE:
 * returns the merged list + whether it superseded or added. The caller persists both the live catalog and
 * the staged building's new state. Separated from the store so it's unit-testable and reusable (admin
 * preview can call it to show "this will REPLACE skyline-tower" before committing).
 */
export function activateInto(existing: Building[], sb: StagedBuilding): {
  merged: Building[];
  effect: "superseded" | "added";
} {
  const { merged, superseded } = stageIntoCatalog(existing, [buildingForActivation(sb)]);
  return { merged, effect: superseded.length ? "superseded" : "added" };
}

/** Mark a staged building's state (PURE helper used after a successful activation / discard). */
export function withBuildingState(
  pack: StagedPack,
  packId: string,
  state: StagedBuilding["state"],
): StagedPack {
  const buildings = pack.buildings.map((sb) => (sb.packId === packId ? { ...sb, state } : sb));
  return { ...pack, buildings };
}

// ── file-backed store (thin skin over the pure core — mirrors lib/applications.ts) ─────────────────────
const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "catalog-staged.json");

async function readAll(): Promise<StagedPack[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StagedPack[]) : [];
  } catch {
    return []; // no file yet
  }
}

async function writeAll(list: StagedPack[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** All staged packs, newest first. */
export async function listStagedPacks(): Promise<StagedPack[]> {
  return (await readAll()).sort((a, b) => b.stagedAt - a.stagedAt);
}

/** Fetch one staged pack by id (null if unknown). */
export async function getStagedPack(id: string): Promise<StagedPack | null> {
  return (await readAll()).find((p) => p.id === id) ?? null;
}

/** Persist a parse result as a new staged pack (returns the stored record). Nothing goes live here. */
export async function stagePack(res: IngestResult): Promise<StagedPack> {
  const pack = toStagedPack(res);
  const list = await readAll();
  list.push(pack);
  await writeAll(list);
  return pack;
}

/** Overwrite a staged pack in place (used after a remap). No-op if the id is unknown. */
async function savePack(pack: StagedPack): Promise<void> {
  const list = await readAll();
  const idx = list.findIndex((p) => p.id === pack.id);
  if (idx < 0) return;
  list[idx] = pack;
  await writeAll(list);
}

/** Remap a staged building's activation target (finding-1). Returns the updated pack (or null if unknown). */
export async function setActivationTarget(packId: string, buildingPackId: string, asId: string): Promise<StagedPack | null> {
  const pack = await getStagedPack(packId);
  if (!pack) return null;
  const next = remapStagedTarget(pack, buildingPackId, asId);
  await savePack(next);
  return next;
}

/** Discard a whole staged pack (removes it from the staging store; the live catalog is untouched). */
export async function discardStagedPack(packId: string): Promise<boolean> {
  const list = await readAll();
  const next = list.filter((p) => p.id !== packId);
  if (next.length === list.length) return false;
  await writeAll(next);
  return true;
}

/**
 * ACTIVATE one staged building into the live catalog. This is the gate the README describes: the parsed
 * building (under its possibly-remapped targetId) is MERGED into .data/catalog.json via the pure
 * stageIntoCatalog, and the staged building is marked "active". Returns what happened (superseded/added +
 * the final target id) so the admin UI can report it. Null if the pack/building is unknown.
 *
 * Takes an OPTIONAL `asId` to remap-and-activate in one step (root confirms the real id at activation).
 * The live-catalog read/write go through the SAME helpers the catalog uses so the active surface stays the
 * single flat Building[] every reader already expects.
 */
export async function activatePackBuilding(
  packId: string,
  buildingPackId: string,
  asId?: string,
): Promise<{ targetId: string; effect: "superseded" | "added" } | null> {
  let pack = await getStagedPack(packId);
  if (!pack) return null;
  if (asId && asId.trim()) pack = remapStagedTarget(pack, buildingPackId, asId);
  const sb = pack.buildings.find((b) => b.packId === buildingPackId);
  if (!sb) return null;

  // merge into the live catalog (lazy import to avoid pulling catalog.ts's fs seed into pure-core consumers).
  const { getCatalog, saveBuilding } = await import("./catalog");
  const live = await getCatalog();
  const { effect } = activateInto(live, sb);
  // saveBuilding supersedes-or-appends by id — the same merge activateInto computed, applied to the store.
  await saveBuilding(buildingForActivation(sb));

  const next = withBuildingState(pack, buildingPackId, "active");
  await savePack(next);
  return { targetId: sb.targetId, effect };
}
