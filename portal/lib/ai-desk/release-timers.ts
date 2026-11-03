// AI Sales Director — the AUTO-RELEASE TIMERS (slice 7, the design docs §6, D-).
// SERVER-ONLY. The mandatory safety net for autonomous holds: because canOpenUnit is ON (the AI can take a unit
// off-market itself), a stalled hold MUST self-free. This is that evaluator. Same discipline as
// lib/standing-scheduler.ts: a PURE ON-DEMAND function of (the live holds + sidecars, asOf) + an idempotency
// anchor — NOT a background timer (a Next portal has no cron; a real timer slots in FRONT of this pure fn later,
// per the rule).
//
// ── The escalation ladder (§6) ──────────────────────────────────────────────────────────────────────────
//   L1  — a fresh hold auto-releases 2h after it was placed if the deal makes no progress (the signing seam
//          stamps the first releaseAt = heldAt + 2h; see signing-seam.L1_HOLD_MS).
//   L2  — at L1 expiry we EXTEND once to the next working day (same time), rather than releasing immediately —
//          "give the customer until tomorrow." (The design's "+2h if the hold was made early" nuance is folded
//          into next-working-day: an early hold still gets a full business day.)
//   final — at L2 expiry we WARN the customer once ("I'll release this unit today unless we take a deposit"),
//          then on the NEXT evaluation past the warn+grace we RELEASE (signReleaseExclusive). Warn-once is
//          idempotent via the sidecar's releaseWarned flag.
// The sidecar's own releaseLevel/releaseWarned/releaseAt fields ARE the idempotency state (D- — the sidecar
// is the AI's working memory). No separate notices ledger (unlike standing-scheduler): one hold, one sidecar,
// its level field is the dedup key.
//
// PRIVACY: server-only; the customer WARN copy is plain words (no price/terms/PII), posted by the act
// layer into the deal thread. This module decides + effects the hold state; the act layer posts the warn message.

import { signReleaseExclusive } from "./signing-seam";
import { expiredActiveHolds, activeHoldForDeal, placeHold, type SoftHold } from "./unit-holds";
import { getSidecar, upsertSidecar, clearHold, type ReleaseLevel } from "./deal-sidecar";

/** The L2 extension: from an expired L1, extend to the next working day at the same wall-clock time. Exported
 *  for the test. PURE. Saturday/Sunday roll forward to Monday. (Demo-grade: no holiday calendar — a working-day
 *  approximation is honest for the purpose, which is "don't release over a weekend without a business day.") */
