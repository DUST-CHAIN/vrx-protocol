// DIRECT (pre-booking) CONVERSATIONS — SERVER-ONLY. §9 step 3: the buyer↔desk funnel conversation that
// exists BEFORE any booking. It is the SECOND context kind of the generalized channel store (lib/channels):
// a thread tagged { kind:"direct", id:<conversationId> } instead of { kind:"booking", id:<requestId> }.
//
// WHO TALKS ("the desk IS a captive ≤1-agent agency, NO new operator actor"): the two parties are the
// BUYER (the walk-in, keyed by wallet account) and the DESK side = the building's DEVELOPER (in-house first,
// §8-1; a VRX-managed desk later swaps the counterparty on the same seam). "Operator" is the human running
// the desk — a job title, not a party type. So a direct message's `from` is "buyer" or "developer".
//
// CONVERSATION IDENTITY: one conversation per (buyer, building) — a buyer enquiring about a building has one
// ongoing thread with that building's desk, not a new thread per message. The id is a stable, opaque digest
// of (buyer, building) so it can't be guessed/enumerated and reveals neither party on the wire (same posture
// as the booking requestId it sits beside). Deriving it is pure → the client never needs to "create" a
// thread first; posting the first message materializes it (the channel store is create-on-write).
//
// SCOPING (fail-closed, the direct-context twin of lib/participant for bookings): a viewer is a participant iff
// they are the buyer OR the building's developer. `directRole(conversationId, viewer)` returns "buyer" |
// "developer" | null. Because the conversationId is derived from (buyer, building), we store the mapping when
// the conversation is first referenced so the id resolves back to its parties.
//
// PRIVACY: bodies are off-chain plaintext; the chain is untouched; parties are neutral account ids. The
// building a buyer is enquiring about is as sensitive as a booking's — hence the opaque id + the gate.

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { getBuilding } from "./catalog";
import { listDevelopers } from "./developers";
import { getThread } from "./channels";
import { seenFor } from "./read-markers";

export type DirectRole = "buyer" | "developer";

/**
 * C-slice — the per-conversation REVEAL negotiation state (the design docs §3). The
 * direct twin of the booking unlock ceremony (lib/offers.ts requestReveal→revealBuyer), but with ONE
 * fewer party: in booking the developer requests and the AGENT (the buyer's protector) approves; here there is
 * no agent — the BUYER protects themselves, so the desk requests and the buyer consents DIRECTLY.
 *
 * Lives on the CONVERSATION (not the buyer's global record): a grant is a property of THIS buyer↔desk
 * relationship, and must not leak to other desks. The buyer's GLOBAL visibility dial (B, maskOverride on
 * BuyerDirect) is separate and merges UNDER this (see grantedFieldsFor / the effective-mask resolution in the
 * route). calls baked in: (1) the desk accepts a SEALED non-circumvention declaration when it
 * requests (evidence on record even if the buyer declines — mirrors booking's T1); (2) a grant is PERMANENT
 * for the conversation's life (no re-mask; only a D call-off wipes it); (3) the desk may request fields the
 * buyer has NOT filled (ask-to-provide) as well as filled-but-hidden ones (unmask) — the request names fields,
 * the buyer provides/consents.
 */
export type DirectReveal = {
  /** The desk's PENDING request. Present + no matching grant = awaiting the buyer. One at a time (idempotent-
   *  ish: a repeat request while one is pending is a no-op, like requestReveal). Cleared when granted/declined. */
  request?: {
    /** The desk developer account that asked. */
    by: string;
    /** ms epoch asked. */
    at: number;
    /** Which profile fields the desk asked to SEE (unmask) or be PROVIDED (if the buyer hasn't filled them). */
    fields: string[];
    /** Sealed hash of the non-circumvention declaration the desk accepted when asking (T1 evidence). */
    declarationSeal: string;
  };
  /** Fields the buyer has CONSENTED to reveal to this desk — PERMANENT for the conversation's life (Q2).
   *  Merged as `show` OVER the buyer's global dial + the system default when the desk reads the profile. Grows
   *  only (a later consent to more fields appends); a D call-off (next slice) is the one thing that clears it. */
  grantedFields?: string[];
  /** ms epoch the most recent consent fired (for the audit readout). */
  grantedAt?: number;
};

