// MISREPRESENTATION STORE — the operator-attested "this developer's listing was found materially wrong and
// not corrected" fact store (§3c second trigger; the enforcement arc). SERVER-ONLY, file-backed.
// the design docs §3c + §7 (the accuracy compact) · docs/.md.
//
// ── The gap this closes ─────────────────────────────────────────────────────────────────────────────────
// lib/dev-standing.ts accepts a SECOND §3c trigger — `misrepresentation?: MisrepresentationTrigger` — into the
// SAME grace→suspended→removed stages as late-payment. lib/standing-scheduler.advanceDeveloperStandings
// then takes a `misrepresentations?: Record<string, MisrepresentationTrigger>` map. Until now NOTHING produced
// that map: the trigger could only be INJECTED by a test/caller, so the misrepresentation half of the machine
// ran on hypothetical input (exactly the data-first gap vrx-receipts.ts closed for the late-payment half in
// ). This module is that store — it turns the misrepresentation trigger from a test-only argument into a
// real operator-asserted fact the scheduler reads.
//
// ── NEVER machine-computed ─────────────────────────────────────────────────────────────────
// "Is this fraud?" is a HUMAN judgment. A misrepresentation enters the system ONLY as an operator's explicit
// assertion (a VRX-root action), never anything derived/inferred. This store holds those assertions and nothing
// else; it computes no standing itself (dev-standing does that) — it is purely the attested input.
//
// ── Grain: per DEVELOPER, building OPTIONAL ─────────────────────────────────────────────────────────────
// Standing is developer-level: a misrepresentation in ONE building degrades the DEVELOPER's platform
// standing. So the trigger the resolver needs is one-per-developer. But an operator may flag more than one
// building over time, so each assertion is its own audit record (keyed by developer, carrying an optional
// buildingId for the notice copy / audit). When several are active for one developer, the trigger anchors on
// the EARLIEST active assertion — matching the resolver's "anchor on the earliest active trigger" rule, so the
// §3c clock starts from when the developer was FIRST told, not the latest flag.
//
// ── assert / clear, NOT record / void (the no-latch rule) ───────────────────────────────────
// dev-standing's MisrepresentationTrigger doc: "the operator clears it by WITHDRAWING the assertion — the
// resolver holds no latch; it reflects the CURRENT asserted state." So the verbs are assert / clear. A clear
// keeps the record for audit (like a receipt void) but it genuinely UN-degrades standing: once the last active
// assertion for a developer is withdrawn, the store produces no trigger and the resolver returns the developer
// to `good`. There is no "served time" latch — withdrawing is a full reversal, by design.
//
// ── A attested record (not a new primitive) ────────────────────────────────────────────────────────
// The Nth consumer of lib/seal.ts (sibling of vrx-receipts / agreements / vrx-developer-agreement): plaintext
// (developer / assertedBy / assertedAt / building? / reason?) + a per-record secret salt + a sealHash
// that re-hashes to ✓Vetted. The seal is VRX-root's attestation: "operator O asserted on date D that developer
// X misrepresented [building B] — reason R". Clearing does NOT re-seal (the original assertion stays verifiable).
//
// ── AUTH is a ROUTE concern, not this lib's ─────────────────────────────────────────────────────────────
// Like vrx-receipts.recordReceipt, this module TRUSTS its caller. The VRX-root authorisation (only a VRX
// operator may assert/clear) lives in the route/action that calls it — that surface (the `/root` console) is a
// later arc; this is the store it will write through. Do NOT mistake this lib for the authorization boundary.
//
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. A misrepresentation finding is a sensitive B2B VRX↔developer fact (reputational) — never on-chain,
// never on a buyer/agent surface. The public projection strips the salt. user-visible standing copy
// says plain words ("accuracy issue under review"), never the raw assertion text.
//
// ── Machine note ────────────────────────────────────────────────────────────────────────────────────────
// Any SEED `.data/misrepresentations.json` must be written with the Write tool (clean UTF-8/LF) — NEVER a
// PowerShell Set-Content/here-string (BOM + CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { digest, newSalt } from "./seal";
import type { MisrepresentationTrigger } from "./dev-standing";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "misrepresentations.json");

/** The seal domain tag for misrepresentation assertions (PUBLIC namespace; the SECRET is the per-record salt). */
const MISREP_DOMAIN = "vrx-misrepresentation";

/** One operator-attested assertion that a developer misrepresented a listing. Keyed by `developer` (standing is
 *  developer-level); `buildingId` is optional audit/notice context. At most one record per id; a developer may
 *  have several active assertions (different buildings / times) — the resolver trigger anchors on the earliest. */
