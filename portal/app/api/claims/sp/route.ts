// GET /api/claims/sp?requestId=..&viewer=.. — assemble the SALE & PURCHASE (S&P) contract for one booking
// (the next big arc). The buyer wants to SEE the full populated contract BEFORE paying the deposit
// (the key sequencing insight), so this is available at the OFFER/booking stage, not only at close.
//
// WHAT IT RETURNS: a SaleContractInput (lib/sale-contract) the client feeds to renderSaleContract + the shared
// <ContractModal>. Everything legible: party identities, price/plan verbatim, agreed terms, construction +
// furniture (empty-safe until that authoring lands), and the execution/seal block with the on-chain receipt
// once sold. The assembly is SERVER-SIDE because the developer identity (KYC profile), the ✓Vetted re-hash
// (verifyOffer), and the buyer-masking all live here — the browser must never see withheld plaintext.
//
// AUTH / SCOPING (reuses the /api/channels participant gate — the SAME scope that feature-#3's hardening is
// about): the caller names itself with ?viewer=. Only a PARTY to the booking may fetch its S&P:
//  • the DEVELOPER (offer.developer) — sees the buyer through developerView (masked per the agent's
//  choice until the reveal unlock fires: "use whatever is exposed to the developer").
//   • the AGENT who authored the booking, or that agent's supervising AGENCY — see the FULL buyer they
//  entered (protects the buyer FROM the developer, not from the agent/buyer side).
// Anyone else (or an unknown booking) → 403, fail closed. No PII leaves the server beyond the viewer's scope.
//
// PRIVACY: no PII on-chain. The buyer-KYC DOCUMENTS (photo/id/passport/card) are NOT in the default
// S&P payload — they're served (metadata here with ?kyc=1, bytes via /api/kyc-vault/doc) only to the
// DEVELOPER and only after the buyer identity is REVEALED, the same gate as the full buyer detail.

import { NextResponse } from "next/server";
import { getOffer, verifyOffer, developerView, contractStage, offerDateAnchor, type Offer } from "@/lib/offers";
import { isDirectOffer, resolveDirectBuyerLine } from "@/lib/direct-offer";
import { getProfile } from "@/lib/profiles";
import { roleOnOffer, type ParticipantRole } from "@/lib/participant";
import { requireCaller } from "@/lib/caller";
import { getEntry, docMeta } from "@/lib/kyc-vault";
import { getBuilding, currentSqm } from "@/lib/catalog";
import { packsForBuilding } from "@/lib/furniture-packs";
import { furniturePackCost } from "@/lib/furniture";
import { getEntity, resolvePaymentOptions } from "@/lib/seller-entities";
import { getDeveloper } from "@/lib/developers";
import { resolveTerminationChain } from "@/lib/termination-terms";
import { resolveBuildState } from "@/lib/sale-contract";
import type { SaleContractInput, SaleBuyerParty, SalePlan, SaleSellerEntity } from "@/lib/sale-contract";
import { directRole } from "@/lib/conversations-direct";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Participant scope is the shared rule (lib/participant) — the one chokepoint for the auth binding (F1).
type Viewer = ParticipantRole;

// Map the offer's buyer snapshot (already scoped: masked for a developer viewer, full for the agent) to the
// S&P buyer party. The snapshot keys come from the agent's buyer form (name/nationality/idRef/…). "masked"
// is detected from the unlock state for a developer viewer — the honest "not yet fully disclosed" line.
function buyerParty(offer: Offer, viewer: Viewer, buyerTypeDisplay: string | null | undefined): SaleBuyerParty {
  const b = (offer.seal.buyer ?? undefined) as Record<string, string> | undefined;
  // A developer viewer sees the buyer MASKED until the reveal unlock fires. The agent/buyer side is
  // never masked. developerView has already reduced the fields for a developer; here we only flag the state.
  const masked = viewer === "developer" && !offer.unlock?.revealed;
  // When masked, b.name is already the agent-allowed PARTIAL hint (developerView ran publicBuyerView). We add
  // a short opaque reference tag off the booking seal so the parties can refer to this exact buyer without
  // disclosing them (: "J*** P***** [hash digits]"). The full name only appears on the final
  // ready-to-sign contract. The tag is the last 6 hex of the on-chain request_hash — stable + opaque.
  const ref = masked ? offer.requestHash.slice(-6) : undefined;
  return {
    name: b?.name,
    region: b?.nationality,
    buyerType: buyerTypeDisplay ?? null,
    masked,
    ref,
  };
}

