// VRX event FETCHER — SERVER-ONLY. Pulls the contract's NEP-297 `EVENT_JSON` logs off chain so the
// event MIRROR (lib/events.ts) can enumerate state the on-chain view methods don't expose cheaply
// (held units, a developer's whole booking history, cross-booking message counts).
//
// WHY TWO SOURCES (byte-verified —):
//   • NearBlocks testnet gives the txn HASH LIST for the contract (method + args, newest-first) but its
//     free tier STRIPS logs (the /v1/txns/{hash} detail has no `logs` key). So it's only the cheap
//     enumerator — the same pattern lib/indexer.ts already uses for registrations.
//   • The ARCHIVAL RPC (EXPERIMENTAL_tx_status) returns receipts_outcome[].outcome.logs[] where the
//     `EVENT_JSON:` lines actually live. ⚠️ Must be the ARCHIVAL endpoint — the normal RPC 408s on older
//     txns (they age off the non-archival node). sender_account_id = the tx SIGNER (from NearBlocks).
//
// RATE DISCIPLINE: a persisted CURSOR (lib/events.ts) means each sync fetches only NEW hashes + only NEW
// tx_status, so steady state is a handful of calls per tick. The FastNEAR KEY POOL (config.FASTNEAR_API_KEYS)
// round-robins across our several accounts' free keys to multiply the quota until the self-hosted
// block-tailer exists (the documented fallback if NearBlocks/quota ever bites). Contract UNCHANGED.

import {
  CONTRACT_ID,
  NETWORK,
  ARCHIVAL_RPC_URL,
  FASTNEAR_API_KEYS,
} from "./config";
import { countRpc } from "./rpc-usage";
import { ingestEvents, getCursor, setCursorBlock, type RawEvent } from "./events";
import { getClaimServer } from "./vrx-server";
import { allOffers } from "./offers";
import { allChannelRequestIds } from "./channels";

const NEARBLOCKS_BASE =
  NETWORK === "mainnet" ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io";

// ── FastNEAR key-pool round-robin ────────────────────────────────────────────────────────────────
let keyCursor = 0;
/** Next key from the pool (round-robin), or undefined if we have no keys (unauthenticated calls). */
function nextKey(): string | undefined {
  if (FASTNEAR_API_KEYS.length === 0) return undefined;
  const k = FASTNEAR_API_KEYS[keyCursor % FASTNEAR_API_KEYS.length];
  keyCursor++;
  return k;
}

// ── NearBlocks: the contract's txn hash list (newest-first) ──────────────────────────────────────
export type TxnRef = {
  hash: string;
  signer: string;
  /** ms epoch from block_timestamp (ns). The cursor compares on this. */
  at: number;
};

type NbTxn = {
  transaction_hash: string;
  signer_account_id?: string;
  predecessor_account_id?: string;
  block_timestamp: string | number;
};

/**
 * List the most recent `perPage` txns against the contract via NearBlocks, newest-first, de-duped on hash.
 *
 * ⚠️ SUPERSEDED as the mirror's enumerator: NearBlocks testnet is BLIND to our reservation-flow
 * txns — it returns 0 open_claim/reply_claim/stamp_tile txns for the contract even though get_claim proves
 * they're on-chain (the coverage gap). FastNEAR has no testnet txn index either. So the mirror now
 * uses the forward block-tailer (syncEvents) + the known-claims seed. This NearBlocks reader is kept only
 * for cheap REGISTRATION discovery / debugging (registrations DO show up), where it's still fine.
 */
export async function listContractTxns(perPage = 25): Promise<TxnRef[]> {
  const url = `${NEARBLOCKS_BASE}/v1/account/${CONTRACT_ID}/txns?per_page=${perPage}&order=desc`;
  const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`nearblocks ${res.status}`);
  const data = (await res.json()) as { txns?: NbTxn[] };
  const byHash = new Map<string, TxnRef>();
  for (const t of data.txns ?? []) {
    const hash = t.transaction_hash;
    if (!hash || byHash.has(hash)) continue;
    byHash.set(hash, {
      hash,
      signer: t.signer_account_id || t.predecessor_account_id || CONTRACT_ID,
      at: Math.floor(Number(t.block_timestamp) / 1e6),
    });
  }
  return Array.from(byHash.values()).sort((a, b) => b.at - a.at);
}

