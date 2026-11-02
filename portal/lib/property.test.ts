// PROPERTY-BASED tests — fast-check over the money/date/masking invariants. The hand-written tests
// (sale-contract.dates.test.ts, buyer-mask.test.ts, payment-ledger.test.ts) assert SPECIFIC cases; this file
// asserts the INVARIANTS that must hold for THOUSANDS of adversarial inputs — the floor those cases can't
// cover (off-by-ones at ordinal/boundary, interior-leak in masking, acceptance of a structurally-broken date).
// WHY these targets: the date logic is the freshest/riskiest and the masking logic is the privacy
// MOAT — a leak there is the worst failure the system can have. A falsified property is a FAIL and
// exits 1 (same harness contract as the other tsx tests). fast-check prints the minimal counterexample.
// Run via `npx tsx` (registered in `npm test`). Deterministic seed so a failure reproduces.
import fc from "fast-check";
import { instalmentDueDate, validateInstalmentDueDate } from "./sale-contract";
import { partialValue, publicBuyerView, type BuyerMask, type MaskMode } from "./buyer-mask";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
// Wrap fc.assert so a falsified property is ONE counted failure (with fast-check's minimal counterexample
// printed) rather than an uncaught throw — keeps the pass/fail tally honest and the harness contract intact.
function prop(name: string, property: fc.IProperty<unknown> | fc.IAsyncProperty<unknown>): void {
  try {
    fc.assert(property as fc.IProperty<unknown>, { numRuns: 1000, seed: 167, verbose: false });
    pass++;
  } catch (e) {
    fail++;
    console.log("FAIL (property):", name);
    console.log(String((e as Error).message).split("\n").slice(0, 6).join("\n"));
  }
}

const DAY = 86_400_000;
// A positive epoch in a sane range (2001-09.. ~2065) so arithmetic never overflows Number and dates are real.
const epoch = () => fc.integer({ min: 1_000_000_000_000, max: 3_000_000_000_000 });

// ── instalmentDueDate — the ONE dating rule ───────────────────────────────────────────────────

// P1: PRIORITY — a per-line dueAt (>0) always wins, whatever else is set.
prop("dates: lineDueAt (>0) beats override + auto-interval", fc.property(
  fc.integer({ min: 1, max: 60 }), epoch(), fc.integer({ min: 1, max: 365 }), epoch(), epoch(),
  (n, anchorAt, freqDays, override, lineDueAt) =>
    instalmentDueDate(n, { anchorAt, freqDays, override, lineDueAt }) === lineDueAt
));

// P2: PRIORITY — with no lineDueAt, an override (>0) always wins over the auto-interval.
prop("dates: override (>0) beats the auto-interval", fc.property(
  fc.integer({ min: 1, max: 60 }), epoch(), fc.integer({ min: 1, max: 365 }), epoch(),
  (n, anchorAt, freqDays, override) =>
    instalmentDueDate(n, { anchorAt, freqDays, override }) === override
));

// P3: MONOTONICITY — on the auto-interval path, a later ordinal is strictly later. The property a per-line
// loop depends on (§2 renders in ordinal order; a non-monotone clock would print out-of-order dates).
prop("dates: auto-interval is strictly increasing in the ordinal", fc.property(
  fc.integer({ min: 1, max: 59 }), epoch(), fc.integer({ min: 1, max: 365 }),
  (n, anchorAt, freqDays) => {
    const a = instalmentDueDate(n, { anchorAt, freqDays })!;
    const b = instalmentDueDate(n + 1, { anchorAt, freqDays })!;
    return typeof a === "number" && typeof b === "number" && b > a;
  }
));

// P4: HONEST ABSENCE — no lineDueAt AND no override AND (no anchor OR no freq OR ordinal<1) ⇒ undefined.
// Never fabricate a date. We feed only the "cannot date" shapes and require undefined every time.
prop("dates: no anchor/freq/override ⇒ always undefined (never guessed)", fc.property(
  fc.integer({ min: -5, max: 60 }),
  fc.oneof(fc.constant(undefined), fc.integer({ min: -10, max: 0 })),   // anchor: absent or non-positive
  fc.oneof(fc.constant(undefined), fc.integer({ min: -10, max: 0 })),   // freq: absent or non-positive
  (n, anchorAt, freqDays) =>
    instalmentDueDate(n, { anchorAt: anchorAt as number | undefined, freqDays: freqDays as number | undefined }) === undefined
));


// P5: never ACCEPTS a date before the booking date (a payment can't be due before the deal exists).
prop("validate: a before-booking date is always rejected", fc.property(
  epoch(), fc.integer({ min: 1, max: 3650 }), fc.integer({ min: 1, max: 60 }),
  (bookingAt, daysBefore, ordinal) =>
    validateInstalmentDueDate({ dueAt: bookingAt - daysBefore * DAY, ordinal, bookingAt, now: bookingAt }).ok === false
));

// P6: never ACCEPTS a date beyond the far-out cap (the "never-due" commission-parking trap).
prop("validate: a date beyond maxAt is always rejected", fc.property(
  epoch(), fc.integer({ min: 30, max: 3650 }), fc.integer({ min: 1, max: 3650 }), fc.integer({ min: 1, max: 60 }),
  (bookingAt, capDays, overshootDays, ordinal) => {
    const maxAt = bookingAt + capDays * DAY;
    return validateInstalmentDueDate({ dueAt: maxAt + overshootDays * DAY, ordinal, bookingAt, now: bookingAt, maxAt }).ok === false;
  }
));

