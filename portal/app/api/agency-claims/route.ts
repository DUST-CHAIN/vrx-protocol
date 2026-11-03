// GET /api/agency-claims?agency=<agencyAccount>
//   → the AGENCY's deal inbox: every booking opened by one of THIS agency's agents, read on the SERVER
//     (FastNEAR-keyed, so the browser never hits the throttled RPC). The agency-side twin of /api/claims
//  (the developer inbox) — SAME attested-records spine, SAME event mirror, SAME
//  channel threads. The whole point of was to build these on ONE shared seam, not bespoke.
//
//   Each row carries:
//       • the on-chain claim wire (status + opaque hashes + org + peer)   — the ledger truth
//  • the attested OFFER plaintext (payment plan / terms / …) — from the off-chain store
//       • `verified`: the offer re-hashed server-side == the on-chain request_hash (the ✓ VETTED seal)
//       • catalog NAMES for the unit + building (never on-chain)
//       • `agent`: which of the agency's agents opened it (from the claim's peer / the offer's `by`)
//       • `developer`: the developer the booking is against
//
// HOW AN AGENCY IS SCOPED TO A BOOKING (no contract change — the whole arc is off-chain):
//   The on-chain Claim stores `org` (agency) + `peer` (agent), but ClaimOpened{id,node} does NOT emit them
//   (lib.rs:1163) — so the event MIRROR alone can't tell which agency a booking belongs to. Two off-chain
//   links close that, and we union them so nothing is missed:
//     (A) the OFFERS store — every booking made through this portal records `developer` + `seal.by` (the
//         signing agent). lib/agents.ts maps agent → agency, so agencyOf(seal.by) === this agency selects
//         the agency's offers directly, with plaintext for the ✓ VETTED seal.
//     (B) the EVENT MIRROR — enumerates every ClaimOpened for known developers (held/resolved included,
//         the lib.rs:1191 gap). For any mirror booking we don't already have via (A), we read get_claim
//         once and keep it iff claim.o === this agency. This catches bookings a known agent made whose
//         offer POST didn't land, and gives live status for resolved ones.
//
// PRIVACY: the chain carries only opaque hashes + neutral account ids. Offer plaintext lives in OUR
// server store and is returned only to the agency party on its own deals; names come from the catalog.

import { NextResponse } from "next/server";
import { getClaimServer } from "@/lib/vrx-server";
import { allOffers, verifyOffer, type Offer } from "@/lib/offers";
import { listAgents } from "@/lib/agents";
import { getCatalog } from "@/lib/catalog";
import { allEvents } from "@/lib/events";
import { explainSaleCommission, type SaleCommission, type CommissionReason } from "@/lib/commission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AgencyInboxRow = {
  requestId: string;
  claim: Awaited<ReturnType<typeof getClaimServer>> | null;
  /** The attested offer (plaintext) if we hold it, else null (opened without an offer POST). */
  offer: Offer | null;
  /** Re-hash(offer) === on-chain request_hash. false when no offer or a mismatch (tamper tripwire). */
  verified: boolean;
  /** Catalog-resolved names for display (never on-chain). */
  names: { building?: string; unit?: string } | null;
  /** The agency's own agent who opened this booking (neutral account id). */
  agent: string | null;
  /** The developer the booking is against (neutral account id). */
  developer: string | null;
  /** the commission this agency earns on the sale (null = no live agreement/rate). B2B money; the
   *  agency dashboard sums these across its agents' deals. */
  commission: SaleCommission | null;
  /** H2 — WHY, so a blank earning is explained honestly instead of silent. */
  commissionReason: CommissionReason;
  /** ms epoch of the baseline, when `commissionReason === "before_baseline"`. */
  baselineAt?: number;
};

