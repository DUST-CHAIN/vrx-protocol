// CLIENT-SAFE commission-reason vocabulary (H2 fix). Split out of lib/commission.ts (which imports
// server-only fs-backed stores) so the UI can import the REASON enum + plain-words copy without dragging
// server code into the client bundle. Pure: no fs, no secrets, no on-chain. See lib/commission.ts for the
// resolver that PRODUCES these reasons.

/**
 * WHY a booking does or doesn't carry resolvable commission. Every bare `null` the resolver used to return
 * had a distinct cause; the UI couldn't tell them apart, so a confirmed sale with no commission read as a
 * bug ("sold → blank"). This enum lets the surface explain it honestly in plain words.
 *
 * - `earned` — a live, resolvable commission (a value is attached).
 * - `prospective` — booking not yet confirmed; a baseline exists so we CAN preview what it WILL be.
 * - `before_baseline` — CONFIRMED sale dated BEFORE the developer+building's baseline (clock hadn't started).
 * - `no_baseline` — no baseline established for this developer+building yet (relationship not onboarded).
 * - `no_agreement` — no live commission agreement between this developer and the agent's agency.
 * - `no_rate` — an agreement exists but carries no rate (>0%) for this building.
 * - `incomplete` — the booking lacks the basics to compute at all (no agent / developer / price).
 */
export type CommissionReason =
  | "earned"
  | "prospective"
  | "before_baseline"
  | "no_baseline"
  | "no_agreement"
  | "no_rate"
  | "incomplete";

/**
 * Plain-words explanation of a NO-commission outcome, for the UI. Keeps developer-talk OUT: no
 * "baseline", "agreement id", "D-refs" — just what a developer/agent/agency would understand. Returns null
 * for the two POSITIVE reasons (`earned`/`prospective` — a figure is shown, nothing to explain). The caller
 * only shows this when the commission value is null. `baselineAt` fills the date in the `before_baseline` copy.
 */
export function commissionReasonCopy(reason: CommissionReason, baselineAt?: number): string | null {
  switch (reason) {
    case "earned":
    case "prospective":
      return null;
    case "before_baseline": {
      const d =
        typeof baselineAt === "number"
          ? new Date(baselineAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
          : null;
      return d
        ? `No commission — this sale closed before VRX began tracking this building on ${d}.`
        : "No commission — this sale closed before VRX began tracking this building.";
    }
    case "no_baseline":
      return "No commission yet — VRX hasn't started tracking sales for this building. Commission begins once the developer is onboarded.";
    case "no_agreement":
      return "No commission — there's no active commission agreement covering this sale.";
    case "no_rate":
      return "No commission — the agreement in force sets no rate for this building.";
    case "incomplete":
      return "No commission — this booking is missing the details needed to calculate it.";
  }
}
