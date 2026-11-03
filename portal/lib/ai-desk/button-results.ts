// button-results.ts — the BUYER-FACING formatters for the read-only action buttons (Slice 2 of the
// payment-UX cluster, the design docs §4). PURE, SERVER-ONLY.
//
// When the buyer taps a READ chip — [ View terms ] or [ Show similar ] — /api/desk-action runs the SAME
// executor the AI tool loop runs (buildingTerms / findUnits), then posts the result back into the thread as a
// desk message. These helpers turn the executor's DATA into the clean buyer-facing text the desk posts:
//   • realTermsToRows  → a TermsRow[] rendered via the SHARED formatTermsTable (the SAME aligned block the
//  desk's own `terms` action renders) — one source of truth for "how a terms table looks".
//   • formatSimilarUnits → a compact numbered list of the top matches findUnits returned.
//
// WHY buyer-facing (not the model-facing `formatTerms` in tool-loop.ts): that one is prose for the MODEL to read
// back; these go straight to the BUYER, so they obey the buyer-facing invariants directly — the DEDUCTIBLE
// DEPOSIT is named, and the VRX/developer-side flat fees (reservationFee/bookingFee) are NEVER shown (
// [[vrx-deposit-is-deductible-not-a-fee]]). No acceptable-ranges line either (that's a negotiation affordance
// for the desk's reasoning, not a buyer quote).

import type { RealTerms, UnitSummary } from "./query-tools";
import type { TermsRow } from "./types";
import type { ReservationDocument } from "./reservation-document";
import { DEPOSIT_WINDOW_MS } from "./reservation-document";

/** The buyer-facing payment-terms rows (shape). ONLY buyer-visible lines — the deductible deposit, the
 *  payment milestones, completion. The flat reservationFee/bookingFee are developer/VRX-side economics and are
 * deliberately omitted (the desk never quotes a flat "fee" to the buyer). Returns [] when nothing
 *  published, so the caller can post an honest "no published terms" line instead of an empty table. */
export function realTermsToRows(t: RealTerms): TermsRow[] {
  const rows: TermsRow[] = [];
  if (t.depositPctOptions?.length) {
    rows.push({ label: "Deposit", value: `${t.depositPctOptions.join("% / ")}% of price (deductible)` });
  }
  if (typeof t.contractDays === "number") {
    rows.push({ label: "S&P signed", value: `within ${t.contractDays} days of reserving` });
  }
  if (t.instalmentPlan?.onContract?.length) {
    rows.push({ label: "On contract", value: t.instalmentPlan.onContract.map((i) => `${i.installments}×${i.amountPct}%`).join(" + ") });
  }
  if (t.instalmentPlan?.ongoing?.length) {
    rows.push({ label: "Instalments", value: t.instalmentPlan.ongoing.map((i) => `${i.installments}×${i.amountPct}%`).join(" + ") });
  }
  if (t.onKeyPctOptions?.length) {
    rows.push({ label: "On handover", value: `${t.onKeyPctOptions.join("% / ")}%` });
  }
  if (typeof t.furniturePerSqmUsd === "number" && t.furniturePerSqmUsd > 0) {
    rows.push({ label: "Furniture pack", value: `$${t.furniturePerSqmUsd}/m²` });
  }
  if (t.taxPctOptions?.length) {
    rows.push({ label: "Tax", value: `${t.taxPctOptions.join("% / ")}%` });
  }
  if (t.transferFeePct) {
    rows.push({ label: "Transfer fee", value: t.transferFeePct });
  }
  if (t.completion) {
    rows.push({ label: "Completion", value: t.completion });
  }
  return rows;
}

/** A compact, numbered summary of the units findUnits returned — the buyer-facing [ Show similar ] result. Shows
 *  the identity + the public facts the buyer already sees on a card (type, floor, size, price). `matchCount` lets
 *  the lead line be honest about how many matched beyond the few shown. Empty list ⇒ a plain "nothing matched"
 *  line (never a confident fabrication). PURE — no I/O, no PII (public facts only). */
