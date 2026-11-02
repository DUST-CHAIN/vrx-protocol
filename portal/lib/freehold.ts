// Foreign freehold quota — pure, shared math over an off-chain Building + status map.
// THE RULE (concrete): a condominium may sell at most N% (49% in Thailand) of its total sellable floor
// area (m²) to foreign buyers as FREEHOLD ("foreign quota"). The remaining ≥51% is held via a local
// COMPANY / leasehold structure. This is a hard legal cap enforced at the Land Office at title transfer.
// THE DECISION: the chain does NOT track m² or enforce the cap — that would be real-estate-specific
// logic in a deliberately domain-agnostic primitive (core bet). The Land Office is the real enforcer;
// the developer distributes quota per unit there. The chain's ONLY role is to WITNESS the promise — the
// chosen unit's freehold flag rides in the opaque request_hash. Everything here is OFF-CHAIN.
// DEVELOPER-DRIVEN: quota is active ONLY for a building the developer configured with `sellableSqm`
// (+ optional `foreignQuotaPct`). No config → `enabled: false` → the whole buyer-type layer disappears
// and the building behaves exactly as before. Country-neutral wording ("Freehold" / "Company").

import type { Building, Unit, StagedSqm } from "./catalog-client";

// Self-contained copy of currentSqm so this module imports ONLY TYPES from catalog-client (a
// "use client" module). Importing a runtime VALUE across that boundary into a server route (the summary
// API) breaks the bundle; types are erased at compile so they're safe. Mirrors catalog-client.currentSqm.
function currentSqm(stages: StagedSqm | undefined, fallback: number): number {
  if (!stages) return fallback;
  return stages.final ?? stages.afterBuilding ?? stages.beforeBuilding ?? fallback;
}

// contract's three ownership codes (ContractPdf.php:26 — T=Thai, F=Foreigner, TC=Thai Company):
// • freehold — a FOREIGN buyer taking freehold title. The ONLY bucket that consumes the 49% foreign
// • company — a Thai Company structure (TC). Not quota-limited.
// • individual — a local person buying in their OWN name. Not quota-limited; can take ANY unit under
// Country-neutral labels are deliberate (the primitive is domain/jurisdiction-agnostic).
export type BuyerType = "freehold" | "company" | "private";

export const BUYER_TYPE_LABEL: Record<BuyerType, string> = {
  freehold: "Freehold",
  company: "Company",
  private: "Private",
};

/** Which buyer types actually count against the foreign-freehold quota — only freehold does. */
export function buyerConsumesQuota(buyer: BuyerType): boolean {
  return buyer === "freehold";
}

/** Label for a bucket, honouring the building's developer-editable overrides, else the default. */
export function buyerLabel(b: Building, buyer: BuyerType): string {
  return b.quotaLabels?.[buyer] ?? BUYER_TYPE_LABEL[buyer];
}

/** The price that applies to a unit for the chosen buyer type: buckets usually carry different
 * prices. Freehold uses the freehold price; company/individual use the company (local-structure) price.
 * Falls back to the unit's headline priceUsd if a bucket price isn't set. */
export function priceForBuyer(unit: Unit, buyer: BuyerType): number {
  const p = unit.pricing;
  if (!p) return unit.priceUsd;
  const picked = buyer === "freehold" ? p.freeholdUsd : p.companyUsd;
  return picked ?? unit.priceUsd;
}

/** A unit's current authoritative m² (latest staged figure), for quota + pricing math. */
export function unitSqm(unit: Unit): number {
  return currentSqm(unit.sqmStages, unit.sqm);
}

// One side of the split (foreign OR local): the cap, what's committed/sold against it, what's left.
export type QuotaSide = {
  /** Allowed m² for this side (foreign = 49% of sellable; local = the remaining 51%). */
  capSqm: number;
  /** m² SOLD on this side (status closed/done). */
  soldSqm: number;
  /** m² sold OR on hold on this side (committed). */
  committedSqm: number;
  /** m² still available = cap − committed (floored at 0). */
  availableSqm: number;
  /** Percent of the cap already SOLD (0–100, rounded). Shown in red. */
  soldPct: number;
};

export type FreeholdQuota = {
  /** True only when the developer configured a quota for this building. */
  enabled: boolean;
  /** Total sellable floor area (m²) — every unit counts, shown or hidden. */
  sellableSqm: number;
  /** The FOREIGN cap as a percentage (e.g. 49). */
  pct: number;
  /** The FOREIGN (freehold) side — the scarce, capped bucket. */
  foreign: QuotaSide;
  /** The LOCAL side (Company + Private grouped) — the remaining ≥51%. */
  local: QuotaSide;
  /** Units with NO ownership tag yet (the floating pool). Local is "anyhow any unit", so this only
   * makes the FOREIGN figure an estimate — surface it to the developer to declare. */
  undeclaredUnits: number;
  undeclaredSqm: number;
  /** True when enough is undeclared that the foreign figure is a GUESS, not exact (developer alert). */
  foreignIsEstimate: boolean;

  // ── Back-compat shims: the old flat foreign fields (still read by some callers) ──
  quotaSqm: number;
  soldSqm: number;
  committedSqm: number;
  availableSqm: number;
};

