// IDENTITY REVOCATION / CURRENT-VALIDITY LAYER (the flagged follow-on to lib/identity-stamp). SERVER-ONLY
// (file-backed). This closes the FRESHNESS TRAP that identity-stamp deliberately leaves open: a Bitcoin "vetted as of
// T" anchor proves ISSUANCE-at-T, never CURRENT validity. A vetting can later be revoked (fraud found, licence
// lapsed, party withdrawn). This module is the mutable CURRENT-STATUS record that lives BESIDE the immutable anchor,
// so a reader can show BOTH honestly: "VRX-vetted as of <T> · ⚠ revoked <T2>".
//
// ── TWO COMPLEMENTARY FACTS, NEVER CONFLATED ─────────────────────────────────────────────────────────────────
//   (1) ISSUANCE  — immutable, Bitcoin-anchored ("vetted as of T"): a historical attestation that is TRUE FOREVER
//       (VRX really did vet this account at T). lib/identity-stamp owns it. Revoking does NOT erase it (you can't
//       un-happen a past attestation — that's the whole point of an anchor).
//   (2) CURRENT STATUS — mutable ("is the vetting in force RIGHT NOW"): active | revoked, with a `since` and a
//       neutral reason code. THIS module owns it. Default = active (no record ⇒ never revoked). Reinstatable (a
//       lapsed-then-renewed licence flips back to active, archiving the prior).
// A reader shows BOTH. Neither replaces the other: the anchor is "what was true at T"; the status is "what's true now".
//
// ── REVOCATION IS ITSELF AN ATTESTABLE EVENT ─────────────────────────────────────────────────────────────────
// When VRX revokes, THAT is also a provenance fact worth anchoring (so "VRX revoked X at T2" is durable + outsider-
// checkable — it closes the "did they really revoke it, or deny they did?" gap, symmetric with issuance). So a
// revoke/reinstate ALSO emits a HASH-ONLY OTS anchor (kind=identity). The same freshness discipline applies in
// reverse: the anchor proves the revocation HAPPENED at T2; the live status is still read from THIS store.
//
// ── ⚠ STILL NOTHING GATES ON THIS AUTOMATICALLY ──────────────────────────────────────────────────────────────
// Like the issuance anchor, the current-status record is INFORMATIONAL — it surfaces truth for a human or a separate
// explicit authz layer to act on. This module does not block any action. (A future authz layer MAY consult
// currentVettingStatus as ONE input, but the gating decision stays explicit + elsewhere — never an implicit
// side effect of reading a stamp. This keeps the "a stamp is provenance, not authorization" invariant intact.)
//
// ── PRIVACY ─────────────────────────────────────────────────────────────────────────────────────────────
// The store + the anchor carry the account HANDLE (public in-system), a neutral status, a `since` timestamp, and a
// neutral REASON CODE (an enum — never free-text, never PII). The anchor is a salted HASH-ONLY seal of a descriptor.

import { promises as fs } from "fs";
import path from "path";
import { sealRecord } from "./seal";
import { anchor } from "./ots-anchor";
import { identityStampsForAccount, asOfLabel, type VettingTier } from "./identity-stamp";
import { type OtsView } from "./ots-anchor";
import { now as vrxNow } from "./clock";
import { localDateStamp } from "./format-time";

const DATA_DIR = path.join(process.cwd(), ".data");
function storePath(): string {
  // Env-overridable for test isolation (mirrors the other stores; read lazily so a static-import test can set it).
  return process.env.VRX_REVOCATION_STORE || path.join(DATA_DIR, "identity-revocation.json");
}

/** The revocation seal domain — EXPORTED so an external tool can re-derive/verify a revocation seal later. */
export const REVOCATION_SEAL_DOMAIN = "vrx-identity-revocation";

/** The current vetting status of an account. `active` = vetting in force (the default — no record ⇒ active).
 *  `revoked` = VRX has withdrawn the vetting as of `since`. */
export type VettingState = "active" | "revoked";

/** A NEUTRAL reason enum — never free-text, never PII. `other` is the catch-all so a new reason doesn't leak detail. */
export type RevocationReason = "fraud" | "licence_lapsed" | "withdrawn" | "duplicate" | "other";

/** A frozen prior status snapshot (archived on each transition so the history is auditable). */
export type VettingSnapshot = {
  state: VettingState;
  since: number;
  reasonCode?: RevocationReason;
  at: number;
};

