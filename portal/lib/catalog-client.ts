"use client";

// Client-side catalog access — the browser half of the off-chain demo catalog.
// lib/catalog.ts is SERVER-ONLY (it imports `fs`), so a client component can't import its types
// without dragging `fs` into the bundle. This module re-declares the shapes structurally and fetches
// them through /api/catalog. Keep these types in sync with lib/catalog.ts (they're the same records).
// THE ON-CHAIN SEAM ( privacy): a catalog Unit maps to its on-chain tile via a single canonical
// reference string `<buildingId>/<unitId>` (e.g. "miracle-tower/unit-812"), hashed with hashRef(ref,
// "vrx-unit") → the opaque unit_key the contract stores. The SAME ref+domain is what the agent screen
// hashes, so a unit stamped from the developer roster is the exact tile an agent books. The catalog
// (price/size/images) never touches the chain — only the hash does.

import type { PriceRounding } from "./price-rounding";

export type PaymentTerms = {
  bookingFee: number[];
  depositPct: number[];
  onContract: { installments: number; amountPct: number }[];
  ongoing: { installments: number; amountPct: number }[];
  frequencyDays: number[];
  onKeyPct: number[];
  taxPct: number[];
  /** Days to sign the SPA after reserving. */
  contractDays?: number;
  /** Optional fitted-furniture package price per m² (USD); 0/absent = not offered. */
  furniturePerSqmUsd?: number;
  /** If furniture is ordered, its full cost is due BEFORE this instalment number (developer cash-flow). */
  furnitureDueBeforeInstalment?: number;
  /** Developer-set caps the A4 calculator enforces. */
  caps?: {
    depositPctMin?: number;
    depositPctMax?: number;
    onContractPctMin?: number;
    onContractPctMax?: number;
    onKeyPctMin?: number;
    onKeyPctMax?: number;
    instalmentsMin?: number;
    instalmentsMax?: number;
    instalmentsDefault?: number;
  };
};

// Staged floor-area: a unit's m² is measured at distinct lifecycle stages; each figure exists only
// once its stage is reached. beforeBuilding = plan/pre-sale · afterBuilding = as-built · final = the
// surveyed Land-Office area (set just before the transfer meeting). See catalog.ts for the full note.
export type StagedSqm = {
  beforeBuilding?: number;
  afterBuilding?: number;
  final?: number;
};

/** Freehold vs company prices for a unit — usually different; the buyer-type selector picks. */
export type UnitPricing = {
  freeholdUsd?: number;
  companyUsd?: number;
};

export type Unit = {
  id: string;
  type: string;
  floor: number;
  /** Current authoritative size (latest staged figure; kept for quick access + back-compat). */
  sqm: number;
  /** Staged floor-area over the lifecycle. */
  sqmStages?: StagedSqm;
  /** Base price in USD (headline/default). Convert for display via lib/currency.ts. */
  priceUsd: number;
  /** Freehold vs company prices; present on quota buildings. */
  pricing?: UnitPricing;
  note?: string;
  unitNumber?: number;
  subtype?: string;
  view?: string;
  corner?: boolean;
  baths?: number;
  /** Per-unit terms override; absent = inherit building default. */
  terms?: PaymentTerms;
  // NOTE: no per-unit ownership tag — ownership is the buyer's, not the unit's. The foreign quota
  // is a building-level number (Building.foreign*Sqm).
  /** Developer off-market state — OFF-CHAIN, developer-only. See OffMarket. */
  offMarket?: OffMarket;
  /** Audit trail of PAST off-market episodes, kept after release so the story survives. */
  offMarketHistory?: OffMarketEvent[];
  /** — optional per-unit map pin override (villa/townhouse/plot). Absent = inherit the building's geo. */
  geo?: BuildingGeo;
  // live on-chain tile status baked by the server (0 open · 1 hold · 2 closed · 3 done · -1 not
  // stamped). Present when fetched via fetchBuilding (one server read for the whole building); absent
  // on the summary list (fetchCatalog). The client seeds its grid from this — ZERO direct RPC reads.
  status?: number;
};

// Off-market developer state — OFF-CHAIN, developer-only. Mirror of lib/catalog.ts. A unit
// taken off-market (blocked) or regulatorily removed (killed). NEVER touches the chain, NEVER overrides a
// live on-chain reservation: only an open/unstamped tile can be blocked; live holds go through the
export type OffMarketState = "blocked" | "killed";

