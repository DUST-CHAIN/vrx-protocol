// FURNITURE COST CALC — pure, isomorphic (server S&P route + client authoring preview).
//
// A furniture PACK is a developer-GLOBAL, reusable package (lib/furniture-packs.FurniturePack) attached to
// one or many buildings. Its cost for a SPECIFIC unit is the sum of its line items, each priced on one of two
// bases (: "fixed-price items that add up to a total" + "unit size × selection"):
//   • flat     — a fixed USD price, same for any unit.
//  • per_sqm — a USD/m² rate multiplied by the unit's authoritative m² (currentSqm).
// Cost is NEVER stored as a frozen figure — it's recomputed from the unit's m² wherever it's shown, so a
// staged area change flows straight through. All USD; rounded to whole dollars for display/contract.

import type { FurniturePack, FurnitureItem } from "./catalog-client";

/** The cost of a single line item for a unit of `unitSqm` m². */
export function furnitureItemCost(item: FurnitureItem, unitSqm: number): number {
  if (item.basis === "flat") return Math.max(0, Math.round(item.priceUsd));
  const sqm = Number.isFinite(unitSqm) && unitSqm > 0 ? unitSqm : 0;
  return Math.max(0, Math.round(item.ratePerSqmUsd * sqm));
}

/** The total cost of a furniture pack (sum of its items) for a unit of `unitSqm` m². */
export function furniturePackCost(pack: Pick<FurniturePack, "items">, unitSqm: number): number {
  return pack.items.reduce((sum, it) => sum + furnitureItemCost(it, unitSqm), 0);
}

/** A human basis label for authoring/contract display ("$450/m²" or "flat"). */
export function furnitureItemBasisLabel(item: FurnitureItem): string {
  return item.basis === "per_sqm" ? `${Math.round(item.ratePerSqmUsd)}/m²` : "flat";
}

/**
 * Project a set of furniture packs into the S&P generator's SaleFurnitureOption shape for a given unit size.
 * Each pack's cost is computed for THIS unit; `selected` is left undefined (a later per-deal selection arc
 * sets it) so the contract lists the available packs with their per-unit price.
 */
export function furnitureForUnit(
  packs: Pick<FurniturePack, "label" | "items">[] | undefined,
  unitSqm: number
): { label: string; costUsd: number }[] {
  return (packs ?? []).map((p) => ({ label: p.label, costUsd: furniturePackCost(p, unitSqm) }));
}
