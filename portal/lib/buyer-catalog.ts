// BUYER-SCOPED CATALOG READ — SERVER-ONLY ( §9 step 2). The anti-browsing funnel's FIRST gate: what a
// logged-in, pre-conversation DIRECT BUYER may see of the catalog. Fail-closed by construction.
// ── What a buyer sees ( §8-resolved-2) ───────────────────────────────────────────────────────────
// ONLY buildings flagged `directSale.visible === true`, projected to:
// building photos + description + unit COUNT + price RANGE.
// NOT included: per-unit records, individual unit availability/status, exact prices, floor plans, the
// seller entity, land/legal, terms, geo pins. Those stay gated until the operator OPENS specific units to
// this buyer (steps 3–5). Per-unit detail is never in this projection — the projection is LOSSY ON PURPOSE.
// ── Fail-closed ───────────────────────────────────────────────────────────────────────────────────────
// Default-deny: a building with no `directSale` or `visible:false` is omitted entirely (never 200s a hidden
// building's data). `buyerBuilding(id)` returns null for any non-visible id → the route 404s it. This is a
// server-side projection, NOT UI hiding — the un-projected fields never leave the server for a buyer viewer.
// This is the "buyer viewer" half of the catalog seam; the developer/agent reads (lib/catalog getCatalog /
// getBuilding) are unchanged and keep returning the full Building. A buyer NEVER calls those.

import { getCatalog, type Building } from "@/lib/catalog";
import { listImages } from "@/lib/mm";
import { suspendedDevelopers, isDeveloperHidden, haltedListingBuildings, isListingHaltedBuilding } from "@/lib/listing-gate";
import { listDevelopers } from "@/lib/developers";

// Resolve a building id → its developer ACCOUNT id (the on-chain handle the listing gate keys on). The
// listing gate (hasSignedCurrentTerms / resolveStandingForDeveloper) is account-keyed, but Building.developer
// is a DISPLAY LABEL ("Summit Estates"), NOT the account — passing the label made the gate find no signed
// agreement and hide EVERY building (the label-vs-account trap, surfaced again via an empty buyer
// browse). The developer registry (lib/developers) is the authoritative buildingId → account mapping.
async function buildingDeveloperAccounts(): Promise<Map<string, string>> {
  const devs = await listDevelopers();
  const m = new Map<string, string>();
  for (const d of devs) for (const b of d.buildingIds) m.set(b, d.account);
  return m;
}

/** The lossy projection a direct buyer may see of ONE building. No per-unit data, no availability. */
export type BuyerBuildingView = {
  id: string;
  name: string;
  tagline: string;
  area: string;
  address: string;
  type: string;
  completion: string;
  amenities: string[];
  /** Developer-authored funnel copy for this building, if set. */
  funnelCopy?: string;
  /** How many units the development has (a COUNT only — never the unit list). */
  unitCount: number;
  /** Price RANGE across the inventory in USD base, or null if no priced units. Never exact per-unit prices. */
  priceRange: { minUsd: number; maxUsd: number } | null;
  /** Marketing photos (exterior/interior/facilities). Floor plans are DELIBERATELY excluded (they reveal
   * unit layouts — too much pre-conversation). Empty arrays if the building has no media. */
  photos: { exterior: string[]; interior: string[]; facilities: string[] };
};

/** Is this building visible to direct buyers? The single fail-closed predicate. */
export function isBuyerVisible(b: Building | null | undefined): boolean {
  return !!b && b.directSale?.visible === true;
}

/** Price range across a building's inventory (USD base), or null if nothing is priced. */
function priceRangeOf(b: Building): { minUsd: number; maxUsd: number } | null {
  const prices = (b.inventory ?? [])
    .map((u) => u.priceUsd)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0);
  if (prices.length === 0) return null;
  return { minUsd: Math.min(...prices), maxUsd: Math.max(...prices) };
}

/** Project ONE building to the buyer view (assumes visibility already checked). */
async function projectBuilding(b: Building): Promise<BuyerBuildingView> {
  const imgs = await listImages(b.id);
  return {
    id: b.id,
    name: b.name,
    tagline: b.tagline,
    area: b.area,
    address: b.address,
    type: b.type,
    completion: b.completion,
    amenities: b.amenities ?? [],
    funnelCopy: b.directSale?.funnelCopy,
    // COUNT only. Prefer the published total; fall back to the inventory length. Never the unit list.
    unitCount: typeof b.units === "number" && b.units > 0 ? b.units : (b.inventory?.length ?? 0),
    priceRange: priceRangeOf(b),
    photos: {
      exterior: imgs?.exterior ?? [],
      interior: imgs?.interior ?? [],
      facilities: imgs?.facilities ?? [],
    },
  };
}

/** Every building a direct buyer may browse — visible ones only, each projected. Fail-closed.
 * §3c: a suspended/removed developer's buildings are dropped WHOLESALE from buyer discovery (developer
 * grain). Part A: a HALTED building is ALSO dropped (building grain — the developer's own pause). Both
 * are forward-only (new discovery): there's no conflict here — the buyer catalog is pure NEW-inventory
 * discovery; nobody's existing deal routes through it (those continue on the conversation/deal surfaces).
 * Contrast the agent read, which keeps live-hold units visible (lib/listing-gate, per-unit grain). */
export async function buyerCatalog(opts?: { asOf?: number }): Promise<BuyerBuildingView[]> {
  const all = await getCatalog();
  const visible = all.filter(isBuyerVisible);
  // Gate on the developer ACCOUNT (registry-resolved), not the display label — see buildingDeveloperAccounts.
  const accountOf = await buildingDeveloperAccounts();
  const accounts = visible.map((b) => accountOf.get(b.id)).filter((a): a is string => !!a);
  const [hidden, halted] = await Promise.all([
    suspendedDevelopers(accounts, { asOf: opts?.asOf }),
    haltedListingBuildings(), // building-grain: ids of buildings with an ACTIVE halt
  ]);
  const shown = visible.filter((b) => {
    const acct = accountOf.get(b.id);
    // A building with no registry mapping can't be verified as signed → fail-closed (hide it), same safe side
    // the gate takes for an unknown developer (signing precedes listing). Then OR the two withhold reasons:
    // developer §3c-suspended OR this building halted.
    if (!acct || hidden.has(acct.trim().toLowerCase())) return false;
    return !halted.has(b.id.trim().toLowerCase());
  });
  return Promise.all(shown.map(projectBuilding));
}

/** ONE building's buyer view by id — null if it doesn't exist, isn't direct-sale-visible, its developer
 * is §3c-hidden (suspended/removed), OR the building is HALTED (Part A) → route 404s. Fail-closed on
 * every axis. */
export async function buyerBuilding(id: string, opts?: { asOf?: number }): Promise<BuyerBuildingView | null> {
  const b = (await getCatalog()).find((x) => x.id === id.trim());
  if (!isBuyerVisible(b)) return null; // fail-closed: never leak a hidden building
  if (await isListingHaltedBuilding((b as Building).id)) return null; // Part A: a halted building is withheld
  // Gate on the developer ACCOUNT (registry-resolved), not the display label (b.developer) — see
  // buildingDeveloperAccounts. No mapping ⇒ can't prove signed ⇒ fail-closed (hide).
  const acct = (await buildingDeveloperAccounts()).get((b as Building).id);
  if (!acct || (await isDeveloperHidden(acct, { asOf: opts?.asOf }))) return null; // hidden-developer + signing guard
  return projectBuilding(b as Building);
}