export type BlockCategory =
  | "executive-hold"
  | "affiliate-hold"
  | "external-party"
  | "vip-hold"
  | "phase-pricing"
  | "company-shop"
  | "regulatory"
  | "other";

export type OffMarketEvent = {
  action: "block" | "kill" | "unblock" | "unkill";
  reason: string;
  category: BlockCategory;
  by: string;
  at: number;
  confirmedBy?: string;
  newPriceUsd?: number;
};

export type OffMarket = {
  state: OffMarketState;
  reason: string;
  category: BlockCategory;
  by: string;
  at: number;
  confirmedBy?: string;
  history: OffMarketEvent[];
};

/** Human labels for the block-reason taxonomy. Shared by developer UI. */
export const BLOCK_CATEGORY_LABEL: Record<BlockCategory, string> = {
  "executive-hold": "Executive / owner hold",
  "affiliate-hold": "Affiliated company",
  "external-party": "Reserved for known buyer",
  "vip-hold": "VIP hold",
  "phase-pricing": "Hold for later / higher price",
  "company-shop": "Reserved for company / shop",
  regulatory: "Regulatory",
  other: "Other",
};

export type UnitType = {
  key: string;
  label: string;
  sqmMin: number;
  sqmMax: number;
  floorplan?: string;
};

export type Building = {
  id: string;
  name: string;
  tagline: string;
  developer: string;
  area: string;
  address: string;
  type: string;
  stories: number;
  units: number;
  reservationFeeUsd: number;
  maintenancePerSqmUsd: number;
  amenities: string[];
  completion: string;
  unitTypes: UnitType[];
  inventory: Unit[];
  terms?: PaymentTerms;
  bookingDepositUsd?: number;
  sinkingFundPerSqmUsd?: number;
  transferFeePct?: string;
  constructionEnd?: string;
  /** Total sellable floor area (m²) — quota tracked only if present. Current authoritative figure. */
  sellableSqm?: number;
  /** Staged total sellable area over the lifecycle. */
  sellableSqmStages?: StagedSqm;
  /** Lifecycle stage — drives which staged m² is authoritative + whether the area true-up applies. */
  stage?: "presale" | "built" | "final";
  /** Foreign-freehold cap % (default 49 when sellableSqm present). */
  foreignQuotaPct?: number;
  /** Foreign-quota running totals. */
  foreignSoldSqm?: number;
  foreignCommittedSqm?: number;
  localSoldSqm?: number;
  /** Developer-editable ownership-bucket labels; absent = Freehold/Company/Private. */
  quotaLabels?: { freehold?: string; company?: string; private?: string };
  /** Map location + access road(s) — OFF-CHAIN, developer-authored, public. Absent = no map. */
  geo?: BuildingGeo;
  /** Construction/handover schedule → S&P, building-specific. Empty/absent = neutral fallback. */
  constructionTimeline?: BuildingMilestone[];
  /** Soft MIN–MAX commission band for NEW agreements. Mirrors lib/catalog.TermsEnvelope.
   * SOFT: flags out-of-range, never blocks. Bounds only new proposals; sealed snapshots are frozen. */
  termsEnvelope?: TermsEnvelope;
  // ── Building Setup record — mirrors the groups on lib/catalog.Building. All optional +
  // absent-safe. The seller-entity identity block is a reusable record referenced by id (sellerEntityId). ──
  project?: BuildingProject;
  physical?: BuildingPhysical;
  fees?: BuildingFees;
  land?: BuildingLand;
  sellerEntityId?: string;
  /** Direct-Sales Desk visibility ( §9 step 2). Absent/visible:false = invisible to direct buyers. */
  directSale?: BuildingDirectSale;
  /** Per-building override of the buyer-default / termination clause numbers (§config-surface,
   * ). Mirrors lib/catalog.Building.terminationTerms — the TOP tier of the 3-tier chain (building →
   * developer house default → code default). Absent = inherit the developer house default. */
  terminationTerms?: TerminationClauseTerms;
  /** DISPLAY-price rounding — a developer's choice to show clean quotes without touching the
   * EXACT stored `priceUsd`. Applied only at the listing/card layer (lib/price-rounding.roundForDisplay),
   * BEFORE currency conversion. Absent = the code default (nearest_1000). Storage stays exact. */
  priceRounding?: PriceRounding;
};

