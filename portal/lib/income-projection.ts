// DEVELOPER PROJECTED-INCOME — the per-building cashflow-vs-plan bucketer. SERVER-ONLY, PURE.
// the design docs. Contract stays FROZEN — all off-chain. This is the pure aggregation
// the /api/payments?projection=1 branch is thin glue over (same split as payment-ledger ↔ /api/payments):
// the route loads each developer deal's sealed plan + payments + termination overlay, then hands the pure
// facts here; this module buckets them into per-building Expected / Received / Behind cumulative series +
// an always-on per-deal table. No I/O, no store, no clock leak (asOf injectable) — unit-testable in isolation.
//
// ── What "income" means here (LOCKED) ───────────────────────────────────────────────────────
// GROSS BUYER RECEIPTS only — the buyer→developer payment schedule and the actual money logged against it.
// NOT net of agency commission or the VRX protocol fee. Those are ONE number on the settlement console; this
// surface never nets them in (two surfaces must never disagree on a figure). So this is cashflow-into-the-
// project, not developer take-home — the UI must not imply otherwise (the component's footer says "indicative
// projection, per each signed agreement"; no "profit"/"net" wording).
//
// ── The four HONESTY GUARDS (the WHY — "projected income" is a forward-looking financial CLAIM) ───────────
//  1. EXPECTED ≠ promised cash. A TERMINAL deal is EXCLUDED from the curves and counted in `closedCount`
//     (a refunded deal is money OUT; we don't pretend it's still coming). A `*_default_served` deal is
//     segregated into `atRiskCount` and ALSO excluded from the healthy curves (its money is contested, not
//     plan-track). Only LIVE deals feed the curves. The caller resolves each deal's `status` from
//     termination-store `overlayFor`; this module trusts that verdict (see classifyDealStatus below).
//  2. "BEHIND" is a schedule flag, NOT a legal verdict. `behindCum = max(0, expectedCum − receivedCum)` — the
//     cumulative plan-vs-actual gap. The component labels it "behind schedule", NEVER "in default". Default
//     eligibility stays on the existing /api/payments?ledger=1 advisory path, untouched.
//  3. UNDATED lines are never forced onto the time axis. deriveSchedule returns lines with NO `dueAt` when the
//     plan states no timing (up-front deposit/on-signing legs, on-key handover, milestone-tied instalments).
//     We do NOT guess a month — their Expected amount is summed into `undatedExpectedUsd` (shown as a caption,
//  off the curve), never bucketed onto a fabricated month (the operator catalog's 2049-01 sentinel is exactly that guess).
//  4. TWO time axes, labelled honestly. EXPECTED buckets by `dueAt` month (the plan); RECEIVED buckets by
//     `paidAt` month (actual money in). The component's legend says so; it reads as cashflow-vs-plan, the same
//  lens the operator catalog's overallreport uses.
//
// ── The `cured` subtlety (a real seam contradiction — flagged, not papered over) ─────────────────────────
// lib/termination.isTerminal returns TRUE for `cured`, and the overlay PERSISTS as `cured` after a cure
// (the TABLE sets record_cure → to:"cured"; the code comment saying it "returns to none" is stale vs the
// TABLE). But the intent (plan §guard 1) is that a cured deal RESUMED and is live income again. So we do
// NOT reuse isTerminal here — we classify EXPLICITLY: terminated_* → closed, *_default_served → at_risk,
// and `none`/`cured` → live (counted in the curves). Documented so a future reader sees the divergence is
// deliberate, not an oversight. (If the overlay machine is ever fixed to land `cured`→`none`, this still holds.)
//
// PRIVACY: pure + server-only. Produces the developer's OWN cashflow figures for their OWN deals — never
// leaks to a non-party surface, nothing on-chain. Survives a future V7 contract defrost unchanged (off-chain).

import type { SalePlan } from "./sale-contract";
import type { TerminationState } from "./termination";
import { deriveSchedule } from "./payment-ledger";

/** A deal's liveness for the projection, derived from its termination overlay state (see classifyDealStatus).
 *  `live` feeds the curves; `at_risk` + `closed` are segregated counts, OFF the curves (honesty guard 1). */
