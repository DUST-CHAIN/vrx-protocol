// SELLER ENTITIES — developer-GLOBAL, reusable (§3 Option A). SERVER-ONLY (file-backed).
// building, NOT flat per-building fields. "Each building is run/signed under a (potentially different) company
// name + director details, so it must be per-building — but what was filled once is easy to repopulate later,
// as it's SAVED and can be RECALLED to fill in when setting up a new building." That is exactly the
// developer-global reusable-record-recalled-per-building shape: a library of seller entities; a building
// points at one via `Building.sellerEntityId`; a new building can pre-fill from a prior one.
// This is the SAME proven spine as lib/furniture-packs (developer-scoped, reusable-by-id, file-backed.data
// with a serialized mutate for the lost-write fix). The seller entity is the "Seller" party on the S&P
//. OFF-CHAIN developer business/payee data — it appears on the S&P (the seller must be identified to
// the buyer), which is expected and correct; it stays off-chain, only hashes/refs ever touch a seal.

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { SellerEntity, PaymentOption, PaymentMethodKind } from "./catalog-client";

export type { SellerEntity, PaymentOption, PaymentMethodKind } from "./catalog-client";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "seller-entities.json");

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: SellerEntity[]) => Promise<{ next: SellerEntity[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<SellerEntity[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as SellerEntity[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: SellerEntity[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const PAYMENT_KINDS: readonly PaymentMethodKind[] = ["bank", "crypto", "card", "other"];
const MAX_PAYMENT_OPTIONS = 12; // sane cap — a developer offering >12 rails per building is a data-entry mistake

/** Normalise one incoming payment option into the stored shape. `kind`/`label`/`destination` are
 * required (an option with no destination is meaningless); id is reused if a valid non-blank one is supplied,
 * else minted. Returns null for a structurally-unusable option so the caller can drop it quietly. */
function cleanPaymentOption(raw: unknown): PaymentOption | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = (PAYMENT_KINDS as readonly string[]).includes(str(r.kind, 12))
    ? (str(r.kind, 12) as PaymentMethodKind)
    : null;
  const label = str(r.label, 120);
  const destination = str(r.destination, 200);
  if (!kind || !label || !destination) return null;
  const id = str(r.id, 40) || `pm-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const instructions = str(r.instructions, 400);
  const out: PaymentOption = { id, kind, label, destination };
  if (instructions) out.instructions = instructions;
  return out;
}

/** Normalise an incoming `paymentOptions` menu: coerce an array, clean each, drop unusable ones, cap the
 * count. `bankPayable` back-compat MIGRATION: if the payload supplies NO usable options but DOES carry
 * a legacy `bankPayable` string, synthesize one `bank` option from it — so an existing entity gains the menu
 * on its first re-save with no developer action. Returns undefined when there is nothing to store (keeps the
 * "absent, not empty-array" discipline the rest of this module follows). */
function cleanPaymentOptions(raw: unknown, bankPayable: string | undefined): PaymentOption[] | undefined {
  const incoming = Array.isArray(raw)
    ? raw.map(cleanPaymentOption).filter((o): o is PaymentOption => o !== null).slice(0, MAX_PAYMENT_OPTIONS)
    : [];
  if (incoming.length > 0) return incoming;
  const legacy = (bankPayable ?? "").trim();
  if (legacy) {
    return [{ id: `pm-${Date.now()}-${randomBytes(3).toString("hex")}`, kind: "bank", label: "Bank transfer", destination: legacy }];
  }
  return undefined;
}

/** Normalise an incoming seller-entity payload into the stored shape (id/developer applied by the caller).
 * `label` + `companyName` are required (an entity with neither is meaningless); every other field optional
 * and absent when blank (never stored as ""). Exported + unit-tested so a malformed payload can't corrupt
 * the store. Throws on a missing required field (route → 400). */
export function cleanSellerEntity(raw: unknown): {
  label: string;
  companyName: string;
  companyNameTH?: string;
  address?: string;
  addressTH?: string;
  email?: string;
  telephone?: string;
  taxId?: string;
  directorName?: string;
  bankPayable?: string;
  paymentOptions?: PaymentOption[];
} {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const label = str(r.label, 120);
  const companyName = str(r.companyName, 200);
  if (!label) throw new Error("label required");
  if (!companyName) throw new Error("companyName required");

  const opt = (v: unknown, max: number) => {
    const s = str(v, max);
    return s === "" ? undefined : s;
  };
  const bankPayable = opt(r.bankPayable, 200);
  const out = {
    label,
    companyName,
    companyNameTH: opt(r.companyNameTH, 200),
    address: opt(r.address, 400),
    addressTH: opt(r.addressTH, 400),
    email: opt(r.email, 200),
    telephone: opt(r.telephone, 60),
    taxId: opt(r.taxId, 60),
    directorName: opt(r.directorName, 200),
    bankPayable,
    // developer's accepted-destination menu; migrates a legacy `bankPayable` into one `bank` option.
    paymentOptions: cleanPaymentOptions(r.paymentOptions, bankPayable),
  };
  // Strip undefined keys so a cleared field vanishes from the stored JSON (no `"x": undefined` noise).
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as typeof out;
}

/** — the ONE resolver for "what payment destinations does this seller offer?" Shared by the hard-require
 * gate (slice 2), the §2 contract term (slice 4) and the buyer picker (slice 5) so no two surfaces can
 * disagree about whether a payee exists (the §2↔ledger one-rule discipline, mirroring `instalmentDueDate`).
 *
 * Reads `paymentOptions` first; if a stored entity predates (has only the legacy `bankPayable` and was
 * never re-saved through `cleanSellerEntity`), it is migrated READ-SIDE here too, so the gate and the S&P see
 * the same destination even before the next write. Returns [] for a null/empty entity (fail-closed — an
 * entity-less deal has no destination, which the gate then blocks). */
export function resolvePaymentOptions(entity: SellerEntity | null | undefined): PaymentOption[] {
  if (!entity) return [];
  const stored = Array.isArray(entity.paymentOptions) ? entity.paymentOptions : [];
  if (stored.length > 0) return stored;
  const legacy = (entity.bankPayable ?? "").trim();
  if (legacy) return [{ id: `pm-legacy-${entity.id}`, kind: "bank", label: "Bank transfer", destination: legacy }];
  return [];
}

/** slice 2 — the signable invariant: a deal can only reach `final`/ready-to-sign if its seller entity
 * states at least one payment destination. True = has a usable payee; false = the gate must block (no signed
 * S&P may ever silently omit where to pay). A thin predicate over `resolvePaymentOptions` so the gate and the
 * invariant test assert the exact same thing. */
export function hasUsablePaymentDestination(entity: SellerEntity | null | undefined): boolean {
  return resolvePaymentOptions(entity).length > 0;
}

/** All seller entities owned by a developer (scope) — the library they pick / recall from. */
export async function listEntitiesForDeveloper(developer: string): Promise<SellerEntity[]> {
  const d = developer.trim().toLowerCase();
  return (await readAll()).filter((e) => e.developer.toLowerCase() === d);
}

/** A single entity by id (whatever developer owns it) — what the S&P resolves for `Building.sellerEntityId`. */
export async function getEntity(id: string): Promise<SellerEntity | null> {
  const want = id.trim();
  if (!want) return null;
  return (await readAll()).find((e) => e.id === want) ?? null;
}

/** Create or update an entity (developer-scoped). An incoming id that isn't this developer's is refused. */
export async function saveEntity(
  developer: string,
  input: { id?: string } & Record<string, unknown>
): Promise<SellerEntity> {
  const dev = developer.trim();
  const fields = cleanSellerEntity(input);

  return mutate(async (list) => {
    const id = str(input.id, 40);
    if (id) {
      const idx = list.findIndex((e) => e.id === id);
      if (idx >= 0) {
        if (list[idx].developer.toLowerCase() !== dev.toLowerCase()) throw new Error("not your entity");
        const next = list.slice();
        next[idx] = { id, developer: next[idx].developer, ...fields };
        return { next, ret: next[idx] };
      }
    }
    const entity: SellerEntity = {
      id: id || `seller-${Date.now()}-${randomBytes(3).toString("hex")}`,
      developer: dev,
      ...fields,
    };
    return { next: [...list, entity], ret: entity };
  });
}

/** Delete an entity (developer-scoped). No-op if it isn't this developer's. Note: a building still pointing at
 * it keeps a dangling `sellerEntityId` — the S&P resolver is absent-safe (a missing entity reads as "no
 * seller attached"), so this never corrupts a building; the developer just re-picks one. */
export async function deleteEntity(developer: string, id: string): Promise<boolean> {
  const dev = developer.trim().toLowerCase();
  return mutate(async (list) => {
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0 || list[idx].developer.toLowerCase() !== dev) return { next: list, ret: false };
    return { next: list.filter((e) => e.id !== id), ret: true };
  });
}
