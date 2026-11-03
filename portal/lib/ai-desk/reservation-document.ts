// RESERVATION DOCUMENT — SERVER-ONLY (file-backed). Slice 3b-i,
// the design docs §0b. Ported CONCEPT from the operator catalog's pre-reservation
// ([[drt-reservation-pipeline-source-map]]) — VRX-native, NOT the operator catalog's DB.
//
// ── What this IS (the object the cluster was missing) ─────────────────────────────────────────────────────
// A paid, on-hold, terms-bearing record that sits BETWEEN a chat hold and a signed S&P — "a contract preview,
// not yet a contract". the operator catalog has had this for years (`pre_reservation`); we forgot it. It carries: unit identity
// + price + the DEDUCTIBLE deposit ([[vrx-deposit-is-deductible-not-a-fee]]) + the payment schedule + a
// PROPOSED signing/ratification date + buyer identity (off-chain, masked — the moat) + a REVISION number.
//
// ── What it REUSES vs what is NEW (the "build ON, don't reinvent" call) ──────────────────────────────
// It does NOT re-derive money. The unit/price/deposit/schedule are SNAPSHOTTED from the materialized direct
// `Offer` (lib/direct-offer — its sealed `DirectPlan`) + the HELD deposit (lib/direct-deposits). Those are the
// one money path shared with the S&P assembler ([[vrx-demo-vs-real-shared-path-audit]]); this record just
// composes + persists them into a named, buyer-facing document. What is genuinely NEW here (the state this
// object OWNS): the PROPOSED SIGNING DATE, its VRX-APPROVAL stamp, and the REVISION number.
//
// ── The signing-date rule (§0b — NOT a hard cap) ───────────────────────────────────────────────
// Buyer + seller each pick from their OWN options to find a MATCH; VRX APPROVES the agreed date (the honesty
// role). Default recommendation ≤ 14 WORKING days for buyer protection; extendable (~90 days) with approval.
// The real hard invariant is ORDERING (built in the next sub-slice): ratify the contract BEFORE the Land
// Office visit. This slice (3b-i) stores the PROPOSED date (default = +14 working days) + a vrxApproved stamp;
// the both-pick→match negotiation UI + the ratify-before-Land-Office enforcement are Slice 3b-ii/iii.
//
// ── Revisions (the operator catalog's `pre_reservation_revision` model) ─────────────────────────────────────────────────────
// A re-negotiation (terms change on re-materialize) BUMPS `revision` and keeps the prior as a snapshot in
// `history[]` (the operator catalog archives a JSON snapshot per revision; we keep them inline — small, bounded by negotiation
// rounds). The FIRST materialize is revision 1. An idempotent re-materialize with UNCHANGED terms does NOT bump
// (so a double-tap / replay is safe — mirrors materializeDirectOffer's idempotency).
//
// ── Privacy ──────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. Buyer identity is NOT stored here as PII — only the neutral buyer ACCOUNT ref (the S&P resolves
// the live desk-entitled mask at read time, like direct-offer.resolveDirectBuyerLine). Nothing here goes
// on-chain; the on-chain fact is the firm-hold the deposit already mirrors.
//
// ── Machine note ──────────────────────────────────────────────────────────────────────────────────────────
// Any seed .data/ai-reservation-documents.json must be written with the Write tool (clean UTF-8/LF), never a
// PowerShell here-string (BOM+CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { addWorkingDays } from "../payment-ledger";
import { materializeDirectOffer, type DirectPlan } from "../direct-offer";
import { depositsForBuyer } from "../direct-deposits";
import { deskDeveloperFor, dealEpoch } from "../conversations-direct";
import { directRequestId } from "../direct-offer";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "ai-reservation-documents.json");

/** Default proposed signing window (§0b): ≤ 14 WORKING days is the buyer-protection recommendation. */
export const DEFAULT_SIGNING_WORKING_DAYS = 14;
/** The extendable ceiling (§0b): VRX may approve a later date up to ~90 calendar days with approval. */
export const MAX_SIGNING_WORKING_DAYS = 90;
/** The deposit clock (§4): confirming STARTS a 2-hour window to pay, measured from the BUYER's tap
 *  (never the seller's offer). Expire ⇒ the confirmation lapses and the buyer must re-confirm to restart it. */
export const DEPOSIT_WINDOW_MS = 2 * 60 * 60 * 1000;

