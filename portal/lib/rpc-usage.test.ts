// Pin the PURE reducers of lib/rpc-usage, split out of the IO-bound mutate so the FastNEAR
// credit-estimate state machine is testable without disk. The estimate the owner dashboard shows is
//     remaining = baselineCredits − (calls − baselineCalls)
// so the whole correctness of "how much FastNEAR credit is left" rides on the baselineCalls ANCHOR:
// applyBaseline must snapshot the current call count at the instant a dashboard figure is entered, and
// applyReset must re-anchor baselineCalls to 0 for the new period while KEEPING the baseline. A regression
// here mis-reports the burn (e.g. double-counts calls made before the baseline was entered). Run via tsx.

import { applyCount, applyBaseline, applyReset, type RpcUsage } from "./rpc-usage";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// The estimate the UI computes — recreated here so the reducers' anchoring is validated end-to-end.
const remaining = (u: RpcUsage): number | null =>
  u.baselineCredits === undefined ? null : u.baselineCredits - (u.calls - (u.baselineCalls ?? 0));

function main() {
  const base: RpcUsage = { calls: 0, since: 1000 };

  // ── applyCount: adds, defaults to 1, is pure (no mutation of input) ───────────────────────────────────
  ok(applyCount(base).calls === 1, "applyCount() defaults to +1");
  ok(applyCount(base, 5).calls === 5, "applyCount(u,5) adds 5");
  ok(base.calls === 0, "applyCount does NOT mutate the input");
  ok(applyCount({ calls: 7, since: 1 }, 3).calls === 10, "applyCount accumulates onto existing calls");

  // ── applyBaseline: snapshots CURRENT calls into baselineCalls + records credits/at ────────────────────
  {
    const after100 = { ...base, calls: 100 };
    const b = applyBaseline(after100, 5000, 2000);
    ok(b.baselineCredits === 5000, "baselineCredits recorded");
    ok(b.baselineAt === 2000, "baselineAt recorded from the passed `at`");
    ok(b.baselineCalls === 100, "baselineCalls SNAPSHOTS the call count at entry (the anchor)");
    ok(b.calls === 100, "applyBaseline leaves the running call count untouched");
    ok(after100.baselineCalls === undefined, "applyBaseline does NOT mutate the input");
  }

  // ── the ANCHOR in action: calls made BEFORE the baseline must NOT count against it ────────────────────
  {
    // 100 calls already burned (on the OLD credit top-up), THEN enters a fresh 5000-credit baseline.
    let u: RpcUsage = { calls: 100, since: 1000 };
    u = applyBaseline(u, 5000, 2000);
    ok(remaining(u) === 5000, "right after baseline: remaining == full baseline (pre-baseline calls excluded)");
    u = applyCount(u, 30); // 30 new calls on the NEW credits
    ok(remaining(u) === 4970, "30 calls after baseline → remaining 4970 (NOT 4870 — the anchor excludes the old 100)");
  }

  // ── applyReset: zero calls, new `since`, re-anchor baselineCalls to 0, KEEP the baseline ──────────────
  {
    const live: RpcUsage = { calls: 450, since: 1000, baselineCredits: 5000, baselineAt: 2000, baselineCalls: 100 };
    const r = applyReset(live, 9999);
    ok(r.calls === 0, "applyReset zeroes the call count");
    ok(r.since === 9999, "applyReset stamps the new period's `since`");
    ok(r.baselineCalls === 0, "applyReset re-anchors baselineCalls to 0 (new period counts fresh)");
    ok(r.baselineCredits === 5000 && r.baselineAt === 2000, "applyReset KEEPS the baseline credits/at");
    ok(live.calls === 450, "applyReset does NOT mutate the input");
    // after a reset, remaining is measured fresh against the kept baseline
    ok(remaining(r) === 5000, "post-reset with 0 calls → remaining == full kept baseline");
    ok(remaining(applyCount(r, 12)) === 4988, "12 calls after a reset → 4988 against the kept baseline");
  }

  // ── no baseline set → remaining is null (dashboard shows the estimate only once enters a figure) ─
  ok(remaining(applyCount(base, 40)) === null, "no baselineCredits → remaining() null regardless of call count");

  console.log(fail === 0 ? `rpc-usage: ${pass}/${pass} PASS` : `rpc-usage: ${fail} FAILED, ${pass} passed`);
  if (fail > 0) process.exit(1);
}

main();
