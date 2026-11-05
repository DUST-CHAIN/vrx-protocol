// SELLER AUTO-RESPONDER — SERVER-ONLY. The "responsive counterparty" cover for real public use.
//
// WHY (the design docs): when VRX opens to the public and real users each get play $VRX to
// negotiate / book / buy, they only fall in love if the OTHER side responds. But normal users can't be sellers
// and nobody runs a developer direct-sale desk 24/7 — so a lone real buyer/agent would stall waiting on a
// silent seller. This module acts AS the developer desk: it finds deals where a REAL user is waiting on a
// seller move and auto-progresses ONE step after a realistic delay, so the magic never breaks.
//
// DECISION: SCRIPTED now, AI-READY seam. The deal-progression is deterministic (robust + cheap
// under load); the CHAT-REPLY text goes through `replyFor` so the DeepSeek help server (lib/ai-help-server)
// can drop in later with no rework.
//
// LIFECYCLE (copied from lib/stamp-jobs, NOT lib/sync-loop): a self-driving singleton ticker that runs whether
// or not anyone is watching — a user can open a booking, close the tab, and the desk still progresses it. The
// sync-loop is audience-gated (stops when no SSE client watches) and would die the moment the user navigates
// away — wrong for this. One step per tick across ALL deals, paced, fair.
//
// SAFETY RAILS:
//  • OFF by default. Only arms when VRX_AUTORESPONDER=1 (like VRX_INDEXER). `isArmed` gates the ticker.
//  • CHAIN STUBBED. It progresses the OFF-CHAIN attested records only (lib/offers) — no tx, no RPC
//     collision. The on-chain confirm/sign ride the later signer arc; the off-chain stage is the demo truth.
//   • SEED-SAFE. It fires ONLY for deals where a REAL (non-seed) account is waiting on a REAL seller — the
//     seeded synthetic world (lib/seed-funnel) is already complete and must be left untouched. Gate =
//     isSeedAccount / isSeedDeveloper / origin:"seed".
//   • REALISTIC DELAY. A deal must sit stalled for `delayMs` before the desk acts, so it reads as a human
//     taking a moment — not an instant robot. Tracked per (requestId, stage) in-memory (no offer-shape change).

import {
  allOffers,
  contractStage,
  getOffer,
  markConfirmed,
  markPaymentArrived,
  markContractSigned,
  type Offer,
} from "./offers";
import { allThreadSummaries, getThread, postMessage, postSystemNotice, SYSTEM_ACCOUNT } from "./channels";
import { allDirectConversations, isBuyerBlocked } from "./conversations-direct";
// Pure, zlib-free seed predicates (NOT from seed-funnel — that drags a Node-only graph into the instrumentation
// edge trace, which broke the build). seed-identity has zero Node deps, safe from the startup graph.
import { isSeedAccount, isSeedDeveloper } from "./seed-identity";

/** Arm switch — OFF unless VRX_AUTORESPONDER=1. Checked on every tick so toggling env restarts cleanly. */
export function isArmed(): boolean {
  return process.env.VRX_AUTORESPONDER === "1";
}

/** How long a stall must sit before the desk acts — a realistic "human took a moment" delay. HUMAN-PACED (
 *): the FIRST reply in a conversation waits longer (the desk "notices + reads", ~12-18s); once a
 *  conversation is already going, replies come FASTER (~5-9s) so it feels like a live back-and-forth, not a flat
 *  30s wall every time. Still a single lower bound for tests. Override the base via env for tuning / demos. */
const DELAY_MS = Number(process.env.VRX_AUTORESPONDER_DELAY_MS || 12_000);
/** The in-conversation (not-first-reply) delay — shorter, so an ongoing chat feels responsive. */
const DELAY_MS_ONGOING = Number(process.env.VRX_AUTORESPONDER_DELAY_ONGOING_MS || 6_000);
/** A small deterministic jitter (0..J) added per key so replies don't arrive on a robotic fixed beat. */
const DELAY_JITTER_MS = Number(process.env.VRX_AUTORESPONDER_JITTER_MS || 5_000);
/** Human-paced delay for a thread: first reply (desk hasn't spoken yet) waits the base; an ongoing thread
 *  (the desk already replied earlier) waits the shorter ongoing delay. Jitter keyed off the stable key so a
 *  given stall's due-time is stable across ticks (no flapping) but varies thread-to-thread. */
