// The CLEAN-SLATE onboarding batch-stamp, run as a DURABLE BACKGROUND JOB — not a foreground "click → wait
// → 10 signs". A developer assembles a plan (each unit → its real state), submits it, and THIS worker drips
// the stamps on-chain in ≤50-tile chunks (stamp_tiles, lib.rs:1107), rate-SPREAD over minutes-to-hours to
// respect the RPC throttle, resumable from the last-confirmed chunk, surviving the developer
// closing the tab. When the whole plan is stamped, the worker writes the commission BASELINE anchor
// (lib/sale-baseline) over the `open` set — so the attested "from that day on" date is the day the slate
// actually landed on-chain, not the day the plan was typed.
// ── THE GENERIC SPINE (reuse-the-pattern) ────────────────────────────────────────────────────────
// This is the FIRST consumer of a generic "VRX background-job worker" (durable job store + a paced,
// resumable, singleton ticker). The SECOND consumer is the self-hosted chain INDEXER (tailing our
// TileStamped/EVENT_JSON signals — the upgrade lib/indexer.ts:10-13 already names). The chunking + state
// machine + ticker here are deliberately job-TYPE-agnostic where cheap, so the indexer can share them.
// This differs from lib/sync-loop.ts (a server singleton loop too) in LIFECYCLE: sync-loop is
// audience-driven (ticks only while an SSE client watches); a stamp job runs whether or not anyone watches.
// ── THE SIGNER IS STUBBED THIS SESSION ( scope) ────────────────────────────────────────────────────
// `signChunk` is a seam. This session it's a STUB (records the intent, no on-chain write) so the whole spine
// is tsc-green + testable with ZERO live txs. The real signer (a stamp-only FUNCTION-CALL access key the
// server holds, usable deposit-free because the developer's node is on the contract `exempt` set) is
// wired in a later session by replacing `defaultSigner`. The faucet (lib/faucet-server) already proves the
// server-signs pattern; the only new bit there is signing AS the developer's node, not a VRX-owned account.
// ── Ownership (DEVELOPER-owned) ────────────────────────────────────────────────────────────────────────
// Only the building's own developer (deskDeveloperFor) may create/control a job for it. The ROUTE enforces
// caller == that developer; this store is a pure record + a process. A job names exactly one (developer,
// building).
// PRIVACY: SERVER-ONLY; neutral developer account + opaque building/unit ids + opaque unit_keys +
// integrity hashes. No PII, no prices. The plan's statuses are the PUBLIC on-chain tile states (0..3), not
// secret. Serialized writes (lost-write guard).

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { establishBaseline } from "./sale-baseline";

/** Max tiles per stamp_tiles call — the contract cap (lib.rs:1111, TOO_MANY_STAMPS). */
export const CHUNK_MAX = 50;

/** On-chain tile status. Mirrors the contract's u8 (0..3). Only these four exist (no new states). */
export type TileStatus = 0 | 1 | 2 | 3; // open | hold | closed | sold

/** One unit's desired on-chain state in the plan. `unitKey` + `integrityHash` are the opaque on-chain refs
 * (computed client-side, same as every other stamp path); `unit` is the catalog id (for the UI + baseline). */
export type StampItem = {
  /** Catalog Unit.id (verbatim) — what the developer sees + what the baseline's availableUnits records. */
  unit: string;
  /** Opaque on-chain tile key (hashRef(unitRef,"vrx-unit")). The contract key; no PII. */
  unitKey: string;
  /** The desired on-chain status (0..3). */
  status: TileStatus;
  /** Opaque integrity hash sealed into the tile (same scheme as stamp_tile elsewhere). */
  integrityHash: string;
};

/** Job lifecycle. `paused` is developer-requested; `failed` is a chunk that exhausted retries. */
export type StampJobStatus = "queued" | "running" | "paused" | "done" | "failed";

/** A single chunk's progress (≤50 items). `txHash` set once a chunk is confirmed stamped. */
export type ChunkState = {
  /** 0-based index into the job's chunk list. */
  index: number;
  /** How many items this chunk carries (≤ CHUNK_MAX). */
  size: number;
  /** "pending" until stamped; "done" once confirmed; "failed" after retries exhausted. */
  state: "pending" | "done" | "failed";
  /** The stamp_tiles tx hash once confirmed (stub records a synthetic marker). "" until then. */
  txHash: string;
  /** Attempts spent on this chunk (for retry budgeting). */
  attempts: number;
  /** ms epoch the chunk was confirmed done (0 until then). Feeds the ETA (observed pace). */
  doneAt: number;
};

