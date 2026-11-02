// GET /api/claims?node=<developerAccount>
// → the developer's incoming BOOKINGS for the inbox, read on the SERVER (FastNEAR-keyed, so the inbox
// never hits the throttled public RPC from the browser). Returns both PENDING and RESOLVED bookings,
// each enriched with:
// • the on-chain claim wire (status + opaque hashes) — the ledger truth
// • the attested OFFER plaintext (payment plan / terms / …) —, from the off-chain store
// • `verified`: the offer re-hashed server-side == the on-chain request_hash (the ✓ VETTED seal)
// • catalog NAMES for the unit + building (never on-chain; from display refs in the offer record)
// SOURCES merged (so nothing is missed):
// 1. get_pending_claims(node) — the on-chain pending queue (authoritative for "waiting on you").
// 2. /api/offers index for this developer — every booking we witnessed, incl. ones already RESOLVED
// (accepted/declined/confirmed) so the inbox can show history. Each is re-read for its live status.
// 3. the EVENT MIRROR — claimsForNode(node), reconstructed from ClaimOpened/ClaimReplied
// events. This is what fixes the HELD-UNITS GAP (lib.rs:1191): once a developer accepts, reply_claim
// drops the claim from the on-chain pending queue (source 1) AND if the booking was opened outside
// this portal there's no offer (source 2) — so a HELD booking would otherwise be invisible. The event
// persists, so the mirror still enumerates it. It also gives a status fallback when get_claim 429s.
// A booking in (2)/(3) but not (1) is resolved or lapsed; a booking in (1) but not (2) was opened outside
// this portal (no plaintext) — shown as "offer unavailable", still actionable.
// PRIVACY: the chain carries only opaque hashes. The offer plaintext lives in OUR server store and
// is returned only to the developer party here; names come from the developer's own catalog. No PII on-chain.

import { NextResponse } from "next/server";
import { getPendingClaimsServer, getClaimServer } from "@/lib/vrx-server";
import { offersForDeveloper, verifyOffer, developerView, type Offer } from "@/lib/offers";
import { explainSaleCommission, type SaleCommission, type CommissionReason } from "@/lib/commission";
import { checkBuyerPolicy, policySummary, type PolicyBuyerFields } from "@/lib/buyer-policy";
import { getDeveloper } from "@/lib/developers";
import { getCatalog } from "@/lib/catalog";
import { claimsForNode, type ClaimView } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type InboxRow = {
  requestId: string;
  claim: Awaited<ReturnType<typeof getClaimServer>> | null;
  /** The attested offer (plaintext) if we hold it, else null (booked outside this portal). */
  offer: Offer | null;
  /** Re-hash(offer) === on-chain request_hash. false when no offer or a mismatch (tamper tripwire). */
  verified: boolean;
  /** Catalog-resolved names for display (never on-chain). */
  names: { building?: string; unit?: string } | null;
  /** completeness against the booking floor — computed from the FULL buyer server-side (the developer
   * can't see masked fields, so the badge is the only honest signal of whether the floor is met). */
  buyerPolicy: { ok: boolean; summary: string } | null;
  /** — the agency commission payable on this sale (developer sees what they'll owe). null = no live
   * agreement/rate. B2B money (no buyer PII) — fine for the developer view. */
  commission: SaleCommission | null;
  /** H2 — WHY, so the UI can explain a blank honestly instead of silent nothing. */
  commissionReason: CommissionReason;
  /** ms epoch of the baseline, when `commissionReason === "before_baseline"` (for the date in the copy). */
  baselineAt?: number;
};