/**
 * (slice 3) — the DIRECT-DEAL buyer line, as a SaleBuyerParty. Thin adapter over the pure
 * lib/direct-offer.resolveDirectBuyerLine (which owns the live most-permissive mask resolution — floor → dial
 * → consented grants → force-show — so a reveal/dial change AFTER materialization shows, and so it stays
 * unit-testable). Here we only map the resolved field map → the contract's buyer party shape.
 */
async function directBuyerParty(
  offer: Offer,
  viewerRole: "developer" | "buyer",
  buyerTypeDisplay: string | null | undefined
): Promise<SaleBuyerParty> {
  const { fields, masked } = await resolveDirectBuyerLine(offer, viewerRole);
  // The display legal name (for the final ready-to-sign line) prefers legalName, else the self-identified name.
  const displayName = fields.legalName || fields.name;
  const ref = masked ? offer.requestHash.slice(-6) : undefined;
  return {
    name: displayName,
    region: fields.nationality,
    buyerType: buyerTypeDisplay ?? null,
    masked,
    ref,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId")?.trim() ?? "";
  if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });
  // F1: identity from the VERIFIED session via requireCaller — param-fallback mode still honours
  // the legacy ?viewer= param (flag off = today's behaviour); strict mode ignores a forged param.
  const caller = requireCaller(req, { param: url.searchParams.get("viewer") });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });
  const viewer = caller.account;

  const stored = await getOffer(requestId);
  if (!stored) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  //  (slice 3) — a DIRECT offer has no agent-side participant (seal.by is the DESK), so roleOnOffer alone
  // can't authorize the BUYER to see their OWN paperwork. For a direct offer we resolve the viewer through the
  // conversation's directRole ("buyer" | "developer"), which authorizes BOTH sides correctly. The buyer sees
  // their own S&P in full; the desk ("developer") goes down the same masked path a booking developer does.
  const direct = isDirectOffer(stored);
  let directViewerRole: "developer" | "buyer" | null = null;
  if (direct) {
    const convId = stored.display.conversationId?.trim() || "";
    directViewerRole = convId ? await directRole(convId, viewer) : null;
    if (!directViewerRole) return NextResponse.json({ error: "not a party to this deal" }, { status: 403 });
  }

  // The booking-path role (developer | agent). For a direct offer the desk IS the offer.developer, so
  // roleOnOffer still resolves it to "developer"; a direct BUYER is authorized above (directViewerRole).
  const role = direct
    ? (directViewerRole === "developer" ? "developer" : "agent")
    : await roleOnOffer(stored, viewer);
  if (!role) return NextResponse.json({ error: "not a party to this booking" }, { status: 403 });

  // ── ?kyc=1 — the developer's pre-sign KYC metadata (docs list + contract fields + captured GPS). Bytes
  // come from the scoped /api/kyc-vault/doc route; this just lists what to show. SCOPE: developer-only AND
  // reveal-gated (same gate as the full buyer detail). The agent has their own agent-scoped path. ──
  if (url.searchParams.get("kyc")) {
    if (role !== "developer") return NextResponse.json({ error: "not permitted" }, { status: 403 });
    if (!stored.unlock?.revealed) return NextResponse.json({ error: "reveal the buyer first" }, { status: 403 });
    const buyerId = stored.display?.buyerId?.trim() || "";
    const entry = buyerId ? await getEntry(buyerId) : null;
    return NextResponse.json({
      kyc: entry
        ? {
            docs: entry.docs.map(docMeta),
            fields: entry.fields,
            gps: entry.gps ? { lat: entry.gps.lat, lng: entry.gps.lng, accuracy: entry.gps.accuracy, at: entry.gps.at } : undefined,
          }
        : null,
    });
  }

  // Scope the offer the SAME way the surfaces do: a developer viewer gets the masked projection (the ONLY
  // shape that may be sent to a developer); the agent/agency gets the full stored offer.
  const offer = role === "developer" ? developerView(stored) : stored;

  // ✓Vetted re-hash — does the (full) stored plaintext still match the on-chain seal? Verify against the
  // STORED offer (full plaintext), not the masked projection, so the check is the real one.
  const verified = await verifyOffer(stored);

  // Developer identity from its KYC profile (honest absence → bare account, handled by the generator).
  const devProfile = await getProfile(stored.developer);

  const plan = (offer.seal.plan ?? null) as SalePlan | null;

  // Construction timeline (building-specific) + furniture (developer-global packs attached to this building),
  // . Both empty-safe in the generator. Furniture cost is computed from THIS unit's authoritative m²
  // (currentSqm) — never a frozen figure, so a staged area change flows straight through.
  const buildingId = offer.display.buildingId;
  const unitId = offer.display.unitId;
  const building = buildingId ? await getBuilding(buildingId) : null;
  const milestones = building?.constructionTimeline ?? [];

  //  §config-surface — resolve this deal's buyer-default / termination clause numbers through
  // the 3-tier chain: BUILDING override → the DEVELOPER's house default → the real-SPA code default. These are
  // the developer's OWN terms toward their buyer (not VRX-set). The signed clause (below, via the generator)
  // and the buyer-default advisory (/api/payments) MUST read the same resolved figures — resolveTerminationChain
  // is the single source so they can't disagree. Absent at every tier = the code defaults (12.5% / 30d / 15%).
  const devRecord = await getDeveloper(stored.developer);
  const terminationTerms = resolveTerminationChain(building?.terminationTerms, devRecord?.terminationTerms);

  //  step 5 — resolve the building's reusable SELLER ENTITY (the selling company named on the S&P). A
  // dangling/absent id reads as "no seller attached" (the generator falls back to the developer's KYC legal
  // name / bare account), so this never corrupts a building. Only the contract-stated fields are forwarded.
  let seller: SaleSellerEntity | undefined;
  if (building?.sellerEntityId) {
    const e = await getEntity(building.sellerEntityId);
    if (e && e.companyName?.trim()) {
      seller = {
        companyName: e.companyName,
        companyNameTH: e.companyNameTH,
        address: e.address,
        addressTH: e.addressTH,
        taxId: e.taxId,
        directorName: e.directorName,
        bankPayable: e.bankPayable,
        // the resolved accepted-payment menu (migrates a legacy bankPayable read-side), stated in §2.
        paymentOptions: resolvePaymentOptions(e),
      };
    }
  }
  let furniture: { label: string; costUsd: number; selected?: boolean }[] = [];
  // the furniture PICKER list (ids + per-unit cost) for the agent/developer selector, returned
  // alongside the contract input (the contract doc itself stays id-free). Plus the current chosen pack id.
  let furniturePick: { packId: string; label: string; costUsd: number }[] = [];
  const selectedPackId = stored.furniture?.packId ?? null;
  if (building && unitId) {
    const unit = building.inventory.find((u) => u.id === unitId);
    const unitSqm = unit ? currentSqm(unit.sqmStages, unit.sqm) : 0;
    const packs = await packsForBuilding(building.id);
    furniturePick = packs.map((pk) => ({ packId: pk.id, label: pk.label, costUsd: furniturePackCost(pk, unitSqm) }));
    // Mark the booking's chosen pack `selected` (by id, not label, so duplicate labels can't confuse).
    furniture = packs.map((pk) => ({
      label: pk.label,
      costUsd: furniturePackCost(pk, unitSqm),
      ...(selectedPackId && pk.id === selectedPackId ? { selected: true } : {}),
    }));
  }

  //  (slice 3) — the buyer line. A DIRECT offer seals no buyer, so resolve it LIVE from the buyer's own
  // record at the desk-entitled mask (reveal/dial changes after materialization show); a booking offer reads
  // the agent-sealed snapshot as before.
  const buyer = direct
    ? await directBuyerParty(stored, directViewerRole!, offer.display.buyerType)
    : buyerParty(offer, role, offer.display.buyerType);

  const input: SaleContractInput = {
    requestId: stored.requestId,
    sealHash: stored.requestHash,
    verified,
    developer: {
      account: stored.developer,
      legalName: devProfile?.legalName,
      region: devProfile?.region,
      proofRef: devProfile?.identityHash,
      //  step 5 — the resolved selling company for this building (absent-safe; falls back in the generator).
      seller,
    },
    buyer,
    property: {
      buildingId: offer.display.buildingId,
      unitId: offer.display.unitId,
    },
    plan,
    terms: offer.seal.terms ?? "",
    // Construction timeline (building-specific) + furniture (developer-global packs attached here).
    // Both resolved above; empty-safe in the generator when unauthored.
    milestones,
    furniture,
    //  step 5 — contractual completion window + the building's free-text legal clause (both absent-safe).
    // the completion line is a plain undertaking now, promotable to a full EIA-style refund clause
    // (§5.5) from the clause library later.
    completeWithinMonths: building?.project?.completeWithinMonths,
    landClause: building?.land?.clauseText,
    // negotiation concessions (off-seal, developer-recorded, frozen at `final`). Empty → no section.
    concessions: (stored.concessions ?? []).map((c) => ({ label: c.label, note: c.note, valueUsd: c.valueUsd })),
    // per-deal timed terms (off-seal, developer-recorded, frozen at `final`). Empty → no §4B section.
    timedTerms: (stored.timedTerms ?? []).map((t) => ({ label: t.label, when: t.when, note: t.note, committed: t.committed })),
    // transfer tax: the negotiated override, else a neutral default (3.6% rate, 50/50 split) so the
    // S&P always states the shared-tax arrangement honestly. `taxPct` from the sealed plan is the legacy path.
    tax: stored.tax
      ? { ratePct: stored.tax.ratePct, buyerSharePct: stored.tax.buyerSharePct }
      : { ratePct: 3.6, buyerSharePct: 50 },
    // developer discount off the price (off-seal, frozen at `final`). Absent → no discount line.
    discount: stored.discount
      ? { kind: stored.discount.kind, value: stored.discount.value, note: stored.discount.note }
      : undefined,
    //  §config-surface — the resolved 3-tier buyer-default / termination numbers for this
    // developer+building. The generator renders them into §Default-and-Termination (sale-contract.ts), never
    // a baked literal. Passing the FULLY-RESOLVED terms (not the raw override) keeps the generator's own
    // resolveTerminationTerms a harmless identity-clamp on sane figures.
    terminationTerms,
    // resolve the instalment→milestone ties against the building's LIVE timeline (ordinal → {label,
    // when}). A tie to a milestone that no longer exists is dropped (graceful) — the display join never drifts.
    instalmentMilestones: (() => {
      const ties = stored.instalmentMilestones ?? {};
      const byLabel = new Map((building?.constructionTimeline ?? []).map((m) => [m.label, m]));
      const out: Record<string, { label: string; when: string }> = {};
      for (const [ord, label] of Object.entries(ties)) {
        const m = byLabel.get(label);
        if (m) out[ord] = { label: m.label, when: m.when };
      }
      return out;
    })(),
    //  Phase A — the BUILD-STATE axis. Resolve the ONE canonical signal from the catalog's
    // (possibly disagreeing) fields: project.status (preferred) → the quota-lifecycle stage → default
    // off_plan. "ready" (already-built) omits the construction/handover + completion-window + milestone-tie
    // clauses in the generator. Absent building (direct/no-catalog deal) → off_plan (back-compatible).
    buildState: resolveBuildState(
      building ? { projectStatus: building.project?.status, stage: building.stage } : undefined
    ),
    // stage is the single source of truth. `signed` is DERIVED from it (reaching "signed"), OR the
    // legacy on-chain close (stored.confirmed) for bookings closed before the stage machine existed — so an
    // already-sold booking still reads as executed. Not two competing flags.
    stage: contractStage(stored),
    signed: contractStage(stored) === "signed" || Boolean(stored.confirmed),
    at: stored.confirmed?.at ?? stored.at,
    receiptTx: stored.confirmed?.tx,
    // the anchor for auto-interval instalment due dates. (c): anchored to the STABLE
    // `stored.at` (booking moment), NOT `confirmed?.at ?? stored.at`. A signed S&P must show the SAME §2 dates
    // after close as when it was signed; the old expression shifted the anchor booking→close date on close, so a
    // post-close render silently re-dated every instalment ("frozen at final" freezes the override INPUTS, not the
    // rendered OUTPUT). `stored.at` is the one anchor shared by the S&P §2, the payment ledger, the income
    // projection AND the date-override validator (one rule: instalmentDueDate) — no §2↔ledger drift, ever.
    anchorAt: offerDateAnchor(stored),
    // Per-instalment DUE-DATE overrides (off-seal, preview-editable, frozen at final). Override wins over the
    // auto date, both here and in the ledger — a pinned date is never a hidden side-arrangement.
    instalmentDueDates: stored.instalmentDueDates,
    // the buyer's agreed payment destination (if picked); §2 states it as the binding term.
    agreedPaymentOptionId: stored.paymentOptionId,
  };

  return NextResponse.json({ input, role, furniturePick, selectedPackId });
}
