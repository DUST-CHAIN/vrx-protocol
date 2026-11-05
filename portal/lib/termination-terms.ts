// TERMINATION CLAUSE PARAMETERS — the pulled-out SURFACE for the §Default and Termination numbers.
//
// WHY THIS FILE EXISTS: the standard-SPA default figures (≥12.5% of price triggers a buyer
// default, 15% p.a. interest on arrears, the cure period) are REAL numbers from the real SPA — but they
// are NOT universal. They vary developer-to-developer and, more sharply, industry-to-industry (a residential
// off-plan SPA threshold is not a car dealer's, not a European builder's). So they MUST NOT be baked as
// literals into the clause PROSE. The clause renders them from named PARAMETERS; those parameters live here,
// on one surface, overridable — exactly the pattern lib/developers.ts already uses for the protocol fee and
// the VRX settlement window (`protocolFeePct`/`vrxSettleWorkingDays`). One source of truth, per-deal, with a
// real-SPA default so the arc stays honest without an explicit override.
//
// SCOPE (deliberately NOT the whole-app magic-number audit): this file pulls out the TERMINATION numbers only.
// The wider "find every baked-in number and give it a config surface" sweep is its own arc — seeded in
// the design docs §CONFIG-SURFACE so it isn't lost. Widening this slice to hunt them all would blow the slice.
//
// THE NUMBERS ARE THE DRAFT'S CLAUSE PARAMETERS, NOT VETTED LAW (honesty, same posture as VRX_DEVELOPER_TERMS
// v1-draft): the defaults below are paraphrased from the real SPA, not invented, but they are reviewable
// — a real per-developer / per-industry onboarding sets them, and the §Default-and-Termination clause that
// renders them carries a `v1-draft` marker. The machine (lib/termination.ts) still hard-codes NO legal number:
// the cure WINDOW is set per-notice by the serving operator (cureWindowMs, guard 3); `cureDays` here is only
// the clause's stated DEFAULT/FLOOR ("not less than N days"), the surface value the serving UI starts from.

/** The per-deal clause parameters the §Default and Termination section renders. Every figure is a number the
 *  clause states ("amounts totalling {defaultThresholdPct}% of the Price", "interest at {interestPctPerAnnum}%
 *  per annum", "not less than {cureDays} days") — never a literal embedded in a sentence. */
export type TerminationTerms = {
  /** Cl.14 — the share of the Price whose non-payment is a buyer default trigger. Real SPA = 12.5%. */
  defaultThresholdPct: number;
  /** The clause's stated default/MINIMUM cure period, in days. The ACTUAL window is set per-notice by the
   *  serving operator (lib/termination cureWindowMs); this is the floor the signed clause promises the buyer
 * ("not less than {cureDays} days") and the value the serving UI defaults to. choice. */
  cureDays: number;
  /** Cl.5.4 — the interest rate on arrears a Seller may charge on a buyer default. Real SPA = 15% p.a. */
  interestPctPerAnnum: number;
};

/** The DEFAULT termination terms — the real standard-SPA figures, used when no per-deal override is set.
 *  Paraphrased from the real SPA, NOT invented; reviewable as a draft clause parameter (see header). A real
 *  onboarding (per developer, per industry) overrides these; this keeps the clause honest without one. */
export const DEFAULT_TERMINATION_TERMS: TerminationTerms = {
  defaultThresholdPct: 12.5, // Cl.14 — amounts totalling ≥12.5% of the price unpaid = a default trigger.
  cureDays: 30, // the clause's stated minimum cure period; the real window is set per default-notice.
  interestPctPerAnnum: 15, // Cl.5.4 — 15% per annum on arrears.
};

/** A partial per-deal override of the termination terms — the shape a Developer record (or, later, a building
 *  / industry profile) may carry. Each field optional; a bad/absent value falls back to the default (never 0
 *  or NaN), mirroring developers.ts's resolver discipline. */
