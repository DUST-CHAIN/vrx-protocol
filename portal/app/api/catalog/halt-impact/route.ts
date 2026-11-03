// /api/catalog/halt-impact — the DEVELOPER's HALT-IMPACT COCKPIT (Part A3, the design docs).
//
//   GET ?building=<id> [&account=<dev>]
//     → { building, affectsExistingDeals, count, totals, deals[] }
//        The developer's OWN view of everything a halt on this building touches: every existing deal they may
//        need to break / refund / cancel / renegotiate, each with its unit, derived stage, counterparty, and
//        the crystallised obligation (agency commission + VRX fee) already owed on it. A running count + USD
//        totals at the top. A2 pushes each AFFECTED PARTY their own notice; A3 shows the DEVELOPER the whole
//        list — SAME affected-set resolver (lib/halt-affected), projected for the developer. One computation.
//
// ── PRE-HALT PREVIEW ────────────────────────────────────────────────────────────────────────────────────
// This does NOT require a live halt to exist — the resolver takes (developer, building), so the developer sees
// the impact of a halt they are CONSIDERING before they confirm it (design §A3: so the note they write + the
// regular-vs-urgent choice are informed). Post-halt it stays as the live "impact" tab until the halt lifts.
//
// ── IT SURFACES, IT DOES NOT INSTRUCT ─────────────────────────────────────────────────────────────
// VRX lists what's affected + each deal's current state + what's already owed. It does NOT tell the developer
// to refund/cancel, nor adjudicate the right action — those are the developer's (and counterparties') calls,
// made in the relationship channel (Part D). The route returns FACTS; the UI copy stays plain + non-judgmental.
//
// ── AUTH: F1 requireCaller (identity) + developer OWNERSHIP check (same posture as /api/catalog/halt) ───────
// A developer's halt-impact for their OWN building is a B2B fact only the owner may read. F1 proves WHO; the
// ownership check proves the caller owns the building. Fail-closed: no caller → 401; not the owner → 403;
// unknown building → 404.
//
// ── PRIVACY + the BUYER MASK ───────────────────────────────────────────────────────────
// The agency + agent are B2B partners — always shown to the developer. The BUYER line is shown ONLY as far as
// the developer is already entitled: we run each deal's offer through lib/offers.developerView (the exact gate
// the inbox uses), so while the buyer is still masked the developer sees only the masked hint, and only after a
// reveal act does a fuller label surface. A3 NEVER widens buyer disclosure — the mask/reveal state still
// governs (design §A3 explicitly). Nothing on-chain; opaque ids; the per-record salt never leaves the server.

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import { getDeveloper, protocolFeePct, type Developer } from "@/lib/developers";
import { requireCaller } from "@/lib/caller";
import { resolveHaltAffected, type DealStage } from "@/lib/halt-affected";
import { getOffer, developerView, type Offer } from "@/lib/offers";
import { explainSaleCommission } from "@/lib/commission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** True iff `dev` owns `buildingId` (its developer-registry buildingIds include it) — the A3 authorisation
 *  (identical to the halt route: F1 proves identity; this proves ownership). Takes the already-fetched record
 *  so the route reads the developer ONCE (it also needs the fee rate off the same record). */
function ownsBuilding(dev: Developer | null, buildingId: string): boolean {
  if (!dev) return false;
  const bid = buildingId.trim().toLowerCase();
  return dev.buildingIds.some((id) => id.trim().toLowerCase() === bid);
}

/** One deal line the developer sees on the impact cockpit — the FACTS, developer-safe. */
type ImpactDeal = {
  requestId: string;
  unitLabel: string;
  stage: DealStage;
  /** B2B counterparty — always shown to the developer. */
  agency: string | null;
  agent: string;
  /** The buyer line AS THE DEVELOPER IS ENTITLED to see it (masked hint while locked; fuller after a reveal).
   *  A short human-ish label built from the developerView buyer map, or null when nothing is disclosable. */
  buyer: string | null;
  /** True iff the buyer detail is still masked to the developer (so the UI can say "identity protected"). */
  buyerMasked: boolean;
  /** The crystallised money ALREADY OWED on this deal (frozen snapshot for a confirmed sale; live preview for a
   *  prospective booking), or null when none resolves (no agreement / predates baseline / no rate). */
  obligation: {
    commissionPct: number;
    commissionUsd: number;
    feePct: number;
    feeUsd: number;
    agency: string;
    /** "earned" (crystallised on a closed sale) | "prospective" (a preview on a not-yet-closed booking). */
    kind: "earned" | "prospective";
  } | null;
};