export type DealStatus = "live" | "at_risk" | "closed";

/**
 * Map a termination overlay state to its projection status. EXPLICIT (not isTerminal) — see the header note on
 * the `cured` seam: `cured` is treated as LIVE (resumed), terminal `terminated_*` as closed, served notices as
 * at-risk. An unknown/future state defaults to `live` (fail-open to "still counts" — we never silently drop a
 * healthy deal's expected income because of an unrecognised state; a wrongly-included contested deal is at
 * worst visible, a wrongly-excluded live one is invisible money the developer is owed).
 */
export function classifyDealStatus(state: TerminationState): DealStatus {
  switch (state) {
    case "terminated_retained":
    case "terminated_refunded":
      return "closed";
    case "buyer_default_served":
    case "seller_default_served":
      return "at_risk";
    case "none":
    case "cured":
    default:
      return "live";
  }
}

/** The pure per-deal input the bucketer consumes. The route resolves these from offers + payment-vault +
 *  termination-store; the module itself does no I/O. `payments` are the GROSS buyer receipts logged for the
 *  deal (ALL logged — confirmedOnly=false — the developer's own books, same basis as the per-deal ledger view). */
export type DealInput = {
  requestId: string;
  buildingId: string;
  buildingName: string;
  /** A human unit label for the table row (e.g. "Marina Heights · 312"), resolved by the caller. */
  unitLabel: string;
  /** The sealed SalePlan (offer.seal.plan), or null if the deal has no sealed plan yet. */
  plan: SalePlan | null;
  /** The stable booking moment (offer.at) — seeds dated instalment lines. (c): anchored to offer.at,
   *  NOT confirmed?.at, so a deal's projected dates don't shift forward when it closes. */
  bookingAt: number;
  /** The deal's termination state (termination-store overlayFor → overlay.state). */
  terminationState: TerminationState;
  /** The gross buyer receipts logged for this deal: { amountUsd, paidAt(ms) }. */
  payments: Array<{ amountUsd: number; paidAt: number }>;
};

/** One row of the always-on per-deal table under the chart. */
export type DealRow = {
  requestId: string;
  unitLabel: string;
  expectedTotalUsd: number;
  receivedTotalUsd: number;
  status: DealStatus;
  /** The `YYYY-MM` months this deal has a DATED expected line in — so clicking a month highlights its rows. */
  monthsWithExpected: string[];
};

/** One point on a building's monthly axis — cumulative Expected / Received, and the derived Behind gap. */
export type MonthPoint = {
  /** `YYYY-MM`. */
  month: string;
  expectedCum: number;
  receivedCum: number;
  /** max(0, expectedCum − receivedCum) — the cumulative plan-vs-actual gap ("behind schedule", NOT default). */
  behindCum: number;
};

/** The projection for ONE building: its monthly curves, its deal table, and the off-curve honesty figures. */
export type BuildingProjection = {
  buildingId: string;
  buildingName: string;
  months: MonthPoint[];
  deals: DealRow[];
  /** Σ of EXPECTED amounts on UNDATED lines across the building's LIVE deals (off the curve — guard 3). */
  undatedExpectedUsd: number;
  /** Count of this building's deals currently in a served-default state (segregated — guard 1). */
  atRiskCount: number;
  /** Count of this building's TERMINAL (closed) deals (segregated — guard 1). */
  closedCount: number;
};

export type IncomeProjection = {
  buildings: BuildingProjection[];
};

/** `YYYY-MM` (UTC) for a ms epoch. UTC so the bucketing never shifts with the server's local zone — the same
 *  discipline as the payment-ledger working-day math. */
function monthKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Build the per-building projection from the resolved per-deal inputs. PURE. Groups deals by building, and
 * within a building:
 *   • LIVE deals feed the curves — their DATED expected lines bucket by `dueAt` month (Expected), their UNDATED
 *     expected lines sum into `undatedExpectedUsd` (off the curve), and their logged payments bucket by `paidAt`
 *     month (Received). Every live deal also produces a table row.
 *   • AT-RISK + CLOSED deals are COUNTED (atRiskCount / closedCount) and still produce a table row (so the
 *     developer sees them, labelled) but contribute NOTHING to the curves or the undated figure (guard 1).
 * The month axis is the sorted union of all Expected + Received months across the building's LIVE deals;
 * Expected/Received accumulate into cumulative series along it, and Behind = max(0, expectedCum − receivedCum).
 */