function humanDelay(key: string, deskHasSpoken: boolean): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const jitter = DELAY_JITTER_MS ? h % DELAY_JITTER_MS : 0;
  return (deskHasSpoken ? DELAY_MS_ONGOING : DELAY_MS) + jitter;
}
/** Pace between desk actions across ALL deals — one step per tick, like the stamp-jobs paced lane. */
const TICK_MS = Number(process.env.VRX_AUTORESPONDER_TICK_MS || 8_000);

// ── The stall taxonomy ──────────────────────────────────────────────────────────────────────────────────
// Each kind is a point where a real user is blocked waiting on the SELLER (developer). Ordered by the deal's
// natural progression; the responder serves the earliest actionable stall per deal.
export type StallKind =
  | "confirm" //          booking opened, developer hasn't confirmed  → markConfirmed
  | "payment_arrived" //  contract at "final", developer must mark on-contract payment received
  | "signed"; //          contract at "payment_arrived", counterparty completes the signature

export type StalledDeal = {
  requestId: string;
  developer: string;
  kind: StallKind;
};

/** Is this offer a REAL (non-seed) deal whose counterparty is a REAL seller? Only these get auto-progressed —
 *  the seeded synthetic world is already complete and must never be touched. */
export function isRealDeal(o: Offer): boolean {
  if (o.display?.origin === "seed") return false; // demo backfill — leave it alone
  if (isSeedDeveloper(o.developer)) return false; // a seeded fictional developer is not a real silent seller
  // The waiting party: for a booking offer it's the agent (seal.by); for a direct offer it's the buyer. If
  // EITHER is identifiable as a real (non-seed) account the deal is real. We keep it conservative: if the
  // only party we can see is a seed handle, skip.
  const agent = o.seal?.by;
  const buyer = o.display?.buyer;
  const parties = [agent, buyer].filter((p): p is string => typeof p === "string" && p.length > 0);
  if (parties.length === 0) return false;
  return parties.some((p) => !isSeedAccount(p));
}

/** The earliest seller-stall on this offer, or null if nothing is waiting on the seller. */
export function stallOf(o: Offer): StallKind | null {
  if (!o.confirmed) return "confirm";
  const stage = contractStage(o);
  if (stage === "final") return "payment_arrived";
  if (stage === "payment_arrived") return "signed";
  return null; // preview (no contract yet proposed) or already signed → nothing for the desk to do
}

/** Scan all offers for REAL deals waiting on a seller move. Pure read — no mutation, no delay logic. */
export async function findStalledDeals(offers?: Offer[]): Promise<StalledDeal[]> {
  const list = offers ?? (await allOffers());
  const out: StalledDeal[] = [];
  for (const o of list) {
    if (!isRealDeal(o)) continue;
    const kind = stallOf(o);
    if (kind) out.push({ requestId: o.requestId, developer: o.developer, kind });
  }
  return out;
}

// ── Chat auto-reply (stall #4) ──────────────────────────────────────────────────────────────────────────
// A deal thread where a REAL agent/buyer spoke LAST and the seller side (developer / vrx desk) hasn't
// answered. The desk owes a reply so the user isn't left talking to a wall. We map a thread back to its offer
// to (a) confirm it's a REAL deal and (b) find the developer to reply as — a thread with no real offer behind
// it, or a seeded one, is skipped (the seeded world's chats are already complete).
export type StalledChat = { requestId: string; developer: string; deskHasSpoken: boolean };

export async function findStalledChats(): Promise<StalledChat[]> {
  const summaries = await allThreadSummaries();
  const out: StalledChat[] = [];
  for (const s of summaries) {
    const last = s.lastMsg;
    if (!last) continue;
    // The seller side already spoke last → not waiting on us.
    if (last.from === "developer" || last.from === "vrx") continue;
    // Only a REAL user's message earns an auto-reply (a seeded agent/buyer is part of the complete demo world).
    if (isSeedAccount(last.by)) continue;
    // Map the thread to its offer: confirms a real deal + yields the developer to reply as. (A direct thread's
    // key is a conversationId, not an offer requestId — those are handled by the direct lane, skipped here.)
    const offer = await getOffer(s.requestId);
    if (!offer || !isRealDeal(offer)) continue;
    // deskHasSpoken → ongoing thread (shorter human delay) vs first contact. Reads the thread (few stalled chats).
    const thread = await getThread(s.requestId);
    const deskHasSpoken = thread.some((m) => m.from === "developer" || m.from === "vrx");
    out.push({ requestId: s.requestId, developer: offer.developer, deskHasSpoken });
  }
  return out;
}

