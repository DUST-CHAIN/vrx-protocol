//  item 3 — the versioned inventory store + freeze gate. Freeze the spine:
// openVersion appends a sealed, hash-chained version (genesis priorHash on v1, chained after), lowercases the
// developer, defaults the approver to the developer; decideVersion approves/rejects only an OPEN version and
// only by the approver; canEdit is the freeze gate — ALLOW pre-contract, ALLOW self-serve on-contract, REFUSE
// a version-gated class on-contract until an APPROVED matching version exists; verifyChain catches a broken
// link / bad seal / non-contiguity; reconstructVersion replays only APPROVED changesets; tamper fails verify.
//
// File-backed stores bind <cwd>/.data at import time → chdir to a throwaway temp BEFORE importing. Run via tsx.

import { promises as fs } from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vrx-inventory-version-"));
  process.chdir(tmp);

  const V = (await import("./inventory-version.js").catch(() => import("./inventory-version"))) as typeof import("./inventory-version");
  const P = (await import("./dev-edit-policy.js").catch(() => import("./dev-edit-policy"))) as typeof import("./dev-edit-policy");
  const B = (await import("./sale-baseline.js").catch(() => import("./sale-baseline"))) as typeof import("./sale-baseline");
  const {
    openVersion, decideVersion, versionsForBuilding, latestVersion,
    canEdit, verifyChain, verifyVersion, reconstructVersion, GENESIS_PRIOR,
    heldUnits, isHeldPendingApproval,
  } = V;

  const DEV = "summit-dev.testnet";
  const BLD = "miracle-tower";

  // ── openVersion: bad input refused ──
  ok((await openVersion({ developer: "", building: BLD, changeClass: "priceUp", changeset: {} })) === null, "blank developer → refused");

  // ── openVersion: v1 chains to GENESIS, seals + verifies, approver defaults to developer ──
  const v1 = (await openVersion({ developer: "Summit-Dev.TESTNET", building: BLD, changeClass: "priceUp", changeset: { "unit-501": { from: 450000, to: 480000 } } }))!;
  ok(!!v1, "v1 opened");
  ok(v1.by === DEV, "developer lowercased");
  ok(v1.version === 1 && v1.priorHash === GENESIS_PRIOR, "v1 is version 1, chained to genesis");
  ok(v1.approver === DEV && v1.approverRole === "developer", "approver defaults to the developer");
  ok(v1.status === "open", "v1 starts open (not yet effective)");
  ok(verifyVersion(v1), "v1 seal verifies");

  // ── openVersion: v2 chains to v1's sealHash ──
  const v2 = (await openVersion({ developer: DEV, building: BLD, changeClass: "addUnit", changeset: { add: "unit-999" } }))!;
  ok(v2.version === 2 && v2.priorHash === v1.sealHash, "v2 is version 2, priorHash = v1 sealHash (chained)");
  ok(verifyVersion(v2), "v2 seal verifies");
  ok((await verifyChain(BLD)) === true, "chain verifies end-to-end (2 links)");
  ok((await latestVersion(BLD))!.version === 2, "latestVersion is v2");

  // ── decideVersion: only the approver, only an OPEN version ──
  ok((await decideVersion({ building: BLD, version: 1, decision: "approved", by: "someone-else.testnet" })) === null, "non-approver cannot decide");
  const v1a = (await decideVersion({ building: BLD, version: 1, decision: "approved", by: DEV }))!;
  ok(v1a.status === "approved" && typeof v1a.decidedAt === "number", "v1 approved by its approver");
  const v1redecide = (await decideVersion({ building: BLD, version: 1, decision: "rejected", by: DEV }))!;
  ok(v1redecide.status === "approved", "re-deciding a decided version is a no-op (stays approved)");
  const v2r = (await decideVersion({ building: BLD, version: 2, decision: "rejected", by: DEV }))!;
  ok(v2r.status === "rejected", "v2 rejected");
  ok((await decideVersion({ building: BLD, version: 99, decision: "approved", by: DEV })) === null, "decide unknown version → null");

  // ── the FREEZE GATE (canEdit) ──
  // No policy + no baseline yet → pre-contract ALLOW (nothing frozen before go-on-contract).
  ok((await canEdit(DEV, "fresh-building", "addUnit")).allowed === true, "pre-contract → allowed (not frozen yet)");

  // Seed a conservative policy (priceDown=notify self-serve, priceUp/addUnit=approve gated) + go on contract.
  await P.ensurePolicy({ developer: DEV, preset: "conservative" });
  await B.establishBaseline({ developer: DEV, building: BLD, availableUnits: ["unit-501"] });

  // On contract + self-serve class → ALLOW straight through.
  const selfServe = await canEdit(DEV, BLD, "priceDown");
  ok(selfServe.allowed === true && selfServe.via === "self_serve", "on-contract self-serve class → allowed (self_serve)");

  // On contract + version-gated class, latest matching version is REJECTED → REFUSE.
  // (latest version for BLD is v2 addUnit=rejected; try to edit addUnit)
  const refusedAdd = await canEdit(DEV, BLD, "addUnit");
  ok(refusedAdd.allowed === false && refusedAdd.reason === "needs_version", "on-contract gated class, no approved version → refused");

  // Open + APPROVE a fresh priceUp version → the gate for priceUp now ALLOWs via approved_version.
  const v3 = (await openVersion({ developer: DEV, building: BLD, changeClass: "priceUp", changeset: { "unit-501": { to: 500000 } } }))!;
  ok(v3.version === 3 && v3.priorHash === v2r.sealHash, "v3 chained after v2 (append-only incl. rejected)");
  const refusedBeforeApprove = await canEdit(DEV, BLD, "priceUp");
  ok(refusedBeforeApprove.allowed === false, "gated class with only an OPEN (unapproved) version → still refused");
  await decideVersion({ building: BLD, version: 3, decision: "approved", by: DEV });
  const allowedAfter = await canEdit(DEV, BLD, "priceUp");
  ok(allowedAfter.allowed === true && allowedAfter.via === "approved_version", "gated class with a matching APPROVED latest version → allowed");

  // A different gated class is still refused (the approved version only covers priceUp, latest is priceUp).
  ok((await canEdit(DEV, BLD, "removeUnit")).allowed === false, "a different gated class is still refused");

  // ── Slice 1: a TIER-0 IMMUTABLE class (land) is REFUSED outright — no version unlocks it ──
  // Uses its OWN building (IMBLD) so opening a land version here does not pollute BLD's chain (the
  // reconstruct/disk assertions below depend on BLD having exactly v1/v2/v3).
  const IMBLD = "immutable-tower";
  await B.establishBaseline({ developer: DEV, building: IMBLD, availableUnits: ["im-1"] });
  const immutable = await canEdit(DEV, IMBLD, "land");
  ok(immutable.allowed === false && immutable.reason === "immutable", "on-contract immutable class (land) → refused with reason 'immutable'");
  // Even after opening + APPROVING a land version, the gate STILL refuses (immutable is checked before version logic).
  const vLand = (await openVersion({ developer: DEV, building: IMBLD, changeClass: "land", changeset: { titleDeedNum: "X" } }))!;
  await decideVersion({ building: IMBLD, version: vLand.version, decision: "approved", by: DEV });
  const stillImmutable = await canEdit(DEV, IMBLD, "land");
  ok(stillImmutable.allowed === false && stillImmutable.reason === "immutable", "an APPROVED land version does NOT unlock it — immutable means immutable (only a VRX correction, Slice 5)");

  // ── reconstructVersion: only APPROVED changesets, in order ──
  const replay = await reconstructVersion(BLD);
  ok(replay.length === 2, "reconstruct replays only the 2 APPROVED versions (v1 + v3, not rejected v2)");
  ok(replay[0].version === 1 && replay[1].version === 3, "replay is ordered oldest→newest, rejected skipped");
  ok((await reconstructVersion(BLD, 1)).length === 1, "reconstruct upTo=1 returns only v1");
  ok((await reconstructVersion("unknown")).length === 0, "reconstruct unknown building → []");

  // ── durable on disk ──
  // The store is a single shared file across all buildings, so count THIS building's rows (BLD), not the whole
  // file (other test buildings — e.g. the immutable-tower — share the store).
  const raw = JSON.parse(await fs.readFile(path.join(tmp, ".data", "inventory-versions.json"), "utf8")) as Array<{ building: string }>;
  const bldRows = raw.filter((r) => r.building === BLD);
  ok(Array.isArray(raw) && bldRows.length === 3, "versions persisted to disk (BLD: v1+v2+v3)");

  // ── verifyChain catches tamper ──
  ok(verifyVersion({ ...v3, changeset: { "unit-501": { to: 999999 } } }) === false, "tampered changeset fails verify");
  ok(verifyVersion({ ...v3, priorHash: "forged" }) === false, "tampered priorHash fails verify (chain link is sealed)");
  ok(verifyVersion({ ...v1, salt: "" }) === false, "missing salt → false (never a silent pass)");

  // ──: the PENDING-APPROVAL HOLD (heldUnits / isHeldPendingApproval) ──
  const HBLD = "held-tower";
  // An OPEN priceUp version over two units → both held.
  const hv1 = (await openVersion({ developer: DEV, building: HBLD, changeClass: "priceUp", changeset: { "h-1": { from: 100, to: 120 }, "h-2": { from: 200, to: 260 } } }))!;
  let held = await heldUnits(HBLD);
  ok(held.has("h-1") && held.has("h-2") && held.size === 2, "open priceUp version holds exactly its two units");
  ok(await isHeldPendingApproval(HBLD, "h-1"), "isHeldPendingApproval true for a held unit");
  ok(!(await isHeldPendingApproval(HBLD, "h-3")), "a unit not in the open changeset is not held");
  // APPROVE it → the change landed, hold releases.
  await decideVersion({ building: HBLD, version: hv1.version, decision: "approved", by: DEV });
  held = await heldUnits(HBLD);
  ok(held.size === 0, "approved version releases the hold (change landed)");
  // A NEW open version over one unit → only that unit held again.
  await openVersion({ developer: DEV, building: HBLD, changeClass: "priceUp", changeset: { "h-1": { from: 120, to: 150 } } });
  held = await heldUnits(HBLD);
  ok(held.has("h-1") && held.size === 1, "a fresh open version re-holds only its unit");
  // REJECT it → the write never happened; hold lifts, unit free on old figures.
  const hvLatest = (await latestVersion(HBLD))!;
  await decideVersion({ building: HBLD, version: hvLatest.version, decision: "rejected", by: DEV });
  ok((await heldUnits(HBLD)).size === 0, "rejected version lifts the hold (write never happened; old figures stand)");
  // An addUnit (control-keyed) open version holds NO existing unit.
  await openVersion({ developer: DEV, building: HBLD, changeClass: "addUnit", changeset: { add: "h-9" } });
  ok(!(await heldUnits(HBLD)).has("h-9") && !(await heldUnits(HBLD)).has("add"), "addUnit changeset holds no existing unit (control key ignored)");
  ok((await heldUnits("unknown-held-building")).size === 0, "unknown building → no held units");

  // ──: a version opened with an EXPLICIT approver (the CEO path) carries it, and ONLY that
  //    approver can decide — the wiring that lets /root point a developer's approver at a CEO wallet. This is
  //    what request-approval now does (it reads the policy's approver and passes it here). ──
  const CEO = "ceo.vrx.testnet";
  const cv = (await openVersion({ developer: DEV, building: "ceo-tower", changeClass: "priceUp", changeset: { "c-1": { from: 100, to: 130 } }, approver: CEO, approverRole: "ceo" }))!;
  ok(cv.approver === CEO && cv.approverRole === "ceo", "explicit approver is stamped onto the version (CEO path)");
  ok((await decideVersion({ building: "ceo-tower", version: cv.version, decision: "approved", by: DEV })) === null, "the DEVELOPER cannot decide a CEO-approver version");
  ok((await isHeldPendingApproval("ceo-tower", "c-1")), "unit stays held while the CEO hasn't decided");
  const cvDecided = (await decideVersion({ building: "ceo-tower", version: cv.version, decision: "approved", by: CEO }))!;
  ok(cvDecided.status === "approved", "the CEO (the version's approver) CAN decide it");
  ok(!(await isHeldPendingApproval("ceo-tower", "c-1")), "hold lifts once the CEO approves");

  console.log(`\ninventory-version: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