export type Misrepresentation = {
  /** Opaque record id. */
  id: string;
  /** The developer whose standing this degrades. */
  developer: string;
  /** The VRX operator account that asserted it (audit trail; never a machine/automatic source). */
  assertedBy: string;
  /** ms epoch the operator asserted it — the §3c timeline anchor for this trigger. */
  assertedAt: number;
  /** Optional building the finding concerns (notice copy / audit). Standing is developer-level regardless. */
  buildingId?: string;
  /** Free-text operator reason (audit; B2B, never surfaced raw to non-parties). */
  reason?: string;
  /** A WITHDRAWN assertion is kept for audit but no longer drives standing (the no-latch rule). A clear does NOT
   *  re-seal (the original attestation stays verifiable); it records who/why/when. */
  cleared?: { by: string; reason?: string; at: number };
  /** spine: per-record secret salt — NEVER served, NEVER on-chain. */
  salt: string;
  /** SHA-256 over domain|salt|stableStringify(the sealed payload) — the tamper-evident shared truth. */
  sealHash: string;
  /** ms epoch created / last mutated. */
  at: number;
  updatedAt: number;
};

/** The subset of an assertion that is SEALED. EXCLUDES salt + sealHash (the seal itself), the mutable
 *  `cleared` flag (a withdrawal happens AFTER the attestation and must not invalidate it), and the volatile
 *  `updatedAt`. This is VRX-root's attestation: "operator O asserted on date D that developer X misrepresented
 *  [building B] — reason R". */
export type MisrepSealInput = {
  developer: string;
  assertedBy: string;
  assertedAt: number;
  buildingId?: string;
  reason?: string;
  at: number;
};

/** Build the canonical seal payload (stable across reads — optional fields OMITTED when absent so a record
 *  without a buildingId/reason hashes stably, never `undefined`-vs-missing divergence). */
function sealPayload(m: Misrepresentation): MisrepSealInput {
  const p: MisrepSealInput = {
    developer: m.developer,
    assertedBy: m.assertedBy,
    assertedAt: m.assertedAt,
    at: m.at,
  };
  if (m.buildingId) p.buildingId = m.buildingId;
  if (m.reason) p.reason = m.reason;
  return p;
}

/** Hash an assertion's canonical payload with the misrep domain + the record's salt → hex digest. */
export function misrepDigest(m: Misrepresentation): string {
  return digest(sealPayload(m) as unknown as Record<string, unknown>, MISREP_DOMAIN, m.salt);
}

/** The ✓ Vetted check: the stored plaintext + salt re-hash to the stored sealHash. false = tampered/lost-salt. */
export function verifyMisrepresentation(m: Misrepresentation): boolean {
  if (!m.salt || !m.sealHash) return false;
  return misrepDigest(m) === m.sealHash;
}

