// Pin the in-process change bus (lib/bus: publish / subscribe / subscriberCount / currentRevision).
//
// WHY THIS MATTERS (not just coverage): the bus is the seam between "a shared store changed" and "push
// to connected clients" (real-time, swappable transport). Its contract carries two guarantees the
// whole real-time layer leans on and that are easy to regress:
//  1. publish NEVER THROWS, even when a listener throws — a single broken SSE subscriber must not break
//      the STORE WRITER that called publish, nor the OTHER subscribers. (A regression here = one dropped
//      browser connection takes down every writer / every other client's live updates.)
//   2. revision is MONOTONIC and bumps exactly once per publish — a reconnecting client compares it to
//      detect a missed tick, so an off-by-one or a non-bump silently loses real-time updates.
// Plus the plumbing: subscribe returns a working unsubscribe, subscriberCount tracks sub/unsub (the sync
// loop idles on 0 to avoid burning FastNEAR quota for an empty room). The module is already a pure in-memory
// unit (no network/timers), so this pins it as-is with no refactor. Run via tsx.

import { publish, subscribe, subscriberCount, currentRevision } from "./bus";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

function main() {
  // ── subscriberCount starts at 0 (fresh module) and tracks sub/unsub ──────────────────────────────────
  ok(subscriberCount() === 0, "subscriberCount starts at 0 (nobody watching)");
  const unsubA = subscribe(() => {});
  ok(subscriberCount() === 1, "subscribe increments subscriberCount");
  const unsubB = subscribe(() => {});
  ok(subscriberCount() === 2, "a second subscribe increments again");
  unsubA();
  ok(subscriberCount() === 1, "unsubscribe decrements subscriberCount");
  // unsubscribe is idempotent — calling it twice must not drive the count negative or affect others
  unsubA();
  ok(subscriberCount() === 1, "calling an unsubscribe twice is a no-op (Set delete), count stays 1");
  unsubB();
  ok(subscriberCount() === 0, "all unsubscribed → back to 0 (sync loop idles here)");

  // ── revision is monotonic: bumps exactly once per publish, even with NO listeners ────────────────────
  const r0 = currentRevision();
  publish("events");
  ok(currentRevision() === r0 + 1, "publish bumps revision by exactly 1 (even with no subscribers)");
  publish("events");
  publish("channel:req-1");
  ok(currentRevision() === r0 + 3, "revision is monotonic across multiple publishes");

  // ── publish delivers the topic to every current subscriber ───────────────────────────────────────────
  {
    const seen: string[] = [];
    const u1 = subscribe((t) => seen.push("1:" + t));
    const u2 = subscribe((t) => seen.push("2:" + t));
    publish("events");
    ok(seen.includes("1:events") && seen.includes("2:events"), "publish notifies every subscriber with the topic");
    // after unsubscribe, a listener no longer receives
    u1();
    seen.length = 0;
    publish("channel:x");
    ok(seen.length === 1 && seen[0] === "2:channel:x", "unsubscribed listener stops receiving; the topic string passes through verbatim");
    u2();
  }

  // ── THE KEY GUARANTEE: a throwing listener must not break publish, the writer, or other subscribers ──
  {
    const got: string[] = [];
    const uGood1 = subscribe(() => got.push("good1"));
    const uBad = subscribe(() => { throw new Error("broken subscriber"); });
    const uGood2 = subscribe(() => got.push("good2"));
    const revBefore = currentRevision();
    let threw = false;
    try { publish("events"); } catch { threw = true; }
    ok(!threw, "publish does NOT throw even when a listener throws (protects the store writer)");
    ok(got.includes("good1") && got.includes("good2"), "a broken subscriber does not stop the OTHER subscribers from being notified");
    ok(currentRevision() === revBefore + 1, "revision still advances exactly once despite the listener error");
    uGood1(); uBad(); uGood2();
    ok(subscriberCount() === 0, "cleanup: all test listeners removed");
  }

  console.log(fail === 0 ? `bus: ${pass}/${pass} PASS` : `bus: ${fail} FAILED, ${pass} passed`);
  if (fail > 0) process.exit(1);
}

main();