/**
 * D-slice — the "polite goodbye" / call-off state (the design docs §4). the model:
 * a call-off is a BILATERAL handshake, not a unilateral switch. Either party PROPOSES a call-off ("I'm out, no
 * hard feelings"); it sits PENDING until the OTHER party AGREES (then both reset) or the proposer WITHDRAWS it
 * (Q1: pending-until-agreed, either can cancel, no timeout). On mutual agreement the DEAL resets to a clean
 * slate — a `vrx` horizontal-rule marker in the thread, the deal `epoch` increments, and consent is wiped
 * (C's grantedFields cleared here; the buyer's global dial reset by the ROUTE, which owns the buyers-direct dep).
 * The CHAT survives (append-only); re-engagement is allowed (next message = a new deal) UNLESS a hard block (E,
 * next slice) is in force. No blame recorded — explicitly no-prejudice.
 */
export type DirectCallOff = {
  /** The PENDING proposal. Present = someone proposed closing the deal, awaiting the other party. Absent = none. */
  proposal?: {
    /** Which side proposed (buyer | developer) — so the UI shows the right "agree/withdraw" affordance. */
    by: DirectRole;
    /** The proposer's account (for the audit readout). */
    byAccount: string;
    /** ms epoch proposed. */
    at: number;
  };
  /** The deal epoch — starts at 0 (the first deal), increments by 1 on each completed (mutually-agreed) call-off.
   *  Anything in the thread after a reset belongs to the new epoch (a new deal). Absent = epoch 0 (legacy/never-
   *  reset). */
  epoch?: number;
  /** ms epoch the most recent call-off completed (the last reset). For the audit readout. */
  closedAt?: number;
};

/** The index row that lets a derived conversationId resolve back to its (buyer, building) parties. */
type DirectConversation = {
  /** The derived opaque id (also the channel-store key for this thread). */
  id: string;
  /** The buyer's wallet account (lowercased). */
  buyer: string;
  /** The building id the enquiry is about. */
  building: string;
  /** ms epoch first materialized. */
  at: number;
  /** C-slice: the reveal negotiation state for this conversation. Absent = nothing requested/granted
   *  (the default fully-masked floor + the buyer's global dial apply). */
  reveal?: DirectReveal;
  /** D-slice: the call-off handshake + deal epoch. Absent = a live first deal, no call-off in flight. */
  callOff?: DirectCallOff;
  /**
 * E-slice: the active HARD BLOCK. DESK-ONLY (revision — only the desk blocks; the buyer's
   * recourse is call-off (D) + escalate to VRX (F), not a block). While `blocked` is true the buyer's messages
   * STILL LAND in the thread (the desk receives them — nothing lost), but the buyer gets a `vrx` autoreply
   * ("this user doesn't want to talk to you anymore"). The desk can UNBLOCK (restores normal messaging). Absent
   * = not blocked. */
  block?: { blocked: boolean; at: number };
  /**
 * E-slice: the PERMANENT anti-cheat demotion. the rule — a buyer BLOCKED by this desk once must NOT
   * re-approach the SAME desk anonymously to retry. Set the first time the desk blocks; the desk-read mask
   * resolution FORCE-SHOWS the buyer's identity to THIS desk (overriding the masked-by-default floor) so they
 * can't hide. Scoped per (buyer, desk) — the buyer stays masked-by-default to OTHER desks (the choice,
 * NOT a global scarlet letter). PERSISTS through UNBLOCK (: unblock restores messaging, NOT anonymity)
   * and through a call-off reset (you can't launder a block by calling the deal off). Once set, never cleared. */
  priorBlock?: { at: number; by: DirectRole };
  /**
 * F-slice: ESCALATE TO VRX REVIEW. Unlike D (call-off) and E (block) which are ENDINGS, escalation is
   * the one move that keeps the deal LIVE and brings VRX in to mediate — the buyer's recourse (symmetric: either
   * party may flag). `status:"open"` = awaiting VRX; `"resolved"` = VRX has responded. VRX speaks into the thread
   * via a `vrx` system notice (postSystemNotice). MOAT GUARD: escalation flags the conversation; it does NOT
   * change the PII projection — VRX reviews the NEGOTIATION RECORD (thread + B/C/D/E state), never the buyer's
   * sealed identity (unless a reveal was already consented). Thin first cut: flag → vrx acks → vrx resolves. */
  escalation?: {
    status: "open" | "resolved";
    /** Which side raised it (buyer | developer) + their account + when. */
    by: DirectRole;
    byAccount: string;
    at: number;
    /** Optional short reason the flagger gave (free text, capped; NO PII expected but treated as off-chain body). */
    reason?: string;
    /** ms epoch VRX resolved it (set when status → resolved). */
    resolvedAt?: number;
  };
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "conversations-direct.json");
const DOMAIN = "vrx-direct-conversation"; // salts the id so it can't be matched against hashes used elsewhere

