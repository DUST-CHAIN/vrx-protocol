//  + — the APPROVED-version executors that land an attested changeset onto the catalog ("the
// approved version IS the instruction", no re-type, no drift). PRICE (applyApprovedPriceVersion): writes the
// EXACT `to` price per unit-id key, skips a missing unit / bad `to` / control key. STRUCTURAL
// (applyApprovedStructuralVersion): add/remove/edit a unit by a self-describing per-entry op, with the
// anti-fraud guard refusing to drop a live on-chain unit. Both save once, report applied-vs-skipped, and
// no-op cleanly on an unknown building or the wrong changeset kind.
// File-backed stores bind <cwd>/.data at import time → seed a minimal catalog.json in a throwaway temp BEFORE
// importing anything that reads it. Run via tsx.

import { promises as fs } from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vrx-apply-version-"));
  process.chdir(tmp);
  await fs.mkdir(path.join(tmp, ".data"), { recursive: true });

  // Minimal catalog: one building, units for both price and structural tests.
  const catalog = [
    {
      id: "apply-tower",
      name: "Apply Tower",
      inventory: [
        { id: "a-1", type: "1BR", floor: 1, sqm: 40, priceUsd: 100000 },
        { id: "a-2", type: "2BR", floor: 2, sqm: 60, priceUsd: 200000 },
        { id: "r-open", type: "1BR", floor: 3, sqm: 42, priceUsd: 110000 }, // removable (OPEN on-chain)
        { id: "r-held", type: "1BR", floor: 4, sqm: 44, priceUsd: 120000 }, // NOT removable (HOLD on-chain)
        { id: "e-1", type: "1BR", floor: 5, sqm: 50, priceUsd: 150000 },    // editable
      ],
    },
  ];
  await fs.writeFile(path.join(tmp, ".data", "catalog.json"), JSON.stringify(catalog), "utf8");

  // Seed a persisted status snapshot so applyApprovedStructuralVersion's remove-guard reads a KNOWN
  // status for each removable unit WITHOUT any network (getUnitsStatusMerged serves the snapshot when it
  // already knows the unit — need=[] → no chain read). r-open=0 (OPEN, removable); r-held=1 (HOLD, guarded).
  const snapshot = { "apply-tower": { units: { "r-open": 0, "r-held": 1 }, filledAt: Date.now(), complete: false } };
  await fs.writeFile(path.join(tmp, ".data", "status-snapshot.json"), JSON.stringify(snapshot), "utf8");

  const AV = (await import("./apply-version.js").catch(() => import("./apply-version"))) as typeof import("./apply-version");
  const C = (await import("./catalog.js").catch(() => import("./catalog"))) as typeof import("./catalog");
  const { applyApprovedPriceVersion, applyApprovedStructuralVersion } = AV;

  // ── applies the EXACT `to` to each named unit, reports direction, saves ──
  const r1 = await applyApprovedPriceVersion("apply-tower", {
    "a-1": { from: 100000, to: 120000.5 }, // up, fraction preserved (EXACT)
    "a-2": { from: 200000, to: 180000 },   // down
  });
  ok(r1.applied.length === 2 && r1.skipped.length === 0, "both units applied, none skipped");
  ok(r1.applied.find((a) => a.id === "a-1")?.direction === "up", "a-1 reported direction up");
  ok(r1.applied.find((a) => a.id === "a-2")?.direction === "down", "a-2 reported direction down");
  const after1 = await C.getBuilding("apply-tower");
  ok(after1?.inventory.find((u) => u.id === "a-1")?.priceUsd === 120000.5, "a-1 price written EXACT (fraction kept)");
  ok(after1?.inventory.find((u) => u.id === "a-2")?.priceUsd === 180000, "a-2 price written");

  // ── skips a missing unit, a bad `to`, and control keys — never corrupts the store ──
  const r2 = await applyApprovedPriceVersion("apply-tower", {
    "a-1": { from: 120000.5, to: 130000 }, // valid
    "ghost": { from: 1, to: 2 },           // unit doesn't exist → skipped
    "a-2": { from: 180000, to: 0 },        // non-positive → skipped (store unchanged for a-2)
    "add": "a-9",                          // control key → skipped
  });
  ok(r2.applied.length === 1 && r2.applied[0].id === "a-1", "only the valid entry applied");
  // `skipped` = unit-id keys that couldn't be applied (missing unit / bad `to`). A CONTROL key ("add") is not a
  // unit-id key — it's intentionally ignored, not a failed apply — so it does NOT appear in `skipped`.
  ok(r2.skipped.includes("ghost") && r2.skipped.includes("a-2"), "ghost (missing) + a-2 (bad `to`) are skipped");
  ok(!r2.skipped.includes("add"), "control key 'add' is intentionally ignored, not reported as skipped");
  const after2 = await C.getBuilding("apply-tower");
  ok(after2?.inventory.find((u) => u.id === "a-1")?.priceUsd === 130000, "a-1 updated");
  ok(after2?.inventory.find((u) => u.id === "a-2")?.priceUsd === 180000, "a-2 UNCHANGED (bad `to` never written)");

  // ── unknown building → empty applied, every key reported skipped, no throw ──
  const r3 = await applyApprovedPriceVersion("no-such-building", { "x": { from: 1, to: 2 } });
  ok(r3.applied.length === 0 && r3.skipped.includes("x"), "unknown building → nothing applied, keys skipped");

  // ── a non-price / structural changeset applies nothing via the PRICE applier (price-only) ──
  const r4 = await applyApprovedPriceVersion("apply-tower", { "add": "a-9" });
  ok(r4.applied.length === 0, "control-only changeset applies no price");

  // ── STRUCTURAL auto-apply: add / remove / edit, self-describing per-entry op ──

  // add → a clean new unit is created (control-keyed under "add").
  const s1 = await applyApprovedStructuralVersion("apply-tower", {
    add: { op: "add", unit: { id: "new-9", type: "3BR", floor: 9, sqm: 90, priceUsd: 300000 } },
  });
  ok(s1.applied.length === 1 && s1.applied[0].op === "add" && s1.applied[0].id === "new-9", "add applied new-9");
  const aAdd = await C.getBuilding("apply-tower");
  ok(aAdd?.inventory.find((u) => u.id === "new-9")?.priceUsd === 300000, "new-9 created with exact fields");

  // add → a duplicate id / malformed payload is skipped, never corrupts the store.
  const s2 = await applyApprovedStructuralVersion("apply-tower", {
    add: { op: "add", unit: { id: "a-1", type: "1BR", floor: 1, sqm: 40, priceUsd: 100000 } }, // already exists
  });
  ok(s2.applied.length === 0 && s2.skipped.includes("add"), "add of an existing id is skipped");

  // remove → an OPEN unit is dropped; a HELD unit (live on-chain) is REFUSED by the guard (skipped).
  const s3 = await applyApprovedStructuralVersion("apply-tower", {
    "r-open": { op: "remove" },
    "r-held": { op: "remove" },
  });
  ok(s3.applied.length === 1 && s3.applied[0].id === "r-open", "only the OPEN unit removed");
  ok(s3.skipped.includes("r-held"), "the HELD unit is skipped (anti-fraud guard)");
  const aRm = await C.getBuilding("apply-tower");
  ok(!aRm?.inventory.some((u) => u.id === "r-open"), "r-open gone from the catalog");
  ok(!!aRm?.inventory.some((u) => u.id === "r-held"), "r-held STILL in the catalog (not dropped)");

  // remove → a missing unit is skipped.
  const s4 = await applyApprovedStructuralVersion("apply-tower", { "ghost": { op: "remove" } });
  ok(s4.applied.length === 0 && s4.skipped.includes("ghost"), "remove of a missing unit is skipped");

  // edit → size/type/layout change applies the attested changes exactly (never price).
  const s5 = await applyApprovedStructuralVersion("apply-tower", {
    "e-1": { op: "edit", changes: { sqm: 55, type: "2BR" } },
  });
  ok(s5.applied.length === 1 && s5.applied[0].op === "edit", "edit applied");
  const aEd = await C.getBuilding("apply-tower");
  const e1 = aEd?.inventory.find((u) => u.id === "e-1");
  ok(e1?.sqm === 55 && e1?.type === "2BR" && e1?.priceUsd === 150000, "e-1 sqm+type changed, price untouched");

  // edit → no valid change supplied is skipped.
  const s6 = await applyApprovedStructuralVersion("apply-tower", { "e-1": { op: "edit", changes: {} } });
  ok(s6.applied.length === 0 && s6.skipped.includes("e-1"), "edit with no valid change is skipped");

  // unknown building → nothing applied, keys reported skipped, no throw.
  const s7 = await applyApprovedStructuralVersion("no-such", { "x": { op: "remove" } });
  ok(s7.applied.length === 0 && s7.skipped.includes("x"), "structural on unknown building → keys skipped");

  // a PRICE changeset through the STRUCTURAL applier applies nothing (entries carry no structural op).
  const s8 = await applyApprovedStructuralVersion("apply-tower", { "a-1": { from: 1, to: 2 } });
  ok(s8.applied.length === 0 && s8.skipped.includes("a-1"), "price entry via structural applier → skipped");

  console.log(`\napply-version: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
