// OTS ANCHORING QUEUE — the GENERAL async Bitcoin-anchoring queue (D- [[vrx-money-privacy-durability-fork]]
// / [[vrx-ideaforge-ots-source-map]]). SERVER-ONLY (file-backed). PORT of IdeaForge's provenance/chain two-phase
// OTS shape, built on VRX's OWN proven background-job spine (lib/stamp-jobs — the paced resumable singleton
// ticker + the serialized-write guard + the pluggable-provider stub seam).
//
// ── WHAT THIS IS (: "reusable everywhere") ─────────────────────────────────────────────────────
// ONE queue · MANY emitters · MANY readers. Any part of VRX can hand a HASH "to OTS"; the item shows here as
// `pending → proven` as Bitcoin confirms (maps 1:1 onto OpenTimestamps' native two-phase stamp→upgrade shape).
// Emitters (the `kind` discriminates): evidence packs · identity badges · S&P documents · signing acts ·
// handover · change-governance · authorship seals. Readers: any surface that wants to show "anchored as of T".
//
// ── THE UX INVARIANT (D-) ───────────────────────────────────────────────────────────────────────────
// `pending` is a NORMAL, hours-long state — NEVER a blocker. The in-system record is ALREADY final the moment
// it's written; the OTS anchor is ADDED assurance that lands later (a notary that outlives the notary). So a
// surface renders "sealed — Bitcoin confirmation pending" for a pending item, and NEVER gates an action on it.
//
// ── THE PROVIDER SEAM (stubbed this session — the cheap/real split, like stamp-jobs' signer) ──────
// `OtsProvider` mirrors IdeaForge's ChainProvider: submit(hash) → a provisional proof (phase 1, stamped to the
// calendar servers); upgrade(proof) → the (possibly) Bitcoin-attested proof (phase 2). This session the provider
// is a STUB (deterministic, NO network, NO new dependency) so the whole queue — emit, idempotent upsert, the
// paced worker, pending→proven, status reads — is tsc-green + testable with ZERO external calls. The REAL
// provider (the `javascript-opentimestamps` npm package talking to real Bitcoin calendars) drops into this exact
// seam at RELEASE_SPINE Track B (D-), replacing the stub via setOtsProvider — nothing above the seam changes.
//
// PRIVACY: the queue stores ONLY opaque hashes (never the anchored content) + a neutral `kind`/`ref`. A hash
// reveals nothing; this is the whole point (amounts/PII live off-chain, only their HASH is ever anchored). No
// amounts, no PII, no account PII. The emitter decides what to hash; the queue just stamps + tracks it.

import { promises as fs } from "fs";
import path from "path";
import { now as vrxNow } from "./clock";
import { localDateStamp } from "./format-time";

const DATA_DIR = path.join(process.cwd(), ".data");
// The store path is env-overridable so a test process can use its OWN isolated file (VRX_OTS_STORE=…). Multiple
// test files run as SEPARATE processes against the same .data dir; the real-provider test's fire-and-forget workers
// can outlive their main and write the shared file WHILE the next process reads it — a cross-process race no
// in-process reset can close. A per-test store path makes them independent. Prod/dev leave it unset → the
// canonical .data/ots-anchors.json. Read LAZILY (per-access, not at module load) so a test that STATICALLY imports
// this module can still set VRX_OTS_STORE before first use — no import-ordering trap.
function storePath(): string {
  return process.env.VRX_OTS_STORE || path.join(DATA_DIR, "ots-anchors.json");
}

/** Gentle default pace between worker ticks — OTS is inherently slow (Bitcoin confirms in hours), so there's no
 *  value hammering the calendar. One item's phase advances per tick; override via env. (Mirrors stamp-jobs' spread.) */
export const OTS_TICK_MS = Number(process.env.VRX_OTS_TICK_MS || 60_000);

/** Per-item attempt budget before an item is marked failed (a failed submit retries on the next tick until this). */
const MAX_ATTEMPTS = Number(process.env.VRX_OTS_MAX_ATTEMPTS || 6);