export async function GET(req: Request) {
  const agency = new URL(req.url).searchParams.get("agency")?.trim();
  if (!agency) return NextResponse.json({ error: "missing_agency" }, { status: 400 });
  const agencyLc = agency.toLowerCase();

  try {
    // Which agent accounts belong to this agency (off-chain mirror, lib/agents.ts). Used to select the
    // agency's own offers without reading the chain, and to attribute mirror bookings to an agent.
    const [agents, offers, events, catalog] = await Promise.all([
      listAgents().catch(() => []),
      allOffers().catch(() => [] as Offer[]),
      allEvents().catch(() => []),
      getCatalog().catch(() => []),
    ]);
    const myAgents = new Set(
      agents.filter((a) => a.agency.toLowerCase() === agencyLc).map((a) => a.account.toLowerCase())
    );

    // (A) This agency's offers: the signing agent (seal.by) belongs to this agency.
    const myOffers = offers.filter((o) => myAgents.has(o.seal.by.toLowerCase()));
    const offerById = new Map(myOffers.map((o) => [o.requestId, o]));

    // (B) Mirror candidates: every ClaimOpened we've seen (any developer), minus the ones we already have
    // an offer for. We resolve each via get_claim and keep only those whose on-chain org === this agency.
    const openedIds = new Set<string>();
    for (const e of events) {
      if (e.event !== "claim_opened") continue;
      const d = e.data as Record<string, unknown> | null;
      const id = typeof d?.id === "string" ? d.id : undefined;
      if (id && !offerById.has(id)) openedIds.add(id);
    }

    // Name enrichment (one catalog, reused). Only resolvable when we hold the offer's display refs.
    const nameOf = (o: Offer | null): AgencyInboxRow["names"] => {
      if (!o?.display) return null;
      const b = catalog.find((x) => x.id === o.display.buildingId);
      if (!b) return null;
      const u = b.inventory.find((x) => x.id === o.display.unitId);
      return { building: b.name, unit: u?.id?.replace(/^unit-/, "") ?? o.display.unitId };
    };

    // Resolve each offer's commission (+ reason) once, keyed by requestId (H2).
    const explained = new Map(
      await Promise.all(
        myOffers.map(async (o) => [o.requestId, await explainSaleCommission(o).catch(() => ({ commission: null, reason: "incomplete" as CommissionReason }))] as const)
      )
    );

    // Resolve the offer-backed rows (we already know they're ours) + probe the mirror candidates.
    const offerRows: AgencyInboxRow[] = await Promise.all(
      myOffers.map(async (offer): Promise<AgencyInboxRow> => {
        let claim = null;
        try {
          claim = await getClaimServer(offer.requestId);
        } catch {
          claim = null;
        }
        return {
          requestId: offer.requestId,
          claim,
          offer,
          verified: await verifyOffer(offer),
          names: nameOf(offer),
          agent: offer.seal.by,
          developer: offer.developer,
          ...(() => {
            const r = explained.get(offer.requestId) ?? { commission: null, reason: "incomplete" as CommissionReason };
            return { commission: r.commission, commissionReason: r.reason, baselineAt: (r as { baselineAt?: number }).baselineAt };
          })(),
        };
      })
    );

    const mirrorRows: AgencyInboxRow[] = (
      await Promise.all(
        Array.from(openedIds).map(async (requestId): Promise<AgencyInboxRow | null> => {
          let claim: Awaited<ReturnType<typeof getClaimServer>> | null = null;
          try {
            claim = await getClaimServer(requestId);
          } catch {
            claim = null;
          }
          // Keep only bookings this agency actually owns on-chain (org === agency). A claim we can't read
          // (resolved → dropped, or an RPC miss) can't be attributed safely, so we drop it rather than leak.
          const org = typeof claim?.o === "string" ? (claim.o as string) : undefined;
          if (!org || org.toLowerCase() !== agencyLc) return null;
          const peer = typeof claim?.p === "string" ? (claim.p as string) : null;
          const node = typeof claim?.n === "string" ? (claim.n as string) : null;
          return {
            requestId,
            claim,
            offer: null,
            verified: false,
            names: null,
            agent: peer,
            developer: node,
            commission: null,
            commissionReason: "incomplete",
          };
        })
      )
    ).filter((r): r is AgencyInboxRow => r !== null);

    const rows = [...offerRows, ...mirrorRows];

    // Open first (status 0), then most-recent by offer timestamp / claim updated_at.
    const recencyOf = (r: AgencyInboxRow) =>
      r.offer?.at ?? (typeof r.claim?.tu === "number" ? Math.floor((r.claim.tu as number) / 1_000_000) : 0);
    rows.sort((a, b) => {
      const ap = a.claim?.s === 0 ? 0 : 1;
      const bp = b.claim?.s === 0 ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return recencyOf(b) - recencyOf(a);
    });

    return NextResponse.json({ agency, rows });
  } catch {
    return NextResponse.json({ error: "rpc_busy" }, { status: 503 });
  }
}