// ── store IO (serialized, same lost-write guard as the other .data stores) ──────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: DirectConversation[]) => { next: DirectConversation[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<DirectConversation[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DirectConversation[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: DirectConversation[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const norm = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** The stable, opaque conversation id for a (buyer, building) pair. Pure — same inputs → same id. */
export function directConversationId(buyer: string, building: string): string {
  const b = norm(buyer);
  const g = building.trim(); // building ids are not lowercased elsewhere
  return createHash("sha256").update(`${DOMAIN}|${b}|${g}`).digest("hex").slice(0, 32);
}

/** The building's DESK-side developer account (in-house, §8-1): the developer whose buildingIds include it.
 *  Null if no developer lists it (→ the conversation can't be scoped → fail closed). */
export async function deskDeveloperFor(building: string): Promise<string | null> {
  const g = building.trim();
  if (!g) return null;
  const dev = (await listDevelopers()).find((d) => d.buildingIds.includes(g));
  return dev?.account ?? null;
}

/**
 * Resolve (buyer, building) → the conversation, materializing the index row on first reference so the id can
 * later resolve back to its parties. Returns null if the building isn't direct-sale-visible OR has no desk
 * developer (fail closed — never open a thread about a building a buyer can't browse). `ensure` = whether to
 * persist the index row (true when the buyer is actually starting the conversation).
 */
export async function resolveDirectConversation(
  buyer: string,
  building: string,
  ensure: boolean
): Promise<{ id: string; buyer: string; building: string; developer: string } | null> {
  const b = norm(buyer);
  const g = building.trim();
  if (!b || !g) return null;

  const bld = await getBuilding(g);
  if (!bld || bld.directSale?.visible !== true) return null; // only visible buildings have a desk to talk to
  const developer = await deskDeveloperFor(g);
  if (!developer) return null;

  const id = directConversationId(b, g);
  if (ensure) {
    await mutate((list) => {
      if (list.some((c) => c.id === id)) return { next: list, ret: null };
      return { next: [...list, { id, buyer: b, building: g, at: Date.now() }], ret: null };
    });
  }
  return { id, buyer: b, building: g, developer };
}

/** The index row for a conversation id (null if never materialized). */
async function conversationById(id: string): Promise<DirectConversation | null> {
  const want = id.trim();
  if (!want) return null;
  return (await readAll()).find((c) => c.id === want) ?? null;
}

/**
 * The viewer's role in a direct conversation, or null if they aren't a participant (FAIL CLOSED). A viewer is
 * the BUYER (their account == the conversation's buyer) or the DEVELOPER (their account == the building's desk
 * developer). Mirrors lib/participant.roleOnBooking for the direct context.
 */
export async function directRole(conversationId: string, viewer: string): Promise<DirectRole | null> {
  const v = norm(viewer);
  if (!v) return null;
  const conv = await conversationById(conversationId);
  if (!conv) return null;
  if (conv.buyer === v) return "buyer";
  const developer = await deskDeveloperFor(conv.building);
  if (developer && developer.toLowerCase() === v) return "developer";
  return null;
}