/** One line of the buyer-facing payment schedule (mirrors DirectPlan.schedule — the deductible deposit named). */
export type ReservationScheduleRow = { label: string; amountUsd: number };

/** A frozen prior revision of a reservation document (the operator catalog's per-revision JSON snapshot, kept inline). */
export type ReservationRevision = {
  revision: number;
  priceUsd: number;
  depositUsd: number;
  schedule: ReservationScheduleRow[];
  proposedSigningAt: number;
  at: number;
};

/**
 * The Reservation Document — one per RESERVED UNIT, keyed by (conversationId, unit), the paid-on-hold "contract
 * preview". It is distinct from (and precedes) the S&P. The money fields are a SNAPSHOT of the materialized offer
 * at the current revision; the signing date + approval + revision are this object's own state.
 *
 * ── Why the key is (conversationId, unit), not conversationId alone (the multi-unit fix) ────────────────
 * A buyer can firm-hold MULTIPLE units in one conversation (the deposit store already keys on (buyer, building,
 * unit) — two held units = two coexisting deposits; `issue_reservation` has always accepted a `unit` hint for
 * exactly this reason). A Reservation Document is inherently a PER-UNIT artifact (one unit/price/deposit/
 * schedule). Keying it on conversationId alone collapsed a 2nd reserved unit into a "terms change" of the
 * 1st — archiving unit #1 into history[] and making it vanish from the purchases tray. So the identity is
 * (conversationId, unit); a revision bump is reserved for a genuine terms change of the SAME unit.
 */
export type ReservationDocument = {
  /** The deal/conversation id (the key). */
  conversationId: string;
  /** The deal epoch at materialization (binds the doc to this engagement — a re-engaged deal gets a fresh doc). */
  epoch: number;
  /** The building this reservation is in (verbatim catalog id). */
  building: string;
  /** The unit being reserved (Unit.id). */
  unit: string;
  /** The buyer's neutral account ref (NOT PII — the S&P resolves the live mask at read time). */
  buyer: string;
  /** The desk developer that issued the reservation (provenance + the authorized author of the S&P). */
  developer: string;
  /** The portal offer requestId the money was snapshotted from (ties the doc to the sealed S&P source). */
  requestId: string;

  /** Live price at materialization (USD) — the same figure agencies get (direct-offer §2). */
  priceUsd: number;
  /** The DEDUCTIBLE deposit (USD) — deductible from the price, NEVER a VRX fee ([[vrx-deposit-is-deductible-not-a-fee]]). */
  depositUsd: number;
  /** The full payment schedule (deposit → on-contract → instalments → on-transfer), snapshotted from the plan. */
  schedule: ReservationScheduleRow[];

  /** The PROPOSED signing/ratification date (ms epoch). Default = +14 working days (buyer protection, §0b). */
  proposedSigningAt: number;
  /** VRX's approval stamp on the agreed signing date (the honesty/vetting role). Absent = not yet approved. */
  vrxApprovedAt?: number;

  /** When the buyer CONFIRMED the reservation (§4). Confirming carries NO money clock itself — it STARTS the
   *  2-hour deposit window (depositDueAt). Absent = not yet confirmed ("time to think"). */
  confirmedAt?: number;
  /** The deposit-window deadline (ms epoch) = confirmedAt + DEPOSIT_WINDOW_MS. Past this with no deposit, the
   *  confirmation has lapsed (pay is refused; the buyer re-confirms to restart). Absent until confirmed. */
  depositDueAt?: number;

  /** The current revision number (1 = first issue; bumps on a terms-changing re-materialize — the operator catalog model). */
  revision: number;
  /** Prior revisions, frozen snapshots (the operator catalog's per-revision archive, inline). Newest-last. */
  history: ReservationRevision[];

  /** ms epoch first issued. */
  at: number;
  /** ms epoch last updated (revision bump / approval). */
  updatedAt: number;
};

/** Locate a doc by its identity (conversationId, unit). When `unit` is omitted (back-compat for the
 *  single-doc callers), fall back to the sole/newest doc for the conversation — the newest by `.at` so a
 *  caller with no unit hint deterministically lands on the most recent reservation in that deal. Returns the
 *  index into `list`, or -1 if none. */