/** Reply to a stalled chat as the desk, once. No-op if the thread's last message is no longer the user's (a
 *  real human replied under us) — so we never double-post. Returns true iff a reply was posted. */
export async function progressChat(chat: StalledChat): Promise<boolean> {
  const thread = await getThread(chat.requestId);
  const last = thread[thread.length - 1];
  if (!last || last.from === "developer" || last.from === "vrx") return false; // answered under us → no-op

  // ── AI Sales Director lane — the booking-chat twin of the direct lane. When armed, the AI answers the
  // booking thread with the right persona (direct-buyer booking → buyer playbook; agent booking → agent
  // playbook), picked inside buildBookingContext from the offer. Fail-soft to the scripted reply on any fault. ──
  if (await aiBookingReply(chat.requestId)) return true;

  await postMessage({
    requestId: chat.requestId,
    from: "vrx",
    by: SYSTEM_ACCOUNT,
    text: replyForChat(last.text),
    context: { kind: "booking", id: chat.requestId },
  });
  return true;
}

/** The AI Sales Director reply for a BOOKING thread. Returns true iff the AI handled it; false → the caller posts
 *  the scripted fallback. Mirrors aiDeskReply but uses the booking-context builder + booking act path (the
 *  direct-only moves don't apply to a booking). The persona (buyer vs agent) is resolved inside buildBookingContext
 *  from the offer's origin. */
async function aiBookingReply(requestId: string): Promise<boolean> {
  try {
    const { getAiDeskConfig } = await import("./ai-desk/config");
    const cfg = await getAiDeskConfig();
    if (!cfg.enabled) return false;

    const { getOffer } = await import("./offers");
    const offer = await getOffer(requestId);
    if (!offer) return false;

    const { leversForBuilding } = await import("./ai-desk/levers");
    const levers = await leversForBuilding(offer.display?.buildingId ?? "");

    const { buildBookingContext } = await import("./ai-desk/sanitize");
    const ctx = await buildBookingContext(requestId, levers, { piiScrubChat: cfg.piiScrubChat });
    if (!ctx) return false;

    const { decide } = await import("./ai-desk/decide");
    const res = await decide(ctx, cfg, undefined, false);
    if (!res.ok) return false; // no key / upstream → scripted fallback

    const { applyBookingDecision } = await import("./ai-desk/act");
    const out = await applyBookingDecision(requestId, res.decision, cfg, offer.developer);
    return out.replied || out.actionFired !== null;
  } catch {
    return false; // any wiring fault → scripted fallback (fail-soft)
  }
}

// ── The AI-ready reply seam ─────────────────────────────────────────────────────────────────────────────
// Scripted, contextual canned text TODAY. Later: route through lib/ai-help-server (DeepSeek) for a contextual
// reply. The caller passes the deal context; this returns the text the desk posts. Keep it honest — the desk
// is an automated concierge, never pretending to be a specific named human.
export function replyFor(ctx: { kind: StallKind; requestId: string }): string {
  switch (ctx.kind) {
    case "confirm":
      return "Thanks — we've received your booking and confirmed the hold. The paperwork will follow shortly.";
    case "payment_arrived":
      return "We've marked your on-contract payment as received. Your sale agreement is now valid to sign.";
    case "signed":
      return "All signatures are in — the agreement is executed. Welcome aboard.";
  }
}

/** The desk's reply to a free-text chat message. SCRIPTED today — the AI seam: later this routes the incoming
 *  text through lib/ai-help-server (DeepSeek) for a contextual answer. Deliberately generic + honest (the desk
 *  is an automated concierge), so it's safe under any message. `_incoming` is unused today but is the hook the
 *  AI replacement reads. */
export function replyForChat(_incoming: string): string {
  return "Thanks for your message — the VRX desk has received it and will follow up on your deal shortly.";
}

