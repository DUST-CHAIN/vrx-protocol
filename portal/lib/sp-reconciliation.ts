// S&P RECONCILIATION — the digital→paper Sale & Purchase sync (Slice 5 of the desk payment-UX cluster;
// the design docs + the design docs "Digital→paper S&P reconciliation"). SERVER-ONLY
// (file-backed).: the digital S&P is PROVISIONAL — valid only UNTIL the paper one is signed + scanned
// back. If the paper carries last-minute changes, the system must RECONCILE them (know the REAL agreed terms) so
// it tracks incoming payments against the right schedule.
//
// ── THE MECHANISM ───────────────────────────────────────────────────────────────────────────────────
//   1. The signed paper S&P is scanned back in → we SEAL it (lib/seal — the authorship/provenance seal, a
//      tamper-evident hash) and ANCHOR that hash via the OTS queue (lib/ots-anchor), keyed on the deal UID
//      (requestId) so the evidence is findable by the booking's existing id ([[vrx-deal-uid-is-requestId]]).
//   2. The AI "reads back" the scan: it records what the paper SAYS the terms are (extracted, structured) so a
//      human can compare at a glance. (Extraction is AI-assisted upstream; this store takes the result.)
//   3. The DEVELOPER'S ADMIN signs off: either the scan MATCHES the system's terms (→ reconciled, track payments
//      against the digital schedule) OR it carries a VARIANCE (→ the admin records the REAL agreed terms, and
//      payment tracking follows THOSE). That human attestation is what keeps the system in sync.
//
// ── AUTHORITY (VRX facilitates + seals, does NOT adjudicate) ──────────────────────────────────────────
// VRX SEALS the scan + ANCHORS it + RECORDS the developer's attestation. It never decides whose terms are
// "true": the developer's admin attestation IS the truth of record (they signed the paper); VRX makes that
// attestation tamper-evident + Bitcoin-anchored. A buyer dispute is a separate surface (not adjudicated here).
//
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. The store holds: the sealed scan HASH (never the scan bytes or PII on-chain), the neutral deal
// UID, the extracted/attested TERMS (B2B developer↔buyer money facts, already the deal's own data), and neutral
// account refs for who attested. The scan file itself lives in the existing doc store; only its hash is anchored.

import { promises as fs } from "fs";
import path from "path";
import { sealRecord, digest, type Seal } from "./seal";
import { anchor, anchorStatus, type OtsView } from "./ots-anchor";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "sp-reconciliation.json");

const SEAL_DOMAIN = "vrx-sp-scan"; // salts the scanned-S&P seal so its hash can't be matched against other seals

/** The reconciliation lifecycle. `provisional` = digital S&P only (the materialized offer is the agreed terms).
 *  `paper_recorded` = the signed scan is sealed + anchored + read back (terms extracted). `reconciled_match` =
 *  the dev admin attested the scan MATCHES the system terms. `reconciled_variance` = the admin recorded a
 *  DIFFERENCE + the real agreed terms (payment tracking follows those). Both `reconciled_*` are terminal-stable
 *  (a re-scan can re-open to paper_recorded → re-attest; the prior is archived). */
export type ReconcileStatus = "provisional" | "paper_recorded" | "reconciled_match" | "reconciled_variance";

/** One structured term line the paper is read back into — kept machine-legible (never free-text), so a variance
 *  is a precise fact a payment tracker can consume. Mirrors the reservation schedule shape. */
export type ReconcileTermLine = { label: string; value: string };

/** A frozen prior reconciliation snapshot (archived when a re-scan re-opens the record). */
export type ReconcileSnapshot = {
  status: ReconcileStatus;
  scanHash: string;
  readBackTerms: ReconcileTermLine[];
  attestedBy?: string;
  attestedAt: number;
  variance?: ReconcileTermLine[];
  at: number;
};

/** One reconciliation record — one per deal (keyed by the deal UID / requestId). */
export type SpReconciliation = {
  /** The deal UID — the requestId the rest of VRX threads offer→S&P→deposit on ([[vrx-deal-uid-is-requestId]]). */
  requestId: string;
  conversationId: string;
  building: string;
  status: ReconcileStatus;
  /** The sealed scan: a tamper-evident hash of the uploaded signed paper (lib/seal — SALTED, so a fresh seal each
   *  time; this is what we anchor). Absent until paper_recorded. */
  scanSeal?: Seal;
  /** A DETERMINISTIC content hash of the scan payload (unsalted digest) — used ONLY to detect "same scan" for
   *  idempotency (the salted scanSeal.hash differs every call, so it can't be the identity key). */
  scanContentHash?: string;
  /** A neutral ref to the scanned document in the doc store (the bytes live there; only the hash is anchored). */
  scanDocId?: string;
  /** What the AI read the PAPER to say (structured) — for the admin to compare against the system's terms. */
  readBackTerms: ReconcileTermLine[];
  /** The developer-admin attestation: who signed off + when + (on a variance) the REAL agreed terms. */
  attestedBy?: string;
  attestedAt: number; // ms epoch; 0 until attested
  /** On reconciled_variance: the corrected terms the admin recorded as actually agreed (payment tracking uses these). */
  variance?: ReconcileTermLine[];
  history: ReconcileSnapshot[];
  createdAt: number;
  updatedAt: number;
};

