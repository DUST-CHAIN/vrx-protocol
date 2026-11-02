// CEO at a developer (or any role) watches one reverse-chronological, plain-language timeline and understands
// docs_by_claude/17_agent_activity_tracking.md — append-only events in, a projection/filter out.)
// filter creates what the user sees — so we have all great logs and can surface anything." Two halves:
// (1) THE SPINE (this file's store) — an append-only `.data/activity.json` of ActivityEntry. New off-chain
// acts that have NO existing timeline store call logActivity(...) at their write site. (Agreement
// lifecycle moves are the first consumer: proposeAgreement left only lastBy/updatedAt, never a trail.)
// (2) THE ENGINE — getActivityFeed(viewer, role). It does NOT only read the spine: it PROJECTS the event
// sources we already hold (the on-chain event mirror = bookings; the sealed buyer-events trail =
// reveals/revisions; the agreements store) INTO the same ActivityEntry shape and MERGES them. So the
// feed is full from day one (back-fill) AND grows forward (the spine). One humanised timeline over all.
// WHY A PROJECTION, NOT "emit everywhere": much already IS logged — the chain emits claim_opened/replied for
// every booking (lib/events.ts), buyer-events seals every reveal/revision. Re-emitting those into a second
// store would double-book and drift. So we project what's already recorded and only EMIT the gap (acts with
// carries `parties` — the accounts entitled to see it — so getActivityFeed(viewer) returns only entries the
// viewer is a party to, "in respect to the counterparty of the deal". /node surfaces it this session; the
// SAME engine rolls to agency/agent/root later by passing a different viewer — no re-write.
// PRIVACY: the feed carries only what the viewer is already entitled to see. Booking lines come from the
// public on-chain mirror (opaque ids/status — no PII). Buyer-event lines carry the plaintext detail the
// server already authored for the two deal parties. We never widen a party's existing view — we re-present it.

import { promises as fs } from "fs";
import path from "path";

// ── The canonical entry (one row of the log) ──────────────────────────────────────────────────────────
/**
 * One thing that happened. Verb + actor + subject + context is enough to humanise it per-viewer. `parties`
 * is the visibility list (the "in respect to the counterparty" scope). `source` tags where it came from so
 * the engine can de-dup and the UI can group/filter (the "filter").
 */
export type ActivityVerb =
  // bookings (projected from the on-chain mirror)
  | "booking.requested"
  | "booking.accepted"
  | "booking.declined"
  | "booking.alternative"
  | "booking.confirmed" // deposit paid → unit closed on-chain (the SALE)
  // S&P contract stage (projected from the buyer-events trail)
  | "contract.final" // S&P marked ready-to-sign (full identity disclosed)
  | "contract.payment_arrived" // on-contract payment received — the online-signing validity gate
  | "contract.signed" // the S&P was executed
  // buyer protection (projected from the sealed buyer-events trail)
  | "buyer.introduced"
  | "buyer.revised"
  | "buyer.reveal_requested"
  | "buyer.reveal_declined"
  | "buyer.revealed"
  | "buyer.acknowledged"
  // agreements (emitted to the spine + projected from the store's current state)
  | "agreement.proposed"
  | "agreement.published"
  | "agreement.joined"
  | "agreement.agreed"
  | "agreement.declined"
  | "agreement.revoke_requested"
  | "agreement.revoked"
  // developer standing (§3c, — emitted to the spine at the VRX-root action/scheduler sites). A
  // SENSITIVE, operator-driven class: the feed row carries only the stage/reason CATEGORY, never the raw
  // operator note. Visibility is the developer + VRX-root ONLY — other parties learn of a pause
  // via the scheduler's deal-chat notice, not this feed.
  | "standing.flagged" // a misrepresentation/accuracy flag was raised against the developer (assert)
  | "standing.cleared" // a flag was withdrawn (clear) — audit-kept, un-degrades standing
  | "standing.advanced" // the stage-advancement scheduler moved the developer to a new §3c stage
  // developer edit-policy trust-dial ( — emitted at the per-class relax/tighten in lib/dev-edit-policy).
  // Same SENSITIVE, operator-driven class as standing.*: visibility is the developer + VRX-root ONLY; the
  // row carries only the change CLASS + its new disposition, never prices/terms/unit specifics.
  | "policy.relaxed" // VRX loosened a change class to self-serve (notify) for the developer
  | "policy.tightened" // VRX raised a change class to version-gated (approve) for the developer
  // inventory change notices ( — emitted at the catalog-mutation routes when a post-sign-off change is
  // ALLOWED). TWO audiences over one event ( §2): subscribed agencies/agents SEE it in their feed +
  // dismiss via read-markers (ephemeral); VRX-root gets the persistent grouped oversight screen. The row
  // carries only the building + a count/direction phrase — NEVER a unit's price/terms specifics.
  | "inventory.repriced" // a unit or batch of units had its price changed
  | "inventory.off_market" // a unit was taken off market (block/kill)
  | "inventory.availability" // a unit's shown/withheld availability changed (incl. released back on market)
  // building-HALT notices (governed-change A) — a developer PAUSED (or RESUMED) new bookings on a whole
  // building. Distinct from inventory.availability (a single unit's shown/withheld flag) so the feed line reads
  // "paused new bookings on X" rather than the flat "changed whether a unit is shown". The NOTE never rides the
  // feed context ( — it surfaces verbatim on the A2/B notice surfaces); only the building + tier do.
  | "inventory.halted" // a developer paused new bookings on a building (a halt was asserted)
  | "inventory.resumed" // a developer lifted a halt — new bookings resume on the building
  | "inventory.unit_added" // a unit was added to the slate
  | "inventory.unit_removed" // a unit was removed from the slate
  | "inventory.unit_changed" // a unit's size/type/layout changed
  | "inventory.listing_updated" // listing copy / images / building terms were updated
  // first-class SEALED event in its own right (§3 TIER-1): an agency/buyer trusted "contract with company Y /
  // signed off by director X"; if that changes they MUST be told, sealed. Audience = agencies AND live buyers
  // (the same affected set as an inventory change). The row carries only the building + which governance field
  // moved — NEVER the old/new values themselves (the before/after lives in the sealed evidence, not the feed).
  | "governance.director_changed" // the seller entity's director / signatory changed
  | "governance.seller_changed"; // the seller entity itself was swapped, or its company/bank-destination changed

