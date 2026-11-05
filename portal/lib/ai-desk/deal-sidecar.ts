// AI Sales Director — the DEAL SIDECAR (the design docs §6). SERVER-ONLY, file-backed.
// The AI's OWN per-deal working memory: the current deal STATE + a running SUMMARY it curates as the
// conversation progresses. This is the "lean core + fetch" principle applied to the chat itself — instead of
// re-feeding 20 raw turns every round, the AI reads the summary it already distilled (cheaper + it never loses
// the thread across a long negotiation). It also powers the developer-facing WORK REPORT (slice 5b): where the
// deal stands, the deadline, and when it's expected to close.
//
// ── NOT a sealed attested fact (deliberate, cf. vrx-receipts/payment-vault which DO seal) ──────────────────
// The sidecar is MUTABLE working state the AI rewrites every turn — the opposite of an attestation, which is
// FROZEN the moment it's made. Sealing a thing that changes each turn would be dishonest (the ✓Vetted seal
// means "this exact text is committed"). So the sidecar is a plain serialized store (the same concurrency-safe
// mutate idiom, WITHOUT the seal). The real COMMITMENTS a deal produces — a hold, a deposit receipt — are
// sealed by THEIR own stores (unit-grants / vrx-receipts); the sidecar only POINTS at them. Keep it that way.
//
// ── Privacy ───────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. The summary is the AI's own words about the deal's SHAPE (phase, budget band, which unit, the
// deadline) — it must carry NO raw buyer PII (the inbound context is already masked+scrubbed, so the AI never
// had PII to write down). A future client-surfaced projection strips anything internal. Keep figures B2B-only.
//
// ── Machine note ───────────────────────────────────────────────────────────────────────────────────────────
// Any seed .data/ai-deal-sidecars.json must be written with the Write tool (clean UTF-8/LF), never a PowerShell
// here-string (BOM+CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import type { Phase } from "./permissions";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "ai-deal-sidecars.json");

/** How a held unit's auto-release deadline is pitched (slice 7 consumes these; the sidecar RECORDS the level +
 *  the computed releaseAt so the pure release evaluator is a function of (sidecar, now)). */
export type ReleaseLevel = "l1" | "l2" | "final" | null;

/** One deal's sidecar — the AI's working record. Keyed by the deal's conversation/booking id (the same id the
 *  context + thread use), so there is exactly one sidecar per live deal. */
export type DealSidecar = {
  /** The deal/conversation id (the key). */
  dealId: string;
  /** The building this deal is about (for the work-report roll-up by developer/building). */
  buildingId: string;
  /** Who the desk is talking to — mirrors the context persona (buyer|agent). */
  counterparty: "buyer" | "agent";
  /** The current conversation phase (drives the permission matrix + the report's "where it stands"). */
  phase: Phase;
  /** The unit the deal has centred on, once one has (find → focus). Absent = still browsing. */
  focusUnitId?: string;
  /** The unit currently HELD for this deal (set when open_unit fires, slice 6). Absent = nothing held. */
  heldUnitId?: string;
  /** When the current hold auto-releases if the deal stalls (slice 7). ms epoch. Absent = no live hold. */
  releaseAt?: number;
  /** Which release level the hold is at (for the escalating 2h → next-working-day → tell-customer ladder). */
  releaseLevel?: ReleaseLevel;
  /** Whether the customer has been WARNED that the unit will be released (slice 7 idempotency — warn once). */
  releaseWarned?: boolean;
  /** The AI's running plain-text SUMMARY of the deal (it rewrites this each turn). No PII. */
  summary: string;
  /** When the deal is EXPECTED to close, if the AI has formed a view (ms epoch). Informational for the report. */
  expectedCloseAt?: number;
  /** ms epoch created / last touched. */
  at: number;
  updatedAt: number;
};

/** The fields a caller may set/update on a turn — everything except the server-managed id/timestamps. All
 *  optional so a turn can patch just the summary, or just advance the phase, etc. */
export type SidecarPatch = Partial<Omit<DealSidecar, "dealId" | "at" | "updatedAt">>;

// ── Store IO (mirrors vrx-receipts/payment-vault: serialized via a promise chain so concurrent writes can't
//    clobber — two turns of the same deal, or two deals, never interleave a read-modify-write). ──
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: DealSidecar[]) => Promise<{ next: DealSidecar[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<DealSidecar[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DealSidecar[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: DealSidecar[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** Read one deal's sidecar (null if the AI hasn't written one yet). PURE read. */
export async function getSidecar(dealId: string): Promise<DealSidecar | null> {
  return (await readAll()).find((s) => s.dealId === dealId) ?? null;
}

/**
 * Upsert a deal's sidecar — create it on first write, else patch the given fields. The AI calls this each turn
 * to record where the deal stands + its running summary. Server-managed: dealId (the key), at (first write),
 * updatedAt (every write). Returns the stored sidecar.
 */
export async function upsertSidecar(
  dealId: string,
  buildingId: string,
  counterparty: "buyer" | "agent",
  patch: SidecarPatch
): Promise<DealSidecar> {
  return mutate(async (list) => {
    const now = Date.now();
    const idx = list.findIndex((s) => s.dealId === dealId);
    if (idx < 0) {
      const created: DealSidecar = {
        dealId,
        buildingId,
        counterparty,
        phase: patch.phase ?? "browse",
        summary: patch.summary ?? "",
        at: now,
        updatedAt: now,
        ...stripUndefined(patch),
      };
      return { next: [...list, created], ret: created };
    }
    // patch the existing — only the provided fields change; buildingId/counterparty can also be corrected.
    const updated: DealSidecar = {
      ...list[idx],
      buildingId,
      counterparty,
      ...stripUndefined(patch),
      updatedAt: now,
    };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** Clear a hold's release fields on the sidecar (used when a hold is released or the deal closes). */
export async function clearHold(dealId: string): Promise<DealSidecar | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((s) => s.dealId === dealId);
    if (idx < 0) return { next: list, ret: null };
    const updated: DealSidecar = { ...list[idx], updatedAt: Date.now() };
    delete updated.heldUnitId;
    delete updated.releaseAt;
    delete updated.releaseLevel;
    delete updated.releaseWarned;
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** All sidecars for a developer's buildings — the WORK REPORT roll-up source (slice 5b). `buildingIds` is the
 *  developer's set (the caller resolves it from the registry); a sidecar matches if its buildingId is in the set. */
export async function sidecarsForBuildings(buildingIds: string[]): Promise<DealSidecar[]> {
  const set = new Set(buildingIds);
  return (await readAll()).filter((s) => set.has(s.buildingId)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Drop undefined-valued keys from a patch so an explicit `{phase: undefined}` can't blow away a stored value
 *  (a patch only sets what it names). PURE. */
function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** TEST-ONLY reset (the store is cwd-scoped via DATA_DIR; tests chdir to a temp dir). */
export async function __resetForTests(): Promise<void> {
  await writeAll([]);
}
