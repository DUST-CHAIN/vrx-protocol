// Tests for lib/field-plausibility — the TIER-1 (deterministic) input-plausibility nudge.
// Run: npm test (node:test). Pins the ADVISORY asymmetry proven by rampart-probe.run.ts: real identifiers
// → "ok", garbage → "warn", empty/short → "unknown" (never nag). This is a warn-only signal; it must NEVER
// gate save, so these tests assert the verdict shape only — there is no "block" state to test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFieldPlausibility, plausibilityHint } from "./field-plausibility";

test("phone: real E.164 numbers (incl. non-US) are recognised", () => {
  assert.equal(checkFieldPlausibility("phone", "+1 415 555 0132").status, "ok");
  assert.equal(checkFieldPlausibility("phone", "+66 81 234 5678").status, "ok");
});

test("phone: garbage digit soup warns", () => {
  assert.equal(checkFieldPlausibility("phone", "2946524").status, "warn");
  assert.equal(checkFieldPlausibility("phone", "0000").status, "warn");
});

test("email: a real address is recognised; malformed warns", () => {
  assert.equal(checkFieldPlausibility("email", "jane.wong@example.com").status, "ok");
  assert.equal(checkFieldPlausibility("email", "jane at example dot com").status, "warn");
  assert.equal(checkFieldPlausibility("email", "notanemail").status, "warn");
});

test("idRef: a known id shape is recognised (hard or soft); gibberish warns", () => {
  assert.equal(checkFieldPlausibility("idRef", "452-78-1934").status, "ok"); // SSN (hard)
  assert.equal(checkFieldPlausibility("idRef", "A1234567").status, "ok"); //   USCIS A-number (soft, accepted)
  assert.equal(checkFieldPlausibility("idRef", "zzzz").status, "warn");
});

test("INVARIANT: empty / too-short input is 'unknown' — never warns on a half-typed field", () => {
  assert.equal(checkFieldPlausibility("phone", "").status, "unknown");
  assert.equal(checkFieldPlausibility("email", "   ").status, "unknown");
  assert.equal(checkFieldPlausibility("idRef", "ab").status, "unknown"); // under MIN_CHARS
  assert.equal(checkFieldPlausibility("phone", "+1").status, "unknown");
});

test("hints are plain language, no error codes / developer-talk (D76)", () => {
  for (const f of ["phone", "email", "idRef"] as const) {
    const h = plausibilityHint(f);
    assert.ok(h.length > 0);
    assert.doesNotMatch(h, /error|code|validator|regex|Rampart|E\.164|undefined/i);
  }
});