// ── Store IO (mirrors vrx-receipts.ts: serialized via a promise chain so concurrent writes can't clobber) ──

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: Misrepresentation[]) => Promise<{ next: Misrepresentation[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<Misrepresentation[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Misrepresentation[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Misrepresentation[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const lc = (s: string) => s.trim().toLowerCase();

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────────

/** Input to assert a misrepresentation. The route supplies / verifies `assertedBy` (VRX-root) — not the client. */
export type AssertMisrepInput = {
  developer: string;
  assertedBy: string;
  /** ms epoch asserted. Defaults to now when omitted (the operator asserts it "now"); an explicit value lets a
   *  seed/backfill anchor the §3c clock in the past. */
  assertedAt?: number;
  buildingId?: string;
  reason?: string;
};

/**
 * Assert that a developer misrepresented a listing (an operator action; NEVER machine-computed). Creates a new
 * sealed audit record. Does NOT replace prior assertions — a developer may accumulate several (different
 * buildings / incidents); the resolver trigger anchors on the EARLIEST active one. VRX-root-authored (the route
 * gates it). Throws on a missing developer / assertedBy.
 */
export async function assertMisrepresentation(input: AssertMisrepInput): Promise<Misrepresentation> {
  const developer = input.developer.trim();
  const assertedBy = input.assertedBy.trim();
  if (!developer || !assertedBy) throw new Error("misrepresentation: developer/assertedBy required");

  const now = Date.now();
  const salt = newSalt();
  const base: Omit<Misrepresentation, "sealHash"> = {
    id: `misrep-${now}-${randomBytes(3).toString("hex")}`,
    developer,
    assertedBy,
    assertedAt: typeof input.assertedAt === "number" && Number.isFinite(input.assertedAt) ? input.assertedAt : now,
    buildingId: input.buildingId?.trim() || undefined,
    reason: input.reason?.trim() || undefined,
    salt,
    at: now,
    updatedAt: now,
  };
  const sealHash = misrepDigest(base as Misrepresentation);
  const record: Misrepresentation = { ...base, sealHash };

  return mutate(async (list) => {
    list.push(record);
    return { next: list, ret: record };
  });
}

/**
 * Clear (WITHDRAW) a single assertion by id. Keeps the record for audit but flips `cleared` so it no longer
 * drives standing (the no-latch rule — once the last active assertion for a developer is cleared, standing
 * returns to `good`). Does NOT re-seal. Returns the cleared record, or null if not found / already cleared.
 */
export async function clearMisrepresentation(id: string, by: string, reason?: string): Promise<Misrepresentation | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((m) => m.id === id && m.cleared == null);
    if (idx < 0) return { next: list, ret: null };
    const cleared: Misrepresentation = {
      ...list[idx],
      cleared: { by: by.trim(), reason: reason?.trim() || undefined, at: Date.now() },
      updatedAt: Date.now(),
    };
    const next = [...list];
    next[idx] = cleared;
    return { next, ret: cleared };
  });
}

/**
 * Clear ALL active assertions for a developer in one call (the common operator action — "the developer corrected
 * it, withdraw the finding"). Returns the number of records cleared. A convenience over clearing each id; both
 * leave the audit trail intact.
 */
export async function clearDeveloper(developer: string, by: string, reason?: string): Promise<number> {
  const dev = lc(developer);
  return mutate(async (list) => {
    let n = 0;
    const next = list.map((m) => {
      if (m.cleared == null && lc(m.developer) === dev) {
        n++;
        return { ...m, cleared: { by: by.trim(), reason: reason?.trim() || undefined, at: Date.now() }, updatedAt: Date.now() };
      }
      return m;
    });
    return { next, ret: n };
  });
}

/** All assertions (active + cleared) for a developer — newest first. For a VRX-root / developer audit surface. */
export async function misrepsForDeveloper(developer: string): Promise<Misrepresentation[]> {
  const list = await readAll();
  const dev = lc(developer);
  return list.filter((m) => lc(m.developer) === dev).sort((a, b) => b.assertedAt - a.assertedAt);
}

/** The active (un-cleared) assertions for a developer, EARLIEST first (so [0] is the §3c anchor). */
async function activeForDeveloper(list: Misrepresentation[], developer: string): Promise<Misrepresentation[]> {
  const dev = lc(developer);
  return list
    .filter((m) => m.cleared == null && lc(m.developer) === dev)
    .sort((a, b) => a.assertedAt - b.assertedAt);
}

/**
 * The §3c MisrepresentationTrigger for ONE developer, or null when nothing is actively flagged. Anchors on the
 * EARLIEST active assertion (the §3c clock starts when the developer was FIRST told). The returned trigger is the
 * exact shape lib/dev-standing.resolveDeveloperStanding consumes. null ⇔ no trigger ⇔ the resolver returns `good`.
 */
export async function misrepresentationTrigger(developer: string): Promise<MisrepresentationTrigger | null> {
  const list = await readAll();
  const active = await activeForDeveloper(list, developer);
  const first = active[0];
  if (!first) return null;
  const t: MisrepresentationTrigger = { assertedAt: first.assertedAt, assertedBy: first.assertedBy };
  if (first.buildingId) t.buildingId = first.buildingId;
  return t;
}

/**
 * The map of developer → active trigger, the exact shape lib/standing-scheduler.advanceDeveloperStandings takes
 * as `misrepresentations`. When `developers` is omitted, covers every developer with an active assertion in the
 * store; when supplied, restricts to that set (and omits any with nothing flagged — an absent key ⇔ no trigger).
 * This is what turns the scheduler's `misrepresentations` param from an injected arg into a store-driven read.
 */
export async function misrepresentationTriggers(
  developers?: string[]
): Promise<Record<string, MisrepresentationTrigger>> {
  const list = await readAll();
  // The set of developers to produce triggers for: the explicit list, or every developer with an active record.
  const names = developers
    ? developers.map((d) => d.trim()).filter(Boolean)
    : Array.from(new Set(list.filter((m) => m.cleared == null).map((m) => m.developer)));

  const out: Record<string, MisrepresentationTrigger> = {};
  for (const dev of names) {
    const active = await activeForDeveloper(list, dev);
    const first = active[0];
    if (!first) continue; // absent key ⇔ no trigger (matches the scheduler's "omitted ⇒ none flagged")
    const t: MisrepresentationTrigger = { assertedAt: first.assertedAt, assertedBy: first.assertedBy };
    if (first.buildingId) t.buildingId = first.buildingId;
    out[dev] = t;
  }
  return out;
}

/** The PUBLIC projection of an assertion — strips the salt so it's never served. The sealHash stays
 *  (shared truth); a holder re-verifies with their stored salt. For any API that returns assertions. */
export function publicMisrepresentation(m: Misrepresentation): Omit<Misrepresentation, "salt"> {
  const { salt: _salt, ...rest } = m;
  return rest;
}
