// Off-chain DEVELOPER REGISTRY — SERVER-ONLY (file-backed, touches the filesystem).
//
// WHY this exists (the missing link the agent picker needs): the chain stores developers as neutral
// Node account ids only and the catalog (lib/catalog.ts) keys buildings by a demo id — nothing
// connects "which on-chain developer account lists which buildings". The picker needs exactly that
// mapping to scope an agent to the developers their agency has access to. So this registry is that
// mapping: developer NEAR account id → display name → the building ids they list.
//
// This is the OFF-CHAIN "information gate" the read-privacy model calls for (vrx-read-privacy-model):
// the chain gates who can BOOK (on-chain gate + exclusive enforcement); this registry + the catalog
// gate who can even SEE a developer's human-readable listings. Enumeration is a deliberate off-chain
// seam — the contract never lists developers; each client keeps the mapping it needs.
//
// Built GENERIC (the #3 path): add a row to grow the marketplace — more developers, each owning
// their own buildings — with no code change. Seeded with #1 (one developer → both demo towers) to match
// the current live testnet rig (vvv-dev-01.testnet). File under portal/.data (gitignored), mirroring
// lib/catalog.ts + lib/applications.ts. Swap to SQLite/KV later without changing the exported surface.
//
// PRIVACY: a developer's account id is a neutral on-chain handle and is public anyway; the display
// name is a demo label. No PII here. The SENSITIVE mapping this protects is "which buildings" — served
// only to a gated agency by the API, never to outsiders.

import { promises as fs } from "fs";
import path from "path";
import type { TerminationTerms } from "./termination-terms";

export type Developer = {
  /** The developer's on-chain Node account id (neutral handle). */
  account: string;
  /** Human display name shown in the picker (demo label — not on-chain). */
  name: string;
  /** Catalog building ids (lib/catalog.ts) this developer lists. */
  buildingIds: string[];
  /**  §8-4 — the DIRECT-SALE offer-eligibility balance bar for THIS developer's desk, in USD. A direct
   *  buyer must hold a wallet balance ≥ this before they can make an offer (the "serious buyer" filter).
   *  PER-DEVELOPER by deliberate design (not a global env) so each desk tunes its own bar. Absent =
   *  DEFAULT_DIRECT_THRESHOLD_USD ($1 test default; $500 is the production figure the design names). */
  directSaleThresholdUsd?: number;
  /**  §9 step 9 — the developer's HOUSE ORG account: the on-chain org (agency) the firm-hold
   *  for a direct buyer is granted to. The direct-sales desk IS the developer's captive in-house agency
 *, and the contract models that as a plain Org (register_org, lib.rs §register_org doc).
   *  Registered on-chain once per developer: owner signs register_org(houseOrg, ref), then the developer
   *  signs grant_gate(houseOrg, scope). Absent = the desk has not set up its house org yet → the firm-hold
 * action is unavailable (the route fails closed). A neutral account id; no PII. */
  houseOrgAccount?: string;
  /** the buyer-profile fields THIS developer requires before a direct buyer can offer on its units
   *  (keys of BuyerDirectProfile, e.g. "passportNo"). PER-DEVELOPER by design: a project needing more KYC
   *  raises its own bar without affecting others. Absent/empty = the DEFAULT required set (legalName +
   *  nationality + phone, lib/buyers-direct DEFAULT_REQUIRED_PROFILE_FIELDS). The config UI lands in
   *  Phase 3; the field + resolver exist now so the readiness check can already be per-developer. */
  requiredProfileFields?: string[];
  /** the VRX PROTOCOL sales-commission rate (%) for THIS developer, the fee VRX earns on a sale it
 * facilitates. PER-DEVELOPER by design: the rate is a term of the VRX↔developer onboarding agreement.
 * That full agreement (a new consumer of the spine) isn't built yet; this field is the interim source
   *  of the rate so the earmark/accrual arc can resolve it now, and the onboarding-agreement arc can later feed
   *  it here without changing earmark's shape. Absent = DEFAULT_PROTOCOL_FEE_PCT (0.5%, the midpoint of the
 * 0.2–0.8% band). Distinct from the AGENCY commission (lib/commission) and the on-chain per-call toll. */
  protocolFeePct?: number;
  /**  §3b — the VRX commission UNLOCK clock: how many WORKING DAYS after a unit leaves `available` (and
   *  is not reversed back) the developer owes VRX its protocol fee. The VRX cut does NOT use the agency's
 * `unlockPct` %-threshold (that's the agency gate, §3) — VRX's is a time-based clock. Like
   *  `protocolFeePct` this is PER-DEVELOPER (a term of the VRX↔developer onboarding agreement) and lives here
   *  as the interim source until that full agreement is built — the clock resolver (lib/payment-ledger
   *  `resolveVrxClock`) reads it now, the agreement feeds it here later with no shape change. Absent =
   *  DEFAULT_VRX_SETTLE_WORKING_DAYS (14). "Working days" = business days (weekends skipped; a holiday
   *  calendar is a named later refinement, not invented here — §3b honesty discipline). */
  vrxSettleWorkingDays?: number;
  /**  §config-surface — the developer's HOUSE DEFAULT buyer-default / termination clause
   *  numbers (threshold %, cure-day floor, interest % p.a.) for the §Default-and-Termination section of the
   *  buyer↔developer S&P. OWNED BY THE DEVELOPER (their own terms toward their customers — NOT VRX-set; that
   *  distinguishes it from protocolFeePct/vrxSettleWorkingDays above, which ARE VRX's terms). This is the
   *  MIDDLE tier of the 3-tier chain (building override → THIS → code default, see termination-terms
   *  resolveTerminationChain). Each field optional; an absent/invalid field falls through to the code default.
   *  Absent entirely = the developer uses the real-SPA code defaults (12.5% / 30d / 15% p.a.). */
  terminationTerms?: Partial<TerminationTerms>;
};