export async function GET(req: Request) {
  const node = new URL(req.url).searchParams.get("node")?.trim();
  if (!node) return NextResponse.json({ error: "missing_node" }, { status: 400 });
  try {
    // (1) on-chain pending queue + (2) every offer we witnessed + (3) the event mirror (held-units fix).
    const [pendingIds, offers, mirror] = await Promise.all([
      getPendingClaimsServer(node).catch(() => [] as string[]),
      offersForDeveloper(node).catch(() => [] as Offer[]),
      claimsForNode(node).catch(() => [] as ClaimView[]),
    ]);

    // The union of request ids from all three sources (dedup). The mirror contributes HELD/resolved
    // bookings that have dropped off the pending queue and have no local offer.
    const offerById = new Map(offers.map((o) => [o.requestId, o]));
    const mirrorById = new Map(mirror.map((c) => [c.requestId, c]));
    const allIds = Array.from(
      new Set<string>([...pendingIds, ...offerById.keys(), ...mirrorById.keys()])
    );

    // Catalog for name enrichment (building/unit display names). One read, reused for all rows.
    const catalog = await getCatalog().catch(() => []);
    // — the completeness BADGE must be DEVELOPER-AWARE, mirroring the agent gate (commit 2): grade each
    // buyer against THIS developer's `requiredProfileFields` override (not the global FLOOR), so "complete"
    // means "complete for the developer who's looking". One read for the node, reused for every row. Absent
    // override → checkBuyerPolicy falls back to the global default, so the badge is never less strict.
    const requiredFields = (await getDeveloper(node).catch(() => null))?.requiredProfileFields ?? null;
    const nameOf = (o: Offer | null): InboxRow["names"] => {
      if (!o?.display) return null;
      const b = catalog.find((x) => x.id === o.display.buildingId);
      if (!b) return null;
      const u = b.inventory.find((x) => x.id === o.display.unitId);
      return { building: b.name, unit: u?.id?.replace(/^unit-/, "") ?? o.display.unitId };
    };

    const rows: InboxRow[] = await Promise.all(
      allIds.map(async (requestId): Promise<InboxRow> => {
        const offer = offerById.get(requestId) ?? null;
        let claim = null;
        try {
          claim = await getClaimServer(requestId);
        } catch {
          claim = null; // one bad read shouldn't sink the whole inbox
        }
        // Mirror fallback: if the live read returned nothing (resolved → off the pending queue, or a
        // transient RPC failure) but the event mirror knows this booking's status, synthesize a minimal
        // claim wire from it so the inbox can still group/show it (the held-units fix, lib.rs:1191).
        const mv = mirrorById.get(requestId);
        if (!claim && mv) {
          claim = { s: mv.status };
        }
        // masking gate: verify against the FULL offer (the on-chain hash sealed the full buyer), but
        // ship the developer only the masked projection while the buyer is still locked. The ✓ VETTED seal
        // stays honest; the withheld plaintext never leaves the server until the reveal act fires.
        // — evaluate completeness against the FULL buyer (before masking), so the badge is honest even
        // while the detail itself stays hidden. null when no buyer is attached (nothing to grade).
        const fullBuyer = offer?.seal.buyer as PolicyBuyerFields | undefined;
        const hasBuyer = fullBuyer && typeof fullBuyer === "object" && Object.keys(fullBuyer).length > 0;
        const pol = hasBuyer ? checkBuyerPolicy(fullBuyer, "book", requiredFields) : null;
        return {
          requestId,
          claim,
          offer: offer ? developerView(offer) : null,
          verified: offer ? await verifyOffer(offer) : false,
          names: nameOf(offer),
          buyerPolicy: pol ? { ok: pol.ok, summary: policySummary(pol) } : null,
          ...(await (async () => {
            const r = offer
              ? await explainSaleCommission(offer).catch(() => ({ commission: null, reason: "incomplete" as CommissionReason }))
              : { commission: null, reason: "incomplete" as CommissionReason, baselineAt: undefined as number | undefined };
            return { commission: r.commission, commissionReason: r.reason, baselineAt: (r as { baselineAt?: number }).baselineAt };
          })()),
        };
      })
    );

    // Pending first, then most-recent resolved. Pending = on-chain status 0 (OPEN).
    const recencyOf = (id: string, o: Offer | null) =>
      o?.at ?? mirrorById.get(id)?.repliedAt ?? mirrorById.get(id)?.openedAt ?? 0;
    rows.sort((a, b) => {
      const ap = a.claim?.s === 0 ? 0 : 1;
      const bp = b.claim?.s === 0 ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return recencyOf(b.requestId, b.offer) - recencyOf(a.requestId, a.offer);
    });

    // Keep the legacy `ids`/`claims` shape too, so any older client keeps working during rollout.
    return NextResponse.json({
      node,
      rows,
      ids: rows.map((r) => r.requestId),
      claims: rows.map((r) => ({ id: r.requestId, claim: r.claim })),
    });
  } catch {
    return NextResponse.json({ error: "rpc_busy" }, { status: 503 });
  }
}
