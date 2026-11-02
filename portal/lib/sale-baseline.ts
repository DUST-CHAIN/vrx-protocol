// when VRX signs with a developer, VRX promises to run all deals on units marked AVAILABLE through the
// system and earn commission. Onboarding establishes a CLEAN SLATE — every unit stamped into its correct
// (existing) status — and THIS record is the attested anchor that starts the commission clock: "count
// commissions from that day on". A sale counts only if its booking landed AFTER `establishedAt`; the units
// already sold AT baseline are provably excluded (they were sold at the slate, not sold THROUGH VRX).
// ── What it is / is NOT ────────────────────────────────────────────────────────────────────────────────
// It is NOT the on-chain stamp (that's stamp_tiles / stamp_tile on the contract, node-signed — the batch
// publish UI is a separate, later step). It is the OFF-CHAIN attested fact that "on date D, developer X and
// VRX established building B's slate with this available set" — the thing commission-eligibility reads. The
// stamps mirror reality on-chain; this record is the agreed starting line for the money.
// ── Ownership (DEVELOPER-owned) ────────────────────────────────────────────────────────────────────────
// Only the building's own developer establishes its baseline (the developer whose buildingIds include it —
// deskDeveloperFor, same resolution as the desk). The route enforces caller == that developer. A baseline is
// per (developer, building): one developer can own many buildings, each with its own slate + date.
// ── Re-establishing ────────────────────────────────────────────────────────────────────────────────────
// Re-running onboarding UPDATES the available set + re-seals, but — importantly — PRESERVES the original
// `establishedAt` (the commission clock does NOT reset when the developer later corrects the unit set; the
// relationship's start date is fixed at first establishment). A deliberate re-baseline (new relationship /
// reset) is a future explicit action, not an accidental side-effect of editing the unit list.
// ── The seal spine ─────────────────────────────────────────────────────────────────────────
// 7th consumer of the attested-record spine (offers → agreements → agent-roster buyers → buyers-direct →
// unit-grants → direct-deposits → THIS). Salted seal (lib/seal) over the stable fields so "developer X
// established building B on date D with available set S" is tamper-evident (✓ verifiable).
// PRIVACY: SERVER-ONLY; neutral developer account + opaque building/unit ids only. No PII, no prices,
// nothing on-chain. Serialized writes (lost-write guard).

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";

const BASELINE_DOMAIN = "vrx-sale-baseline";

/** A commission baseline for one (developer, building): the agreed clean-slate start. */
export type SaleBaseline = {
  /** The owning developer account (lowercased — store key half). */
  developer: string;
  /** The catalog building id (verbatim — building ids are NOT lowercased elsewhere). */
  building: string;
  /** The units marked AVAILABLE at the slate (catalog Unit.id, sorted + de-duped). The set the commission
   * promise covers from the baseline forward. Sold/closed/blocked units are NOT in here (they don't count). */
  availableUnits: string[];
  /** ms epoch the baseline was FIRST established — THE commission-clock anchor. Fixed across re-establishes. */
  establishedAt: number;
  /** Per-record secret salt (hex) for the seal. NEVER on-chain. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify({developer,building,availableUnits,establishedAt})) — the seal. */
  sealHash: string;
  /** ms epoch last updated (available-set corrections / re-seal). */
  updatedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "sale-baselines.json");

// Serialized writes (lost-write guard) — a developer may re-establish while a read is in flight.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: SaleBaseline[]) => { next: SaleBaseline[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<SaleBaseline[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SaleBaseline[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: SaleBaseline[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const normAccount = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const normId = (s: unknown) => (typeof s === "string" ? s.trim() : "");

/** Sort + de-dupe a unit-id list (so the sealed set is canonical regardless of input order/dupes). */
function canonUnits(units: unknown): string[] {
  if (!Array.isArray(units)) return [];
  const set = new Set<string>();
  for (const u of units) {
    const id = normId(u);
    if (id) set.add(id);
  }
  return Array.from(set).sort();
}

/** The sealed payload — the stable fields the seal protects (establishedAt included: the anchor is part of
 * the attested fact, so a changed start date is a tamper, not a silent re-write). */
function baselinePayload(b: Pick<SaleBaseline, "developer" | "building" | "availableUnits" | "establishedAt">) {
  return {
    developer: b.developer,
    building: b.building,
    // join into a single stable string so stableStringify sees a primitive, not a nested array (matches the
    // "flat map" shape the other seals use; order is already canonical via canonUnits).
    availableUnits: b.availableUnits.join(","),
    establishedAt: b.establishedAt,
  };
}

const key = (dev: string, bld: string) => `${dev} ${bld}`;

/**
 * Establish (or re-establish) the baseline for (developer, building). Idempotent on the pair: a first call
 * fixes `establishedAt = now`; a later call UPDATES `availableUnits` + re-seals but PRESERVES the original
 * `establishedAt` (the commission clock never resets on a unit-set correction). Returns the record, or null
 * if developer/building is missing.
 *
 * The CALLER (route) MUST enforce: `developer` is the building's owning developer. This store is a pure
 * record — it does not read the chain, the catalog, or the developer registry.
 */