/** The parties of a conversation (for display/counterpart resolve), or null if unknown/unscopable. */
export async function directParties(
  conversationId: string
): Promise<{ buyer: string; building: string; developer: string } | null> {
  const conv = await conversationById(conversationId);
  if (!conv) return null;
  const developer = await deskDeveloperFor(conv.building);
  if (!developer) return null;
  return { buyer: conv.buyer, building: conv.building, developer };
}

/** Every direct conversation a viewer participates in — for the desk's enquiry list + the buyer's thread list. */
export async function directConversationsFor(
  viewer: string
): Promise<Array<{ id: string; buyer: string; building: string; developer: string }>> {
  const v = norm(viewer);
  if (!v) return [];
  const all = await readAll();
  const out: Array<{ id: string; buyer: string; building: string; developer: string }> = [];
  for (const c of all) {
    const developer = await deskDeveloperFor(c.building);
    if (!developer) continue; // unscopable → drop (fail closed)
    if (c.buyer === v || developer.toLowerCase() === v) {
      out.push({ id: c.id, buyer: c.buyer, building: c.building, developer });
    }
  }
  return out;
}

/** EVERY direct conversation with its resolvable parties (id + buyer + building + desk developer) — the
 *  unscoped twin of directConversationsFor, for a server-side sweep that isn't tied to one viewer (the seller
 *  auto-responder's direct lane). Rows whose building has no desk developer are DROPPED (fail closed — an
 * unscopable conversation has no desk to reply as). No bodies, no PII: parties are neutral account ids. */
export async function allDirectConversations(): Promise<
  Array<{ id: string; buyer: string; building: string; developer: string }>
> {
  const all = await readAll();
  const out: Array<{ id: string; buyer: string; building: string; developer: string }> = [];
  for (const c of all) {
    const developer = await deskDeveloperFor(c.building);
    if (!developer) continue; // unscopable → drop (fail closed)
    out.push({ id: c.id, buyer: c.buyer, building: c.building, developer });
  }
  return out;
}

// ── REVEAL negotiation (C-slice) — the desk asks, the buyer consents ──────────────────────────────────
// The direct twin of the booking reveal ceremony. Scoped to the conversation; the buyer is their own
// protector (no agent middle-party). All mutators serialize through `mutate`. A reveal grant is PERMANENT for
// the conversation's life (Q2) — these never RE-MASK; only a D call-off (next slice) clears grantedFields.

/** The direct-buyer profile field names a reveal request may name. Kept local (not imported from buyers-direct)
 *  so this module stays dependency-free of the buyer store; must mirror BuyerDirectProfile's keys. An unknown
 *  key in a request/consent is DROPPED (fail-closed: you can't request/grant a field that isn't a real one). */
const KNOWN_PROFILE_FIELDS: ReadonlySet<string> = new Set<string>([
  "name", "legalName", "nationality", "phone", "email", "passportNo", "idCardNo", "address",
]);

