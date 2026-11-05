// APPLY AN APPROVED VERSION — SERVER-ONLY. The executor that lands an APPROVED inventory-version's
// attested changeset onto the live catalog: "the approved version IS the instruction". On approve,
// the developer re-types nothing — we apply the exact figures the approver signed off, so there is NO drift
// between what was approved and what lands.
//
// WHY HERE AND NOT IN inventory-version.ts: the version store is a PURE chained record that deliberately
// "does not read the catalog or the developer registry" — it only attests WHAT changed. Applying that change to
// the catalog is a separate concern (reads/saves the catalog), so it lives in this thin seam that the decide
// route calls. The store stays pure; the apply stays testable in isolation.
//
// THE CHANGESET CONTRACT: a price version's changeset is keyed by unit id —
// `{ "unit-501": { from, to }... }` (the shape POST /api/catalog/request-approval produces
// resolvePriceTargets, and the SAME shape lib/inventory-version.heldUnits reads to hold those units). We apply
// each entry's EXACT `to` price (never re-rounded — storage is the truth). Entries without a finite
// positive `to`, or naming a unit that no longer exists, are skipped (reported back) rather than corrupting the
// store.
//
// STRUCTURAL AUTO-APPLY — the "clean later extension off the same pattern" the earlier comment promised.
// A structural version (addUnit / removeUnit / sizeTypeLayout) carries a SELF-DESCRIBING per-entry op so this
// applier never has to guess from the changeClass:
//   • remove → `{ "<id>": { op:"remove" } }`               (unit-id keyed → the unit is held while pending)
//   • edit   → `{ "<id>": { op:"edit", changes:{...} } }`   (unit-id keyed → held)
//  • add → `{ "add": { unit:{ id, type, floor, sqm, priceUsd... } } }` (CONTROL-keyed → holds nothing,
//              correct: an un-added unit isn't in the catalog/snapshot yet and is already not bookable)
// The SAME route (POST /api/catalog/version/decide) lands either kind; it routes to applyApprovedPriceVersion
// for a price class and applyApprovedStructuralVersion for a structural class. A removeUnit honours the
// anti-fraud guard — a unit with a live on-chain reservation is NEVER structurally dropped; it is skipped
// (reported back) and must go through lawful cancellation, exactly as POST /api/catalog/unit refuses it.
//
// PRIVACY: operates on opaque building/unit ids + public catalog prices/sizes. Nothing on-chain.

import { getBuilding, saveBuilding } from "./catalog";
import type { Unit } from "./catalog-client";
import { getUnitsStatusMerged } from "./status-cache";
import { offMarketBlockedReason } from "./offmarket";

/** One applied price move (for the route to report / notice from). */
export type AppliedPrice = { id: string; from: number; to: number; direction: "up" | "down" };

export type ApplyResult = {
  /** The per-unit prices actually written. */
  applied: AppliedPrice[];
  /** Unit-id keys in the changeset that could not be applied (missing unit / bad `to`). */
  skipped: string[];
};

/** Is this a price-changeset entry — `{ to:number, from?:number }` — naming a concrete new price? */
function priceEntry(v: unknown): v is { to: number; from?: number } {
  return !!v && typeof v === "object" && typeof (v as { to?: unknown }).to === "number";
}

/**
 * Apply an APPROVED version's price changeset to the catalog. Reads the building, sets each named unit's
 * `priceUsd` to the attested EXACT `to`, saves once. Returns what was applied vs skipped. Does NOT touch the
 * version store (the caller has already marked it approved) and does NOT emit the change notice (the route owns
 * that — it knows the audience). Returns an empty result for an unknown building or a changeset with no
 * applicable price entries (e.g. a structural/control-keyed changeset).
 */
export async function applyApprovedPriceVersion(
  building: string,
  changeset: Record<string, unknown>
): Promise<ApplyResult> {
  const applied: AppliedPrice[] = [];
  const skipped: string[] = [];

  const bld = await getBuilding(String(building ?? "").trim());
  if (!bld) {
    // Unknown building — nothing applied. Report only the unit-id keys as skipped (control keys are never
    // "skipped applies"; they name no unit).
    return { applied, skipped: Object.keys(changeset ?? {}).filter((k) => k !== "add" && k !== "remove") };
  }

  const byId = new Map(bld.inventory.map((u) => [u.id, u]));
  let touched = false;
  for (const [key, entry] of Object.entries(changeset ?? {})) {
    if (key === "add" || key === "remove") continue; // control key — not a per-unit price change
    const unit = byId.get(key);
    if (!unit || !priceEntry(entry) || !(entry.to > 0)) {
      skipped.push(key);
      continue;
    }
    const from = unit.priceUsd;
    unit.priceUsd = entry.to; // EXACT — the approved figure, never re-rounded
    applied.push({ id: key, from, to: entry.to, direction: entry.to >= from ? "up" : "down" });
    touched = true;
  }

  if (touched) await saveBuilding(bld);
  return { applied, skipped };
}

/** One applied structural move (for the route to report / notice from). */
export type AppliedStructural =
  | { op: "add"; id: string }
  | { op: "remove"; id: string }
  | { op: "edit"; id: string; changes: Record<string, string | number> };

