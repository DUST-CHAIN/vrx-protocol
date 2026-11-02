// VRX §3c STAGE-ADVANCEMENT SCHEDULER — the LAST seam (#4) of the enforcement arc ( §3c) — SERVER-ONLY.
// sender were all waiting for: it re-evaluates each developer's standing, and when a developer has ENTERED an
// adverse stage (grace → suspended → removed) it NOTIFIES all parties on that developer's deals in the chat
// (via lib/channels.postSystemNotice, the §3c seam #3 sender) — ONCE per (developer, stage), idempotently.
// A Next.js portal has no cron/worker, and the resolver (lib/dev-standing.resolveStandingForDeveloper) is
// already `asOf`-driven + stateless — it tells you a developer's stage at ANY instant from the live stores.
// So "advance standings" is not a process that ticks; it is a PURE function of (current stores, asOf) plus a
// small IDEMPOTENCY ledger of which stage notices have already been emitted. Call it from an API hit, an
// operator action, or the demo harness; re-calling it with the same (or a later, same-stage) asOf emits
// the cheap, replayable evaluator now; a literal timer only if a real deployment ever needs one — it slots in
// front of this same function.)
// §7 (and its spirit) forbids VRX firing a timed consequence against a developer who never SIGNED the
// current disclosure terms — "disclosure exists" ≠ "disclosed TO THIS developer who signed THIS version".
// not signed the CURRENT terms version, exactly as if §3c-suspended — so an unsigned developer has no live
// listings, accrues no NEW VRX-fee obligations, and therefore cannot reach a late/overdue state at all. That
// makes "late ⇒ signed-current-terms" an INVARIANT enforced upstream, so THIS scheduler does not need to
// re-litigate consent before firing — it may safely assume anyone who reached a late stage had signed. We
// still DOCUMENT the coupling loudly (if the gate invariant were ever weakened, re-add a check here), and the
// scheduler reports the assumption in its result so a caller/test can assert it.
// ── IDEMPOTENCY (the small new stored fact) ───────────────────────────────────────────────────────────────
// postSystemNotice has no dedup of its own; a naive re-run would double-post "about to be suspended". So we
// keep a per-(developer, stage) "already notified" fact in.data/standing-notices.json (same file-backed
// pattern as channels/receipts). A notice for (dev, stage) is emitted at most once, EVER — crossing into a NEW
// stage emits that stage's notice; staying in a stage (or re-evaluating) emits nothing. Clearing back to `good`
// does NOT erase the ledger (the history of what was announced is kept); if the developer later re-offends and
// re-enters the SAME stage, we deliberately do NOT re-announce the identical stage (the ledger is a permanent
// "has this developer ever been told X" record — a second identical dunning message would be noise, and the
// real-world re-escalation that matters is a MORE severe stage, which is a different ledger key). A future
// refinement could scope the ledger key by the trigger ANCHOR (firstMissedDueAt) so a genuinely NEW incident
// re-announces; it is a named later decision, not a silent assumption (documented, not built — no demo need).
// PRIVACY: server-only. The notice body is plain-words (lib/dev-standing copy) — a B2B standing fact,
// no customer payment amounts, no field-names, no contract-speak, nothing on-chain.

import { promises as fs } from "fs";
import path from "path";
import { settlementRollup } from "./earmark";
import {
  resolveStandingForDeveloper,
  standingCopy,
  type DeveloperStandingStage,
  type MisrepresentationTrigger,
} from "./dev-standing";
import { postSystemNotice } from "./channels";

// The adverse stages that warrant a chat notice. `good` never notifies (nothing to announce). Ordered by
// severity so a caller can reason about transitions.
const NOTIFIABLE_STAGES: DeveloperStandingStage[] = ["grace", "suspended", "removed"];

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "standing-notices.json");

/** One emitted-notice fact: we told THIS developer about THIS stage, once, at this time, across these threads.
 * The store key is `${developer}|${stage}` (see noticeKey) — its mere presence means "already announced". */
type EmittedNotice = {
  developer: string;
  stage: DeveloperStandingStage;
  /** ms epoch we emitted it. */
  at: number;
  /** The deal threads (requestIds) the notice was posted into, for the audit trail. */
  requestIds: string[];
};
type Store = Record<string, EmittedNotice>;

/** The ledger key for a (developer, stage) announcement. Developer trimmed/lower-cased for stable matching. */
function noticeKey(developer: string, stage: DeveloperStandingStage): string {
  return `${developer.trim().toLowerCase()}|${stage}`;
}

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

// Serialize writes (read-modify-write can't interleave) — same discipline as channels.ts/vrx-receipts.ts.
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