// ── Serialized writes (lost-write guard — the shared VRX store pattern) ───────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: SpReconciliation[]) => { next: SpReconciliation[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<SpReconciliation[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SpReconciliation[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: SpReconciliation[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");

// ── Read ──────────────────────────────────────────────────────────────────────────────────────────────────
/** The reconciliation for a deal, or null if none exists yet (→ the deal is implicitly `provisional`: the digital
 *  S&P stands, no paper scanned). Keyed on the deal UID (requestId). */
export async function getReconciliation(requestId: string): Promise<SpReconciliation | null> {
  const id = clean(requestId);
  if (!id) return null;
  return (await readAll()).find((r) => r.requestId === id) ?? null;
}

/** The EFFECTIVE status of a deal's S&P — `provisional` when no record exists (the default, before any scan). */
export async function reconciliationStatus(requestId: string): Promise<ReconcileStatus> {
  return (await getReconciliation(requestId))?.status ?? "provisional";
}

/** The deal's reconciliation PLUS its OTS anchor status (the Bitcoin-seal state of the scanned paper), joined by
 *  the scan hash. The anchor is null until a paper is recorded. `pending` is a normal state (never a blocker). */
export async function reconciliationWithAnchor(
  requestId: string
): Promise<{ record: SpReconciliation | null; anchor: OtsView | null }> {
  const record = await getReconciliation(requestId);
  const anc = record?.scanSeal ? await anchorStatus(record.scanSeal.hash) : null;
  return { record, anchor: anc };
}

// ── Write 1: record the scanned paper (seal + anchor + read-back) ─────────────────────────────────────────
/** Record the signed paper S&P: SEAL the scan (tamper-evident hash), ANCHOR that hash via the OTS queue (keyed on
 *  the deal UID), and store the AI's read-back of what the paper SAYS the terms are. Moves the record to
 *  `paper_recorded` (awaiting the developer-admin attestation). Idempotent on an UNCHANGED scan (same payload →
 *  same deal still paper_recorded, re-anchor is a no-op by the queue's first-writer-wins). A re-scan (new content)
 *  archives the prior to history[] and re-opens. The caller supplies a canonical scan payload to seal (e.g. the
 *  doc bytes' own hash + the docId) — this module doesn't read files.
 *
 *  `scanPayload` is what gets sealed (a stable descriptor of the scanned bytes — typically {docId, sha256} from
 *  the upload); `readBackTerms` is the AI's structured extraction of the paper's terms. */
export async function recordScannedSp(args: {
  requestId: string;
  conversationId: string;
  building: string;
  scanDocId: string;
  scanPayload: Record<string, unknown> | string;
  readBackTerms?: ReconcileTermLine[];
}): Promise<{ ok: true; record: SpReconciliation } | { ok: false; reason: string }> {
  const requestId = clean(args.requestId);
  const conversationId = clean(args.conversationId);
  const building = clean(args.building);
  const scanDocId = clean(args.scanDocId);
  if (!requestId || !conversationId || !building) return { ok: false, reason: "requestId + conversationId + building required" };
  if (!scanDocId) return { ok: false, reason: "scanDocId required (the scanned document reference)" };

  // SEAL the scan → a tamper-evident hash (the authorship/provenance seal). The salt stays with the record (never
  // on-chain); the hash is what we anchor. SEPARATELY, a DETERMINISTIC content hash (unsalted) keys idempotency —
  // the salted seal hash differs every call, so "same scan?" must compare the content, not the seal.
  const seal = sealRecord(args.scanPayload, SEAL_DOMAIN);
  const contentHash = digest(args.scanPayload, SEAL_DOMAIN, "");
  const readBack = normalizeTerms(args.readBackTerms);
  const now = Date.now();

  const record = await mutate<SpReconciliation>((list) => {
    const idx = list.findIndex((r) => r.requestId === requestId);
    if (idx < 0) {
      const fresh: SpReconciliation = {
        requestId,
        conversationId,
        building,
        status: "paper_recorded",
        scanSeal: seal,
        scanContentHash: contentHash,
        scanDocId,
        readBackTerms: readBack,
        attestedAt: 0,
        history: [],
        createdAt: now,
        updatedAt: now,
      };
      return { next: [...list, fresh], ret: fresh };
    }
    const prev = list[idx];
    // Idempotent: the SAME scan CONTENT (deterministic hash) + same read-back + already paper_recorded → no change
    // (replay-safe). Keyed on the content hash, NOT the salted seal hash (which differs every call).
    if (prev.scanContentHash === contentHash && prev.status === "paper_recorded" && sameTerms(prev.readBackTerms, readBack)) {
      return { next: list, ret: prev };
    }
    // A new/changed scan (or re-scan after an attestation) ARCHIVES the prior and re-opens to paper_recorded.
    const snapshot: ReconcileSnapshot = {
      status: prev.status,
      scanHash: prev.scanSeal?.hash ?? "",
      readBackTerms: prev.readBackTerms,
      ...(prev.attestedBy ? { attestedBy: prev.attestedBy } : {}),
      attestedAt: prev.attestedAt,
      ...(prev.variance ? { variance: prev.variance } : {}),
      at: now,
    };
    const updated: SpReconciliation = {
      ...prev,
      status: "paper_recorded",
      scanSeal: seal,
      scanContentHash: contentHash,
      scanDocId,
      readBackTerms: readBack,
      attestedBy: undefined,
      attestedAt: 0,
      variance: undefined,
      history: [...prev.history, snapshot],
      updatedAt: now,
    };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });

  // ANCHOR the sealed scan hash to Bitcoin via the OTS queue, keyed on the deal UID. We anchor the hash that is
  // actually ON the record (record.scanSeal.hash) — on an IDEMPOTENT replay that's the ORIGINAL stored hash (the
  // freshly-salted `seal` above was discarded by mutate), so a replay does NOT create a phantom second anchor. On
  // a new/changed scan it's the new hash. The queue itself is first-writer-wins per hash (idempotent).
  if (record.scanSeal?.hash) await anchor(record.scanSeal.hash, "sp_document", requestId);

  return { ok: true, record };
}

