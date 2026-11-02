// HALT NOTICES — the A2 party-facing PUSH over the affected-set resolver (Part A2 of
// ── WHAT THIS IS ────────────────────────────────────────────────────────────────────────────────────────
// When a developer HALTS a building, the software (not a human flag) decides WHO is affected and HOW LOUD,
// and pushes each affected party a notice. This module is that fan-out + its per-party SEEN state:
// • resolveHaltNoticesFor(viewer) — for one viewer (an agent or agency), every live halt that touches
// them, split into the UNMISSABLE set (a) (they have an EXISTING DEAL on the halted building) and the
// lighter set (b) card (a forward-only partner — an agreement covers it but no live deal). Carries the
// developer's NOTE + the Part-D "ask more" deep-link target (developer, agency).
// • the SEEN-MARKER store — the twin of lib/read-markers, keyed (viewer, haltId). A set-(a) notice is
// "unmissable": persistent, and DISMISS is gated on the marker (you may hide it only AFTER it's seen).
// The marker keys on halt.id (`halt-{ts}-{hex}`), which is unique per assertion. So if a developer lifts a
// halt and later asserts a NEW one on the same building, that new halt has a NEW id → it is UNSEEN for every
// party again → the unmissable notice re-raises for everyone (a fresh halt is fresh news). Keying on the
// building alone would let one dismiss permanently silence all future halts on that building — a silent-
// failure trap. The halt-event key is the safe default.
// ── THE AFFECTED SET IS COMPUTED, never stored (shared resolver) ────────────────────────────────────────
// resolveHaltAffected(developer, building) (lib/halt-affected) does the one computation A2 + A3 share: set
// (a) existing-deal parties, set (b) forward-only agencies, disjoint. This module projects that PER VIEWER:
// "is THIS viewer in set (a) or (b) for this halt?" — the viewer being an agent OR its agency (an agent
// inherits its agency's forward-only membership; a deal the agent authored puts the agent AND the agency in
// set (a)). VRX is always in the set-to-notify but VRX's own queue is /api/root/halts (the pending-ack
// queue), not this party surface — so this module is agent/agency-facing only.
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. The notice tells the VIEWER that a building THEY are connected to was halted + the developer's
// own-words note + how many of their own deals it touches — it NEVER discloses the OTHER parties on the
// building (no cross-party leak), and it never resolves a buyer identity. The marker store holds only neutral
// account ids, opaque halt ids, and integers (0/1 seen flag) — no PII, no bodies, nothing on-chain. Same
// file-backed.data + serialized-mutate discipline as read-markers.ts / channels.ts.
// ── Machine note ────────────────────────────────────────────────────────────────────────────────────────
// Any SEED `.data/halt-notice-marks.json` must be written with the Write tool (clean UTF-8/LF) — NEVER a
// PowerShell Set-Content/here-string (BOM + CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { liveHalts, publicHalt, type BuildingHalt } from "./building-halt";
import { resolveHaltAffected } from "./halt-affected";
import { agencyOf } from "./agents";
import { getBuilding } from "./catalog";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "halt-notice-marks.json");

const lc = (s: string) => s.trim().toLowerCase();

// ── SEEN-MARKER STORE (twin of lib/read-markers; keyed (viewer, haltId)) ────────────────────────────────

/** viewer account → (haltId → seen flag). We store a boolean-as-1: a halt notice is a single event, not a
 * growing message count, so "seen" is a latch, not a diff (contrast read-markers' monotonic count). */
type Store = Record<string, Record<string, boolean>>;

