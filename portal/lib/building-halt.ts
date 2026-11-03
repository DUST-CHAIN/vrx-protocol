// BUILDING HALT STORE — the developer-asserted "stop selling this building" lever (Part A of
// the design docs). SERVER-ONLY, file-backed. Structural twin of
// lib/misrepresentation-store.ts (a attested record on lib/seal).
//
// ── FRAMING (LOCKED): TRANSPARENCY, not permission or penalty ───────────────────────────────
// A developer has an inalienable right to stop selling their own inventory — VRX can NEVER force a building
// open. So a halt is not a punishment and VRX does not adjudicate it. It is about transparency: a halt MUST
// carry an explanatory NOTE (the developer's own words), and everyone it affects (VRX + signed-up partners,
// and — when existing deals are touched — buyers too) must be able to see what's going on. This store holds
// the halt facts; the NOTICE fan-out (Part A2/B/C) and the affected-set resolver read FROM here.
//
// ── TWO HALT KINDS, by urgency ─────────────────────────────────────────────────────────────
//   • REGULAR — the developer "asks VRX first". Recorded as `pending`: it does NOT hide the building until a
//     VRX operator ACKNOWLEDGES it (acknowledgeHalt → status `active`). Use when there's no emergency and the
//  developer wants VRX in the loop up front. (: a regular halt is staged-pending, hidden on ack —
//     the literal "applied on VRX acknowledgement" reading. In this demo there is no human VRX actor, so the
//     operator ack is the /api/root/halts acknowledge action.)
//   • URGENT — takes effect IMMEDIATELY (recorded `active` on assertion): the safety case (a legal issue, a
//     pricing error, a unit that's genuinely unavailable — don't let a buyer book something that shouldn't be
//     bookable while waiting). VRX sees it right after.
// BOTH kinds REQUIRE a non-empty note (the halt-specific instance of the cross-cutting mandatory-remark rule).
//
// ── GRAIN: per BUILDING (contrast §3c, which is per DEVELOPER) ───────────────────────────────────────────
// §3c suspension (lib/dev-standing) is a DEVELOPER-level fact (late payment / misrepresentation degrades the
// whole account). A halt is BUILDING-level — a developer pauses ONE building. So the gate consults this at the
// building grain (lib/listing-gate.haltedBuildings), ORed with the developer-grain §3c hide. A halt stops NEW
// discovery + NEW bookings for that building; by itself it does NOT reach existing deals (those continue — H1
// keeps their money intact). Whether a given halt touches existing deals is COMPUTED by the A2 resolver
// (over allOffers + agreements), never stored as a human flag — so this record carries no "affectsExisting".
//
// ── assert / acknowledge / lift (no-latch, mirrors the misrepresentation verbs) ─────────────────────────
// A developer ASSERTS a halt (regular→pending, urgent→active). A VRX operator ACKNOWLEDGES a pending regular
// halt (pending→active). The developer LIFTS a halt when the building resumes (→lifted; audit-kept, no longer
// hides). A building has at most ONE active/pending halt at a time (a second assert while one is live is
// rejected by the route); the store itself keeps every record for audit, newest wins for the gate read.
//
// ── A attested record (not a new primitive) ────────────────────────────────────────────────────────
// The Nth consumer of lib/seal.ts (sibling of misrepresentation-store / vrx-receipts / agreements): plaintext
// (developer / building / tier / note / assertedAt) + a per-record secret salt + a sealHash that
// re-hashes to ✓Vetted. The seal is the developer's attestation: "developer D halted building B, tier T, on
// date, because: NOTE". Acknowledge/lift do NOT re-seal (the original assertion stays verifiable).
//
// ── AUTH is a ROUTE concern, not this lib's ─────────────────────────────────────────────────────────────
// Like misrepresentation-store, this module TRUSTS its caller. The DEVELOPER authorisation (only the building's
// developer may assert/lift) and the VRX-operator authorisation (only VRX may acknowledge) live in the routes
// that call it (app/api/catalog/halt + app/api/root/halts). Do NOT mistake this lib for the auth boundary.
//
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. A halt + its note is a B2B fact shared with VRX + signed-up partners (and existing-deal parties
// via A2) — never on-chain. The public projection strips the salt. The note is the DEVELOPER's own
// words, quoted verbatim where it surfaces (no translation of a developer's stated reason).
//
// ── Machine note ────────────────────────────────────────────────────────────────────────────────────────
// Any SEED `.data/building-halts.json` must be written with the Write tool (clean UTF-8/LF) — NEVER a
// PowerShell Set-Content/here-string (BOM + CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { digest, newSalt } from "./seal";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "building-halts.json");

/** The seal domain tag for building-halt assertions (PUBLIC namespace; the SECRET is the per-record salt). */
const HALT_DOMAIN = "vrx-building-halt";

/** Urgency tier. `regular` = ask VRX first (staged pending → hides on ack); `urgent` = immediate. */
export type HaltTier = "regular" | "urgent";

/** A halt's lifecycle. `pending` = asserted-regular awaiting VRX acknowledgement (NOT hiding yet); `active` =
 *  in effect (building hidden from NEW discovery/bookings); `lifted` = released by the developer (audit-kept,
 *  no longer hides). A record never moves backwards (pending→active→lifted only). */
export type HaltStatus = "pending" | "active" | "lifted";

/** One developer-asserted halt on ONE building. Keyed by `building`; a building has at most one record that is
 *  pending|active at a time (the route guards the second assert). `note` is mandatory (the mandatory-remark
 *  rule) — the developer's own words, surfaced verbatim. */
export type BuildingHalt = {
  /** Opaque record id. */
  id: string;
  /** The building this halt pauses. */
  building: string;
  /** The developer account that asserted it (the authoriser; the route proves it owns the building). */
  developer: string;
  /** Urgency tier — drives the initial status (regular→pending, urgent→active) and the notice loudness. */
  tier: HaltTier;
  /** Mandatory explanatory note, the developer's own words (surfaced verbatim, never translated). */
  note: string;
  /** Lifecycle status (see HaltStatus). */
  status: HaltStatus;
  /** ms epoch the developer asserted it — the seal anchor. */
  assertedAt: number;
  /** For a regular halt: who/when VRX acknowledged it (pending→active). Absent on an unacknowledged/urgent one. */
  acknowledged?: { by: string; at: number };
  /** When lifted: who/when the developer released it (→lifted). Absent while pending/active. */
  lifted?: { by: string; at: number };
  /** spine: per-record secret salt — NEVER served, NEVER on-chain. */
  salt: string;
  /** SHA-256 over domain|salt|stableStringify(the sealed payload) — the tamper-evident shared truth. */
  sealHash: string;
  /** ms epoch created / last mutated. */
  at: number;
  updatedAt: number;
};

/** The subset of a halt that is SEALED. EXCLUDES salt + sealHash (the seal itself), the mutable
 *  lifecycle (`status`/`acknowledged`/`lifted` all happen AFTER the attestation and must not invalidate it),
 *  and the volatile `updatedAt`. This is the developer's attestation: "developer D halted building B, tier T,
 *  on date, because: NOTE". */
export type HaltSealInput = {
  building: string;
  developer: string;
  tier: HaltTier;
  note: string;
  assertedAt: number;
  at: number;
};

/** Build the canonical seal payload (stable across reads). */
function sealPayload(h: BuildingHalt): HaltSealInput {
  return {
    building: h.building,
    developer: h.developer,
    tier: h.tier,
    note: h.note,
    assertedAt: h.assertedAt,
    at: h.at,
  };
}

/** Hash a halt's canonical payload with the halt domain + the record's salt → hex digest. */
export function haltDigest(h: BuildingHalt): string {
  return digest(sealPayload(h) as unknown as Record<string, unknown>, HALT_DOMAIN, h.salt);
}

/** The ✓ Vetted check: the stored plaintext + salt re-hash to the stored sealHash. false = tampered/lost-salt. */
export function verifyHalt(h: BuildingHalt): boolean {
  if (!h.salt || !h.sealHash) return false;
  return haltDigest(h) === h.sealHash;
}

// ── Store IO (mirrors misrepresentation-store: serialized via a promise chain so writes can't clobber) ──────

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: BuildingHalt[]) => Promise<{ next: BuildingHalt[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<BuildingHalt[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BuildingHalt[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: BuildingHalt[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const lc = (s: string) => s.trim().toLowerCase();

/** A halt that is currently HIDING the building (status `active`). `pending`/`lifted` do not hide. */
function isHiding(h: BuildingHalt): boolean {
  return h.status === "active";
}

/** A halt that is "live" (pending OR active) — the route guards a second assert against this. */
function isLive(h: BuildingHalt): boolean {
  return h.status === "pending" || h.status === "active";
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────────

/** Input to assert a halt. The route proves `developer` owns `building` (not the client). */
export type AssertHaltInput = {
  building: string;
  developer: string;
  tier: HaltTier;
  note: string;
  /** ms epoch asserted. Defaults to now; an explicit value lets a seed anchor it in the past. */
  assertedAt?: number;
};

/**
 * Assert a halt on a building (a developer action). REGULAR → status `pending` (does NOT hide until a VRX
 * operator acknowledges it); URGENT → status `active` (hides at once). The note is MANDATORY — a halt with no
 * stated reason is rejected here (throws). Returns the sealed record. Developer-authored (the route gates it).
 * Does NOT itself guard against a second live halt on the same building — the ROUTE checks `liveHaltForBuilding`
 * first and 409s (keeping this store a pure writer, like assertMisrepresentation).
 */
export async function assertHalt(input: AssertHaltInput): Promise<BuildingHalt> {
  const building = input.building.trim();
  const developer = input.developer.trim();
  const note = (input.note ?? "").trim();
  if (!building || !developer) throw new Error("halt: building/developer required");
  if (!note) throw new Error("halt: a non-empty note is required (mandatory-remark rule)");
  if (input.tier !== "regular" && input.tier !== "urgent") throw new Error("halt: tier must be regular|urgent");

  const now = Date.now();
  const salt = newSalt();
  const base: Omit<BuildingHalt, "sealHash"> = {
    id: `halt-${now}-${randomBytes(3).toString("hex")}`,
    building,
    developer,
    tier: input.tier,
    note,
    // Regular is staged pending (hides only on VRX ack); urgent is active immediately.
    status: input.tier === "urgent" ? "active" : "pending",
    assertedAt:
      typeof input.assertedAt === "number" && Number.isFinite(input.assertedAt) ? input.assertedAt : now,
    salt,
    at: now,
    updatedAt: now,
  };
  const sealHash = haltDigest(base as BuildingHalt);
  const record: BuildingHalt = { ...base, sealHash };

  return mutate(async (list) => {
    list.push(record);
    return { next: list, ret: record };
  });
}

/**
 * ACKNOWLEDGE a pending (regular) halt — the VRX-operator action that activates it (pending → active). Only a
 * `pending` record moves; an already-active (urgent, or previously-acked) or lifted one returns null (no-op).
 * Does NOT re-seal (the developer's attestation stays verifiable). VRX-root-authored (the /root route gates it).
 */
export async function acknowledgeHalt(id: string, by: string): Promise<BuildingHalt | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((h) => h.id === id && h.status === "pending");
    if (idx < 0) return { next: list, ret: null };
    const next = [...list];
    next[idx] = { ...list[idx], status: "active", acknowledged: { by: by.trim(), at: Date.now() }, updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/**
 * LIFT a halt — the developer releases the building back to normal (pending|active → lifted). The record is
 * kept for audit but no longer hides. Returns the lifted record, or null if not found / already lifted. Does
 * NOT re-seal. Developer-authored (the route proves ownership).
 */
export async function liftHalt(id: string, by: string): Promise<BuildingHalt | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((h) => h.id === id && isLive(h));
    if (idx < 0) return { next: list, ret: null };
    const next = [...list];
    next[idx] = { ...list[idx], status: "lifted", lifted: { by: by.trim(), at: Date.now() }, updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/** Every halt record (active + historical) for a building — newest first. For a developer/VRX audit surface. */
export async function haltsForBuilding(building: string): Promise<BuildingHalt[]> {
  const list = await readAll();
  const b = lc(building);
  return list.filter((h) => lc(h.building) === b).sort((a, b2) => b2.assertedAt - a.assertedAt);
}

/** The ONE live (pending|active) halt for a building, or null. Newest live record wins (there should be at most
 *  one — the route guards a second assert — but the read is defensive). The route reads this to 409 a duplicate. */
export async function liveHaltForBuilding(building: string): Promise<BuildingHalt | null> {
  const list = await readAll();
  const b = lc(building);
  const live = list
    .filter((h) => lc(h.building) === b && isLive(h))
    .sort((a, b2) => b2.assertedAt - a.assertedAt);
  return live[0] ?? null;
}

/** Every building currently HIDDEN by an active halt — the set lib/listing-gate consults at building grain.
 *  Lower-cased building ids. `pending`/`lifted` are NOT included (only `active` hides). */
export async function haltedBuildings(): Promise<Set<string>> {
  const list = await readAll();
  const out = new Set<string>();
  for (const h of list) if (isHiding(h)) out.add(lc(h.building));
  return out;
}

/** Is THIS one building currently halted (an active halt hides it)? The per-building fail-closed predicate the
 *  buyer-catalog read uses. */
export async function isBuildingHalted(building: string): Promise<boolean> {
  return (await haltedBuildings()).has(lc(building));
}

/** All halts currently PENDING a VRX acknowledgement — the /root queue (newest first). */
export async function pendingHalts(): Promise<BuildingHalt[]> {
  const list = await readAll();
  return list.filter((h) => h.status === "pending").sort((a, b) => b.assertedAt - a.assertedAt);
}

/** Every LIVE halt (pending OR active) across ALL buildings — newest first. The A2 notice fan-out
 *  (lib/halt-notices) iterates this to find who to notify: a `pending` regular halt already notifies
 *  (the developer has stated intent + reason; VRX is in the loop), and `active` is in effect. `lifted`
 *  is excluded (resolved — no live notice). Does NOT run the affected-set resolver (that's the caller's
 *  concern); this is just the live-halt enumerator the per-building reads never needed. */
export async function liveHalts(): Promise<BuildingHalt[]> {
  const list = await readAll();
  return list.filter(isLive).sort((a, b) => b.assertedAt - a.assertedAt);
}

/** The PUBLIC projection of a halt — strips the salt so it's never served. The sealHash stays (shared
 *  truth); a holder re-verifies with their stored salt. For any API that returns halt records. */
export function publicHalt(h: BuildingHalt): Omit<BuildingHalt, "salt"> {
  const { salt: _salt, ...rest } = h;
  return rest;
}
