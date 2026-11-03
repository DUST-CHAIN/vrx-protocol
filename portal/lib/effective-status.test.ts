// Freeze the effective-availability derive (indexer Slice 1). The contract keeps a time-expired hold
// stored as status:1 until a tx frees it; this derive serves OPEN once the expiry has passed, for DISPLAY.
// The one subtlety is the ns/ms boundary — these cases pin it. Run via tsx.

import { effectiveStatus, msToNs, STATUS_OPEN, STATUS_HOLD } from "./effective-status";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// A fixed "now" so the cases are deterministic. 2026-06-01T00:00:00Z in ms, converted to ns.
const NOW_MS = Date.UTC(2026, 5, 1, 0, 0, 0);
const NOW_NS = msToNs(NOW_MS);
const HOUR_NS = 3_600_000_000_000n; // 1h in ns

function main() {
  // ── Non-hold statuses are returned UNCHANGED, regardless of any expiry value ──────────────────────────
  ok(effectiveStatus(STATUS_OPEN, null, NOW_NS) === STATUS_OPEN, "open stays open");
  ok(effectiveStatus(2, null, NOW_NS) === 2, "closed stays closed");
  ok(effectiveStatus(3, null, NOW_NS) === 3, "done stays done");
  ok(effectiveStatus(-1, null, NOW_NS) === -1, "not-stamped stays -1");
  // Even a stale/garbage expiry must not perturb a non-hold status (we only consult expiry for holds).
  ok(effectiveStatus(2, Number(NOW_NS - HOUR_NS), NOW_NS) === 2, "closed ignores a past expiry");

  // ── A HOLD with NO recorded expiry = untimed/indefinite → stays HOLD (never auto-opens) ───────────────
  ok(effectiveStatus(STATUS_HOLD, null, NOW_NS) === STATUS_HOLD, "hold + null expiry stays hold");
  ok(effectiveStatus(STATUS_HOLD, undefined, NOW_NS) === STATUS_HOLD, "hold + undefined expiry stays hold");

  // ── A HOLD that has NOT yet expired → stays HOLD ──────────────────────────────────────────────────────
  ok(effectiveStatus(STATUS_HOLD, NOW_NS + HOUR_NS, NOW_NS) === STATUS_HOLD, "hold expiring in 1h stays hold");

  // ── A HOLD whose expiry has PASSED → becomes OPEN (the whole point) ────────────────────────────────────
  ok(effectiveStatus(STATUS_HOLD, NOW_NS - HOUR_NS, NOW_NS) === STATUS_OPEN, "hold expired 1h ago → open");

  // ── The BOUNDARY: now === expiry → OPEN (mirror the contract's `now >= until`) ─────────────────────────
  ok(effectiveStatus(STATUS_HOLD, NOW_NS, NOW_NS) === STATUS_OPEN, "hold at the exact expiry instant → open");
  ok(effectiveStatus(STATUS_HOLD, NOW_NS + 1n, NOW_NS) === STATUS_HOLD, "hold expiring 1ns from now stays hold");

  // ── Accepts bigint OR number for the expiry (callers pass JSON numbers; internal code may pass bigint) ─
  ok(effectiveStatus(STATUS_HOLD, Number(NOW_NS - HOUR_NS), NOW_NS) === STATUS_OPEN, "number expiry (past) → open");
  ok(effectiveStatus(STATUS_HOLD, NOW_NS - HOUR_NS, NOW_NS) === STATUS_OPEN, "bigint expiry (past) → open");

  // ── msToNs sanity ─────────────────────────────────────────────────────────────────────────────────────
  ok(msToNs(1) === 1_000_000n, "1ms = 1e6 ns");
  ok(msToNs(0) === 0n, "0ms = 0ns");

  console.log(fail === 0 ? `effective-status: ${pass}/${pass} PASS` : `effective-status: ${fail} FAILED, ${pass} passed`);
  if (fail > 0) process.exit(1);
}

main();