/** The emitter categories — ONE queue, discriminated by kind so every surface can filter to its own anchors.
 *  Open set by design (new emitters add a kind); keep it a string union for the known ones + accept any string. */
export type OtsKind =
  | "evidence_pack" // an encrypted wallet-keyed evidence pack at a money/consent chokepoint (D-)
  | "identity" // a batched VRX-vetted identity badge ("vetted as of T")
  | "sp_document" // a materialized or scanned-back Sale & Purchase agreement (Slice 5 reconciliation)
  | "signing" // a signing/authorization act
  | "handover" // a unit handover record
  | "change_governance" // a governed change to terms/structure
  | "authorship" // an authorship/provenance seal ([[vrx-authorship-seal-beyond-developers]])
  | "other";

/** The two-phase status — maps 1:1 onto OpenTimestamps. `pending` = submitted to the calendar, not yet
 *  Bitcoin-confirmed (the normal hours-long state). `proven` = a Bitcoin attestation exists (permanent).
 *  `failed` = submit exhausted its retry budget (the in-system record still stands; only the OTS assurance missed). */
export type OtsStatus = "pending" | "proven" | "failed";

/** One queued anchor. `itemHash` is the thing stamped (opaque — the emitter hashed its content). `ref` is an
 *  OPTIONAL neutral back-pointer (e.g. a conversationId or doc id) so a reader can find an item's anchor without
 *  re-hashing; it carries no PII. `otsProof` is the serialized proof blob (base64), grown by submit then upgrade. */
export type OtsAnchor = {
  itemHash: string; // the PK — first-writer-wins (idempotent emit)
  kind: OtsKind;
  status: OtsStatus;
  ref?: string; // ⭐ the DEAL UID — the requestId (directRequestId) or conversationId the rest of VRX threads the
  //                offer→S&P→reservation-doc→deposit on (lib/direct-offer). So an anchor is findable by booking X's
  //  EXISTING UID (anchorsForRef), not a new parallel id. Neutral, no PII.
  otsProof?: string; // base64 serialized .ots proof (provisional after submit, upgraded after)
  attempts: number;
  submittedAt: number; // ms epoch the item was queued
  stampedAt: number; // ms epoch the calendar accepted it (phase 1 done); 0 until
  provenAt: number; // ms epoch of the Bitcoin attestation (phase 2 done); 0 until proven
  updatedAt: number;
  error?: string;
};

/** A reader-facing view of an anchor's state (what a surface renders). `label` is a ready plain-English status. */
export type OtsView = {
  itemHash: string;
  kind: OtsKind;
  status: OtsStatus;
  ref?: string;
  stampedAt: number;
  provenAt: number;
  label: string;
};

// ── Serialized writes (lost-write guard — same pattern as stamp-jobs) ─────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: OtsAnchor[]) => { next: OtsAnchor[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<OtsAnchor[]> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OtsAnchor[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: OtsAnchor[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(list, null, 2), "utf8");
}

// ── THE PROVIDER SEAM (stubbed — the real javascript-opentimestamps provider drops in at Track B) ──────────
/** Mirrors IdeaForge's ChainProvider: a provider that can stamp a hash to the OTS calendars (phase 1 → a
 *  provisional proof) and later upgrade a provisional proof (phase 2 → fold in the Bitcoin attestation when the
 *  block lands). `provenAt` is null until Bitcoin confirms. PURE of this store — the worker calls it + records. */
export type OtsProvider = {
  /** Phase 1 — submit the hash to the calendar servers. Returns a provisional (base64) proof blob. */
  submit(itemHash: string): Promise<{ ok: true; proof: string } | { ok: false; error: string }>;
  /** Phase 2 — attempt to upgrade a provisional proof with a Bitcoin attestation. `provenAt` is the block time
   *  (ms) once confirmed, or null if still pending (the common case for hours). Returns the (possibly) grown proof.
   *  ⭐ `itemHash` is passed alongside the proof because a real OpenTimestamps provider MUST re-derive the original
   *  detached-timestamp from the hash to VERIFY a Bitcoin attestation (O.verify needs both the proof AND the
   *  original hash — the proof blob alone can't confirm which hash it attests). The worker always has it in scope. */
  upgrade(itemHash: string, proof: string): Promise<{ proof: string; provenAt: number | null }>;
};

