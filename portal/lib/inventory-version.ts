// VERSIONED INVENTORY — SERVER-ONLY (file-backed). The append-only, hash-chained version history of a
// building's vetted inventory, and the FREEZE GATE that blocks a version-gated structural edit after the
// building has gone on contract (item 3 of the vetting/release lifecycle). Design:
// docs/DESIGN_vetting_release_lifecycle.md §"PINNED " + §"Freeze + versioning".
//
// ── The model ───────────────────────────────────────────────────────────────────────────────────
// Once a building goes on contract (a sale baseline exists — the sign-off), its vetted structure is frozen.
// A SELF-SERVE change (the developer's policy maps the change class → "notify") takes effect immediately and
// just emits a notice. A VERSION-GATED change (class → "approve") is REFUSED unless the developer first opens
// a new sealed version and it is APPROVED. Each version is CHANGESET-shaped and HASH-CHAINED to the prior:
//
//   { building, version, at, by, approver, approverRole, changeClass, changeset, priorHash, salt, sealHash, status }
//
// WHY A CHANGESET CHAIN, NOT A SNAPSHOT: a hash-chained changeset is already dispute-proof — breaking
// any link breaks every seal after it, so the chain itself proves "on date D unit-501 went 450k→480k, signed
// by X, history unrewritten". A full per-version snapshot adds no PROOF, only the convenience of reading a
// past state without replaying the chain — which for a catalog that is already the live truth is trivial. So
// the snapshot is DERIVABLE (reconstructVersion replays the chain), never stored N times (storing
// snapshots now = paying the full cost before V7/on-chain is final). A dispute workflow wanting frozen
// snapshots later is a clean ADDITIVE step.
//
// ── The approval lifecycle of one version ──────────────────────────────────────────────────────────────
// open  →  a developer opened a version-gated change; NOT yet effective (the freeze gate still blocks the edit)
// approved  →  the approver (developer-themselves by default, a VRX/CEO approver later — the single `approver`
//  abstraction) signed it off; the edit may now land
// rejected  →  the approver refused it; the change never takes effect (terminal; open a new version to retry)
// The chain only ever grows (append-only); a rejected version stays in the history as an attested fact.
//
// ── The seal spine ─────────────────────────────────────────────────────────────────────────
// Nth consumer of the attested-record spine. Salted seal (lib/seal) over the stable version fields INCLUDING
// priorHash, so the whole chain is tamper-evident end-to-end. A version's seal binds it to its predecessor.
//
// PRIVACY: SERVER-ONLY; neutral developer/approver accounts + opaque building id + an opaque change
// class + the changeset payload (whatever the caller attests — this store does NOT interpret it). The
// changeset MAY carry prices/sizes (it is the developer's own attested record of their own change); it is
// NEVER surfaced to another party by this store, and NEVER goes on-chain. Serialized writes (guard).

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";
import type { ChangeClass, ApproverRole } from "./dev-edit-policy";
import { dispositionOf } from "./dev-edit-policy";
import { getBaseline } from "./sale-baseline";

const VERSION_DOMAIN = "vrx-inventory-version";

/** Where a version sits in its approval lifecycle. */
export type VersionStatus = "open" | "approved" | "rejected";

/** The GENESIS marker — a version-1 record's priorHash (no predecessor to chain to). */
export const GENESIS_PRIOR = "genesis";

/** One sealed, hash-chained version of a building's vetted inventory — a single version-gated change. */
export type InventoryVersion = {
  /** The catalog building id (verbatim). */
  building: string;
  /** 1-based, strictly increasing, contiguous per building. */
  version: number;
  /** ms epoch the version was opened. */
  at: number;
  /** The developer account that opened the change (lowercased). */
  by: string;
  /** Who signs this version off — the single `approver` abstraction. Defaults to `by` (the developer). */
  approver: string;
  approverRole: ApproverRole;
  /** The change class this version covers (must be a version-gated class for this developer, else it wouldn't
   *  need a version). */
  changeClass: ChangeClass;
  /** WHAT changed — an opaque attested payload (the store does not interpret it). */
  changeset: Record<string, unknown>;
  /** The `sealHash` of the prior version (GENESIS_PRIOR for version 1) — the chain link. */
  priorHash: string;
  /** Per-record secret salt (hex) for the seal. NEVER on-chain. */
  salt: string;
  /** SHA-256(domain | salt | stable fields incl. priorHash) — the chain-binding seal. */
  sealHash: string;
  /** Approval lifecycle state. */
  status: VersionStatus;
  /** ms epoch the status last changed (approve/reject). */
  decidedAt?: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "inventory-versions.json");