/** Has the (developer, stage) notice already been emitted? A read for callers/tests. */
export async function wasStageAnnounced(
  developer: string,
  stage: DeveloperStandingStage
): Promise<boolean> {
  const store = await readAll();
  return !!store[noticeKey(developer, stage)];
}

/** What one developer's evaluation did, for the aggregate report + tests. */
export type StandingAdvance = {
  developer: string;
  stage: DeveloperStandingStage;
  /** Every active trigger reason (from the resolver). */
  reasons: string[];
  /** True iff this call EMITTED a fresh notice for this developer's current stage (first time at this stage).
   * False means: `good` (nothing to announce) OR already-announced (idempotent no-op). */
  notified: boolean;
  /** The deal threads the notice was posted into (empty when notified=false). */
  requestIds: string[];
};

export type AdvanceReport = {
  /** ms epoch the evaluation ran at (the asOf used). */
  asOf: number;
  /** Per-developer outcome. */
  advances: StandingAdvance[];
  /** How many developers got a FRESH notice this run. */
  notifiedCount: number;
};

/**
 * Re-evaluate standings and emit any un-emitted §3c stage notice. PURE-DRIVEN + idempotent:
 * - resolve each developer's CURRENT standing (lib/dev-standing, `asOf`-injectable);
 * - if the stage is adverse (grace/suspended/removed) AND we have NOT already announced THIS (developer, stage),
 * post the stage copy (standingCopy) into EVERY deal thread the developer has (earmark byVrx → deals →
 * requestId), then record the (developer, stage) fact so a replay is a no-op.
 *
 * `developers` defaults to every developer that appears in the VRX settlement rollup (i.e. has at least one
 * fee line) — the universe that can possibly be late. Pass an explicit list to scope a run (e.g. a single
 * developer after an operator action). `misrepresentations` lets a caller inject operator-asserted
 * misrepresentation triggers per developer — until the persisted operator-assertion store lands, that
 * is how a VRX-root action feeds the fraud trigger into this evaluation (the resolver reads it; this scheduler
 * just forwards it). Omitted ⇒ no misrepresentation flagged.
 */
export async function advanceDeveloperStandings(opts?: {
  developers?: string[];
  misrepresentations?: Record<string, MisrepresentationTrigger>;
  asOf?: number;
}): Promise<AdvanceReport> {
  const asOf = opts?.asOf ?? Date.now();

  // The developer universe: explicit list, else every developer with a VRX fee line (the ones that can be late).
  let developers = opts?.developers?.map((d) => d.trim()).filter(Boolean);
  if (!developers || developers.length === 0) {
    const { byVrx } = await settlementRollup();
    developers = byVrx.map((v) => v.developer);
  }
  // Distinct (case-insensitive), preserving the first-seen casing for display.
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const d of developers) {
    const key = d.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    distinct.push(d.trim());
  }

  const advances: StandingAdvance[] = [];
  for (const developer of distinct) {
    const mis = opts?.misrepresentations?.[developer.toLowerCase()];
    const standing = await resolveStandingForDeveloper(developer, { asOf, misrepresentation: mis });
    const stage = standing.stage;

    // `good` never notifies. An adverse stage notifies only if not already announced for this (dev, stage).
    if (!NOTIFIABLE_STAGES.includes(stage) || (await wasStageAnnounced(developer, stage))) {
      advances.push({ developer, stage, reasons: standing.reasons, notified: false, requestIds: [] });
      continue;
    }

    // Find the developer's deal threads to notify (the requestIds on their VRX fee line). Existing deals
    // continue through every stage — the notice is exactly §3c's "everyone on an affected deal is told".
    const { byVrx } = await settlementRollup();
    const line = byVrx.find((v) => v.developer.trim().toLowerCase() === developer.toLowerCase());
    const requestIds = [...new Set((line?.deals ?? []).map((d) => d.requestId).filter(Boolean))];

    const text = standingCopy(standing);
    for (const requestId of requestIds) {
      await postSystemNotice({ requestId, text, context: { kind: "booking", id: requestId } });
    }

    // Record the fact so a replay is a no-op, even if there were ZERO threads (we still "announced" the stage —
    // a developer with no deals can't be re-notified, and shouldn't be re-tried every run).
    await mutate((store) => ({
      next: { ...store, [noticeKey(developer, stage)]: { developer, stage, at: asOf, requestIds } },
      ret: null,
    }));

    advances.push({ developer, stage, reasons: standing.reasons, notified: true, requestIds });
  }

  return { asOf, advances, notifiedCount: advances.filter((a) => a.notified).length };
}
