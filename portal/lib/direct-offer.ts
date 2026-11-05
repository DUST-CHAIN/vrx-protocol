// DIRECT-DEAL OFFER MATERIALIZATION — SERVER-ONLY. the design docs.
//
// THE GAP THIS CLOSES: the agent BOOKING path lets a developer tailor a deal (discount furniture /
// concessions timed-terms) and feed it into the S&P — all keyed off an `Offer.requestId`. The
// DIRECT desk had no `Offer`, so a direct buyer couldn't get a tailored deal into an S&P. the call
// (option #1): when a direct deal gets SERIOUS (the desk firm-holds the unit — "takes it out of
// available so nobody else can book it"), MATERIALIZE a real `lib/offers.Offer`. Then the ENTIRE existing
// `/api/offers/*` tailoring path + `/api/claims/sp` assembler + renderSaleContract are reused VERBATIM.
//
// THE ONE HONEST DIVERGENCE (design §3): a direct offer's `requestId` is a PORTAL id, not an on-chain
// `open_claim` id, and its seal is an OFF-CHAIN salted attestation rather than the on-chain
// `request_hash`. `verifyOffer` re-hashes the stored plaintext either way, so the ✓Vetted check still means
// "terms unaltered since sealing". We mark the offer `display.origin = "direct"` so no consumer mistakes it
// for an on-chain claim (a claim-only chain path must never be reached with it — design §3 guard).
//
// PRICE (design §2): the SAME live catalog price agencies get — "we do not cheap". The price snapshot
// is the opened unit's live `priceUsd` at the materialization moment. A discount is ONLY ever a positive
// response to an ask, authored later through the existing `/api/offers/discount` — never baked in here.
//
// LIFECYCLE (design §5): the offer is bound to (conversationId, epoch) via its `requestId`. A call-off
// or hard block VOIDS it (the caller releases the hold); escalation (deal stays live) does not.
// The epoch binding means a re-engaged deal (epoch++) can never inherit the old deal's tailoring.
//
// PRIVACY: the only on-chain act is the firm-hold (grant_exclusive — opaque unit key + house org). This
// seal is OFF-CHAIN; the buyer PII is NOT sealed here (the S&P resolves the live desk-entitled mask at read
// time, design §5) — we seal only neutral refs (building/unit/price/desk + the deal binding).

import { createHash } from "crypto";
import { getBuilding, currentSqm } from "./catalog";
import { getOffer, recordOffer, sealDigest, type Offer, type OfferSeal } from "./offers";
import { dealEpoch, deskDeveloperFor, grantedFieldsFor, priorBlockFor } from "./conversations-direct";
import { getBuyerDirect } from "./buyers-direct";
import { publicDirectProfileView, type BuyerMask, type MaskMode } from "./buyer-mask";

const REQUEST_DOMAIN = "vrx-direct-offer"; // salts the requestId so it can't be matched against other hashes

/** The portal requestId for a direct deal's offer — STABLE per (conversationId, epoch) so the lifecycle
 *  (void on call-off/block) can find it, and OPAQUE (salted digest) so it reveals neither party on the wire.
 *  Pure — same inputs → same id, so a replay upserts rather than duplicating (recordOffer is idempotent). */
export function directRequestId(conversationId: string, epoch: number): string {
  const c = conversationId.trim();
  return createHash("sha256").update(`${REQUEST_DOMAIN}|${c}|${epoch}`).digest("hex").slice(0, 32);
}

/**
 * The neutral free-text terms the direct offer seals — no PII, a human-legible marker of provenance.
 *
 * IMPORTANT (seal mechanics — "how numbers are handled", a documented gotcha): the seal digest
 * (lib/offers.sealDigest → stableStringify) uses `JSON.stringify(obj, sortedTopLevelKeys)`, where the key
 * array acts as a RECURSIVE property allowlist. So NESTED fields (e.g. `plan.priceUsd`) are DROPPED from the
 * digest — `plan` always serializes to `{}` (verified empirically). On the booking path the price has a
 * SECOND anchor (the on-chain contract stores the plan), so the dropped-from-digest plan still can't be forged.
 * A DIRECT offer has NO on-chain plan anchor, so to make its price genuinely TAMPER-EVIDENT we fold the price
 * into `terms` (which IS a sealed top-level field). `plan.priceUsd` is still carried for the S&P to read; the
 * SEALED copy is here in `terms`. (the design docs §2/§3.)
 */