export type TerminationTermsOverride = Partial<TerminationTerms> | null | undefined;

function pct(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100 ? v : fallback;
}

function days(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * Resolve the effective termination terms for a deal — the override's values where valid, the real-SPA
 * defaults otherwise. Always returns finite, sane figures (a bad/absent/zero field never leaks through).
 * Takes a plain partial override so the caller can pass a Developer record, a building profile, or nothing;
 * the surface is one function so the advisory route and the signed clause can NEVER disagree on a number.
 */
export function resolveTerminationTerms(override?: TerminationTermsOverride): TerminationTerms {
  return {
    defaultThresholdPct: pct(override?.defaultThresholdPct, DEFAULT_TERMINATION_TERMS.defaultThresholdPct),
    cureDays: days(override?.cureDays, DEFAULT_TERMINATION_TERMS.cureDays),
    interestPctPerAnnum: pct(override?.interestPctPerAnnum, DEFAULT_TERMINATION_TERMS.interestPctPerAnnum),
  };
}

/**
 * Sanitise an untrusted partial-override payload (from a developer/building editor) into a stored
 * Partial<TerminationTerms>, or null if NOTHING valid was supplied (→ the caller clears the override and the
 * tier below applies). Each field is kept ONLY if it passes the same validity rule the resolver uses (a
 * positive % ≤ 100 for the two rates; a positive integer for cure days) — a blank/invalid field is DROPPED,
 * not stored as 0/NaN, so "leave blank = inherit" works end to end. Server-side so a malformed POST can't
 * corrupt the store (same discipline as cleanTermsEnvelope). */
export function cleanTerminationTerms(input: unknown): Partial<TerminationTerms> | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const out: Partial<TerminationTerms> = {};
  const keepPct = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100 ? v : undefined;
  const keepDays = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  const thr = keepPct(o.defaultThresholdPct);
  const cure = keepDays(o.cureDays);
  const intr = keepPct(o.interestPctPerAnnum);
  if (thr !== undefined) out.defaultThresholdPct = thr;
  if (cure !== undefined) out.cureDays = cure;
  if (intr !== undefined) out.interestPctPerAnnum = intr;
  return Object.keys(out).length ? out : null;
}

/**
 * The 3-TIER resolution the buyer-default clause actually uses: a BUILDING override wins over the
 * DEVELOPER's house default, which wins over the code default. Each tier is a plain partial, merged FIELD BY
 * FIELD (a developer can set a house interest rate while one building overrides only its threshold) — then the
 * usual `resolveTerminationTerms` clamp applies, so every field is still finite + sane whatever the tiers hold.
 *
 * Takes plain partials (NOT the Developer / Building records themselves) so this file stays free of a
 * catalog/developers import — the caller reads `dev.terminationTerms` / `building.terminationTerms` and passes
 * them. Ownership: the DEVELOPER sets both tiers (their house default + any per-building override)
 * — these are the developer's OWN terms toward their buyers, NOT VRX-set. VRX's own fee/settlement terms are a
 * SEPARATE surface (lib/developers protocolFeePct / vrxSettleWorkingDays). A later industry/region tier would
 * slot in as another partial between building and code default without changing this signature.
 */
export function resolveTerminationChain(
  buildingOverride?: TerminationTermsOverride,
  developerDefault?: TerminationTermsOverride
): TerminationTerms {
  // Field-by-field: building wins, else developer, else undefined → the clamp supplies the code default.
  const merged: Partial<TerminationTerms> = {
    defaultThresholdPct: buildingOverride?.defaultThresholdPct ?? developerDefault?.defaultThresholdPct,
    cureDays: buildingOverride?.cureDays ?? developerDefault?.cureDays,
    interestPctPerAnnum: buildingOverride?.interestPctPerAnnum ?? developerDefault?.interestPctPerAnnum,
  };
  return resolveTerminationTerms(merged);
}
