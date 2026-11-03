// /api/desk-action — the EXECUTOR behind the in-chat action-buttons spine (Decision B of
// the design docs). SERVER-ONLY.
//
// When the buyer TAPS a commit chip (rendered from a message's un-hashed `action?` payload — channels.ts), the
// client POSTs { account, conversationId, buttonKind, unit } here and this route runs the SAME executor the AI's
// tool loop runs (open_unit for "reserve"). The whole point of the spine: the commit is a STRUCTURED payload the
// server executes deterministically, never a parsed chat turn — so the confab/loop/wrong-unit bug class
//  cannot happen.
//
//   POST { account, conversationId, buttonKind:"reserve", unit } → run open_unit for THIS buyer on THIS unit.
//         → { ok:true, outcome, unitId, releaseAt?, alreadyHeld? } | { ok:false, reason }
//
//  Slice 2 — the two READ-ONLY buttons (no commit, no money, no state change): the server runs the SAME
// executor the AI tool loop runs and POSTS the result back into the thread as a desk message, so the buyer sees
// the answer inline (consistent with how the AI's own `terms`/`find_units` results appear).
//   POST { …, buttonKind:"view_terms", unit? } → buildingTerms → post a payment-terms TABLE for the building/unit.
//   POST { …, buttonKind:"show_similar", unit? } → findUnits → post a numbered list of comparable on-market units.
// Both are matrix-gated inside the executor (buyer×browse allows building_terms + inventory); public facts only
// (the deductible deposit is named; flat VRX/developer fees are never shown). A read button does NOT need
// unit-eligibility (it reveals nothing the buyer can't already ask the desk for in chat) — only reserve gates on
// isUnitGranted. Still fail-closed on ROLE (only the conversation's buyer may drive the thread).
//
//  Slice 3a — the S&P-BEFORE-DEPOSIT gate (the first money-ordering RULE, §4 of the design):
//   POST { …, buttonKind:"read_sp" } → the buyer VIEWS the Sale & Purchase agreement. Requires a HELD deposit
//        for this deal (so there's a unit to paper); MATERIALIZES the direct offer (idempotent) so the real S&P
//        renders; records the ACK on the deal sidecar (spAcknowledgedAt). → { ok, requestId, acknowledged:true }.
//   POST { …, buttonKind:"pay_deposit" } → SERVER-ENFORCED legal gate: refused 409 `sp_not_acknowledged` unless
//        [Read S&P] was tapped first. When the ack is present it returns { ok:true, mayPay:true } — the actual
//        $VRX debit still runs through the existing /api/direct-deposits `pay-vrx` rail (Slice 4 owns the pay
//        SURFACE). The button's `enabled` is advisory UI; THIS re-check is the authority (fail-closed).
//
// ── AUTHORIZATION (fail-closed, defence in depth — §5b of the design) ────────────────────────────────────
//   1. ROLE: the caller's role is resolved from the conversation (directRole), NEVER trusted from the client.
//      Only the conversation's BUYER may tap a reserve chip. A non-participant / the desk side → 403.
//   2. UNIT-ELIGIBILITY: the unit must be one the desk actually OPENED to THIS buyer (isUnitGranted). A forged
//      POST with a real conversationId + an arbitrary unit is rejected 403 — not merely "is the caller a party"
//      (the under-specification the adversarial pass caught). open_unit ALSO re-checks live availability (its own
//      Gate 3), so a stale/unavailable unit returns a clean denial, never a bad hold.
//   3. IDEMPOTENT: open_unit no-ops a re-hold by the same deal (Gate 3b + the bridge's own idempotency), so a
//      double-tap yields exactly ONE hold. We rely on that rather than a second lock.
// The client-sent `label`/`priceUsd` are IGNORED — the server resolves the real unit + re-derives money
// (depositPct × live price via the open_unit bridge). The button payload is DISPLAY only.
//
// PRIVACY: parties resolved server-side from the conversation; neutral account ids; the hold/deposit the
// executor writes carry only opaque refs. This is a UI/transport seam — the executor is the ONE business-logic
// path shared with the AI lane and the real on-chain lane ([[vrx-demo-vs-real-shared-path-audit]]).

