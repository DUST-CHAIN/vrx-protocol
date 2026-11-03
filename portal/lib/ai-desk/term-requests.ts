// AI Sales Director — TERM REQUESTS (the design docs §terms). SERVER-ONLY, file-backed.
// A buyer's ask for payment terms OUTSIDE the developer's acceptable range — the one case the desk (and the
// overlay form) cannot self-serve, because no one but the DEVELOPER may bend their own published rule.
//
// ── Why this is NOT the "Refer to VRX" escalation (deliberate; verified) ─────────────────────────
//  (lib/conversations-direct.escalateToVrx) brings VRX-ROOT in to MEDIATE a dispute and keeps the deal live.
// A terms ask is NOT a dispute — it's "can you, the developer, make an exception to your own terms for me?".
// Only the developer who OWNS the terms can answer that, so the queue is DEVELOPER-facing (/node), not VRX-root.
// The two share a shape (a flagged conversation + a reason) but route to DIFFERENT parties; conflating them would
// send a terms decision to the wrong desk. So this is its own thin store, mirroring deal-sidecar's idiom.
//
// ── Two feeders, one store ──────────────────────────────────────────────────────────────────────────
//   1. THE FORM (no AI): the buyer hits "ask for different terms" in the review overlay and types a short note →
//      POST /api/term-requests files one directly. The common, cheap path — no AI turn, no confabulation risk.
//   2. THE DESK (routing only): if the buyer asks conversationally, the desk recognizes an OUT-OF-RANGE ask and
//      files the SAME request. The AI only ROUTES — it never composes the numbers (the in-range case is the
//      overlay sliders' job, which are bounded by caps). The in-range test is the shared lib/payment-plan.isAskInRange.
//
// ── Privacy ─────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. A term request carries only a neutral MONEY structure (the milestone + the asked figure) + the
// buyer's free-text note. NO sealed PII (the developer already sees the masked buyer in the thread; a term
// request changes no projection). The note is treated as off-chain body text (capped), same posture as 's reason.
//
// ── Machine note ─────────────────────────────────────────────────────────────────────────────────────────────
// Any seed .data/ai-term-requests.json must be written with the Write tool (clean UTF-8/LF), never a PowerShell
// here-string (BOM+CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import type { TermsMilestone } from "../payment-plan";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "ai-term-requests.json");
const NOTE_CAP = 500; // off-chain body cap (same posture as 's reason)

/** One buyer ask for out-of-range terms — a developer work item. Keyed by `id`. */
export type TermRequest = {
  /** Stable id (dealId + milestone + value → idempotent: a repeat of the SAME ask upserts, doesn't duplicate). */
  id: string;
  /** The conversation/deal this came from (so the developer can open the thread). */
  dealId: string;
  /** The building — scopes the request to the developer who owns it (the /node queue filters on this). */
  buildingId: string;
  /** The developer who owns the building/terms (resolved by the filer; the queue double-checks via buildingIds). */
  developer: string;
  /** Which milestone the buyer wants bent. Absent when the ask is free-text only (a bespoke structure). */
  milestone?: TermsMilestone;
  /** The figure the buyer asked for (a %, or an instalment count). Absent for a free-text-only ask. */
  askedValue?: number;
  /** The bound the ask breached + which side — for the developer's at-a-glance read ("36, above the 24 max"). */
  breach?: { side: "below" | "above"; bound: number };
  /** The buyer's free-text note (capped; may be the whole ask when there's no structured milestone). */
  note?: string;
  /** Who filed it — "buyer" (the form) or "desk" (the AI routed a chat ask). Audit + copy. */
  source: "buyer" | "desk";
  /** open = awaiting the developer; resolved = the developer has actioned it (accepted/declined out-of-band). */
  status: "open" | "resolved";
  /** ms epoch filed. */
  at: number;
  /** ms epoch the developer resolved it (set when status → resolved). */
  resolvedAt?: number;
};

/** The structured ask a feeder passes in (the id/developer/timestamps/status are server-managed). */
export type FileTermRequestInput = {
  dealId: string;
  buildingId: string;
  developer: string;
  milestone?: TermsMilestone;
  askedValue?: number;
  breach?: { side: "below" | "above"; bound: number };
  note?: string;
  source: "buyer" | "desk";
};

