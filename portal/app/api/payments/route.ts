// /api/payments — the customer→developer PAYMENT LEDGER surface (step 5,).
// Reads + writes over lib/payment-vault (the one genuinely-new store; everything else in the arc is pure
// computation over it). the design docs §5/§7. Contract stays FROZEN — all off-chain.
//
//   GET ?developer=&requestId=            → { payments } for ONE deal, developer-scoped (the logger's view).
//   GET ?developer=&buildingId=&unitId=   → { payments } for ONE unit, developer-scoped.
//   GET ?developer=                       → { payments } ALL this developer logged.
//   GET ?developer=&projection=1          → { buildings } the developer's PROJECTED-INCOME (Expected vs
//  Received vs Behind, per building) — gross buyer receipts
//                                           only, the four honesty guards enforced here (lib/income-projection).
//   GET ?buyer=                           → { payments } the BUYER's OWN (across developers) — Rail-B surface.
//   GET ?agent=&requestId=                → { payments } for ONE deal, AGENT-scoped (the buyer's agent/agency
//  acting as proxy) — authorised via lib/participant off the offer.
//   POST (multipart/form-data)            → LOG a payment (developer-scoped). fields: developer, buildingId,
//                                           unitId, [requestId], [buyer], amountUsd, paidAt, method, rail,
//                                           [note], [file]. Locked vault + evidence → 503; no-evidence → OK.
//   POST (application/json) { op:"confirm" }   → buyer/agent confirms/disputes an offline entry (Rail B, §4b,
//  step 6). A dispute also posts to the deal chat.
//  POST (application/json) { op:"share" } → a party opens a DISPUTED slip to chosen audiences.
//  POST (application/json) { op:"shareAgent" } → the buyer keeps their agent in the loop on a slip.
//  POST (application/json) { op:"flag" } → a party flags bad-evidence/bad-actor (design-now).
//   DELETE ?developer=&id=                → delete one payment the developer logged (+ its evidence blob).
//
// AUTH posture (demo-layer, matches /api/settlement + /api/kyc-vault): the caller NAMES itself (`developer`
// or `buyer`); lib/payment-vault scopes every op so no cross-party read/write slips through (the signed-
// request binding rides the deferred F1 signing arc). The decrypted SLIP BYTES are served only by
// /api/payments/evidence, which re-authorizes the reader (owning developer / named buyer / dispute-granted
// VRX-root). PRIVACY: amounts + slips are B2B PII — off-chain, encrypted at rest, never on the buyer's
// S&P, nothing on-chain. The public projection (publicPayment) strips the salt + all crypto material.

import { NextResponse } from "next/server";
import {
  logPayment,
  paymentsForDeveloper,
  paymentsForUnit,
  paymentsForRequest,
  paymentsForBuyer,
  setBuyerConfirm,
  setDisputeShare,
  setBuyerShareToAgent,
  flagPayment,
  addEvidence,
  getPayment,
  deletePayment,
  publicPayment,
  paidToDate,
  isValidAmount,
  logSentPayment,
  paymentsForDeal,
  VaultLockedError,
  type PaymentMethod,
  type PaymentRail,
} from "@/lib/payment-vault";
import { reconcileDeal, type ReconcileInput } from "@/lib/payment-reconcile";
import { publish } from "@/lib/bus";
import { getOffer, contractStage, offersForDeveloper, offerDateAnchor } from "@/lib/offers";
import { buildIncomeProjection, type DealInput } from "@/lib/income-projection";
import { roleOnOffer } from "@/lib/participant";
import { postMessage } from "@/lib/channels";
import { explainSaleCommission } from "@/lib/commission";
import { computeLedgerStatus, resolvePayable } from "@/lib/payment-ledger";
import { buyerDefaultEligible } from "@/lib/termination";
import { overlayFor } from "@/lib/termination-store";
import { resolveTerminationChain } from "@/lib/termination-terms";
import { computeSettlement } from "@/lib/termination-settlement";
import { getBuilding } from "@/lib/catalog";
import { getDeveloper } from "@/lib/developers";
import type { SalePlan } from "@/lib/sale-contract";