function findDocIndex(list: ReservationDocument[], conversationId: string, unit?: string): number {
  if (unit) return list.findIndex((d) => d.conversationId === conversationId && d.unit === unit);
  // No unit given → the newest doc for this conversation (there may be several).
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].conversationId !== conversationId) continue;
    if (best < 0 || list[i].at > list[best].at) best = i;
  }
  return best;
}

// ── Store IO (serialized via a promise chain — mirrors deal-sidecar / direct-deposits) ──────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: ReservationDocument[]) => { next: ReservationDocument[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<ReservationDocument[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReservationDocument[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: ReservationDocument[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** The money subset of a plan the doc snapshots (deposit named, price, schedule). PURE. */
function planToMoney(plan: DirectPlan): { priceUsd: number; depositUsd: number; schedule: ReservationScheduleRow[] } {
  return {
    priceUsd: Math.round(plan.priceUsd),
    depositUsd: Math.round(plan.depositUsd ?? 0),
    schedule: (plan.schedule ?? []).map((r) => ({ label: r.label, amountUsd: Math.round(r.amountUsd) })),
  };
}

/** Do two snapshots carry the SAME terms? (a re-materialize with identical terms must NOT bump the revision). */
function sameTerms(
  a: { priceUsd: number; depositUsd: number; schedule: ReservationScheduleRow[] },
  b: { priceUsd: number; depositUsd: number; schedule: ReservationScheduleRow[] }
): boolean {
  if (a.priceUsd !== b.priceUsd || a.depositUsd !== b.depositUsd) return false;
  if (a.schedule.length !== b.schedule.length) return false;
  return a.schedule.every((r, i) => r.label === b.schedule[i].label && r.amountUsd === b.schedule[i].amountUsd);
}

export type MaterializeReservationResult =
  | { ok: true; doc: ReservationDocument; created: boolean; bumped: boolean }
  | { ok: false; reason: "no_held_reservation" | "no_desk" | "offer_failed" };

/**
 * Materialize (or revise) the Reservation Document for a deal. The buyer must have a HELD deposit in this
 * building (the Reserve→bridge path) — that IS the "paid, on-hold" fact this document papers. We snapshot the
 * money from the materialized direct Offer (idempotent, the one money path) + default a proposed signing date
 * (+14 working days). Revision model:
 *   - no existing doc        → create revision 1 (created:true).
 *   - existing, SAME terms    → return untouched (created:false, bumped:false) — replay/double-tap safe.
 *   - existing, CHANGED terms → archive the current snapshot to history[], bump revision, update (bumped:true).
 * Fails closed with a reason (never fabricates against a unit that isn't held / a building with no desk).
 */
