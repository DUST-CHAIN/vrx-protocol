// DEVELOPER EDIT POLICY — SERVER-ONLY (file-backed). The per-developer, per-change-class approval MATRIX that
// governs what a developer may self-serve vs what VRX must approve first, AFTER a building goes on contract
// Freeze is NOT all-or-nothing. Post-sign-off, a change falls into one of a fixed set of CHANGE CLASSES, and
// for EACH class the developer's policy says either:
// • "notify" → SELF-SERVE: the change takes effect immediately; VRX just SEES it (a change notice).
// • "approve" → VERSION-GATED: the change needs a new sealed version + a VRX re-approval round first.
// The matrix (`changePolicy`) is SEEDED by a named `policyPreset` (conservative | standard | trusted) but is
// NOT frozen to it — VRX RELAXES/tightens individual classes PER DEVELOPER OVER TIME: a new developer starts
// tight (conservative); once proven responsible, VRX flips e.g. priceUp/terms to "notify" ("a big responsible
// company — let them, we don't police daily"). This per-class relax/tighten is the mechanism that separates
// top developers (light-touch) from ones needing tight monitoring. Each relax/tighten is itself an AUDITED
// spine event (it changes what the developer may self-serve), so the trust history is tamper-evident.
// ── The change classes ( §1, the CONSERVATIVE default) ─────────────────────────────────────────────
// Self-serve by default (preset "conservative" seeds these "notify"):
// priceDown · copy · images · withholdToggle · offMarket
// Version-gated by default (preset "conservative" seeds these "approve"):
// addUnit · removeUnit · sizeTypeLayout · priceUp · terms
// ── The seal spine ─────────────────────────────────────────────────────────────────────────
// Nth consumer of the attested-record spine (sale-baseline was the 7th). Salted seal (lib/seal) over the
// stable policy fields so "developer X's edit policy on date D was this matrix, set by this approver" is
// tamper-evident (✓ verifiable). The seal re-computes on every mutation (relax/tighten/approver change).
// ── Why NOT lib/provisioned.ts (design §3) ─────────────────────────────────────────────────────────────
// lib/provisioned.ts is CLIENT-ONLY localStorage (the "what this browser provisioned" list) — the wrong home
// for a trust record VRX mutates server-side over the relationship's life. This is the server-side per-
// developer record. One policy per developer account (NOT per building — the trust tier is developer-level,
// same scope as dev-standing).
// PRIVACY: SERVER-ONLY; neutral developer/approver accounts + opaque policy enums only. No PII, no prices,
// no building/unit specifics, nothing on-chain. Serialized writes (lost-write guard).

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";
import { logActivity } from "./activity";

const POLICY_DOMAIN = "vrx-dev-edit-policy";

/** The fixed set of change classes a post-sign-off edit falls into ( §1). The matrix has one entry per
 * class. Adding a class here is a deliberate model change (and must be reflected in the presets + the
 * change-notice verbs). */
export type ChangeClass =
  // self-serve by default (conservative preset → "notify")
  | "priceDown" // lowering a unit's price
  | "copy" // marketing copy / description
  | "images" // images / renderings
  | "withholdToggle" // withhold ↔ available toggle WITHIN already-vetted units
  | "offMarket" // taking a still-open unit off market
  // version-gated by default (conservative preset → "approve")
  | "addUnit" // adding a unit to the slate
  | "removeUnit" // removing a unit from the slate
  | "sizeTypeLayout" // changing a unit's size / type / layout
  | "priceUp" // raising a unit's price
  | "terms" // materially changing terms
  // The building-setup groups the §3 taxonomy governs, promoted from the crude sectionChangeClass terms/copy
  // collapse to first-class change classes so the matrix can carry their real disposition per developer.
  | "physical" // TIER 2 material: car parks / floor-to-ceiling / land area (versioned + buyer-notify + evidence)
  | "fees" // TIER 2 material: sinking fund /m² / CAM advance months
  | "land" // TIER 0 immutable: the title/survey/land-no./address legal anchors (refuse — VRX correction only)
  | "sellerEntity" // TIER 1 governance: seller-entity swap (who you contract with)
  | "directorChange"; // TIER 1 governance: director/signatory change (an agency/buyer trusted "signed by X")

