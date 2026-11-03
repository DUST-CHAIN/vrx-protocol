//  item 3 — display-price rounding. Pure, no I/O. Run via tsx.
// Covers: roundForDisplay (none passthrough / nearest_100 / nearest_1000 / half-up / exact storage untouched /
// non-finite passthrough), asPriceRounding (narrowing + fallback), the default.

import {
  roundForDisplay,
  asPriceRounding,
  DEFAULT_PRICE_ROUNDING,
  PRICE_ROUNDING_MODES,
  type PriceRounding,
} from "./price-rounding";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// default is clean thousands
ok(DEFAULT_PRICE_ROUNDING === "nearest_1000", "default is nearest_1000");
ok(PRICE_ROUNDING_MODES.length === 3, "three modes exposed");

// none → exact passthrough (storage truth is shown verbatim)
ok(roundForDisplay(424360, "none") === 424360, "none → exact");
ok(roundForDisplay(424715.35, "none") === 424715.35, "none keeps fractions");

// nearest_1000 — the worked example ($424,360 → $424,000)
ok(roundForDisplay(424360, "nearest_1000") === 424000, "424360 → 424000 at nearest_1000");
ok(roundForDisplay(424500, "nearest_1000") === 425000, "half-up at .5 of the step (424500 → 425000)");
ok(roundForDisplay(424499, "nearest_1000") === 424000, "below half rounds down");

// nearest_100
ok(roundForDisplay(424360, "nearest_100") === 424400, "424360 → 424400 at nearest_100");
ok(roundForDisplay(424715.35, "nearest_100") === 424700, "fraction rounds at nearest_100");

// default arg = nearest_1000
ok(roundForDisplay(424360) === 424000, "default arg rounds to nearest_1000");

// this NEVER mutates storage — it returns a NEW number; the exact input is unchanged (value semantics)
const exact = 424715.35;
roundForDisplay(exact, "nearest_1000");
ok(exact === 424715.35, "input (stored price) is untouched — pure function");

// non-finite passthrough (formatter handles display)
ok(Number.isNaN(roundForDisplay(NaN, "nearest_1000")), "NaN passes through");
ok(roundForDisplay(Infinity, "nearest_100") === Infinity, "Infinity passes through");

// asPriceRounding — narrow + fallback
ok(asPriceRounding("none") === "none", "narrows a valid mode");
ok(asPriceRounding("nearest_100") === "nearest_100", "narrows nearest_100");
ok(asPriceRounding("garbage") === DEFAULT_PRICE_ROUNDING, "invalid → default");
ok(asPriceRounding(undefined) === DEFAULT_PRICE_ROUNDING, "undefined → default");
ok(asPriceRounding(1000) === DEFAULT_PRICE_ROUNDING, "non-string → default");
const narrowed: PriceRounding = asPriceRounding("nearest_1000"); // type-checks
ok(narrowed === "nearest_1000", "type narrows to PriceRounding");

console.log(`\nprice-rounding: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