// ── Archival RPC (JSON-RPC, key-pool round-robin) ─────────────────────────────────────────────────
/** POST one JSON-RPC call to the archival endpoint with the next pooled key. Throws on transport/RPC error. */
async function archivalRpc<T>(method: string, params: unknown): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = nextKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(ARCHIVAL_RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`archival rpc ${res.status}`);
  countRpc();
  const data = (await res.json()) as { result?: T; error?: unknown };
  if (data.error || data.result === undefined) throw new Error(`rpc ${method} error ${JSON.stringify(data.error)}`);
  return data.result;
}

type BlockResult = {
  header: { height: number; timestamp: number };
  chunks: { chunk_hash: string }[];
};
type ChunkTxn = { hash: string; signer_id: string; receiver_id: string };
type ChunkResult = { transactions?: ChunkTxn[] };

/** The current final head block height. */
async function headHeight(): Promise<number> {
  const b = await archivalRpc<BlockResult>("block", { finality: "final" });
  return b.header.height;
}

/** A block's chunk hashes + its timestamp (ms). Empty chunks if the block id is missing/skipped. */
async function blockAt(height: number): Promise<{ chunks: string[]; at: number }> {
  const b = await archivalRpc<BlockResult>("block", { block_id: height });
  return {
    chunks: (b.chunks ?? []).map((c) => c.chunk_hash),
    at: Math.floor(Number(b.header.timestamp) / 1e6), // ns → ms
  };
}

/** The txns in one chunk whose receiver is our contract, stamped with the block's ms timestamp. */
async function contractTxnsInChunk(chunkHash: string, at: number): Promise<TxnRef[]> {
  const c = await archivalRpc<ChunkResult>("chunk", { chunk_id: chunkHash });
  const out: TxnRef[] = [];
  for (const t of c.transactions ?? []) {
    if (t.receiver_id !== CONTRACT_ID) continue;
    out.push({ hash: t.hash, signer: t.signer_id, at });
  }
  return out;
}

// ── Archival RPC: the EVENT_JSON logs for one txn ─────────────────────────────────────────────────
type TxStatusResult = {
  result?: { receipts_outcome?: { outcome?: { logs?: string[] } }[] };
  error?: unknown;
};

/**
 * Fetch all `EVENT_JSON` logs for one txn via archival EXPERIMENTAL_tx_status, parsed into RawEvents.
 * `logIndex` is the position of the event among THIS txn's EVENT_JSON lines — the mirror dedups on
 * (tx, logIndex) so a replayed sync is idempotent. A txn with no vrx events yields []. Throws on a
 * transport/RPC error so the caller can back off and retry on the next tick (never records a partial).
 */
export async function fetchTxnEvents(txn: TxnRef): Promise<RawEvent[]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = nextKey();
  if (key) headers.Authorization = `Bearer ${key}`;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: txn.hash,
    method: "EXPERIMENTAL_tx_status",
    params: { tx_hash: txn.hash, sender_account_id: txn.signer, wait_until: "NONE" },
  });

  const res = await fetch(ARCHIVAL_RPC_URL, { method: "POST", headers, body, cache: "no-store" });
  if (!res.ok) throw new Error(`archival rpc ${res.status}`);
  countRpc(); // one keyed archival call
  const data = (await res.json()) as TxStatusResult;
  if (data.error || !data.result) throw new Error(`tx_status error ${JSON.stringify(data.error)}`);

  const out: RawEvent[] = [];
  let logIndex = 0;
  for (const ro of data.result.receipts_outcome ?? []) {
    for (const line of ro.outcome?.logs ?? []) {
      const parsed = parseEventLog(line);
      if (!parsed) continue;
      out.push({ tx: txn.hash, at: txn.at, logIndex, event: parsed.event, data: parsed.data });
      logIndex++;
    }
  }
  return out;
}

