// Terms-envelope payload validation for POST /api/catalog/terms (§9). Lives in lib/ (not the
// route file) because a Next route module may only export HTTP handlers + known config — extra exports break
// the generated route type (the lesson catalog-geo.ts records). Pure functions, unit-tested in
// lib/catalog-terms.test.ts.

import type { TermsEnvelope } from "@/lib/catalog";

/** Validate + normalise an incoming terms-envelope payload, or null to CLEAR it. Throws on bad shape (caller
 * → 400). An envelope with neither bound set collapses to null (nothing to bound = no envelope). Each bound
 * is a percentage in 0..100; if BOTH are set, min must not exceed max. */
export function cleanTermsEnvelope(raw: unknown): TermsEnvelope | null {
  if (raw == null) return null;
  const r = raw as Record<string, unknown>;

  const lo = readPct(r.commissionMinPct, "commissionMinPct");
  const hi = readPct(r.commissionMaxPct, "commissionMaxPct");

  if (lo == null && hi == null) return null; // empty envelope = cleared
  if (lo != null && hi != null && lo > hi) {
    throw new Error("commissionMinPct cannot exceed commissionMaxPct");
  }

  const out: TermsEnvelope = {};
  if (lo != null) out.commissionMinPct = lo;
  if (hi != null) out.commissionMaxPct = hi;
  return out;
}

/** Read one optional percent bound. Absent/empty → undefined (bound not set); a present value must be a
 * finite number in 0..100, else throw. */
function readPct(v: unknown, field: string): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${field} must be a percentage between 0 and 100`);
  return n;
}