export function nextWorkingDay(fromMs: number): number {
  const d = new Date(fromMs);
  d.setDate(d.getDate() + 1); // at least tomorrow
  // Roll Saturday(6)/Sunday(0) forward to Monday.
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The grace after the final WARN before the unit is actually released — the customer gets the rest of the day.
 *  Exported so the test + a future config can share it. */
export const FINAL_WARN_GRACE_MS = 24 * 60 * 60 * 1000; // 1 day after the warn

/** What the evaluator decided for ONE hold. `extend`/`warn`/`release` are the effectful outcomes; `hold` = still
 *  within its window, nothing to do (not past releaseAt yet — it won't even be a candidate). */
export type ReleaseAction =
  | { kind: "extend"; dealId: string; unitId: string; toLevel: "l2"; newReleaseAt: number }
  | { kind: "warn"; dealId: string; unitId: string; newReleaseAt: number }
  | { kind: "release"; dealId: string; unitId: string; reason: string }
  | { kind: "none"; dealId: string };

/**
 * PURE CORE — decide what a single expired hold needs, given its current release level + whether the customer
 * was already warned + asOf. Split out (like leftAvailableFromRows) so the ladder logic is unit-testable with
 * injected values, no fs. The caller passes the hold's level/warned from the sidecar (or defaults for a legacy
 * hold with no sidecar level — treat as L1).
 *
 * Ladder: L1-expired → EXTEND to L2 (next working day). L2-expired, not yet warned → WARN (+grace day). L2/final
 * expired AND already warned AND past the grace → RELEASE. Anything else → none (shouldn't happen for a candidate,
 * but fail-safe to no-op rather than an errant release).
 */
export function decideRelease(
  hold: Pick<SoftHold, "dealId" | "unitId" | "releaseAt">,
  level: ReleaseLevel,
  warned: boolean,
  asOf: number
): ReleaseAction {
  if (hold.releaseAt > asOf) return { kind: "none", dealId: hold.dealId }; // not actually expired

  const lvl = level ?? "l1"; // a hold with no recorded level is treated as fresh (L1)

  if (lvl === "l1") {
    return { kind: "extend", dealId: hold.dealId, unitId: hold.unitId, toLevel: "l2", newReleaseAt: nextWorkingDay(asOf) };
  }

  // L2 (or a null/legacy level that already passed L1): first expiry → warn once; later expiry → release.
  if (!warned) {
    return { kind: "warn", dealId: hold.dealId, unitId: hold.unitId, newReleaseAt: asOf + FINAL_WARN_GRACE_MS };
  }

  // Already warned → release once past the warn's grace window (hold.releaseAt was set to warn-time + grace).
  return { kind: "release", dealId: hold.dealId, unitId: hold.unitId, reason: "expired-final" };
}

/** One hold's processed outcome, for the report/tests. */
export type ReleaseOutcome = { dealId: string; unitId: string; action: ReleaseAction["kind"]; newReleaseAt?: number };

export type ReleaseReport = {
  asOf: number;
  /** Per-hold outcome. */
  outcomes: ReleaseOutcome[];
  /** The WARN messages to POST (the act layer sends them into each deal thread — this module doesn't touch
   *  channels, so the caller fans these out). dealId + a plain-words line. */
  warnings: { dealId: string; unitId: string; text: string }[];
  releasedCount: number;
  extendedCount: number;
};

/** The plain-words customer warning (no price/terms/PII). Exported so the act layer + tests share the copy. */
export function finalWarnCopy(): string {
  return "A quick heads-up: I'm holding this unit for you, but I'll need to release it back to the market later today unless we're able to take your reservation deposit. Let me know if you'd like to go ahead and I'll keep it secured.";
}

/**
 * Evaluate + effect auto-release across ALL expired active holds (PURE-DRIVEN + idempotent via each deal's
 * sidecar level/warned flags). For each expired hold:
 *   extend  → advance the hold's window to L2 (next working day) + set the sidecar level "l2";
 *   warn    → advance the window by the grace day + set sidecar releaseWarned (the act layer posts finalWarnCopy);
 *   release → signReleaseExclusive(reason) + clear the sidecar's hold fields.
 * Re-running with the same asOf is a no-op after the first pass (a warned/extended hold's new releaseAt is now
 * in the future, so it's no longer a candidate). `asOf` is injectable for tests/replay.
 *
 * NB extend/warn re-stamp the hold's releaseAt by PLACING the hold again at the new window (placeHold supersedes
 * the same deal's prior active hold and re-seals with the new window) — keeping the holds store the single source
 * of the live window. We re-import placeHold here to avoid a cycle at module top.
 */
export async function advanceHoldReleases(opts?: { asOf?: number }): Promise<ReleaseReport> {
  const asOf = opts?.asOf ?? Date.now();

  const candidates = await expiredActiveHolds(asOf);
  const outcomes: ReleaseOutcome[] = [];
  const warnings: ReleaseReport["warnings"] = [];
  let releasedCount = 0;
  let extendedCount = 0;

  for (const hold of candidates) {
    const sidecar = await getSidecar(hold.dealId);
    const level: ReleaseLevel = sidecar?.releaseLevel ?? "l1";
    const warned = !!sidecar?.releaseWarned;
    const action = decideRelease(hold, level, warned, asOf);

    if (action.kind === "extend") {
      await placeHold({ dealId: hold.dealId, desk: hold.desk, buildingId: hold.buildingId, unitId: hold.unitId, heldAt: hold.heldAt, releaseAt: action.newReleaseAt });
      if (sidecar) await upsertSidecar(hold.dealId, hold.buildingId, sidecar.counterparty, { releaseLevel: "l2", releaseAt: action.newReleaseAt });
      extendedCount++;
      outcomes.push({ dealId: hold.dealId, unitId: hold.unitId, action: "extend", newReleaseAt: action.newReleaseAt });
    } else if (action.kind === "warn") {
      await placeHold({ dealId: hold.dealId, desk: hold.desk, buildingId: hold.buildingId, unitId: hold.unitId, heldAt: hold.heldAt, releaseAt: action.newReleaseAt });
      if (sidecar) await upsertSidecar(hold.dealId, hold.buildingId, sidecar.counterparty, { releaseLevel: "final", releaseWarned: true, releaseAt: action.newReleaseAt });
      warnings.push({ dealId: hold.dealId, unitId: hold.unitId, text: finalWarnCopy() });
      outcomes.push({ dealId: hold.dealId, unitId: hold.unitId, action: "warn", newReleaseAt: action.newReleaseAt });
    } else if (action.kind === "release") {
      await signReleaseExclusive(hold.dealId, hold.desk, action.reason);
      if (sidecar) await clearHold(hold.dealId);
      releasedCount++;
      outcomes.push({ dealId: hold.dealId, unitId: hold.unitId, action: "release" });
    } else {
      outcomes.push({ dealId: hold.dealId, unitId: hold.unitId, action: "none" });
    }
  }

  return { asOf, outcomes, warnings, releasedCount, extendedCount };
}

/** Convenience read for a surface/test: the live release state of one deal's hold (level + when it frees). */
export async function releaseStateForDeal(dealId: string): Promise<{ unitId: string; releaseAt: number; level: ReleaseLevel; warned: boolean } | null> {
  const hold = await activeHoldForDeal(dealId);
  if (!hold) return null;
  const sidecar = await getSidecar(dealId);
  return { unitId: hold.unitId, releaseAt: hold.releaseAt, level: sidecar?.releaseLevel ?? "l1", warned: !!sidecar?.releaseWarned };
}
