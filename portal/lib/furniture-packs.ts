// FURNITURE PACKS — developer-GLOBAL, reusable. SERVER-ONLY (file-backed).
//
// "developer can store and recall multiple furniture packs GLOBALLY because those can be offered to
// one or MANY buildings (if developer marked it so)." So a furniture pack is NOT building-owned — it's a
// developer-level asset authored ONCE and ATTACHED to any number of buildings via `buildingIds` (the "marked
// it so" list, kept WITH the pack = one source of truth for the mapping). The S&P generator resolves, for a
// given building, the developer's packs whose buildingIds include it, and computes each pack's per-unit cost
// from the unit's m² (lib/furniture). Cost is never frozen into the pack.
//
// Same file-backed.data pattern + serialized mutate (lost-write fix) as catalog.ts / kyc-vault.ts.
// OFF-CHAIN, developer-authored. Not PII (a furniture menu is commercial, not personal).

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { FurniturePack, FurnitureItem } from "./catalog-client";

export type { FurniturePack, FurnitureItem } from "./catalog-client";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "furniture-packs.json");

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: FurniturePack[]) => Promise<{ next: FurniturePack[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<FurniturePack[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as FurniturePack[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: FurniturePack[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/** Validate + normalise incoming pack line items. Drops items without a label or a valid non-negative figure. */
export function cleanItems(raw: unknown): FurnitureItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FurnitureItem[] = [];
  for (const ir of raw.slice(0, 40)) {
    const it = (ir && typeof ir === "object" ? ir : {}) as Record<string, unknown>;
    const label = str(it.label, 120);
    if (!label) continue;
    if (it.basis === "per_sqm") {
      const rate = num(it.ratePerSqmUsd);
      if (!Number.isFinite(rate) || rate < 0) continue;
      out.push({ label, basis: "per_sqm", ratePerSqmUsd: Math.round(rate) });
    } else {
      const price = num(it.priceUsd);
      if (!Number.isFinite(price) || price < 0) continue;
      out.push({ label, basis: "flat", priceUsd: Math.round(price) });
    }
  }
  return out;
}

/** All packs owned by a developer (scope). */
export async function listPacksForDeveloper(developer: string): Promise<FurniturePack[]> {
  const d = developer.trim().toLowerCase();
  return (await readAll()).filter((p) => p.developer.toLowerCase() === d);
}

/** The packs ATTACHED to a building (whatever developer owns them) — what the S&P offers for that building. */
export async function packsForBuilding(buildingId: string): Promise<FurniturePack[]> {
  const b = buildingId.trim();
  return (await readAll()).filter((p) => p.buildingIds.includes(b));
}

/** Create or update a pack (developer-scoped). An incoming id that isn't this developer's is refused. */
export async function savePack(
  developer: string,
  input: { id?: string; label: string; items: unknown; buildingIds?: unknown }
): Promise<FurniturePack> {
  const dev = developer.trim();
  const label = str(input.label, 120);
  if (!label) throw new Error("label required");
  const items = cleanItems(input.items);
  if (items.length === 0) throw new Error("a pack needs at least one priced item");
  const buildingIds = Array.isArray(input.buildingIds)
    ? Array.from(new Set(input.buildingIds.map((b) => str(b, 80)).filter(Boolean)))
    : [];

  return mutate(async (list) => {
    const id = str(input.id, 40);
    if (id) {
      const idx = list.findIndex((p) => p.id === id);
      if (idx >= 0) {
        if (list[idx].developer.toLowerCase() !== dev.toLowerCase()) throw new Error("not your pack");
        const next = list.slice();
        next[idx] = { ...next[idx], label, items, buildingIds };
        return { next, ret: next[idx] };
      }
    }
    const pack: FurniturePack = {
      id: id || `pack-${Date.now()}-${randomBytes(3).toString("hex")}`,
      developer: dev,
      label,
      items,
      buildingIds,
    };
    return { next: [...list, pack], ret: pack };
  });
}

/** Delete a pack (developer-scoped). No-op if it isn't this developer's. */
export async function deletePack(developer: string, id: string): Promise<boolean> {
  const dev = developer.trim().toLowerCase();
  return mutate(async (list) => {
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0 || list[idx].developer.toLowerCase() !== dev) return { next: list, ret: false };
    return { next: list.filter((p) => p.id !== id), ret: true };
  });
}

/** Toggle a pack's attachment to a building (developer-scoped). The "marked it so" action. */
export async function setPackBuilding(
  developer: string,
  id: string,
  buildingId: string,
  attached: boolean
): Promise<FurniturePack | null> {
  const dev = developer.trim().toLowerCase();
  const b = buildingId.trim();
  return mutate(async (list) => {
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0 || list[idx].developer.toLowerCase() !== dev) return { next: list, ret: null };
    const has = list[idx].buildingIds.includes(b);
    const buildingIds = attached
      ? has
        ? list[idx].buildingIds
        : [...list[idx].buildingIds, b]
      : list[idx].buildingIds.filter((x) => x !== b);
    const next = list.slice();
    next[idx] = { ...next[idx], buildingIds };
    return { next, ret: next[idx] };
  });
}
