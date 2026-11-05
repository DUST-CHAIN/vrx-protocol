// TIER-0 CORRECTION — the ONLY legitimate way an IMMUTABLE land legal-anchor changes once a building is on
// contract (Slice 5, the design docs §Slice 5; arc design the design docs §3
// TIER-0 + §2 "some facts are immutable … a change is a CORRECTION requiring VRX review"). SERVER-ONLY.
//
// ── WHY ─────────────────────────────────────────────────────────────────────────────────────────────────
// Slice 1 made the land legal-anchors (title deed / survey page / land number / address) IMMUTABLE: the freeze
// gate refuses a self-serve edit (canEdit → reason:"immutable"; the route 409s immutable_tier0). But a genuine
// typo in a title deed number is real and must be fixable — WITHOUT killing+rebuilding the building (that would
// orphan live contracts/bookings) and WITHOUT a silent self-serve edit (indistinguishable from fraud). The
// taxonomy's answer: a VRX-REVIEWED correction. The developer OPENS a correction (proposed new values + a
// reason); VRX REVIEWS and approves/rejects; on approve the corrected values are applied + sealed as evidence +
// ALL affected parties notified. VRX anchors the review + the evidence; VRX does NOT warrant the correctness of
// the new value or adjudicate any dispute (pt5) — it records who corrected what, why, and that VRX reviewed.
//
// This store owns the correction REQUEST + its review state (open → approved | rejected). The APPLY step (the
// actual land write + evidence + notify) lives in the decide ROUTE — same split as inventory version/decide,
// where the store records the decision and the route applies the attested change. Keeps this module pure of
// cross-module I/O.
//
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. The before/after are the land legal identifiers — PUBLIC building context (they appear on the
// title/S&P), NOT buyer PII. Neutral developer/reviewer accounts. Per-record salt next to the plaintext, never
// on-chain. Serialized writes (lost-write guard).

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";

const CORRECTION_DOMAIN = "vrx-tier0-correction";

/** A land legal-anchor snapshot (the TIER-0 fields only — clauseText is editable prose, not an anchor). A null
 *  field = absent. Opaque to this store; it seals + carries it, the route validates via cleanLand on apply. */
export type LandAnchors = {
  titleDeedNum?: string;
  surveyPageNum?: string;
  landNumber?: string;
  address?: string;
  addressTH?: string;
};

export type CorrectionStatus = "open" | "approved" | "rejected";

/** One VRX-reviewed TIER-0 correction request + its review state. */
export type Tier0Correction = {
  /** Stable unique id (store key). */
  id: string;
  /** The building whose land anchor is being corrected (opaque catalog id). */
  building: string;
  /** The developer who opened the correction, lowercased. */
  developer: string;
  /** The land anchors BEFORE (the current on-disk values at open time). */
  before: LandAnchors;
  /** The land anchors the developer PROPOSES (the corrected values). */
  after: LandAnchors;
  /** The developer's stated reason for the correction (required — a correction is never silent). */
  reason: string;
  /** Review state: open (awaiting VRX) → approved (applied) | rejected (nothing applied). */
  status: CorrectionStatus;
  /** The VRX reviewer account that decided, lowercased. "" while open. */
  reviewedBy: string;
  /** The change-evidence id sealed when the correction was APPLIED (links the "what changed" proof). "" until
   *  approved+applied. */
  evidenceId: string;
  /** Per-record secret salt (hex) for the seal. NEVER on-chain. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify(sealed payload)) — tamper-evident over the REQUEST (who/what/why).
   *  The review state (status/reviewedBy/evidenceId) is NOT sealed — it mutates after the request is sealed; the
   *  REQUEST's integrity is what the seal protects (same discipline as a version's seal vs its status). */
  sealHash: string;
  /** ms epoch opened. */
  at: number;
  /** ms epoch decided (0 while open). */
  decidedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "tier0-corrections.json");

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: Tier0Correction[]) => { next: Tier0Correction[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<Tier0Correction[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return Array.isArray(parsed) ? (parsed as Tier0Correction[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Tier0Correction[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const lc = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** The stable sealed payload — the REQUEST (building/developer/before/after/reason/at). Review state is excluded
 *  (it mutates post-seal). Canonical via stableStringify (order-independent); before/after JSON-stringified so a
 *  nested object seals as one primitive at this level. */
function requestPayload(p: Pick<Tier0Correction, "building" | "developer" | "before" | "after" | "reason" | "at">) {
  return {
    building: p.building,
    developer: p.developer,
    before: JSON.stringify(p.before ?? {}),
    after: JSON.stringify(p.after ?? {}),
    reason: p.reason,
    at: p.at,
  };
}

function seal(p: Parameters<typeof requestPayload>[0] & { salt: string }): string {
  return digest(requestPayload(p), CORRECTION_DOMAIN, p.salt);
}

/**
 * Open a TIER-0 correction request. The developer proposes `after` anchors with a `reason`; status starts
 * `open` (awaiting VRX review). `before` is the caller-supplied current on-disk anchors (the route reads them
 * from the building). A blank building/developer/reason is refused (null) — a correction is never silent or
 * reason-less. Seals the request. Returns the stored record.
 */
export async function openCorrection(input: {
  building: string;
  developer: string;
  before: LandAnchors;
  after: LandAnchors;
  reason: string;
}): Promise<Tier0Correction | null> {
  const building = input.building.trim();
  const developer = lc(input.developer);
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
  if (!building || !developer || !reason) return null;

  const at = Date.now();
  const salt = newSalt();
  const base = { building, developer, before: input.before ?? {}, after: input.after ?? {}, reason, at };
  const rec: Tier0Correction = {
    id: `cor-${at.toString(36)}-${salt.slice(0, 8)}`,
    ...base,
    status: "open",
    reviewedBy: "",
    evidenceId: "",
    salt,
    sealHash: seal({ ...base, salt }),
    decidedAt: 0,
  };
  return mutate((list) => ({ next: [...list, rec], ret: rec }));
}

/**
 * VRX decides an OPEN correction. `decision` = approved | rejected; `by` = the VRX reviewer. Idempotent: a
 * correction already decided is returned unchanged (status reflects the FIRST decision) — the caller detects the
 * no-op by comparing the returned status to its request. On approve, the route then APPLIES the land write +
 * seals evidence + notifies, and calls `attachEvidence` to link the proof. Returns the updated record, or null
 * if the id is unknown. Does NOT apply anything itself (the route owns the apply — see module header).
 */
export async function decideCorrection(args: {
  id: string;
  decision: "approved" | "rejected";
  by: string;
}): Promise<{ correction: Tier0Correction; changed: boolean } | null> {
  const id = args.id.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null as { correction: Tier0Correction; changed: boolean } | null };
    const prev = list[idx];
    if (prev.status !== "open") return { next: list, ret: { correction: prev, changed: false } }; // already decided
    const updated: Tier0Correction = {
      ...prev,
      status: args.decision,
      reviewedBy: lc(args.by),
      decidedAt: Date.now(),
    };
    const copy = [...list];
    copy[idx] = updated;
    return { next: copy, ret: { correction: updated, changed: true } };
  });
}

/** Link the sealed change-evidence id to an approved correction (called by the route after it applies + seals). */
export async function attachEvidence(id: string, evidenceId: string): Promise<Tier0Correction | null> {
  const cid = id.trim();
  if (!cid) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === cid);
    if (idx < 0) return { next: list, ret: null as Tier0Correction | null };
    const updated = { ...list[idx], evidenceId: evidenceId.trim() };
    const copy = [...list];
    copy[idx] = updated;
    return { next: copy, ret: updated };
  });
}

/** A single correction by id. */
export async function getCorrection(id: string): Promise<Tier0Correction | null> {
  const cid = id.trim();
  if (!cid) return null;
  return (await readAll()).find((c) => c.id === cid) ?? null;
}

/** Corrections for a building, newest-first. */
export async function correctionsForBuilding(building: string): Promise<Tier0Correction[]> {
  const bid = building.trim();
  if (!bid) return [];
  return (await readAll()).filter((c) => c.building === bid).sort((a, b) => b.at - a.at);
}

/** All OPEN corrections, oldest-first — the VRX-root review queue. */
export async function openCorrections(): Promise<Tier0Correction[]> {
  return (await readAll()).filter((c) => c.status === "open").sort((a, b) => a.at - b.at);
}

/** The ✓-verifiable check: re-hash the REQUEST fields with the salt and compare to the seal. Proves the
 *  developer's proposed correction + reason is unaltered since opening (the review state is intentionally
 *  outside the seal). */
export function verifyCorrection(c: Tier0Correction): boolean {
  try {
    if (!c?.salt || !c?.sealHash) return false;
    return seal(c) === c.sealHash;
  } catch {
    return false;
  }
}
