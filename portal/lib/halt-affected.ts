// HALT AFFECTED-SET RESOLVER — the ONE computation A2 and A3 share (Part A2/A3 of
// ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────────────────────────────────
// For a HALTED building, who is connected to it, and how? The system already holds every deal + every
// affected, the developer writes the NOTE"). It splits into two disjoint sets:
// (a) EXISTING-DEAL parties — every agent/agency/buyer on a confirmed sale, a live booking, or an open
// negotiation for a unit in the building. "Affects existing deals" ⇔ set (a) is non-empty (a computed
// fact, not a checkbox). → A2 pushes each an UNMISSABLE notice; A3 shows the developer the whole list.
// (b) FORWARD-ONLY partners — agencies with an agreement covering the building but NO live deal on it.
// → A2 gives these the lighter Part-B card; they're the "nobody to surprise YET but signed up" set.
// VRX is always in the set-to-notify — that's a CONSUMER concern (the push surfaces add VRX), not this
// resolver's: this computes the DEVELOPER-side affected parties, and stays role-neutral.
// • A2 (the affected party's view): iterate set (a) → push each party its own notice; set (b) → the card.
// • A3 (the developer's cockpit): render the WHOLE of set (a) as the halt-impact list, each deal with its
// stage + counterparty + crystallised obligation. Same resolver, projected for the developer.
// The resolver returns RAW refs (accounts + requestIds + derived stage) — it does NOT mask-resolve the buyer
// or decide who may SEE what. That entitlement boundary (reveal state; "surfaces not instructs")
// lives in each CONSUMER route, which applies developerView etc. before anything leaves the server.
// ── DEAL STAGE is DERIVED, not stored (D-b drift, re-verified) ─────────────────────────────────
// There is no "booking vs negotiation" field on an offer. The three design stages map onto real fields:
// confirmed sale ⇐ offer.confirmed present ( — closed on-chain / crystallised).
// live booking ⇐ not confirmed, but the S&P contract has advanced past `preview` (final / payment_arrived
// / signed) — a deal genuinely in flight.
// open negotiation ⇐ not confirmed, contract still at `preview` (the default) — an early, unsettled booking.
// This is a READ-TIME derivation; it never writes.
// ── BUILDING MATCH tolerates an absent id (D-S177b drift) ───────────────────────────────────────────────
// offer.display.buildingId is OPTIONAL (a direct-desk offer is keyed by conversationId, not a buildingId, and
// has no agent-side party). An offer with no buildingId simply can't match a halted building BY ID → it is not
// in the affected set (honest: it's not reachable via the building-halt path). Case-insensitive match.
// ── AGENCY joins via the AGREEMENT / agent registry, it is NOT on the offer (D-S177b drift) ─────────────
// An offer carries the AGENT (seal.by), never the agency. The agency is resolved agencyOf(agent) — the same
// chain lib/commission uses. A party set therefore folds agent + its agency + the buyer ref together.
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────
// Reads only server-side stores; opaque account ids + request ids; no PII, nothing on-chain. The buyer is
// carried as a REFERENCE (requestId + the off-seal buyerId/buyer label), never a resolved identity — the
// consumer applies the mask. Pure read: never mutates a store.

import { allOffers, contractStage, type Offer } from "./offers";
import { agreementsForParty } from "./agreements";
import { agencyOf } from "./agents";

/** The three deal stages, DERIVED from an offer's confirmed + contract fields (see header). */
export type DealStage = "confirmed_sale" | "live_booking" | "open_negotiation";

/**
 * Derive a deal's stage from the real offer fields. confirmed → sale; else contract past preview → live
 * booking; else (preview / absent contract) → open negotiation. A pure, total function over one offer.
 */
export function dealStage(o: Offer): DealStage {
  if (o.confirmed) return "confirmed_sale";
  const stage = contractStage(o); // preview | final | payment_arrived | signed
  if (stage === "preview") return "open_negotiation";
  return "live_booking"; // final / payment_arrived / signed = in flight
}

/** One existing deal touching a halted building — the raw refs a consumer enriches/masks (set a). */
export type AffectedDeal = {
  /** The on-chain/portal request id — the join key for the offer, obligation, mask state, deep link. */
  requestId: string;
  /** The catalog unit id this deal is on (display extra; may be absent on an old/odd record). */
  unitId?: string;
  /** Derived deal stage (see DealStage). */
  stage: DealStage;
  /** The AGENT who authored the booking (seal.by), lower-cased. Empty for an agent-less (direct-desk) offer. */
  agent: string;
  /** The AGENCY the agent belongs to (agencyOf), lower-cased, or null if the agent isn't registered / absent. */
  agency: string | null;
  /** The buyer REFERENCE this booking attached, if any (off-seal display id/account — NOT a resolved identity).
   * A consumer that may show the buyer resolves it through the mask (developerView); this is only the link. */
  buyerRef?: string;
};