/** One account's current-validity record. Absent ⇒ the account was never revoked (⇒ `active` if an issuance exists). */
export type VettingStatusRecord = {
  account: string;
  state: VettingState;
  since: number; // ms epoch the CURRENT state began (the revoke/reinstate moment)
  reasonCode?: RevocationReason; // present only while revoked
  tier?: VettingTier; // the tier this status pertains to (carried for a reader; optional)
  history: VettingSnapshot[];
  updatedAt: number;
};

/** A reader-facing view combining the status + a ready label. */
export type VettingStatusView = {
  account: string;
  state: VettingState;
  since: number;
  reasonCode?: RevocationReason;
  /** A plain-English CURRENT-status label — honest about revocation; never implies the issuance anchor is void. */
  label: string;
};

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const isReason = (r: unknown): r is RevocationReason =>
  r === "fraud" || r === "licence_lapsed" || r === "withdrawn" || r === "duplicate" || r === "other";

// ── Serialized writes (lost-write guard — the shared.data store pattern) ─────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: VettingStatusRecord[]) => { next: VettingStatusRecord[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}
async function readAll(): Promise<VettingStatusRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(), "utf8"));
    return Array.isArray(parsed) ? (parsed as VettingStatusRecord[]) : [];
  } catch {
    return [];
  }
}
async function writeAll(list: VettingStatusRecord[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(list, null, 2), "utf8");
}

const labelFor = (state: VettingState, since: number, reason?: RevocationReason, tz?: string): string => {
  if (state === "active") return "vetting in force";
  const when = since > 0 ? localDateStamp(since, tz) : "an earlier date";
  const why = reason && reason !== "other" ? ` (${reason.replace(/_/g, " ")})` : "";
  return `vetting REVOKED as of ${when}${why}`;
};

const toView = (r: VettingStatusRecord, tz?: string): VettingStatusView => ({
  account: r.account,
  state: r.state,
  since: r.since,
  ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
  label: labelFor(r.state, r.since, r.reasonCode, tz),
});

// ── Read: the current validity of an account's vetting ────────────────────────────────────────────────────────
/** The CURRENT vetting status of an account. No record ⇒ `active` (never revoked). This is the live-validity read a
 *  surface joins with the issuance anchor; it is NEVER an authorization by itself. */
export async function currentVettingStatus(account: string, tz?: string): Promise<VettingStatusView> {
  const a = clean(account);
  const rec = (await readAll()).find((r) => r.account === a);
  if (!rec) return { account: a, state: "active", since: 0, label: labelFor("active", 0, undefined, tz) };
  return toView(rec, tz);
}

/** Convenience: is this account's vetting currently in force? (active and not revoked). Still advisory — a caller
 *  that WANTS to gate must do so explicitly; this never silently blocks. */
export async function isVettingActive(account: string): Promise<boolean> {
  return (await currentVettingStatus(account)).state === "active";
}

// ── Write: revoke / reinstate (each also anchors the event, hash-only) ────────────────────────────────────────
/**
 * REVOKE an account's vetting as of now (or a supplied `now`). Idempotent: revoking an already-revoked account with
 * the SAME reason is a no-op (no duplicate anchor, no history churn). Archives the prior state to history. ALSO emits
 * a HASH-ONLY OTS anchor of the revocation event (symmetric with issuance — "VRX revoked X at T2" becomes durable +
 * outsider-checkable). Fire-and-forget on the anchor (best-effort) — the in-system status is authoritative the
 * instant it's written; the anchor is added assurance. Never throws (a bad account is a no-op).
 */
export async function revokeVetting(args: {
  account: string;
  reasonCode: RevocationReason;
  tier?: VettingTier;
  now?: number;
}): Promise<VettingStatusView | null> {
  const account = clean(args.account);
  if (!account) return null;
  const reasonCode: RevocationReason = isReason(args.reasonCode) ? args.reasonCode : "other";
  const now = args.now ?? vrxNow();

  const { record, changed } = await mutate<{ record: VettingStatusRecord; changed: boolean }>((list) => {
    const idx = list.findIndex((r) => r.account === account);
    if (idx < 0) {
      const fresh: VettingStatusRecord = { account, state: "revoked", since: now, reasonCode, tier: args.tier, history: [], updatedAt: now };
      return { next: [...list, fresh], ret: { record: fresh, changed: true } };
    }
    const prev = list[idx];
    // Idempotent: already revoked with the same reason → no change (don't re-anchor / re-archive).
    if (prev.state === "revoked" && prev.reasonCode === reasonCode) return { next: list, ret: { record: prev, changed: false } };
    const snapshot: VettingSnapshot = { state: prev.state, since: prev.since, ...(prev.reasonCode ? { reasonCode: prev.reasonCode } : {}), at: now };
    const updated: VettingStatusRecord = { ...prev, state: "revoked", since: now, reasonCode, tier: args.tier ?? prev.tier, history: [...prev.history, snapshot], updatedAt: now };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: { record: updated, changed: true } };
  });

  if (changed) await anchorRevocationEvent(account, "revoked", now, reasonCode);
  return toView(record);
}