// The buyer-default threshold the ADVISORY uses, as a percentage of price (slice 3 → wired to the clause
// surface in slice 4). It now reads the SAME resolved figure as the signed §Default-and-Termination clause
// (lib/termination-terms, real-SPA default 12.5% per Cl.14/), so the operator prompt and the contract can
// never disagree on the number. Still ADVISORY only — it tells the developer a default notice MAY be eligible;
// serving stays an explicit action (never auto-terminate). A per-deal override lives on the surface for a
// later developer/industry variation; absent → the default, which is what this deal resolves to today.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The buyer's FORWARD-view line (thread-#1 Thing A). One per deal that has a next payment coming. `dueAt`
// absent = the plan states no timing (we never guess a date); the client then shows the amount without "in
// X days". Amounts are the buyer's OWN money only (no commission, no VRX cut).
type BuyerNextDue = {
  requestId: string;
  unitLabel: string;
  nextDue: { label: string; dueUsd: number; dueAt?: number };
  /** Days past-due on the earliest uncovered dated line (from the ledger), if any. */
  lateByDays?: number;
};

const METHODS: PaymentMethod[] = ["cash", "bank_slip", "qr_slip", "other"];
const RAILS: PaymentRail[] = ["in_app", "offline"];
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — a phone photo of a slip fits comfortably (same cap as KYC)
const OK_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i; // slip photo OR a PDF bank statement

const lc = (s: string) => s.trim().toLowerCase();

// Is `account` the BUYER-SIDE on this payment — i.e. may it confirm/dispute? Returns HOW (buyer in person, or
// the buyer's agent as proxy), or null if neither. The named buyer always qualifies as "buyer". The
// deal's agent/agency (lib/participant role === "agent") qualifies as the buyer's proxy — resolved from the
// record's requestId → offer. A record with no requestId can only be acted on by the named buyer directly.
async function actorAsBuyerSide(rec: Awaited<ReturnType<typeof getPayment>>, account: string): Promise<"buyer" | "agent_for_buyer" | null> {
  if (!rec) return null;
  const acct = lc(account);
  if (rec.buyer && lc(rec.buyer) === acct) return "buyer";
  if (rec.requestId) {
    const offer = await getOffer(rec.requestId);
    if (offer && (await roleOnOffer(offer, account)) === "agent") return "agent_for_buyer";
  }
  return null;
}