/** The full affected set for a halted building — the shared output A2 and A3 both read. */
export type HaltAffectedSet = {
  /** The building this set was resolved for (as passed; echoed for the consumer). */
  building: string;
  /** (a) Every existing deal on the building, newest first. Non-empty ⇔ "affects existing deals". */
  deals: AffectedDeal[];
  /** The distinct existing-deal PARTY accounts (agents + their agencies + buyer refs), deduped, lower-cased —
   * the set A2 pushes the UNMISSABLE notice to. Derived from `deals`; a convenience over re-walking them. */
  existingParties: string[];
  /** (b) Agencies with an agreement COVERING the building but NO live deal on it — the forward-only partners
   * (the lighter Part-B card). Deduped, lower-cased, and DISJOINT from any agency already in `existingParties`. */
  forwardOnlyAgencies: string[];
  /** True iff `deals` is non-empty — the computed "affects existing deals" fact (never a stored flag). */
  affectsExistingDeals: boolean;
};

const lc = (s: string) => s.trim().toLowerCase();

/**
 * Resolve the affected set for a halted building (over `allOffers` + the agreements store). Pure read; the
 * `developer` scopes BOTH halves to inventory this developer owns (set a: deals where offer.developer === dev;
 * set b: agreements where this dev is the inventory owner) — so a resolver call is always about ONE developer's
 * halt on ONE of their buildings, never a cross-developer leak. Case-insensitive throughout.
 *
 * The `developer` + `building` are the same pair the halt was asserted on; passing them (rather than re-reading
 * the halt record) keeps this resolver usable for the A3 PRE-HALT PREVIEW too — the developer sees the impact of
 * a halt they haven't committed yet (design §A3), so it must not depend on a live halt record existing.
 */
export async function resolveHaltAffected(developer: string, building: string): Promise<HaltAffectedSet> {
  const dev = lc(developer);
  const bid = lc(building);
  const empty: HaltAffectedSet = {
    building,
    deals: [],
    existingParties: [],
    forwardOnlyAgencies: [],
    affectsExistingDeals: false,
  };
  if (!dev || !bid) return empty;

  // ── SET (a): existing deals on THIS developer's building ──────────────────────────────────────────────
  // An offer is on the building iff its developer owns it AND its display.buildingId matches (case-insensitive).
  // An offer with no buildingId (direct-desk) can't match by id → excluded. Newest first (offer.at desc).
  const offers = (await allOffers())
    .filter((o) => lc(o.developer) === dev && o.display.buildingId && lc(o.display.buildingId) === bid)
    .sort((a, b) => b.at - a.at);

  const deals: AffectedDeal[] = [];
  const existing = new Set<string>();
  // The set of agencies that ALREADY have a live deal — these are excluded from the forward-only set (b).
  const dealAgencies = new Set<string>();

  for (const o of offers) {
    const agent = o.seal.by ? lc(o.seal.by) : "";
    const agency = agent ? await agencyOf(agent) : null;
    const agencyLc = agency ? lc(agency) : null;
    const buyerRef =
      (typeof o.display.buyerId === "string" && o.display.buyerId.trim()) ||
      (typeof o.display.buyer === "string" && o.display.buyer.trim()) ||
      undefined;

    deals.push({
      requestId: o.requestId,
      unitId: o.display.unitId,
      stage: dealStage(o),
      agent,
      agency: agencyLc,
      ...(buyerRef ? { buyerRef } : {}),
    });

    if (agent) existing.add(agent);
    if (agencyLc) {
      existing.add(agencyLc);
      dealAgencies.add(agencyLc);
    }
    if (buyerRef) existing.add(lc(buyerRef));
  }

  // ── SET (b): forward-only partners — an agreement covers the building but no live deal on it ────────────
  // "Covers the building" = ANY agreement (any status) naming this dev as owner + listing the building — the
  // SAME boundary as catalog-edit-gate.buildingHasPartner (the demote boundary the whole arc hangs off). An
  // agency already in set (a) is removed (disjoint sets): it's an EXISTING-deal party, not forward-only.
  const forward = new Set<string>();
  for (const g of await agreementsForParty(dev)) {
    if (lc(g.seal.developer) !== dev) continue; // dev must be the inventory owner, not the agency side
    if (!g.seal.buildings.some((b) => lc(b.buildingId) === bid)) continue; // agreement must cover THIS building
    const ag = lc(g.seal.agency);
    if (!ag) continue; // a PUBLISHED agreement has no named agency yet — nobody concrete to notify
    if (dealAgencies.has(ag)) continue; // already an existing-deal party → belongs to set (a), not (b)
    forward.add(ag);
  }

  return {
    building,
    deals,
    existingParties: [...existing],
    forwardOnlyAgencies: [...forward],
    affectsExistingDeals: deals.length > 0,
  };
}
