// AI Sales Director — the QUERY TOOLS (the design docs §3). SERVER-ONLY. The procedural
// retrieval layer that feeds the AI REAL inventory/terms/availability from the catalog the developer already
// authored — ZERO per-building hand-authoring. Each tool:
//   1. is BUILDING-SCOPED by the caller (the model can't query another building);
//   2. reads the real catalog (lib/catalog) — the SAME data the human desk sees;
//   3. consults the PERMISSION MATRIX (lib/ai-desk/permissions) for its data category × persona × phase;
//   4. REDUCES the result (a count + top-3 summaries, not the 199-row table; only terms fields that EXIST) so
//      the model never receives the raw catalog — the privacy moat (REFINEMENT 2, the raw data stays on OUR
//      server; see docs §1/§7). The loop (slice 3) calls these; they are PURE of any LLM.
//
// REAL-TERMS-ONLY is enforced HERE, not in the prompt: building_terms returns only fields present in the data.
// There is no rentalGuarantee field in PaymentTerms/Building (verified), so no tool can return one, so the
// AI can never offer one — the phantom guarantee (the live-transcript bug) dies structurally (slice 4 removes
// the dangling lever/prompt line).

import { getBuilding, effectiveTerms, type Building, type Unit, type PaymentTerms } from "../catalog";
import { listDevelopers } from "../developers";
import { bookableResult } from "../bookable";
import { can, type Persona, type Phase } from "./permissions";

/** The scope every tool runs under — who's asking + where in the deal, so the matrix can gate. The building id
 *  is passed explicitly (never model-supplied) so a conversation can't read another building's data. */
export type ToolScope = { persona: Persona; phase: Phase; buildingId: string };

/** A reduced unit summary — the ONLY unit shape that goes back toward the model (never the raw Unit with every
 *  field). Public market facts a human desk would state; no internal flags. */
export type UnitSummary = {
  id: string;
  typeLabel: string; // human unit-type (e.g. "1 Bedroom"), resolved from the building's unitTypes
  floor: number;
  sqm: number;
  priceUsd: number;
  view?: string;
  corner?: boolean;
  baths?: number;
};

/** find_units result: a COUNT + at most the top few summaries. The model sees "N match, here are the best 3",
 *  never the full inventory. `note` carries a plain reason when nothing matched (so the AI answers honestly). */
export type FindUnitsResult = { matchCount: number; units: UnitSummary[]; note?: string };

/** A tool verdict wrapper — `denied` when the matrix forbids the category for this persona×phase (the model is
 *  told the datum isn't available in this context, never a raw value). */
export type ToolResult<T> = { ok: true; data: T } | { ok: false; denied: true; category: string };

const deny = (category: string): ToolResult<never> => ({ ok: false, denied: true, category });

/** Resolve a unit's human type label from the building's unitTypes (falls back to the raw key). PURE. */
function typeLabel(building: Building, unit: Unit): string {
  return building.unitTypes?.find((t) => t.key === unit.type)?.label ?? unit.type;
}

/** A unit is ON-MARKET iff it has no offMarket block (the lightweight, always-available signal — the
 *  authoritative "bookable right now" check needs the on-chain baseline+snapshot and is check_availability). */
function isOnMarket(unit: Unit): boolean {
  return !unit.offMarket;
}

function toSummary(building: Building, unit: Unit): UnitSummary {
  return {
    id: unit.id,
    typeLabel: typeLabel(building, unit),
    floor: unit.floor,
    sqm: unit.sqm,
    priceUsd: unit.priceUsd,
    ...(unit.view ? { view: unit.view } : {}),
    ...(unit.corner ? { corner: true } : {}),
    ...(typeof unit.baths === "number" ? { baths: unit.baths } : {}),
  };
}

/** Normalise a buyer's free-text "beds" intent to a set of unit-type keys/labels to match against. Handles the
 *  common ways people say it ("1 bed", "one bedroom", "studio", "2br"). Absent = no type filter. PURE. */