/** Clean a submitted field list: trim, keep only known profile keys, dedupe, preserve order. [] if nothing valid. */
function cleanRevealFields(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  const out: string[] = [];
  for (const f of fields) {
    const k = typeof f === "string" ? f.trim() : "";
    if (KNOWN_PROFILE_FIELDS.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** The reveal state of a conversation (null if the conversation is unknown; `{}`-ish DirectReveal if untouched). */
export async function getDirectReveal(conversationId: string): Promise<DirectReveal | null> {
  const conv = await conversationById(conversationId);
  if (!conv) return null;
  return conv.reveal ?? {};
}

/**
 * The fields currently CONSENTED-to for this conversation (the desk may see these in full, on top of the
 * buyer's global dial). [] if none / unknown. PURE read — the route folds these into the effective mask as
 * `show` before projecting the profile to the desk.
 */
export async function grantedFieldsFor(conversationId: string): Promise<string[]> {
  const conv = await conversationById(conversationId);
  return conv?.reveal?.grantedFields ?? [];
}

/**
 * The DESK requests a reveal / more fields (Q1+Q3). Records a PENDING request carrying the fields
 * asked for and the SEALED non-circumvention declaration the desk accepted (evidence on record even if the
 * buyer later declines). Idempotent-ish: if a request is already pending (and not yet granted for exactly these
 * fields) the FIRST request's provenance is kept — a repeat is a no-op. `fields` is cleaned to the known profile
 * keys; an empty/garbage field list is refused (returns null). Returns the updated reveal state, or null if the
 * conversation is unknown or nothing valid was asked.
 */
export async function requestDirectReveal(
  conversationId: string,
  by: string,
  fields: string[],
  declarationSeal: string
): Promise<DirectReveal | null> {
  const id = conversationId.trim();
  const asker = norm(by);
  const want = cleanRevealFields(fields);
  if (!id || !asker || want.length === 0 || !declarationSeal.trim()) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    const reveal: DirectReveal = { ...(cur.reveal ?? {}) };
    // Idempotent-ish: keep the first pending request's provenance (don't overwrite a live ask).
    if (reveal.request) return { next: list, ret: reveal };
    reveal.request = { by: asker, at: Date.now(), fields: want, declarationSeal: declarationSeal.trim() };
    const next = list.slice();
    next[idx] = { ...cur, reveal };
    return { next, ret: reveal };
  });
}

/**
 * The BUYER CONSENTS to a desk's pending request (Q2 — permanent). Appends the consented fields to
 * `grantedFields` (union; a grant only grows) and CLEARS the pending request. `consentFields` lets the buyer
 * grant a SUBSET of what was asked (incremental/mutual consent); omitted/empty ⇒ consent to the whole request.
 * Only fields that were actually in the pending request can be granted (you can't consent to something not
 * asked). Returns the updated reveal state, or null if the conversation is unknown or there's no pending request.
 */
export async function grantDirectReveal(
  conversationId: string,
  consentFields?: string[]
): Promise<DirectReveal | null> {
  const id = conversationId.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    const req = cur.reveal?.request;
    if (!req) return { next: list, ret: cur.reveal ?? {} }; // nothing to consent to
    const asked = new Set(req.fields);
    // Default: grant everything asked. Else grant only the requested fields the buyer picked.
    const picked = consentFields && consentFields.length > 0
      ? cleanRevealFields(consentFields).filter((f) => asked.has(f))
      : req.fields;
    const granted = [...new Set([...(cur.reveal?.grantedFields ?? []), ...picked])];
    const reveal: DirectReveal = { grantedFields: granted, grantedAt: Date.now() }; // request cleared (consumed)
    const next = list.slice();
    next[idx] = { ...cur, reveal };
    return { next, ret: reveal };
  });
}

/**
 * The BUYER DECLINES a desk's pending request — drop the pending request, keep any prior grants untouched. The
 * sealed declaration the desk accepted stays on the thread/evidence trail (it was logged when asked; declining
 * doesn't erase that the desk gave the undertaking). Returns the updated reveal state, or null if unknown.
 * No-op if there was no pending request.
 */
export async function declineDirectReveal(conversationId: string): Promise<DirectReveal | null> {
  const id = conversationId.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (!cur.reveal?.request) return { next: list, ret: cur.reveal ?? {} }; // nothing pending
    const { request: _dropped, ...rest } = cur.reveal;
    const next = list.slice();
    next[idx] = { ...cur, reveal: rest };
    return { next, ret: rest };
  });
}

// ── CALL-OFF handshake (D-slice) — the bilateral "polite goodbye" ─────────────────────────────────────
// Either party PROPOSES; the other AGREES (→ both reset) or the proposer WITHDRAWS. No timeout (Q1). On a
// mutual agree the deal resets: grantedFields cleared here, epoch++, a thread marker + the buyer's global dial
// reset done by the ROUTE (which owns the buyers-direct dependency). priorBlock is PRESERVED across a reset.

/** The call-off state of a conversation (null if unknown; a DirectCallOff — possibly empty — otherwise). */
export async function getCallOff(conversationId: string): Promise<DirectCallOff | null> {
  const conv = await conversationById(conversationId);
  if (!conv) return null;
  return conv.callOff ?? {};
}