/** THE STUB. Deterministic, NO network, NO dependency. submit "stamps" instantly (a synthetic proof); upgrade
 *  leaves it pending (provenAt null) so the pending→proven transition is driven by a TEST that injects a proving
 *  provider — the real calendar/Bitcoin timing can't be unit-tested. This exercises the whole spine with zero txs. */
const stubProvider: OtsProvider = {
  async submit(itemHash) {
    return { ok: true, proof: `stub-ots:${itemHash.slice(0, 16)}` };
  },
  async upgrade(_itemHash, proof) {
    // The stub never spontaneously proves (Bitcoin confirmation is real-world + slow). A test swaps in a provider
    // whose upgrade returns a provenAt to exercise the proven transition. Here: unchanged, still pending.
    return { proof, provenAt: null };
  },
};

let activeProvider: OtsProvider = stubProvider;
/** Swap the OTS provider (the real javascript-opentimestamps provider at Track B; a fake in tests). */
export function setOtsProvider(p: OtsProvider): void {
  activeProvider = p;
}
/** Reset to the no-op stub (tests / teardown). */
export function resetOtsProvider(): void {
  activeProvider = stubProvider;
}

// ── EMIT (the one entry point every emitter calls) ────────────────────────────────────────────────────────
/** Queue a hash for anchoring. IDEMPOTENT + first-writer-wins on `itemHash` (re-emitting the same hash returns
 *  the existing anchor unchanged — the provenance fact is "this hash existed by time T", which must not reset).
 *  Returns immediately as `pending`: the in-system record is already final; OTS is added assurance that lands
 *  later. Arms the worker. `ref` is an optional neutral back-pointer (no PII). */
export async function anchor(itemHash: string, kind: OtsKind, ref?: string): Promise<OtsAnchor> {
  const h = (itemHash || "").trim();
  if (!h) throw new Error("anchor: itemHash required");
  const now = vrxNow();
  const rec = await mutate<OtsAnchor>((list) => {
    const existing = list.find((a) => a.itemHash === h);
    if (existing) return { next: list, ret: existing }; // first-writer-wins — never reset a prior anchor
    const fresh: OtsAnchor = {
      itemHash: h,
      kind,
      status: "pending",
      ...(ref ? { ref: ref.trim() } : {}),
      attempts: 0,
      submittedAt: now,
      stampedAt: 0,
      provenAt: 0,
      updatedAt: now,
    };
    return { next: [...list, fresh], ret: fresh };
  });
  // Arm the REAL provider if VRX_OTS_LIVE=1 (else a cheap no-op — the stub stays active). Lazy dynamic import so
  // this file (imported widely) never statically pulls the CommonJS OTS lib into a client bundle (Trap 4). The
  // import resolves before the ticker's first phase-1 submit runs (setTimeout 0), so the live provider is in place
  // in time; and it's fail-safe — a load failure leaves the stub, the record still seals.
  if (process.env.VRX_OTS_LIVE === "1") {
    try {
      const { ensureRealOtsProvider } = await import("./ots-bootstrap.server");
      await ensureRealOtsProvider();
    } catch {
      /* stay on the stub — the in-system record is already final */
    }
  }
  ensureTicker();
  return rec;
}

// ── READ (every surface reads status; pending is NORMAL, never a blocker) ─────────────────────────────────
const labelFor = (a: Pick<OtsAnchor, "status">): string =>
  a.status === "proven" ? "Bitcoin-anchored" : a.status === "failed" ? "anchoring unavailable (record still stands)" : "sealed — Bitcoin confirmation pending";

