// RELATIONSHIP CHANNELS — SERVER-ONLY. Part D of the design docs: the generic
// developer↔agency conversation that is NOT bound to any single deal. The THIRD context kind of the
// generalized channel store (lib/channels): a thread tagged { kind:"relationship", id:<channelId> } beside
// { kind:"booking", id:<requestId> } and { kind:"direct", id:<conversationId> }.
//
// WHY IT EXISTS: a developer and an agency need somewhere to TALK about things that span their
// whole relationship — a building halt, a new building, revised terms — not about one unit/booking. The per-
// deal channel (booking/direct) can't carry that; the halt notice (Part A2) needs an "ask more" target. This
// is that target. It is the "scan for the reusable pattern" in action: channels.ts is already the
// generic hash-chained, append-only, system-notice-capable message store — a relationship thread is just a
// new context kind + a new id/scope, exactly as `direct` was (lib/conversations-direct.ts is the twin this
// mirrors file-for-file).
//
// WHO TALKS: the two parties are the DEVELOPER (Node) and the AGENCY (Org). An AGENT of that agency may author
// on the agency's behalf (same sell side — mirrors lib/participant.roleOnOffer folding agent+agency into one
// "agent" side). So a message's `from` is "developer" or "agency"; an agent posts AS "agency" (resolved
// server-side via agencyOf, never client-claimed). `vrx` system notices also land here (postSystemNotice).
//
// CHANNEL IDENTITY: one channel per (developer, agency) pair — all their cross-deal talk in one ongoing thread,
// not a new thread per topic. The id is a stable, opaque SHA-256 digest of (developer, agency) under its own
// domain salt, so it can't be guessed/enumerated and reveals neither party on the wire (same posture as the
// booking requestId / direct conversationId it sits beside). Deriving it is pure; the index row materialized on
// first reference lets the id resolve back to its parties (the channel store is create-on-write).
//
// FAIL-CLOSED SCOPING: a relationship channel exists ONLY where the pair has an AGREEMENT between them (any
// lifecycle status — a declined/revoked agreement still means "these two have a relationship / have talked").
// `resolveRelationshipChannel` refuses to materialize a thread for a pair with no agreement at all — you can't
// open a relationship channel with a stranger. `relationshipRole(channelId, viewer)` returns "developer" |
// "agency" | null (the developer, the agency, or an agent of that agency; everyone else fails closed).
//
// PRIVACY: bodies are off-chain plaintext; the chain is untouched; parties are neutral account ids. The id
// is opaque so the pair can't be read off the wire.

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { getThread } from "./channels";
import { agencyOf } from "./agents";
import { listAllAgreements } from "./agreements";
import { seenFor } from "./read-markers";

export type RelationshipRole = "developer" | "agency";