/** A durable stamp job for one (developer, building). */
export type StampJob = {
  /** Opaque job id (random hex). */
  id: string;
  /** The owning developer account (lowercased — authz subject + store key half). */
  developer: string;
  /** The catalog building id (verbatim). */
  building: string;
  /** The full plan — every unit the developer set a state for. Immutable once the job is created. */
  plan: StampItem[];
  /** The per-chunk progress ledger (plan sliced into ≤CHUNK_MAX groups, in plan order). */
  chunks: ChunkState[];
  /** Lifecycle — see StampJobStatus. */
  status: StampJobStatus;
  /** ms between chunk attempts (the RATE SPREAD — large = gentle on the RPC). Configurable per job. */
  spreadMs: number;
  /** A short human reason when status === "failed" (last chunk error). "" otherwise. */
  error: string;
  /** ms epoch created. */
  createdAt: number;
  /** ms epoch last advanced (a chunk attempt or a state change). */
  updatedAt: number;
  /** ms epoch the baseline anchor was written on completion (0 until done). */
  baselineAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "stamp-jobs.json");

/** Default rate spread between chunks — gentle by default so a big tower drips over a long window, not a
 * stampede. 90s × ~10 chunks ≈ 15 min for a 476-unit tower; override per job (slower for huge buildings). */
export const DEFAULT_SPREAD_MS = Number(process.env.VRX_STAMP_SPREAD_MS || 90_000);

/** Per-chunk retry budget before the chunk (and the job) is marked failed. */
const MAX_ATTEMPTS = Number(process.env.VRX_STAMP_MAX_ATTEMPTS || 4);

// ── Serialized writes (lost-write guard) ───────────────────────────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: StampJob[]) => { next: StampJob[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<StampJob[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StampJob[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: StampJob[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const normAccount = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const normId = (s: unknown) => (typeof s === "string" ? s.trim() : "");