// Serialized writes (lost-write guard) — two edits to one building must not interleave their appends.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: InventoryVersion[]) => { next: InventoryVersion[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<InventoryVersion[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return Array.isArray(parsed) ? (parsed as InventoryVersion[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: InventoryVersion[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const normAccount = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const normId = (s: unknown) => (typeof s === "string" ? s.trim() : "");

/** Deterministic JSON for the changeset so its contribution to the seal is stable regardless of key order —
 *  RECURSIVELY (a changeset is nested, e.g. {"unit-501":{from,to}}). A flat replacer-array (Object.keys.sort)
 *  would silently DROP nested keys and let a nested tamper pass; this sorts keys at every depth. */
function stableChangeset(cs: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = canon((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(canon(cs));
}

/** The stable payload the seal protects — every field that defines the version AND its chain link. status/
 *  decidedAt are NOT sealed (they move through the lifecycle AFTER sealing; the approval decision is a
 *  separate attested act, see decideVersion). */
function versionPayload(
  v: Pick<
    InventoryVersion,
    "building" | "version" | "at" | "by" | "approver" | "approverRole" | "changeClass" | "changeset" | "priorHash"
  >
) {
  return {
    building: v.building,
    version: v.version,
    at: v.at,
    by: v.by,
    approver: v.approver,
    approverRole: v.approverRole,
    changeClass: v.changeClass,
    changeset: stableChangeset(v.changeset),
    priorHash: v.priorHash,
  };
}

function seal(v: Parameters<typeof versionPayload>[0] & { salt: string }): string {
  return digest(versionPayload(v), VERSION_DOMAIN, v.salt);
}

const forBuilding = (list: InventoryVersion[], bld: string) =>
  list.filter((x) => x.building === bld).sort((a, b) => a.version - b.version);

/**
 * OPEN a new version-gated change for (developer, building). Appends a sealed version chained to the prior
 * one (GENESIS_PRIOR for the first). Status starts `open` — the edit is NOT yet effective (the freeze gate
 * keeps blocking until this version is APPROVED). `approver`/`approverRole` default to the developer (the
 * sign-off-actor default). Returns the new version, or null on bad input.
 *
 * The CALLER (route) asserts `developer` owns `building` and that `changeClass` is genuinely version-gated for
 * this developer (checked via `requiresApproval`). This store is a pure chained record — it does not read the
 * catalog or the developer registry.
 */
export async function openVersion(input: {
  developer: string;
  building: string;
  changeClass: ChangeClass;
  changeset: Record<string, unknown>;
  approver?: string;
  approverRole?: ApproverRole;
}): Promise<InventoryVersion | null> {
  const dev = normAccount(input.developer);
  const bld = normId(input.building);
  if (!dev || !bld) return null;

  return mutate((list) => {
    const existing = forBuilding(list, bld);
    const priorHash = existing.length ? existing[existing.length - 1].sealHash : GENESIS_PRIOR;
    const version = existing.length ? existing[existing.length - 1].version + 1 : 1;
    const now = Date.now();
    const base = {
      building: bld,
      version,
      at: now,
      by: dev,
      approver: normAccount(input.approver) || dev,
      approverRole: input.approverRole ?? ("developer" as ApproverRole),
      changeClass: input.changeClass,
      changeset: input.changeset ?? {},
      priorHash,
    };
    const salt = newSalt();
    const rec: InventoryVersion = { ...base, salt, sealHash: seal({ ...base, salt }), status: "open" };
    return { next: [...list, rec], ret: rec };
  });
}

/**
 * APPROVE or REJECT an open version (the approver's sign-off). `by` must be the version's `approver`
 * (the route enforces the role). Only an `open` version can be decided; a re-decide is a no-op returning the
 * current record. Does NOT re-seal (the decision is a lifecycle move on an already-sealed record, tracked by
 * `status`/`decidedAt`; the sealed payload — the attested change itself — is immutable). Returns the updated
 * version, or null if not found / `by` is not the approver.
 */
export async function decideVersion(args: {
  building: string;
  version: number;
  decision: "approved" | "rejected";
  by: string;
}): Promise<InventoryVersion | null> {
  const bld = normId(args.building);
  const by = normAccount(args.by);
  if (!bld || !by) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.building === bld && x.version === args.version);
    if (idx < 0) return { next: list, ret: null as InventoryVersion | null };
    const prev = list[idx];
    if (prev.approver !== by) return { next: list, ret: null as InventoryVersion | null }; // only the approver decides
    if (prev.status !== "open") return { next: list, ret: prev }; // already decided — no-op
    const updated: InventoryVersion = { ...prev, status: args.decision, decidedAt: Date.now() };
    const copy = [...list];
    copy[idx] = updated;
    return { next: copy, ret: updated };
  });
}

