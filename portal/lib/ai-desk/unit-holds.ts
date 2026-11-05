// AI Sales Director — the OFF-CHAIN SOFT-HOLD store (slice 6, the design docs §5).
// SERVER-ONLY, file-backed. The attested record the `signGrantExclusive` SEAM produces when the AI desk opens
// a unit for a deal: "the desk is holding unit U (building B) for deal D until T." It is the DEMO-stage stand-in
// for the real on-chain grant_exclusive (D-) — the real firm-hold is WALLET-SIGNED by a human desk operator
// client-side (api/direct-deposits "never holds a key"), so an autonomous AI hold cannot be on-chain without a
// desk key on the server. So the AI records an OFF-CHAIN SEALED soft-hold here; a human later signs the real
// grant_exclusive to make it firm (the unchanged flow). The auto-release timers (slice 7) free a stalled soft-hold.
//
// ── A attested record (not a new primitive) ────────────────────────────────────────────────────────
// Each soft-hold is the Nth consumer of lib/seal.ts: plaintext (desk/building/unit/deal/window) + a per-record
// secret salt + a sealHash that re-hashes to ✓Vetted. Same spine as offers/receipts/payments — no
// parallel seal. The seal is the desk's attestation: "the desk reserved unit U for deal D until T". UNLIKE the
// sidecar (D- deliberately NOT sealed because it is mutable working state), a soft-hold IS a frozen
// commitment the moment it's made — exactly the thing that SHOULD be sealed (the sidecar only POINTS at it).
//
// ── Grain: at most one ACTIVE hold per deal ─────────────────────────────────────────────────────────────
// A deal holds at most one unit at a time (opening a second supersedes the first — the desk moved the buyer to
// a different unit). Keyed primarily by dealId; the unitId is carried so a release/availability check matches.
// A released hold is kept as a tombstone (`released` set) for audit, like a voided receipt.
//
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. Neutral account/building/unit ids + a timestamp window — no PII, no price, no terms. The public
// projection strips the salt. This mirrors exclusives-store's opacity (the on-chain mirror it shadows).
//
// ── Machine note ────────────────────────────────────────────────────────────────────────────────────────
// Any SEED .data/ai-unit-holds.json must be written with the Write tool (clean UTF-8/LF) — NEVER a PowerShell
// Set-Content/here-string (BOM + CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { digest, newSalt } from "../seal";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "ai-unit-holds.json");

/** The seal domain tag for AI soft-holds (PUBLIC namespace; the SECRET is the per-record salt). */
const HOLD_DOMAIN = "vrx-ai-soft-hold";

/** One off-chain soft-hold the AI desk placed for a deal. */
export type SoftHold = {
  /** Opaque record id. */
  id: string;
  /** The deal/conversation id the hold belongs to (the primary key — one active hold per deal). */
  dealId: string;
  /** The desk developer account the hold is "signed" as (the party the real grant_exclusive would be by). */
  desk: string;
  buildingId: string;
  unitId: string;
  /** ms epoch the soft-hold was placed. */
  heldAt: number;
  /** ms epoch the hold auto-releases if the deal stalls (the slice-7 timer anchor). */
  releaseAt: number;
  /** RELEASED tombstone (auto-release fired, or the deal closed/moved) — kept for audit, no longer live.
   *  A release does NOT re-seal (the original attestation stays verifiable); it flips this + records who/why. */
  released?: { by: string; reason: string; at: number };
  /** spine: per-record secret salt — NEVER served, NEVER on-chain. */
  salt: string;
  /** SHA-256 over domain|salt|stableStringify(the sealed payload) — the tamper-evident shared truth. */
  sealHash: string;
  /** ms epoch created / last mutated. */
  at: number;
  updatedAt: number;
};

/** The subset of a hold that is SEALED. EXCLUDES salt + sealHash (the seal itself), the mutable
 *  `released` tombstone (a release happens AFTER the attestation and must not invalidate it), and the volatile
 *  `updatedAt`. This is the desk's attestation: "desk D reserved unit U (building B) for deal L until T". */
export type HoldSealInput = {
  dealId: string;
  desk: string;
  buildingId: string;
  unitId: string;
  heldAt: number;
  releaseAt: number;
};

/** Build the canonical seal payload (stable across reads — same fields every time). */
function sealPayload(h: SoftHold): HoldSealInput {
  return {
    dealId: h.dealId,
    desk: h.desk,
    buildingId: h.buildingId,
    unitId: h.unitId,
    heldAt: h.heldAt,
    releaseAt: h.releaseAt,
  };
}

/** Hash a hold's canonical payload with the hold domain + the record's salt → hex digest. */
export function holdDigest(h: SoftHold): string {
  return digest(sealPayload(h) as unknown as Record<string, unknown>, HOLD_DOMAIN, h.salt);
}

/** The ✓ Vetted check: the stored plaintext + salt re-hash to the stored sealHash. false = tampered/lost-salt. */
export function verifyHold(h: SoftHold): boolean {
  if (!h.salt || !h.sealHash) return false;
  return holdDigest(h) === h.sealHash;
}

