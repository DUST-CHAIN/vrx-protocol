// THE TIME SEAM (the "where do we get time from?" note). SERVER-ONLY. ONE place VRX reads "now", so the
// time source is a single swap point, not 50 scattered `Date.now` calls.
//
// ── WHY THIS MATTERS (the notary posture) ────────────────────────────────────────────────────────────────────
// VRX's whole value is "we can prove X happened at time T." A soft T = a soft proof. Today "now" is the box's LOCAL
// WALL CLOCK (`Date.now`). That is the ASSERTED time — fast, always available, and what a sealed record SAYS
// happened. It is NOT, by itself, trustless: a drifted/un-NTP'd VM clock or a careless/malicious operator can be
// wrong or backdate. The durable model (see docs/ §time + OPEN_ITEMS) is:
//
//  ASSERTED time (this module's now) — what the record claims, immediate.
//        +
//   PROVEN time-FLOOR (the OpenTimestamps/Bitcoin anchor, once `proven`) — an independent, tamper-evident
//        "existed no later than block T" that NO VRX operator can forge. This is the trustless backup with real
//        resolution; the OTS queue already produces it (lib/ots-anchor `provenAt`). NEAR block height is a cheap
//        second independent witness we already read.
//
// This seam is the FOUNDATION for that model: centralizing "now" means a future hardening (an NTP-checked monotonic
// clock, a boot-time drift guard, or injecting a proven/witnessed time) changes ONE function, not every call site.
//
// ── TODAY ────────────────────────────────────────────────────────────────────────────────────────────────────
// now returns Date.now (the asserted wall clock) UNLESS VRX_FIXED_NOW is set (tests / deterministic replays).
// A boot-time sanity note is logged ONCE if the clock looks implausibly wrong (before ~2020 or after ~2100), which
// catches a grossly-unset VM clock early. True NTP enforcement is a -gated follow-on (OPEN_ITEMS).

/** ms epoch floor/ceiling for a plausible real clock — a value outside this is a grossly-wrong (unset) VM clock. */
const PLAUSIBLE_MIN = 1_577_836_800_000; // 2020-01-01
const PLAUSIBLE_MAX = 4_102_444_800_000; // 2100-01-01

let warnedImplausible = false;

/**
 * The single VRX "now" (ms epoch). The ASSERTED time — what a sealed/stamped/anchored record says happened. Use this
 * everywhere instead of a bare `Date.now` so the time source stays one swappable seam.
 *
 * VRX_FIXED_NOW (ms) pins it for tests / deterministic replays. Otherwise the wall clock, with a ONE-TIME warning if
 * the clock is implausibly wrong (an early guard against an unset VM clock silently mis-timestamping provenance).
 */
export function now(): number {
  const fixed = process.env.VRX_FIXED_NOW;
  if (fixed) {
    const n = Number(fixed);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const t = Date.now();
  if ((t < PLAUSIBLE_MIN || t > PLAUSIBLE_MAX) && !warnedImplausible) {
    warnedImplausible = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[clock] system clock reads ${new Date(t).toISOString()} — outside the plausible 2020–2100 window. The box ` +
        `clock may be unset/drifted; provenance timestamps will be WRONG until it is corrected (check NTP). ` +
        `See OPEN_ITEMS S386 (time trust model).`
    );
  }
  return t;
}

/** Is the current wall clock plausibly correct (inside 2020–2100)? A cheap boot/health check — a false here means
 *  the box clock is grossly wrong and every asserted timestamp is suspect until NTP corrects it. */
export function clockLooksPlausible(): boolean {
  const t = Date.now();
  return t >= PLAUSIBLE_MIN && t <= PLAUSIBLE_MAX;
}
