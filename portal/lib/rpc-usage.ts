// RPC usage counter — SERVER-ONLY. FastNEAR has no documented API to read our credit balance (it's
// dashboard-only), so we can't show the LIVE number. What we CAN do (the call: "1 and 2"): count the
// RPC calls WE make through the key, and pair that with the real dashboard link as the source of truth.
//
// This is an ESTIMATE, deliberately labelled as such in the UI. Each contract read/query we send is ~1
// FastNEAR request ≈ ~1 credit (their pricing varies per method; the dashboard has the exact figure).
//
// STORAGE NOTE: Next.js dev recompiles/route-isolates modules, so an in-memory singleton is NOT reliably
// shared between requests (a POST setBaseline followed by a GET could see a fresh, empty module). So every
// mutation does an immediate read-modify-write to the .data file — disk is the single source of truth. The
// counter serializes writes through a promise chain so concurrent countRpc calls don't clobber each other.

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "rpc-usage.json");

export type RpcUsage = {
  /** Total keyed RPC calls counted since `since`. */
  calls: number;
  /** Epoch ms when counting (this period) began — reset when tops up / starts a new period. */
  since: number;
  /** The reserve-credit balance last entered from the dashboard, for a remaining estimate. */
  baselineCredits?: number;
  /** Epoch ms when baselineCredits was entered. */
  baselineAt?: number;
  /** calls counted when baselineCredits was entered (remaining = baseline − (calls − baselineCalls)). */
  baselineCalls?: number;
};

// ── PURE reducers (split out of the IO-bound mutate so the state transitions are testable without
// touching disk). Each takes the current usage and returns the NEXT usage — no mutation, no clock except
// the explicit `at` the caller passes in. The subtle invariant they carry is the `baselineCalls` anchor:
// the "remaining credits" estimate is baselineCredits − (calls − baselineCalls), so applyBaseline must
// SNAPSHOT the current call count at the moment enters a dashboard figure, and applyReset must
// re-anchor baselineCalls to 0 (the new period starts the burn count fresh) while KEEPING the baseline.
/** Count `n` keyed calls. */
export function applyCount(u: RpcUsage, n = 1): RpcUsage {
  return { ...u, calls: u.calls + n };
}
/** Anchor a new reserve-credit baseline from the dashboard: snapshot current calls into baselineCalls. */
export function applyBaseline(u: RpcUsage, credits: number, at: number): RpcUsage {
  return { ...u, baselineCredits: credits, baselineAt: at, baselineCalls: u.calls };
}
/** Start a new counting period: zero calls + re-anchor baselineCalls to 0, keep any baseline figure. */
export function applyReset(u: RpcUsage, at: number): RpcUsage {
  return { ...u, calls: 0, since: at, baselineCalls: 0 };
}

async function readStore(): Promise<RpcUsage> {
  try {
    return JSON.parse(await fs.readFile(STORE, "utf8")) as RpcUsage;
  } catch {
    return { calls: 0, since: Date.now() };
  }
}

async function writeStore(u: RpcUsage): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(u, null, 2), "utf8");
}

// Serialize all writes so concurrent counts/updates apply atomically (read-modify-write can't interleave).
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (u: RpcUsage) => { next: RpcUsage; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readStore();
    const { next, ret } = fn(cur);
    await writeStore(next);
    return ret;
  });
  // Keep the chain alive but don't let a rejection break future writes.
  chain = run.catch(() => {});
  return run;
}

/** Count `n` keyed RPC calls (default 1). Fire-and-forget; never blocks/throws on the hot read path. */
export function countRpc(n = 1): void {
  void mutate((u) => ({ next: applyCount(u, n), ret: null })).catch(() => {});
}

/** Read the current usage picture (owner dashboard). */
export async function getUsage(): Promise<RpcUsage> {
  return await readStore();
}

/** Set the reserve-credit baseline from the FastNEAR dashboard so we can show a remaining estimate. */
export async function setBaseline(credits: number): Promise<RpcUsage> {
  return await mutate((u) => {
    const next = applyBaseline(u, credits, Date.now());
    return { next, ret: next };
  });
}

/** Reset the call counter (new period). Keeps any baseline; re-anchors baselineCalls to 0. */
export async function resetUsage(): Promise<RpcUsage> {
  return await mutate((u) => {
    const next = applyReset(u, Date.now());
    return { next, ret: next };
  });
}
