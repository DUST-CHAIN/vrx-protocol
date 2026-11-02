// Tests for lib/backfill-dates — the timestamp POST-PASS of the dated off-chain backfill.
// Pins the real deliverable (BACKFILL_DESIGN_S130 §5): the dated world is internally consistent AND every
// SEALED record still ✓-verifies after its date was rewritten (re-chain / re-seal, not a bare overwrite).
// The post-pass binds.data at <cwd>/.data, so we chdir to a throwaway temp dir BEFORE importing it — the
// real repo.data is never touched. Run via tsx (same harness as the other lib/*.test.ts).

import { promises as fs } from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

const DAY = 86_400_000;

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vrx-backfill-"));
  process.chdir(tmp);
  await fs.mkdir(path.join(tmp, ".data"), { recursive: true });

  const BF = await import("./backfill-dates.js").catch(() => import("./backfill-dates"));
  const { resolveDealDates, launchDates, assertInvariants, backfillDates, freshWipeSeedRows } =
    BF as typeof import("./backfill-dates");
  const baselineLib = await import("./sale-baseline.js").catch(() => import("./sale-baseline")) as typeof import("./sale-baseline");
  const agreementLib = await import("./agreements.js").catch(() => import("./agreements")) as typeof import("./agreements");
  const channelLib = await import("./channels.js").catch(() => import("./channels")) as typeof import("./channels");

  const now = 1_792_000_000_000; // fixed so dates are deterministic

  // ── resolveDealDates: monotonic, strictly past ──────────────────────────────────────────────────────
  const targets = [
    {
      kind: "offer" as const, key: "req-A", developer: "d1.testnet", building: "miracle-tower",
      schedule: { arrivalDaysAgo: 200, dwell: { toConfirm: 2, toPreviewFinal: 5, toPaymentArrived: 3, toSigned: 2 }, archetype: "trickle" as const, outcome: "close" as const },
    },
    {
      kind: "offer" as const, key: "req-B", developer: "d1.testnet", building: "pearls-view",
      schedule: { arrivalDaysAgo: 60, dwell: { toConfirm: 0 }, archetype: "opening_event" as const, outcome: "lapse" as const },
    },
  ];
  const deals = resolveDealDates(now, targets);
  const a = deals[0];
  ok(a.arrivalAt === now - 200 * DAY, "arrival = now - daysAgo");
  ok(a.confirmAt! > a.arrivalAt && a.previewFinalAt! > a.confirmAt! && a.paymentArrivedAt! > a.previewFinalAt! && a.signedAt! > a.paymentArrivedAt!, "stage dates strictly increasing");
  ok(a.signedAt! < now, "all dates strictly before now");
  const b = deals[1];
  ok(b.confirmAt! > b.arrivalAt && b.confirmAt! < now, "a 0-day dwell still advances by >=1ms and stays < now");

  // ── launchDates: launch strictly before each building's earliest deal, staggered per cluster ─────────
  const launch = launchDates(now, deals);
  const lA = launch.get("d1.testnet|miracle-tower")!;
  const lB = launch.get("d1.testnet|pearls-view")!;
  ok(lA < a.arrivalAt, "launch(miracle) < its earliest deal");
  ok(lB < b.arrivalAt, "launch(pearls) < its earliest deal");
  ok(lA !== lB, "distinct buildings get distinct (staggered) launch eras");

  // ── assertInvariants: passes on good, throws on bad ──────────────────────────────────────────────────
  let threw = false;
  try { assertInvariants(now, deals, launch); } catch { threw = true; }
  ok(!threw, "assertInvariants passes on a consistent world");
  threw = false;
  try {
    const bad = [{ ...a, arrivalAt: now + DAY }]; // arrival in the FUTURE
    assertInvariants(now, bad, launch);
  } catch { threw = true; }
  ok(threw, "assertInvariants THROWS on a future-dated deal");

  // ── INTEGRATION: a SEALED baseline + agreement + a chained thread must still ✓-verify after re-dating ──
  // Establish a real baseline (sealed), then date it back via the post-pass and re-verify.
  const bl = await baselineLib.establishBaseline({ developer: "d1.testnet", building: "miracle-tower", availableUnits: ["unit-101", "unit-102"] });
  ok(bl != null, "baseline established");
  const blVerifyBefore = await baselineLib.getBaseline("d1.testnet", "miracle-tower");
  ok(blVerifyBefore != null && baselineLib.verifyBaseline(blVerifyBefore), "baseline verifies before re-date");

  // A real sealed agreement.
  const agr = await agreementLib.proposeAgreement({
    agency: "ag1.testnet", developer: "d1.testnet",
    buildings: [{ buildingId: "miracle-tower", commissionPct: 3, scope: "whole" }],
    terms: "Standard", by: "agency", proposedAt: now,
  });
  ok(agr != null, "agreement proposed");
  ok(await agreementLib.verifyAgreement(agr), "agreement verifies before re-date");

  // A chained booking thread (keyed by the offer requestId).
  await channelLib.postMessage({ requestId: "req-A", from: "agent", by: "ag1.testnet", text: "Booked unit-101." });
  await channelLib.postMessage({ requestId: "req-A", from: "developer", by: "d1.testnet", text: "Confirmed." });
  const chainBefore = await channelLib.verifyChain("req-A");
  ok(chainBefore.ok, "thread chain verifies before re-date");

  // Write offers so the post-pass + freshWipe can see them. Four shapes exercise the reclaim rule:
  // (1) req-A — a current seed offer → WIPED (origin:"seed")
  // (2) req-REAL — a true hand-made offer on a NON-seeded developer, no origin → KEPT (the thing we protect)
  // (3) req-STALE — a pre-marker offer on a SEEDED developer (vvv-dev-01), no origin → WIPED (isSeedDeveloper)
  // (4) test-req-x — ad-hoc test junk by reqId pattern → WIPED (isTestJunkOffer)
  await fs.writeFile(path.join(tmp, ".data", "offers.json"), JSON.stringify([
    { requestId: "req-A", requestHash: "h", developer: "d1.testnet", seal: {}, display: { buildingId: "miracle-tower", unitId: "unit-101", origin: "seed" }, at: now, confirmed: { at: now, by: "d1.testnet" }, contract: { stage: "signed", finalAt: now, paymentArrivedAt: now, signedAt: now } },
    { requestId: "req-REAL", requestHash: "h2", developer: "d1.testnet", seal: {}, display: { buildingId: "pearls-view", unitId: "unit-9" }, at: now },
    { requestId: "req-STALE", requestHash: "h3", developer: "vvv-dev-01.testnet", seal: {}, display: { buildingId: "miracle-tower", unitId: "unit-101" }, at: now },
    { requestId: "test-req-999", requestHash: "h4", developer: "test-dev.testnet", seal: {}, display: { buildingId: "x", unitId: "unit-1" }, at: now },
  ], null, 2), "utf8");

  // Run the post-pass.
  const report = await backfillDates(targets, now);
  ok(report.baselinesResealed >= 1, "post-pass re-sealed the baseline");
  ok(report.agreementsResealed >= 1, "post-pass re-sealed the agreement");
  ok(report.threadsRechained >= 1, "post-pass re-chained the thread");
  ok(report.offersDated >= 1, "post-pass dated the offer");

  // THE CRITICAL ASSERTIONS: every sealed record STILL verifies after its date was rewritten.
  const blAfter = await baselineLib.getBaseline("d1.testnet", "miracle-tower");
  ok(blAfter != null && blAfter.establishedAt < a.arrivalAt, "baseline establishedAt moved to before the first deal");
  ok(blAfter != null && baselineLib.verifyBaseline(blAfter), "RE-SEALED baseline still ✓-verifies after re-date");

  const agrs = await agreementLib.agreementsForParty("d1.testnet");
  const reloadedAgr = agrs.find((g) => g.id === agr.id) ?? agr;
  ok(await agreementLib.verifyAgreement(reloadedAgr), "RE-SEALED agreement still ✓-verifies after re-date");

  const chainAfter = await channelLib.verifyChain("req-A");
  ok(chainAfter.ok, "RE-CHAINED thread still verifies after re-date (the §7 hazard, handled)");

  // ── freshWipeSeedRows: wipes seed + STALE (seeded-dev) + JUNK rows; KEEPS the true hand-made one ──
  const w = await freshWipeSeedRows();
  ok(w.offersRemoved === 3, "freshWipe removed the seed + stale + junk offers (3), not the hand-made one");
  ok(w.threadsRemoved === 1, "freshWipe removed the seed offer's thread");
  const offersLeft = JSON.parse(await fs.readFile(path.join(tmp, ".data", "offers.json"), "utf8"));
  ok(offersLeft.length === 1 && offersLeft[0].requestId === "req-REAL", "the hand-made offer on a non-seeded developer survives the wipe");

  console.log(`\nbackfill-dates.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error("backfill-dates.test crashed:", e); process.exit(1); });