// ── Direct-funnel chat auto-reply (stall #5) ────────────────────────────────────────────────────────────────
// The PRE-booking walk-in lane (docs/SELLER_AUTORESPONDER_PLAN §5): a real buyer enquiring with a building's
// desk (a lib/conversations-direct thread, keyed by an opaque conversationId, NOT a booking requestId — which
// is exactly why findStalledChats skips it) can be left talking to a wall before any booking exists. The desk
// owes a reply so the buyer isn't stuck waiting.
//
// DELIBERATELY CHAT-ONLY — it NEVER advances the funnel. The funnel states (in_conversation → units_opened →
// offer_eligible) encode real human VETTING: opening specific units to a buyer, judging KYC/eligibility. The
// desk auto-REPLIES so the buyer isn't ignored, but granting access/eligibility to a stranger stays a human
// decision (the same reason stall #3's preview→final, which needs the developer's KYC undertaking, is manual).
// So this touches lib/channels only; lib/buyers-direct funnel state is never written by the responder.
//
// BLOCKED buyers are SKIPPED: a hard-blocked buyer already gets the E-slice autoreply ("this user doesn't want
// to talk to you anymore") at message-post time — the desk must not post a friendly "we'll follow up" over that.
export type StalledDirectChat = { conversationId: string; deskHasSpoken: boolean };

export async function findStalledDirectChats(): Promise<StalledDirectChat[]> {
  const convs = await allDirectConversations();
  const out: StalledDirectChat[] = [];
  for (const c of convs) {
    const thread = await getThread(c.id); // direct threads are keyed by the conversationId in the channel store
    const last = thread[thread.length - 1];
    if (!last) continue; // a materialized-but-silent conversation can't be waiting on a reply
    // The desk already spoke last (developer message or a vrx notice) → not waiting on us.
    if (last.from === "developer" || last.from === "vrx") continue;
    // Only a REAL buyer's message earns an auto-reply (the seeded world's direct chats are already complete).
    if (isSeedAccount(c.buyer)) continue;
    // A hard-blocked buyer is handled by the block path's own autoreply — never post a concierge reply over it.
    if (await isBuyerBlocked(c.id)) continue;
    // deskHasSpoken → this is an ONGOING chat (shorter human delay), vs a first contact (longer "notice+read").
    const deskHasSpoken = thread.some((m) => m.from === "developer" || m.from === "vrx");
    out.push({ conversationId: c.id, deskHasSpoken });
  }
  return out;
}

/** Reply to a stalled direct enquiry as the desk, once. When the AI Sales Director is ARMED (ai-desk config
 * `enabled`) it routes the enquiry through the ai-desk brain — a real salesperson reply + an optional
 *  gated action — and FALLS BACK to the scripted concierge line on any fault (no key / upstream / unscopable),
 *  the same fail-soft posture as ai-help-server. When not armed it posts the scripted line as before. No-op if
 *  the buyer is no longer the last speaker or got blocked in the meantime. NEVER touches the funnel state. */
export async function progressDirectChat(chat: StalledDirectChat): Promise<boolean> {
  const thread = await getThread(chat.conversationId);
  const last = thread[thread.length - 1];
  if (!last || last.from === "developer" || last.from === "vrx") return false; // answered under us → no-op
  if (await isBuyerBlocked(chat.conversationId)) return false; // blocked under us → the block path owns the reply

  // ── AI Sales Director lane — armed = ai-desk config `enabled`. Fail-soft to the scripted reply. ──
  if (await aiDeskReply(chat.conversationId)) return true;

  const posted = await postSystemNotice({
    requestId: chat.conversationId, // the channel-store key for a direct thread IS the conversationId
    text: replyForDirectChat(last.text),
    context: { kind: "direct", id: chat.conversationId },
  });
  return posted !== null;
}

/** The AI Sales Director reply for a direct enquiry. Returns true iff the AI handled it (replied/acted); false
 *  → the caller posts the scripted fallback. Reads the live ai-desk config: if `enabled` is false it declines
 *  immediately (returns false) so the scripted path runs. All PII masking/scrub happens in buildDeskContext —
 *  this orchestrator never touches raw PII beyond handing the stored profile straight into that gate. */
async function aiDeskReply(conversationId: string): Promise<boolean> {
  try {
    const { getAiDeskConfig } = await import("./ai-desk/config");
    const cfg = await getAiDeskConfig();
    if (!cfg.enabled) return false;

    const { directParties } = await import("./conversations-direct");
    const parties = await directParties(conversationId);
    if (!parties) return false;

    const { getBuyerDirect } = await import("./buyers-direct");
    const buyer = await getBuyerDirect(parties.buyer).catch(() => null);

    const { leversForBuilding } = await import("./ai-desk/levers");
    const levers = await leversForBuilding(parties.building);

    const { buildDeskContext } = await import("./ai-desk/sanitize");
    const ctx = await buildDeskContext(
      conversationId,
      buyer?.profile,
      levers,
      { piiScrubChat: cfg.piiScrubChat },
      false, // consent is a future per-conversation buyer toggle; default = scrub on (fail-closed)
      buyer?.maskOverride
    );
    if (!ctx) return false;

    const { decide } = await import("./ai-desk/decide");
    const res = await decide(ctx, cfg, undefined, false);
    if (!res.ok) return false; // no key / upstream → scripted fallback

    const { applyDecision } = await import("./ai-desk/act");
    const out = await applyDecision(conversationId, res.decision, cfg, parties.developer);
    return out.replied || out.actionFired !== null;
  } catch {
    return false; // any wiring fault → let the scripted reply run (fail-soft)
  }
}