import { NextResponse } from "next/server";
import { directParties, directRole } from "@/lib/conversations-direct";
import { requireCaller } from "@/lib/caller";
import { isUnitGranted } from "@/lib/unit-grants";
import { getAiDeskConfig } from "@/lib/ai-desk/config";
import { toolScope } from "@/lib/ai-desk/tool-loop";
import { openUnit, type ActionScope } from "@/lib/ai-desk/open-unit";
import { buildingTerms, findUnits } from "@/lib/ai-desk/query-tools";
import { formatTermsTable } from "@/lib/ai-desk/act";
import { realTermsToRows, formatSimilarUnits } from "@/lib/ai-desk/button-results";
import { postMessage } from "@/lib/channels";
import { acknowledgeSP, isSpAcknowledged } from "@/lib/ai-desk/deal-sidecar";
import { depositsForBuyer, getDeposit } from "@/lib/direct-deposits";
import { payDepositVrx } from "@/lib/pay-deposit";
import { balanceOf } from "@/lib/vrx-token";
import { minorToUsd } from "@/lib/fx";
import { materializeDirectOffer } from "@/lib/direct-offer";
import {
  materializeReservationDocument,
  getReservationDocument,
  confirmReservation,
  depositWindowState,
  proposeSigningDate,
  approveSigningDate,
} from "@/lib/ai-desk/reservation-document";
import {
  formatReservationDocument,
  formatReservationConfirmed,
  formatReserveConfirmed,
  formatSigningDate,
} from "@/lib/ai-desk/button-results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The button kinds this route accepts. "reserve" fires a real hold (Slice 1); "view_terms"/"show_similar" are
 *  read-only and post their result into the thread (Slice 2). "read_sp"/"pay_deposit" are recognised shape-wise
 *  but not yet wired (their slices land later). An unknown kind is a 400 so a typo fails loud, not a silent no-op. */
