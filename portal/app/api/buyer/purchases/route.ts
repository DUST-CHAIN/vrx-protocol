// GET /api/buyer/purchases?account=<buyer>
//  → the buyer's "My purchases" tray feed ([[vrx-buyer-purchases-tray]], the design docs).
//     One row per Reservation Document the buyer holds, each joined with its deposit + an honest lifecycle STATUS
//     + (when the offer is materialized) the opaque S&P requestId so the tray can link to the draft Sale & Purchase
//  contract. A single, always-available consolidated list — the in-app twin of the operator catalog emailing the reservation doc.
//
// WHY A DEDICATED ROUTE (not reuse /conversations-direct/offer): that route answers "one deal's requestId"; the
// tray needs the buyer's reservations ACROSS all deals with their staged status. The data already exists on the
// buyer-keyed stores (reservation documents + direct deposits), so this route is a pure read/aggregation (kin to
// the wallet/BI surface) — it mints nothing.
//
// STATUS (the honest-badge design point): the tray must never present a provisional draft as a binding
// contract. We derive a single lifecycle status per row from the real state:
//   reserved        — a Reservation Document exists, buyer has not confirmed yet ("time to think").
//   confirmed       — buyer confirmed; the 2h deposit window is OPEN (clock running).
//   window_lapsed   — buyer confirmed but the 2h window passed with no deposit (must re-confirm).
//   deposit_paid    — the deposit is settled (held on-chain OR paid in $VRX) → the DRAFT S&P is available.
//   ratified        — the signing date is VRX-approved (ready for the Land-Office step; the final contract follows).
// The draft S&P is surfaced (hasDraftSp) only once (a) the deposit is paid AND (b) the offer is materialized — and
// the tray labels it PROVISIONAL (digitally sealed, not yet the paper-signed final). The FINAL signed contract is a
// later stage (post courier + scan-back + dev-admin sign-off, Slice 5) — not yet modelled, so never claimed here.
//
// PRIVACY + AUTH (VRX-0001 fail-closed IDOR class): returns only neutral/opaque fields to the
// AUTHENTICATED buyer (building/unit ids, their own money figures, the opaque requestId). No PII, no counterparty
// identity, no terms text (the S&P route masks on fetch). The caller's identity comes from the PROVEN session via
// requireCaller — NOT the raw `?account=` param — so a stranger can NOT enumerate another buyer's reservations +
// draft-S&P requestId by naming their account. The store filter is then buyer-scoped on that proven account.

import { NextResponse } from "next/server";
import { reservationDocumentsForBuyer, depositWindowState } from "@/lib/ai-desk/reservation-document";
import { depositsForBuyer } from "@/lib/direct-deposits";
import { getOffer } from "@/lib/offers";
import { isDirectOffer } from "@/lib/direct-offer";
import { requireCaller } from "@/lib/caller";
import { custodyStateOf, vetoMsLeft } from "@/lib/escrow/deposit-custody";
import { depositEvidenceForDeal } from "@/lib/escrow/deposit-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PurchaseStatus = "reserved" | "confirmed" | "window_lapsed" | "deposit_paid" | "ratified";

