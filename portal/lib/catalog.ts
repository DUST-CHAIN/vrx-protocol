// Off-chain demo catalog â€” SERVER-ONLY (file-backed, touches the filesystem).
//
// The role dashboards (Developer populates/prices units; Agent browses them) need building/unit
// DETAIL + IMAGES that the contract deliberately never holds (privacy moat, â€” the chain stores only
// an opaque unit hash + status). So that data lives here, off-chain, in a file-backed JSON store under
// portal/.data (gitignored), mirroring lib/applications.ts. Swap to SQLite/KV later without changing
// the API surface. On-chain, a unit maps to its opaque unit_key = hashRef(<building>/<unit>, "vrx-unit").
//
// SEED DATA: ALL 9 real Vetted Realty developments imported from the the operator catalog db (read-only) â€”
// 1,558 live units with REAL specs (size, view, subtype, baths, corner) and prices derived from the
// real foreign price/sqm (rounded to clean demo figures; the real THB price never leaves off-chain,
// ). Two flagships are demo-renamed per (Miracle Tower = Garden Court Tower; Pearls View =
// Paradise Ocean View). Images come from the MM renderings via lib/mm.ts. The seed lives in the
// generated lib/catalog-seed.json (regenerate via `node scripts/import-drt.mjs`).

import { promises as fs } from "fs";
import path from "path";
import seed from "./catalog-seed.json";
import type { TerminationTerms } from "./termination-terms";
import type { PriceRounding } from "./price-rounding";