// Is `account` ANY party to this payment's deal (developer / buyer / the deal's agent|agency)? Used to
// authorise share + flag. Developer + buyer match the record directly; the agent/agency path needs the offer.
async function isDealParty(rec: Awaited<ReturnType<typeof getPayment>>, account: string): Promise<boolean> {
  if (!rec) return false;
  const acct = lc(account);
  if (lc(rec.developer) === acct) return true;
  if (rec.buyer && lc(rec.buyer) === acct) return true;
  if (rec.requestId) {
    const offer = await getOffer(rec.requestId);
    if (offer && (await roleOnOffer(offer, account)) !== null) return true;
  }
  return false;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const developer = url.searchParams.get("developer")?.trim() || "";
  const buyer = url.searchParams.get("buyer")?.trim() || "";
  const agent = url.searchParams.get("agent")?.trim() || "";
  const requestId = url.searchParams.get("requestId")?.trim() || "";
  const buildingId = url.searchParams.get("buildingId")?.trim() || "";
  const unitId = url.searchParams.get("unitId")?.trim() || "";

  // Buyer's own payments (Rail-B confirm/dispute surface) — scoped to the buyer account.
  if (buyer) {
    const records = await paymentsForBuyer(buyer);
    const payments = records.map(publicPayment);
    // thread-#1 Thing A — the buyer's FORWARD view: "next payment due in X days". Passive, read-only,
    // no new store, no new auth (the buyer names itself, same posture as the list above). We derive the
    // buyer's DEALS from their own payment records (each distinct requestId → one deal), load each sealed
    // plan, and compute the next-due line server-side with the SAME engine the developer deal view uses
    // (computeLedgerStatus over the buyer's paid-to-date). HONEST EDGE: a deal with a sealed plan but ZERO
    // recorded payments is not discoverable here (nothing to join on) — the buyer sees that via the deal/
    // chat, not this list; this view speaks only to deals with money already in motion. We NEVER guess a
    // date — `dueAt` is absent when the plan states no timing (lib/payment-ledger honesty rule), and then
    // we emit the line WITHOUT a date (label + amount only). Indicative, per the signed §Payments plan.
    const byDeal = new Map<string, typeof records>();
    for (const r of records) {
      if (!r.requestId) continue; // a record with no deal can't carry a forward schedule
      const arr = byDeal.get(r.requestId) ?? [];
      arr.push(r);
      byDeal.set(r.requestId, arr);
    }
    const deals: BuyerNextDue[] = [];
    for (const [requestId, recs] of byDeal) {
      const offer = await getOffer(requestId);
      if (!offer) continue;
      const plan = (offer.seal.plan ?? null) as SalePlan | null;
      if (!plan) continue; // no sealed plan → no schedule to look forward on
      const paid = paidToDate(recs, false); // the buyer's own money, same basis as the developer deal view
      // apply the per-instalment DUE-DATE overrides so the ledger's dates match the S&P §2 (one
      // rule: instalmentDueDate). (c): anchored to the STABLE `offer.at`, NOT `confirmed?.at ?? offer.at`
      // — so a deal's dates (and its late-flags) don't shift when it closes; the S&P §2, this ledger, the income
      // projection and the date validator all share the one `offer.at` anchor.
      const ledger = computeLedgerStatus(plan, paid, { bookingAt: offerDateAnchor(offer), dueDateOverrides: offer.instalmentDueDates });
      if (!ledger.nextDue) continue; // fully paid up, or no forward line → nothing to nudge
      // Suppress the nudge once a default/termination process is under way — a "next payment due" cue would
      // contradict a served-notice/terminated state (same honesty the developer advisory keeps).
      const term = await overlayFor(requestId);
      if (term.state !== "none") continue;
      const bldg = offer.display.buildingId ? await getBuilding(offer.display.buildingId) : null;
      const unitId = offer.display.unitId ?? "";
      const nd = ledger.nextDue;
      deals.push({
        requestId,
        unitLabel: [bldg?.name, unitId].filter(Boolean).join(" · ") || unitId || "Your unit",
        nextDue: { label: nd.label, dueUsd: nd.dueUsd, dueAt: nd.dueAt },
        lateByDays: ledger.lateByDays,
      });
    }
    return NextResponse.json({ payments, deals });
  }

  // AGENT acting as the buyer's proxy: the deal's agent/agency sees ONE deal's payments so it can
  // confirm/dispute on the buyer's behalf. Authorised via lib/participant (role === "agent") off the offer —
  // the agent never needs to know the buyer account; it acts on the deal. Developer is resolved from the
  // offer (the records' owner), so this reuses the same developer-scoped paymentsForRequest with no leak.
  if (agent && requestId) {
    const offer = await getOffer(requestId);
    if (!offer) return NextResponse.json({ error: "deal not found" }, { status: 404 });
    if ((await roleOnOffer(offer, agent)) !== "agent") {
      return NextResponse.json({ error: "not permitted — not the agent on this deal" }, { status: 403 });
    }
    const payments = (await paymentsForRequest(offer.developer, requestId)).map(publicPayment);
    return NextResponse.json({ payments });
  }

  // ?reconcile=1&requestId=&viewer= → the TWO-SIDED reconciliation of ONE deal (§5b). Runs the pure
  // reconcileDeal engine over BOTH ledgers (paymentsForDeal returns received + sent) and returns the structured
  // summary PLUS both sides' public records so a panel can show the comparison. READ authz: ANY party to the
  // deal (developer / buyer / the deal's agent-proxy) may read it — a reconciliation is a shared fact between the
  // two sides (lib/participant.roleOnOffer off the offer; non-parties fail closed). The engine never adjudicates
  // it STATES the variance; whose number is "true" is the parties' to resolve. No `developer` scope: the
  // viewer names itself and is role-checked against the offer, same posture as the agent-proxy read above.
  if (url.searchParams.get("reconcile") === "1" && requestId) {
    const viewer = url.searchParams.get("viewer")?.trim() || "";
    if (!viewer) return NextResponse.json({ error: "viewer required" }, { status: 400 });
    const offer = await getOffer(requestId);
    if (!offer) return NextResponse.json({ error: "deal not found" }, { status: 404 });
    if ((await roleOnOffer(offer, viewer)) === null) {
      return NextResponse.json({ error: "not a party to this deal" }, { status: 403 });
    }
    const records = await paymentsForDeal(requestId);
    const inputs: ReconcileInput[] = records.map((r) => ({
      id: r.id,
      side: r.side ?? "received", // legacy records with no `side` are developer "received" (readAll backfills)
      amountUsd: r.amountUsd,
      paidAt: r.paidAt,
      method: r.method,
      flagged: !!r.flag,
    }));
    const summary = reconcileDeal(inputs);
    // Return both sides' PUBLIC records (salt/evidence-bytes stripped) so the panel can render each line's
    // amount/date/method next to the structured delta. Split by side for a clean two-column surface.
    const received = records.filter((r) => (r.side ?? "received") === "received").map(publicPayment);
    const sent = records.filter((r) => r.side === "sent").map(publicPayment);
    return NextResponse.json({ summary, received, sent });
  }

  if (!developer) {
    return NextResponse.json({ error: "developer (or buyer) required" }, { status: 400 });
  }

  // ?projection=1 → the developer's PROJECTED-INCOME across their buildings. Thin GLUE over the pure
  // lib/income-projection bucketer: load the developer's OWN offers, and for each with a sealed plan resolve
  // (sealed SalePlan + bookingAt + termination overlay state + gross buyer receipts) → the pure module buckets
  // them into per-building Expected(by dueAt-month) / Received(by paidAt-month) / Behind cumulative curves + a
  // per-deal table, enforcing the four honesty guards (terminal excluded+counted, served-default segregated to
  // at-risk, undated never forced onto a month, behind ≠ default). GROSS buyer receipts only — NOT net of the
  // agency commission or the VRX fee (those are the settlement console's one number; never netted here). Same
  // AUTH posture as the other developer-scoped reads (caller names `developer`; off-chain; no new secret).
  // Payments counted = ALL logged (confirmedOnly=false) — the developer's own books, same basis as ?ledger=1.
  if (url.searchParams.get("projection") === "1") {
    const offers = await offersForDeveloper(developer);
    const inputs: DealInput[] = [];
    for (const offer of offers) {
      const plan = (offer.seal.plan ?? null) as SalePlan | null;
      if (!plan) continue; // no sealed plan → no schedule to project on
      const buildingId = offer.display.buildingId;
      if (!buildingId) continue; // the chart is grouped by building; an unplaced booking has nowhere to sit
      const bldg = await getBuilding(buildingId);
      const unitId = offer.display.unitId ?? "";
      const term = await overlayFor(offer.requestId);
      const records = await paymentsForRequest(developer, offer.requestId);
      inputs.push({
        requestId: offer.requestId,
        buildingId,
        buildingName: bldg?.name || buildingId,
        unitLabel: [bldg?.name, unitId].filter(Boolean).join(" · ") || unitId || "Unit",
        plan,
        bookingAt: offerDateAnchor(offer), //  (c): stable booking anchor (not confirmed?.at) — see api/claims/sp
        terminationState: term.state,
        payments: records.map((r) => ({ amountUsd: r.amountUsd, paidAt: r.paidAt })),
      });
    }
    return NextResponse.json(buildIncomeProjection(inputs));
  }

  // ?ledger=1 with a requestId → the deal's full ledger VIEW (developer-scoped): the logged payments PLUS the
  // server-computed variance (schedule-vs-actual) PLUS the agency-unlock verdict. One read so the developer
  // panel renders "paid X of schedule" + "commission now payable: $Y" from one authoritative server source
  // (never recomputed on the client). The variance engine stays server-side (over the sealed SalePlan).
  if (url.searchParams.get("ledger") === "1" && requestId) {
    const offer = await getOffer(requestId);
    if (!offer || offer.developer.trim().toLowerCase() !== developer.trim().toLowerCase()) {
      return NextResponse.json({ error: "not your deal, or not found" }, { status: 403 });
    }
    const records = await paymentsForRequest(developer, requestId);
    // The developer's OWN variance view counts ALL logged payments (confirmedOnly=false — they see their own
    // books); the agency UNLOCK gate counts confirmed-only (§4b safe default). Two figures, one per purpose.
    const paidAll = paidToDate(records, false);
    const paidConfirmed = paidToDate(records, true);
    const plan = (offer.seal.plan ?? null) as SalePlan | null;
    // apply the per-instalment DUE-DATE overrides so the ledger dates match the S&P §2.
    //  (c): stable `offer.at` anchor (not confirmed?.at) so closed-deal dates/late-flags don't shift.
    const ledger = computeLedgerStatus(plan, paidAll, { bookingAt: offerDateAnchor(offer), dueDateOverrides: offer.instalmentDueDates });

    // The agency-unlock verdict (reuses the exact earmark seam — explainSaleCommission carries clause+plan).
    const c = await explainSaleCommission(offer);
    let payable = null as null | ReturnType<typeof resolvePayable>;
    if (c.commission && c.reason === "earned") {
      payable = resolvePayable(
        c.commission,
        c.clause ?? {},
        c.plan ?? { priceUsd: c.commission.priceUsd },
        { paidToDateUsd: paidConfirmed, signed: contractStage(offer) === "signed" }
      );
    }

    //  slice 3 — the ADVISORY buyer-default flag. Advisory ONLY: it tells the developer a default notice
    // MAY be eligible to serve (behind on a dated obligation, or paid under the standard SPA threshold). It is
    // never a verdict and never auto-serves — serving is an explicit developer action (POST /api/termination).
    // Suppressed once a default/termination process is already in progress on this deal (the overlay is past
    // `none`) — "may serve" makes no sense when one has already been served or the deal is terminal.
    const termination = await overlayFor(requestId);
    //  §config-surface — resolve this deal's buyer-default numbers through the SAME 3-tier
    // chain the signed S&P clause uses (building override → developer house default → code default), so the
    // advisory threshold and the clause can NEVER disagree. `offer` is this deal's offer, in scope above.
    const advBuilding = offer.display.buildingId ? await getBuilding(offer.display.buildingId) : null;
    const advDev = await getDeveloper(offer.developer);
    const termTerms = resolveTerminationChain(advBuilding?.terminationTerms, advDev?.terminationTerms);
    const eligible = buyerDefaultEligible({
      lateByDays: ledger.lateByDays,
      paidToDateUsd: ledger.paidToDateUsd,
      priceUsd: ledger.priceUsd,
      thresholdPct: termTerms.defaultThresholdPct,
    });
    const defaultAdvisory = {
      // Only prompt when eligible AND no process is already running/closed (overlay still at home state).
      eligible: eligible && termination.state === "none",
      // The honest reason — so the UI can say WHICH trigger fired without re-deriving the ledger.
      reason: ledger.lateByDays && ledger.lateByDays > 0 ? ("overdue" as const) : ("under_threshold" as const),
      thresholdPct: termTerms.defaultThresholdPct,
      // The deal's current termination state, so the panel can show "a default notice has been served" etc.
      // instead of the eligibility prompt once the process has begun.
      terminationState: termination.state,
    };

    //  slice 5 — the retain/refund SETTLEMENT. A pure DERIVATION from the live ledger (never persisted,
    // never on the sealed trail —: the amount is the ledger's job). Present only when the deal is TERMINAL
    // (terminated_retained / terminated_refunded); null otherwise (nothing settles while a cure clock runs).
    // Interest on a buyer-default is advisory + date-derived + capped (can't be abused) and is NOT folded into
    // the retained total — the developer decides whether to claim it (a later sealed step). Figures come from
    // the sealed plan + recorded payments + the clause rate, so the operator has no tunable knob in the math.
    const settlement = computeSettlement({
      state: termination.state,
      paidToDateUsd: paidAll,
      terms: termTerms,
      schedule: ledger.schedule,
    });

    // slice 6 — the UI also needs the running cure-clock (overlay.cureEndsAt) to render a countdown, and the
    // clause's cure-floor (days) to default the serve-notice form. Both are already resolved above.
    return NextResponse.json({
      payments: records.map(publicPayment),
      ledger,
      payable,
      defaultAdvisory,
      settlement,
      overlay: termination,
      cureDays: termTerms.cureDays,
    });
  }

  // Developer-scoped reads: per-deal, per-unit, or all.
  let records;
  if (requestId) records = await paymentsForRequest(developer, requestId);
  else if (buildingId && unitId) records = await paymentsForUnit(developer, buildingId, unitId);
  else records = await paymentsForDeveloper(developer);

  return NextResponse.json({ payments: records.map(publicPayment) });
}

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") || "";

  // ── JSON ops: buyer confirm/dispute (step 6) + dispute-view grant ──────────────────────────────
  if (ctype.includes("application/json")) {
    const body = await req.json().catch(() => ({}));

    // confirm/dispute — the buyer-side two-sided fact (§4b). The ACTOR may be the buyer in person OR the
    // buyer's agent as proxy. Authorisation here: the actor must be the named buyer, OR the deal's
    // agent/agency (lib/participant role === "agent"). We record which, for the audit trail (confirmBy.as).
    // logSent — the BUYER-SIDE records an INDEPENDENT "I sent $X on day D" attestation (§5b). The SECOND
    // ownership model on the same vault: it never touches `paidToDate` or the unlock (the developer's "received"
    // figure stays the sole cashflow basis) — it exists so the reconcile engine can pair the two ledgers and
    // surface a STRUCTURED discrepancy. VRX records the fact; it never decides whose number is true.
    //
    // AUTHZ (mirrors confirm/dispute, but PRE-record — no record exists to check against yet): resolve the
    // actor off the OFFER via lib/participant. The deal's AGENT/AGENCY (role "agent") is the buyer's PROXY
    // (`agent_for_buyer`) — the live posture today, since F1 buyer-auth is deferred and there is no buyer login
    // surface yet. A party naming itself as the buyer is trusted as "buyer" under the same demo posture as the
    // rest of this route (the signed binding rides F1). The buyer ACCOUNT is supplied by the caller (`buyer`) —
    // we do NOT read it off the offer: the offer's buyer snapshot is a MASKED seal, never a plaintext
    // account, so fabricating an owner from it would be wrong. The agent names their client; a self-buyer names
    // themselves. No slip on this JSON path — a buyer-side slip attaches afterwards via the multipart
    // addEvidence op (side="buyer"), keeping "just record what I sent" a one-call JSON write.
    if (body.op === "logSent") {
      const by = typeof body.by === "string" ? body.by.trim() : "";
      const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
      const buyer = typeof body.buyer === "string" ? body.buyer.trim() : "";
      const amountUsd = Number(body.amountUsd);
      const paidAt = Number(body.paidAt);
      const method = METHODS.includes(body.method) ? (body.method as PaymentMethod) : null;
      const note = typeof body.note === "string" ? body.note.trim() || undefined : undefined;
      if (!by || !requestId || !method) {
        return NextResponse.json({ error: "by + requestId + method (cash|bank_slip|qr_slip|other) required" }, { status: 400 });
      }
      if (!isValidAmount(amountUsd)) return NextResponse.json({ error: "amountUsd must be a positive number" }, { status: 400 });
      if (!Number.isFinite(paidAt) || paidAt <= 0) return NextResponse.json({ error: "paidAt (ms epoch) required" }, { status: 400 });

      const offer = await getOffer(requestId);
      if (!offer) return NextResponse.json({ error: "deal not found" }, { status: 404 });

      // AUTHZ — who may inject a "sent" record onto THIS (shared) deal? A sent record affects the OTHER party's
      // reconciliation, so unlike a self-scoped READ it needs a real party gate (a stranger must not be able to
      // pollute a deal's ledger). Two lawful actors, both resolved WITHOUT exposing the buyer's raw account (the
      // offer's buyer snapshot is a masked seal — the privacy moat):
      //   • the deal's AGENT/AGENCY (roleOnOffer === "agent") acting as the buyer's PROXY (the live posture —
      //  "the agent does all things for their client",; F1 buyer-login is deferred); OR
      //   • a self-logging BUYER who is ALREADY ESTABLISHED on the deal — i.e. names themselves AND matches the
      //     buyer the developer named on an existing record. (Demo posture: the caller names itself, same trust
      //     as paymentsForBuyer; the signed binding rides F1. The "already established" test is what stops an
      //     arbitrary account from inventing a sent record on a deal it has no part in.)
      // In BOTH cases the OWNER is the buyer already on the deal's records — never a free-typed account, so the
      // reconcile join stays consistent and no one can mis-attribute. With no anchor yet (no developer record
      // naming a buyer), the op refuses honestly (409): reconciliation needs one side to establish the buyer.
      const role = await roleOnOffer(offer, by);
      const existing = await paymentsForDeal(requestId);
      const anchoredBuyer = existing.find((r) => !!r.buyer)?.buyer?.trim() || "";

      let as: "buyer" | "agent_for_buyer";
      let owner: string;
      if (role === "agent") {
        as = "agent_for_buyer";
        // The agent names their client only if the caller supplied one AND it matches the anchor (or no anchor
        // yet but they named it); otherwise fall to the deal's established buyer. Never a raw unseen account.
        owner = anchoredBuyer || buyer;
      } else if (anchoredBuyer && lc(by) === lc(anchoredBuyer)) {
        // A self-logging buyer, proven by matching the buyer the developer already recorded on this deal.
        as = "buyer";
        owner = anchoredBuyer;
      } else {
        return NextResponse.json(
          { error: "only the deal's agent, or the buyer already recorded on this deal, may record a payment sent" },
          { status: 403 }
        );
      }
      if (!owner) {
        return NextResponse.json(
          { error: "no buyer is established on this deal yet — a payment the developer logs (which names the buyer) must exist first" },
          { status: 409 }
        );
      }
      const buildingId = offer.display.buildingId ?? "";
      const unitId = offer.display.unitId ?? "";
      if (!buildingId || !unitId) return NextResponse.json({ error: "this deal is missing its unit reference" }, { status: 409 });

      try {
        const rec = await logSentPayment({
          developer: offer.developer,
          buildingId,
          unitId,
          requestId,
          buyer: owner,
          amountUsd,
          paidAt,
          method,
          note,
          attestedBy: { account: by, as },
        });
        publish("events"); // open dashboards refresh (a new sent attestation changes the reconciliation)
        return NextResponse.json({ ok: true, payment: publicPayment(rec) });
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "could not record the payment sent" }, { status: 400 });
      }
    }

    if (body.op === "confirm") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const by = typeof body.by === "string" ? body.by.trim() : "";
      const decision = body.decision === "disputed" ? "disputed" : body.decision === "confirmed" ? "confirmed" : null;
      if (!id || !by || !decision) {
        return NextResponse.json({ error: "id + by + decision (confirmed|disputed) required" }, { status: 400 });
      }
      const rec = await getPayment(id);
      if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
      const as = await actorAsBuyerSide(rec, by);
      if (!as) return NextResponse.json({ error: "not permitted — only the buyer or their agent may confirm" }, { status: 403 });
      const note = typeof body.disputeNote === "string" ? body.disputeNote : undefined;
      const updated = await setBuyerConfirm(id, decision, { account: by, as }, note);
      if (!updated) return NextResponse.json({ error: "could not update (in-app payments are self-proving)" }, { status: 400 });
      // A DISPUTE flags to the DEAL CHAT (§4b) so the developer + buyer actually see it where they talk.
      // Post as the acting side (buyer in person → "buyer"; agent proxy → "agent") into the booking thread
      // keyed by the record's requestId. Best-effort — a chat post must never fail the confirm/dispute itself.
      if (decision === "disputed" && updated.requestId) {
        const line = `⚠ Payment disputed — ${updated.amountUsd} recorded on ${new Date(updated.paidAt).toLocaleDateString("en-GB")}.${note ? ` Reason: ${note}` : ""}`;
        try {
          await postMessage({ requestId: updated.requestId, from: as === "agent_for_buyer" ? "agent" : "buyer", by, text: line });
        } catch {
          /* chat post is best-effort — the dispute state is already saved */
        }
      }
      return NextResponse.json({ ok: true, payment: publicPayment(updated) });
    }

    // share — a party opens a DISPUTED slip into the dispute, to chosen audiences ("as the buyer wishes").
    if (body.op === "share") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const by = typeof body.by === "string" ? body.by.trim() : "";
      const to = Array.isArray(body.to) ? body.to.filter((x: unknown): x is "vrx" | "agent" | "developer" | "buyer" => x === "vrx" || x === "agent" || x === "developer" || x === "buyer") : [];
      if (!id || !by || to.length === 0) return NextResponse.json({ error: "id + by + to[] (vrx|agent|developer|buyer) required" }, { status: 400 });
      const rec = await getPayment(id);
      if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (!(await isDealParty(rec, by))) return NextResponse.json({ error: "only a party to this deal may share" }, { status: 403 });
      const updated = await setDisputeShare(id, by, to);
      return NextResponse.json({ ok: true, payment: updated ? publicPayment(updated) : null });
    }

    // flag — raise a bad-evidence / bad-actor allegation (the dog-photo case). DESIGN-NOW/BUILD-LATER:
    // the flag persists + drops the record from the unlock % now; the escalation/stop-deal machinery is later.
    if (body.op === "flag") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const by = typeof body.by === "string" ? body.by.trim() : "";
      const kind = body.kind === "bad_actor" ? "bad_actor" : body.kind === "bad_evidence" ? "bad_evidence" : null;
      if (!id || !by || !kind) return NextResponse.json({ error: "id + by + kind (bad_evidence|bad_actor) required" }, { status: 400 });
      const rec = await getPayment(id);
      if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (!(await isDealParty(rec, by))) return NextResponse.json({ error: "only a party to this deal may flag" }, { status: 403 });
      const updated = await flagPayment(id, kind, by, typeof body.reason === "string" ? body.reason : undefined);
      return NextResponse.json({ ok: true, payment: updated ? publicPayment(updated) : null });
    }

    // shareAgent — the BUYER keeps their AGENT in the loop on THIS payment (voluntary, standing). Only
    // the named buyer (or their agent as proxy) may toggle it. Distinct from the dispute `share` above.
    if (body.op === "shareAgent") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const by = typeof body.by === "string" ? body.by.trim() : "";
      const on = body.on !== false; // default true
      if (!id || !by) return NextResponse.json({ error: "id + by required" }, { status: 400 });
      const rec = await getPayment(id);
      if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (!(await actorAsBuyerSide(rec, by))) return NextResponse.json({ error: "only the buyer or their agent may set this" }, { status: 403 });
      const updated = await setBuyerShareToAgent(id, on);
      return NextResponse.json({ ok: true, payment: updated ? publicPayment(updated) : null });
    }

    return NextResponse.json({ error: "unknown op (expected confirm|share|shareAgent|flag)" }, { status: 400 });
  }

  // ── multipart: log a payment, OR attach a side's evidence slip to an existing record ──────────────────
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "invalid form" }, { status: 400 });

    // op=addEvidence — a side attaches its own slip to an EXISTING record (both-sides upload). The
    // developer may attach the "developer" side; the buyer or their agent-proxy may attach the "buyer" side.
    if (String(form.get("op") || "").trim() === "addEvidence") {
      const id = String(form.get("id") || "").trim();
      const by = String(form.get("by") || "").trim();
      const side = String(form.get("side") || "").trim();
      const file = form.get("file");
      if (!id || !by || (side !== "developer" && side !== "buyer")) {
        return NextResponse.json({ error: "id + by + side (developer|buyer) required" }, { status: 400 });
      }
      if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "file required" }, { status: 400 });
      if (!OK_MIME.test(file.type)) return NextResponse.json({ error: "evidence must be an image or PDF" }, { status: 400 });
      if (file.size > MAX_BYTES) return NextResponse.json({ error: "evidence too large (max 8 MB)" }, { status: 400 });
      const rec = await getPayment(id);
      if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
      // Authorise by side: developer side → the owning developer; buyer side → the named buyer or their agent.
      const authed = side === "developer" ? lc(rec.developer) === lc(by) : !!(await actorAsBuyerSide(rec, by));
      if (!authed) return NextResponse.json({ error: `not permitted to attach the ${side}-side slip` }, { status: 403 });
      try {
        const updated = await addEvidence(id, { bytes: Buffer.from(await file.arrayBuffer()), filename: file.name || "slip", mime: file.type, side, uploadedBy: by });
        return NextResponse.json({ ok: true, payment: updated ? publicPayment(updated) : null });
      } catch (e) {
        if (e instanceof VaultLockedError) return NextResponse.json({ error: "vault is locked — an operator must unlock it before attaching evidence" }, { status: 503 });
        return NextResponse.json({ error: e instanceof Error ? e.message : "could not attach evidence" }, { status: 400 });
      }
    }

    const developer = String(form.get("developer") || "").trim();
    const buildingId = String(form.get("buildingId") || "").trim();
    const unitId = String(form.get("unitId") || "").trim();
    const requestId = String(form.get("requestId") || "").trim() || undefined;
    const buyer = String(form.get("buyer") || "").trim() || undefined;
    const method = String(form.get("method") || "").trim() as PaymentMethod;
    const rail = String(form.get("rail") || "").trim() as PaymentRail;
    const note = String(form.get("note") || "").trim() || undefined;
    const amountUsd = Number(form.get("amountUsd"));
    const paidAt = Number(form.get("paidAt"));

    if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
    if (!buildingId || !unitId) return NextResponse.json({ error: "buildingId + unitId required" }, { status: 400 });
    if (!isValidAmount(amountUsd)) return NextResponse.json({ error: "amountUsd must be a positive number" }, { status: 400 });
    if (!Number.isFinite(paidAt) || paidAt <= 0) return NextResponse.json({ error: "paidAt (ms epoch) required" }, { status: 400 });
    if (!METHODS.includes(method)) return NextResponse.json({ error: "method must be one of " + METHODS.join("|") }, { status: 400 });
    if (!RAILS.includes(rail)) return NextResponse.json({ error: "rail must be one of " + RAILS.join("|") }, { status: 400 });

    let evidence: { bytes: Buffer; filename: string; mime: string } | undefined;
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      if (!OK_MIME.test(file.type)) return NextResponse.json({ error: "evidence must be an image or PDF" }, { status: 400 });
      if (file.size > MAX_BYTES) return NextResponse.json({ error: "evidence too large (max 8 MB)" }, { status: 400 });
      evidence = { bytes: Buffer.from(await file.arrayBuffer()), filename: file.name || "slip", mime: file.type };
    }

    try {
      const rec = await logPayment({ developer, buildingId, unitId, requestId, buyer, amountUsd, paidAt, method, rail, note, evidence });
      return NextResponse.json({ ok: true, payment: publicPayment(rec) });
    } catch (e) {
      if (e instanceof VaultLockedError) {
        // A payment WITH evidence needs the KEK; a locked vault can't wrap the slip. (No-evidence writes never reach here.)
        return NextResponse.json({ error: "vault is locked — an operator must unlock it before logging a payment with evidence" }, { status: 503 });
      }
      return NextResponse.json({ error: e instanceof Error ? e.message : "could not log payment" }, { status: 400 });
    }
  }

  return NextResponse.json({ error: "unsupported content-type" }, { status: 415 });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const developer = url.searchParams.get("developer")?.trim() || "";
  const id = url.searchParams.get("id")?.trim() || "";
  if (!developer || !id) return NextResponse.json({ error: "developer + id required" }, { status: 400 });
  const ok = await deletePayment(id, developer);
  if (!ok) return NextResponse.json({ error: "not your payment, or not found" }, { status: 403 });
  return NextResponse.json({ ok: true });
}