// ── Store IO (mirrors deal-sidecar: serialized via a promise chain so concurrent writes can't clobber). ──
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: TermRequest[]) => Promise<{ next: TermRequest[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<TermRequest[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TermRequest[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: TermRequest[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** A stable, opaque id for an ask so an identical repeat (double-tap, re-ask) UPSERTS instead of duplicating.
 *  Free-text-only asks (no milestone) fall back to a time bucket so two different notes don't collide, but the
 *  SAME note+milestone within a deal is one request. PURE-ish (uses the note text, not a hash — ids stay legible). */
function requestId(input: FileTermRequestInput): string {
  const base = `${input.dealId}|${input.milestone ?? "freeform"}|${input.askedValue ?? ""}`;
  // A structured ask is fully keyed; a free-text-only ask adds a short note fingerprint so distinct notes differ.
  const noteKey = input.milestone ? "" : `|${(input.note ?? "").trim().slice(0, 40).toLowerCase()}`;
  return `tr_${base}${noteKey}`.replace(/\s+/g, "-").slice(0, 120);
}

/**
 * File (or re-open) a term request. Idempotent per (deal, milestone, value) [+ note for free-text]: a repeat of
 * the SAME ask returns the existing OPEN request untouched; a repeat of a RESOLVED one re-opens it (the buyer is
 * asking again). Returns the stored request + whether it was newly created.
 */
export async function fileTermRequest(input: FileTermRequestInput): Promise<{ request: TermRequest; created: boolean }> {
  const id = requestId(input);
  return mutate<{ request: TermRequest; created: boolean }>(async (list) => {
    const now = Date.now();
    const idx = list.findIndex((r) => r.id === id);
    if (idx >= 0) {
      const cur = list[idx];
      if (cur.status === "open") return { next: list, ret: { request: cur, created: false } }; // already open — no-op
      // Resolved → re-open (asking again): fresh timestamp, clear the resolution.
      const reopened: TermRequest = { ...cur, status: "open", at: now };
      delete reopened.resolvedAt;
      const next = [...list];
      next[idx] = reopened;
      return { next, ret: { request: reopened, created: false } };
    }
    const request: TermRequest = {
      id,
      dealId: input.dealId.trim(),
      buildingId: input.buildingId.trim(),
      developer: input.developer.trim(),
      ...(input.milestone ? { milestone: input.milestone } : {}),
      ...(typeof input.askedValue === "number" ? { askedValue: input.askedValue } : {}),
      ...(input.breach ? { breach: input.breach } : {}),
      ...(input.note ? { note: input.note.trim().slice(0, NOTE_CAP) } : {}),
      source: input.source,
      status: "open",
      at: now,
    };
    return { next: [...list, request], ret: { request, created: true } };
  });
}

/** Mark a request resolved (the developer actioned it). Idempotent: a second resolve is a no-op. The route
 *  authorizes the caller is the owning developer BEFORE calling this. Returns the request, or null if unknown. */
export async function resolveTermRequest(id: string): Promise<TermRequest | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return { next: list, ret: null };
    if (list[idx].status === "resolved") return { next: list, ret: list[idx] };
    const resolved: TermRequest = { ...list[idx], status: "resolved", resolvedAt: Date.now() };
    const next = [...list];
    next[idx] = resolved;
    return { next, ret: resolved };
  });
}

/** One request by id (for the resolve route to re-check ownership). PURE read. */
export async function getTermRequest(id: string): Promise<TermRequest | null> {
  return (await readAll()).find((r) => r.id === id) ?? null;
}

/** OPEN term requests across a developer's buildings — the /node queue source. Scoped by the caller's buildingIds
 *  (the SAME scoping as the work-report). Newest-first. Only `open` by default; pass `includeResolved` for all. */
export async function termRequestsForBuildings(
  buildingIds: string[],
  includeResolved = false
): Promise<TermRequest[]> {
  const set = new Set(buildingIds);
  return (await readAll())
    .filter((r) => set.has(r.buildingId) && (includeResolved || r.status === "open"))
    .sort((a, b) => b.at - a.at);
}

/** TEST-ONLY reset (the store is cwd-scoped via DATA_DIR; tests chdir to a temp dir). */
export async function __resetForTests(): Promise<void> {
  await writeAll([]);
}