export function formatSimilarUnits(units: UnitSummary[], matchCount: number): string {
  if (!units.length) {
    return "I don't have other on-market units that match right now.";
  }
  const lines = units.map((u, i) => {
    const bits = [u.typeLabel, `floor ${u.floor}`, `${u.sqm} m²`];
    if (u.view) bits.push(u.view);
    const price = u.priceUsd > 0 ? ` — $${u.priceUsd.toLocaleString()}` : "";
    return `${i + 1}. ${u.id} · ${bits.join(" · ")}${price}`;
  });
  const more = matchCount > units.length ? `\n(+${matchCount - units.length} more match — ask me to narrow by budget or size.)` : "";
  const lead = matchCount === 1 ? "One other unit matches:" : `${matchCount} units match — here ${units.length === 1 ? "is the closest" : `are the top ${units.length}`}:`;
  return `${lead}\n${lines.join("\n")}${more}`;
}

/** The buyer-facing summary of a RESERVATION DOCUMENT (Slice 3b-i, §0b) — the paid-on-hold "contract
 *  preview". Shows the unit, price, the DEDUCTIBLE deposit, the payment schedule, the PROPOSED signing date
 * (+ whether VRX has approved it), and the revision number (the operator catalog's revision model). PURE — no PII (the buyer's
 *  identity is never printed here; the S&P resolves the live mask). Buyer-facing invariant: "Deposit" is the
 *  deductible, never a VRX fee ([[vrx-deposit-is-deductible-not-a-fee]]). The date is rendered as a UTC calendar
 *  day (deterministic — no server-zone drift). */
export function formatReservationDocument(doc: ReservationDocument): string {
  const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`Reservation document · ${doc.unit} (rev ${doc.revision})`);
  lines.push(`Price: ${usd(doc.priceUsd)}  ·  Deposit (deductible): ${usd(doc.depositUsd)}`);
  if (doc.schedule.length) {
    lines.push("Payment schedule:");
    for (const r of doc.schedule) lines.push(`  • ${r.label}: ${usd(r.amountUsd)}`);
  }
  const approved = doc.vrxApprovedAt ? " (VRX-approved)" : " (pending VRX approval)";
  lines.push(`Proposed signing date: ${day(doc.proposedSigningAt)}${approved}`);
  lines.push("This is a contract preview — not yet the signed Sale & Purchase agreement.");
  return lines.join("\n");
}

/** The buyer-facing CONFIRMATION message (Slice 3b-ii, §4). Confirming carries no money itself — it opens
 *  the 2-hour window to pay the deposit, measured from the buyer's tap. We state the deadline plainly so the
 *  buyer knows exactly how long they have (removes the "time to think vs 2 hours" ambiguity). PURE. */
export function formatReservationConfirmed(doc: ReservationDocument): string {
  const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const hrs = Math.round(DEPOSIT_WINDOW_MS / (60 * 60 * 1000));
  const due = doc.depositDueAt ? new Date(doc.depositDueAt).toISOString().slice(11, 16) + " UTC" : "";
  return [
    `Reservation confirmed · ${doc.unit}.`,
    `You now have ${hrs} hours to pay the ${usd(doc.depositUsd)} deductible deposit to hold ${doc.unit}${due ? ` (by ${due})` : ""}.`,
    "Tap [ Pay deposit ] to complete the hold — until then the unit stays open to others.",
  ].join("\n");
}