function bedsToMatchers(beds?: string | number): ((building: Building, u: Unit) => boolean) | null {
  if (beds === undefined || beds === null || beds === "") return null;
  const raw = String(beds).toLowerCase().trim();
  // studio
  if (/\bstudio\b|\b0\s*(bed|br)\b/.test(raw)) {
    return (b, u) => /studio/i.test(u.type) || /studio/i.test(typeLabel(b, u));
  }
  // a bedroom count ("1", "1 bed", "1br", "one bedroom"). Pull the first digit 1–4 (compact forms like "1br"
  // have no word boundary after the digit, so match the digit directly), or a number word.
  const word: Record<string, string> = { one: "1", two: "2", three: "3", four: "4" };
  const num = raw.match(/[1-4]/)?.[0] ?? word[raw.match(/\b(one|two|three|four)\b/)?.[1] ?? ""];
  if (num) {
    // A unit type is an N-bedroom iff its key or label contains that digit immediately followed by a bed
    // indicator (so "1br"/"1-bed"/"1 bedroom" all match, but a stray "10" or "studio" does not).
    const re = new RegExp(`${num}\\s*-?\\s*(?:br|bed)`); // 1br · 1 br · 1-bed · 1 bedroom
    return (b, u) => re.test(u.type.toLowerCase()) || re.test(typeLabel(b, u).toLowerCase());
  }
  return null;
}

/**
 * find_units — the inventory query. Filters the building's REAL inventory by beds/type + max budget, keeps only
 * on-market units, sorts by best fit (cheapest within budget first; then lower floor as a tiebreak), and returns
 * a COUNT + the top `limit` (default 3) SUMMARIES. Never returns the full table. Matrix-gated on `inventory`.
 */
export async function findUnits(
  scope: ToolScope,
  args: { beds?: string | number; maxBudgetUsd?: number; view?: string; limit?: number }
): Promise<ToolResult<FindUnitsResult>> {
  if (can(scope.persona, scope.phase, "inventory") !== "allow") return deny("inventory");
  const building = await getBuilding(scope.buildingId);
  if (!building) return { ok: true, data: { matchCount: 0, units: [], note: "No such building." } };

  const bedFilter = bedsToMatchers(args.beds);
  const budget = typeof args.maxBudgetUsd === "number" && args.maxBudgetUsd > 0 ? args.maxBudgetUsd : undefined;
  const viewWant = args.view?.toLowerCase().trim();

  const matched = (building.inventory ?? [])
    .filter(isOnMarket)
    .filter((u) => (bedFilter ? bedFilter(building, u) : true))
    .filter((u) => (budget ? u.priceUsd > 0 && u.priceUsd <= budget : true))
    .filter((u) => (viewWant ? (u.view ?? "").toLowerCase().includes(viewWant) : true));

  // sort: cheapest first (best value within budget), then lower floor as a stable tiebreak
  matched.sort((a, b) => a.priceUsd - b.priceUsd || a.floor - b.floor);

  const limit = Math.max(1, Math.min(args.limit ?? 3, 5));
  const units = matched.slice(0, limit).map((u) => toSummary(building, u));
  const note =
    matched.length === 0
      ? budget
        ? "No on-market units match that brief within budget."
        : "No on-market units match that brief."
      : undefined;
  return { ok: true, data: { matchCount: matched.length, units, ...(note ? { note } : {}) } };
}

/** unit_detail — one unit's public facts. Matrix-gated on `unit_detail`. Null-safe: an unknown id returns a
 *  not-found result (the AI answers honestly rather than confabulating). */
export async function unitDetail(scope: ToolScope, args: { unitId: string }): Promise<ToolResult<UnitSummary | null>> {
  if (can(scope.persona, scope.phase, "unit_detail") !== "allow") return deny("unit_detail");
  const building = await getBuilding(scope.buildingId);
  const unit = building?.inventory?.find((u) => u.id === args.unitId);
  if (!building || !unit) return { ok: true, data: null };
  return { ok: true, data: toSummary(building, unit) };
}

/** The reduced, REAL terms the AI may quote — ONLY fields that exist in the data. No rentalGuarantee field
 *  exists, so this type structurally cannot carry one. Percentages are the developer-published option arrays
 *  (the AI frames "from X%"); dollar fees are the building's published figures. */
export type RealTerms = {
  depositPctOptions?: number[];
  bookingFeeUsdOptions?: number[];
  reservationFeeUsd?: number;
  bookingDepositUsd?: number;
  onKeyPctOptions?: number[];
  taxPctOptions?: number[];
  contractDays?: number; // days to sign the S&P after reserving
  furniturePerSqmUsd?: number; // 0/absent = not offered
  maintenancePerSqmUsd?: number;
  transferFeePct?: string;
  completion?: string;
  // ongoing/onContract instalment structure, flattened to a plain, quotable shape
  instalmentPlan?: { onContract?: { installments: number; amountPct: number }[]; ongoing?: { installments: number; amountPct: number }[] };
};

/** building_terms — the building's (or a specific unit's) REAL payment terms + fees, reduced to only-what-exists.
 *  Matrix-gated on `building_terms`. If `unitId` is given, uses effectiveTerms (unit override else building). */