export async function GET(req: Request) {
  // The buyer's own tray — derive the account from the PROVEN caller (session), never the client-supplied param.
  // The `account` query param is used ONLY as the god-mode/dev-fallback hint requireCaller allows; in strict mode
  // (the default, incl. the live demo) a mismatched or absent session refuses 401. This closes the cross-buyer
  // IDOR the raw-param version would open (a shipped leak of reservations + draft-S&P ids).
  const claimed = new URL(req.url).searchParams.get("account")?.trim() || "";
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: who.reason }, { status: who.status });
  const account = who.account;

  const docs = await reservationDocumentsForBuyer(account);
  // One read of the buyer's deposits, joined by (building, unit) — the money fact that staged a reservation past
  // "confirmed" into "deposit paid". depositsForBuyer is already buyer-scoped + newest-first.
  const deposits = await depositsForBuyer(account);
  const depositFor = (building: string, unit: string) =>
    deposits.find((d) => d.building === building && d.unit === unit) ?? null;

  const now = Date.now();
  const rows = await Promise.all(
    docs.map(async (doc) => {
      const dep = depositFor(doc.building, doc.unit);
      // "Settled" = the deposit actually paid: held on-chain (desk firm-hold) OR paid in $VRX (buyer self-pay).
      // A merely "pending"/"released" deposit is NOT a paid deposit (released = the deal fell through → no draft).
      const depositPaid = !!dep && (dep.status === "held" || !!dep.paidVrx);
      const win = depositWindowState(doc, now);

      // The deposit figure the buyer sees: prefer the REAL filed deposit (direct-deposits, in minor units of its
      // currency) over the doc's plan snapshot, which can be 0 when the sealed DirectPlan carried no deposit line
      // (the bridge files the deductible deposit as its own money fact, separate from the plan). This keeps the
      // tray honest — the buyer's own money, not a zeroed snapshot. Falls back to the doc snapshot when no deposit.
      const depositUsd =
        dep && (dep.currency === "USD" || !dep.currency) ? Math.round(dep.amountMinor / 100) : doc.depositUsd;

      let status: PurchaseStatus;
      if (doc.vrxApprovedAt) status = "ratified";
      else if (depositPaid) status = "deposit_paid";
      else if (win.state === "open") status = "confirmed";
      else if (win.state === "lapsed") status = "window_lapsed";
      else status = "reserved";

      // The draft S&P is only real once the offer is materialized (the requestId resolves to a direct offer). We
      // surface the requestId only when the draft is both PAID-FOR and materialized, so the tray link never 404s.
      let spRequestId: string | null = null;
      if (depositPaid) {
        const offer = await getOffer(doc.requestId);
        if (offer && isDirectOffer(offer)) spRequestId = doc.requestId;
      }

      return {
        conversationId: doc.conversationId,
        building: doc.building,
        unit: doc.unit,
        priceUsd: doc.priceUsd,
        depositUsd,
        status,
        revision: doc.revision,
        proposedSigningAt: doc.proposedSigningAt,
        vrxApprovedAt: doc.vrxApprovedAt ?? null,
        confirmedAt: doc.confirmedAt ?? null,
        depositDueAt: doc.depositDueAt ?? null,
        depositWindowMsLeft: win.state === "open" ? win.msLeft : 0,
        depositPaidVrx: dep?.paidVrx?.amountVrx ?? null,
        // ESCROW CUSTODY (Slice 2) — present only when the deposit is actually in escrow custody (flag ON).
        // The tray reads `custodyState` to show an "in escrow" note + the live VETO control while the developer's
        // release request is pending (release_pending) and the buyer's veto window is still open (vetoMsLeft > 0).
        // null when the deposit never entered custody (the direct-to-dev path / legacy / unpaid) — the tray then
        // renders exactly as before (escrow is a transparent add-on; funded = paid either way).
        custodyState: dep && dep.custody && dep.custody.state !== "none" ? custodyStateOf(dep) : null,
        vetoMsLeft: dep ? vetoMsLeft(dep, now) : 0,
        // OTS DURABILITY (D-) — the Bitcoin-anchor status of this deal's deposit evidence pack(s). The
        // LATEST anchor's status + label (pending = "sealed, Bitcoin confirmation pending" — a NORMAL hours-long
        // state, NEVER a blocker; proven = "Bitcoin-anchored"). null when no evidence pack was ever emitted (no
        // custody transition / direct-to-dev path). A read-only durability badge: the in-system record is already
        // final; this shows the ADDED Bitcoin assurance landing. One read per row (read surface, not the pay path).
        evidenceAnchor: await (async () => {
          const packs = await depositEvidenceForDeal(account, doc.building, doc.unit);
          const latest = packs[0]; // anchorsForRef returns newest-first
          return latest ? { status: latest.status, label: latest.label, count: packs.length } : null;
        })(),
        // The DRAFT (provisional, digitally sealed) S&P — only when paid-for + materialized (else null).
        spRequestId,
        at: doc.at,
        updatedAt: doc.updatedAt,
      };
    })
  );

  return NextResponse.json({ purchases: rows });
}