// ── Store IO (mirrors vrx-receipts.ts: serialized via a promise chain so concurrent writes can't clobber) ──
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: SoftHold[]) => Promise<{ next: SoftHold[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<SoftHold[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SoftHold[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: SoftHold[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const lc = (s: string) => s.trim().toLowerCase();

/** Input to place a soft-hold. The caller (the signing seam) supplies the desk + resolved window. */
export type PlaceHoldInput = {
  dealId: string;
  desk: string;
  buildingId: string;
  unitId: string;
  /** ms epoch the hold auto-releases (the L1 anchor the signing seam computes). */
  releaseAt: number;
  /** Optional explicit held-at (defaults to now) — lets a test or a replay pin the moment. */
  heldAt?: number;
};

/**
 * Place (or move) a deal's soft-hold. At most ONE active hold per deal: placing a new one RELEASES any prior
 * active hold for the same deal first (the desk moved the buyer to a different unit), then seals the new one.
 * Idempotent for the SAME (deal, unit, window): a re-place of an identical active hold returns it untouched (the
 * seal is deterministic given the fields, so a double-tap doesn't churn). Returns the stored hold.
 */
export async function placeHold(inp: PlaceHoldInput): Promise<SoftHold> {
  const dealId = inp.dealId.trim();
  const desk = inp.desk.trim();
  const buildingId = inp.buildingId.trim();
  const unitId = inp.unitId.trim();
  if (!dealId || !desk || !buildingId || !unitId) throw new Error("soft-hold: dealId/desk/buildingId/unitId required");
  if (!Number.isFinite(inp.releaseAt) || inp.releaseAt <= 0) throw new Error("soft-hold: releaseAt must be a positive epoch");

  const now = Date.now();
  const heldAt = Number.isFinite(inp.heldAt) && (inp.heldAt as number) > 0 ? (inp.heldAt as number) : now;

  return mutate(async (list) => {
    // If an identical ACTIVE hold already exists for this deal+unit+window, return it untouched (idempotent).
    const live = list.find((h) => h.dealId === dealId && !h.released);
    if (live && live.unitId === unitId && live.buildingId === buildingId && live.releaseAt === inp.releaseAt) {
      return { next: list, ret: live };
    }

    // Release any prior active hold for this deal (the desk moved to a different unit, or re-opened).
    const next = list.map((h) =>
      h.dealId === dealId && !h.released
        ? { ...h, released: { by: desk, reason: "superseded", at: now }, updatedAt: now }
        : h
    );

    const base: Omit<SoftHold, "sealHash"> = {
      id: `hold-${now}-${randomBytes(3).toString("hex")}`,
      dealId,
      desk,
      buildingId,
      unitId,
      heldAt,
      releaseAt: inp.releaseAt,
      salt: newSalt(),
      at: now,
      updatedAt: now,
    };
    const record: SoftHold = { ...base, sealHash: holdDigest(base as SoftHold) };
    next.push(record);
    return { next, ret: record };
  });
}

/** Release a deal's active soft-hold (auto-release fired, or the deal closed/moved). Keeps the record as a
 *  tombstone. Does NOT re-seal (the original attestation stays verifiable). Returns the released record, or null
 *  if the deal has no active hold. `reason` is a short plain tag (e.g. "expired-l1", "deal-closed"). */
export async function releaseHold(dealId: string, by: string, reason: string): Promise<SoftHold | null> {
  const id = dealId.trim();
  return mutate(async (list) => {
    const idx = list.findIndex((h) => h.dealId === id && !h.released);
    if (idx < 0) return { next: list, ret: null };
    const released: SoftHold = { ...list[idx], released: { by: by.trim(), reason: reason.trim() || "released", at: Date.now() }, updatedAt: Date.now() };
    const next = [...list];
    next[idx] = released;
    return { next, ret: released };
  });
}

/** The ACTIVE (un-released) soft-hold for a deal, if any. There is at most one; newest wins defensively. */
export async function activeHoldForDeal(dealId: string): Promise<SoftHold | null> {
  const id = dealId.trim();
  const active = (await readAll()).filter((h) => h.dealId === id && !h.released).sort((a, b) => b.heldAt - a.heldAt);
  return active[0] ?? null;
}

/** Is this unit currently soft-held by ANY live deal? (used so open_unit doesn't double-hold a unit another
 *  deal already took). Compares building+unit across all active, non-expired-by-releaseAt holds. `asOf` lets a
 *  test/evaluator pin the moment; defaults to now. */
export async function unitSoftHeld(buildingId: string, unitId: string, asOf = Date.now()): Promise<boolean> {
  const b = lc(buildingId);
  const u = lc(unitId);
  return (await readAll()).some(
    (h) => !h.released && h.releaseAt > asOf && lc(h.buildingId) === b && lc(h.unitId) === u
  );
}

/** Every ACTIVE hold whose releaseAt is on/before `asOf` — the slice-7 auto-release evaluator's candidate set
 *  (holds that have reached their deadline). Newest-held first. Pure read; the evaluator decides what to do. */
export async function expiredActiveHolds(asOf = Date.now()): Promise<SoftHold[]> {
  return (await readAll())
    .filter((h) => !h.released && h.releaseAt <= asOf)
    .sort((a, b) => b.heldAt - a.heldAt);
}

/** The PUBLIC projection of a hold — strips the salt so it's never served. The sealHash stays. */
export function publicHold(h: SoftHold): Omit<SoftHold, "salt"> {
  const { salt: _salt, ...rest } = h;
  void _salt;
  return rest;
}

/** TEST-ONLY reset (the store is cwd-scoped via DATA_DIR; tests chdir to a temp dir). */
export async function __resetForTests(): Promise<void> {
  await writeAll([]);
}