/** The current deal epoch (0 if none/legacy). A message after a reset belongs to epoch N+1 = a new deal. */
export async function dealEpoch(conversationId: string): Promise<number> {
  const conv = await conversationById(conversationId);
  return conv?.callOff?.epoch ?? 0;
}

/**
 * PROPOSE a call-off. `by` is the proposer's ROLE (resolved by the route from directRole); `byAccount` is
 * their account. Idempotent-ish: if a proposal is already pending, the FIRST one's provenance is kept (a repeat
 * is a no-op) — mirrors requestDirectReveal. Returns the updated call-off state, or null if the conversation is
 * unknown. (The route authorizes that the caller is a participant before calling this.)
 */
export async function requestCallOff(
  conversationId: string,
  by: DirectRole,
  byAccount: string
): Promise<DirectCallOff | null> {
  const id = conversationId.trim();
  const acct = norm(byAccount);
  if (!id || !acct) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    const callOff: DirectCallOff = { ...(cur.callOff ?? {}) };
    if (callOff.proposal) return { next: list, ret: callOff }; // already pending — no-op (keep first provenance)
    callOff.proposal = { by, byAccount: acct, at: Date.now() };
    const next = list.slice();
    next[idx] = { ...cur, callOff };
    return { next, ret: callOff };
  });
}

/** WITHDRAW a pending call-off proposal — drop it, nothing resets. No-op if nothing pending. The route
 *  authorizes that the withdrawer is the ORIGINAL proposer (only the proposer can take back their own proposal).
 *  Returns the updated call-off state, or null if unknown. */
export async function withdrawCallOff(conversationId: string): Promise<DirectCallOff | null> {
  const id = conversationId.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (!cur.callOff?.proposal) return { next: list, ret: cur.callOff ?? {} };
    const { proposal: _dropped, ...rest } = cur.callOff;
    const next = list.slice();
    next[idx] = { ...cur, callOff: rest };
    return { next, ret: rest };
  });
}

/**
 * AGREE to a pending call-off — the OTHER party consents, so the DEAL RESETS. The route authorizes that
 * the agreer is the party who did NOT propose (you can't "agree" to your own proposal — that'd be unilateral,
 * which the model forbids). On agree:
 *   - the pending `reveal.request` is dropped AND `grantedFields` is cleared (C's consent is wiped — "no junk");
 *   - `epoch` increments (anything after belongs to the new deal);
 *   - the proposal is consumed; `closedAt` stamped;
 * - `priorBlock` is PRESERVED (a call-off must never launder a block — the anti-cheat rule).
 * The buyer's GLOBAL dial (maskOverride on BuyerDirect) is reset by the ROUTE (it owns that dependency). Returns
 * the updated call-off state, or null if the conversation is unknown or there was no pending proposal.
 */
export async function agreeCallOff(conversationId: string): Promise<DirectCallOff | null> {
  const id = conversationId.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (!cur.callOff?.proposal) return { next: list, ret: cur.callOff ?? {} }; // nothing to agree to
    const now = Date.now();
    const nextEpoch = (cur.callOff.epoch ?? 0) + 1;
    const callOff: DirectCallOff = { epoch: nextEpoch, closedAt: now }; // proposal consumed
    const next = list.slice();
    // Wipe C's consent (grantedFields + any pending request); PRESERVE priorBlock (anti-launder).
    next[idx] = { ...cur, callOff, reveal: undefined };
    return { next, ret: callOff };
  });
}

// ── HARD BLOCK (E-slice) — DESK-ONLY ──────────────────────────────────────────────────────────────────
// The desk blocks a buyer (anti-scammer). The buyer's messages still land (desk receives), but the buyer gets a
// vrx autoreply; the desk can unblock. Blocking sets a PERMANENT priorBlock (identity force-shown to this desk,
// anti-cheat) that survives unblock + call-off. Only the desk can block (the buyer's recourse is call-off D /
// escalate F). The route authorizes that the caller is the desk developer before calling blockBuyer/unblockBuyer.