/** The buyer-default / termination clause numbers ( §config-surface). Mirrors lib/termination-terms
 * TerminationTerms as a client-safe partial (each field optional — a tier may set only some). */
export type TerminationClauseTerms = { defaultThresholdPct?: number; cureDays?: number; interestPctPerAnnum?: number };

/** Construction-timeline milestone. Mirrors lib/catalog.BuildingMilestone. */
export type BuildingMilestone = { label: string; when: string; projected?: boolean };

// ── Building Setup group types. Mirror lib/catalog.* — client-safe copies. ──
export type BuildingProject = {
  startConst?: string;
  endConst?: string;
  completeWithinMonths?: number;
  phase?: string;
  status?: "planning" | "building" | "complete";
};
export type BuildingPhysical = { landArea?: string; carParks?: number; floorToCeiling?: string };
export type BuildingFees = { sinkingFundPerSqmUsd?: number; camAdvanceMonths?: number };
export type BuildingLand = {
  titleDeedNum?: string;
  surveyPageNum?: string;
  landNumber?: string;
  address?: string;
  addressTH?: string;
  clauseText?: string;
};

/** Direct-Sales Desk per-building visibility ( §9 step 2). Mirrors lib/catalog.BuildingDirectSale. */
export type BuildingDirectSale = { visible: boolean; funnelCopy?: string };

/** The developer's soft MIN–MAX commission band. Mirrors lib/catalog.TermsEnvelope. */
export type TermsEnvelope = { commissionMinPct?: number; commissionMaxPct?: number };

/** Classify a commission % against an envelope (pure, shared by the authoring form + the terms surfaces).
 * Returns `below`/`above` when the rate falls outside a defined bound, else null (in band / no envelope). */
export function checkEnvelope(pct: number, env?: TermsEnvelope | null): "below" | "above" | null {
  if (!env || !Number.isFinite(pct)) return null;
  if (typeof env.commissionMinPct === "number" && pct < env.commissionMinPct) return "below";
  if (typeof env.commissionMaxPct === "number" && pct > env.commissionMaxPct) return "above";
  return null;
}

/** Human one-liner for an envelope ("3–5%", "at least 3%", "up to 5%"), or null if neither bound is set. */
export function envelopeLabel(env?: TermsEnvelope | null): string | null {
  if (!env) return null;
  const { commissionMinPct: lo, commissionMaxPct: hi } = env;
  if (typeof lo === "number" && typeof hi === "number") return `${lo}–${hi}%`;
  if (typeof lo === "number") return `at least ${lo}%`;
  if (typeof hi === "number") return `up to ${hi}%`;
  return null;
}

/** A reusable developer-GLOBAL furniture pack: authored once, attached to one or many
 * buildings via `buildingIds`. Per-unit cost = sum of items (lib/furniture). Mirrors lib/furniture-packs. */
export type FurniturePack = {
  id: string;
  /** Owning developer account (scope). */
  developer: string;
  label: string;
  items: FurnitureItem[];
  /** Buildings this pack is offered on ("if developer marked it so"). Empty = authored but not yet attached. */
  buildingIds: string[];
};

/** One priced line within a furniture pack. Exactly one basis applies. */
export type FurnitureItem =
  | { label: string; basis: "flat"; priceUsd: number }
  | { label: string; basis: "per_sqm"; ratePerSqmUsd: number };

/** A reusable SELLER-ENTITY record (§3 Option A) — the developer's selling company identity + payee
 * details, authored ONCE and referenced by any number of buildings via `Building.sellerEntityId`. Same
 * developer-global, reusable-by-id spine as FurniturePack: each building is run/signed under a (possibly
 * different) company, but what's filled once can be recalled to pre-fill a new building (§3). This
 * is the "Seller" party on the S&P. OFF-CHAIN developer business/payee data — appears on the S&P (the seller
 * must be identified to the buyer) which is expected; it stays off-chain, only hashes/refs ever seal. */