/**
 * THE PENDING-APPROVAL HOLD — which units of a building are currently HELD because a version-gated
 * change over them is awaiting VRX approval. Derived, no stored per-unit flag (same discipline as `canEdit`
 * derives the write-freeze): a unit is held iff it appears as a changeset UNIT-ID KEY in any still-`open`
 * version for the building.
 *
 * THE CHANGESET CONTRACT this reads: a version over EXISTING units is keyed by unit id —
 * `{ "unit-501": { from, to }... }` (the shape `resolvePriceTargets` + structural edits produce). The hold
 * reads those top-level keys. A control-keyed changeset like addUnit's `{ add: "unit-999" }` carries no
 * existing-unit key, so it holds nothing — correct, because an about-to-be-added unit isn't in the catalog/
 * snapshot yet and is already not bookable. The hold persists exactly while a gated change is unresolved:
 *   • version `open`      → its units are held
 *   • version `approved`  → the change landed; nothing to hold (it's no longer `open`)
 * • version `rejected` → the write never happened (blocked it, storage unchanged); the hold lifts and
 *                           the unit stays bookable on the OLD figures. "Fall back to before" = nothing to roll
 *                           back. If the developer keeps trying, they open a NEW `open` version → held again.
 *
 * Pure read. Returns a Set of held unit ids (verbatim catalog ids). Empty for an unknown/clean building.
 */
export async function heldUnits(building: string): Promise<Set<string>> {
  const held = new Set<string>();
  for (const v of await versionsForBuilding(building)) {
    if (v.status !== "open") continue; // only a PENDING version holds; approved/rejected release
    for (const key of Object.keys(v.changeset ?? {})) {
      // A unit-id key (the per-unit change shape). Control keys (e.g. addUnit's `add`) name no existing unit.
      if (key !== "add" && key !== "remove") held.add(key);
    }
  }
  return held;
}

/** Is this specific unit held pending approval right now? Convenience over `heldUnits`. */
export async function isHeldPendingApproval(building: string, unit: string): Promise<boolean> {
  return (await heldUnits(building)).has(normId(unit));
}

/** Every version for a building, oldest → newest (the chain order). */
export async function versionsForBuilding(building: string): Promise<InventoryVersion[]> {
  const bld = normId(building);
  if (!bld) return [];
  return forBuilding(await readAll(), bld);
}

/** The latest version for a building, or null if none opened. */
export async function latestVersion(building: string): Promise<InventoryVersion | null> {
  const list = await versionsForBuilding(building);
  return list.length ? list[list.length - 1] : null;
}

/**
 * THE FREEZE GATE — may this (developer, building) make a `changeClass` edit RIGHT NOW? Returns the
 * decision + a plain reason. The rule:
 *   • Building NOT on contract (no baseline) → ALLOW (pre-sign-off; nothing is frozen yet). The release
 *     lifecycle only freezes AFTER go-on-contract.
 *   • On contract + the class is SELF-SERVE for this developer (policy "notify") → ALLOW (immediate; a notice
 *     is emitted elsewhere, this gate doesn't block it).
 *   • On contract + the class is VERSION-GATED (policy "approve") → ALLOW iff the LATEST version for this
 *     building is this class, still the open-then-approved one... actually: iff there is an APPROVED, not-yet-
 *     consumed version covering this change. Modeled simply: ALLOW iff the latest version is `approved` and
 *     matches `changeClass`; otherwise REFUSE ("open a new version and get it approved first"). Fail-closed.
 *
 * Pure-ish (reads the baseline + policy + versions). Hard-block enforcement is the caller's to honour (refuse
 * the edit when `allowed` is false) — same discipline as the bookable gate.
 */