/** The index row that lets a derived channelId resolve back to its (developer, agency) parties. */
type RelationshipChannel = {
  /** The derived opaque id (also the channel-store key for this thread). */
  id: string;
  /** The developer (Node) account, lowercased. */
  developer: string;
  /** The agency (Org) account, lowercased. */
  agency: string;
  /** ms epoch first materialized. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "relationship-channels.json");
const DOMAIN = "vrx-relationship-channel"; // salts the id so it can't be matched against hashes used elsewhere

// ── store IO (serialized, same lost-write guard as the other .data stores) ──────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: RelationshipChannel[]) => { next: RelationshipChannel[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<RelationshipChannel[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RelationshipChannel[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: RelationshipChannel[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const norm = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** The stable, opaque channel id for a (developer, agency) pair. Pure — same inputs → same id. */
export function relationshipChannelId(developer: string, agency: string): string {
  const d = norm(developer);
  const a = norm(agency);
  return createHash("sha256").update(`${DOMAIN}|${d}|${a}`).digest("hex").slice(0, 32);
}

/** True iff the pair has ANY agreement between them (any status) — the precondition for a relationship channel.
 *  A declined/revoked agreement still counts: they HAVE a relationship / have talked. PURE read over the store. */
export async function pairHasAgreement(developer: string, agency: string): Promise<boolean> {
  const d = norm(developer);
  const a = norm(agency);
  if (!d || !a) return false;
  return (await listAllAgreements()).some(
    (g) => g.seal.developer.toLowerCase() === d && g.seal.agency.toLowerCase() === a
  );
}

/** The index row for a channel id (null if never materialized). */
async function channelById(id: string): Promise<RelationshipChannel | null> {
  const want = id.trim();
  if (!want) return null;
  return (await readAll()).find((c) => c.id === want) ?? null;
}

/**
 * Resolve (developer, agency) → the channel, materializing the index row on first reference so the id can later
 * resolve back to its parties. Returns null if the pair has NO agreement between them (fail closed — you can't
 * open a relationship channel with a stranger). `ensure` = whether to persist the index row (true when a party
 * is actually opening the channel; false for a pure derive/read).
 */
export async function resolveRelationshipChannel(
  developer: string,
  agency: string,
  ensure: boolean
): Promise<{ id: string; developer: string; agency: string } | null> {
  const d = norm(developer);
  const a = norm(agency);
  if (!d || !a) return null;
  if (!(await pairHasAgreement(d, a))) return null; // no relationship → no channel

  const id = relationshipChannelId(d, a);
  if (ensure) {
    await mutate((list) => {
      if (list.some((c) => c.id === id)) return { next: list, ret: null };
      return { next: [...list, { id, developer: d, agency: a, at: Date.now() }], ret: null };
    });
  }
  return { id, developer: d, agency: a };
}

/**
 * The viewer's role in a relationship channel, or null if they aren't a participant (FAIL CLOSED). A viewer is
 * the DEVELOPER (account == the channel's developer), the AGENCY (account == the channel's agency), or an AGENT
 * of that agency (agencyOf(viewer) == the channel's agency — the agent authors on the agency's behalf, same sell
 * side, mirroring lib/participant.roleOnOffer). Mirrors conversations-direct.directRole for this context.
 */
export async function relationshipRole(channelId: string, viewer: string): Promise<RelationshipRole | null> {
  const v = norm(viewer);
  if (!v) return null;
  const chan = await channelById(channelId);
  if (!chan) return null;
  if (chan.developer === v) return "developer";
  if (chan.agency === v) return "agency";
  const agency = (await agencyOf(v))?.toLowerCase();
  if (agency && agency === chan.agency) return "agency"; // an agent of the channel's agency (same sell side)
  return null;
}

/** The parties of a channel (for display/counterpart resolve), or null if unknown. */
export async function relationshipParties(
  channelId: string
): Promise<{ developer: string; agency: string } | null> {
  const chan = await channelById(channelId);
  if (!chan) return null;
  return { developer: chan.developer, agency: chan.agency };
}

/**
 * Every relationship channel a viewer participates in — for both the developer's and the agency's channel list.
 * Includes channels where the viewer is an AGENT of a channel's agency. Only MATERIALIZED channels (someone has
 * opened them) appear; a pair with an agreement but no opened channel is resolvable on demand, not listed here.
 */
export async function relationshipChannelsFor(
  viewer: string
): Promise<Array<{ id: string; developer: string; agency: string }>> {
  const v = norm(viewer);
  if (!v) return [];
  const myAgency = (await agencyOf(v))?.toLowerCase() ?? null;
  const all = await readAll();
  return all
    .filter((c) => c.developer === v || c.agency === v || (myAgency !== null && c.agency === myAgency))
    .map((c) => ({ id: c.id, developer: c.developer, agency: c.agency }));
}

// ── UNREAD for relationship channels — the twin of conversations-direct.directUnreadIds. Same "unread
//    for a viewer" rule (more messages than they've marked seen AND the newest message is NOT their own side)
//    over the relationship threads the viewer participates in, reusing the shared server read-markers (keyed by
//    the relationship channelId, just like a booking requestId / direct conversationId). No bodies leave here. ──

/** The relationship channel ids currently unread for the viewer, newest-activity first. */
export async function relationshipUnreadIds(viewer: string): Promise<string[]> {
  const v = norm(viewer);
  if (!v) return [];
  const [chans, seen] = await Promise.all([
    relationshipChannelsFor(v),
    seenFor(v).catch(() => ({} as Record<string, number>)),
  ]);
  const unread: { id: string; at: number }[] = [];
  for (const c of chans) {
    const thread = await getThread(c.id).catch(() => []);
    if (thread.length === 0) continue; // silent thread can't be unread
    const last = thread[thread.length - 1];
    // The viewer's side in THIS channel: developer or agency (an agent counts as the agency side).
    const side: RelationshipRole = c.developer === v ? "developer" : "agency";
    const seenCount = seen[c.id] ?? 0;
    // Unread = more messages than the viewer saw AND the newest is from the OTHER side (not their own). A `vrx`
    // system notice is never the viewer's own side, so it correctly counts as unread for both parties.
    if (thread.length > seenCount && last.from !== side) {
      unread.push({ id: c.id, at: last.at });
    }
  }
  unread.sort((a, b) => b.at - a.at);
  return unread.map((u) => u.id);
}

/** The number of the viewer's relationship channels with unseen counterpart messages — the badge value. */
export async function relationshipUnreadCountFor(viewer: string): Promise<number> {
  return (await relationshipUnreadIds(viewer)).length;
}
