// GET /api/agent-claims?agent=<agentAccount>
//   → the AGENT's "My bookings": every booking THIS agent opened, read on the SERVER (FastNEAR-keyed, so
//     the mobile browser never hits the throttled RPC). The agent-side twin of /api/claims (developer
//  inbox) and /api/agency-claims (agency inbox) — SAME attested-records spine, SAME event mirror
// SAME channel threads. One shared seam, three role views.
//
//   Each row carries:
//       • the on-chain claim wire (status 0..3 + opaque hashes + node/org/peer) — the ledger truth. The
//         status IS the developer's reply: 0 open(awaiting) · 1 accepted(held, deposit awaited) · 2 declined
//         · 3 alternative-offered (CLAIM_STATUS, lib/vrx.ts).
//  • the attested OFFER plaintext (payment plan / terms / buyer) — the agent's OWN copy. Unlike the
//         developer/agency views this is NOT masked: the agent authored the buyer detail, so it sees its own
//  full seal (masking is a developer-facing protection).
//       • `verified`: the offer re-hashed server-side == the on-chain request_hash (the ✓ VETTED seal).
//       • catalog NAMES for the unit + building (never on-chain).
//       • `developer`: the developer the booking is against (neutral account id).
//
// SCOPING (no contract change — all off-chain): the OFFERS store records `seal.by` (the signing agent), so
// offersForAgent(agent) selects this agent's bookings directly, with plaintext for the ✓ seal. We also sweep
// the EVENT MIRROR for ClaimOpened we don't already have an offer for and keep those whose on-chain `peer`
// (p) === this agent — catches a booking whose offer POST didn't land, and gives live status for resolved
// ones (the lib.rs:1191 "ClaimOpened omits peer" gap is closed by reading get_claim once per candidate).
//
// PRIVACY: the chain carries only opaque hashes + neutral account ids. Offer plaintext lives in OUR
// server store and is returned only to the authoring agent on its own deals; names come from the catalog.

import { NextResponse } from "next/server";
import { getClaimServer } from "@/lib/vrx-server";
import { offersForAgent, verifyOffer, type Offer } from "@/lib/offers";
import { getCatalog } from "@/lib/catalog";
import { allEvents } from "@/lib/events";
import { explainSaleCommission, type SaleCommission, type CommissionReason } from "@/lib/commission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AgentBookingRow = {
  requestId: string;
  claim: Awaited<ReturnType<typeof getClaimServer>> | null;
  /** The attested offer (plaintext, the agent's own full seal) if we hold it, else null. */
  offer: Offer | null;
  /** Re-hash(offer) === on-chain request_hash. false when no offer or a mismatch (tamper tripwire). */
  verified: boolean;
  /** Catalog-resolved names for display (never on-chain). */
  names: { building?: string; unit?: string } | null;
  /** The developer the booking is against (neutral account id). */
  developer: string | null;
  /** the agency commission this agent earns on the sale (null = no live agreement/rate). Agent sees
   *  their own earning; NEVER sent to a buyer surface. */
  commission: SaleCommission | null;
  /** H2 — WHY, so a blank earning is explained honestly instead of silent. */
  commissionReason: CommissionReason;
  /** ms epoch of the baseline, when `commissionReason === "before_baseline"`. */
  baselineAt?: number;
};

