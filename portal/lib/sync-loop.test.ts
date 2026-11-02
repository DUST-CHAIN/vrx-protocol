// Pin the sync-loop tick DECISION (lib/sync-loop: tickDecision) — extracted.
// WHY THIS MATTERS (not just coverage): this predicate IS the quota-protection logic of the server-side
// sync loop. It decides, each beat, whether to stop / skip / run:
// • "stop" — nobody is watching → the loop shuts down so an idle server does ZERO RPC work. This is the
// whole replacement for the 60s browser poll that caused the /api/* 120/min 429s: if this ever returned
// "run"/"skip" on an empty room, an idle server would quietly burn FastNEAR quota forever.
// • "skip" — a previous tick is still in flight (slow archival round-trips) → don't overlap sync calls.
// • "run" — audience present and idle → sync.
// ORDER is the subtle, regress-prone part: the empty-room check must WIN over the in-flight check (stop beats
// skip) — otherwise a loop that's mid-tick when the last client leaves could skip instead of stop and keep
// ticking. The rest of sync-loop is setInterval/singleton glue (not unit-testable without timers); this is the
// one pure decision worth owning. Run via tsx.

import { tickDecision } from "./sync-loop";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

function main() {
  // ── empty room → stop, regardless of ticking (the zero-RPC-when-idle invariant) ──────────────────────
  ok(tickDecision(0, false) === "stop", "no subscribers + idle → stop (idle server does zero RPC work)");
  ok(tickDecision(0, true) === "stop", "no subscribers wins even mid-tick → stop (stop beats skip, the subtle order)");

  // ── audience present but a tick already running → skip this beat (no overlapping sync) ───────────────
  ok(tickDecision(1, true) === "skip", "subscribers present + already ticking → skip (no overlap)");
  ok(tickDecision(5, true) === "skip", "more subscribers, still ticking → skip");

  // ── audience present and idle → run the sync ─────────────────────────────────────────────────────────
  ok(tickDecision(1, false) === "run", "one subscriber + idle → run");
  ok(tickDecision(99, false) === "run", "many subscribers + idle → run");

  console.log(fail === 0 ? `sync-loop: ${pass}/${pass} PASS` : `sync-loop: ${fail} FAILED, ${pass} passed`);
  if (fail > 0) process.exit(1);
}

main();