/** The desk's reply to a pre-booking enquiry. SCRIPTED today — the AI seam (same as replyForChat): later this
 *  routes the incoming text through lib/ai-help-server. Honest (automated concierge) and safe under any message;
 *  it promises a human follow-up, NOT access — access is a human vetting decision the funnel still gates. */
export function replyForDirectChat(_incoming: string): string {
  return "Thanks for reaching out to the VRX desk — we've received your enquiry and a desk agent will follow up shortly.";
}

/** Progress exactly ONE deal ONE step, acting as the developer. Returns the step taken, or null if it was a
 * no-op (stage changed under us / unknown kind). Chain STUBBED — off-chain records only. */
export async function progressOne(deal: StalledDeal): Promise<StallKind | null> {
  const { requestId, developer, kind } = deal;
  // Re-check the stall still applies BEFORE acting: the mark* fns are idempotent and return the (unchanged)
  // offer on a replay, so a non-null result alone doesn't mean we advanced — which would post a duplicate
  // reply. stallOf is the single source of truth; if the offer is gone or no longer at this stall, no-op.
  const current = await getOffer(requestId);
  if (!current || stallOf(current) !== kind) return null;
  let acted: Offer | null = null;
  switch (kind) {
    case "confirm":
      acted = await markConfirmed(requestId, developer);
      break;
    case "payment_arrived":
      acted = await markPaymentArrived(requestId, developer);
      break;
    case "signed":
      acted = await markContractSigned(requestId);
      break;
  }
  if (!acted) return null;
  // Post a system notice into the deal thread so the waiting user SEES the desk responded (the "desk is
  // responding" signal). from:"vrx" = an honest automated-concierge notice, never a human impersonation.
  await postMessage({
    requestId,
    from: "vrx",
    by: SYSTEM_ACCOUNT,
    text: replyFor({ kind, requestId }),
    context: { kind: "booking", id: requestId },
  });
  return kind;
}

// ── The realistic-delay gate ────────────────────────────────────────────────────────────────────────────
// A stall must be observed for DELAY_MS before the desk acts. We don't touch any stored shape — the first time
// we SEE a stall (by its stable key) we stamp it here; it becomes actionable once DELAY_MS passes. ONE shared
// clock across both deal-stalls and chat-stalls, so a burst is never possible and both share the fair pace.
const firstSeen = new Map<string, number>();
const dealKey = (d: StalledDeal) => `deal:${d.requestId}:${d.kind}`; // kind in the key → each step re-clocks
const chatKey = (c: StalledChat) => `chat:${c.requestId}`;
const directChatKey = (c: StalledDirectChat) => `direct:${c.conversationId}`;

/** Generic due-gate: stamp newly-seen keys, prune keys no longer live (resolved), return the items whose clock
 *  has elapsed. Keeping ONE map keyed across kinds means a resolved stall is pruned no matter its type. */
function dueItems<T>(
  items: T[],
  keyOf: (t: T) => string,
  live: Set<string>,
  now: number,
  delayOf?: (t: T, k: string) => number
): T[] {
  for (const k of firstSeen.keys()) if (!live.has(k)) firstSeen.delete(k); // prune everything not currently live
  const due: T[] = [];
  for (const it of items) {
    const k = keyOf(it);
    const seen = firstSeen.get(k);
    if (seen === undefined) {
      firstSeen.set(k, now); // first observation — start the clock, not due yet
      continue;
    }
    const delay = delayOf ? delayOf(it, k) : DELAY_MS;
    if (now - seen >= delay) due.push(it);
  }
  return due;
}

/** All currently-live clock keys across the three lanes — the ONE liveness set every due-call prunes against,
 *  so `dueItems` (which drops every firstSeen key not in `live`) never prunes a live clock from another lane.
 *  Each due-function builds this from its own items plus whatever complement lanes the caller passes. */