// ── Write 2: the developer-admin attestation (match or variance) ──────────────────────────────────────────
/** The developer's admin signs off on the scanned paper. `match` = the scan matches the system's terms →
 *  reconciled_match (payment tracking follows the digital schedule). A VARIANCE = the admin records the REAL
 *  agreed terms (structured) → reconciled_variance (payment tracking follows THOSE). Requires a paper_recorded
 *  record (there must be a scan to attest). AUTHORITY: the caller (route) proves `attestedBy` is the building's
 * developer admin — this store records the attestation, it does not authorize it (the route gates). */
export async function attestReconciliation(args: {
  requestId: string;
  attestedBy: string;
  outcome: "match" | "variance";
  variance?: ReconcileTermLine[];
}): Promise<{ ok: true; record: SpReconciliation } | { ok: false; reason: string }> {
  const requestId = clean(args.requestId);
  const attestedBy = clean(args.attestedBy);
  if (!requestId || !attestedBy) return { ok: false, reason: "requestId + attestedBy required" };
  if (args.outcome !== "match" && args.outcome !== "variance") return { ok: false, reason: "outcome must be match|variance" };
  const variance = args.outcome === "variance" ? normalizeTerms(args.variance) : [];
  if (args.outcome === "variance" && !variance.length) {
    return { ok: false, reason: "a variance attestation must record at least one corrected term" };
  }
  const now = Date.now();
  const res = await mutate<{ ok: boolean; record?: SpReconciliation; reason?: string }>((list) => {
    const idx = list.findIndex((r) => r.requestId === requestId);
    if (idx < 0) return { next: list, ret: { ok: false, reason: "no reconciliation to attest (record the scanned paper first)" } };
    const prev = list[idx];
    if (prev.status === "provisional") return { next: list, ret: { ok: false, reason: "no scanned paper to attest" } };
    const updated: SpReconciliation = {
      ...prev,
      status: args.outcome === "match" ? "reconciled_match" : "reconciled_variance",
      attestedBy,
      attestedAt: now,
      variance: args.outcome === "variance" ? variance : undefined,
      updatedAt: now,
    };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: { ok: true, record: updated } };
  });
  if (!res.ok) return { ok: false, reason: res.reason ?? "attestation failed" };
  return { ok: true, record: res.record! };
}

/** The TERMS that payment tracking should follow for this deal: the recorded VARIANCE when the admin attested one,
 *  else null (meaning "follow the system's digital terms" — provisional or attested-match). A tracker reads this
 *  to know whether a last-minute paper change moved the schedule. */
export async function effectiveTerms(requestId: string): Promise<{ source: "digital" | "paper_variance"; variance: ReconcileTermLine[] | null }> {
  const r = await getReconciliation(requestId);
  if (r?.status === "reconciled_variance" && r.variance?.length) {
    return { source: "paper_variance", variance: r.variance };
  }
  return { source: "digital", variance: null };
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────
function normalizeTerms(t?: ReconcileTermLine[]): ReconcileTermLine[] {
  if (!Array.isArray(t)) return [];
  return t
    .filter((r): r is ReconcileTermLine => !!r && typeof r === "object")
    .map((r) => ({ label: clean(r.label).slice(0, 60), value: clean(r.value).slice(0, 120) }))
    .filter((r) => r.label && r.value)
    .slice(0, 40);
}

function sameTerms(a: ReconcileTermLine[], b: ReconcileTermLine[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.label === b[i].label && x.value === b[i].value);
}

/** Test/teardown helper. */
export async function __resetForTests(): Promise<void> {
  await writeAll([]);
}