const emptySide = (): QuotaSide => ({ capSqm: 0, soldSqm: 0, committedSqm: 0, availableSqm: 0, soldPct: 0 });

/** A disabled/zero quota — for a building with none, or before one loads. */
export function emptyQuota(): FreeholdQuota {
  return {
    enabled: false, sellableSqm: 0, pct: 0,
    foreign: emptySide(), local: emptySide(),
    undeclaredUnits: 0, undeclaredSqm: 0, foreignIsEstimate: false,
    quotaSqm: 0, soldSqm: 0, committedSqm: 0, availableSqm: 0,
  };
}

const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * Compute the full quota picture (both sides) for a building.
 *
 * MODEL (+ confirmed against the operator catalog schema): **ownership is a property of the BUYER/sale, NOT
 * the unit** (the operator catalog: `pre_reservation.ownership` T/F/C; a unit is never inherently "freehold"). So the
 * foreign-freehold quota is just a NUMBER — 49% of the fixed total sellable m² — consumed as units are
 * SOLD to foreign buyers. The building carries how much foreign area is already committed/sold
 * (`foreignSoldSqm` / `foreignCommittedSqm`), a running total the developer maintains (off-chain, like
 * the catalog). The LOCAL side (the ≥51%) isn't scarce — any unit can be sold locally — so we only
 * track the local SOLD figure for display, never a cap that blocks. `status` is unused here now (the
 * quota is a developer-maintained number, not derived from per-unit tags) but kept for signature
 * stability + future live wiring.
 */
export function freeholdQuota(b: Building, _status: Record<string, number> = {}): FreeholdQuota {
  const sellableSqm = currentSqm(b.sellableSqmStages, b.sellableSqm ?? 0);
  const enabled = sellableSqm > 0;
  const pct = b.foreignQuotaPct ?? (enabled ? 49 : 0);
  const foreignCap = Math.round((sellableSqm * pct) / 100);
  const localCap = Math.max(0, sellableSqm - foreignCap);

  // Developer-maintained running totals (off-chain). Absent → 0 (nothing sold to foreigners yet).
  const fSold = enabled ? Math.min(foreignCap, b.foreignSoldSqm ?? 0) : 0;
  const fCommitted = enabled ? Math.min(foreignCap, b.foreignCommittedSqm ?? b.foreignSoldSqm ?? 0) : 0;
  const lSold = enabled ? Math.min(localCap, b.localSoldSqm ?? 0) : 0;

  const foreign: QuotaSide = {
    capSqm: foreignCap,
    soldSqm: fSold,
    committedSqm: fCommitted,
    availableSqm: Math.max(0, foreignCap - fCommitted),
    soldPct: pctOf(fSold, foreignCap),
  };
  const local: QuotaSide = {
    capSqm: localCap,
    soldSqm: lSold,
    committedSqm: lSold,
    availableSqm: Math.max(0, localCap - lSold),
    soldPct: pctOf(lSold, localCap),
  };

  return {
    enabled,
    sellableSqm,
    pct,
    foreign,
    local,
    // The undeclared-pool concept belonged to the old per-unit-tag model; ownership is now the buyer's,
    // so there's nothing "undeclared" at the unit level. Kept at 0 for type stability.
    undeclaredUnits: 0,
    undeclaredSqm: 0,
    foreignIsEstimate: false,
    // back-compat flat foreign fields
    quotaSqm: foreignCap,
    soldSqm: fSold,
    committedSqm: fCommitted,
    availableSqm: foreign.availableSqm,
  };
}

/**
 * Can this unit be booked for a FOREIGN (freehold) buyer? Only if the remaining foreign quota has room
 * for this unit's size (: "can only book if the 49% quota has room for that unit's size"). Local
 * buyers are never limited, so this only gates the foreign path.
 */
export function freeholdBookable(unit: Unit, q: FreeholdQuota): boolean {
  if (!q.enabled) return true; // no quota → no restriction
  return unitSqm(unit) <= q.foreign.availableSqm;
}

/**
 * Is a unit selectable for the chosen buyer type? Company + individual buyers: always (subject to
 * on-chain status) — neither consumes the foreign quota. Freehold buyers: only if freeholdBookable.
 * Used to grey-out / block units in the grid + re-check at submit.
 */
export function bookableForBuyer(unit: Unit, buyer: BuyerType, q: FreeholdQuota): boolean {
  if (!buyerConsumesQuota(buyer)) return true;
  return freeholdBookable(unit, q);
}
