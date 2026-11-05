// MM pack model + validation tests. Pure, no I/O. Run via tsx.
// Covers: slugify, emptyPack exports-valid shape, totalUnits, and validatePack error/warning split.

import { emptyPack, slugify, totalUnits, type Pack } from "./pack";
import { validatePack } from "./validate";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// --- slugify ---
ok(slugify("Acme Developments") === "acme-developments", "slugify spaces -> hyphens");
ok(slugify("Rivérside #1!") === "riv-rside-1", "slugify strips non [a-z0-9-]");
ok(slugify("") === "untitled", "slugify empty -> untitled");
ok(/^[a-z0-9-]+$/.test(slugify("  Big  Name  ")), "slugify always matches id pattern");

// --- emptyPack ---
const p0 = emptyPack("New Dev");
ok(p0.developer.id === "new-dev", "emptyPack slugifies developer id");
ok(p0.buildings.length === 0 && p0.complexes.length === 0, "emptyPack has empty tree");
ok(Array.isArray(p0.geo) && p0.geo!.length === 0, "emptyPack has geometry-ready (empty) geo array");

// --- totalUnits ---
const p1: Pack = emptyPack("Acme");
p1.buildingUnits = {
  "bldg-a": [
    { id: "u1", type: "studio", floor: 1, sqm: 30, priceUsd: 95000 },
    { id: "u2", type: "1br", floor: 2, sqm: 46, priceUsd: 165000 },
  ],
  "bldg-b": [{ id: "u3", type: "studio", floor: 1, sqm: 28, priceUsd: 90000 }],
};
ok(totalUnits(p1) === 3, "totalUnits sums across buildings");

// --- validatePack: a well-formed minimal pack ---
const good: Pack = {
  developer: { id: "acme-developments", name: "Acme Developments" },
  companies: [{ id: "acme-co", name: "Acme Co" }],
  complexes: [{ id: "riverside", name: "Riverside", buildings: ["riverside-north"] }],
  buildings: [
    { id: "riverside-north", name: "Riverside North", complexId: "riverside", type: "High Rise", stories: 20, termsRef: "standard-2y" },
  ],
  buildingUnits: {
    "riverside-north": [
      { id: "unit-0801", type: "studio", subtype: "A", floor: 8, unitNumber: 801, sqm: 30, priceUsd: 95000 },
    ],
  },
  terms: [{ id: "standard-2y", data: { bookingFee: [1500] } }],
};
const rGood = validatePack(good);
ok(rGood.ok === true, "well-formed pack validates ok (no errors)");
ok(rGood.counts.errors === 0, "well-formed pack has 0 errors");

// --- validatePack: catches the real error classes ---
const bad: Pack = {
  developer: { id: "Bad Id", name: "" }, // bad id + missing name
  companies: [],
  complexes: [{ id: "cx", name: "CX", buildings: ["ghost-building"] }], // dangling building ref
  buildings: [
    { id: "b1", name: "B1", complexId: "nope", type: "High Rise", stories: 0 }, // bad complexId + stories<1
  ],
  buildingUnits: {
    "b1": [
      { id: "dup", type: "", floor: NaN as unknown as number, sqm: 0, priceUsd: -5 }, // missing type/floor/sqm/price
      { id: "dup", type: "studio", floor: 1, sqm: 30, priceUsd: 1, termsRef: "missing-terms" }, // dup id + missing terms
    ],
  },
  terms: [],
};
const rBad = validatePack(bad);
ok(rBad.ok === false, "bad pack fails validation");
const msgs = rBad.findings.map((f) => `${f.where}|${f.field}|${f.message}`).join("\n");
ok(/developer\|name/.test(msgs), "flags missing developer name");
ok(/developer\|id/.test(msgs), "flags bad developer id pattern");
ok(/references building "ghost-building"/.test(msgs), "flags dangling building reference");
ok(/building must reference an existing complex/.test(msgs), "flags bad complexId");
ok(/stories is required/.test(msgs), "flags stories < 1");
ok(/duplicate unit id "dup"/.test(msgs), "flags duplicate unit id");
ok(/references terms "missing-terms"/.test(msgs), "flags missing termsRef");

console.log(`\npack.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