async function readAll(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

async function writeAll(store: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(store, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as read-markers.ts.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (store: Store) => { next: Store; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/** The set of halt ids this viewer has marked SEEN. Empty if they've never seen one. */
export async function seenHaltsFor(viewer: string): Promise<Set<string>> {
  const v = lc(viewer);
  if (!v) return new Set();
  const mine = (await readAll())[v] ?? {};
  return new Set(Object.keys(mine).filter((id) => mine[id]));
}

/** Mark a halt notice SEEN for a viewer (a latch — never un-sees). The UI calls this the moment the notice
 * is actually shown, which ARMS the dismiss (you may hide only after it's been seen). Returns true. */
export async function markHaltSeen(viewer: string, haltId: string): Promise<boolean> {
  const v = lc(viewer);
  const id = haltId.trim();
  if (!v || !id) return false;
  return mutate((store) => {
    const mine = { ...(store[v] ?? {}) };
    mine[id] = true;
    return { next: { ...store, [v]: mine }, ret: true };
  });
}

// ── THE NOTICE PROJECTION (per viewer, over the shared resolver) ────────────────────────────────────────

/** The two notice loudnesses (design §A2). `existing_deal` = set (a), the UNMISSABLE notice; `forward_only`
 * = set (b), the lighter dismissible card. */
export type HaltNoticeKind = "existing_deal" | "forward_only";

/** One halt notice for ONE viewer — what the UI renders. Discloses only the viewer's OWN relationship to the
 * halted building (count of their deals), never the other parties. */
export type HaltNotice = {
  /** The halt event id — the marker key + React key. A new assertion has a new id (re-raises). */
  haltId: string;
  /** The halted building (catalog id). */
  building: string;
  /** The building's human display name (catalog), so the UI needs no extra fetch. Falls back to the id. */
  buildingLabel: string;
  /** The developer who halted it — the Part-D "ask more" counterparty (developer side). */
  developer: string;
  /** The urgency tier (drives extra loudness on the UI). */
  tier: BuildingHalt["tier"];
  /** The developer's own-words note — the "why", quoted verbatim. */
  note: string;
  /** ms epoch the halt was asserted (the notice's "when"). */
  assertedAt: number;
  /** Loudness: existing_deal (unmissable) vs forward_only (dismissible card). */
  kind: HaltNoticeKind;
  /** For set (a): how many of THIS viewer's own live deals the halt touches (their own count only — never the
   * other parties'). 0 for a forward-only notice. */
  myDealCount: number;
  /** Has this viewer already SEEN this notice? Set-(a) dismiss is gated on this being true. */
  seen: boolean;
  /** The Part-D "ask more" deep-link target: resolveRelationshipChannel materializes (developer, agency). The
   * agency is the viewer's own agency (an agent asks through its agency's channel). */
  askMore: { developer: string; agency: string } | null;
};

/**
 * Resolve every live-halt notice for ONE viewer (an agent or an agency account). For each live halt we run
 * the shared affected-set resolver and ask: is this viewer in set (a) (an existing deal — unmissable) or set
 * (b) (a forward-only partner — the lighter card)? Set (a) wins if both somehow match. The viewer's agency
 * (agencyOf) is folded in so an AGENT sees a notice for a deal/agreement held under its agency.
 *
 * Returns newest-halt-first. A viewer not connected to any live halt gets []. SERVER-ONLY; pure read apart
 * from the seen-marker lookup; discloses only the viewer's own connection.
 */
export async function resolveHaltNoticesFor(viewer: string): Promise<HaltNotice[]> {
  const v = lc(viewer);
  if (!v) return [];

  // The viewer's "side": their own account + (if an agent) their agency. A deal the agent authored lands the
  // agent in set (a); an agreement is held by the agency, so the agency id is what matches set (b).
  const myAgency = await agencyOf(v); // null if the viewer is itself an agency (or unregistered)
  const myAgencyLc = myAgency ? lc(myAgency) : null;
  // The identities that count as "me" for membership tests — the viewer, and their agency if they're an agent.
  const mine = new Set<string>([v, ...(myAgencyLc ? [myAgencyLc] : [])]);

  const [halts, seen] = await Promise.all([liveHalts(), seenHaltsFor(v)]);
  const out: HaltNotice[] = [];

  for (const h of halts) {
    const pub = publicHalt(h); // strip the salt before anything derived from it leaves the server
    const set = await resolveHaltAffected(h.developer, h.building);

    // Set (a): does the viewer (or their agency) sit on an EXISTING deal for this building? Count only the
    // viewer's OWN deals (agent === v, OR the deal's agency is the viewer/their agency) — never total deals.
    const myDeals = set.deals.filter(
      (d) => mine.has(d.agent) || (d.agency !== null && mine.has(d.agency)),
    );
    const inA = myDeals.length > 0;

    // Set (b): forward-only — an agency with an agreement covering it but no live deal. The resolver's set (b)
    // is agency-grained; an agent inherits via their agency. (A viewer in set (a) is NOT in set (b): disjoint.)
    const inB =
      !inA && set.forwardOnlyAgencies.some((ag) => mine.has(ag));

    if (!inA && !inB) continue; // this viewer isn't connected to this halt at all

    // The "ask more" channel is (developer, the viewer's agency). An agent asks through its agency's channel;
    // an agency uses its own id. If we can't resolve an agency side, there's no relationship channel to open.
    const agencySide = myAgencyLc ?? v;

    const building = await getBuilding(pub.building);

    out.push({
      haltId: h.id,
      building: pub.building,
      buildingLabel: building?.name ?? pub.building,
      developer: pub.developer,
      tier: pub.tier,
      note: pub.note,
      assertedAt: pub.assertedAt,
      kind: inA ? "existing_deal" : "forward_only",
      myDealCount: inA ? myDeals.length : 0,
      seen: seen.has(h.id),
      askMore: agencySide ? { developer: pub.developer, agency: agencySide } : null,
    });
  }

  // Newest halt first; within that, set (a) (louder) ahead of set (b) so the unmissable ones sort to the top.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "existing_deal" ? -1 : 1;
    return b.assertedAt - a.assertedAt;
  });
  return out;
}