/** Build a short, mask-safe buyer label from a developer-view offer. Picks the first disclosable identity-ish
 *  field (name → email → a generic "buyer"); returns null if the masked view exposes nothing. Never emits
 *  withheld plaintext — it reads ONLY the already-masked map developerView produced. */
function buyerLabel(o: Offer): { label: string | null; masked: boolean } {
  const masked = !o.unlock?.revealed;
  const b = o.seal.buyer as Record<string, string> | undefined;
  if (!b || typeof b !== "object") return { label: null, masked };
  const pick =
    b.legalName || b.name || b.fullName || b.email || b.phone || undefined;
  return { label: pick ? String(pick) : null, masked };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const building = (searchParams.get("building") ?? "").trim();
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });

  // Identity (F1) + ownership — a halt-impact readout is the owner's private B2B view.
  const caller = requireCaller(req, { param: searchParams.get("account") });
  if (!caller.ok) return NextResponse.json({ error: caller.reason }, { status: caller.status });

  const [b, dev] = await Promise.all([getBuilding(building), getDeveloper(caller.account).catch(() => null)]);
  if (!b) return NextResponse.json({ error: "building not found" }, { status: 404 });
  if (!ownsBuilding(dev, building)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // The shared resolver (same one A2 reads) → set (a) existing deals, projected for THIS developer.
  const set = await resolveHaltAffected(caller.account, building);
  // The developer's CURRENT VRX protocol-fee rate — used as the PROSPECTIVE preview for a not-yet-closed deal.
  // A CONFIRMED deal instead reads its own FROZEN feePct off the obligation snapshot (H1), resolved per-deal below.
  const feePct = protocolFeePct(dev);

  // Unit label lookup from the catalog inventory (id → "Unit 1204" style; fall back to the raw id).
  const unitLabelFor = (unitId?: string): string => {
    if (!unitId) return "—";
    const u = b.inventory.find((x) => x.id === unitId);
    if (!u) return unitId;
    return u.unitNumber ? `Unit ${u.unitNumber}` : u.id;
  };

  let totalCommissionUsd = 0;
  let totalFeeUsd = 0;

  const deals: ImpactDeal[] = await Promise.all(
    set.deals.map(async (d) => {
      // Re-read the offer so we can mask-gate the buyer (developerView) + resolve the obligation. The resolver
      // intentionally returns only refs — the entitlement boundary lives HERE (design §A3).
      const raw = await getOffer(d.requestId);
      const dv = raw ? developerView(raw) : null;
      const { label, masked } = dv ? buyerLabel(dv) : { label: null, masked: true };

      // Crystallised obligation: frozen snapshot for a confirmed sale (H1), live preview otherwise. The VRX fee
      // on a CONFIRMED deal is the snapshot's frozen feePct; on a prospective one it's the developer's CURRENT
      // fee rate (an honest preview of what it WOULD be). Commission is the agency money; the fee is VRX's cut.
      let obligation: ImpactDeal["obligation"] = null;
      if (raw) {
        const cr = await explainSaleCommission(raw).catch(() => null);
        if (cr?.commission) {
          const kind = cr.reason === "earned" ? "earned" : "prospective";
          const effFeePct =
            kind === "earned" && raw.obligation ? raw.obligation.feePct : feePct;
          const commissionUsd = cr.commission.amountUsd;
          const feeUsd = Math.round((cr.commission.priceUsd * effFeePct) / 100);
          obligation = {
            commissionPct: cr.commission.pct,
            commissionUsd,
            feePct: effFeePct,
            feeUsd,
            agency: cr.commission.agency,
            kind,
          };
          totalCommissionUsd += commissionUsd;
          totalFeeUsd += feeUsd;
        }
      }

      return {
        requestId: d.requestId,
        unitLabel: unitLabelFor(d.unitId),
        stage: d.stage,
        agency: d.agency,
        agent: d.agent,
        buyer: label,
        buyerMasked: masked,
        obligation,
      };
    })
  );

  return NextResponse.json({
    building: b.name,
    buildingId: building,
    affectsExistingDeals: set.affectsExistingDeals,
    count: deals.length,
    totals: { commissionUsd: totalCommissionUsd, feeUsd: totalFeeUsd },
    deals,
  });
}
