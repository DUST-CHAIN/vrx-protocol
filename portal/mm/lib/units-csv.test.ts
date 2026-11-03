// units.csv parse/serialize tests. Pure, no I/O. Run via tsx.
// Covers: header-by-name mapping, quoted fields, number/bool coercion, required-field row errors,
// round-trip (serialize -> parse), and the canonical column order.

import { parseUnitsCsv, serializeUnitsCsv, UNIT_COLUMNS } from "./units-csv";
import type { Unit } from "./pack";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// --- canonical columns match unit.columns.md ---
ok(UNIT_COLUMNS[0] === "id" && UNIT_COLUMNS[1] === "type", "columns start id,type");
ok(UNIT_COLUMNS.includes("priceUsd") && UNIT_COLUMNS.includes("termsRef"), "columns include priceUsd + termsRef");

// --- parse the real examples/minimal shape ---
const csv = [
  "id,type,subtype,floor,unitNumber,sqm,priceUsd,priceFreehold,priceCompany,view,corner,baths,note,termsRef",
  "unit-0801,studio,A,8,801,30,95000,99000,92000,River view,false,1,Efficient studio,",
  'unit-1204,1br,B,12,1204,46,165000,172000,159000,River view,true,1,"Corner, prime",standard-3y',
].join("\n");
const r = parseUnitsCsv(csv);
ok(r.errors.length === 0, "clean CSV parses with no row errors");
ok(r.units.length === 2, "two units parsed");
ok(r.units[0].id === "unit-0801" && r.units[0].type === "studio", "row 1 id+type");
ok(r.units[0].floor === 8 && r.units[0].sqm === 30 && r.units[0].priceUsd === 95000, "row 1 numbers coerced");
ok(r.units[0].corner === false && r.units[1].corner === true, "corner bool coerced");
ok(r.units[1].note === "Corner, prime", "quoted field with embedded comma parsed");
ok(r.units[1].termsRef === "standard-3y", "per-unit termsRef read");

// --- header order independence + unknown-column tolerance ---
const reordered = [
  "type,id,priceUsd,floor,sqm,bogusCol",
  "studio,u9,90000,3,28,ignored",
].join("\n");
const r2 = parseUnitsCsv(reordered);
ok(r2.errors.length === 0, "reordered headers still parse");
ok(r2.units[0].id === "u9" && r2.units[0].type === "studio" && r2.units[0].sqm === 28, "mapped by header name, order-independent");

// --- required-field errors surface per row ---
const bad = [
  "id,type,floor,sqm,priceUsd",
  ",studio,,,", // missing id, floor, sqm, priceUsd
].join("\n");
const r3 = parseUnitsCsv(bad);
const cols = r3.errors.map((e) => `${e.row}:${e.column}`).join(",");
ok(/1:id/.test(cols), "flags missing id on row 1");
ok(/1:floor/.test(cols), "flags missing floor");
ok(/1:sqm/.test(cols), "flags missing sqm");
ok(/1:priceUsd/.test(cols), "flags missing priceUsd");

// --- thousands separators tolerated ---
const withCommas = ["id,type,floor,sqm,priceUsd", 'u10,1br,5,"46","165,000"'].join("\n");
const r4 = parseUnitsCsv(withCommas);
ok(r4.units[0].priceUsd === 165000, "price with thousands separator coerced");

// --- round-trip: serialize -> parse yields the same values ---
const units: Unit[] = [
  { id: "u1", type: "studio", subtype: "A", floor: 1, unitNumber: 101, sqm: 30, priceUsd: 95000, view: "Sea view", corner: true, baths: 1, note: 'has "quotes", and commas', termsRef: "t1" },
  { id: "u2", type: "1br", floor: 2, sqm: 46, priceUsd: 165000 },
];
const serialized = serializeUnitsCsv(units);
ok(serialized.split("\n")[0] === UNIT_COLUMNS.join(","), "serialize writes canonical header");
const back = parseUnitsCsv(serialized);
ok(back.errors.length === 0, "round-trip re-parses cleanly");
ok(back.units[0].note === 'has "quotes", and commas', "round-trip preserves quotes+commas in note");
ok(back.units[0].corner === true && back.units[1].priceUsd === 165000, "round-trip preserves values");

console.log(`\nunits-csv.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