function directTerms(building: string, unit: string, epoch: number, priceUsd: number): string {
  return `Direct-desk deal — building ${building}, unit ${unit}, deal #${epoch}; price USD ${Math.round(priceUsd)}.`;
}

// ── PAYMENT-STRUCTURE TEMPLATES (slice 4) ────────────────────────────────────────────────
// "a few buttons or templates that easily make it simple, structured, tested ways to sell something"
// — and the real-estate (esp. off-plan) norm is deposit → on-contract → instalments → on-key/transfer, "but
// maybe other ways are useful". So the desk picks ONE of a small, FIXED set of structures at the moment it
// opens the paperwork; each is just a different fill of the EXISTING AssembledPlan shape (nothing new in the
// plan model — see components/PaymentCalculator.AssembledPlan). The desk can still fine-tune the numbers in
// the plan editor later; these are the sane starting points.
//
// NUMBERS (doc-alongside): every template is computed from the LIVE unit price at materialization. The deposit
// is the figure the desk already took (passed in); the balance is `price − deposit`, allocated per template.
// Rounding: deposit/on-contract/on-key are whole USD; instalments divide the remainder with Math.floor and the
// LAST instalment carries the remainder (mirrors PaymentCalculator, so the schedule always reconciles to price).
export type DirectPlanTemplate =
  | "off_plan_standard" // deposit → on-contract → N instalments → balance on transfer (real-estate default)
  | "deposit_then_transfer" // deposit now, balance on handover (no instalments)
  | "full_on_transfer" // minimal deposit now, full balance on transfer
  | "refundable_deposit"; // refundable holding deposit now, balance on transfer

/** The sealed-plan shape a direct offer carries (subset of PaymentCalculator.AssembledPlan the S&P reads). */
export type DirectPlan = {
  priceUsd: number;
  depositUsd: number;
  onContractUsd: number;
  onKeyUsd: number;
  instalmentCount: number;
  instalmentUsd: number;
  /** marks the deposit refundable on the S&P (refundable_deposit template). Display-only. */
  depositRefundable?: boolean;
  schedule: { label: string; amountUsd: number }[];
  balanced: boolean;
};

/**
 * Build a structured payment plan from a template + the live price + the deposit the desk took. PURE and
 * tested in isolation. `instalments` only applies to `off_plan_standard` (ignored otherwise); clamped to ≥0.
 * `onContractUsd` for the standard template is 0 by default (the desk tunes it after) — the point of the
 * template is a sane, reconciling STARTING structure, not a fixed split.
 */
export function directPlanFromTemplate(
  template: DirectPlanTemplate,
  priceUsd: number,
  depositUsd: number,
  instalments = 0
): DirectPlan {
  const price = Math.max(0, Math.round(priceUsd));
  const deposit = Math.max(0, Math.min(price, Math.round(depositUsd)));
  const mk = (
    onContractUsd: number,
    onKeyUsd: number,
    instalmentCount: number,
    instalmentUsd: number,
    depositRefundable?: boolean
  ): DirectPlan => {
    const schedule: { label: string; amountUsd: number }[] = [];
    if (deposit > 0) schedule.push({ label: depositRefundable ? "Refundable deposit" : "Deposit", amountUsd: deposit });
    if (onContractUsd > 0) schedule.push({ label: "On contract", amountUsd: onContractUsd });
    for (let i = 1; i <= instalmentCount; i++) {
      // The last instalment carries the remainder so the total reconciles to price exactly.
      const amt = i === instalmentCount ? price - deposit - onContractUsd - onKeyUsd - instalmentUsd * (instalmentCount - 1) : instalmentUsd;
      schedule.push({ label: `Instalment ${i}`, amountUsd: amt });
    }
    if (onKeyUsd > 0) schedule.push({ label: "On transfer", amountUsd: onKeyUsd });
    const total = schedule.reduce((s, r) => s + r.amountUsd, 0);
    return {
      priceUsd: price,
      depositUsd: deposit,
      onContractUsd,
      onKeyUsd,
      instalmentCount,
      instalmentUsd,
      ...(depositRefundable ? { depositRefundable: true } : {}),
      schedule,
      balanced: Math.abs(price - total) < 1,
    };
  };

  const balance = Math.max(0, price - deposit);
  switch (template) {
    case "off_plan_standard": {
      const n = Math.max(0, Math.round(instalments));
      if (n < 1) return mk(0, balance, 0, 0); // degenerate → deposit + balance on transfer
      const each = Math.floor(balance / n);
      return mk(0, 0, n, each);
    }
    case "deposit_then_transfer":
      return mk(0, balance, 0, 0);
    case "full_on_transfer":
      return mk(0, balance, 0, 0);
    case "refundable_deposit":
      return mk(0, balance, 0, 0, true);
  }
}