/** How the developer ACCEPTS payment — a prescribed destination the buyer can be told to pay to.
 * This is the developer's PER-BUILDING KYC data (set upfront, admin can't edit). It is the
 * §2 contract TERM ("where/how to pay"), distinct from the §5 per-payment `method` enum in payment-vault,
 * which records how a payment OBSERVABLY arrived. The two reconcile ( slice 4), they are not the same.
 * `destination` (bank acct / crypto addr / card number) is OFF-CHAIN only — it appears on the S&P to the
 * buyer (correct — they must know where to pay) but never touches a seal. Listing a `crypto` NEAR address
 * does NOT imply an in-app transfer (none exists yet — Rail A is deferred); the buyer pays off-platform and
 * records it, same as every other method today. */
export type PaymentMethodKind = "bank" | "crypto" | "card" | "other";
export type PaymentOption = {
  /** Stable id — the buyer's pick + the ledger reference bind to this. */
  id: string;
  kind: PaymentMethodKind;
  /** Buyer-facing name, e.g. "Bangkok Bank (THB)", "USDC on NEAR". */
  label: string;
  /** The account / address / card number — off-chain, (never on a seal). */
  destination: string;
  /** Optional free text — "reference your booking ref", a memo tag, etc. */
  instructions?: string;
};

export type SellerEntity = {
  id: string;
  /** Owning developer account (scope). */
  developer: string;
  /** Short label the developer picks this entity by (e.g. "Platinum Hill Co."). */
  label: string;
  companyName: string;
  companyNameTH?: string;
  address?: string;
  addressTH?: string;
  email?: string;
  telephone?: string;
  taxId?: string;
  directorName?: string;
  /** Who cheques/transfers are made payable to (bank/payee line). LEGACY single free-text payee;
   * superseded by `paymentOptions`. Kept for back-compat; migrated to one `bank` option on first save. */
  bankPayable?: string;
  /** Developer-authored menu of ACCEPTED payment destinations. Absent/empty = not yet signable
   * (the hard-require gate, slice 2). A legacy `bankPayable` migrates in here as one `bank` option. */
  paymentOptions?: PaymentOption[];
};

/** A building's map location + the main access road(s) to it. Mirrors lib/catalog.BuildingGeo. */
export type BuildingGeo = {
  lat: number;
  lng: number;
  /** Optional place label shown on the map (distinct from the postal `address`). */
  label?: string;
  /** Main access road(s)/approach — each a polyline of [lat,lng] points (a single point allowed). */
  accessRoads?: AccessRoad[];
  // ── Site plan ( layer 1). All optional/absent-safe — mirrors lib/catalog.BuildingGeo. ──
  /** Land PARCEL boundary polygon ([lat,lng] points, auto-closed on render). */
  landPolygon?: [number, number][];
  /** Building FOOTPRINT polygon ([lat,lng] points, auto-closed). Layer 2's level plan aligns onto this. */
  footprintPolygon?: [number, number][];
  /** Orientation compass bearing in degrees (0–359, 0 = north). Drives the north arrow + E/W sun marks. */
  northBearing?: number;
};

export type AccessRoad = {
  name?: string;
  /** Ordered [lat, lng] points. ≥2 = a line; 1 = a single marked point. */
  path: [number, number][];
};

/** Currently-authoritative m² from a staged figure: latest stage present (final → after → before),
 * else `fallback` (the flat `sqm`). Each stage exists only once reached. */
export function currentSqm(stages: StagedSqm | undefined, fallback: number): number {
  if (!stages) return fallback;
  return stages.final ?? stages.afterBuilding ?? stages.beforeBuilding ?? fallback;
}

/**
 * Area true-up owed at the Land-Office transfer: the FINAL surveyed m² usually differs
 * from the contracted (before-building) m², and since the unit is priced per m², the parties settle the
 * difference on transfer day. Returns the signed USD amount + direction, or null if it can't be computed
 * yet (no final figure, or no contracted figure to compare). Positive `amountUsd` = buyer pays the
 * developer; negative = developer refunds the buyer. This is a DISPLAY/known-owed figure — the actual
 * money movement belongs to the settlement arc, not this demo.
 */
export function areaTrueUp(
  unit: Unit,
  pricePerSqmUsd: number
): { deltaSqm: number; amountUsd: number; payer: "buyer" | "developer" | "none" } | null {
  const contracted = unit.sqmStages?.beforeBuilding;
  const final = unit.sqmStages?.final;
  if (contracted == null || final == null) return null;
  const deltaSqm = Math.round((final - contracted) * 100) / 100;
  const amountUsd = Math.round(deltaSqm * pricePerSqmUsd);
  const payer = amountUsd > 0 ? "buyer" : amountUsd < 0 ? "developer" : "none";
  return { deltaSqm, amountUsd, payer };
}