export async function GET(req: Request) {
  const agent = new URL(req.url).searchParams.get("agent")?.trim();
  if (!agent) return NextResponse.json({ error: "missing_agent" }, { status: 400 });
  const agentLc = agent.toLowerCase();

  try {
    const [offers, events, catalog] = await Promise.all([
      // includeBuyerless: My-bookings must not hide a CONFIRMED, commission-bearing booking that happens
      // to have no buyer object attached (the buyer-required filter is for the protection surface, not this one).
      offersForAgent(agent, { includeBuyerless: true }).catch(() => [] as Offer[]),
      allEvents().catch(() => []),
      getCatalog().catch(() => []),
    ]);

    // (A) This agent's offers (offersForAgent already filters seal.by === agent).
    const offerById = new Map(offers.map((o) => [o.requestId, o]));

    // (B) Mirror candidates: every ClaimOpened we've seen, minus the ones we already hold an offer for.
    // Resolve each via get_claim and keep only those whose on-chain peer (p) === this agent.
    const openedIds = new Set<string>();
    for (const e of events) {
      if (e.event !== "claim_opened") continue;
      const d = e.data as Record<string, unknown> | null;
      const id = typeof d?.id === "string" ? d.id : undefined;
      if (id && !offerById.has(id)) openedIds.add(id);
    }

    // Name enrichment (one catalog, reused). Only resolvable when we hold the offer's display refs.
    const nameOf = (o: Offer | null): AgentBookingRow["names"] => {
      if (!o?.display) return null;
      const b = catalog.find((x) => x.id === o.display.buildingId);
      if (!b) return null;
      const u = b.inventory.find((x) => x.id === o.display.unitId);
      return { building: b.name, unit: u?.id?.replace(/^unit-/, "") ?? o.display.unitId };
    };

    // Resolve each offer's commission (+ reason) once, keyed by requestId (H2).
    const explained = new Map(
      await Promise.all(
        offers.map(async (o) => [o.requestId, await explainSaleCommission(o).catch(() => ({ commission: null, reason: "incomplete" as CommissionReason }))] as const)
      )
    );

    const offerRows: AgentBookingRow[] = await Promise.all(
      offers.map(async (offer): Promise<AgentBookingRow> => {
        let claim = null;
        try {
          claim = await getClaimServer(offer.requestId);
        } catch {
          claim = null;
        }
        return {
          requestId: offer.requestId,
          claim,
          offer, // the agent's OWN full seal — not masked (it authored the buyer detail)
          verified: await verifyOffer(offer),
          names: nameOf(offer),
          developer: offer.developer,
          ...(() => {
            const r = explained.get(offer.requestId) ?? { commission: null, reason: "incomplete" as CommissionReason };
            return { commission: r.commission, commissionReason: r.reason, baselineAt: (r as { baselineAt?: number }).baselineAt };
          })(),
        };
      })
    );

    const mirrorRows: AgentBookingRow[] = (
      await Promise.all(
        Array.from(openedIds).map(async (requestId): Promise<AgentBookingRow | null> => {
          let claim: Awaited<ReturnType<typeof getClaimServer>> | null = null;
          try {
            claim = await getClaimServer(requestId);
          } catch {
            claim = null;
          }
          // Keep only bookings this agent actually opened on-chain (peer === agent). A claim we can't read
          // (resolved → dropped, or an RPC miss) can't be attributed safely, so we drop it rather than leak.
          const peer = typeof claim?.p === "string" ? (claim.p as string) : undefined;
          if (!peer || peer.toLowerCase() !== agentLc) return null;
          const node = typeof claim?.n === "string" ? (claim.n as string) : null;
          return { requestId, claim, offer: null, verified: false, names: null, developer: node, commission: null, commissionReason: "incomplete" as CommissionReason };
        })
      )
    ).filter((r): r is AgentBookingRow => r !== null);

    const rows = [...offerRows, ...mirrorRows];

    // Open first (status 0), then most-recent by offer timestamp / claim updated_at.
    const recencyOf = (r: AgentBookingRow) =>
      r.offer?.at ?? (typeof r.claim?.tu === "number" ? Math.floor((r.claim.tu as number) / 1_000_000) : 0);
    rows.sort((a, b) => {
      const ap = a.claim?.s === 0 ? 0 : 1;
      const bp = b.claim?.s === 0 ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return recencyOf(b) - recencyOf(a);
    });

    return NextResponse.json({ agent, rows });
  } catch {
    return NextResponse.json({ error: "rpc_busy" }, { status: 503 });
  }
}