export function buildIncomeProjection(deals: DealInput[]): IncomeProjection {
  // Group by building, preserving first-seen name.
  const byBuilding = new Map<string, { name: string; deals: DealInput[] }>();
  for (const d of deals) {
    const g = byBuilding.get(d.buildingId) ?? { name: d.buildingName, deals: [] };
    g.deals.push(d);
    byBuilding.set(d.buildingId, g);
  }

  const buildings: BuildingProjection[] = [];
  for (const [buildingId, group] of byBuilding) {
    // Per-month accumulators for the LIVE deals only.
    const expectedByMonth = new Map<string, number>();
    const receivedByMonth = new Map<string, number>();
    let undatedExpectedUsd = 0;
    let atRiskCount = 0;
    let closedCount = 0;
    const rows: DealRow[] = [];

    for (const deal of group.deals) {
      const status = classifyDealStatus(deal.terminationState);
      const schedule = deriveSchedule(deal.plan, deal.bookingAt);

      // Per-deal table figures — computed for EVERY deal (live/at-risk/closed) so the row is honest, but only
      // LIVE deals' figures are folded into the building curves + undated total below.
      const expectedTotalUsd = schedule.reduce((s, l) => s + l.dueUsd, 0);
      const receivedTotalUsd = deal.payments.reduce((s, p) => s + Math.max(0, p.amountUsd), 0);
      const monthsWithExpected = Array.from(
        new Set(schedule.filter((l) => l.dueAt !== undefined).map((l) => monthKey(l.dueAt!)))
      ).sort();

      rows.push({
        requestId: deal.requestId,
        unitLabel: deal.unitLabel,
        expectedTotalUsd,
        receivedTotalUsd,
        status,
        monthsWithExpected,
      });

      if (status === "closed") {
        closedCount++;
        continue; // OFF the curves (guard 1)
      }
      if (status === "at_risk") {
        atRiskCount++;
        continue; // segregated, OFF the curves (guard 1)
      }

      // LIVE: feed the curves. Dated lines → Expected-by-dueAt-month; undated → the off-curve caption figure.
      for (const line of schedule) {
        if (line.dueAt !== undefined) {
          const k = monthKey(line.dueAt);
          expectedByMonth.set(k, (expectedByMonth.get(k) ?? 0) + line.dueUsd);
        } else {
          undatedExpectedUsd += line.dueUsd; // guard 3: never forced onto a month
        }
      }
      // Received → by paidAt month (guard 4). Negative/garbage amounts floored at 0, same as the total above.
      for (const p of deal.payments) {
        const amt = Math.max(0, p.amountUsd);
        if (amt <= 0) continue;
        const k = monthKey(p.paidAt);
        receivedByMonth.set(k, (receivedByMonth.get(k) ?? 0) + amt);
      }
    }

    // Month axis = sorted union of Expected + Received months (lexicographic on `YYYY-MM` == chronological).
    const axis = Array.from(new Set([...expectedByMonth.keys(), ...receivedByMonth.keys()])).sort();
    const months: MonthPoint[] = [];
    let expectedCum = 0;
    let receivedCum = 0;
    for (const month of axis) {
      expectedCum += expectedByMonth.get(month) ?? 0;
      receivedCum += receivedByMonth.get(month) ?? 0;
      months.push({
        month,
        expectedCum,
        receivedCum,
        behindCum: Math.max(0, expectedCum - receivedCum), // guard 2: a schedule gap, NOT a default verdict
      });
    }

    buildings.push({
      buildingId,
      buildingName: group.name,
      months,
      deals: rows,
      undatedExpectedUsd,
      atRiskCount,
      closedCount,
    });
  }

  // Stable order: by building name, then id, so the tab order is deterministic across reloads.
  buildings.sort((a, b) => a.buildingName.localeCompare(b.buildingName) || a.buildingId.localeCompare(b.buildingId));
  return { buildings };
}
