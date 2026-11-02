// $VRX demo play-money slices 1–2 — freeze the fake-by-construction invariants from the design doc:
// • DEMO-FLAG-GATED: every entry point refuses unless NEXT_PUBLIC_VRX_DEMO=1 (fail-closed, can't exist in prod).
// • balance auto-seeds the base mint; mint tops up (cosmetic, fake).
// • a $VRX booking is a TIME-BOXED demo HOLD (always demo:true) that AUTO-REVERTS at expiresAt — the unit
// stops being parked with NO cleanup write (self-cleaning edge). Never settles a real obligation.
// • a demo actor can't spend play-money it doesn't have (keeps the demo coherent).
// File-backed stores bind <cwd>/.data at import time, so we chdir to a throwaway temp dir BEFORE importing.
// The demo flag is read LIVE per call (not memoised), so we toggle process.env around the gated-off assertion.
// Run via tsx.

import { promises as fs } from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vrx-demo-currency-"));
  process.chdir(tmp);
  process.env.NEXT_PUBLIC_VRX_DEMO = "1"; // arm the demo gate for the import + the happy-path cases

  const V = (await import("./vrx-demo-currency.js").catch(() => import("./vrx-demo-currency"))) as typeof import("./vrx-demo-currency");
  const {
    demoEnabled, balanceOf, mintDemo, placeDemoHold, activeDemoHoldsForUnit, demoHoldsForAccount,
    demoHoldsForBuildings, getDemoHold, isDemoHoldExpired, isDemoHoldActive, upgradeDemoHold, DEMO_BASE_MINT_VRX,
  } = V;

  const ACTOR = "agent-ann.testnet";

  // ── demo gate ────────────────────────────────────────────────────────────────────────────────────────
  ok(demoEnabled(), "demoEnabled() true when NEXT_PUBLIC_VRX_DEMO=1");
  // flip the flag OFF and prove a mutating call is refused (fail-closed — $VRX can't exist in prod)
  process.env.NEXT_PUBLIC_VRX_DEMO = "0";
  ok(!demoEnabled(), "demoEnabled() false when the flag is unset");
  let gated = false;
  try { await balanceOf(ACTOR); } catch { gated = true; }
  ok(gated, "balanceOf is REFUSED when the demo flag is off (fail-closed)");
  let gated2 = false;
  try { await placeDemoHold({ account: ACTOR, buildingId: "b", unitId: "u", amountVrx: 1 }); } catch { gated2 = true; }
  ok(gated2, "placeDemoHold is REFUSED when the demo flag is off");
  process.env.NEXT_PUBLIC_VRX_DEMO = "1"; // re-arm for the rest

  // ── balance + mint ───────────────────────────────────────────────────────────────────────────────────
  ok((await balanceOf(ACTOR)) === DEMO_BASE_MINT_VRX, "balance auto-seeds the base mint on first touch");
  ok((await balanceOf(ACTOR)) === DEMO_BASE_MINT_VRX, "a second read does NOT re-seed (idempotent)");
  const topped = await mintDemo(ACTOR, 50_000);
  ok(topped === DEMO_BASE_MINT_VRX + 50_000, "mint tops up the balance (cosmetic, fake)");
  let badMint = false;
  try { await mintDemo(ACTOR, -1); } catch { badMint = true; }
  ok(badMint, "mint refuses a non-positive amount");

  // ── demo hold: always demo:true, time-boxed ────────────────────────────────────────────────────────
  const before = await balanceOf(ACTOR);
  const hold = await placeDemoHold({ account: ACTOR, buildingId: "miracle-tower", unitId: "unit-103", amountVrx: 100_000, ttlMs: 50 });
  ok(hold.demo === true, "a demo hold ALWAYS carries demo:true (the honesty marker)");
  ok(hold.expiresAt > hold.placedAt, "a demo hold is time-boxed (expiresAt in the future)");
  ok((await balanceOf(ACTOR)) === before - 100_000, "placing a hold deducts the fake price from the balance");

  // active immediately
  ok(isDemoHoldActive(hold), "a fresh hold is active");
  ok(!isDemoHoldExpired(hold), "a fresh hold is not expired");
  ok((await activeDemoHoldsForUnit("miracle-tower", "unit-103")).length === 1, "an active hold parks the unit");

  // ── self-cleaning: after TTL the hold auto-reverts with NO cleanup write ──────────────────────────────
  await new Promise((r) => setTimeout(r, 70)); // let the 50ms TTL lapse
  const expired = (await getDemoHold(hold.id))!;
  ok(isDemoHoldExpired(expired), "the hold is expired once past expiresAt");
  ok(!isDemoHoldActive(expired), "an expired hold is no longer active");
  ok((await activeDemoHoldsForUnit("miracle-tower", "unit-103")).length === 0,
    "an expired hold stops parking the unit (self-cleaning — the unit reads available, no cleanup write)");
  ok((await getDemoHold(hold.id)) !== null, "the expired hold record still EXISTS on disk (audit) — it just isn't active");

  // ── insufficient balance refused ──────────────────────────────────────────────────────────────────────
  let broke = false;
  try { await placeDemoHold({ account: "poor-actor.testnet", buildingId: "b", unitId: "u", amountVrx: DEMO_BASE_MINT_VRX + 1 }); } catch { broke = true; }
  ok(broke, "a demo actor cannot spend more play-money than it holds");

  // ── per-account holds surface ─────────────────────────────────────────────────────────────────────────
  ok((await demoHoldsForAccount(ACTOR)).some((h) => h.id === hold.id), "demoHoldsForAccount returns the actor's holds (incl. expired, for the surface)");

  // ── per-BUILDING holds surface (the developer's upgrade view) ─────────────────────────────────────
  // The hold above is on "miracle-tower"; the developer who owns that building must see it, nobody else. It
  // returns ALL holds on the building (incl. expired/upgraded — the UI filters active), unlike activeForUnit.
  ok((await demoHoldsForBuildings(["miracle-tower"])).some((h) => h.id === hold.id),
    "demoHoldsForBuildings returns holds on the developer's building (incl. expired, for the surface)");
  ok((await demoHoldsForBuildings(["MIRACLE-TOWER"])).some((h) => h.id === hold.id),
    "demoHoldsForBuildings is case-insensitive on buildingId");
  ok((await demoHoldsForBuildings(["some-other-building"])).length === 0,
    "demoHoldsForBuildings scopes to the given buildings (no leak of another developer's holds)");
  ok((await demoHoldsForBuildings([])).length === 0, "demoHoldsForBuildings with no buildings → empty");

  // ── an upgraded hold is no longer active (slice 3 sets upgradedToRequestId; prove the active rule here) ─
  ok(!isDemoHoldActive({ ...hold, expiresAt: Date.now() + 10_000, upgradedToRequestId: "req-1" }),
    "an upgraded hold is not active (it has left the demo world — real booking)");

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // ══ SLICE 3 — upgrade path (the real-fee forcing function: demo hold → real booking) ══════════════════

  // A fresh, long-lived demo hold to upgrade (the one above already expired).
  const upUnit = { buildingId: "miracle-tower", unitId: "unit-700" };
  const upHold = await placeDemoHold({ account: ACTOR, ...upUnit, amountVrx: 10_000, ttlMs: 60_000 });
  ok(isDemoHoldActive(upHold), "the fresh hold is active before upgrade");
  ok((await activeDemoHoldsForUnit(upUnit.buildingId, upUnit.unitId)).length === 1, "the active demo hold parks the unit before upgrade");

  // ── the upgrade MUST name a real booking (no fake booking may pose as real) ───────────────────────────
  let noReq = false;
  try { await upgradeDemoHold({ holdId: upHold.id, requestId: "" }); } catch { noReq = true; }
  ok(noReq, "an upgrade with no real requestId is refused (the demo hold must become a NAMED real booking)");

  // ── a valid upgrade: the hold leaves the demo world, pointing at the real booking ─────────────────────
  const upgraded = await upgradeDemoHold({ holdId: upHold.id, requestId: "req-real-42" });
  ok(upgraded.upgradedToRequestId === "req-real-42", "the upgrade records the real booking's requestId (the handoff)");
  ok(!isDemoHoldActive(upgraded), "the upgraded hold is no longer active (it crossed into the real path)");
  ok((await activeDemoHoldsForUnit(upUnit.buildingId, upUnit.unitId)).length === 0,
    "the unit is no longer DEMO-held after upgrade (the real booking now parks it honestly, not $VRX)");

  // ── a double-upgrade is refused (would re-point a real booking) ───────────────────────────────────────
  let doubleUp = false;
  try { await upgradeDemoHold({ holdId: upHold.id, requestId: "req-real-99" }); } catch { doubleUp = true; }
  ok(doubleUp, "a second upgrade of the same hold is refused (no re-pointing a real booking)");
  ok((await getDemoHold(upHold.id))?.upgradedToRequestId === "req-real-42", "the refused double-upgrade did not change the original handoff");

  // ── an EXPIRED hold cannot be upgraded (its demo lease already reverted) ───────────────────────────────
  const shortHold = await placeDemoHold({ account: ACTOR, buildingId: "miracle-tower", unitId: "unit-701", amountVrx: 5_000, ttlMs: 30 });
  await new Promise((r) => setTimeout(r, 50));
  let upExpired = false;
  try { await upgradeDemoHold({ holdId: shortHold.id, requestId: "req-real-x" }); } catch { upExpired = true; }
  ok(upExpired, "an expired demo hold cannot be upgraded (place a fresh real booking instead)");

  // ── upgrade is demo-gated (fail-closed in prod) ───────────────────────────────────────────────────────
  const gateHold = await placeDemoHold({ account: ACTOR, buildingId: "miracle-tower", unitId: "unit-702", amountVrx: 5_000, ttlMs: 60_000 });
  process.env.NEXT_PUBLIC_VRX_DEMO = "0";
  let upGated = false;
  try { await upgradeDemoHold({ holdId: gateHold.id, requestId: "req-real-y" }); } catch { upGated = true; }
  ok(upGated, "upgradeDemoHold is REFUSED when the demo flag is off (fail-closed — $VRX can't exist in prod)");
  process.env.NEXT_PUBLIC_VRX_DEMO = "1";

  console.log(`\nvrx-demo-currency (slices 1–3 + the developer upgrade view): ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
