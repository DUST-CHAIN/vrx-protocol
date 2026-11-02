// VRX event MIRROR — SERVER-ONLY (file-backed.data/events.json). The self-hosted enumeration
// layer: a queryable mirror of the contract's NEP-297 events so the developer inbox AND the coming agency
// app read ONE shared seam instead of each re-deriving state from the chain. ( layer #2, done for real
// this time — lib/indexer.ts was the light NearBlocks-registrations stand-in; this ingests every event.)
// THE FIRST CONCRETE WIN (the held-units gap, lib.rs:1191): when a developer ACCEPTS a booking, reply_claim
// drops the claim from the on-chain pending queue and there is no get_claims_by_node — so accepted/HELD
// bookings vanish from the developer side. The chain emits ClaimOpened{id,node} and ClaimReplied{id,status}
// for every booking though; replay those here and we can answer "all this node's bookings + their current
// status" — held included — with zero extra on-chain methods. Same for stamped/released units (TileStamped,
// HoldReleased) and exclusives (ExclusiveGranted/Released).
// PRIVACY: events carry ONLY what's already public on-chain — opaque ids/keys, neutral account ids,
// status codes. No PII, amounts, or terms. This mirror is therefore no more revealing than the chain; the
// plaintext enrichment (offers, names) stays in the party-private stores (offers.ts / catalog).
// Same file-backed.data pattern as offers.ts / gates.ts. The real architecture keeps each node's
// mirror on its own box; this.data store is the demo stand-in. Sync is cursor-driven (lib/event-fetch.ts)
// so it stays cheap + rate-safe.

import { promises as fs } from "fs";
import path from "path";
import { publish } from "./bus";

// ── Stored shape ──────────────────────────────────────────────────────────────────────────────────
/** One ingested event, as pulled from a txn's EVENT_JSON logs. Deduped on (tx, logIndex). */
export type RawEvent = {
  /** The txn hash that emitted it. */
  tx: string;
  /** ms epoch (from the txn's block_timestamp). */
  at: number;
  /** Position among this txn's EVENT_JSON lines (so (tx,logIndex) is a stable unique id). */
  logIndex: number;
  /** The event tag, snake_case, exactly as the contract emits (claim_opened, tile_stamped, …). */
  event: string;
  /** The event `data` object (opaque ids/keys/status). Shape per the Event enum in lib.rs. */
  data: unknown;
};

type EventStore = {
  /** All ingested events, de-duplicated, ascending by (at, logIndex). */
  events: RawEvent[];
  /** Cursor: the newest block_timestamp (ms) we've fully ingested — sync skips anything at/below it
   * that we already hold. We dedup on (tx,logIndex) regardless, so an overlap is harmless. */
  cursorAt: number;
  /** Block cursor: the highest block height the forward tailer has scanned. The next tick walks from
   * here → head. 0 = never tailed (the tailer starts near head so it doesn't blind-backfill history —
   * history is covered by the known-claims seed). */
  cursorBlock: number;
  /** Epoch ms of the last successful sync (for the UI "last updated"). */
  syncedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "events.json");

async function readStore(): Promise<EventStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8")) as Partial<EventStore>;
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      cursorAt: typeof parsed.cursorAt === "number" ? parsed.cursorAt : 0,
      cursorBlock: typeof parsed.cursorBlock === "number" ? parsed.cursorBlock : 0,
      syncedAt: typeof parsed.syncedAt === "number" ? parsed.syncedAt : 0,
    };
  } catch {
    return { events: [], cursorAt: 0, cursorBlock: 0, syncedAt: 0 };
  }
}