const toView = (a: OtsAnchor): OtsView => ({
  itemHash: a.itemHash,
  kind: a.kind,
  status: a.status,
  ...(a.ref ? { ref: a.ref } : {}),
  stampedAt: a.stampedAt,
  provenAt: a.provenAt,
  label: labelFor(a),
});

/** THE TIME TRUST LEVEL of an anchor ("where do we get time from?"). An anchor carries TWO times:
 *  the ASSERTED time (`stampedAt`, VRX's own clock — immediate but forgeable) and, once `proven`, the PROVEN
 *  time-FLOOR (`provenAt`, the Bitcoin block time — tamper-evident, no VRX operator can forge it). This returns the
 *  BEST available time + its trust level, so a surface can show "proven on-chain as of T" vs "VRX-asserted at T,
 *  Bitcoin confirmation pending". The proven time is an UPPER BOUND ("existed no later than block T"), which is
 *  exactly the durable, independently-verifiable guarantee the notary posture needs. */
export type TimeTrust = "bitcoin_proven" | "vrx_asserted" | "unknown";
export function provenTime(a: Pick<OtsView, "status" | "stampedAt" | "provenAt">, tz?: string): { at: number; trust: TimeTrust; label: string } {
  if (a.status === "proven" && a.provenAt > 0) {
    return { at: a.provenAt, trust: "bitcoin_proven", label: `Bitcoin-proven as of ${localDateStamp(a.provenAt, tz)}` };
  }
  if (a.stampedAt > 0) {
    return { at: a.stampedAt, trust: "vrx_asserted", label: `VRX-asserted at ${localDateStamp(a.stampedAt, tz)} (Bitcoin confirmation pending)` };
  }
  return { at: 0, trust: "unknown", label: "not yet timestamped" };
}

/** One anchor's current state, or null if the hash was never queued. */
export async function anchorStatus(itemHash: string): Promise<OtsView | null> {
  const a = (await readAll()).find((x) => x.itemHash === (itemHash || "").trim());
  return a ? toView(a) : null;
}

/** All anchors of a kind (newest first) — for a per-emitter status surface. */
export async function anchorsByKind(kind: OtsKind): Promise<OtsView[]> {
  return (await readAll()).filter((a) => a.kind === kind).sort((a, b) => b.submittedAt - a.submittedAt).map(toView);
}

/** All anchors carrying a given neutral ref (e.g. every anchor for one conversation/doc). */
export async function anchorsForRef(ref: string): Promise<OtsView[]> {
  const r = (ref || "").trim();
  return (await readAll()).filter((a) => a.ref === r).sort((a, b) => b.submittedAt - a.submittedAt).map(toView);
}

// ── THE WORKER (paced, resumable, singleton — the stamp-jobs ticker pattern) ──────────────────────────────
let ticker: ReturnType<typeof setTimeout> | null = null;
let draining = false;

/** Arm the worker if it isn't already running. Idempotent; safe to call on every emit. ⚠ TEST DETERMINISM: when
 *  VRX_OTS_NO_AUTOTICK=1 this is a NO-OP, so a test that drives the worker BY HAND (drainOnce) is never raced by an
 * auto-armed setTimeout(0) firing mid-assertion (the flake: `anchor` auto-arms, the timer fires during a
 *  later `await` and advances a phase the test didn't expect). Prod/dev leave it unset → normal auto-pacing. */
export function ensureTicker(): void {
  if (process.env.VRX_OTS_NO_AUTOTICK === "1") return;
  if (ticker || draining) return;
  ticker = setTimeout(() => void drainOnce(), 0);
  (ticker as unknown as { unref?: () => void }).unref?.();
}

/** Stop the worker (tests / teardown). */
export function stopTicker(): void {
  if (ticker) {
    clearTimeout(ticker);
    ticker = null;
  }
}

