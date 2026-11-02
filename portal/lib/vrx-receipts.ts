// VRX RECEIPTS — the "VRX got paid its protocol fee" attested-fact store ( §3c/§4b, the enforcement arc,
// ── The gap this closes ─────────────────────────────────────────────────────────────────────────────────
// The §3c developer-standing resolver (lib/dev-standing.resolveDeveloperStanding) takes, per VRX obligation,
// a `paid: boolean` — "has VRX actually been paid its protocol fee for this unit?". NOTHING produced that
// fact: the §3b clock (lib/payment-ledger.resolveVrxClock, surfaced on earmark's VrxLine) tells us when the
// can't observe its own receipt on-chain, so — exactly like Rail B for customer→developer payments (§4b) —
// "VRX got paid" is a MANUALLY-ATTESTED VRX-side fact. This module is that store; it is what turns the
// standing resolver from a hypothetical (`paid` always passed in) into something driven by real receipts.
// ── Grain: per UNIT, not per deal ───────────────────────────────────────────────────────────────────────
// The §3b VRX fee is earned when a UNIT leaves `available` (resolveVrxClock anchors on
// lib/status-ledger.leftAvailableAt, keyed by (buildingId, unitId)). So one fee obligation = one unit-exit,
// and a receipt is keyed the SAME way: (developer, buildingId, unitId). A `requestId` join is recorded when
// known (mirrors PaymentRecord) but is NOT the key — the obligation grain is the unit, matching the clock.
// ── A attested record (not a new primitive) ────────────────────────────────────────────────────────
// Each receipt is the Nth consumer of lib/seal.ts: plaintext (who/what/amount/date/method) + a per-record
// secret salt + a sealHash that re-hashes to ✓Vetted. Same spine as offers/agreements/payments — no
// parallel seal. The seal is VRX's attestation: "VRX received its protocol fee of $X for unit U on date D".
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. The fee amount is a B2B VRX↔developer figure (not customer PII, but still off-chain + never
// on the buyer's S&P, nothing on-chain). The public projection strips the salt.: no amount/field
// leaks to any non-party surface; surfaces say "Protocol fee paid" in plain words.
// ── Machine note ────────────────────────────────────────────────────────────────────────────────────────
// Any SEED `.data/vrx-receipts.json` must be written with the Write tool (clean UTF-8/LF) — NEVER a
// PowerShell Set-Content/here-string (BOM + CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { digest, newSalt } from "./seal";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "vrx-receipts.json");

/** The seal domain tag for VRX fee receipts (PUBLIC namespace; the SECRET is the per-record salt). */
const RECEIPT_DOMAIN = "vrx-receipt";

/** How VRX was paid its protocol fee for a unit. "on_rail" is reserved for the future in-app TAKE (frozen
 * today) where the transfer is self-proving; until then receipts are manually attested. */
export type ReceiptMethod = "bank_transfer" | "cash" | "offset" | "on_rail" | "other";

/** One attested fact that VRX received its protocol fee for ONE unit. Keyed by (developer, buildingId, unitId)
 * — the §3b obligation grain. At most one ACTIVE (un-voided) receipt per unit; re-recording replaces it. */
export type VrxReceipt = {
  /** Opaque record id. */
  id: string;
  /** The developer who paid VRX (the party whose standing this clears). */
  developer: string;
  buildingId: string;
  unitId: string;
  /** Join to the offer/deal when known (mirrors PaymentRecord.requestId) — informational, NOT the key. */
  requestId?: string;
  /** The protocol fee VRX received for this unit (USD). B2B figure. */
  amountUsd: number;
  /** ms epoch VRX RECEIVED the fee (not when it was logged). This is what the standing resolver treats as the
   * settle moment — a receipt dated on/before an obligation's dueAt clears it. */
  paidAt: number;
  method: ReceiptMethod;
  note?: string;
  /** VOIDED receipts (a mistaken/reversed attestation) are kept for audit but no longer count as `paid`.
   * A void does NOT re-seal (the original attestation stays verifiable); it flips this flag + records who/why. */
  voided?: { by: string; reason?: string; at: number };
  /** spine: per-record secret salt — NEVER served, NEVER on-chain. */
  salt: string;
  /** SHA-256 over domain|salt|stableStringify(the sealed payload) — the tamper-evident shared truth. */
  sealHash: string;
  /** ms epoch created / last mutated. */
  at: number;
  updatedAt: number;
};

/** The subset of a receipt that is SEALED. EXCLUDES salt + sealHash (the seal itself), the mutable
 * `voided` flag (a void happens AFTER the attestation and must not invalidate it), and the volatile
 * `updatedAt`. This is VRX's attestation: "VRX received $X for unit U on date D, by method M". */
export type ReceiptSealInput = {
  developer: string;
  buildingId: string;
  unitId: string;
  requestId?: string;
  amountUsd: number;
  paidAt: number;
  method: ReceiptMethod;
  note?: string;
  at: number;
};

/** Build the canonical seal payload (stable across reads — optional fields OMITTED when absent so a receipt
 * without a requestId/note hashes stably, never `undefined`-vs-missing divergence). */
function sealPayload(r: VrxReceipt): ReceiptSealInput {
  const p: ReceiptSealInput = {
    developer: r.developer,
    buildingId: r.buildingId,
    unitId: r.unitId,
    amountUsd: r.amountUsd,
    paidAt: r.paidAt,
    method: r.method,
    at: r.at,
  };
  if (r.requestId) p.requestId = r.requestId;
  if (r.note) p.note = r.note;
  return p;
}

/** Hash a receipt's canonical payload with the receipt domain + the record's salt → hex digest. */
export function receiptDigest(r: VrxReceipt): string {
  return digest(sealPayload(r) as unknown as Record<string, unknown>, RECEIPT_DOMAIN, r.salt);
}

/** The ✓ Vetted check: the stored plaintext + salt re-hash to the stored sealHash. false = tampered/lost-salt. */
export function verifyReceipt(r: VrxReceipt): boolean {
  if (!r.salt || !r.sealHash) return false;
  return receiptDigest(r) === r.sealHash;
}

// ── Store IO (mirrors payment-vault.ts: serialized via a promise chain so concurrent writes can't clobber) ──

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: VrxReceipt[]) => Promise<{ next: VrxReceipt[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<VrxReceipt[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VrxReceipt[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: VrxReceipt[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const lc = (s: string) => s.trim().toLowerCase();

/** Unit key for matching a receipt to an obligation — (developer, buildingId, unitId), case-normalised. */
function unitKey(developer: string, buildingId: string, unitId: string): string {
  return `${lc(developer)}|${lc(buildingId)}|${lc(unitId)}`;
}

/** Valid USD amount for a receipt: a finite number > 0 (never seal a nonsense amount). */
export function isValidAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────────

/** Input to record a VRX fee receipt. The route supplies `developer`/VRX-root authorisation — not the client. */
export type RecordReceiptInput = {
  developer: string;
  buildingId: string;
  unitId: string;
  requestId?: string;
  amountUsd: number;
  paidAt: number;
  method: ReceiptMethod;
  note?: string;
};

/**
 * Record (or replace) the VRX-got-paid fact for one unit. VRX-root-authored (the route gates it — only VRX
 * attests its own receipt). At most ONE active receipt per unit: re-recording the same unit REPLACES the prior
 * active receipt (the latest attestation wins; a correction is a new attestation, same durability rule as a
 * re-sealed agreement). Voided receipts are left in place for audit. Throws on a nonsense amount.
 */
export async function recordReceipt(input: RecordReceiptInput): Promise<VrxReceipt> {
  if (!isValidAmount(input.amountUsd)) throw new Error("vrx-receipt: amountUsd must be a positive number");
  const developer = input.developer.trim();
  const buildingId = input.buildingId.trim();
  const unitId = input.unitId.trim();
  if (!developer || !buildingId || !unitId) throw new Error("vrx-receipt: developer/buildingId/unitId required");

  const now = Date.now();
  const salt = newSalt();
  const base: Omit<VrxReceipt, "sealHash"> = {
    id: `rcpt-${now}-${randomBytes(3).toString("hex")}`,
    developer,
    buildingId,
    unitId,
    requestId: input.requestId?.trim() || undefined,
    amountUsd: input.amountUsd,
    paidAt: input.paidAt,
    method: input.method,
    note: input.note?.trim() || undefined,
    salt,
    at: now,
    updatedAt: now,
  };
  const sealHash = receiptDigest(base as VrxReceipt);
  const record: VrxReceipt = { ...base, sealHash };

  return mutate(async (list) => {
    // Drop any prior ACTIVE (un-voided) receipt for the same unit — the latest attestation is the live one.
    const key = unitKey(developer, buildingId, unitId);
    const next = list.filter((r) => !(r.voided == null && unitKey(r.developer, r.buildingId, r.unitId) === key));
    next.push(record);
    return { next, ret: record };
  });
}

/**
 * Void an active receipt (a mistaken / reversed attestation) by id. Keeps the record for audit but flips
 * `voided` so it no longer counts as paid. Does NOT re-seal (the original attestation stays verifiable).
 * Returns the voided record, or null if not found / already voided.
 */
export async function voidReceipt(id: string, by: string, reason?: string): Promise<VrxReceipt | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === id && r.voided == null);
    if (idx < 0) return { next: list, ret: null };
    const voided: VrxReceipt = {
      ...list[idx],
      voided: { by: by.trim(), reason: reason?.trim() || undefined, at: Date.now() },
      updatedAt: Date.now(),
    };
    const next = [...list];
    next[idx] = voided;
    return { next, ret: voided };
  });
}

/** All receipts (active + voided) for a developer — newest first. For a developer/VRX-root audit surface. */
export async function receiptsForDeveloper(developer: string): Promise<VrxReceipt[]> {
  const list = await readAll();
  const dev = lc(developer);
  return list.filter((r) => lc(r.developer) === dev).sort((a, b) => b.paidAt - a.paidAt);
}

/** The ACTIVE (un-voided) receipt for a unit, if any. The latest active attestation (there is at most one,
 * but we defend against a legacy store by taking the newest). */
export async function activeReceiptForUnit(
  developer: string,
  buildingId: string,
  unitId: string
): Promise<VrxReceipt | null> {
  const list = await readAll();
  const key = unitKey(developer, buildingId, unitId);
  const active = list
    .filter((r) => r.voided == null && unitKey(r.developer, r.buildingId, r.unitId) === key)
    .sort((a, b) => b.paidAt - a.paidAt);
  return active[0] ?? null;
}

/**
 * Has VRX been paid its protocol fee for this unit? The single fact the §3c standing resolver reads as
 * `paid`. True iff an ACTIVE receipt exists for the unit AND — when `dueAt` is supplied — it was received
 * on/before that due date (a receipt dated AFTER the obligation came due still clears it, so `dueAt` is an
 * optional tightening the caller passes only if it wants "paid on time"; standing only needs "paid at all").
 *
 * Standing cares about "paid at all" — a late-but-paid obligation is no longer overdue-unpaid, so it should
 * clear standing. So the default (no `dueAt`) is the right call for the resolver. `dueAt` exists for a future
 * "paid late" report, not to block clearing.
 */
export async function paidForUnit(
  developer: string,
  buildingId: string,
  unitId: string,
  opts?: { dueAt?: number }
): Promise<boolean> {
  const r = await activeReceiptForUnit(developer, buildingId, unitId);
  if (!r) return false;
  if (typeof opts?.dueAt === "number") return r.paidAt <= opts.dueAt;
  return true;
}

/** The PUBLIC projection of a receipt — strips the salt so it's never served. The sealHash stays
 * (it's the shared truth); a holder re-verifies with their stored salt. For any API that returns receipts. */
export function publicReceipt(r: VrxReceipt): Omit<VrxReceipt, "salt"> {
  const { salt: _salt, ...rest } = r;
  return rest;
}