export type MaterializeResult =
  | { ok: true; offer: Offer; created: boolean }
  | { ok: false; reason: "no-desk" | "no-building" | "no-unit" };

/**
 * Materialize (or return the existing) direct `Offer` for a serious direct deal. Called at/after the firm-hold
 * moment (the route authorizes that `by` is the building's desk developer BEFORE calling this). Idempotent per
 * (conversationId, epoch): a second call returns the same offer (`created:false`) rather than re-sealing — so a
 * double-tap or a replay is safe. Price is snapshotted from the LIVE catalog unit at this moment (design §2).
 *
 * Fails closed with a reason when the building/desk/unit can't be resolved (never fabricates an offer against a
 * unit that isn't there). The returned offer carries `display.origin = "direct"` (the §3 guard marker).
 */
export async function materializeDirectOffer(args: {
  conversationId: string;
  buyer: string;
  building: string;
  unit: string;
  by: string; // the desk developer account (the route authorizes this == deskDeveloperFor(building))
  /**  slice 4 — optional payment-structure template chosen at "open the paperwork". Absent
   *  → the bare price-only plan (back-compatible with slices 1–3). The structure is a sane STARTING point the
   *  desk can still tune in the plan editor; the price stays the tamper-evident figure folded into `terms`. */
  template?: DirectPlanTemplate;
  /** Instalment count for the `off_plan_standard` template (ignored by the others). */
  instalments?: number;
  /** The deposit (USD) the desk took — seeds the template's deposit line. Defaults to 0 (price all on transfer). */
  depositUsd?: number;
}): Promise<MaterializeResult> {
  const conversationId = args.conversationId.trim();
  const buyer = args.buyer.trim().toLowerCase();
  const building = args.building.trim();
  const unitId = args.unit.trim();
  const by = args.by.trim();

  const desk = await deskDeveloperFor(building);
  if (!desk) return { ok: false, reason: "no-desk" };

  const b = await getBuilding(building);
  if (!b) return { ok: false, reason: "no-building" };
  const unit = b.inventory.find((u) => u.id === unitId);
  if (!unit) return { ok: false, reason: "no-unit" };

  const epoch = await dealEpoch(conversationId);
  const requestId = directRequestId(conversationId, epoch);

  // Idempotent: if this deal's offer already exists, return it untouched (never re-seal / clobber tailoring).
  const existing = await getOffer(requestId);
  if (existing) return { ok: true, offer: existing, created: false };

  // Price snapshot = the unit's LIVE catalog price at materialization (design §2 — same price agencies get).
  // currentSqm is unused for the price itself (priceUsd is the base figure), but kept available for parity
  // with the booking S&P's furniture-cost recompute; the S&P assembler recomputes furniture from live m².
  const priceUsd = unit.priceUsd;
  void currentSqm; // referenced by the S&P assembler, not needed for the price seal here

  //  slice 4 — a payment-structure template yields a full AssembledPlan-shaped plan the S&P
  // renders as a schedule; absent, the bare price-only plan (slices 1–3). NB the structure numbers are DISPLAY
  // (nested plan fields drop from the digest — see directTerms note + lib/offers stableStringify); only the
  // PRICE is tamper-evident (folded into `terms`), which is the figure that actually matters for ✓Vetted.
  const plan = args.template
    ? directPlanFromTemplate(args.template, priceUsd, args.depositUsd ?? 0, args.instalments ?? 0)
    : { priceUsd };

  // Build the canonical seal EXACTLY the shape sealDigest/verifyOffer expect, so the offer verifies by
  // construction. Buyer PII is deliberately NOT sealed (design §5 — the S&P resolves the live mask at read
  // time); we seal only neutral terms + the price plan + the desk as author.
  const seal: OfferSeal = {
    terms: directTerms(building, unitId, epoch, priceUsd), // price folded in → genuinely sealed (see note)
    plan, // carried for the S&P to read; the TAMPER-EVIDENT copy of the PRICE is in `terms`
    by,
  };
  const requestHash = await sealDigest(seal);

  const offer: Offer = {
    requestId,
    requestHash,
    developer: desk, // the desk developer is the offer's developer → the tailoring routes authorize correctly
    seal,
    display: {
      buildingId: building,
      unitId,
      origin: "direct", // the §3 guard marker: NOT an on-chain claim
      // slice 3 — carried so the S&P can authorize the buyer as a viewer of their OWN paperwork and resolve
      // the LIVE desk-entitled buyer mask at read time (not this frozen moment). Off-seal, display only.
      conversationId,
      buyer,
    },
    at: Date.now(),
  };
  await recordOffer(offer);
  return { ok: true, offer, created: true };
}