export async function materializeReservationDocument(args: {
  conversationId: string;
  buyer: string;
  building: string;
  /** The specific unit being reserved (the one the Reserve chip holds). When given, we require THAT unit be
   *  held for this buyer — deterministic even when the buyer has multiple holds in the building (the wrong-unit
   *  bug class this spine exists to kill). Absent → the sole / newest held unit (back-compat). */
  unit?: string;
}): Promise<MaterializeReservationResult> {
  const conversationId = args.conversationId.trim();
  const buyer = args.buyer.trim().toLowerCase();
  const building = args.building.trim();
  const wantUnit = args.unit?.trim() || "";

  // The reserved unit = the buyer's HELD deposit in this building (never a client-supplied unit for the MONEY —
  // we still re-verify it's genuinely held; the hint only disambiguates WHICH held unit this deal papers).
  const myHolds = (await depositsForBuyer(buyer)).filter((d) => d.building === building && d.status === "held");
  const held = wantUnit ? myHolds.find((d) => d.unit === wantUnit) : myHolds[0];
  if (!held) return { ok: false, reason: "no_held_reservation" };

  const developer = await deskDeveloperFor(building);
  if (!developer) return { ok: false, reason: "no_desk" };

  // Snapshot the money from the materialized offer (the sealed S&P source; idempotent per (conversationId, epoch)).
  const mat = await materializeDirectOffer({ conversationId, buyer, building, unit: held.unit, by: developer });
  if (!mat.ok) return { ok: false, reason: "offer_failed" };
  // materializeDirectOffer always seals a DirectPlan (or the minimal { priceUsd }) — OfferSeal.plan is typed
  // `unknown | null` for the generic offer path, so narrow it here; planToMoney guards the minimal shape.
  const money = planToMoney((mat.offer.seal.plan ?? { priceUsd: 0 }) as DirectPlan);
  const epoch = await dealEpoch(conversationId);
  const requestId = directRequestId(conversationId, epoch);

  type OkRet = { ok: true; doc: ReservationDocument; created: boolean; bumped: boolean };
  return mutate<OkRet>((list) => {
    const now = Date.now();
    // Identity is (conversationId, unit) — a 2nd reserved unit in the same deal is a NEW doc, not a
    // revision of the 1st. A revision bump is reserved for a terms change of THIS same unit.
    const idx = findDocIndex(list, conversationId, held.unit);

    if (idx < 0) {
      const created: ReservationDocument = {
        conversationId,
        epoch,
        building,
        unit: held.unit,
        buyer,
        developer,
        requestId,
        ...money,
        proposedSigningAt: addWorkingDays(now, DEFAULT_SIGNING_WORKING_DAYS),
        revision: 1,
        history: [],
        at: now,
        updatedAt: now,
      };
      return { next: [...list, created], ret: { ok: true as const, doc: created, created: true, bumped: false } };
    }

    const prev = list[idx];
    // Idempotent: same terms → no bump (replay/double-tap safe).
    if (sameTerms(prev, money)) {
      return { next: list, ret: { ok: true as const, doc: prev, created: false, bumped: false } };
    }
    // Terms changed → archive the current snapshot, bump the revision (the operator catalog's revision model). The proposed
    // signing date is CARRIED forward (a terms change doesn't reset a date the parties already negotiated);
    // the VRX approval, however, is CLEARED (new terms must be re-approved).
    const archived: ReservationRevision = {
      revision: prev.revision,
      priceUsd: prev.priceUsd,
      depositUsd: prev.depositUsd,
      schedule: prev.schedule,
      proposedSigningAt: prev.proposedSigningAt,
      at: prev.updatedAt,
    };
    const updated: ReservationDocument = {
      ...prev,
      unit: held.unit,
      developer,
      requestId,
      ...money,
      revision: prev.revision + 1,
      history: [...prev.history, archived],
      updatedAt: now,
    };
    delete updated.vrxApprovedAt; // new terms ⇒ re-approval required
    const next = [...list];
    next[idx] = updated;
    return { next, ret: { ok: true as const, doc: updated, created: false, bumped: true } };
  });
}

/** Read one reserved unit's Reservation Document (null if none issued yet). PURE read — the buyer reads their
 * own. Pass `unit` to target a specific reserved unit when the deal has several; omit it for the
 *  sole/newest doc in the conversation (back-compat). */
export async function getReservationDocument(conversationId: string, unit?: string): Promise<ReservationDocument | null> {
  const id = conversationId.trim();
  if (!id) return null;
  const u = unit?.trim() || undefined;
  const list = await readAll();
  const idx = findDocIndex(list, id, u);
  return idx < 0 ? null : list[idx];
}

/**
 * EVERY Reservation Document a buyer holds, across all their deals (newest-issued first) — the backing read for
 * the buyer "My purchases" tray ([[vrx-buyer-purchases-tray]]). The store already carries the buyer ref on
 * each record, so this is a plain owner-scoped filter (no join through conversations). PURE read: a buyer reads
 * their OWN reservations; the ROUTE enforces that `buyer` is the authenticated caller (same posture as
 * depositsForBuyer — the store is not an authz boundary).
 */
export async function reservationDocumentsForBuyer(buyer: string): Promise<ReservationDocument[]> {
  const b = buyer.trim().toLowerCase();
  if (!b) return [];
  return (await readAll()).filter((d) => d.buyer === b).sort((a, c) => c.at - a.at);
}

/**
 * Propose a signing date for a reserved unit's reservation (the buyer or desk picks a date; the both-pick→match
 * negotiation UI is Slice 3b-ii — this is the write primitive). Clamps to [now, now + MAX working days]; a
 * change CLEARS any prior VRX approval (a new date must be re-approved). Returns the updated doc, or null if
 * no document / the date is invalid.
 */