/** Every change class, in a stable order (for seeding, iteration, and canonical seals). The CHANGE-GOVERNANCE
 * classes are appended AFTER the original 10 so the canonical seal order of pre-existing policies is unchanged
 * for the original classes (a seeded policy's seal only shifts because new classes join the payload — a
 * deliberate, demo-only reseed; all.data is throwaway seed). */
export const CHANGE_CLASSES: readonly ChangeClass[] = [
  "priceDown",
  "copy",
  "images",
  "withholdToggle",
  "offMarket",
  "addUnit",
  "removeUnit",
  "sizeTypeLayout",
  "priceUp",
  "terms",
  // CHANGE-GOVERNANCE tiers
  "physical",
  "fees",
  "land",
  "sellerEntity",
  "directorChange",
] as const;

/** Per-class disposition: "notify" = self-serve (immediate, VRX just sees it); "approve" = version-gated
 * (needs a new sealed version + VRX re-approval first); "immutable" = REFUSED on the normal edit path (a
 * TIER-0 legal anchor; a genuine error is fixed only through a VRX-reviewed correction, never self-serve).
 * (Slice 1 added "immutable" — the 4th disposition, strictly tighter than "approve".) */
export type ChangeDisposition = "notify" | "approve" | "immutable";

/** The matrix: one disposition per change class. */
export type ChangePolicy = Record<ChangeClass, ChangeDisposition>;

/** The named tier that SEEDS the matrix. NOT a frozen category — just the starting point VRX then relaxes
 * per class over time. */
export type PolicyPreset = "conservative" | "standard" | "trusted";

/** Which VRX role signed off for THIS developer (feeds the single `approver` abstraction).
 * "developer" = the developer's own go-on-contract is the sign-off (default today); a VRX/CEO approver slots
 * in later with no rework. */
export type ApproverRole = "developer" | "vrx" | "ceo";

/** Which consumers get this developer's change notices ( §3). */
export type NoticeAudience =
  | "all_subscribed" // every agency subscribed to the developer
  | "agreement_only"; // only agencies with a live agreement on the building

/** A per-developer edit policy — the trust-tier/approver record that governs post-sign-off edits. */
export type DevEditPolicy = {
  /** The owning developer account (lowercased — store key). */
  developer: string;
  /** The named tier the matrix was SEEDED from. Record of origin; the live truth is `changePolicy`. */
  policyPreset: PolicyPreset;
  /** The LIVE per-change-class matrix. VRX relaxes/tightens individual classes over time. */
  changePolicy: ChangePolicy;
  /** Who signs off releases + re-approvals for this developer (the `approver` abstraction). */
  approver: string;
  approverRole: ApproverRole;
  /** WHERE VRX reaches this developer when uneasy (the "VRX will contact them" destination). A free string
   * (email/phone/handle) — opaque to the store, never validated here. */
  contactChannel: string;
  /** ms epoch the developer acknowledged the §3c standing/enforcement disclosure (§7-owed). 0 = not yet. */
  disclosureAckAt: number;
  /** Which consumers get this developer's change notices. */
  noticeAudience: NoticeAudience;
  /** Per-record secret salt (hex) for the seal. NEVER on-chain. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify(stable policy fields)) — the seal. */
  sealHash: string;
  /** ms epoch created. */
  createdAt: number;
  /** ms epoch last mutated (relax/tighten/approver/contact change + re-seal). */
  updatedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "dev-edit-policies.json");