/**
 * Parse one log line into { event, data } iff it's a well-formed vrx NEP-297 EVENT_JSON line. Returns
 * null for any non-vrx / non-event / malformed line (other standards, plain logs). Defensive by design —
 * a single bad line must never throw and abort the whole txn's ingest.
 */
export function parseEventLog(line: string): { event: string; data: unknown } | null {
  const PREFIX = "EVENT_JSON:";
  const i = line.indexOf(PREFIX);
  if (i < 0) return null;
  try {
    const obj = JSON.parse(line.slice(i + PREFIX.length)) as {
      standard?: string;
      event?: string;
      data?: unknown;
    };
    if (obj.standard !== "vrx" || typeof obj.event !== "string") return null;
    return { event: obj.event, data: obj.data ?? {} };
  } catch {
    return null;
  }
}

// ── Seed from known claims (hybrid) ─────────────────────────────────────────────────────
// The public indexers (NearBlocks, FastNEAR) are BLIND to our testnet reservation-flow txns (verified
// get_claim shows a live HELD claim, but NearBlocks returns 0 open_claim/reply_claim txns), and
// blind block-walking to backfill ~4645 blocks is impractical. So we SEED the mirror from the booking
// ids the portal already holds (offers + channel threads), reading each claim's AUTHORITATIVE on-chain
// status via get_claim, and synthesize the equivalent claim_opened/claim_replied events. This closes the
// held-units gap TODAY for every booking we witnessed. The forward block-tailer (below) then captures
// everything from here on, including bookings opened outside this portal.
//
// Synthetic events use tx id `seed:<requestId>` so they dedup stably and coexist with a later REAL event
// (different tx) harmlessly — claimsForNode replays ascending by `at`, so the real/latest reply wins.

/** Collect every booking id the portal knows about, from the offer store + the channel threads. */
async function knownRequestIds(): Promise<string[]> {
  const [offers, channelIds] = await Promise.all([
    allOffers().catch(() => []),
    allChannelRequestIds().catch(() => [] as string[]),
  ]);
  return Array.from(new Set<string>([...offers.map((o) => o.requestId), ...channelIds]));
}

/**
 * Read each known booking's live on-chain claim and ingest synthetic claim_opened/claim_replied events.
 * Returns how many events were newly added. Never throws — a failed read is skipped (a later seed/tick
 * retries it; dedup makes retries free). Low cost: one get_claim per known id, through the patient
 * server reader (FastNEAR-keyed). Idempotent: re-seeding overwrites nothing new once statuses are stable.
 */
export async function seedFromKnownClaims(): Promise<number> {
  const ids = await knownRequestIds();
  const synthetic: RawEvent[] = [];
  for (const requestId of ids) {
    let claim: Awaited<ReturnType<typeof getClaimServer>> = null;
    try {
      claim = await getClaimServer(requestId);
    } catch {
      continue; // transient RPC failure — a later tick retries
    }
    if (!claim) continue; // no on-chain claim for this id (recorded locally but never opened on-chain)
    const node = typeof claim.n === "string" ? claim.n : undefined;
    const status = typeof claim.s === "number" ? claim.s : undefined;
    if (!node || status === undefined) continue;
    // tc/tu are ns timestamps (created / updated). Fall back to now if absent.
    const tc = typeof claim.tc === "number" ? Math.floor(claim.tc / 1e6) : Date.now();
    const tu = typeof claim.tu === "number" ? Math.floor(claim.tu / 1e6) : tc;
    const tx = `seed:${requestId}`;
    synthetic.push({ tx, at: tc, logIndex: 0, event: "claim_opened", data: { id: requestId, node } });
    if (status !== 0) {
      synthetic.push({ tx, at: tu, logIndex: 1, event: "claim_replied", data: { id: requestId, status } });
    }
  }
  return synthetic.length ? await ingestEvents(synthetic) : 0;
}

