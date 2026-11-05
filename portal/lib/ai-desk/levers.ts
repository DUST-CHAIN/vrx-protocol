// AI Sales Director — lever resolver (the design docs §3b step 4). Turns the REAL,
// draftable sales levers for a building into ConcessionLever[] the AI may compose from. Keeping this the ONE
// place levers are resolved means the AI can never promise a term that isn't real (the no-invented-terms rule).
//
// v1 source: furniture packs attached to the building (lib/furniture-packs.packsForBuilding). A pack's $ value
// is unit-m²-dependent (computed in the S&P generator), so pre-booking we expose a nominal flat-item sum as the
// headline value — enough for the AI to frame a combo; the exact figure is reconciled when drafted into the S&P.
// A generic price_discount lever is always offered (bounded later by maxConcessionPct → a SaleDiscount note at
// draft time); furniture packs are enumerated as concrete named assets so the AI quotes a real pack.
// (slice 4): the old rental_guarantee / alt_unit "generic levers" were REMOVED — no resolver produced them, so
// they were a confabulation surface. A real rental guarantee a developer authors reaches the AI via the
// building's REAL terms (lib/ai-desk/query-tools.buildingTerms), never as an invented lever.

import { packsForBuilding } from "../furniture-packs";
import type { ConcessionLever } from "./types";

/** Nominal headline $ value of a pack from its FLAT items (per_sqm items need a unit m², reconciled at draft). */
function nominalPackValue(items: Array<{ basis?: string; priceUsd?: number }>): number {
  return items.reduce((s, it) => s + (it.basis === "flat" && typeof it.priceUsd === "number" ? it.priceUsd : 0), 0);
}

/** The real concession levers available for a building. Furniture packs are enumerated as concrete named
 *  levers; a generic price-discount lever is always offered (bounded later by maxConcessionPct). */
export async function leversForBuilding(buildingId: string): Promise<ConcessionLever[]> {
  const packs = await packsForBuilding(buildingId).catch(() => []);
  const levers: ConcessionLever[] = packs.map((p) => {
    const v = nominalPackValue((p.items as Array<{ basis?: string; priceUsd?: number }>) ?? []);
    return { kind: "furniture_pack" as const, label: p.label, ...(v > 0 ? { valueUsd: v } : {}) };
  });
  // A generic discount lever the AI may propose (maps to SaleDiscount; value chosen within the bound at decide).
  levers.push({ kind: "price_discount", label: "a direct price discount" });
  return levers;
}
