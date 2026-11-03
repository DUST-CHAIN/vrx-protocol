// the fail-closed BOOKABLE gate. Freeze the invariant: a unit is bookable IFF its building
// is on contract (a sale baseline exists) AND the unit is stamped OPEN (snapshot status 0). Everything else —
// pre-contract (no baseline), not-stamped (-1), held (1), closed (2), done (3), a unit missing from the
// snapshot, a building with no snapshot at all — is NOT bookable (fail-closed). Covers every status ×
// on/off-contract, the reason codes, and the plain-language messages.
//
// File-backed stores bind <cwd>/.data at import time + status-store MEMOISES the snapshot on first read, so we
// chdir to a throwaway temp dir and write the snapshot file BEFORE importing anything that reads it. Run via tsx.

import { promises as fs } from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vrx-bookable-"));
  process.chdir(tmp);
  await fs.mkdir(path.join(tmp, ".data"), { recursive: true });

  // Seed the status snapshot directly (the durable on-chain mirror). One ON-contract building with every
  // status code present, plus a building we'll leave OFF-contract.
  const snapshot = {
    "on-tower": {
      units: {
        "u-open": 0,   // open  → bookable (when on contract)
        "u-hold": 1,   // hold
        "u-closed": 2, // closed
        "u-done": 3,   // done
        "u-raw": -1,   // not stamped
      },
      filledAt: Date.now(),
      complete: true,
    },
    "off-tower": {
      units: { "u-open": 0 }, // open, but the building never went on contract
      filledAt: Date.now(),
      complete: true,
    },
  };
  await fs.writeFile(path.join(tmp, ".data", "status-snapshot.json"), JSON.stringify(snapshot), "utf8");

  const B = (await import("./bookable.js").catch(() => import("./bookable"))) as typeof import("./bookable");
  const SB = (await import("./sale-baseline.js").catch(() => import("./sale-baseline"))) as typeof import("./sale-baseline");
  const { isBookable, bookableResult } = B;

  // Put ONLY on-tower on contract (a baseline establishes "released"). off-tower gets none.
  await SB.establishBaseline({ developer: "dev.testnet", building: "on-tower", availableUnits: ["u-open"] });

  // ── ON CONTRACT × every status ──────────────────────────────────────────────────────────────────────
  ok(await isBookable("dev.testnet", "on-tower", "u-open"), "on-contract + open (0) → bookable");
  ok(!(await isBookable("dev.testnet", "on-tower", "u-hold")), "on-contract + hold (1) → NOT bookable");
  ok(!(await isBookable("dev.testnet", "on-tower", "u-closed")), "on-contract + closed (2) → NOT bookable");
  ok(!(await isBookable("dev.testnet", "on-tower", "u-done")), "on-contract + done (3) → NOT bookable");
  ok(!(await isBookable("dev.testnet", "on-tower", "u-raw")), "on-contract + not-stamped (-1) → NOT bookable");
  ok(!(await isBookable("dev.testnet", "on-tower", "u-ghost")), "on-contract + unit absent from snapshot → NOT bookable");

  // ── OFF CONTRACT: even an open unit is NOT bookable (pre-contract fails first) ────────────────────────
  ok(!(await isBookable("dev.testnet", "off-tower", "u-open")), "off-contract + open (0) → NOT bookable (pre_contract)");

  // ── building with NO snapshot at all, but somehow on contract → fail-closed ───────────────────────────
  await SB.establishBaseline({ developer: "dev.testnet", building: "no-snap-tower", availableUnits: ["x"] });
  ok(!(await isBookable("dev.testnet", "no-snap-tower", "x")), "on-contract but no snapshot → NOT bookable");

  // ── baseline is PER (developer, building): the wrong developer isn't on contract ──────────────────────
  ok(!(await isBookable("other.testnet", "on-tower", "u-open")), "other developer (no baseline of theirs) → NOT bookable");
  // developer is normalized (lowercased) the same way the baseline store does it.
  ok(await isBookable("DEV.testnet", "on-tower", "u-open"), "developer case-insensitive (baseline lowercases)");

  // ── reason codes + plain-language messages ───────────────────────────────────────────────────────────
  const rOk = await bookableResult("dev.testnet", "on-tower", "u-open");
  ok(rOk.ok === true, "bookableResult ok:true for the bookable unit");

  const rPre = await bookableResult("dev.testnet", "off-tower", "u-open");
  ok(rPre.ok === false && rPre.reason === "pre_contract", "off-contract → reason pre_contract");
  ok(rPre.ok === false && typeof rPre.message === "string" && rPre.message.length > 0, "pre_contract carries a plain message");

  const rNot = await bookableResult("dev.testnet", "on-tower", "u-raw");
  ok(rNot.ok === false && rNot.reason === "not_open", "not-stamped → reason not_open");
  ok(rNot.ok === false && typeof rNot.message === "string" && rNot.message.length > 0, "not_open carries a plain message");

  // ── blank inputs → fail-closed (no baseline resolves for a blank pair) ────────────────────────────────
  ok(!(await isBookable("", "on-tower", "u-open")), "blank developer → NOT bookable");
  ok(!(await isBookable("dev.testnet", "", "u-open")), "blank building → NOT bookable");

  // ──: the pending-approval HOLD flows through the bookable gate ──────────────────────────────────
  // u-open is on-contract + stamped OPEN (bookable above). Open a version-gated change over it → it must read
  // as NOT bookable with the specific held_pending_approval CODE but a NEUTRAL message (same as not_open), so a
  // booking agent can't tell a change is in review while the developer's UI can color it distinctly.
  const IV = (await import("./inventory-version.js").catch(() => import("./inventory-version"))) as typeof import("./inventory-version");
  const hv = (await IV.openVersion({ developer: "dev.testnet", building: "on-tower", changeClass: "priceUp", changeset: { "u-open": { from: 450000, to: 480000 } } }))!;

  const rHeld = await bookableResult("dev.testnet", "on-tower", "u-open");
  ok(rHeld.ok === false && rHeld.reason === "held_pending_approval", "unit in an OPEN version → reason held_pending_approval");
  // The neutral wording: byte-identical to the not_open message, and says nothing about a review/approval.
  ok(rHeld.ok === false && rNot.ok === false && rHeld.message === rNot.message, "held unit's message is the NEUTRAL not-available wording (identical to not_open, no leak)");
  ok(rHeld.ok === false && !/approv|review|pending|chang/i.test(rHeld.message), "held message leaks no 'approval/review/pending/change' hint to the agent");
  ok(!(await isBookable("dev.testnet", "on-tower", "u-open")), "held unit → NOT bookable");
  // A different open unit in the same building is NOT affected (the hold is per-unit).
  // (none other is stamped open here, so assert the gate is unit-scoped via heldUnits already covered.)

  // APPROVE the version → the change landed; the hold releases; the unit is bookable again.
  await IV.decideVersion({ building: "on-tower", version: hv.version, decision: "approved", by: "dev.testnet" });
  ok(await isBookable("dev.testnet", "on-tower", "u-open"), "approved version → hold released → bookable again");

  // A FRESH open version then REJECTED → the write never happened; the unit is bookable on the OLD figures.
  const hv2 = (await IV.openVersion({ developer: "dev.testnet", building: "on-tower", changeClass: "priceUp", changeset: { "u-open": { from: 480000, to: 999999 } } }))!;
  ok(!(await isBookable("dev.testnet", "on-tower", "u-open")), "fresh open version → held again");
  await IV.decideVersion({ building: "on-tower", version: hv2.version, decision: "rejected", by: "dev.testnet" });
  ok(await isBookable("dev.testnet", "on-tower", "u-open"), "rejected version → hold lifts → bookable on old figures");

  console.log(`bookable.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