export type ActivitySource = "mirror" | "buyer-events" | "agreements" | "spine";

export type ActivityEntry = {
  /** Stable unique id (store key for spine rows; a derived "<source>:<natural-key>" for projected rows). */
  id: string;
  /** What happened. Drives the plain-language template. */
  verb: ActivityVerb;
  /** The account that performed the act (may be "" when the chain doesn't name an actor, e.g. a lapse). */
  actor: string;
  /** What it happened TO — an opaque booking requestId, an agreement id, a unit, etc. */
  subject: { kind: "booking" | "agreement" | "unit" | "buyer" | "developer"; id: string };
  /** Display-safe extras for the humaniser (unit number, building name, counterparty role, from/to, …).
   * NEVER put a secret salt or PII here that the viewer isn't already entitled to — this reaches the client. */
  context?: Record<string, string | number | undefined>;
  /** The accounts entitled to see this entry (the visibility / counterparty scope). Case-insensitive match. */
  parties: string[];
  /** Where the engine sourced it (for de-dup + the UI source filter). */
  source: ActivitySource;
  /** ms epoch the act happened. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "activity.json");

// ── Spine store (append-only; same file-backed.data discipline as offers/agreements/buyer-events) ──────
type SpineRow = Omit<ActivityEntry, "source"> & { source: "spine" };

async function readSpine(): Promise<SpineRow[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return Array.isArray(parsed) ? (parsed as SpineRow[]) : [];
  } catch {
    return [];
  }
}

async function writeSpine(rows: SpineRow[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(rows, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as events.ts/offers.ts.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (rows: SpineRow[]) => { next: SpineRow[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readSpine();
    const { next, ret } = fn(cur);
    await writeSpine(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * EMIT an act into the spine — called at a write site that has no timeline store of its own (today: the
 * agreement lifecycle). Booking + buyer acts are NOT emitted here (they live in the mirror / buyer-events and
 * get projected). Never throws — a logging failure must not break the action that called it.
 */
export async function logActivity(
  verb: ActivityVerb,
  actor: string,
  subject: ActivityEntry["subject"],
  parties: string[],
  context?: ActivityEntry["context"]
): Promise<void> {
  try {
    const at = Date.now();
    const row: SpineRow = {
      id: `act-${at}-${Math.random().toString(36).slice(2, 8)}`,
      verb,
      actor,
      subject,
      parties: parties.filter(Boolean),
      source: "spine",
      at,
      ...(context ? { context } : {}),
    };
    await mutate((rows) => ({ next: [...rows, row], ret: null }));
  } catch {
    /* best-effort: the log is a convenience, never a blocker on the real write */
  }
}

/** Every spine row (for the engine to merge). Newest-first. */
export async function spineEntries(): Promise<ActivityEntry[]> {
  return (await readSpine()).slice().sort((a, b) => b.at - a.at);
}
