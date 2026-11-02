// Pin diffStatuses (lib/status-store) — the PURE status-ledger seam contract, extracted so it's
// testable without file IO. saveBuildingStatuses is the ONE choke-point every status write funnels through,
// and callers often pass a MERGED full map ({...known...read}); the ledger (and the §6c commission timer
// downstream) depend on this diff emitting EXACTLY the real transitions: unchanged → nothing, absent-in-prev
// → first observation (from:null), changed → {from,to}. A regression here would fabricate or drop ledger
// rows and mis-time a financial action. Run via tsx.

import { diffStatuses } from "./status-store";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

function main() {
  // ── unchanged emits NOTHING (the merged-map safety: re-writing known units must not fake transitions) ─
  ok(diffStatuses({ a: 0, b: 1 }, { a: 0, b: 1 }).length === 0, "identical maps → no transitions");
  ok(diffStatuses({ a: 2 }, { a: 2 }).length === 0, "an unchanged code → nothing");

  // ── absent-in-prev → first observation with from: null (honest, not a faked 0→x) ────────────────────
  const first = diffStatuses({}, { a: 0 });
  ok(first.length === 1 && first[0].from === null && first[0].to === 0 && first[0].unit === "a",
    "a unit absent from prev → { from: null } first observation");
  const firstNonzero = diffStatuses({}, { a: 3 });
  ok(firstNonzero[0].from === null && firstNonzero[0].to === 3,
    "first observation preserves the real `to` code (not assumed 0)");

  // ── a changed code → { unit, from, to } ─────────────────────────────────────────────────────────────
  const ch = diffStatuses({ a: 0 }, { a: 1 });
  ok(ch.length === 1 && ch[0].from === 0 && ch[0].to === 1, "0→1 emits { from:0, to:1 }");

  // ── mixed map: only the changed/new units appear, in incoming order ─────────────────────────────────
  const mixed = diffStatuses(
    { a: 0, b: 1, c: 2 },        // prev
    { a: 0, b: 2, c: 2, d: 0 }   // incoming: a unchanged, b 1→2, c unchanged, d new
  );
  ok(mixed.length === 2, "mixed map → exactly the 2 real changes (a,c unchanged excluded)");
  ok(mixed.some((t) => t.unit === "b" && t.from === 1 && t.to === 2), "b recorded 1→2");
  ok(mixed.some((t) => t.unit === "d" && t.from === null && t.to === 0), "d recorded as first-obs null→0");
  ok(!mixed.some((t) => t.unit === "a" || t.unit === "c"), "unchanged a,c absent from the diff");

  // ── the -1 'not stamped' code participates like any other (a real transition to/from -1) ────────────
  ok(diffStatuses({ a: 0 }, { a: -1 }).some((t) => t.from === 0 && t.to === -1), "0→-1 (unstamped) is a transition");
  ok(diffStatuses({ a: -1 }, { a: -1 }).length === 0, "-1→-1 is unchanged → nothing");

  // ── empty incoming → nothing (a no-op write) ────────────────────────────────────────────────────────
  ok(diffStatuses({ a: 0 }, {}).length === 0, "empty incoming → no transitions (nothing to record)");

  console.log(fail === 0 ? `status-store.diff: ${pass}/${pass} PASS` : `status-store.diff: ${fail} FAILED, ${pass} passed`);
  if (fail > 0) process.exit(1);
}

main();
