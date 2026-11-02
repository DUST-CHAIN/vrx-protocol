// Off-chain CHANNEL store — SERVER-ONLY (file-backed). The secure-communication layer that sits
// A channel is a conversation bound to a DEAL CONTEXT. The first (and only, for now) context is a booking
// request (`requestId`) — opening a claim seeds the agent↔developer channel for that booking, so the
// developer inbox shows the offer AND a thread to talk in one place (§2d).
// ON-CHAIN OR OFF? (§2b) Message BODIES are off-chain — they are PII / deal terms and must never touch
// the chain. Only an explicit COMMITMENT summary may later be sealed exactly like an offer;
// most chat is never sealed. This stub carries bodies only; the optional seal is a later, first-class-
// but-optional action (we leave the field room — a message could gain a `sealHash` later without a
// schema break).
// TRANSPORT IS SWAPPABLE (§2c / invariant 3). v0 = store-and-forward over our server, clients gently
// poll. v1 = SSE/WebSocket push. vFuture = near.email. This module is the STORE; delivery
// is a separate concern. The route + UI must not weld the demo transport in — they talk to this store
// behind a stable shape so SSE/near.email can replace the poll without touching callers.
// Same file-backed.data pattern as gates.ts / offmarket.ts / offers.ts.
// PRIVACY: server-side only; bodies are the parties' private words. Participants are neutral account
// ids. The chain is untouched.

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { publish } from "./bus";
import { channelTopic } from "./channel-topic";

// The party roles that can author a message. BOOKING conversations use developer|agent (the original two,
//). DIRECT (pre-booking, §9 step 3) conversations add `buyer` — the only genuinely NEW actor; the
// DESK side of a direct conversation is still the existing developer/agent: "the desk IS a captive
// ≤1-agent agency — NO new operator actor"; "operator" is a human job-title, not a party type). The union is
// open so one store serves both context kinds without a schema fork — the ROUTE decides which roles are valid
// for a given context + authorizes them (lib/participant for bookings; the direct route for buyer↔desk).
// `vrx` is the SYSTEM origin (§3c enforcement seam). Unlike the three party roles it is NOT a human —
// it is VRX itself speaking into a deal thread (e.g. "this developer is late paying VRX and about to be
// suspended; your existing deal continues"). It is NEVER authored from a client: no route accepts `from:"vrx"`
// from a request body — only the server, via `postSystemNotice` below, can emit it. A `vrx` message carries
// the reserved system account id (SYSTEM_ACCOUNT) as `by`, and renders as a centred notice, not a party
// bubble (DealChat). This is the sender §3c's "notify all parties in the chat" needs; the stage-advancement
// scheduler that CALLS it is a separate, deferred enforcement seam (no caller wired here yet — on purpose).
// `agency` is a first-class author on the RELATIONSHIP context (D-slice): a developer↔agency thread that
// is NOT bound to any one deal (Part D of GOVERNED_CHANGE_DESIGN_S180.md). On a booking/direct thread the sell
// side authors as "agent"; on a relationship thread the counterparty IS the agency itself (an agent of that
// agency authors on the agency's behalf, resolved server-side). The union stays open so one store serves every
// context kind without a schema fork — the ROUTE decides which roles are valid for a given context + authorizes.
export type ChannelFrom = "developer" | "agent" | "agency" | "buyer" | "vrx";

/** The reserved account id a SYSTEM (`from:"vrx"`) message is attributed to. Not a real NEAR account — a
 * sentinel so `by` is never blank and a reader can tell a system notice from any human party. */
export const SYSTEM_ACCOUNT = "vrx";