function liveKeys(
  deals: StalledDeal[],
  chats: StalledChat[],
  directChats: StalledDirectChat[]
): Set<string> {
  return new Set([...deals.map(dealKey), ...chats.map(chatKey), ...directChats.map(directChatKey)]);
}

/** The deal-stalls stalled long enough to act on. (Prunes against ALL three lanes' live keys so no lane's
 *  resolved entries linger and no live entry is wrongly pruned.) Exported for tests. */
export function dueDeals(
  stalled: StalledDeal[],
  now = Date.now(),
  liveChats: StalledChat[] = [],
  liveDirectChats: StalledDirectChat[] = []
): StalledDeal[] {
  return dueItems(stalled, dealKey, liveKeys(stalled, liveChats, liveDirectChats), now);
}

/** The booking-chat stalls stalled long enough to answer. */
export function dueChats(
  chats: StalledChat[],
  now = Date.now(),
  liveDeals: StalledDeal[] = [],
  liveDirectChats: StalledDirectChat[] = []
): StalledChat[] {
  return dueItems(chats, chatKey, liveKeys(liveDeals, chats, liveDirectChats), now,
    (c, k) => humanDelay(k, c.deskHasSpoken));
}

/** The direct-funnel chat stalls (stall #5) stalled long enough to answer. */
export function dueDirectChats(
  directChats: StalledDirectChat[],
  now = Date.now(),
  liveDeals: StalledDeal[] = [],
  liveChats: StalledChat[] = []
): StalledDirectChat[] {
  return dueItems(directChats, directChatKey, liveKeys(liveDeals, liveChats, directChats), now,
    (c, k) => humanDelay(k, c.deskHasSpoken));
}

/** Test/shutdown helper: forget all observed-stall timestamps. */
export function resetResponderState(): void {
  firstSeen.clear();
}

// ── The self-driving singleton ticker (mirrors lib/stamp-jobs) ──────────────────────────────────────────
let ticker: ReturnType<typeof setTimeout> | null = null;
let ticking = false;

/** What a single tick did: advanced a deal step, answered a booking chat, answered a direct enquiry, or nothing. */
export type TickResult =
  | { kind: "deal"; step: StallKind }
  | { kind: "chat" }
  | { kind: "direct" }
  | null;

/** One tick: if armed, do AT MOST ONE action (fair, paced). Priority deal > booking-chat > direct-enquiry (a
 *  stalled deal is more consequential than an unanswered message; a booking chat is a live deal, a direct chat
 *  is pre-booking). Exported so tests can step deterministically. All THREE stall sets are gated against ONE
 *  combined liveness set (each due-call is passed the other two lanes) so the shared firstSeen clock prunes
 *  consistently whichever lane we act on. */
export async function tickOnce(now = Date.now()): Promise<TickResult> {
  if (!isArmed()) return null;
  if (ticking) return null;
  ticking = true;
  try {
    const stalled = await findStalledDeals();
    const chats = await findStalledChats();
    const directChats = await findStalledDirectChats();
    const dueD = dueDeals(stalled, now, chats, directChats);
    if (dueD.length > 0) {
      const step = await progressOne(dueD[0]);
      if (step) return { kind: "deal", step };
    }
    const dueC = dueChats(chats, now, stalled, directChats);
    if (dueC.length > 0) {
      const posted = await progressChat(dueC[0]);
      if (posted) return { kind: "chat" };
    }
    const dueDC = dueDirectChats(directChats, now, stalled, chats);
    if (dueDC.length > 0) {
      const posted = await progressDirectChat(dueDC[0]);
      if (posted) return { kind: "direct" };
    }
    return null;
  } catch {
    return null; // transport hiccup — the records are unchanged; the next tick retries
  } finally {
    ticking = false;
  }
}

/** Start the responder ticker if armed and not already running. Idempotent. Safe to call from startup. */
export function ensureResponder(): void {
  if (ticker || !isArmed()) return;
  const beat = () => {
    void tickOnce().finally(() => {
      if (ticker) ticker = schedule(beat);
    });
  };
  ticker = schedule(beat);
}

function schedule(fn: () => void): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, TICK_MS);
  (t as unknown as { unref?: () => void }).unref?.(); // never block a graceful shutdown
  return t;
}

/** Stop the ticker (tests / shutdown). Does not alter any deal state. */
export function stopResponder(): void {
  if (ticker) {
    clearTimeout(ticker);
    ticker = null;
  }
}