function randHex(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

/** Slice a plan into ≤CHUNK_MAX groups, in plan order (deterministic; resumable by index). */
export function planToChunks(plan: StampItem[]): ChunkState[] {
  const chunks: ChunkState[] = [];
  for (let i = 0; i < plan.length; i += CHUNK_MAX) {
    const size = Math.min(CHUNK_MAX, plan.length - i);
    chunks.push({ index: chunks.length, size, state: "pending", txHash: "", attempts: 0, doneAt: 0 });
  }
  return chunks;
}

/** The items a given chunk covers (pure; derived from the plan + chunk index, never stored twice). */
export function itemsForChunk(job: StampJob, chunkIndex: number): StampItem[] {
  const start = chunkIndex * CHUNK_MAX;
  return job.plan.slice(start, start + CHUNK_MAX);
}

// ── The SIGNER SEAM (stubbed this session) ──────────────────────────────────────────────────────
/** Signs ONE chunk (≤50 tiles) via stamp_tiles and resolves the confirmed tx hash. The real implementation
 * (later session) uses a stamp-only function-call key for `developer`'s node, deposit-free (exempt). */
export type ChunkSigner = (args: {
  developer: string;
  building: string;
  items: StampItem[];
  chunkIndex: number;
}) => Promise<{ ok: true; txHash: string } | { ok: false; error: string }>;

/** THE STUB. Pretends the chunk was stamped (no on-chain write), returning a synthetic marker so the whole
 * spine — chunking, pacing, resume, progress, completion→baseline — is exercisable with ZERO live txs.
 * Replace via `setChunkSigner` with the real function-call-key signer when the live path lands. */
const stubSigner: ChunkSigner = async ({ chunkIndex }) => {
  return { ok: true, txHash: `stub:chunk:${chunkIndex}` };
};

let activeSigner: ChunkSigner = stubSigner;
/** Swap the chunk signer (the live FC-key signer later; tests inject a fake failing/succeeding one). */
export function setChunkSigner(signer: ChunkSigner): void {
  activeSigner = signer;
}
/** Reset to the no-op stub (tests / teardown). */
export function resetChunkSigner(): void {
  activeSigner = stubSigner;
}

// ── Create ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Create a queued stamp job. The CALLER (route) MUST enforce: `developer` is the building's owning developer
 * (deskDeveloperFor) and every plan unit exists in that building. This store validates shape only, not
 * ownership (it does not read the catalog / developer registry — same contract as sale-baseline).
 * Returns the job, or null on an empty/invalid plan.
 */
export async function createJob(input: {
  developer: string;
  building: string;
  plan: StampItem[];
  spreadMs?: number;
}): Promise<StampJob | null> {
  const developer = normAccount(input.developer);
  const building = normId(input.building);
  if (!developer || !building) return null;

  // Canonicalize the plan: drop malformed items, de-dupe by unit (last state wins — the developer's latest
  // choice for a unit is the one that stamps), keep plan order stable by first appearance.
  const byUnit = new Map<string, StampItem>();
  const order: string[] = [];
  for (const raw of Array.isArray(input.plan) ? input.plan : []) {
    const unit = normId(raw?.unit);
    const unitKey = normId(raw?.unitKey);
    const integrityHash = normId(raw?.integrityHash);
    const status = raw?.status;
    if (!unit || !unitKey) continue;
    if (status !== 0 && status !== 1 && status !== 2 && status !== 3) continue;
    if (!byUnit.has(unit)) order.push(unit);
    byUnit.set(unit, { unit, unitKey, status: status as TileStatus, integrityHash });
  }
  const plan = order.map((u) => byUnit.get(u)!);
  if (plan.length === 0) return null;

  const spreadMs = Number.isFinite(input.spreadMs) && (input.spreadMs as number) >= 0
    ? Math.floor(input.spreadMs as number)
    : DEFAULT_SPREAD_MS;

  const now = Date.now();
  const job: StampJob = {
    id: randHex(),
    developer,
    building,
    plan,
    chunks: planToChunks(plan),
    status: "queued",
    spreadMs,
    error: "",
    createdAt: now,
    updatedAt: now,
    baselineAt: 0,
  };
  await mutate((list) => ({ next: [...list, job], ret: null }));
  ensureTicker();
  return job;
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────
export async function getJob(id: string): Promise<StampJob | null> {
  const jid = normId(id);
  if (!jid) return null;
  return (await readAll()).find((j) => j.id === jid) ?? null;
}

/** All jobs a developer owns, newest first. */
export async function jobsForDeveloper(developer: string): Promise<StampJob[]> {
  const dev = normAccount(developer);
  if (!dev) return [];
  return (await readAll()).filter((j) => j.developer === dev).sort((a, b) => b.createdAt - a.createdAt);
}

/** The latest job for a (developer, building), or null. The UI reads this to show the onboarding state. */
export async function latestJobFor(developer: string, building: string): Promise<StampJob | null> {
  const dev = normAccount(developer);
  const bld = normId(building);
  if (!dev || !bld) return null;
  return (
    (await readAll())
      .filter((j) => j.developer === dev && j.building === bld)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

// ── Progress (pure, derived) ───────────────────────────────────────────────────────────────────────────
export type JobProgress = {
  status: StampJobStatus;
  chunksTotal: number;
  chunksDone: number;
  tilesTotal: number;
  tilesDone: number;
  /** Fraction 0..1 of tiles stamped. */
  fraction: number;
  /** Estimated ms remaining, or null if not enough signal yet (0 done, or already finished). */
  etaMs: number | null;
};

/** Derive progress + ETA from the chunk ledger. ETA uses the observed per-chunk interval (fall back to
 * spreadMs before any chunk completes), times chunks remaining. Pure — safe to call anywhere. */
export function progressOf(job: StampJob): JobProgress {
  const chunksTotal = job.chunks.length;
  const chunksDone = job.chunks.filter((c) => c.state === "done").length;
  const tilesTotal = job.plan.length;
  const tilesDone = job.chunks
    .filter((c) => c.state === "done")
    .reduce((n, c) => n + c.size, 0);
  const remaining = chunksTotal - chunksDone;

  let etaMs: number | null = null;
  if (job.status !== "done" && job.status !== "failed" && remaining > 0) {
    // Observed pace: span between the first and last confirmed chunk / intervals between them.
    const doneTimes = job.chunks.filter((c) => c.state === "done" && c.doneAt > 0).map((c) => c.doneAt).sort((a, b) => a - b);
    let perChunk = job.spreadMs;
    if (doneTimes.length >= 2) {
      perChunk = (doneTimes[doneTimes.length - 1] - doneTimes[0]) / (doneTimes.length - 1);
    }
    etaMs = Math.max(0, Math.round(perChunk * remaining));
  }

  return {
    status: job.status,
    chunksTotal,
    chunksDone,
    tilesTotal,
    tilesDone,
    fraction: tilesTotal === 0 ? 0 : tilesDone / tilesTotal,
    etaMs,
  };
}

// ── Control (pause / resume) ───────────────────────────────────────────────────────────────────────────
/** Pause a running/queued job (developer-requested). No-op on done/failed. Returns the updated job or null. */
export async function pauseJob(id: string): Promise<StampJob | null> {
  return mutate((list) => {
    const idx = list.findIndex((j) => j.id === id);
    if (idx < 0) return { next: list, ret: null };
    const j = list[idx];
    if (j.status === "running" || j.status === "queued") {
      const upd = { ...j, status: "paused" as StampJobStatus, updatedAt: Date.now() };
      const next = [...list];
      next[idx] = upd;
      return { next, ret: upd };
    }
    return { next: list, ret: j };
  });
}

/** Resume a paused/failed job (failed → clear error + reset the failed chunk's attempts so it retries).
 * No-op on done. Returns the updated job or null. */
export async function resumeJob(id: string): Promise<StampJob | null> {
  const ret = await mutate((list) => {
    const idx = list.findIndex((j) => j.id === id);
    if (idx < 0) return { next: list, ret: null as StampJob | null };
    const j = list[idx];
    if (j.status === "done") return { next: list, ret: j };
    const chunks = j.chunks.map((c) => (c.state === "failed" ? { ...c, state: "pending" as const, attempts: 0 } : c));
    const upd: StampJob = { ...j, chunks, status: "queued", error: "", updatedAt: Date.now() };
    const next = [...list];
    next[idx] = upd;
    return { next, ret: upd };
  });
  if (ret) ensureTicker();
  return ret;
}

// ── The WORKER (paced, resumable, singleton ticker) ──────────────────────────────────────────────────────
// ONE ticker for the whole process. It advances AT MOST ONE chunk per tick ACROSS ALL JOBS (all developers),
// on-chain write rate is one stamp_tiles per spreadMs REGARDLESS of how many developers onboard at once —
// concurrent jobs SHARE the one paced lane, they don't each get their own, so they can never TOGETHER exceed
// the RPC write budget. (Reads are separate: stamp jobs are a WRITE path / gas, not FastNEAR reads —
// config.ts:64 — so they also can't collide with the indexer/snapshot read quota.) FAIRNESS: the scheduler
// ROUND-ROBINS across active jobs (a rotation cursor), so a second developer's job interleaves with the first
// instead of waiting behind its entire tower. Resumable: the ledger IS the cursor; a restart re-reads it.

let ticker: ReturnType<typeof setTimeout> | null = null;
let draining = false;
/** Round-robin cursor: the index AFTER the job we last served, so the next scan starts there (fair rotation
 * across concurrent developers' jobs rather than draining the first job fully before the next gets a turn). */
let rrCursor = 0;

/** Start the ticker if a job needs work and it isn't already scheduled. Idempotent. Call after create/resume. */
export function ensureTicker(): void {
  if (ticker || draining) return;
  ticker = setTimeout(() => void drainOnce(), 0);
  (ticker as unknown as { unref?: () => void }).unref?.();
}

/** Stop the ticker (tests / shutdown). Does not alter job state. */
export function stopTicker(): void {
  if (ticker) {
    clearTimeout(ticker);
    ticker = null;
  }
}

/** Pick the next actionable (job, chunkIndex): the first pending chunk of a queued/running job. */
function nextWork(list: StampJob[]): { job: StampJob; chunkIndex: number } | null {
  const n = list.length;
  if (n === 0) return null;
  // Scan starting at the rotation cursor so concurrent jobs take turns (fair round-robin), then advance the
  // cursor past the job we picked. A job in list order that's done/paused is simply skipped.
  for (let off = 0; off < n; off++) {
    const i = (rrCursor + off) % n;
    const job = list[i];
    if (job.status !== "queued" && job.status !== "running") continue;
    const chunkIndex = job.chunks.findIndex((c) => c.state === "pending");
    if (chunkIndex >= 0) {
      rrCursor = (i + 1) % n; // next scan starts after this job → the next active job gets the following turn
      return { job, chunkIndex };
    }
  }
  return null;
}

/** Read-only: does ANY job still have a pending chunk? (Used to decide rescheduling without advancing the
 * round-robin cursor — nextWork advances it, this must not.) */
function hasWork(list: StampJob[]): boolean {
  return list.some(
    (j) => (j.status === "queued" || j.status === "running") && j.chunks.some((c) => c.state === "pending")
  );
}

/** One tick: attempt a single chunk, persist the outcome, then reschedule by the job's spread (or stop when
 * no work remains). Exported for tests to step deterministically (await a single chunk attempt). */
export async function drainOnce(): Promise<void> {
  ticker = null;
  if (draining) return;
  draining = true;
  let spreadForNext = DEFAULT_SPREAD_MS;
  try {
    const list = await readAll();
    const work = nextWork(list);
    if (!work) {
      draining = false;
      return; // nothing to do — ticker stays off until the next create/resume calls ensureTicker()
    }
    spreadForNext = work.job.spreadMs;
    // Flip queued → running the first time we touch it.
    if (work.job.status === "queued") {
      await setStatus(work.job.id, "running");
    }
    const items = itemsForChunk(work.job, work.chunkIndex);
    const res = await activeSigner({
      developer: work.job.developer,
      building: work.job.building,
      items,
      chunkIndex: work.chunkIndex,
    });
    await recordChunkOutcome(work.job.id, work.chunkIndex, res);
  } catch {
    /* transport hiccup — the ledger is unchanged for this chunk; the next tick retries it */
  } finally {
    draining = false;
    // Reschedule iff work remains. The spread is the rate limit between on-chain writes. Use hasWork (not
    // nextWork) so this check doesn't advance the round-robin cursor.
    if (hasWork(await readAll())) {
      ticker = setTimeout(() => void drainOnce(), spreadForNext);
      (ticker as unknown as { unref?: () => void }).unref?.();
    }
  }
}

async function setStatus(id: string, status: StampJobStatus): Promise<void> {
  await mutate((list) => {
    const idx = list.findIndex((j) => j.id === id);
    if (idx < 0) return { next: list, ret: null };
    const next = [...list];
    next[idx] = { ...list[idx], status, updatedAt: Date.now() };
    return { next, ret: null };
  });
}

/** Apply a chunk's sign outcome: mark done (+txHash) or bump attempts / fail, and roll up the job status
 * (all-done → "done", any-exhausted → "failed"). Does NOT write the commission baseline — that is the
 * separate, deliberate `goOnContract` action; a job finishing only means the tiles are stamped. */
async function recordChunkOutcome(
  id: string,
  chunkIndex: number,
  res: { ok: true; txHash: string } | { ok: false; error: string }
): Promise<void> {
  await mutate((list) => {
    const idx = list.findIndex((j) => j.id === id);
    if (idx < 0) return { next: list, ret: null };
    const j = list[idx];
    // If the developer paused mid-flight, abandon this outcome (don't advance a paused job).
    if (j.status === "paused") return { next: list, ret: null };

    const chunks = j.chunks.map((c) => ({ ...c }));
    const c = chunks[chunkIndex];
    if (!c || c.state === "done") return { next: list, ret: null };

    if (res.ok) {
      c.state = "done";
      c.txHash = res.txHash;
      c.doneAt = Date.now();
    } else {
      c.attempts += 1;
      if (c.attempts >= MAX_ATTEMPTS) {
        c.state = "failed";
      }
    }

    const allDone = chunks.every((x) => x.state === "done");
    const anyFailed = chunks.some((x) => x.state === "failed");
    const status: StampJobStatus = allDone ? "done" : anyFailed ? "failed" : j.status;
    const error = anyFailed && !res.ok ? res.error.slice(0, 200) : j.error;

    const upd: StampJob = { ...j, chunks, status, error, updatedAt: Date.now() };
    const next = [...list];
    next[idx] = upd;
    return { next, ret: null };
  });
  // NOTE: completing a job does NOT write the commission baseline. Stamping tiles and "going on contract"
  // phase 1 = all units → available; phase 2 = the sold/closed exceptions), and only when the whole slate is
  // final do they take a SEPARATE "go on contract" action (goOnContract below) that reads the LIVE on-chain
  // `open` set and writes the baseline. That is the moment the VRX↔developer contract takes effect and the
  // "on contract since <date>" banner lights up. Don't re-couple it to a job finishing.
}

/**
 * Establish the commission baseline ("zero time" / contract-in-effect) for (developer, building). Called by
 * its own route AFTER the developer confirms the whole slate is final — NOT automatically when a stamp job
 * ends. `availableUnits` is the LIVE on-chain `open` (status 0) set at this moment, resolved by the CALLER
 * (the route reads the building's current tile states — truth is what's actually on-chain after all batches,
 * independent of how many jobs it took). Idempotent via establishBaseline (a re-call corrects the set but
 * PRESERVES the original establishedAt — the contract start date never moves). Returns the baseline record.
 *
 * The CALLER MUST enforce: caller == the building's owning developer, and every unit in `availableUnits`
 * exists in the building (same authz contract as sale-baseline's route).
 */
export async function goOnContract(input: {
  developer: string;
  building: string;
  availableUnits: string[];
}): Promise<import("./sale-baseline").SaleBaseline | null> {
  return establishBaseline(input);
}