// The conversation CONTEXT a thread hangs off ( §9 step 3). A thread used to be implicitly a BOOKING
// (keyed by requestId). It is now explicitly tagged so a thread can exist BEFORE any booking — or outside any
// single deal at all:
// { kind: "booking", id: <requestId> } — the original agent↔developer deal thread.
// { kind: "direct", id: <conversationId> } — a buyer↔desk funnel conversation (no booking yet).
// { kind: "relationship", id: <channelId> } — a developer↔agency thread spanning ALL their deals (D-
// slice): talk about a halt, a new building, terms —
// not tied to one unit/booking (GOVERNED_CHANGE_DESIGN §D).
// The on-disk STORE key is still the bare context id (so existing booking threads keyed by requestId are
// unchanged on disk). `context` is stamped onto each MESSAGE so a reader knows the kind without a side lookup;
// it is OPTIONAL for backward-compat — a legacy message with no context is read as a booking (see ctxOf).
export type ChannelContextKind = "booking" | "direct" | "relationship";
export type ChannelContext = { kind: ChannelContextKind; id: string };

export type ChannelMessage = {
  /** Opaque unique id for the message (so clients can dedupe across polls). */
  id: string;
  /** The deal context this message belongs to (the booking requestId, or a direct conversationId). The field
   * name stays `requestId` so the existing route/UI/JSON are untouched — for a direct thread it carries the
   * conversationId. `context` disambiguates the kind. */
  requestId: string;
  /** The conversation context (kind + id). Optional for backward-compat: a legacy booking message omits it
   * and is treated as { kind:"booking", id:requestId }. New writes always stamp it. */
  context?: ChannelContext;
  /** The author's role. developer|agent (booking) or operator|buyer (direct). Account id kept separate. */
  from: ChannelFrom;
  /** The author's account id (neutral). */
  by: string;
  /** The message body (off-chain plaintext). */
  text: string;
  /** ms epoch when the server recorded it. */
  at: number;
  /** Tamper-evidence chain hash ("stay VERY secure" durability). SHA-256 over the PREVIOUS
   * message's `h` concatenated with THIS message's immutable fields — so every message commits to the whole
   * history before it. Editing, deleting, reordering, or inserting any past message breaks the chain from
   * that point on (detectable via {@link verifyChain}). OPTIONAL for backward-compat: a legacy message written
   * before has no `h`; a thread is only chain-verifiable once every message carries one (chainOk below
   * treats a legacy gap as "unverifiable", never a false tamper alarm). New writes always stamp it. */
  h?: string;
};

/** The per-message chain hash: SHA-256(prevH | id | requestId | from | by | text | at). Pure. The first
 * message in a thread chains off "" (empty prev). Covers every IMMUTABLE field, so any edit to a stored
 * message — or a reorder/delete that changes which message is "previous" — yields a different hash downstream.
 * Not a keyed/peppered hash (unlike lib/seal): this is an internal integrity chain over server-authored
 * append-only data, not a low-entropy attested record an attacker brute-forces — plain SHA-256 is apt. */
function chainHash(prevH: string, m: Pick<ChannelMessage, "id" | "requestId" | "from" | "by" | "text" | "at">): string {
  return createHash("sha256")
    .update(`${prevH}|${m.id}|${m.requestId}|${m.from}|${m.by}|${m.text}|${m.at}`, "utf8")
    .digest("hex");
}

/** The context of a message, defaulting a legacy (context-less) one to a booking keyed by its requestId. */
export function ctxOf(m: ChannelMessage): ChannelContext {
  return m.context ?? { kind: "booking", id: m.requestId };
}

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "channels.json");

// The on-disk shape is a map requestId → messages[], so a thread read is a direct lookup.
type Store = Record<string, ChannelMessage[]>;

async function readAll(): Promise<Store> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