export type FreezeDecision =
  | { allowed: true; via: "pre_contract" | "self_serve" | "approved_version" }
  | { allowed: false; reason: "needs_version"; message: string }
  | { allowed: false; reason: "immutable"; message: string };

const NEEDS_VERSION_MSG =
  "This change needs VRX approval while the building is on contract — open a new version and get it approved first.";

// TIER-0 immutable legal anchor (Slice 1, the design docs §3). Refused on the normal
// edit path — there is NO version that unlocks it; a genuine error is corrected only through a VRX-reviewed
// correction (Slice 5). Fail-safe reason distinct from needs_version so the route + UI can steer to the right path.
const IMMUTABLE_MSG =
  "The title deed, survey page, land number and address are fixed once a building is on contract. To correct a genuine error, contact VRX — the change is reviewed and all parties are notified with evidence.";

export async function canEdit(
  developer: string,
  building: string,
  changeClass: ChangeClass
): Promise<FreezeDecision> {
  const dev = normAccount(developer);
  const bld = normId(building);

  // Pre-sign-off: nothing frozen yet.
  const baseline = await getBaseline(dev, bld);
  if (!baseline) return { allowed: true, via: "pre_contract" };

  // On contract: read the precise disposition. An IMMUTABLE class (TIER-0 legal anchor) is REFUSED outright —
  // no version unlocks it; the only legitimate change is a VRX-reviewed correction (Slice 5). Checked before the
  // version logic so a developer can't open a version to mutate a legal anchor.
  const disp = await dispositionOf(dev, changeClass);
  if (disp === "immutable") return { allowed: false, reason: "immutable", message: IMMUTABLE_MSG };
  if (disp === "notify") return { allowed: true, via: "self_serve" };

  // Version-gated: need a latest version that is APPROVED and covers THIS change class.
  const latest = await latestVersion(bld);
  if (latest && latest.status === "approved" && latest.changeClass === changeClass) {
    return { allowed: true, via: "approved_version" };
  }
  return { allowed: false, reason: "needs_version", message: NEEDS_VERSION_MSG };
}

/**
 * DISPUTE-PROOF helpers (the derivable "snapshot"). `verifyChain` walks a building's versions oldest→
 * newest and confirms (a) each record's own seal verifies, (b) each priorHash equals the predecessor's
 * sealHash (GENESIS_PRIOR for version 1), and (c) versions are contiguous from 1. Any break → false (a loud
 * tamper signal). This IS the proof a dispute reads — the chain, not a stored snapshot.
 */
export async function verifyChain(building: string): Promise<boolean> {
  const list = await versionsForBuilding(building);
  let expectedPrior = GENESIS_PRIOR;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v.version !== i + 1) return false; // non-contiguous
    if (v.priorHash !== expectedPrior) return false; // broken link
    if (!verifyVersion(v)) return false; // bad seal
    expectedPrior = v.sealHash;
  }
  return true;
}

/** The ✓-verifiable check for ONE version: re-hash its stable fields (incl. priorHash) with its salt. */
export function verifyVersion(v: InventoryVersion): boolean {
  try {
    if (!v?.salt || !v?.sealHash) return false;
    return seal(v) === v.sealHash;
  } catch {
    return false;
  }
}

/**
 * Reconstruct the attested CHANGE HISTORY up to (and including) `upTo` — the derivable "snapshot". We
 * do not store the catalog, so this returns the ORDERED list of APPROVED changesets a reader replays against
 * the baseline/catalog to reach that version's state. Rejected/open versions are excluded (they never took
 * effect). `upTo` defaults to the latest. Returns the replay list oldest→newest, or [] for an unknown building.
 *
 * This is the "read a past state without trusting a single snapshot" answer: the chain + verifyChain proves
 * the list is unaltered; the replay yields the state. A future frozen-snapshot store (if a dispute workflow
 * ever needs it) layers on top of this — it does not replace it.
 */
export async function reconstructVersion(
  building: string,
  upTo?: number
): Promise<Array<Pick<InventoryVersion, "version" | "changeClass" | "changeset" | "at" | "by">>> {
  const list = await versionsForBuilding(building);
  const ceiling = typeof upTo === "number" ? upTo : Infinity;
  return list
    .filter((v) => v.status === "approved" && v.version <= ceiling)
    .map((v) => ({ version: v.version, changeClass: v.changeClass, changeset: v.changeset, at: v.at, by: v.by }));
}
