// OFFER EVALUATION — the pure guard behind the "real deal order": the buyer COMPOSES a payment
// plan (components/PaymentCalculator → AssembledPlan) and the desk/AI must decide whether to AUTO-AGREE (the
// offer sits inside the developer's published caps) or route it to NEGOTIATION (an off-standard ask — e.g. a
// deposit below the floor, or a longer instalment run than the developer allows).
//
// WHY A PURE FUNCTION (isomorphic): the SAME verdict must be reachable in three places without a
// network hop — (1) the buyer's review overlay (live "✓ within terms" / "⚠ ask the desk" as they drag the
// sliders), (2) the AI-desk decide loop (when a buyer asks in chat for off-standard terms, the model needs a
// factual "is {deposit,instalments,onKey} within caps?" answer, not a guess), (3) the server at seal time
// (never materialize an offer whose composed plan is out of range without an explicit desk concession). No
// money, no PII, no chain — just percentages vs the developer's own published ranges. So it lives in a tiny
// dependency-free module both the client bundle and the server can import.
//
// NUMBERS (doc-alongside): caps are PERCENTAGES of the unit price (catalog-client.PaymentTerms.caps). The
// AssembledPlan carries USD figures + the price, so we convert each milestone back to a % of price and compare.
// A small tolerance (EPS_PCT) absorbs the calculator's rounding (it works in whole USD) so a slider parked
// exactly on a cap doesn't read as "0.0001% over". Instalment COUNT is an integer compared directly. When the
// developer didn't publish a cap for a milestone, that milestone can't be "outside" (no range to violate).

import type { AssembledPlan } from "@/components/PaymentCalculator";
import type { PaymentTerms } from "@/lib/catalog-client";

/** Rounding slack (percentage points) so a plan parked on a cap boundary isn't flagged as a hair outside it.
 *  The calculator allocates in whole USD; on a cheap unit one dollar can be a few hundredths of a percent. */
const EPS_PCT = 0.05;

/** One milestone that fell outside the developer's published range — carried so the UI/AI can say WHICH ask is
 *  off-standard and by how much ("deposit 5% is below the 10% minimum"), not just a bare "outside terms". */
export type OfferBreach = {
  field: "deposit" | "onContract" | "onKey" | "instalments";
  label: string;
  /** The composed value: a PERCENT for the milestone rows, a COUNT for instalments. */
  value: number;
  min?: number;
  max?: number;
  /** "pct" → value/min/max are percentages; "count" → whole instalment counts. */
  unit: "pct" | "count";
};

export type OfferVerdict = {
  /** true → every composed milestone sits inside the developer's caps; the desk/AI can auto-agree. */
  withinCaps: boolean;
  /** The specific off-standard milestones (empty when withinCaps). Drives the "ask the desk" copy. */
  breaches: OfferBreach[];
  /** A one-line human summary — "within the developer's terms" or "deposit below the 10% minimum, …". */
  summary: string;
};

const pctOf = (usd: number, price: number) => (price > 0 ? (usd / price) * 100 : 0);
const trim = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/**
 * Evaluate a composed payment plan against the developer's published caps. PURE — same inputs, same verdict.
 *
 * A milestone is a BREACH only when the developer PUBLISHED a bound and the composed value crosses it (beyond
 * the rounding tolerance). An absent cap means "the developer set no range here" → never a breach. Instalments
 * are compared as whole counts against caps.instalmentsMin/Max. `onContract` is checked too (it has caps) even
 * though the overlay calculator seeds it from the dev's first option — a buyer can still move it.
 *
 * NOTE: because the PaymentCalculator's sliders are already bound to these same caps (decision: the widget
 * clamps, off-standard asks go to chat), a plan composed THROUGH that widget is within-caps by construction and
 * this returns withinCaps:true. The guard still matters for (a) the AI-desk path where a buyer ASKS in free text
 * for off-standard terms, and (b) the server seal-time check — neither of which is clamped by a UI slider.
 */
export function evaluateOffer(plan: AssembledPlan, terms: PaymentTerms | null | undefined): OfferVerdict {
  const caps = terms?.caps ?? {};
  const price = plan.priceUsd;
  const breaches: OfferBreach[] = [];

  const checkPct = (
    field: OfferBreach["field"],
    label: string,
    usd: number,
    min?: number,
    max?: number
  ) => {
    const v = pctOf(usd, price);
    if (min != null && v < min - EPS_PCT) breaches.push({ field, label, value: v, min, max, unit: "pct" });
    else if (max != null && v > max + EPS_PCT) breaches.push({ field, label, value: v, min, max, unit: "pct" });
  };

  checkPct("deposit", "Deposit", plan.depositUsd, caps.depositPctMin, caps.depositPctMax);
  checkPct("onContract", "On contract", plan.onContractUsd, caps.onContractPctMin, caps.onContractPctMax);
  checkPct("onKey", "On transfer", plan.onKeyUsd, caps.onKeyPctMin, caps.onKeyPctMax);

  // Instalment COUNT (integer) vs the published min/max.
  const n = plan.instalmentCount;
  if (caps.instalmentsMin != null && n < caps.instalmentsMin)
    breaches.push({ field: "instalments", label: "Instalments", value: n, min: caps.instalmentsMin, max: caps.instalmentsMax, unit: "count" });
  else if (caps.instalmentsMax != null && n > caps.instalmentsMax)
    breaches.push({ field: "instalments", label: "Instalments", value: n, min: caps.instalmentsMin, max: caps.instalmentsMax, unit: "count" });

  const withinCaps = breaches.length === 0;
  const summary = withinCaps
    ? "Within the developer's published terms."
    : breaches.map((b) => breachPhrase(b)).join("; ") + ".";
  return { withinCaps, breaches, summary };
}

/** A human phrase for one breach — "deposit 5% is below the 10% minimum" / "12 instalments exceeds the max of 6". */
export function breachPhrase(b: OfferBreach): string {
  if (b.unit === "count") {
    if (b.min != null && b.value < b.min) return `${b.value} ${b.label.toLowerCase()} is below the minimum of ${b.min}`;
    return `${b.value} ${b.label.toLowerCase()} exceeds the maximum of ${b.max}`;
  }
  const v = `${trim(b.value)}%`;
  if (b.min != null && b.value < b.min) return `${b.label.toLowerCase()} ${v} is below the ${trim(b.min)}% minimum`;
  return `${b.label.toLowerCase()} ${v} is above the ${trim(b.max!)}% maximum`;
}