/** Is there any item still needing work (a pending phase-1 submit, or a stamped-not-proven phase-2 upgrade)? */
function needsWork(a: OtsAnchor): boolean {
  if (a.status === "failed" || a.status === "proven") return false;
  return true; // pending: either not yet stamped (submit) or stamped-not-proven (upgrade)
}

/** Advance ONE item by one phase. Called on each tick; reschedules itself while work remains. Resumable: the
 *  store IS the cursor (status/stampedAt/provenAt), so a restart picks up exactly where it left off. */
export async function drainOnce(): Promise<void> {
  ticker = null;
  if (draining) return;
  draining = true;
  try {
    const list = await readAll();
    const item = list.find(needsWork);
    if (!item) {
      draining = false;
      return; // no work → ticker stays off until the next anchor
    }
    if (item.stampedAt === 0) {
      // PHASE 1 — submit to the calendar.
      const res = await activeProvider.submit(item.itemHash);
      await recordSubmit(item.itemHash, res);
    } else {
      // PHASE 2 — try to upgrade the provisional proof with a Bitcoin attestation. Pass itemHash so a real
      // provider can re-derive the original detached timestamp to verify (the proof blob alone can't).
      const res = await activeProvider.upgrade(item.itemHash, item.otsProof ?? "");
      await recordUpgrade(item.itemHash, res);
    }
  } catch {
    /* transport hiccup — store unchanged; next tick retries */
  } finally {
    draining = false;
    if ((await readAll()).some(needsWork)) {
      ticker = setTimeout(() => void drainOnce(), OTS_TICK_MS);
      (ticker as unknown as { unref?: () => void }).unref?.();
    }
  }
}

/** Record a phase-1 submit outcome: success → stamped (proof stored, still pending until proven); failure →
 *  bump attempts, mark failed past the budget. */
async function recordSubmit(
  itemHash: string,
  res: { ok: true; proof: string } | { ok: false; error: string }
): Promise<void> {
  const now = vrxNow();
  await mutate((list) => {
    const idx = list.findIndex((a) => a.itemHash === itemHash);
    if (idx < 0) return { next: list, ret: null };
    const a = { ...list[idx] };
    if (res.ok) {
      a.otsProof = res.proof;
      a.stampedAt = now;
      a.error = undefined;
    } else {
      a.attempts += 1;
      if (a.attempts >= MAX_ATTEMPTS) {
        a.status = "failed";
        a.error = res.error.slice(0, 200);
      }
    }
    a.updatedAt = now;
    const next = [...list];
    next[idx] = a;
    return { next, ret: null };
  });
}

/** Record a phase-2 upgrade outcome: the proof may have grown; a non-null provenAt flips the item to proven
 *  (the permanent Bitcoin seal). A null provenAt leaves it pending — the common case until the block lands. */
async function recordUpgrade(itemHash: string, res: { proof: string; provenAt: number | null }): Promise<void> {
  const now = vrxNow();
  await mutate((list) => {
    const idx = list.findIndex((a) => a.itemHash === itemHash);
    if (idx < 0) return { next: list, ret: null };
    const a = { ...list[idx] };
    a.otsProof = res.proof;
    if (res.provenAt) {
      a.status = "proven";
      a.provenAt = res.provenAt;
    }
    a.updatedAt = now;
    const next = [...list];
    next[idx] = a;
    return { next, ret: null };
  });
}

/** Test/teardown helper — clear the store + reset the worker + provider. Awaits any in-flight serialized mutate
 *  BEFORE wiping, so a still-landing write (e.g. a worker tick from the prior section) can't re-pollute the
 *  freshly-emptied store — the race that made the reader-filter assertion flaky once a second emitter added store
 * traffic. writeAll goes THROUGH the same mutate chain so the wipe itself is serialized too. */
export async function __resetForTests(): Promise<void> {
  stopTicker();
  resetOtsProvider();
  draining = false;
  await chain.catch(() => {}); // drain any in-flight mutate so a late write can't survive the wipe
  await mutate(() => ({ next: [], ret: null })); // wipe ON the serialized chain (not a bare writeAll)
}