/** The default direct-sale balance bar (USD) when a developer sets no `directSaleThresholdUsd`. Test value
 * $1 (§8-4 — "test default $1 / prod $500"); a desk raises it per-developer for a real deployment. */
export const DEFAULT_DIRECT_THRESHOLD_USD = 1;

/** The default VRX protocol fee (%) when a developer sets no `protocolFeePct` — 0.5%, the midpoint of the
 * 0.2–0.8% band. A real onboarding sets the per-developer rate; this keeps the arc honest without one. */
export const DEFAULT_PROTOCOL_FEE_PCT = 0.5;

/**  §3b — the default VRX settlement window in WORKING DAYS when a developer sets no
 * `vrxSettleWorkingDays` (: 14 working days after a unit leaves `available`). A real VRX↔developer
 *  onboarding may set a different per-developer window; this keeps the clock honest without one. */
export const DEFAULT_VRX_SETTLE_WORKING_DAYS = 14;

/** The effective direct-sale balance bar (USD) for a developer — their configured value or the default. */
export function directSaleThresholdUsd(dev: Developer | null | undefined): number {
  const v = dev?.directSaleThresholdUsd;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_DIRECT_THRESHOLD_USD;
}

/** The effective VRX protocol fee (%) for a developer — their configured rate or the default (0.5%). Always a
 *  finite positive percentage ≤ 100 (a bad/absent value falls back to the default, never 0 or NaN). */
export function protocolFeePct(dev: Developer | null | undefined): number {
  const v = dev?.protocolFeePct;
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100 ? v : DEFAULT_PROTOCOL_FEE_PCT;
}

/**  §3b — the effective VRX settlement window (WORKING DAYS) for a developer — their configured value or
 *  the default (14). Always a finite positive integer (a bad/absent/zero value falls back to the default — a
 *  0-working-day window would mean "payable the instant a unit leaves available", which is never a real term). */
export function vrxSettleWorkingDays(dev: Developer | null | undefined): number {
  const v = dev?.vrxSettleWorkingDays;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_VRX_SETTLE_WORKING_DAYS;
}

/** The developer's house-org account for direct-sale firm-holds, trimmed, or null if unset. The
 *  firm-hold grant_exclusive(unit_key, houseOrg, window) is only available once this is set (the route and
 *  the UI both fail closed on null — a desk must register + gate its house org on-chain first). */
export function houseOrgFor(dev: Developer | null | undefined): string | null {
  const v = dev?.houseOrgAccount;
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "developers.json");

async function readStore(): Promise<Developer[] | null> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Developer[]) : null;
  } catch {
    return null;
  }
}

async function writeStore(list: Developer[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** All registered developers — seeded on first read if the store doesn't exist yet. */
export async function listDevelopers(): Promise<Developer[]> {
  const existing = await readStore();
  if (existing) return existing;
  const seed = buildSeed();
  await writeStore(seed);
  return seed;
}

export async function getDeveloper(account: string): Promise<Developer | null> {
  return (await listDevelopers()).find((d) => d.account === account) ?? null;
}

/** Add or update a developer row (the generic "add your own developers/buildings later" path). */
export async function saveDeveloper(dev: Developer): Promise<void> {
  const list = await listDevelopers();
  const idx = list.findIndex((d) => d.account === dev.account);
  if (idx < 0) list.push(dev);
  else list[idx] = dev;
  await writeStore(list);
}

// ── Seed (#1: one developer → both demo towers) ──────────────────────────────────────────────
// Matches the live testnet rig: vvv-dev-01.testnet is the developer that stamped both buildings and
// holds the gates the demo agencies use. Growing to many developers is just more rows here.
function buildSeed(): Developer[] {
  return [
    {
      account: "vvv-dev-01.testnet",
      name: "Summit Estates",
      buildingIds: ["miracle-tower", "oceanview"],
    },
  ];
}