/**
 * REINSTATE an account's vetting (a lapsed-then-renewed licence, a cleared dispute). Idempotent: reinstating an
 * already-active account is a no-op. Archives the prior revoked state. ALSO anchors the reinstatement event (hash-
 * only). Never throws.
 */
export async function reinstateVetting(args: { account: string; tier?: VettingTier; now?: number }): Promise<VettingStatusView | null> {
  const account = clean(args.account);
  if (!account) return null;
  const now = args.now ?? vrxNow();

  const { record, changed } = await mutate<{ record: VettingStatusRecord; changed: boolean }>((list) => {
    const idx = list.findIndex((r) => r.account === account);
    if (idx < 0) {
      // Never revoked → already active; record an explicit active marker so the reinstatement is auditable.
      const fresh: VettingStatusRecord = { account, state: "active", since: now, tier: args.tier, history: [], updatedAt: now };
      return { next: [...list, fresh], ret: { record: fresh, changed: false } }; // no state change (was implicitly active)
    }
    const prev = list[idx];
    if (prev.state === "active") return { next: list, ret: { record: prev, changed: false } };
    const snapshot: VettingSnapshot = { state: prev.state, since: prev.since, ...(prev.reasonCode ? { reasonCode: prev.reasonCode } : {}), at: now };
    const updated: VettingStatusRecord = { ...prev, state: "active", since: now, reasonCode: undefined, tier: args.tier ?? prev.tier, history: [...prev.history, snapshot], updatedAt: now };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: { record: updated, changed: true } };
  });

  if (changed) await anchorRevocationEvent(account, "reinstated", now);
  return toView(record);
}

/** Seal + anchor a revocation/reinstatement event (hash-only, best-effort). Symmetric with the issuance stamp. */
async function anchorRevocationEvent(account: string, event: "revoked" | "reinstated", at: number, reasonCode?: RevocationReason): Promise<void> {
  try {
    const seal = sealRecord({ v: 1, kind: "identity_revocation", account, event, at, ...(reasonCode ? { reasonCode } : {}) }, REVOCATION_SEAL_DOMAIN);
    await anchor(seal.hash, "identity", account);
  } catch {
    /* best-effort — the in-system status already stands; only the added Bitcoin assurance was skipped */
  }
}

// ── The composed reader — issuance anchors + current status, TOGETHER (the honest surface) ────────────────────
/** The full identity picture for an account: its immutable ISSUANCE anchors ("vetted as of T", from lib/identity-
 *  stamp) PLUS its mutable CURRENT status (active/revoked, from this store). A surface renders both — e.g.
 *  "VRX-vetted as of 2026-11-14 (Bitcoin-anchored) · ⚠ vetting REVOKED as of 2026-12-01 (fraud)". Neither fact
 *  overrides the other: the anchor says what was TRUE at T; the status says what's TRUE NOW. ⚠ Still NOT an
 *  authorization — a reader shows truth; a gate stays explicit + elsewhere. */
export async function identityWithCurrentStatus(
  account: string,
  tz?: string
): Promise<{ account: string; current: VettingStatusView; issuance: OtsView[]; issuanceLabels: string[] }> {
  const a = clean(account);
  const [current, issuance] = await Promise.all([currentVettingStatus(a, tz), identityStampsForAccount(a)]);
  // Label each issuance anchor with its own "as of" IN THE VIEWER'S ZONE (the anchor carries no vettedAt, so we
  // label from stampedAt as the best available issuance proxy — the descriptor's vettedAt is sealed, not in the
  // view; an explicit reader holding the vettedAt can call asOfLabel directly).
  const issuanceLabels = issuance.map((v) => asOfLabel(v, v.stampedAt || v.provenAt || 0, tz));
  return { account: a, current, issuance, issuanceLabels };
}

/** Test/teardown helper. */
export async function __resetForTests(): Promise<void> {
  await chain.catch(() => {});
  await mutate(() => ({ next: [], ret: null }));
}