/** The buyer-facing RESERVE-CONFIRMATION message (the "desk tells the buyer WHEN + HOW to pay" +
 * "desk is balance-aware" items of the payment-UX cluster). PURE, SERVER-ONLY.
 *
 *  Posted into the thread the moment a Reserve chip fires a real hold (the only commit that previously posted
 *  NOTHING back — every other chip speaks for itself). It makes the desk transparent + proactive about the two
 *  things the buyer needs next: (1) the hold WINDOW — how long the unit is held for them before it auto-releases;
 *  (2) WHAT to pay to lock it (the deductible deposit) and HOW (the inline [ Pay deposit ] step, after reading
 *  the S&P), stated with the buyer's own COVERAGE (balance vs deposit) so an underfunded buyer learns it HERE,
 *  not at the pay tap (the proactive half of balance-awareness).
 *
 *  Honesty invariants held: "Deposit" is the DEDUCTIBLE reservation deposit, never a flat VRX/developer fee
 * ([[vrx-deposit-is-deductible-not-a-fee]]); coverage names only the buyer's OWN balance (no PII, no
 *  other party's figure); the ordering rule (read the S&P before paying) is stated, matching the server gate.
 *  The window is rendered from `releaseAtMs` relative to `nowMs` (passed in, so the formatter stays PURE +
 *  deterministic for the drive). A deposit of 0 / unknown balance degrades to the window + pay-step without a
 *  fabricated figure. */
export function formatReserveConfirmed(args: {
  unit: string;
  depositUsd: number;
  balanceVrx: number | null;
  releaseAtMs: number;
  nowMs: number;
}): string {
  const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const { unit, depositUsd, balanceVrx, releaseAtMs, nowMs } = args;

  const lines: string[] = [`✓ ${unit} is held for you.`];

  // (1) THE WINDOW — how long the hold lasts before it auto-releases. Round to whole hours (the hold windows are
  // hour-scale); a sub-hour remainder reads as "under an hour" rather than a confusing "0 hours".
  const msLeft = releaseAtMs - nowMs;
  if (msLeft > 0) {
    const hours = msLeft / (60 * 60 * 1000);
    const windowLabel =
      hours >= 1 ? `about ${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}` : "under an hour";
    lines.push(`This hold lasts ${windowLabel} — after that the unit auto-releases and is open to others again.`);
  } else {
    lines.push("The hold is active now — complete the deposit soon so the unit stays yours.");
  }

  // (2) WHAT + HOW to pay, with the buyer's own coverage. The deposit is the deductible reservation deposit.
  if (depositUsd > 0) {
    lines.push(`To lock it, pay the ${usd(depositUsd)} deductible reservation deposit (it comes off the price).`);
    if (typeof balanceVrx === "number") {
      lines.push(
        balanceVrx >= depositUsd
          ? `Your wallet has ${usd(balanceVrx)} $VRX — enough to cover it.`
          : `Your wallet has ${usd(balanceVrx)} $VRX — ${usd(depositUsd - balanceVrx)} short; claim or top up before you pay.`
      );
    }
    lines.push("Read the Sale & Purchase agreement first, then tap [ Pay deposit ] — your deposit goes to the developer.");
  } else {
    lines.push("Read the Sale & Purchase agreement, then tap [ Pay deposit ] to lock the unit — the desk will confirm the amount.");
  }

  return lines.join("\n");
}

/** The buyer-facing SIGNING-DATE message (Slice 3b-iii, §0b). Used when a date is proposed or approved.
 *  States the agreed/proposed date + the approval status in plain words. The real hard rule is ordering (ratify
 *  before the Land Office), so we remind that the signed contract follows. PURE — renders a UTC calendar day. */
export function formatSigningDate(doc: ReservationDocument, kind: "proposed" | "approved"): string {
  const day = new Date(doc.proposedSigningAt).toISOString().slice(0, 10);
  if (kind === "approved") {
    return [
      `Signing date approved by VRX: ${day}.`,
      "This is the date to ratify the Sale & Purchase agreement; the Land Office handover follows after ratification.",
    ].join("\n");
  }
  return [
    `Proposed signing date: ${day} (pending VRX approval).`,
    "Either side can counter with a workable date; once it matches, VRX approves it.",
  ].join("\n");
}
