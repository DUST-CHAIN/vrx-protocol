// VRX event MIRROR — SERVER-ONLY (file-backed.data/events.json). The self-hosted enumeration
// layer: a queryable mirror of the contract's NEP-297 events so the developer inbox AND the coming agency
// app read ONE shared seam instead of each re-deriving state from the chain. (layer #2, done for real
// this time — lib/indexer.ts was the light NearBlocks-registrations stand-in; this ingests every event.)
//
// THE FIRST CONCRETE WIN (the held-units gap, lib.rs:1191): when a developer ACCEPTS a booking, reply_claim
// drops the claim from the on-chain pending queue and there is no get_claims_by_node — so accepted/HELD
// bookings vanish from the developer side. The chain emits ClaimOpened{id,node} and ClaimReplied{id,status}
// for every booking though; replay those here and we can answer "all this node's bookings + their current
// status" — held included — with zero extra on-chain methods. Same for stamped/released units (TileStamped,
// HoldReleased) and exclusives (ExclusiveGranted/Released).
//
// PRIVACY: events carry ONLY what's already public on-chain — opaque ids/keys, neutral account ids,
// status codes. No PII, amounts, or terms. This mirror is therefore no more revealing than the chain; the
// plaintext enrichment (offers, names) stays in the party-private stores (offers.ts / catalog).
//
// Same file-backed.data pattern as offers.ts / gates.ts. The real architecture keeps each node's
// mirror on its own box; this .data store is the demo stand-in. Sync is cursor-driven (lib/event-fetch.ts)
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
   *  that we already hold. We dedup on (tx,logIndex) regardless, so an overlap is harmless. */
  cursorAt: number;
  /** Block cursor: the highest block height the forward tailer has scanned. The next tick walks from
   *  here → head. 0 = never tailed (the tailer starts near head so it doesn't blind-backfill history —
   *  history is covered by the known-claims seed). */
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
/** A numeric id list (e.g. `tokens_issued.ids` = Vec<u64>). Non-numeric members are dropped (defensive). */
function dataNumArr(e: RawEvent, key: string): number[] {
  const d = e.data as Record<string, unknown> | null;
  const v = d?.[key];
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
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

// ── Booking-token lifecycle views (V7) — the TOKEN half of ────────────────────────────────
//
// The booking-token registry (contract/src/lib.rs §Booking tokens, V7) emits a token-lifecycle event on
// every custody/scarcity transition. The off-chain store `lib/booking-tokens.ts` is the operational source
// of truth (it carries the money/economics — OFF-CHAIN); these views are the INDEPENDENT on-chain-event
// derivation — the same role `claimsForNode` plays for bookings. They answer "where is this token, where has
// it been, what does a developer hold" PURELY from the emitted events (no RPC, no store read), so a partner
// or auditor can reconstruct scarcity + custody + provenance from the chain alone. Privacy: token ids +
// accounts + the opaque unit `key` only — never amounts/economics/cash (those never leave the off-chain store).
//
// EVENT → MEANING (exact, from the Event enum, lib.rs):
//   tokens_issued {developer, ids[]}   — VRX issued fresh tokens to a developer (custody = developer)
//   token_handed  {id, from, to}       — custody moved one step along the trust graph
//   token_committed {id, key, by}      — holder committed the token to secure a unit (binds `key`)
//   token_released  {id, by}           — a committed token's slot was released (deal fell through pre-cash)
//   token_recycled  {id, developer}    — token returned to the developer as reusable capacity (terminal-ish)
//   token_reissued  {id, recycle_of, developer} — a FRESH token minted from a recycled one (new id)
//   token_frozen {id} / token_unfrozen {id}     — holder froze/unfroze (freeze follows custody)
//   token_clawed_back {id, from, to}   — an upstream authority reclaimed custody (bilateral/VRX)
//   exclusive_linked_to_token {id, key, org}    — the firm-hold exclusive was linked to this committed token
//
// The off-chain store's fine-grained states (with_agency/cash_taken/reconciling/…) are NOT on-chain — the
// events carry only the custody/scarcity facts, so these views report the COARSE on-chain lifecycle below.

/** The on-chain-derivable lifecycle of a token (coarser than the off-chain store — only what events carry). */
export type OnChainTokenState =
  | "issued" // minted to a developer, not yet committed/handed away from its genesis
  | "held" // custody has moved (handed/clawed-back) but not committed/recycled
  | "committed" // committed to secure a unit (an exclusive link may follow)
  | "frozen" // frozen by its current holder (thaws back to the pre-freeze lifecycle)
  | "recycled"; // returned to the developer as spent capacity (does not occupy a scarcity slot)

/** One reconstructed token, derived purely from its lifecycle events. */
export type TokenView = {
  id: string;
  developer?: string; // the developer the capacity belongs to (from issue/reissue/recycle events)
  custody?: string; // current holder (last hand/clawback/issue target), lower-cased account id
  state: OnChainTokenState;
  committedKey?: string; // the opaque unit key it secured, if committed
  exclusiveOrg?: string; // the agency the firm-hold exclusive was linked to, if any
  recycleOf?: string; // provenance: the recycled token this one was re-issued from
  /** The frozen token's pre-freeze lifecycle, so an unfreeze restores it. Absent when not frozen. */
  frozenFrom?: OnChainTokenState;
  issuedAt?: number; // ms epoch of the genesis event (tokens_issued / token_reissued)
  updatedAt: number; // ms epoch of the latest lifecycle event seen
};

/** Pull every lifecycle event for ONE token id out of the mirror, ascending (genesis → latest). A token id
 *  appears as `id` on most events, as a member of `ids[]` on tokens_issued, and as `recycle_of` on the
 *  reissue that descends FROM it. We collect the events that NAME this id (not the descendant's own id). */
function tokenEventsAscending(events: RawEvent[], tokenId: string): RawEvent[] {
  const want = tokenId.trim();
  if (!want) return [];
  const n = Number(want);
  const out = events.filter((e) => {
    if (dataStr(e, "id") === want) return true;
    if (e.event === "tokens_issued" && Number.isFinite(n) && dataNumArr(e, "ids").includes(n)) return true;
    return false;
  });
  // Already globally ascending in the store, but re-sort defensively (cheap, local).
  return out.sort((a, b) => (a.at - b.at) || (a.logIndex - b.logIndex));
}

/** Fold a token's ascending event stream into a TokenView. Pure — no IO. Exported so a route/test can
 *  reconstruct a view from an arbitrary event slice without touching the store. */
export function foldTokenView(tokenId: string, ascending: RawEvent[]): TokenView | null {
  if (ascending.length === 0) return null;
  const v: TokenView = { id: tokenId.trim(), state: "issued", updatedAt: 0 };
  for (const e of ascending) {
    v.updatedAt = Math.max(v.updatedAt, e.at);
    switch (e.event) {
      case "tokens_issued": {
        v.developer = dataStr(e, "developer")?.toLowerCase();
        v.custody = v.developer;
        v.state = "issued";
        v.issuedAt = e.at;
        break;
      }
      case "token_reissued": {
        // Only meaningful when THIS id is the fresh token (id === tokenId); the recycle_of→this edge is
        // captured by reissuedFrom separately. A reissue names the new token's own id.
        if (dataStr(e, "id") === v.id) {
          v.developer = dataStr(e, "developer")?.toLowerCase() ?? v.developer;
          v.custody = v.developer;
          v.recycleOf = dataStr(e, "recycle_of");
          v.state = "issued";
          v.issuedAt = e.at;
        }
        break;
      }
      case "token_handed": {
        v.custody = dataStr(e, "to")?.toLowerCase() ?? v.custody;
        if (v.state !== "frozen") v.state = "held";
        break;
      }
      case "token_clawed_back": {
        v.custody = dataStr(e, "to")?.toLowerCase() ?? v.custody;
        if (v.state !== "frozen") v.state = "held";
        break;
      }
      case "token_committed": {
        v.committedKey = dataStr(e, "key");
        v.state = "committed";
        break;
      }
      case "token_released": {
        // The slot returned to the holder; it is no longer committed but still held.
        v.committedKey = undefined;
        v.exclusiveOrg = undefined;
        v.state = "held";
        break;
      }
      case "exclusive_linked_to_token": {
        v.exclusiveOrg = dataStr(e, "org");
        v.committedKey = dataStr(e, "key") ?? v.committedKey;
        v.state = "committed";
        break;
      }
      case "token_frozen": {
        if (v.state !== "frozen") v.frozenFrom = v.state;
        v.state = "frozen";
        break;
      }
      case "token_unfrozen": {
        v.state = v.frozenFrom ?? "held";
        v.frozenFrom = undefined;
        break;
      }
      case "token_recycled": {
        v.developer = dataStr(e, "developer")?.toLowerCase() ?? v.developer;
        v.custody = v.developer; // capacity returns to the developer
        v.committedKey = undefined;
        v.exclusiveOrg = undefined;
        v.state = "recycled";
        break;
      }
    }
  }
  return v;
}

/** The full provenance of ONE token, reconstructed from events (newest-first raw trail + the folded view).
 *  Returns null if the mirror holds no event naming this id. No RPC. */
export async function tokenHistory(
  tokenId: string
): Promise<{ view: TokenView; events: RawEvent[] } | null> {
  const s = await readStore();
  const asc = tokenEventsAscending(s.events, tokenId);
  const view = foldTokenView(tokenId, asc);
  if (!view) return null;
  return { view, events: asc.slice().reverse() }; // newest-first for display, consistent with allEvents
}

/** Current holder + lifecycle state of a token, derived from events. null if unknown to the mirror. */
export async function custodyOf(tokenId: string): Promise<TokenView | null> {
  const h = await tokenHistory(tokenId);
  return h ? h.view : null;
}

/** Collect every token id the mirror has ever seen (across every lifecycle event), ascending by first-seen. */
function allTokenIds(events: RawEvent[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };
  for (const e of events) {
    if (e.event === "tokens_issued") {
      for (const n of dataNumArr(e, "ids")) add(String(n));
    } else {
      add(dataStr(e, "id"));
    }
  }
  return order;
}

/** Every token a developer owns the capacity for, reconstructed from events, newest-first by issuance.
 *  "Owns" = the developer named on the token's issue/reissue/recycle events (capacity belongs to them even
 *  while handed down the chain). Purely event-derived — the independent twin of the store's
 *  booking-tokens.tokensForDeveloper. Case-insensitive account match. */
export async function tokensForDeveloperFromEvents(developer: string): Promise<TokenView[]> {
  const dev = developer.trim().toLowerCase();
  if (!dev) return [];
  const s = await readStore();
  const views: TokenView[] = [];
  for (const id of allTokenIds(s.events)) {
    const view = foldTokenView(id, tokenEventsAscending(s.events, id));
    if (view && view.developer === dev) views.push(view);
  }
  return views.sort((a, b) => (b.issuedAt ?? b.updatedAt) - (a.issuedAt ?? a.updatedAt));
}

/** A developer's LIVE token count from events (the scarcity numerator) — every owned token NOT recycled.
 *  Mirrors booking-tokens.isLiveState (recycled = spent capacity, doesn't occupy a slot). */
export async function liveTokenCountFromEvents(developer: string): Promise<number> {
  return (await tokensForDeveloperFromEvents(developer)).filter((t) => t.state !== "recycled").length;
}

/** Every currently-COMMITTED token with the opaque unit key it secured — the on-chain "what is firmly held
 *  right now" view. Derived from events (a token in `committed` state with a `committedKey`). Newest-first. */
export async function committedTokensFromEvents(): Promise<TokenView[]> {
  const s = await readStore();
  const out: TokenView[] = [];
  for (const id of allTokenIds(s.events)) {
    const view = foldTokenView(id, tokenEventsAscending(s.events, id));
    if (view && view.state === "committed" && view.committedKey) out.push(view);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Vetting-attestation views (V7) — the ATTESTATION half of ───────────────────────────────
//
// The contract emits a vetting-attestation event on every set/amend and on VRX ratification (the
// "a developer signed off a sealed baseline, and VRX agreed" provenance stamp). Like the token views these
// are the INDEPENDENT on-chain-event derivation: "which buildings has this node attested, at what version,
// and did VRX ratify" — purely from events, no RPC. Privacy: node + opaque building scope hash + kind
// + version ONLY — never the `seal_hash` (the salted baseline it anchors) nor any slate/term/PII. The events
// structurally carry only these fields, so the derivation can't leak the sealed content.
//
// EVENT → MEANING (exact, from the Event enum, lib.rs):
//   attestation_set {node, building, kind, version} — a node set/amended an attestation (version bumps per amend)
//   attestation_ratified {node, building}           — VRX (owner-key-gated) ratified that node's attestation
//
// `kind`: 0 = release/sign-off (V7) · 1 = version-seal (future). An attestation is keyed by (node, building,
// kind); the LATEST attestation_set wins (highest version seen), and ratification is a sticky flag per (node,
// building). We fold ascending so the newest version + a later ratify both land correctly.

/** The on-chain-derivable attestation kind codes (mirrors the contract's Attestation.kind). */
export type AttestationKind = 0 | 1; // 0 = release/sign-off (V7); 1 = version-seal (future)

/** One reconstructed vetting attestation, derived purely from events. Keyed by (node, building, kind). */
export type AttestationView = {
  node: string; // the developer/node that attested (lower-cased)
  building: string; // opaque building scope hash — never the plaintext building
  kind: number; // 0 release/sign-off · 1 version-seal (future)
  version: number; // the latest attestation version seen (bumps per re-attest)
  ratified: boolean; // true once VRX ratified this node→building attestation on-chain
  setAt: number; // ms epoch of the latest attestation_set
  ratifiedAt?: number; // ms epoch of the ratification, if any
};

const attKey = (node: string, building: string, kind: number) => `${node} ${building} ${kind}`;

/** Fold every attestation event matching `pred` into a map of (node,building,kind) → AttestationView.
 *  Ascending replay so the latest version wins and a later ratify sticks. Ratification is keyed by
 *  (node, building) — it marks the node's attestation for that building, independent of kind (the contract
 *  ratifies the node→building attestation; V7 only emits kind 0). Pure — no IO. */
function foldAttestations(
  events: RawEvent[],
  pred: (node: string, building: string) => boolean
): AttestationView[] {
  const byKey = new Map<string, AttestationView>();
  const ratifiedPairs = new Map<string, number>(); // (node\0building) → ratifiedAt
  for (const e of events) {
    if (e.event === "attestation_set") {
      const node = dataStr(e, "node")?.toLowerCase();
      const building = dataStr(e, "building");
      const kind = dataNum(e, "kind");
      const version = dataNum(e, "version");
      if (!node || !building || kind === undefined || version === undefined) continue;
      if (!pred(node, building)) continue;
      const k = attKey(node, building, kind);
      const prev = byKey.get(k);
      // Keep the highest version seen (amends bump version; replay order is ascending anyway).
      if (!prev || version >= prev.version) {
        byKey.set(k, { node, building, kind, version, ratified: prev?.ratified ?? false, setAt: e.at, ratifiedAt: prev?.ratifiedAt });
      }
    } else if (e.event === "attestation_ratified") {
      const node = dataStr(e, "node")?.toLowerCase();
      const building = dataStr(e, "building");
      if (!node || !building) continue;
      if (!pred(node, building)) continue;
      ratifiedPairs.set(`${node} ${building}`, e.at);
    }
  }
  // Apply ratification to every (node,building,*) attestation (ratify is kind-independent per the contract).
  for (const v of byKey.values()) {
    const at = ratifiedPairs.get(`${v.node} ${v.building}`);
    if (at !== undefined) {
      v.ratified = true;
      v.ratifiedAt = at;
    }
  }
  return Array.from(byKey.values());
}

/** Every vetting attestation a node has set, reconstructed from events, newest-first by set time. The
 *  independent on-chain-event twin of a node's attestation inventory (no RPC). Case-insensitive node match. */
export async function attestationsForNode(node: string): Promise<AttestationView[]> {
  const dev = node.trim().toLowerCase();
  if (!dev) return [];
  const s = await readStore();
  return foldAttestations(s.events, (n) => n === dev).sort((a, b) => b.setAt - a.setAt);
}

/** Every node's attestation over ONE opaque building scope hash, newest-first. "Who has signed off this
 *  building, at what version, VRX-ratified?" — from events alone. The `building` arg is the opaque hash. */
export async function attestationsForBuilding(building: string): Promise<AttestationView[]> {
  const b = building.trim();
  if (!b) return [];
  const s = await readStore();
  return foldAttestations(s.events, (_n, bld) => bld === b).sort((a, b2) => b2.setAt - a.setAt);
}