/** The block state of a conversation (null if unknown; a `{}`-ish shape otherwise). */
export async function getBlock(
  conversationId: string
): Promise<{ blocked: boolean; priorBlock: boolean } | null> {
  const conv = await conversationById(conversationId);
  if (!conv) return null;
  return { blocked: !!conv.block?.blocked, priorBlock: !!conv.priorBlock };
}

/** True iff the buyer is currently hard-blocked on this conversation. PURE read — the message-post path gates on it. */
export async function isBuyerBlocked(conversationId: string): Promise<boolean> {
  const conv = await conversationById(conversationId);
  return !!conv?.block?.blocked;
}

/** True iff this desk has EVER blocked this buyer (the permanent anti-cheat mark) — the mask consumer force-shows
 *  the buyer's identity to this desk when true. Survives unblock + call-off. PURE read. */
export async function priorBlockFor(conversationId: string): Promise<boolean> {
  const conv = await conversationById(conversationId);
  return !!conv?.priorBlock;
}

/**
 * The DESK hard-blocks the buyer. Sets `block.blocked=true` and, the FIRST time, stamps the PERMANENT
 * `priorBlock` (anti-cheat identity force-show for this desk; never overwritten on a re-block). Idempotent: a
 * re-block of an already-blocked buyer keeps the original `priorBlock`. Returns the updated block state, or null
 * if the conversation is unknown. (The route authorizes caller == the desk developer.)
 */
export async function blockBuyer(conversationId: string): Promise<{ blocked: boolean; priorBlock: boolean } | null> {
  const id = conversationId.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    const now = Date.now();
    const next = list.slice();
    next[idx] = {
      ...cur,
      block: { blocked: true, at: now },
      // Stamp priorBlock only if not already set — it's permanent, set once by the first block (by the developer).
      priorBlock: cur.priorBlock ?? { at: now, by: "developer" },
    };
    return { next, ret: { blocked: true, priorBlock: true } };
  });
}

/**
 * The DESK unblocks the buyer — restores normal messaging (`block.blocked=false`). Deliberately PRESERVES
 * `priorBlock` (: unblock restores messaging, NOT anonymity — the identity stays force-shown to this desk).
 * Idempotent. Returns the updated block state, or null if unknown.
 */
export async function unblockBuyer(conversationId: string): Promise<{ blocked: boolean; priorBlock: boolean } | null> {
  const id = conversationId.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    const next = list.slice();
    // Clear the active block; KEEP priorBlock untouched (permanent).
    next[idx] = { ...cur, block: { blocked: false, at: Date.now() } };
    return { next, ret: { blocked: false, priorBlock: !!cur.priorBlock } };
  });
}

// ── ESCALATE TO VRX (F-slice) — the one move that keeps the deal LIVE ──────────────────────────────────
// Either party (symmetric — the buyer's recourse against a pushy desk, since E's block is desk-only) flags the
// conversation for VRX review. VRX responds IN the thread. The deal stays live. VRX sees the negotiation record,
// NOT the buyer's sealed PII (escalation changes no projection). The route authorizes the flagger as a participant.

/** The escalation state (null if conversation unknown; a shape with `status:null` when never escalated). */
export async function getEscalation(
  conversationId: string
): Promise<{ status: "open" | "resolved" | null; by?: DirectRole; at?: number; reason?: string } | null> {
  const conv = await conversationById(conversationId);
  if (!conv) return null;
  const e = conv.escalation;
  if (!e) return { status: null };
  return { status: e.status, by: e.by, at: e.at, reason: e.reason };
}

/**
 * Flag the conversation for VRX review. Either party may escalate (symmetric). Idempotent-ish: if an
 * escalation is already OPEN, the first flagger's provenance is kept (a repeat is a no-op) — so a double-tap
 * doesn't reset it. A previously RESOLVED escalation CAN be re-opened (a new flag supersedes the resolved one).
 * `reason` is trimmed + capped. Returns the updated escalation state, or null if the conversation is unknown.
 */