async function writeStore(s: EventStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(s, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as rpc-usage.ts.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (s: EventStore) => { next: EventStore; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readStore();
    const { next, ret } = fn(cur);
    await writeStore(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

const idOf = (e: RawEvent) => `${e.tx}#${e.logIndex}`;

/**
 * Merge freshly-fetched events into the mirror (idempotent — dedups on (tx,logIndex)). Advances the
 * cursor to the newest `at` we now hold. Returns how many were NEW this call. A sync that fetched
 * nothing new (common steady state) is a cheap no-op.
 */
export async function ingestEvents(fetched: RawEvent[]): Promise<number> {
  const added = await mutate((s) => {
    const seen = new Set(s.events.map(idOf));
    let count = 0;
    const events = s.events.slice();
    for (const e of fetched) {
      const id = idOf(e);
      if (seen.has(id)) continue;
      seen.add(id);
      events.push(e);
      count++;
    }
    events.sort((a, b) => (a.at - b.at) || (a.logIndex - b.logIndex));
    const cursorAt = events.length ? events[events.length - 1].at : s.cursorAt;
    return { next: { ...s, events, cursorAt, syncedAt: Date.now() }, ret: count };
  });
  // Only a real advance is worth a push — a no-op sync (nothing new) must not wake every client.
  if (added > 0) publish("events");
  return added;
}

/** Advance the forward tailer's block cursor (highest block fully scanned). Monotonic (never rewinds). */
export async function setCursorBlock(block: number): Promise<void> {
  await mutate((s) => ({
    next: { ...s, cursorBlock: Math.max(s.cursorBlock, block), syncedAt: Date.now() },
    ret: null,
  }));
}

/** The current cursors + last-sync time — the fetcher reads this to go incremental. */
export async function getCursor(): Promise<{
  cursorAt: number;
  cursorBlock: number;
  syncedAt: number;
  count: number;
}> {
  const s = await readStore();
  return { cursorAt: s.cursorAt, cursorBlock: s.cursorBlock, syncedAt: s.syncedAt, count: s.events.length };
}

/** All ingested events (newest-first). For the raw feed / debugging / the agency app's own derivations. */
export async function allEvents(): Promise<RawEvent[]> {
  const s = await readStore();
  return s.events.slice().reverse();
}

// ── Typed data accessors (defensive: events come from the chain as opaque JSON) ───────────────────
function dataStr(e: RawEvent, key: string): string | undefined {
  const d = e.data as Record<string, unknown> | null;
  const v = d?.[key];
  return typeof v === "string" ? v : undefined;
}
function dataNum(e: RawEvent, key: string): number | undefined {
  const d = e.data as Record<string, unknown> | null;
  const v = d?.[key];
  return typeof v === "number" ? v : undefined;
}

// ── Derived views (the enumeration the chain doesn't expose) ──────────────────────────────────────

/** A claim's reconstructed lifecycle, derived purely from events (no RPC). */
export type ClaimView = {
  requestId: string;
  node: string;
  /** Latest reply status: 0 = still open (no reply seen), 1 = accepted/HELD, 2 = declined, 3 = alt. */
  status: number;
  /** ms epoch of the opening event. */
  openedAt: number;
  /** ms epoch of the latest reply (if any). */
  repliedAt?: number;
};

/**
 * Reconstruct every booking for a node from ClaimOpened/ClaimReplied events, newest-first. This is the
 * fix for the held-units gap (lib.rs:1191): a reply_claim removes the claim from the on-chain pending
 * queue, but the ClaimReplied{id,status} event persists here, so an ACCEPTED (status 1 = HELD) booking is
 * still enumerable. status 0 = still awaiting the developer. Case-insensitive node match (account ids).
 */
export async function claimsForNode(node: string): Promise<ClaimView[]> {
  const dev = node.trim().toLowerCase();
  const s = await readStore();
  const byId = new Map<string, ClaimView>();
  // Ascending pass so later replies overwrite earlier status; opened sets the anchor.
  for (const e of s.events) {
    if (e.event === "claim_opened") {
      const id = dataStr(e, "id");
      const n = dataStr(e, "node");
      if (!id || !n || n.toLowerCase() !== dev) continue;
      const prev = byId.get(id);
      byId.set(id, { requestId: id, node: n, status: prev?.status ?? 0, openedAt: e.at, repliedAt: prev?.repliedAt });
    } else if (e.event === "claim_replied") {
      const id = dataStr(e, "id");
      if (!id) continue;
      const cur = byId.get(id);
      if (!cur) continue; // a reply whose open we scoped out (different node) — ignore
      cur.status = dataNum(e, "status") ?? cur.status;
      cur.repliedAt = e.at;
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * The node's HELD units — accepted bookings (ClaimReplied status 1) that vanished from the on-chain
 * pending queue. The concrete first win of the indexer. Returns the claim views with status === 1.
 */
export async function heldClaimsForNode(node: string): Promise<ClaimView[]> {
  return (await claimsForNode(node)).filter((c) => c.status === 1);
}

/** Latest known on-chain status for each opaque unit_key a node has touched (from TileStamped/HoldReleased). */
export async function unitStatusForNode(node: string): Promise<Record<string, number>> {
  const dev = node.trim().toLowerCase();
  const s = await readStore();
  const out: Record<string, number> = {};
  for (const e of s.events) {
    const n = dataStr(e, "node");
    const key = dataStr(e, "key");
    if (!key || !n || n.toLowerCase() !== dev) continue;
    if (e.event === "tile_stamped") {
      const st = dataNum(e, "status");
      if (st !== undefined) out[key] = st;
    } else if (e.event === "hold_released") {
      out[key] = 0; // release → back to open
    }
  }
  return out;
}