// P7: ORDER-SAFETY — IF a date is accepted, it sits strictly between the nearest earlier and later neighbour.
// The structural guarantee: an accepted override can NEVER create an out-of-order schedule in §2.
prop("validate: an accepted date never breaks neighbour ordering", fc.property(
  epoch(), fc.integer({ min: 1, max: 365 }), epoch(),
  (bookingAt, freqDays, dueAt) => {
    const ordinal = 2;
    // Two neighbours straddling ordinal 2: #1 (earlier) and #3 (later), auto-interval dates off the anchor.
    const n1 = bookingAt + 1 * freqDays * DAY;
    const n3 = bookingAt + 3 * freqDays * DAY;
    const r = validateInstalmentDueDate({ dueAt, ordinal, bookingAt, now: bookingAt, neighbours: { 1: n1, 3: n3 }, maxAt: bookingAt + 100 * 365 * DAY });
    // If rejected, nothing to prove. If accepted, it MUST sit strictly within (n1, n3].
    return !r.ok || (dueAt >= n1 && dueAt <= n3);
  }
));

// ── publicBuyerView / partialValue — the privacy MOAT ──────────────────────────────────────────

// Field-name + value generators: realistic-ish keys (incl. the always-passed attestationSource) + arbitrary values.
const fieldKey = fc.oneof(
  fc.constantFrom("name", "idRef", "nationality", "phone", "email", "note", "legalName", "address", "attestationSource"),
  fc.string({ minLength: 1, maxLength: 12 }) // unmapped future keys → must fail CLOSED
);
const maskMode = fc.constantFrom<MaskMode>("show", "partial", "hide");
const buyerObj = fc.dictionary(fieldKey, fc.string({ maxLength: 40 }), { maxKeys: 8 });
const maskObj = fc.dictionary(fieldKey, maskMode, { maxKeys: 8 }) as fc.Arbitrary<BuyerMask>;

// P8: NO LEAK — a field whose effective mode resolves to "hide" is ABSENT from the output. The core privacy
// invariant: the developer-scoped view never ships a hidden field's plaintext. (attestationSource is metadata,
// always passed — excluded from the hide check by design.)
prop("mask: a 'hide' field is always absent from the public view", fc.property(
  buyerObj, maskObj,
  (buyer, mask) => {
    const out = publicBuyerView(buyer, mask) ?? {};
    for (const k of Object.keys(buyer)) {
      if (k === "attestationSource") continue; // always-passed metadata, not maskable PII
      // Effective mode resolution MIRRORS publicBuyerView: explicit mask → DEFAULT_MASK → "hide".
      const DEFAULT_MASK: Record<string, MaskMode> = { name: "partial", idRef: "partial", nationality: "show", phone: "hide", email: "hide", note: "hide" };
      const mode = (mask[k] ?? DEFAULT_MASK[k] ?? "hide") as MaskMode;
      if (mode === "hide" && k in out) return false; // a hidden field leaked
    }
    return true;
  }
));

// P9: FAIL-CLOSED — an UNMAPPED key (not in DEFAULT_MASK) with NO explicit mask must be dropped (defaults hide).
prop("mask: an unmapped field with no mask defaults to hidden (fail-closed)", fc.property(
  fc.string({ minLength: 1, maxLength: 40 }),
  (value) => {
    const KEY = "zzz_unmapped_future_field";
    const out = publicBuyerView({ [KEY]: value }, {}) ?? {};
    return !(KEY in out); // must NOT appear — fail-visible rule
  }
));

// P10: partialValue never leaks the interior — for a single word of length ≥ 3, every interior char is a dot,
// only the first + last ORIGINAL chars survive, and the length/shape is preserved.
prop("mask: partialValue dots the interior of a word (len ≥ 3), preserving shape", fc.property(
  fc.string({ minLength: 3, maxLength: 30 }).filter((s) => !/\s/.test(s)), // one whitespace-free word
  (word) => {
    const m = partialValue(word);
    if (m.length !== word.length) return false;            // 1:1 char replacement
    if (m[0] !== word[0] || m[m.length - 1] !== word[word.length - 1]) return false; // ends survive
    for (let i = 1; i < m.length - 1; i++) if (m[i] !== "•") return false;           // interior all dotted
    return true;
  }
));

// P11: partialValue never masks WHITESPACE — the whitespace runs between words pass through verbatim, so a
// full name keeps its word SHAPE (how many names, where the spaces are) while the content is masked. Note the
// total length is NOT preserved in general: a 1-char word becomes `char + dot` by design (lib comment l.57),
// so this asserts the real invariant (whitespace untouched), not length equality.
prop("mask: partialValue passes whitespace runs through verbatim", fc.property(
  fc.string({ maxLength: 40 }),
  (v) => {
    const m = partialValue(v);
    // The whitespace runs (in order) must be identical in input and output — none dotted, none dropped/added.
    const wsIn = (v.match(/\s+/g) ?? []).join("");
    const wsOut = (m.match(/\s+/g) ?? []).join("");
    return wsIn === wsOut;
  }
));

console.log(`\nproperty (fast-check): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