// Realistic off-plan caps + contract window. Applied as a FALLBACK so the A4 calculator has sane
// bounds even for catalog rows seeded before caps existed (avoids a re-import). A developer's own caps
// (once the ingest path sets them) take precedence.
const FALLBACK_CAPS = {
  depositPctMin: 0.5,
  depositPctMax: 5,
  onContractPctMin: 10,
  onContractPctMax: 40,
  onKeyPctMin: 30,
  onKeyPctMax: 60,
  instalmentsMin: 1,
  instalmentsMax: 48,
} as const;

/** Terms that apply to a unit: its own override, else the building default, with realistic
 * off-plan caps + a contract-sign window filled in as a fallback. */
export function effectiveTerms(building: Building, unit: Unit): PaymentTerms | null {
  const base = unit.terms ?? building.terms ?? null;
  if (!base) return null;
  return {
    ...base,
    contractDays: base.contractDays ?? 7,
    caps: { ...FALLBACK_CAPS, ...(base.caps ?? {}) },
  };
}

export type BuildingImages = {
  exterior: string[];
  interior: string[];
  facilities: string[];
  floorplans: string[];
};

/** The canonical on-chain reference for a unit — hash THIS with hashRef(ref, "vrx-unit"). */
export function unitRef(buildingId: string, unitId: string): string {
  return `${buildingId}/${unitId}`;
}

/** All buildings (summary list), scoped to the viewer's entitled buildings server-side (Security Pass #3,
 *): pass the viewer's account so the server returns only buildings they own / are gated to (god-mode
 * on localnet returns all regardless). Omit `account` only for a genuinely unscoped/legacy caller. */
export async function fetchCatalog(account?: string | null): Promise<Building[]> {
  const q = account ? `?account=${encodeURIComponent(account)}` : "";
  const res = await fetch(`/api/catalog${q}`);
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const json = (await res.json()) as { buildings: Building[] };
  return json.buildings;
}

/** Per-building summary stats for the building cards (availability from the snapshot; no chain reads). */
export type BuildingSummary = {
  id: string;
  name: string;
  area: string;
  tagline: string;
  stories: number;
  total: number;
  available: number;
  sold: number;
  onHold: number;
  unknown: number;
  /** Units present in the snapshot but not stamped on-chain (status -1) — real inventory, not yet listed. */
  notListed: number;
  /** Units the developer has taken off-market (blocked) — inventory, but not sellable. */
  offMarket: number;
  hasSnapshot: boolean;
  snapshotAt: number | null;
  /** — true if the developer has placed this building on the map (drives a card chip; coords not here). */
  hasGeo?: boolean;
  /** The building's representative photo (hero) for the card banner — null when it has no media yet. */
  heroImage?: string | null;
  priceMinUsd: number;
  priceMaxUsd: number;
  /** The building's DISPLAY-rounding choice, carried so the card range reads as clean quotes without
   * rounding the EXACT stored figures. Absent/null = the code default (nearest_1000). */
  priceRounding?: PriceRounding | null;
  types: { key: string; label: string; sqmMin: number; sqmMax: number }[];
  /** Foreign-freehold quota picture — present only when the developer configured a quota.
   * Both sides: foreign (the 49% cap) + local (the ≥51%), each with sold% + m² left, plus the
   * undeclared floating pool that makes the foreign figure an estimate. */
  freehold?: {
    pct: number;
    sellableSqm: number;
    foreign: { capSqm: number; availableSqm: number; soldPct: number };
    local: { capSqm: number; availableSqm: number; soldPct: number };
    undeclaredUnits: number;
    foreignIsEstimate: boolean;
  } | null;
};

/** Per-building summary stats, scoped server-side to the viewer's entitled buildings (Security Pass #3,
 *): pass the viewer's account (god-mode on localnet returns all). Omit only for a legacy caller. */
export async function fetchSummary(account?: string | null): Promise<BuildingSummary[]> {
  const q = account ? `?account=${encodeURIComponent(account)}` : "";
  const res = await fetch(`/api/catalog/summary${q}`);
  if (!res.ok) throw new Error(`summary ${res.status}`);
  const json = (await res.json()) as { buildings: BuildingSummary[] };
  return json.buildings;
}