/** Is this offer a direct-desk materialization (vs an on-chain booking)? The §3 guard predicate — a claim-only
 *  chain path (confirm_claim/get_claim) must refuse when this is true. */
export function isDirectOffer(o: Offer): boolean {
  return o.display?.origin === "direct";
}

/** The resolved buyer line for a direct deal's S&P (slice 3) — a neutral field map + the "not-yet-disclosed"
 *  flag. The route adapts this to its SaleBuyerParty shape. `masked` = the full legal identity is still hidden
 *  from the desk (name a hint, legalName absent). */
export type DirectBuyerLine = { fields: Record<string, string>; masked: boolean };

/**
 * (slice 3) — resolve a direct offer's buyer line LIVE at read time (design §5). A direct offer
 * seals NO buyer PII; the identity is read from the buyer's own direct record and masked exactly as the desk's
 * advance route does (deskSafeBuyer), so a reveal (C) or dial change (B) granted AFTER
 * materialization shows on the S&P. Resolution is most-permissive across the layers:
 *   floor (DIRECT_PROFILE_MASK, inside publicDirectProfileView) → buyer dial (maskOverride)
 * → consented grantedFields (forced to `show`) → force-show (E, anti-cheat: a once-blocked buyer's
 *   whole identity is force-shown to THIS desk).
 * The BUYER viewing their OWN paperwork (`viewerRole:"buyer"`) sees themselves in FULL, unmasked. An absent
 * buyer record → an empty masked line (never a crash). PURE over the stores — no request/response coupling, so
 * it's unit-testable without next/server (the route is thin over it).
 */
export async function resolveDirectBuyerLine(
  offer: Offer,
  viewerRole: "developer" | "buyer"
): Promise<DirectBuyerLine> {
  const buyerAccount = offer.display.buyer?.trim() || "";
  const conversationId = offer.display.conversationId?.trim() || "";
  const rec = buyerAccount ? await getBuyerDirect(buyerAccount) : null;
  const profile = (rec?.profile ?? {}) as Record<string, unknown>;

  // The buyer's OWN view = full, unmasked (it's their paperwork).
  if (viewerRole === "buyer") {
    const full: Record<string, string> = {};
    for (const [k, v] of Object.entries(profile)) if (v != null) full[k] = String(v);
    return { fields: full, masked: false };
  }

  // The desk sees the LIVE desk-entitled mask.
  const forceShow = conversationId ? await priorBlockFor(conversationId) : false;
  if (forceShow) {
    const all: BuyerMask = {};
    for (const k of Object.keys(profile)) all[k] = "show" as MaskMode;
    return { fields: publicDirectProfileView(profile, all) ?? {}, masked: false }; // anti-cheat inverts the floor
  }
  const granted = conversationId ? await grantedFieldsFor(conversationId) : [];
  const effective: BuyerMask = { ...(rec?.maskOverride ?? {}) };
  for (const f of granted) effective[f] = "show" as MaskMode;
  const fields = publicDirectProfileView(profile, effective) ?? {};
  // "masked" = the full legal identity is not yet disclosed (legalName still hidden → name is only a hint).
  return { fields, masked: !fields.legalName };
}