// Payment terms (models drt.payment_type + the pilot's option-array term sheet): the
// developer publishes ALLOWED options per category; the agent's offer picks ONE from each â†’ the
// concrete plan that gets hashed into the opaque request_hash. Building carries a default; a unit
// MAY override it entirely (effectiveTerms). booking fee in THB; deposit/onContract/ongoing/onKey/tax
// in %. Editable via the developer terms editor (A5).
export type PaymentTerms = {
  bookingFee: number[]; // reservation fee options (USD base); may include 0 = "Free"
  depositPct: number[]; // deposit % options
  onContract: { installments: number; amountPct: number }[]; // e.g. 1 Ã— 20%
  ongoing: { installments: number; amountPct: number }[]; // e.g. 24 Ã— 2%
  frequencyDays: number[]; // payment frequency options (days)
  onKeyPct: number[]; // final % on handover
  taxPct: number[]; // tax % options
  /** Days the customer has to sign the sale & purchase agreement after reserving. */
  contractDays?: number;
  /** Optional fitted-furniture package price per m² (USD); 0/absent = not offered. */
  furniturePerSqmUsd?: number;
  /** If furniture is ordered, its full cost is due BEFORE this instalment number (developer cash-flow). */
  furnitureDueBeforeInstalment?: number;
  /** Developer-set CAPS the A4 calculator enforces. Absent = sensible fallbacks. Percentages. */
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

// Staged floor-area: a unit's m² is measured at distinct lifecycle stages, and each figure
// only exists once its stage is reached — never before. `beforeBuilding` = the pre-construction/plan
// area (known at pre-sale); `afterBuilding` = the as-built area (known once built); `final` = the
// surveyed area used at the Land Office (set just BEFORE the land-office title-transfer meeting — "the
// final always comes before the land office meeting"). Absent stages simply haven't happened yet. The
// currently-authoritative area is the latest stage present (resolved via currentSqm/StagedSqm).
export type StagedSqm = {
  beforeBuilding?: number;
  afterBuilding?: number;
  final?: number;
};

// Dual pricing: freehold and company (local structure) usually carry DIFFERENT prices for
// the same unit. Both are stored; the buyer-type selector picks which applies. USD base (the UI converts
// to the user's chosen currency).
export type UnitPricing = {
  freeholdUsd?: number;
  companyUsd?: number;
};

export type Unit = {
  /** Stable id, e.g. "unit-1204". Also the human unit reference. */
  id: string;
  /** Unit-type key (links to UnitType.key). */
  type: string;
  floor: number;
  /** Current authoritative size in sqm (the latest staged figure; kept for back-compat + quick access). */
  sqm: number;
  /** Staged floor-area over the project lifecycle. Absent = only `sqm` is known. */
  sqmStages?: StagedSqm;
  /** Demo list price in USD (base currency; the UI converts to the user's chosen currency). For a
   *  quota building this is the DEFAULT/headline price; the bucket-specific prices live in `pricing`. */
  priceUsd: number;
  /** Freehold vs company prices. Present on quota buildings; the selector picks which shows. */
  pricing?: UnitPricing;
  /** Optional per-unit note (view, corner, etc.). */
  note?: string;
  // â”€â”€ Real the operator catalog structured fields (pulled generously so we're not stuck re-importing) â”€â”€
  /** Real unit number (e.g. 1204). */
  unitNumber?: number;
  /** Unit subtype letter (A/B/Câ€¦). */
  subtype?: string;
  /** Normalised view (e.g. "Sea view", "Pool view"). */
  view?: string;
  /** Corner unit. */
  corner?: boolean;
  /** Number of bathrooms. */
  baths?: number;
  /** Per-unit payment-terms OVERRIDE. Absent = inherit the building default. */
  terms?: PaymentTerms;
  // NOTE: a unit is NOT inherently "freehold"/"company"/"private" — ownership is a property of the
  // BUYER/sale (the operator catalog: pre_reservation.ownership T/F/C), chosen at reservation. So there is no per-unit
  // ownership tag. The foreign-freehold QUOTA is a building-level number (see Building.foreign*Sqm).
  /** Developer off-market state. Absent = on-market (normal). See OffMarket. */
  offMarket?: OffMarket;
  /** The audit trail of PAST off-market episodes, kept after a unit is released back to market so the
 * story survives for a later decision (reversible WITH context). Append-only; absent = never
   *  been off-market. */
  offMarketHistory?: OffMarketEvent[];
  /** optional PER-UNIT map pin (overrides the building's `geo` pin for this unit — e.g. a villa,
   *  a townhouse, a plot with its own location). Reuses BuildingGeo. Absent = the unit inherits the
   *  building's location. A tower unit normally has none (the building pin is the location). */
  geo?: BuildingGeo;
};

// Off-market developer state — OFF-CHAIN, developer-only. A unit a developer has taken off
// the market (blocked) or had regulatorily removed (killed). This NEVER touches the chain and NEVER
// overrides a live on-chain reservation (anti-fraud rule: you can only block/kill a unit whose
// on-chain tile is open/unstamped; a live hold/booking/sale must go through the recorded lawful
// cancellation door instead). Mirrors the operator catalog's `unit_status_id=6` (Blocked) + `unit_killed` flag.
export type OffMarketState = "blocked" | "killed";

// Real block-reason taxonomy decoded from the the operator catalog dump. Each is a distinct developer
// STRATEGY, not just "hidden" — the packing advisor plans #company-shop/#phase-pricing optimally.
export type BlockCategory =
  | "executive-hold" // CEO/owner takes it for themselves (the operator catalog nickname "Yigal") — not a customer
  | "affiliate-hold" // related company holds it (the operator catalog "City G" = Garden Court, affiliated)
  | "external-party" // reserved off-system for a known buyer/agency ("confirmed by [staff] on [date]")
  | "vip-hold" // individual VIP hold (the operator catalog "Sam")
  | "phase-pricing" // held back to sell LATER at a higher price once the building gains reputation
  | "company-shop" // reserved for local company/shop structure (cheaper units, better for company)
  | "regulatory" // regulatory-forced hold (leans to `killed`)
  | "other";

// One entry in a unit's off-market history — every block/kill/unblock records note + who + when (
// "notes carry forward so a LATER decision is informed"). Append-only; the CURRENT state is `offMarket`.
export type OffMarketEvent = {
  action: "block" | "kill" | "unblock" | "unkill";
  /** WHY (the reason IS the story the structured fields miss). Free text. */
  reason: string;
  category: BlockCategory;
  /** Developer account/label who made the change. */
  by: string;
  /** epoch ms. */
  at: number;
  /** Optional "confirmed by [staff] on [date]" party (the operator catalog external-party pattern). */
  confirmedBy?: string;
  /** On un-block, the developer TYPICALLY updates the price at the same time. The new USD price
   *  set at reversal, for the audit trail (the live price already moved on the unit). */
  newPriceUsd?: number;
};

export type OffMarket = {
  state: OffMarketState;
  reason: string;
  category: BlockCategory;
  by: string;
  at: number;
  confirmedBy?: string;
  /** Full audit trail incl. this current state as the last entry (reversible with context). */
  history: OffMarketEvent[];
};

export type UnitType = {
  key: string; // e.g. "studio", "1br", "2br"
  label: string; // e.g. "Studio", "1 Bedroom"
  sqmMin: number;
  sqmMax: number;
  /** Floor-plan image filename in the MM folder, if one applies to this type. */
  floorplan?: string;
};

export type Building = {
  /** URL-safe demo id (also the lib/mm.ts key). */
  id: string;
  /** Demo display name (the renaming). */
  name: string;
  tagline: string;
  developer: string; // demo developer label
  area: string;
  address: string;
  type: string; // High Rise / Low Rise
  stories: number;
  units: number; // total units in the development (from fact sheet)
  reservationFeeUsd: number;
  maintenancePerSqmUsd: number;
  amenities: string[];
  completion: string;
  unitTypes: UnitType[];
  /** All live units imported from the operator catalog (real specs). */
  inventory: Unit[];
  /** Default payment terms for the building (units may override). */
  terms?: PaymentTerms;
  // â”€â”€ Real the operator catalog financial fields, USD base (future-proof; may be undefined for older seed rows) â”€â”€
  /** Booking/reservation deposit (USD) â€” same as reservationFeeUsd, kept explicit. */
  bookingDepositUsd?: number;
  /** Sinking fund per sqm (USD, one-off). */
  sinkingFundPerSqmUsd?: number;
  /** Transfer fee, as published (e.g. "6.30%"). */
  transferFeePct?: string;
  /** Construction completion date (ISO). */
  constructionEnd?: string;
  // ── Foreign freehold quota — OFF-CHAIN only; present ONLY if the developer configured it ──
  /** Total sellable floor area (m²) for the quota calculation. Absent = quota not tracked for this
   *  building (no buyer-type step, no freehold stat — behaves exactly as before). This is the CURRENT
   *  authoritative figure (latest stage); staged history is in `sellableSqmStages`. */
  sellableSqm?: number;
  /** Staged total sellable area over the lifecycle: the total the quota is computed against also
   *  changes stage-by-stage (before-building → after-building → final Land-Office). */
  sellableSqmStages?: StagedSqm;
  /** Which lifecycle stage the building is currently in (drives which m² figures are authoritative). */
  stage?: "presale" | "built" | "final";
  /** Foreign-freehold cap as a percentage of sellableSqm (e.g. 49 in Thailand). Absent with
   *  sellableSqm present defaults to 49; both absent = quota disabled. */
  foreignQuotaPct?: number;
  // ── Foreign-quota running totals — developer-maintained, OFF-CHAIN. Ownership is the buyer's,
  //    so the quota is a NUMBER: how much foreign area is already sold/committed against the 49% cap. ──
  /** m² already SOLD to foreign (freehold) buyers. */
  foreignSoldSqm?: number;
  /** m² sold OR under a live foreign booking/hold (committed against the cap). Defaults to foreignSoldSqm. */
  foreignCommittedSqm?: number;
  /** m² sold to LOCAL buyers (for the local-side "% sold" display only; never caps). */
  localSoldSqm?: number;
  /** Developer-editable labels for the three buyer ownership types. Absent = country-neutral
   *  defaults (Freehold / Company / Private). Lets a developer localise (e.g. "Thai Company"). */
  quotaLabels?: { freehold?: string; company?: string; private?: string };
  // ── Location / maps — OFF-CHAIN, developer-authored, PUBLIC context (a building's location is
  //  not PII; a BUYER's captured GPS is separate + party-scoped in the encrypted KYC vault). Absent
  //    = no map shown (every pre-geo building behaves exactly as before). "location, location, location." ──
  geo?: BuildingGeo;
  // ── Construction timeline — OFF-CHAIN, developer-authored, BUILDING-specific (a schedule
  //    belongs to one building). Feeds the S&P "Construction and Handover" section; empty/absent = the
  //    neutral "to be completed" fallback, exactly as before. (Furniture is NOT here — furniture packs are
  //    developer-GLOBAL + reusable across many buildings; they live in lib/furniture-packs, attached by id.) ──
  /** The developer's construction/handover schedule for the building → S&P "Construction and Handover". */
  constructionTimeline?: BuildingMilestone[];
  // ── Commission terms-envelope (§9) — OFF-CHAIN, developer-authored. The MIN–MAX commission %
  //    the developer is willing to agree on NEW agreements for this building. It is a SOFT bound: it never
  //    blocks — it flags an out-of-range rate so the developer notices before sealing (the principle is
  //  sunshine/visibility, not adjudication). It bounds only NEW proposals; an already-sealed
  //  agreement's snapshotted commissionPct is frozen and untouched. Absent = no envelope, no flag. ──
  termsEnvelope?: TermsEnvelope;
  // ── Building Setup record — OFF-CHAIN, developer-authored. The the operator catalog-style rich per-building
  //    record (condoData.js): construction/project parameters, physical specs, developer fees, and land/legal
  //    references. ALL groups optional + absent-safe — a building with none renders exactly as before, and the
  //  S&P falls back to its neutral copy when a field is unset (same posture as). PUBLIC building context
  //  (family), NOT PII. The seller-entity IDENTITY block is modelled separately as a reusable record
  //  referenced by id (§3 = Option A, lib/seller-entities) — `sellerEntityId` points at it. Only
  //  hashes/refs ever touch a seal. ──
  /** Construction/project parameters (§2+§4). The contractual completion envelope lives here. */
  project?: BuildingProject;
  /** Physical specs not already modelled (land area, car parks, floor-to-ceiling). */
  physical?: BuildingPhysical;
  /** Developer fees (sinking fund / CAM advance). `sinkingFundPerSqmUsd` already exists top-level as the
   *  published figure; `fees` is the authored Building-Setup home — see `cleanBuildingSetup` for how they
   *  reconcile (the setup write mirrors the authoritative value back to the top-level field, no duplication
   *  of truth). */
  fees?: BuildingFees;
  /** Land-title references + legal clause text (→ S&P). The actual title-DEED document + sealing is its own
 * arc (BuildingProvenance); these are the structured refs beside that document. */
  land?: BuildingLand;
  /** Points at a reusable seller-entity record (lib/seller-entities, §3 Option A). The entity is the
   *  "Seller" party on the S&P. Absent = no seller entity attached yet. */
  sellerEntityId?: string;
  // ── Direct-Sales Desk visibility (§9 step 2) — OFF-CHAIN, developer-authored. Flags a building as
  //    visible to DIRECT BUYERS (the anti-browsing funnel, §3). Absent or visible:false = the building is
  //    INVISIBLE to buyers entirely (fail-closed default-deny). When visible, a pre-conversation buyer sees
  //    ONLY the §8-resolved projection: photos + description + unit COUNT + price RANGE — NO per-unit detail,
  //    NO availability (that stays gated until the operator opens specific units, steps 3+). This flag governs
  //  the BROWSE funnel only; an operator's deliberate offer bypasses it (§8-3). ──
  /** Direct-buyer visibility + optional funnel copy. Absent = invisible to direct buyers. */
  directSale?: BuildingDirectSale;
  // ── Buyer-default / termination clause numbers (§config-surface) — OFF-CHAIN,
  //    developer-authored, PER-BUILDING. The TOP tier of the 3-tier chain (THIS → developer house default →
  //    code default, see lib/termination-terms resolveTerminationChain): a specific project may set its own
  //    §Default-and-Termination threshold / cure floor / interest, overriding the developer's house default.
  //    OWNED BY THE DEVELOPER (their terms toward buyers, not VRX-set). Each field optional + absent-safe — a
  //    building with none inherits the developer default (then the code default). Mirrors how commission
  //    (termsEnvelope) and tax (taxPct) already live per-building. Only NEW S&P renders use it; sealed
  //    agreements keep their frozen numbers. ──
  /** Per-building override of the buyer-default termination numbers. Absent = inherit the developer default. */
  terminationTerms?: Partial<TerminationTerms>;
  /** DISPLAY-price rounding — developer's clean-quote choice, applied only at the listing/card
   *  layer (lib/price-rounding), BEFORE currency conversion. Absent = code default (nearest_1000). Storage
   *  (priceUsd) stays EXACT — this never touches a written price. */
  priceRounding?: PriceRounding;
};

/** Direct-Sales Desk per-building visibility (§9 step 2). */
export type BuildingDirectSale = {
  /** Is this building visible to direct buyers at all? false/absent ⇒ fail-closed invisible. */
  visible: boolean;
  /** Optional funnel copy shown to buyers for this building (marketing prose). */
  funnelCopy?: string;
};

/** Construction/project parameters. `completeWithinMonths` is the CONTRACTUAL completion envelope
 * around the `constructionTimeline` milestones (§4) — it does not replace them. Dates are free text so
 *  "projected Dec 2026" vs a committed date reads honestly (same posture as BuildingMilestone). */
export type BuildingProject = {
  /** Construction START (free text — "Dec 2026", "Q1 2027", a real date). */
  startConst?: string;
  /** Construction END / stated target (free text). */
  endConst?: string;
  /** Contractual completion window in months from commencement (e.g. 36). The backstop the milestones sit in. */
  completeWithinMonths?: number;
  /** Development phase label (e.g. "Phase 2"). */
  phase?: string;
  /** PROJECT-level status (distinct from per-unit tile status). */
  status?: "planning" | "building" | "complete";
};

/** Physical specs beyond the display basics already on Building. */
export type BuildingPhysical = {
  /** Land area as published — free text so Thai units ("1 Rai 3 Ngan 81 Wah") survive verbatim (§2). */
  landArea?: string;
  /** Car-park count. */
  carParks?: number;
  /** Floor-to-ceiling height, free text ("2.8 m"). */
  floorToCeiling?: string;
};

/** Developer fees authored in Building Setup. */
export type BuildingFees = {
  /** One-off sinking fund per m² (USD). Mirrored to the top-level `sinkingFundPerSqmUsd` on save. */
  sinkingFundPerSqmUsd?: number;
  /** CAM (common-area maintenance) months paid in advance at handover (e.g. 12). */
  camAdvanceMonths?: number;
};

/** Land-title references + the legal clause text that feeds the S&P. */
export type BuildingLand = {
  /** Land-title deed number. */
  titleDeedNum?: string;
  /** Survey page number. */
  surveyPageNum?: string;
  /** Land/parcel number. */
  landNumber?: string;
  /** Land address (postal/registry), + optional Thai rendering. */
  address?: string;
  addressTH?: string;
  /** Free-text legal clause(s) — permit/approval references, land terms & conditions — rendered into the S&P.
 * Jurisdiction-neutral hint: a developer types their own (in Thailand this is the EIA; elsewhere the
   *  relevant local permit). Rendered verbatim; VRX never rewrites a developer's authored clause. */
  clauseText?: string;
};

/** The developer's soft MIN–MAX commission band for new agreements on a building. Both bounds are
 *  optional: a lone min = "at least this much"; a lone max = "no more than this"; both = a band. Percentages. */
export type TermsEnvelope = {
  commissionMinPct?: number;
  commissionMaxPct?: number;
};

/** One construction-timeline milestone. Date kept as free text so "projected" vs committed reads
 *  honestly (mirrors lib/sale-contract.SaleMilestone; defined here to avoid a server→contract import cycle). */
export type BuildingMilestone = {
  label: string;
  /** Human date text as entered — "Q3 2027", "projected Mar 2028", a real date. */
  when: string;
  /** True if this date is a projection, not a committed/contractual date. */
  projected?: boolean;
};

/** A building's map location + the main access road(s) to it ("approach matters as much as the pin"). */
export type BuildingGeo = {
  /** Decimal degrees (WGS84). The map pin. */
  lat: number;
  lng: number;
  /** Optional free-text place label shown on the map (distinct from the postal `address`). */
  label?: string;
  /** The main access road(s)/approach — each a polyline of [lat,lng] points (a single point is allowed
   *  for a simple "entrance here" marker). Developer-drawn. Empty/absent = just the pin. */
  accessRoads?: AccessRoad[];
  // ── Site plan (layer 1) — developer-authored polygons + orientation. All optional/absent-safe:
  //  a building (point + roads only) renders exactly as before. ──
  /** The LAND PARCEL boundary — a closed polygon of [lat,lng] points (we close it on render; don't repeat
   *  the first point). Developer-drawn. This is the plot the building sits on. */
  landPolygon?: [number, number][];
  /** The BUILDING FOOTPRINT — a closed polygon of [lat,lng] points (its outprint on the land). Layer 2
   *  (the georeferenced level-plan image) will later be aligned onto this footprint. */
  footprintPolygon?: [number, number][];
  /** Orientation: compass bearing in degrees (0–359, 0 = true north) that the building's front/reference
   *  axis faces. Drives the north arrow + sunrise(E)/sunset(W) direction marks — orientation is a real
   *  property value (which units catch the morning sun / sunset). Absent = no orientation shown. */
  northBearing?: number;
};

export type AccessRoad = {
  /** Optional name/label for the approach (e.g. "Main entrance off Sukhumvit"). */
  name?: string;
  /** Ordered [lat, lng] points. ≥2 = a line; exactly 1 = a single marked point. */
  path: [number, number][];
};

/** The currently-authoritative m² from a staged figure: the latest stage present (final → after →
 * before), falling back to `fallback` (the flat `sqm`). Each stage only exists once reached. */
export function currentSqm(stages: StagedSqm | undefined, fallback: number): number {
  if (!stages) return fallback;
  return stages.final ?? stages.afterBuilding ?? stages.beforeBuilding ?? fallback;
}

/**
 * The terms that actually apply to a unit: the unit's own override if set, else the building
 * default. Returns null if neither exists (shouldn't happen once the seed carries building terms).
 */
export function effectiveTerms(building: Building, unit: Unit): PaymentTerms | null {
  return unit.terms ?? building.terms ?? null;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "catalog.json");

async function readStore(): Promise<Building[] | null> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Building[]) : null;
  } catch {
    return null;
  }
}

async function writeStore(list: Building[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** The catalog â€” seeded from the imported the operator catalog data on first read if the store doesn't exist yet. */
export async function getCatalog(): Promise<Building[]> {
  const existing = await readStore();
  if (existing) return existing;
  const list = seed as Building[];
  await writeStore(list);
  return list;
}

export async function getBuilding(id: string): Promise<Building | null> {
  return (await getCatalog()).find((b) => b.id === id) ?? null;
}

/** Overwrite a building (used by the Developer dashboard to edit units/prices). */
export async function saveBuilding(b: Building): Promise<void> {
  const list = await getCatalog();
  const idx = list.findIndex((x) => x.id === b.id);
  if (idx < 0) list.push(b);
  else list[idx] = b;
  await writeStore(list);
}