/**
 * One building + its resolved image URLs. Status is LAZY by default (A1): the returned units carry NO
 * `status` — paint the grid from specs instantly, then fill status via fetchUnitsStatus (progressive,
 * with a spinner). Pass `live=true` for "Live" mode: the server bakes every unit's on-chain status now
 * (a complete snapshot, slower). `fresh=true` (Live only) forces a fresh chain read — use after a stamp.
 */
export async function fetchBuilding(
  id: string,
  opts: { live?: boolean; fresh?: boolean; account?: string | null } = {}
): Promise<{
  building: Building;
  images: BuildingImages | null;
  statusAsOf?: number | null;
  statusCached?: boolean;
  lazy?: boolean;
  /** Persisted snapshot (lazy mode): known statuses + when they were captured. */
  snapshot?: { units: Record<string, number>; filledAt: number; unitAt?: Record<string, number> } | null;
}> {
  const params = new URLSearchParams({ building: id });
  if (opts.live) params.set("status", "full");
  if (opts.live && opts.fresh) params.set("fresh", "1");
  // Security Pass #3: the viewer's account scopes this full-detail read server-side (god-mode on
  // localnet returns all). A non-entitled caller gets a 404 — same as a missing building (no leak).
  if (opts.account) params.set("account", opts.account);
  const res = await fetch(`/api/catalog?${params.toString()}`);
  if (!res.ok) throw new Error(`building ${res.status}`);
  return (await res.json()) as {
    building: Building;
    images: BuildingImages | null;
    statusAsOf?: number | null;
    statusCached?: boolean;
    lazy?: boolean;
    snapshot?: { units: Record<string, number>; filledAt: number; unitAt?: Record<string, number> } | null;
  };
}

/**
 * Fetch on-chain status for a specific set of units (a progressive chunk or one clicked unit, A1).
 * Merges into + is served from the shared server cache. Returns { unitId: code } (-1 = unknown).
 */
export async function fetchUnitsStatus(
  buildingId: string,
  unitIds: string[],
  fresh = false,
  account?: string | null
): Promise<{
  status: Record<string, number>;
  asOf: number | null;
  /** true = the RPC was unreachable; values are the persisted snapshot (UI: "network busy, as of …"). */
  busy?: boolean;
  source?: "chain" | "snapshot" | "cache";
  rpcError?: boolean;
}> {
  if (unitIds.length === 0) return { status: {}, asOf: null };
  const params = new URLSearchParams({ building: buildingId, units: unitIds.join(",") });
  if (fresh) params.set("fresh", "1");
  // Security Pass #3: scope the unit-level status read to the viewer's entitled buildings.
  if (account) params.set("account", account);
  const res = await fetch(`/api/catalog/status?${params.toString()}`);
  if (!res.ok) return { status: {}, asOf: null, rpcError: true };
  return (await res.json()) as {
    status: Record<string, number>;
    asOf: number | null;
    busy?: boolean;
    source?: "chain" | "snapshot" | "cache";
    rpcError?: boolean;
  };
}

/** Bust the server status cache for a building (call after a stamp confirms). Fire-and-forget. */
export async function invalidateBuildingStatus(id: string): Promise<void> {
  try {
    await fetch("/api/catalog/invalidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ building: id }),
    });
  } catch {
    /* best-effort */
  }
}

// Price display moved to lib/currency.ts (USD base + user-selectable display currency).

/**
 * Precise, compact "how long ago" for a captured-at timestamp (staleness of cached availability).
 * e.g. "just now", "42 sec ago", "58 min 32 sec ago", "3 hr 12 min ago", "2 d ago".
 */
export function timeAgo(epochMs: number | null | undefined): string {
  if (!epochMs) return "unknown";
  const totalSecs = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (totalSecs < 5) return "just now";
  if (totalSecs < 60) return `${totalSecs} sec ago`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return `${mins} min ${secs} sec ago`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hrs < 24) return `${hrs} hr ${remMin} min ago`;
  const days = Math.floor(hrs / 24);
  return `${days} d ago`;
}

/** Orange accent used for staleness/"last cached" hints. */
export const CACHED_ORANGE = "#e0953a";
