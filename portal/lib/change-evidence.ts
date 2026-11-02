// CHANGE EVIDENCE — SERVER-ONLY (file-backed). The sealed before/after record of a change to an ON-CONTRACT
// §2/§6). The Nth consumer of the attested-record spine — it uses the SAME salted seal primitive
// (lib/seal) as agreements / KYC profiles / dev-edit-policy, so "building X's section S changed from <before> to
// <after>, by <who>, on <when>" is tamper-evident (✓ re-verifiable by whoever holds the plaintext + salt).
// ── WHY ─────────────────────────────────────────────────────────────────────────────────────────────────
// an on-contract building produces a sealed before/after record and notifies every affected party." This store
// is the SEAL half (the NOTIFY half is the change-notice activity emit + the buyer-inclusive audience in
// lib/affected-parties). VRX anchors the evidence; VRX does NOT adjudicate ( pt5) — we seal who/what/when/
// before/after and make it retrievable on request (the retrieval surface is Slice 7); a buyer may raise a
// dispute USING it, VRX warrants nothing about enforceability.
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. The before/after are PUBLIC building-context values (car parks, fees, land identifiers, copy —
// the family, NOT PII). Neutral developer/party accounts only. The per-record salt lives next to the
// plaintext here and NEVER goes on-chain (and is never surfaced to the client — see the ActivityEntry.context
// warning). Serialized writes (lost-write guard).

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";
import type { ChangeClass } from "./dev-edit-policy";

const EVIDENCE_DOMAIN = "vrx-change-evidence";

/** A JSON-serialisable snapshot of a building section's value (before or after a change). `null` = the section
 * was absent/cleared (no value) — distinct from an object with fields. Opaque to this store; it only seals it. */
export type EvidenceSnapshot = Record<string, unknown> | null;

/** One sealed before/after evidence record for a change to an on-contract building. */
export type ChangeEvidence = {
  /** Stable unique id (store key). */
  id: string;
  /** The building the change was made to (opaque catalog id). */
  building: string;
  /** Which section/group changed (project | physical | fees | land | sellerEntity | directSale). */
  section: string;
  /** The change class the gate classified it as (the tier lens — see lib/dev-edit-policy). */
  changeClass: ChangeClass;
  /** The section value BEFORE the change (null = was absent). */
  before: EvidenceSnapshot;
  /** The section value AFTER the change (null = cleared). */
  after: EvidenceSnapshot;
  /** The account that made the change, lowercased — or "" on the pre-signing no-`by` path (still sealed, never
   * silent: an unattributed change is recorded as such rather than not recorded). */
  by: string;
  /** The accounts notified of this change (the affected set — agencies AND live buyers; see lib/affected-parties).
   * Stored so the evidence record itself proves WHO was told, not just WHAT changed. */
  parties: string[];
  /** Per-record secret salt (hex) for the seal. NEVER on-chain, never surfaced to the client. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify(sealed payload)) — the tamper-evident digest. */
  sealHash: string;
  /** ms epoch the change happened. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "change-evidence.json");

// Serialized writes (lost-write guard) — two routes could seal evidence concurrently.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: ChangeEvidence[]) => { next: ChangeEvidence[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<ChangeEvidence[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return Array.isArray(parsed) ? (parsed as ChangeEvidence[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: ChangeEvidence[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const lc = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** The stable payload the seal protects — who/what/when/before/after. `parts` folds the notified parties into
 * the seal so the record also proves WHO was told. salt/sealHash are NOT sealed (seal machinery); `id` is not
 * sealed (a surrogate key). Canonical, so the digest is reproducible regardless of key order (stableStringify). */
function evidencePayload(
  p: Pick<ChangeEvidence, "building" | "section" | "changeClass" | "before" | "after" | "by" | "parties" | "at">
) {
  return {
    building: p.building,
    section: p.section,
    changeClass: p.changeClass,
    // JSON-string the snapshots so stableStringify sees a primitive at this level (the snapshot's own key order
    // doesn't need to be canonical — it's frozen as the exact text that was sealed, and re-sealed verbatim).
    before: JSON.stringify(p.before ?? null),
    after: JSON.stringify(p.after ?? null),
    by: p.by,
    // canonical, order-independent party set (sorted) so a re-seal matches regardless of resolve order.
    parties: [...p.parties].map(lc).filter(Boolean).sort().join(","),
    at: p.at,
  };
}

function seal(p: Parameters<typeof evidencePayload>[0] & { salt: string }): string {
  return digest(evidencePayload(p), EVIDENCE_DOMAIN, p.salt);
}

/**
 * Record a sealed before/after evidence entry for a change to an on-contract building. Generates the salt +
 * seal, persists, and returns the stored record. Best-effort callers (a route) should not let a sealing failure
 * break the user's save — but unlike a pure log, evidence is a governance promise, so the route awaits it and a
 * throw surfaces (the mutate chain itself swallows its own errors to protect concurrent writers). Accounts are
 * lowercased; the parties set is deduped + lowercased.
 */
export async function recordChangeEvidence(input: {
  building: string;
  section: string;
  changeClass: ChangeClass;
  before: EvidenceSnapshot;
  after: EvidenceSnapshot;
  by: string;
  parties: string[];
}): Promise<ChangeEvidence> {
  const at = Date.now();
  const salt = newSalt();
  const parties = [...new Set(input.parties.map(lc).filter(Boolean))];
  const base = {
    building: input.building.trim(),
    section: input.section.trim(),
    changeClass: input.changeClass,
    before: input.before ?? null,
    after: input.after ?? null,
    by: lc(input.by),
    parties,
    at,
  };
  const sealHash = seal({ ...base, salt });
  const rec: ChangeEvidence = {
    id: `ev-${at.toString(36)}-${salt.slice(0, 8)}`,
    ...base,
    salt,
    sealHash,
  };
  return mutate((list) => ({ next: [...list, rec], ret: rec }));
}

/** All evidence for a building, newest-first. Pure read (the retrieval surface, Slice 7, masks before serving). */
export async function evidenceForBuilding(building: string): Promise<ChangeEvidence[]> {
  const bid = building.trim();
  if (!bid) return [];
  return (await readAll()).filter((e) => e.building === bid).sort((a, b) => b.at - a.at);
}

/** The ✓-verifiable check: re-hash the record's sealed fields with its salt and compare to its seal. True =
 * unaltered since sealing. A missing salt/hash or a mismatch returns false (a loud tamper/lost-salt signal). */
export function verifyChangeEvidence(e: ChangeEvidence): boolean {
  try {
    if (!e?.salt || !e?.sealHash) return false;
    return seal(e) === e.sealHash;
  } catch {
    return false;
  }
}