async function writeAll(store: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(store, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as activity.ts/events.ts. Without
// this, two messages posted to the same (or any) thread at once race: both readAll the old store and the
// second writeAll drops the first message. At exhibition scale (many concurrent chats) this loses messages.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (store: Store) => { next: Store; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    assertAppendOnly(cur, next); // a write may only GROW a thread, never rewrite/shorten/reorder it
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/** APPEND-ONLY GUARD ("stay VERY secure"): the everlasting chat is a durable record — an old
 * message must never be silently edited or dropped. A legal write may only ADD threads and APPEND to existing
 * ones; every message already on disk must remain byte-identical and in the same position. Throws on any
 * violation (a thread that shrank, or whose existing element changed) — the serialized `mutate` catches it so
 * the bad write never reaches disk and the thread is left untouched. This is the server-side counterpart to
 * the per-message hash chain: the chain makes tampering DETECTABLE after the fact; this guard makes a
 * well-behaved write PREVENT it in the first place. */
function assertAppendOnly(prev: Store, next: Store): void {
  for (const [id, before] of Object.entries(prev)) {
    const after = next[id];
    if (!after || after.length < before.length) {
      throw new Error(`append-only violation: thread ${id} shrank or was dropped`);
    }
    for (let i = 0; i < before.length; i++) {
      if (JSON.stringify(after[i]) !== JSON.stringify(before[i])) {
        throw new Error(`append-only violation: thread ${id} message #${i} was rewritten`);
      }
    }
  }
}

/** Every requestId we hold a thread for — a source of known booking ids for the event-mirror seed. */
export async function allChannelRequestIds(): Promise<string[]> {
  return Object.keys(await readAll());
}

/** A compact per-thread summary — the roll-up the Conversations area reads (step 3). The STORE only
 * knows message bodies; participant-scoping + title/counterpart enrichment happen in the route (which has
 * the offer/agent context), exactly like /api/agent-claims. We return every thread's last message + count
 * so the caller can filter to the viewer's threads without re-reading each one. */
export type ThreadSummary = { requestId: string; lastMsg: ChannelMessage | null; msgCount: number };
export async function allThreadSummaries(): Promise<ThreadSummary[]> {
  const store = await readAll();
  return Object.entries(store).map(([requestId, msgs]) => ({
    requestId,
    lastMsg: msgs.length > 0 ? msgs[msgs.length - 1] : null,
    msgCount: msgs.length,
  }));
}

/** The thread for one booking, oldest-first. Empty if no one has spoken yet. */
export async function getThread(requestId: string): Promise<ChannelMessage[]> {
  const id = requestId.trim();
  if (!id) return [];
  return (await readAll())[id] ?? [];
}

/** Append a message and return it (with its generated id + timestamp). `context` is optional for backward-
 * compat: omitted ⇒ a BOOKING thread keyed by requestId (the original behavior). A DIRECT conversation
 * passes context = { kind:"direct", id:<conversationId> } (and requestId = that same id). The store key is
 * always the context id, so booking and direct threads coexist in one map without colliding. */
export async function postMessage(args: {
  requestId: string;
  from: ChannelFrom;
  by: string;
  text: string;
  context?: ChannelContext;
}): Promise<ChannelMessage | null> {
  const requestId = args.requestId.trim();
  const text = args.text.trim();
  const by = args.by.trim();
  if (!requestId || !text || !by) return null;
  const context: ChannelContext = args.context ?? { kind: "booking", id: requestId };
  const msg: ChannelMessage = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    requestId,
    context,
    from: args.from,
    by,
    text: text.slice(0, 4000), // defensive cap
    at: Date.now(),
  };
  await mutate((store) => {
    const prior = store[requestId] ?? [];
    // Chain this message off the previous one's hash (empty for the first). A legacy tail with no `h` on its
    // last message chains off "" too — so the NEW message onward is verifiable even if the prefix
    // isn't; verifyChain reports that prefix as a boundary, never a false alarm.
    const prevH = prior.length > 0 ? prior[prior.length - 1].h ?? "" : "";
    msg.h = chainHash(prevH, msg);
    const next = { ...store, [requestId]: [...prior, msg] };
    return { next, ret: null };
  });
  // Push: this booking's thread changed → nudge via an OPAQUE topic (channelTopic) so the tick reveals no
  // booking id to non-parties on the shared SSE stream (F2); a party recomputes the same token to match it.
  publish(channelTopic(requestId));
  return msg;
}

/** Post a SYSTEM notice (`from:"vrx"`) into a deal thread — the §3c "notify all parties in the chat" sender.
 * This is the ONE place a `vrx`-origin message is created; a client can never author one (no route forwards
 * `from:"vrx"` from a body). It reuses postMessage's exact append/validate/push path — a system notice is a
 * normal message with a reserved author, so it lands in every participant's thread and nudges the SSE tick
 * like any other. Returns null on blank text (same validation as postMessage). The scheduler/enforcement
 * arc that decides WHEN to call this is deferred — this just makes the sender exist and be verifiable. */
export async function postSystemNotice(args: {
  requestId: string;
  text: string;
  context?: ChannelContext;
}): Promise<ChannelMessage | null> {
  return postMessage({
    requestId: args.requestId,
    from: "vrx",
    by: SYSTEM_ACCOUNT,
    text: args.text,
    context: args.context,
  });
}

/** Re-walk a thread's hash chain and report whether it is intact — the ✓ tamper check for the everlasting
 * chat. For each message, recompute chainHash(prevH, msg) and compare to its stored `h`; a mismatch
 * means that message (or an earlier one) was edited/reordered/deleted on disk.
 *
 * Returns: `ok` — true iff every chained message verifies. `verifiedFrom` — the index of the first message
 * that carries an `h` (0 when the whole thread is; a higher index when a legacy prefix has
 * no hashes). `brokenAt` — the index of the first message whose hash doesn't match, or null when intact.
 *
 * A legacy prefix (messages with no `h`) is NOT a failure: it's unverifiable, not tampered. We skip it and
 * verify the chained suffix from `verifiedFrom`, chaining the first hashed message off "" (matching how
 * postMessage seeded it when the thread was still legacy). An empty thread verifies trivially (ok, from 0). */
export async function verifyChain(
  requestId: string
): Promise<{ ok: boolean; verifiedFrom: number; brokenAt: number | null }> {
  const thread = await getThread(requestId);
  const verifiedFrom = thread.findIndex((m) => typeof m.h === "string" && m.h.length > 0);
  if (verifiedFrom === -1) return { ok: true, verifiedFrom: thread.length, brokenAt: null }; // all legacy / empty
  let prevH = "";
  for (let i = verifiedFrom; i < thread.length; i++) {
    const m = thread[i];
    if (typeof m.h !== "string" || m.h.length === 0) {
      return { ok: false, verifiedFrom, brokenAt: i }; // a gap AFTER the chain started = tampering
    }
    if (chainHash(prevH, m) !== m.h) return { ok: false, verifiedFrom, brokenAt: i };
    prevH = m.h;
  }
  return { ok: true, verifiedFrom, brokenAt: null };
}

/**
 * RE-CHAIN a thread in place after its message timestamps were rewritten (the backfill post-pass).
 * `at` IS inside chainHash's payload (see chainHash above), so merely rewriting each message's `at` would
 * break every `h` and verifyChain would flag the whole thread as tampered. This recomputes `h` oldest→first
 * EXACTLY as postMessage seeded it and verifyChain checks it: the first HASHED message chains off "", each
 * subsequent off the prior's recomputed `h`. A legacy prefix with no `h` is left untouched (unverifiable, not
 * tampered — same boundary verifyChain reports). Pure: mutates & returns the passed array (the caller persists).
 *
 * Use ONLY for the dated backfill of SEEDED threads — never on real user messages (re-sealing real history
 * would erase the very tamper-evidence the chain exists to provide). The caller asserts seed-ownership.
 */
export function rechainThread(thread: ChannelMessage[]): ChannelMessage[] {
  const verifiedFrom = thread.findIndex((m) => typeof m.h === "string" && m.h.length > 0);
  if (verifiedFrom === -1) return thread; // all legacy / empty — nothing hashed to re-chain
  let prevH = "";
  for (let i = verifiedFrom; i < thread.length; i++) {
    const m = thread[i];
    m.h = chainHash(prevH, m); // uses the message's CURRENT `at` (already rewritten by the caller)
    prevH = m.h;
  }
  return thread;
}