const KNOWN_KINDS = [
  "reserve",
  "view_terms",
  "read_sp",
  "pay_deposit",
  "show_similar",
  "issue_reservation",
  "confirm_reservation",
  "propose_signing_date",
  "approve_signing_date",
] as const;
type Kind = (typeof KNOWN_KINDS)[number];
const isKind = (s: unknown): s is Kind => typeof s === "string" && (KNOWN_KINDS as readonly string[]).includes(s);

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const claimedAccount = typeof body.account === "string" ? body.account.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";

  // AUDIT (VRX-0001 IDOR class): the acting account MUST be the PROVEN caller, not a trusted body field.
  // Gate 1 below resolves the ROLE from the conversation — but role-on-a-CLAIMED-account only proves "that named
  // account is a party", not "the CALLER is that account". Without this, an attacker who learns a conversationId
  // (opaque, but not a secret) could POST {account:"<victim-buyer>", buttonKind:"reserve"/"confirm"/"read_sp"/…}
  // and drive the deal AS the victim (reserve units, start their deposit clock, ack the S&P for them). Bind the
  // account to the session first; the role check then runs on the proven identity. (Mirrors F1 + the tray.)
  const who = requireCaller(req, { param: claimedAccount });
  if (!who.ok) return NextResponse.json({ ok: false, reason: "sign-in required" }, { status: 401 });
  const account = who.account;
  const buttonKind = body.buttonKind;
  // The unit the chip commits to. Accept either a bare id string or the button's { key } display shape; we
  // re-resolve/re-validate it server-side regardless (the client value is never trusted for the money path).
  const unitId =
    typeof body.unit === "string"
      ? body.unit.trim()
      : body.unit && typeof body.unit === "object" && typeof body.unit.key === "string"
        ? body.unit.key.trim()
        : "";

  if (!account || !conversationId) {
    return NextResponse.json({ ok: false, reason: "account + conversationId required" }, { status: 400 });
  }
  if (!isKind(buttonKind)) {
    return NextResponse.json({ ok: false, reason: "unknown buttonKind" }, { status: 400 });
  }

  // Gate 1 — ROLE: resolved from the conversation, never claimed by the client. A non-participant is always
  // refused. Then the ALLOWED role depends on the kind (§4/§0b):
  //   • approve_signing_date is the VRX/honesty role — in the demo the desk DEVELOPER stands in for VRX, so it
  //     is DEVELOPER-only (the buyer may not self-approve their own signing date).
  //   • propose_signing_date is a negotiation affordance either side may use (buyer OR developer).
  //   • every other kind (reserve/confirm/pay/read/issue) is a BUYER commit/affordance — buyer-only.
  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ ok: false, reason: "not a participant" }, { status: 403 });
  const allowedRole: "buyer" | "developer" | "both" =
    buttonKind === "approve_signing_date" ? "developer" : buttonKind === "propose_signing_date" ? "both" : "buyer";
  if (allowedRole !== "both" && role !== allowedRole) {
    return NextResponse.json(
      { ok: false, reason: allowedRole === "developer" ? "only VRX/the desk may approve the signing date" : "only the buyer may act on this" },
      { status: 403 }
    );
  }

  const parties = await directParties(conversationId);
  if (!parties) return NextResponse.json({ ok: false, reason: "no deal" }, { status: 404 });

  // ── READ buttons (Slice 2) — view_terms / show_similar ────────────────────────────────────────────────────
  // Pure reads: run the SAME executor the AI tool loop runs over the REAL catalog (matrix-gated inside), then
  // POST the formatted result into the thread as a desk reply so the buyer sees it inline. No commit, no money,
  // no unit-eligibility gate (a read reveals nothing the buyer couldn't already ask the desk in chat). `unit` is
  // OPTIONAL here — view_terms without a unit answers the BUILDING's terms; with one, that unit's effective terms.
  if (buttonKind === "view_terms" || buttonKind === "show_similar") {
    const scope = toolScope("buyer", "browse", parties.building);
    let text: string;
    if (buttonKind === "view_terms") {
      const r = await buildingTerms(scope, unitId ? { unitId } : undefined);
      // Gate flipping off mid-session, or no building: honest line, never a thrown action.
      const rows = r.ok && r.data ? realTermsToRows(r.data) : [];
      text = rows.length
        ? `Payment terms${unitId ? ` for ${unitId}` : ""}:\n${formatTermsTable(rows)}`
        : "There are no published payment terms for this building yet.";
    } else {
      // Comparable units: the top on-market matches in this building (findUnits sorts cheapest-first within the
      // on-market set). The client never sends a trusted budget/brief — the server reads the real catalog.
      const r = await findUnits(scope, { limit: 3 });
      text = r.ok ? formatSimilarUnits(r.data.units, r.data.matchCount) : "I can't look up comparable units right now.";
    }
    const posted = await postMessage({
      requestId: conversationId,
      from: "developer",
      by: parties.developer,
      text,
      context: { kind: "direct", id: conversationId },
    });
    return NextResponse.json({ ok: posted !== null, buttonKind, posted: posted !== null }, { status: 200 });
  }

  // ── S&P-BEFORE-DEPOSIT gate (Slice 3a) — read_sp / pay_deposit ──────────────────────────────────────────────
  // The focus unit for the S&P/pay is the one this buyer has a HELD deposit on in this building (set by the
  // Reserve→bridge path). We resolve it server-side (the client value is never trusted for the MONEY), but when
  // the chip carries a unit we require THAT held unit — deterministic when the buyer has multiple holds in the
  // building (the wrong-unit bug class this spine exists to kill; fixed alongside the Reservation Document).
  if (buttonKind === "read_sp" || buttonKind === "pay_deposit") {
    const myHolds = (await depositsForBuyer(parties.buyer)).filter(
      (d) => d.building === parties.building && d.status === "held"
    );
    const held = unitId ? myHolds.find((d) => d.unit === unitId) : myHolds[0];
    if (!held) {
      // Nothing is firm-held yet → there's no reservation to paper or pay. Honest, not a 500.
      return NextResponse.json({ ok: false, reason: "no_held_reservation", buttonKind }, { status: 409 });
    }

    if (buttonKind === "read_sp") {
      // Materialize the direct offer (idempotent — keyed on (conversationId, epoch)) so the REAL populated S&P
      // becomes resolvable for the buyer BEFORE they pay (§0b), then record the acknowledgement. The
      // desk developer is the authorized author (parties.developer == deskDeveloperFor(building)).
      const res = await materializeDirectOffer({
        conversationId,
        buyer: parties.buyer,
        building: parties.building,
        unit: held.unit,
        by: parties.developer,
      });
      if (!res.ok) {
        return NextResponse.json({ ok: false, reason: "sp_not_available", detail: res.reason }, { status: 409 });
      }
      const acknowledgedAt = await acknowledgeSP(conversationId, parties.building);
      return NextResponse.json({
        ok: true,
        buttonKind,
        requestId: res.offer.requestId,
        acknowledged: true,
        acknowledgedAt,
      });
    }

    // pay_deposit — the legal-ordering GATE, and now (Slice 4) the pay EXECUTION surface. Fail-closed;
    // TWO ordering rules must both hold before any money moves (§4):
    //   (a) the S&P must have been acknowledged first (Slice 3a); and
    //   (b) the reservation must be CONFIRMED and still within the 2-hour deposit window (Slice 3b-ii). A lapsed
    //       window refuses pay (the buyer re-confirms to restart the clock); never-confirmed refuses too.
    const acked = await isSpAcknowledged(conversationId);
    if (!acked) {
      return NextResponse.json({ ok: false, reason: "sp_not_acknowledged", buttonKind }, { status: 409 });
    }
    //  multi-unit: the deposit-window gate must read THIS unit's reservation doc (the one we're about to pay —
    // held.unit), not the deal's newest. Otherwise, with two reserved units, a confirmed window on unit B could
    // wrongly green-light a pay for an unconfirmed unit A. Key the gate to held.unit.
    const resDoc = await getReservationDocument(conversationId, held.unit);
    const win = resDoc ? depositWindowState(resDoc) : { state: "unconfirmed" as const, msLeft: 0 };
    if (win.state !== "open") {
      // unconfirmed → confirm first; lapsed → the 2h window passed, re-confirm to restart.
      return NextResponse.json(
        { ok: false, reason: win.state === "lapsed" ? "deposit_window_lapsed" : "not_confirmed", buttonKind },
        { status: 409 }
      );
    }
    // The ordering gates passed → EXECUTE the deposit on the ONE shared money path (lib/pay-deposit): the buyer
    // pays the DEVELOPER in $VRX, balance-aware, idempotent. Authorization is already proven above
    // (requireCaller bound the account to the session, directRole proved buyer-on-this-deal), and pay-deposit is
    // the SAME path the held-unit card calls (/api/direct-deposits pay-vrx) — so a buyer can pay in either place
    // and the other no-ops. We pay the unit the gate resolved (`held.unit`), never a client-sent unit. At V5 the
    // debit relocates to a signed on-chain transfer behind this same seam (the executor stays one path).
    const pay = await payDepositVrx(parties.buyer, parties.building, held.unit);
    if (!pay.ok) {
      // insufficient balance / unpayable / missing — honest status straight through (the balance-aware refusal).
      return NextResponse.json(
        { ok: false, reason: pay.error, buttonKind, ...(pay.balanceVrx !== undefined ? { balanceVrx: pay.balanceVrx } : {}), ...(pay.amountVrx !== undefined ? { amountVrx: pay.amountVrx } : {}) },
        { status: pay.status }
      );
    }
    if (pay.alreadyPaid) {
      return NextResponse.json({ ok: true, buttonKind, paid: true, alreadyPaid: true, unit: held.unit });
    }
    // Paid. Post a buyer-facing confirmation into the thread so the chat reflects the settled deposit inline
    // (consistent with how the other chips surface their result), then report the money truth to the caller.
    await postMessage({
      requestId: conversationId,
      from: "developer",
      by: parties.developer,
      text: `✓ Deposit of $${pay.amountVrx.toLocaleString()} paid for ${held.unit}. Your reservation is settled — the developer has received your deposit.`,
      context: { kind: "direct", id: conversationId },
    });
    return NextResponse.json({ ok: true, buttonKind, paid: true, unit: held.unit, amountVrx: pay.amountVrx, balanceVrx: pay.balanceVrx, paidTo: pay.paidTo });
  }

  // ── RESERVATION DOCUMENT (Slice 3b-i) — issue_reservation ───────────────────────────────────────────────────
  // Promote the bare hold into the VRX-native Reservation Document (§0b): unit + price + deductible deposit +
  // schedule + a proposed signing date + revision number. Requires a HELD deposit (that IS the paid-on-hold
  // fact this papers — resolved server-side, never a client unit). Materialize (or revise) the doc, then post a
  // buyer-facing summary into the thread so the buyer sees the terms inline. The money is SNAPSHOTTED from the
  // sealed offer (the one money path); this adds only the signing-date + revision state.
  if (buttonKind === "issue_reservation") {
    const res = await materializeReservationDocument({
      conversationId,
      buyer: parties.buyer,
      building: parties.building,
      // The unit the chip papers (the reserved unit). Disambiguates when the buyer has multiple holds; the
      // server still re-verifies it's genuinely held (the client value is never trusted for the money itself).
      unit: unitId || undefined,
    });
    if (!res.ok) {
      // no_held_reservation / no_desk / offer_failed — honest 409, never a 500 or a fabricated doc.
      const status = res.reason === "no_held_reservation" ? 409 : 409;
      return NextResponse.json({ ok: false, reason: res.reason, buttonKind }, { status });
    }
    await postMessage({
      requestId: conversationId,
      from: "developer",
      by: parties.developer,
      text: formatReservationDocument(res.doc),
      context: { kind: "direct", id: conversationId },
    });
    return NextResponse.json({
      ok: true,
      buttonKind,
      revision: res.doc.revision,
      created: res.created,
      bumped: res.bumped,
      unit: res.doc.unit,
      proposedSigningAt: res.doc.proposedSigningAt,
    });
  }

  // ── CONFIRM / SIGNING-DATE (Slice 3b-ii / 3b-iii) ───────────────────────────────────────────────────────────
  // These all operate on the Reservation Document (which must already be issued — the money is snapshotted there,
  // never re-derived here). A missing document is an honest 409 (issue the reservation first), never a 500.
  if (buttonKind === "confirm_reservation") {
    // The buyer commits ("time to think" → go): this starts the 2-hour deposit window from THIS tap (§4). No
    // money moves here; pay_deposit enforces the window. Requires a doc (and thus a held deposit) to exist.
    // Target THIS reserved unit's doc (multi-unit key). unitId is the chip's re-resolved unit; omitted →
    // the sole/newest doc in the deal (back-compat for a single-unit conversation).
    const existing = await getReservationDocument(conversationId, unitId || undefined);
    if (!existing) return NextResponse.json({ ok: false, reason: "no_reservation_document", buttonKind }, { status: 409 });
    const doc = await confirmReservation(conversationId, unitId || undefined);
    if (!doc) return NextResponse.json({ ok: false, reason: "no_reservation_document", buttonKind }, { status: 409 });
    await postMessage({
      requestId: conversationId,
      from: "developer",
      by: parties.developer,
      text: formatReservationConfirmed(doc),
      context: { kind: "direct", id: conversationId },
    });
    return NextResponse.json({ ok: true, buttonKind, confirmedAt: doc.confirmedAt, depositDueAt: doc.depositDueAt });
  }

  if (buttonKind === "propose_signing_date") {
    // Either side proposes a date (the both-pick→match negotiation, §0b). The write primitive clamps to
    // [now, +90 working days] and CLEARS any prior VRX approval (a new date must be re-approved). The date comes
    // from the client as an ms epoch or an ISO day; we parse + validate it (never trust it for money — it only
    // sets the signing date). A missing/invalid date is a clean 400.
    const raw = body.signingAt ?? body.date;
    const atMs = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
    if (!Number.isFinite(atMs)) {
      return NextResponse.json({ ok: false, reason: "signingAt required (ms epoch or ISO date)", buttonKind }, { status: 400 });
    }
    const doc = await proposeSigningDate(conversationId, atMs, unitId || undefined);
    if (!doc) return NextResponse.json({ ok: false, reason: "no_reservation_document", buttonKind }, { status: 409 });
    await postMessage({
      requestId: conversationId,
      from: role === "buyer" ? "buyer" : "developer",
      by: account,
      text: formatSigningDate(doc, "proposed"),
      context: { kind: "direct", id: conversationId },
    });
    return NextResponse.json({ ok: true, buttonKind, proposedSigningAt: doc.proposedSigningAt, vrxApproved: false });
  }

  if (buttonKind === "approve_signing_date") {
    // VRX (the desk developer, in the demo) approves the agreed signing date — the honesty/vetting stamp (§0b).
    // Idempotent + monotonic. This is what RATIFIES the date; mayProceedToLandOffice gates the (future)
    // handover on this approval — the ratify-before-Land-Office ordering invariant.
    const doc = await approveSigningDate(conversationId, unitId || undefined);
    if (!doc) return NextResponse.json({ ok: false, reason: "no_reservation_document", buttonKind }, { status: 409 });
    await postMessage({
      requestId: conversationId,
      from: "developer",
      by: parties.developer,
      text: formatSigningDate(doc, "approved"),
      context: { kind: "direct", id: conversationId },
    });
    return NextResponse.json({ ok: true, buttonKind, vrxApprovedAt: doc.vrxApprovedAt, proposedSigningAt: doc.proposedSigningAt });
  }

  if (buttonKind !== "reserve") {
    // No other kinds remain, but keep a benign fallback so an unhandled kind never 500s.
    return NextResponse.json({ ok: false, reason: "not_yet_available", buttonKind }, { status: 200 });
  }

  if (!unitId) return NextResponse.json({ ok: false, reason: "unit required" }, { status: 400 });

  // Gate 2 — UNIT-ELIGIBILITY: the desk must actually have OPENED this unit to THIS buyer (isUnitGranted).
  // A real conversationId + an arbitrary unit is rejected here — participant-role alone is not enough (§5b.2).
  const granted = await isUnitGranted(parties.buyer, parties.building, unitId);
  if (!granted) {
    return NextResponse.json({ ok: false, reason: "unit_not_offered" }, { status: 403 });
  }

  // Build the ActionScope server-side. Phase is forced to "book": the buyer tapping Reserve IS the explicit
  // intent to hold, and open_unit is matrix-gated to book/deposit (a reserve chip is only ever rendered once the
  // deal has reached that stage). canOpenUnit comes from the LIVE config (the per-action authority); if it's OFF
  // open_unit returns "propose" (no hold) — the honest posture, not a failure. The signing posture rides along.
  const cfg = await getAiDeskConfig();
  const scope: ActionScope = {
    ...toolScope("buyer", "book", parties.building),
    dealId: conversationId,
    canOpenUnit: cfg.canOpenUnit,
    signingPosture: cfg.signingPosture,
  };

  // Fire the SAME executor the AI tool loop runs. It re-checks live availability (Gate 3a), refuses a unit held
  // by ANOTHER deal (Gate 3b), is idempotent for a re-hold by THIS deal (so a double-tap = one hold), and bridges
  // the hold into the buyer's direct-deposit rail so "Pay deposit" lights up — all server-side, no model.
  const result = await openUnit(scope, { unitId });

  if (result.ok && result.outcome === "held") {
    // Desk is TRANSPARENT + PROACTIVE about money + timing: the reserve chip is the only commit
    // that posted nothing back into the thread, yet the hold is exactly when the buyer needs to know (1) their
    // hold WINDOW / auto-release and (2) WHAT + HOW to pay, with their own COVERAGE (balance vs deposit) — so an
    // underfunded buyer learns it HERE, not at the pay tap. Resolve both server-side (the deposit the bridge just
    // filed + the buyer's own $VRX balance) and post one buyer-facing desk message, like every other chip.
    // BEST-EFFORT: the hold is the authoritative outcome; a messaging hiccup must never fail the reserve. The
    // deposit/balance lookups degrade to an honest window-only message (the formatter handles 0/null).
    try {
      const dep = result.bridged ? await getDeposit(parties.buyer, parties.building, result.unitId) : null;
      const depositUsd = dep ? minorToUsd(dep.amountMinor, dep.currency) : 0;
      let balanceVrx: number | null = null;
      try {
        balanceVrx = await balanceOf(parties.buyer);
      } catch {
        /* balance read is best-effort — the message still states the window + pay step without coverage */
      }
      await postMessage({
        requestId: conversationId,
        from: "developer",
        by: parties.developer,
        text: formatReserveConfirmed({
          unit: result.unitId,
          depositUsd,
          balanceVrx,
          releaseAtMs: result.releaseAt,
          nowMs: Date.now(),
        }),
        context: { kind: "direct", id: conversationId },
      });
    } catch {
      /* the hold stands regardless; the buyer can still see it on their card + the pay chip */
    }
    return NextResponse.json({
      ok: true,
      outcome: "held",
      unitId: result.unitId,
      releaseAt: result.releaseAt,
      bridged: result.bridged,
    });
  }
  if (result.ok && result.outcome === "propose") {
    // canOpenUnit OFF — the desk holds nothing autonomously; the buyer's tap is recorded as an intent to escalate
    // to a human. Honest, not an error.
    return NextResponse.json({ ok: false, outcome: "propose", reason: "holds_require_human" }, { status: 200 });
  }
  if (result.ok && result.outcome === "needs_authorization") {
    return NextResponse.json({ ok: false, outcome: "needs_authorization", reason: result.reason }, { status: 200 });
  }
  // Denied (availability / already held by another / resolution). Surface the reason for a clean buyer message.
  return NextResponse.json({ ok: false, outcome: "denied", reason: result.reason }, { status: 200 });
}