// Serialized writes (lost-write guard) — VRX may relax a class while a read is in flight.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: DevEditPolicy[]) => { next: DevEditPolicy[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<DevEditPolicy[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return Array.isArray(parsed) ? (parsed as DevEditPolicy[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: DevEditPolicy[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const normAccount = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** Seed a matrix from a named preset. The conservative list ( §1) is the base; standard loosens the
 * "soft" structural classes a proven-but-not-top developer can own; trusted loosens everything except the
 * two most trust-critical structural moves (add/remove a unit always stay VRX-approved — they change the
 * vetted set itself). These are SEEDS only — VRX then relaxes/tightens per class per developer. */
export function presetMatrix(preset: PolicyPreset): ChangePolicy {
  // The CHANGE-GOVERNANCE tier classes (§3) have a FIXED disposition across ALL presets — they encode the
  // legal posture, not a trust dial: `land` is TIER-0 immutable (always refuse — only VRX correction changes a
  // legal anchor, never self-serve); `physical`/`fees` are TIER-2 material (always version-gated + buyer-notify
  // + evidence — their magnitude can entitle a dispute); `sellerEntity`/`directorChange` are TIER-1 governance
  // events (always version-gated — a party relied on "contract with entity Y / signed by director X"). VRX may
  // still relax/tighten an individual one per developer via setChangeClassPolicy, but the SEED is tier-correct.
  const governance = {
    physical: "approve",
    fees: "approve",
    land: "immutable",
    sellerEntity: "approve",
    directorChange: "approve",
  } as const;

  // Base: the conservative default — self-serve the 5 non-structural classes, approve the 5 structural ones.
  const base: ChangePolicy = {
    priceDown: "notify",
    copy: "notify",
    images: "notify",
    withholdToggle: "notify",
    offMarket: "notify",
    addUnit: "approve",
    removeUnit: "approve",
    sizeTypeLayout: "approve",
    priceUp: "approve",
    terms: "approve",
    ...governance,
  };
  if (preset === "conservative") return base;
  if (preset === "standard") {
    // A proven developer may raise prices + change layout/size without a round; terms + add/remove stay gated.
    // Governance/immutable tiers are NOT loosened by a preset — they hold their legal-posture disposition.
    return { ...base, priceUp: "notify", sizeTypeLayout: "notify" };
  }
  // trusted: light-touch — everything self-serve EXCEPT add/remove a unit (those always change the vetted set)
  // and the governance/immutable tiers (legal posture, never a trust dial by preset).
  return {
    priceDown: "notify",
    copy: "notify",
    images: "notify",
    withholdToggle: "notify",
    offMarket: "notify",
    addUnit: "approve",
    removeUnit: "approve",
    sizeTypeLayout: "notify",
    priceUp: "notify",
    terms: "notify",
    ...governance,
  };
}

/** The stable payload the seal protects — the policy fields that define "what this developer may do and who
 * signs off", in a canonical flat shape (the matrix joined into one stable string, matching the "flat map"
 * shape the other seals use). createdAt is inside the seal (the record's identity is anchored to when it was
 * established). salt/sealHash/updatedAt are NOT sealed (they're the seal machinery / a mutation marker). */
function policyPayload(
  p: Pick<
    DevEditPolicy,
    | "developer"
    | "policyPreset"
    | "changePolicy"
    | "approver"
    | "approverRole"
    | "contactChannel"
    | "disclosureAckAt"
    | "noticeAudience"
    | "createdAt"
  >
) {
  return {
    developer: p.developer,
    policyPreset: p.policyPreset,
    // canonical class order → "class:disposition..." so stableStringify sees a primitive, not a nested object.
    changePolicy: CHANGE_CLASSES.map((c) => `${c}:${p.changePolicy[c]}`).join(","),
    approver: p.approver,
    approverRole: p.approverRole,
    contactChannel: p.contactChannel,
    disclosureAckAt: p.disclosureAckAt,
    noticeAudience: p.noticeAudience,
    createdAt: p.createdAt,
  };
}

function seal(p: Omit<DevEditPolicy, "salt" | "sealHash" | "updatedAt"> & { salt: string }): string {
  return digest(policyPayload(p), POLICY_DOMAIN, p.salt);
}