export async function buildingTerms(scope: ToolScope, args?: { unitId?: string }): Promise<ToolResult<RealTerms | null>> {
  if (can(scope.persona, scope.phase, "building_terms") !== "allow") return deny("building_terms");
  const building = await getBuilding(scope.buildingId);
  if (!building) return { ok: true, data: null };

  const unit = args?.unitId ? building.inventory?.find((u) => u.id === args.unitId) : undefined;
  const terms: PaymentTerms | null = unit ? effectiveTerms(building, unit) : building.terms ?? null;

  // Build the reduced shape, OMITTING any field that isn't present (only-what-exists). This is where the
  // phantom-guarantee is structurally impossible — there is no source field to copy from.
  const out: RealTerms = {};
  if (terms) {
    if (terms.depositPct?.length) out.depositPctOptions = terms.depositPct;
    if (terms.bookingFee?.length) out.bookingFeeUsdOptions = terms.bookingFee;
    if (terms.onKeyPct?.length) out.onKeyPctOptions = terms.onKeyPct;
    if (terms.taxPct?.length) out.taxPctOptions = terms.taxPct;
    if (typeof terms.contractDays === "number") out.contractDays = terms.contractDays;
    if (typeof terms.furniturePerSqmUsd === "number" && terms.furniturePerSqmUsd > 0) out.furniturePerSqmUsd = terms.furniturePerSqmUsd;
    if (terms.onContract?.length || terms.ongoing?.length) {
      out.instalmentPlan = {
        ...(terms.onContract?.length ? { onContract: terms.onContract } : {}),
        ...(terms.ongoing?.length ? { ongoing: terms.ongoing } : {}),
      };
    }
  }
  if (typeof building.reservationFeeUsd === "number") out.reservationFeeUsd = building.reservationFeeUsd;
  if (typeof building.bookingDepositUsd === "number") out.bookingDepositUsd = building.bookingDepositUsd;
  if (typeof building.maintenancePerSqmUsd === "number") out.maintenancePerSqmUsd = building.maintenancePerSqmUsd;
  if (building.transferFeePct) out.transferFeePct = building.transferFeePct;
  if (building.completion) out.completion = building.completion;

  return { ok: true, data: out };
}

export type Availability = "available" | "unavailable" | "unknown";

/** Resolve a building id → its developer ACCOUNT (the on-chain handle isBookable keys on). The developer
 *  registry is the authoritative mapping (mirrors buyer-catalog's resolver). PURE read. */
async function developerAccountFor(buildingId: string): Promise<string | null> {
  const devs = await listDevelopers();
  return devs.find((d) => d.buildingIds?.includes(buildingId))?.account ?? null;
}

/**
 * check_availability — is this unit reservable? Mirrors the REAL flow (the memo's "don't invent"): the
 * authoritative signal is lib/bookable.isBookable (on-contract + stamped open), resolved via the developer
 * account. When no on-chain baseline/snapshot is present (a pure-catalog demo world), we fall back to the
 * on-market flag so the AI still answers sensibly rather than blocking every unit. Matrix-gated on `inventory`
 * (availability is a property of the public inventory). Returns available / unavailable / unknown.
 */
export async function checkAvailability(scope: ToolScope, args: { unitId: string }): Promise<ToolResult<Availability>> {
  if (can(scope.persona, scope.phase, "inventory") !== "allow") return deny("inventory");
  const building = await getBuilding(scope.buildingId);
  const unit = building?.inventory?.find((u) => u.id === args.unitId);
  if (!building || !unit) return { ok: true, data: "unknown" };

  // off-market units are unavailable regardless of chain state (the cheap, definitive negative).
  if (unit.offMarket) return { ok: true, data: "unavailable" };

  const account = await developerAccountFor(scope.buildingId);
  if (!account) return { ok: true, data: "available" }; // no registry mapping → trust the on-market flag (demo-safe)

  try {
    const res = await bookableResult(account, scope.buildingId, args.unitId);
    if (res.ok) return { ok: true, data: "available" }; // chain-authoritative: on-contract + stamped open
    // A negative from bookableResult carries a REASON. `pre_contract` (no sale baseline) just means the
    // on-chain booking rail isn't set up for this building in THIS demo world — not that the unit is taken;
    // the unit already passed the off-market check, so fall back to the on-market flag ("available"). A
    // concrete chain negative (not_open = held/closed/done, or held_pending_approval) IS a real "unavailable".
    return { ok: true, data: res.reason === "pre_contract" ? "available" : "unavailable" };
  } catch {
    return { ok: true, data: "available" }; // read fault → don't block on it; the on-market flag stands
  }
}