// ── The orchestrator: seed + forward block-tailer ─────────────────────────────────────────────────
// Tuning. The tailer walks blocks forward from the cursor to head, bounded per tick so a sync never runs
// away (testnet produces ~1 block/sec, so MAX_BLOCKS_PER_TICK ≈ how many seconds of lag one tick clears).
// On a COLD start (no block cursor) we begin only COLD_MARGIN blocks behind head — history is already
// covered by the known-claims seed, so there's no reason to blind-backfill thousands of empty blocks.
// Kept small by design: the known-claims SEED (not the walk) closes the held-units gap for every booking
// the portal witnessed, so the tailer only needs to keep pace with live block production between ticks +
// a thin cold margin for very-recent outside-portal activity. Each walked block costs ~1 block RPC +
// ~1 chunk RPC, so a big cap makes a sync slow; 40/tick clears ~40s of lag per tick and a cron can tick
// often. Raise VRX_INDEXER_MAX_BLOCKS for a one-off deeper catch-up (or pass ?blocks= to the sync route).
const MAX_BLOCKS_PER_TICK = Number(process.env.VRX_INDEXER_MAX_BLOCKS || 40);
const COLD_MARGIN = Number(process.env.VRX_INDEXER_COLD_MARGIN || 20);
// WALK TOGGLE — the forward block-tailer is OFF by default. It exists only to catch bookings
// made OUTSIDE our portal (a vetted+gated actor using their own client, onto our node's inventory), which
// is ~never for a private invite-only primitive — and even then the CONTRACT prevents the only real harm
// (claim asserts tile.status==open atomically → E18 TILE_NOT_OPEN → a stale "available" just fails at
// commit with "please refresh"). So we don't poll the chain to discover change: our own bookings are
// captured by seedFromKnownClaims (0 reads), integrity at commit is owned by the contract. The walk cost
// ~80+ FastNEAR calls/15s-tick while any console tab was open — it drained the free key pool. Flip
// VRX_INDEXER_WALK=1 to re-enable (e.g. if real third-party on-chain volume ever appears; the durable fix
// then is a self-hosted near-lake PUSH indexer, not timer-polling). The SEED always runs regardless.
const WALK_ENABLED = process.env.VRX_INDEXER_WALK === "1";
// Bounded concurrency — archival round-trips dominate, so parallelism (not a bigger cap) is the speed
// lever. Kept modest to stay gentle on the shared key pool; raise if a dedicated/paid key lifts limits.
const BLOCK_CONCURRENCY = Number(process.env.VRX_INDEXER_BLOCK_CONCURRENCY || 8);
const CHUNK_CONCURRENCY = 4;
const TX_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` in flight. Resolves when all complete; never rejects
 *  (fn is expected to swallow its own errors) — a worker that throws just ends that slot. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await fn(items[idx]);
      } catch {
        /* fn owns its errors; keep the slot alive */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export type SyncResult = {
  ok: boolean;
  /** Synthetic events added by the known-claims seed this tick. */
  seeded: number;
  /** Real events added by the forward block-tailer this tick. */
  added: number;
  /** Contract txns the tailer pulled tx_status for this tick. */
  scanned: number;
  /** Blocks the tailer walked this tick. */
  walked: number;
  /** True if the tailer reached head (cursor is current); false if it stopped at the per-tick cap. */
  caughtUp: boolean;
  /** Set when the sync failed — the mirror is left at its last good cursor. */
  error?: string;
  cursorAt: number;
  cursorBlock: number;
  syncedAt: number;
  count: number;
};

// Guard against overlapping syncs (a poll firing while a previous one runs) — concurrent archival reads
// would double-spend the quota for no gain. A sync in flight short-circuits the second caller to a no-op.
let syncing = false;

/**
 * One sync tick: (1) SEED the mirror from known-booking claims (cheap get_claim reads — closes the
 * held-units gap for every booking the portal witnessed), then (2) TAIL forward from the block cursor to
 * head (bounded), scanning each block's chunks for txns to our contract and ingesting their EVENT_JSON
 * logs — this captures everything from here on, including bookings opened outside this portal. Never
 * throws — a transport failure returns { ok:false } and leaves the mirror at its last good cursor.
 *
 * `blocksThisTick` overrides the per-tick block cap (e.g. a one-off deeper catch-up). The seed runs every
 * tick (it's idempotent + cheap) so a developer's held view is correct even before the tailer catches up.
 */
export async function syncEvents(blocksThisTick = MAX_BLOCKS_PER_TICK): Promise<SyncResult> {
  const before = await getCursor();
  if (syncing) {
    return { ok: true, seeded: 0, added: 0, scanned: 0, walked: 0, caughtUp: true, ...before };
  }
  syncing = true;
  try {
    // (1) Seed from known claims — authoritative, cheap, idempotent.
    const seeded = await seedFromKnownClaims().catch(() => 0);

    // (2) Forward block-tail — OFF by default. The seed above covers every portal-authored booking;
    // the contract's own atomic tile-open assert covers integrity at commit. Skipping the walk takes the
    // steady-state burn from ~80 RPC/tick to ~the seed's cheap reads. Re-enable via VRX_INDEXER_WALK=1.
    if (!WALK_ENABLED) {
      // Advance the cursor to head WITHOUT walking, so a later re-enable doesn't try to backfill the whole
      // gap at once (history is seed-covered anyway). One cheap head read; no per-block block/chunk cost.
      try {
        const head = await headHeight();
        if (head > before.cursorBlock) await setCursorBlock(head);
      } catch {
        /* head read failed — leave cursor; next tick retries. Seed already applied. */
      }
      const after = await getCursor();
      return { ok: true, seeded, added: 0, scanned: 0, walked: 0, caughtUp: true, ...after };
    }

    const head = await headHeight();
    const from = before.cursorBlock > 0 ? before.cursorBlock + 1 : Math.max(1, head - COLD_MARGIN);
    const to = Math.min(head, from + blocksThisTick - 1);

    // Walk heights with bounded concurrency — the walk is embarrassingly parallel across heights, and
    // archival round-trips dominate the cost, so a serial walk is needlessly slow. We scan each block for
    // contract txns → collect their (hash, signer, at) refs, then fetch tx_status for the refs. The
    // cursor advances to `to` regardless (a walked-but-failed block has no recoverable txns; the seed
    // covers portal bookings), so concurrency doesn't risk a cursor gap.
    let walked = 0;
    const refs: TxnRef[] = [];
    const heights = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
    await mapLimit(heights, BLOCK_CONCURRENCY, async (h) => {
      let block: { chunks: string[]; at: number };
      try {
        block = await blockAt(h);
      } catch {
        walked++;
        return; // missing/skipped/transient — nothing to ingest at this height
      }
      walked++;
      await mapLimit(block.chunks, CHUNK_CONCURRENCY, async (chunkHash) => {
        try {
          const txns = await contractTxnsInChunk(chunkHash, block.at);
          for (const t of txns) refs.push(t);
        } catch {
          // one bad chunk read — skip (rare; seed covers portal bookings)
        }
      });
    });

    // Fetch EVENT_JSON logs for the collected contract txns (bounded concurrency), then ingest.
    let added = 0;
    let scanned = 0;
    await mapLimit(refs, TX_CONCURRENCY, async (t) => {
      try {
        const evs = await fetchTxnEvents(t);
        scanned++;
        if (evs.length) added += await ingestEvents(evs);
      } catch {
        // tx_status failed (408/429) — skip; seed-covered bookings are unaffected.
      }
    });

    // Advance the block cursor to the highest block we walked (monotonic).
    if (to >= from) await setCursorBlock(to);
    const after = await getCursor();
    return {
      ok: true,
      seeded,
      added,
      scanned,
      walked,
      caughtUp: to >= head,
      ...after,
    };
  } catch (e) {
    return {
      ok: false,
      seeded: 0,
      added: 0,
      scanned: 0,
      walked: 0,
      caughtUp: false,
      error: e instanceof Error ? e.message : String(e),
      ...before,
    };
  } finally {
    syncing = false;
  }
}