/**
 * Ensure a developer has an edit policy, creating it from `preset` on first call (idempotent — a later call
 * NEVER re-seeds an existing policy; use the mutators to change a live one). `approver` defaults to the
 * developer themselves (`approverRole: "developer"`) — the sign-off-actor default (design §"Sign-off actor").
 * Returns the policy. A missing developer returns null.
 *
 * The CALLER (route) asserts `developer` is a real developer account — this store is a pure record.
 */
export async function ensurePolicy(input: {
  developer: string;
  preset?: PolicyPreset;
  approver?: string;
  approverRole?: ApproverRole;
  contactChannel?: string;
  noticeAudience?: NoticeAudience;
}): Promise<DevEditPolicy | null> {
  const dev = normAccount(input.developer);
  if (!dev) return null;
  const preset: PolicyPreset = input.preset ?? "conservative";

  return mutate((list) => {
    const existing = list.find((x) => x.developer === dev);
    if (existing) return { next: list, ret: existing };

    const now = Date.now();
    const salt = newSalt();
    const base: Omit<DevEditPolicy, "sealHash" | "updatedAt"> = {
      developer: dev,
      policyPreset: preset,
      changePolicy: presetMatrix(preset),
      approver: normAccount(input.approver) || dev,
      approverRole: input.approverRole ?? "developer",
      contactChannel: typeof input.contactChannel === "string" ? input.contactChannel.trim() : "",
      disclosureAckAt: 0,
      noticeAudience: input.noticeAudience ?? "all_subscribed",
      salt,
      createdAt: now,
    };
    const rec: DevEditPolicy = { ...base, sealHash: seal(base), updatedAt: now };
    return { next: [...list, rec], ret: rec };
  });
}

/** The policy for a developer, or null if none set yet. */
export async function getPolicy(developer: string): Promise<DevEditPolicy | null> {
  const dev = normAccount(developer);
  if (!dev) return null;
  return (await readAll()).find((x) => x.developer === dev) ?? null;
}