export async function proposeSigningDate(conversationId: string, atMs: number, unit?: string): Promise<ReservationDocument | null> {
  const id = conversationId.trim();
  const when = Number(atMs);
  if (!id || !Number.isFinite(when)) return null;
  const u = unit?.trim() || undefined;
  return mutate((list) => {
    const idx = findDocIndex(list, id, u);
    if (idx < 0) return { next: list, ret: null as ReservationDocument | null };
    const now = Date.now();
    const ceiling = addWorkingDays(now, MAX_SIGNING_WORKING_DAYS);
    const clamped = Math.min(Math.max(when, now), ceiling);
    const prev = list[idx];
    if (clamped === prev.proposedSigningAt) return { next: list, ret: prev }; // no-op
    const updated: ReservationDocument = { ...prev, proposedSigningAt: clamped, updatedAt: now };
    delete updated.vrxApprovedAt; // a date change needs re-approval
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/**
 * VRX approves the agreed signing date (the vetting/honesty role, §0b). Idempotent + monotonic (keeps the first
 * approval time). Returns the updated doc, or null if no document. The caller (a VRX-root / desk route) is the
 * authority — this store only records the stamp.
 */
export async function approveSigningDate(conversationId: string, unit?: string): Promise<ReservationDocument | null> {
  const id = conversationId.trim();
  if (!id) return null;
  const u = unit?.trim() || undefined;
  return mutate((list) => {
    const idx = findDocIndex(list, id, u);
    if (idx < 0) return { next: list, ret: null as ReservationDocument | null };
    const prev = list[idx];
    const approvedAt = prev.vrxApprovedAt ?? Date.now();
    const updated: ReservationDocument = { ...prev, vrxApprovedAt: approvedAt, updatedAt: Date.now() };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/**
 * The buyer CONFIRMS the reservation (§4, Slice 3b-ii). This is the "time to think" → "now I commit" step:
 * it carries NO money itself, but STARTS the 2-hour deposit window (depositDueAt = now + DEPOSIT_WINDOW_MS),
 * measured from THIS tap (the buyer's), never the seller's offer. Re-confirming RESTARTS the clock (e.g. after
 * a lapse) — idempotent only in that it always yields a fresh window from the latest confirm. Returns the
 * updated doc, or null if no document exists (a reservation must be issued first).
 */
export async function confirmReservation(conversationId: string, unit?: string): Promise<ReservationDocument | null> {
  const id = conversationId.trim();
  if (!id) return null;
  const u = unit?.trim() || undefined;
  return mutate((list) => {
    const idx = findDocIndex(list, id, u);
    if (idx < 0) return { next: list, ret: null as ReservationDocument | null };
    const now = Date.now();
    const prev = list[idx];
    const updated: ReservationDocument = {
      ...prev,
      confirmedAt: now,
      depositDueAt: now + DEPOSIT_WINDOW_MS,
      updatedAt: now,
    };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** The live state of the deposit window for a doc. PURE (takes `now` for testability). "open" = confirmed and
 *  still within the 2h window (pay allowed); "lapsed" = confirmed but the window passed (re-confirm needed);
 *  "unconfirmed" = never confirmed. `msLeft` is the remaining window when open (0 otherwise). */
export function depositWindowState(
  doc: Pick<ReservationDocument, "confirmedAt" | "depositDueAt">,
  now: number = Date.now()
): { state: "unconfirmed" | "open" | "lapsed"; msLeft: number } {
  if (!doc.confirmedAt || !doc.depositDueAt) return { state: "unconfirmed", msLeft: 0 };
  if (now <= doc.depositDueAt) return { state: "open", msLeft: doc.depositDueAt - now };
  return { state: "lapsed", msLeft: 0 };
}

/**
 * The RATIFY-BEFORE-LAND-OFFICE ordering invariant (§4, — the real hard rule, not the 14-day cap).
 * A Land-Office handover / title step may only proceed once the signing date has been VRX-APPROVED (ratified).
 * PURE guard the (future) handover step calls; returns the honest blocking reason when not yet ratified. We
 * encode + export it now so the ordering is a single source of truth the moment the handover surface is built.
 */
export function mayProceedToLandOffice(
  doc: Pick<ReservationDocument, "vrxApprovedAt">
): { ok: true } | { ok: false; reason: "signing_not_ratified" } {
  return doc.vrxApprovedAt ? { ok: true } : { ok: false, reason: "signing_not_ratified" };
}

/** TEST-ONLY reset (the store is cwd-scoped via DATA_DIR; tests chdir to a temp dir). */
export async function __resetForTests(): Promise<void> {
  await writeAll([]);
}