export type ApplyStructuralResult = {
  /** The structural moves actually written. */
  applied: AppliedStructural[];
  /** Changeset keys that could not be applied (bad shape / unit missing or already present / live reservation). */
  skipped: string[];
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Build a clean Unit from an attested add entry — the SAME field rules as POST /api/catalog/unit's cleanNewUnit
 *  (the shape the request-approval add path stored). Returns null on a malformed entry (→ skipped, never a
 *  corrupt unit). */
function cleanAddUnit(raw: unknown): Unit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, 80);
  const type = str(o.type, 40);
  const floor = num(o.floor);
  const sqm = num(o.sqm);
  const priceUsd = num(o.priceUsd);
  if (!id || !type || floor === undefined || sqm === undefined || sqm <= 0 || priceUsd === undefined || priceUsd <= 0) {
    return null;
  }
  const u: Unit = { id, type, floor, sqm, priceUsd };
  if (str(o.subtype, 40)) u.subtype = str(o.subtype, 40);
  if (str(o.view, 60)) u.view = str(o.view, 60);
  if (num(o.baths) !== undefined) u.baths = num(o.baths);
  if (num(o.unitNumber) !== undefined) u.unitNumber = num(o.unitNumber);
  return u;
}

/** Apply the `changes` of an attested edit entry to a unit — mirrors the sizeTypeLayout branch of POST
 *  /api/catalog/unit (never price — that's a price version). Returns the actually-applied changes, or null if
 *  nothing valid was supplied. */
function applyEdit(unit: Unit, changes: Record<string, unknown>): Record<string, string | number> | null {
  const done: Record<string, string | number> = {};
  if (str(changes.type, 40)) { unit.type = str(changes.type, 40); done.type = unit.type; }
  if (num(changes.sqm) !== undefined && num(changes.sqm)! > 0) { unit.sqm = num(changes.sqm)!; done.sqm = unit.sqm; }
  if (num(changes.floor) !== undefined) { unit.floor = num(changes.floor)!; done.floor = unit.floor; }
  if (str(changes.subtype, 40)) { unit.subtype = str(changes.subtype, 40); done.subtype = unit.subtype; }
  if (num(changes.baths) !== undefined) { unit.baths = num(changes.baths)!; done.baths = unit.baths; }
  return Object.keys(done).length ? done : null;
}

/** Is this a structural-changeset entry carrying a self-describing op? */
function structuralEntry(v: unknown): v is { op: "add" | "remove" | "edit"; [k: string]: unknown } {
  const op = (v as { op?: unknown } | null)?.op;
  return !!v && typeof v === "object" && (op === "add" || op === "remove" || op === "edit");
}

/**
 * Apply an APPROVED STRUCTURAL version's changeset to the catalog — add / remove / edit a unit, the
 * exact moves the approver signed off. Reads the building, performs each self-describing entry, saves once.
 *
 * The entry shapes (self-describing per-entry op):
 *   • `{ "add":   { op:"add",    unit:{...} } }`        → push a clean new unit (skip if id already exists)
 *   • `{ "<id>":  { op:"remove"             } }`        → drop the unit (skip if missing, or a LIVE on-chain
 * reservation — anti-fraud; never hide a booked unit)
 *   • `{ "<id>":  { op:"edit",   changes:{...} } }`     → size/type/layout change (skip if missing / no valid change)
 *
 * Does NOT touch the version store (caller already marked it approved) and does NOT emit the change notice (the
 * route owns that). Returns what was applied vs skipped. Empty for an unknown building or a changeset with no
 * applicable structural entry (e.g. a price changeset — routed to applyApprovedPriceVersion instead).
 */
export async function applyApprovedStructuralVersion(
  building: string,
  changeset: Record<string, unknown>
): Promise<ApplyStructuralResult> {
  const applied: AppliedStructural[] = [];
  const skipped: string[] = [];

  const bld = await getBuilding(String(building ?? "").trim());
  if (!bld) return { applied, skipped: Object.keys(changeset ?? {}) };

  // Fetch fresh-enough on-chain status ONCE for every unit a remove targets (guard) — a held/booked/sold
  // unit must go through lawful cancellation, never be structurally dropped behind the scenes.
  const removeIds: string[] = [];
  for (const [key, entry] of Object.entries(changeset ?? {})) {
    if (key !== "add" && structuralEntry(entry) && entry.op === "remove") removeIds.push(key);
  }
  let status: Record<string, number> = {};
  if (removeIds.length) {
    try {
      ({ status } = await getUnitsStatusMerged(bld.id, removeIds));
    } catch {
      status = {}; // unconfirmed → every remove below is refused by the guard (offMarketBlockedReason(undefined))
    }
  }

  let touched = false;
  for (const [key, entry] of Object.entries(changeset ?? {})) {
    if (!structuralEntry(entry)) { skipped.push(key); continue; }

    if (entry.op === "add") {
      const unit = cleanAddUnit(entry.unit);
      if (!unit || bld.inventory.some((u) => u.id === unit.id)) { skipped.push(key); continue; }
      bld.inventory.push(unit);
      applied.push({ op: "add", id: unit.id });
      touched = true;
      continue;
    }

    const unit = bld.inventory.find((u) => u.id === key);
    if (!unit) { skipped.push(key); continue; }

    if (entry.op === "remove") {
      // refuse to drop a unit with a live on-chain reservation (unconfirmed status also refuses).
      if (offMarketBlockedReason(status[key])) { skipped.push(key); continue; }
      bld.inventory = bld.inventory.filter((u) => u.id !== key);
      applied.push({ op: "remove", id: key });
      touched = true;
      continue;
    }

    // edit
    const changes = (entry.changes && typeof entry.changes === "object" ? entry.changes : {}) as Record<string, unknown>;
    const done = applyEdit(unit, changes);
    if (!done) { skipped.push(key); continue; }
    applied.push({ op: "edit", id: key, changes: done });
    touched = true;
  }

  if (touched) await saveBuilding(bld);
  return { applied, skipped };
}