/** All policies (VRX-root oversight read), newest-updated first. */
export async function allPolicies(): Promise<DevEditPolicy[]> {
  return (await readAll()).slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The precise 3-way disposition of `changeClass` for THIS developer. Fail-closed — a developer with NO policy,
 * or an unknown/missing class, resolves to "approve" (the safe default is "VRX must approve", never "let it
 * through unseen"; we deliberately do NOT fail-closed to "immutable" — an unknown class is gated, not refused,
 * since refusal is reserved for the specific legal-anchor classes the taxonomy names). Pure read. (Slice 1.)
 */
export async function dispositionOf(developer: string, changeClass: ChangeClass): Promise<ChangeDisposition> {
  const p = await getPolicy(developer);
  if (!p) return "approve"; // no policy on record → fail-closed to approval
  const disp = p.changePolicy[changeClass];
  return disp === "notify" || disp === "immutable" ? disp : "approve"; // anything else (incl. missing) → approve
}

/**
 * The gate the edit site reads: does `changeClass` need VRX approval (version-gated) for THIS developer, or is
 * it self-serve? Fail-closed — a developer with NO policy, or an unknown class, requires approval (the safe
 * default is "VRX must approve", never "let it through unseen"). An "immutable" class ALSO requires approval
 * here (it is strictly tighter than version-gated — the hard REFUSE is applied by the freeze gate via
 * dispositionOf; this boolean only distinguishes self-serve from not, so no existing caller regresses). Pure read.
 */
export async function requiresApproval(developer: string, changeClass: ChangeClass): Promise<boolean> {
  return (await dispositionOf(developer, changeClass)) !== "notify"; // notify = self-serve; approve|immutable = not
}

/**
 * RELAX or TIGHTEN a single change class for a developer (the trust-dial). `to` is the new
 * disposition for `changeClass`. VRX-asserted — `by` is the VRX operator account (audit trail). Re-seals the
 * record and emits an AUDITED spine event (`policy.relaxed` / `policy.tightened`) so the trust history is
 * tamper-evident and visible to the developer + VRX-root. Idempotent: setting a class to its current
 * disposition is a no-op (no re-seal, no event). Returns the updated policy, or null if the developer has no
 * policy (relax a nonexistent policy is a caller error — ensurePolicy first).
 */
export async function setChangeClassPolicy(args: {
  developer: string;
  changeClass: ChangeClass;
  to: ChangeDisposition;
  by: string;
}): Promise<DevEditPolicy | null> {
  const dev = normAccount(args.developer);
  if (!dev) return null;

  const result = await mutate((list) => {
    const idx = list.findIndex((x) => x.developer === dev);
    if (idx < 0) return { next: list, ret: { policy: null as DevEditPolicy | null, changed: false } };
    const prev = list[idx];
    if (prev.changePolicy[args.changeClass] === args.to) {
      return { next: list, ret: { policy: prev, changed: false } }; // no change — idempotent no-op
    }
    const changePolicy: ChangePolicy = { ...prev.changePolicy, [args.changeClass]: args.to };
    const now = Date.now();
    const next0: Omit<DevEditPolicy, "sealHash" | "updatedAt"> = { ...prev, changePolicy };
    const updated: DevEditPolicy = { ...next0, sealHash: seal(next0), updatedAt: now };
    const copy = [...list];
    copy[idx] = updated;
    return { next: copy, ret: { policy: updated, changed: true } };
  });

  // Audit the trust-dial move ONLY when the disposition actually changed (never on a no-op). Best-effort;
  // never blocks the policy write. "relaxed" = loosened to self-serve (notify); "tightened" = raised to
  // version-gated (approve). Visible to the developer + VRX-root only.
  if (result.changed) {
    const verb = args.to === "notify" ? "policy.relaxed" : "policy.tightened";
    await logActivity(
      verb,
      normAccount(args.by),
      { kind: "developer", id: dev },
      [dev, normAccount(args.by)],
      { changeClass: args.changeClass, disposition: args.to }
    );
  }
  return result.policy;
}

/** Update the `approver`/`approverRole` for a developer (the sign-off actor). Re-seals.
 * Returns the updated policy or null if none on record. */
export async function setApprover(args: {
  developer: string;
  approver: string;
  approverRole: ApproverRole;
}): Promise<DevEditPolicy | null> {
  const dev = normAccount(args.developer);
  const approver = normAccount(args.approver);
  if (!dev || !approver) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.developer === dev);
    if (idx < 0) return { next: list, ret: null as DevEditPolicy | null };
    const prev = list[idx];
    const next0: Omit<DevEditPolicy, "sealHash" | "updatedAt"> = {
      ...prev,
      approver,
      approverRole: args.approverRole,
    };
    const updated: DevEditPolicy = { ...next0, sealHash: seal(next0), updatedAt: Date.now() };
    const copy = [...list];
    copy[idx] = updated;
    return { next: copy, ret: updated };
  });
}

/** Mark the §3c disclosure acknowledged (sets `disclosureAckAt = now` if not already set). Re-seals. */
export async function ackDisclosure(developer: string): Promise<DevEditPolicy | null> {
  const dev = normAccount(developer);
  if (!dev) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.developer === dev);
    if (idx < 0) return { next: list, ret: null as DevEditPolicy | null };
    const prev = list[idx];
    if (prev.disclosureAckAt > 0) return { next: list, ret: prev };
    const next0: Omit<DevEditPolicy, "sealHash" | "updatedAt"> = { ...prev, disclosureAckAt: Date.now() };
    const updated: DevEditPolicy = { ...next0, sealHash: seal(next0), updatedAt: Date.now() };
    const copy = [...list];
    copy[idx] = updated;
    return { next: copy, ret: updated };
  });
}

/** The ✓-verifiable check: re-hash the policy's stable fields with its salt and compare to its seal. */
export function verifyPolicy(x: DevEditPolicy): boolean {
  try {
    if (!x?.salt || !x?.sealHash) return false;
    return seal(x) === x.sealHash;
  } catch {
    return false;
  }
}