export async function establishBaseline(input: {
  developer: string;
  building: string;
  availableUnits: string[];
}): Promise<SaleBaseline | null> {
  const dev = normAccount(input.developer);
  const bld = normId(input.building);
  const units = canonUnits(input.availableUnits);
  if (!dev || !bld) return null;

  return mutate((list) => {
    const idx = list.findIndex((x) => key(x.developer, x.building) === key(dev, bld));
    if (idx >= 0) {
      const prev = list[idx];
      // Preserve the ORIGINAL establishedAt — a re-establish corrects the set, it does not reset the clock.
      const updated: SaleBaseline = {
        ...prev,
        availableUnits: units,
        sealHash: digest(
          baselinePayload({ developer: dev, building: bld, availableUnits: units, establishedAt: prev.establishedAt }),
          BASELINE_DOMAIN,
          prev.salt
        ),
        updatedAt: Date.now(),
      };
      const next = [...list];
      next[idx] = updated;
      return { next, ret: updated };
    }
    const salt = newSalt();
    const now = Date.now();
    const rec: SaleBaseline = {
      developer: dev,
      building: bld,
      availableUnits: units,
      establishedAt: now,
      salt,
      sealHash: digest(
        baselinePayload({ developer: dev, building: bld, availableUnits: units, establishedAt: now }),
        BASELINE_DOMAIN,
        salt
      ),
      updatedAt: now,
    };
    return { next: [...list, rec], ret: rec };
  });
}

/**
 * RE-SEAL a baseline with a new `establishedAt` — the dated-backfill post-pass. `establishedAt` is
 * INSIDE the sealed payload (baselinePayload above), so re-dating it by a bare overwrite would make the
 * record fail its own ✓-verify (a tamper). This recomputes `sealHash` with the record's OWN salt via the
 * exact same digest the establish path uses, so the re-dated baseline verifies cleanly. Returns a NEW record
 * (pure — the caller persists). `updatedAt` bumps to mark the re-seal.
 *
 * Use ONLY for seeded baselines in the backfill (re-sealing a real attested baseline would erase its tamper
 * evidence). The caller asserts seed-ownership.
 */
export function resealBaselineWithDate(prev: SaleBaseline, establishedAt: number): SaleBaseline {
  return {
    ...prev,
    establishedAt,
    sealHash: digest(
      baselinePayload({ developer: prev.developer, building: prev.building, availableUnits: prev.availableUnits, establishedAt }),
      BASELINE_DOMAIN,
      prev.salt
    ),
    updatedAt: Date.now(),
  };
}

/** The baseline for a (developer, building), or null if none established yet. */
export async function getBaseline(developer: string, building: string): Promise<SaleBaseline | null> {
  const dev = normAccount(developer);
  const bld = normId(building);
  if (!dev || !bld) return null;
  return (await readAll()).find((x) => key(x.developer, x.building) === key(dev, bld)) ?? null;
}

/** All baselines a developer has established (across buildings), newest-established first. */
export async function baselinesForDeveloper(developer: string): Promise<SaleBaseline[]> {
  const dev = normAccount(developer);
  if (!dev) return [];
  return (await readAll()).filter((x) => x.developer === dev).sort((a, b) => b.establishedAt - a.establishedAt);
}

/**
 * The commission-clock gate the future per-sale check will read: is a sale that landed at `saleAtMs` within
 * the baseline for (developer, building)? True iff a baseline exists AND the sale is AT-OR-AFTER establishedAt.
 * No baseline established → false (fail closed: no established relationship = no commission counted). Pure.
 *
 * NOTE: this does NOT yet check the unit is in `availableUnits` — whether commission is gated by "unit was in
 * the slate" vs "any sale after the date" is a per-sale policy decision deferred with the commission wiring
 * (scope). This helper answers the DATE half (the "from that day on" anchor) only.
 */
export async function isAfterBaseline(
  developer: string,
  building: string,
  saleAtMs: number
): Promise<boolean> {
  if (!Number.isFinite(saleAtMs)) return false;
  const b = await getBaseline(developer, building);
  if (!b) return false;
  return saleAtMs >= b.establishedAt;
}

/** The ✓-verifiable check: re-hash the baseline's stable fields with its salt and compare to its seal. */
export function verifyBaseline(x: SaleBaseline): boolean {
  try {
    if (!x?.salt || !x?.sealHash) return false;
    return (
      digest(
        baselinePayload({
          developer: x.developer,
          building: x.building,
          availableUnits: x.availableUnits,
          establishedAt: x.establishedAt,
        }),
        BASELINE_DOMAIN,
        x.salt
      ) === x.sealHash
    );
  } catch {
    return false;
  }
}