export async function escalateToVrx(
  conversationId: string,
  by: DirectRole,
  byAccount: string,
  reason?: string
): Promise<{ status: "open" | "resolved"; by: DirectRole } | null> {
  const id = conversationId.trim();
  const acct = norm(byAccount);
  if (!id || !acct) return null;
  const cleanReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (cur.escalation?.status === "open") {
      return { next: list, ret: { status: "open", by: cur.escalation.by } }; // already open — no-op
    }
    const escalation = {
      status: "open" as const,
      by,
      byAccount: acct,
      at: Date.now(),
      ...(cleanReason ? { reason: cleanReason } : {}),
    };
    const next = list.slice();
    next[idx] = { ...cur, escalation };
    return { next, ret: { status: "open" as const, by } };
  });
}

/**
 * VRX RESOLVES an open escalation — marks it resolved + stamps the time. The authorizing caller is VRX-root
 * (the route gates on the operator/root capability, not a conversation participant). No-op if nothing is open.
 * Returns the updated state, or null if the conversation is unknown.
 */
export async function resolveEscalation(
  conversationId: string
): Promise<{ status: "open" | "resolved" } | null> {
  const id = conversationId.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (cur.escalation?.status !== "open") {
      return { next: list, ret: { status: (cur.escalation?.status ?? "resolved") as "open" | "resolved" } };
    }
    const next = list.slice();
    next[idx] = { ...cur, escalation: { ...cur.escalation, status: "resolved", resolvedAt: Date.now() } };
    return { next, ret: { status: "resolved" as const } };
  });
}

/** Every conversation with an OPEN escalation — the VRX-root review queue. Returns the conversation id + its
 *  parties + who flagged it + when + the reason, so root can triage. PURE read over the store. */
export async function openEscalations(): Promise<
  Array<{ id: string; buyer: string; building: string; by: DirectRole; at: number; reason?: string }>
> {
  const all = await readAll();
  return all
    .filter((c) => c.escalation?.status === "open")
    .map((c) => ({
      id: c.id,
      buyer: c.buyer,
      building: c.building,
      by: c.escalation!.by,
      at: c.escalation!.at,
      reason: c.escalation!.reason,
    }))
    .sort((a, b) => b.at - a.at);
}

// ── UNREAD for direct conversations — the twin of lib/conversations-unread but for the PRE-booking
//    desk funnel. The booking-side unread rule scopes through getOffer/partyOnOffer (an offer), which a direct
//    thread doesn't have — so direct enquiries were invisible to the badge. This computes the SAME "unread for
//    a viewer" rule (more messages than they've marked seen AND the newest message is NOT their own side) over
//    the direct threads the viewer participates in, reusing the shared server read-markers (survives device/
//  login, keyed by the direct conversationId just like a booking requestId). No bodies leave here. ──

/** The direct conversation ids that are currently unread for the viewer, newest-activity first. */
export async function directUnreadIds(viewer: string): Promise<string[]> {
  const v = norm(viewer);
  if (!v) return [];
  const [convs, seen] = await Promise.all([
    directConversationsFor(v),
    seenFor(v).catch(() => ({} as Record<string, number>)),
  ]);
  const unread: { id: string; at: number }[] = [];
  for (const c of convs) {
    const thread = await getThread(c.id).catch(() => []);
    if (thread.length === 0) continue; // silent thread can't be unread
    const last = thread[thread.length - 1];
    // The viewer's side in THIS conversation: desk developer or buyer.
    const side: DirectRole = c.developer.toLowerCase() === v ? "developer" : "buyer";
    const seenCount = seen[c.id] ?? 0;
    // Unread = more messages than the viewer saw AND the newest is from the OTHER side (not their own).
    if (thread.length > seenCount && last.from !== side) {
      unread.push({ id: c.id, at: last.at });
    }
  }
  unread.sort((a, b) => b.at - a.at);
  return unread.map((u) => u.id);
}

/** The number of the viewer's direct conversations with unseen counterpart messages — the badge value. */
export async function directUnreadCountFor(viewer: string): Promise<number> {
  return (await directUnreadIds(viewer)).length;
}
