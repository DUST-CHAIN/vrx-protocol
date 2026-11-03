// Off-chain AGREEMENT registry — SERVER-ONLY (file-backed). The commission agreement, built as
// the SECOND consumer of the "Attested Off-Chain Records" spine (the design docs §1 — the
// offer store, lib/offers.ts, was the first). Same shape, deliberately: plaintext off-chain + a hash
// SEAL + re-hash to verify. One pattern, N consumers (the "scan for the reusable PATTERN").
//
// WHAT IT IS: the commission agreement between an AGENCY (contract: Org) and a DEVELOPER (contract: Node)
// the money half of the relationship that keeps OFF-chain (the chain never sees rates or amounts).
// The agency proposes "I sell your units for X% commission under these terms"; the developer agrees. Both
// parties hold the same plaintext; the SEAL (SHA-256 over the canonical fields) is the tamper-proof shared
// truth — anyone with the plaintext re-hashes it and proves it's unaltered since signing (✓ VETTED), or a
// loud mismatch flags tampering.
//
// ON-CHAIN STAMP — DESIGN NOW, BUILD LATER: a commission agreement is a trust-critical legal moment,
// so later it earns an on-chain stamp (a new contract method witnesses `sealHash`, exactly like a booking's
// request_hash). That needs a contract change, so it ships with the money/contract arc — the contract stays
// FROZEN now. We leave the room: `sealHash` is computed + stored today (the parties' shared seal), and an
// optional `onChainTx` field can record the witnessing txn when the stamp lands, with no schema break. So
// the agreement is a real, verifiable attested record TODAY (party-attested), and gains chain-witnessing
// later without a rewrite.
//
// Same file-backed.data pattern as offers.ts / gates.ts / channels.ts. The real architecture keeps
// each party's records on their own node; this .data store is the demo stand-in. The pattern is unchanged
// when it distributes — the seal is the shared truth, the plaintext each party's private copy.
//
// PRIVACY: server-side only; holds the plaintext deliberately (it's the parties' private copy). Only
// the two parties to an agreement may read it. The chain carries at most the opaque seal hash (when stamped).

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";
import { identityForSeal, getProfile, verifyProfile } from "./profiles";

/** The seal domain tag for agreements (public namespace; the SECRET is the per-record salt). */
const AGREEMENT_DOMAIN = "vrx-agreement";

// ── Shared commission-% validator (review fix #5) ────────────────────────────────────────────────
// ONE rule, used by the server (parseBuildings) AND exported for both clients, so the value QUOTED in the
// UI is exactly the value STORED/sealed. Before this, the server accepted 0 while the node UI rejected ≤0
// and the agency UI only checked isFinite — three rules for one sealed field, and Number("")→0 could seal
// a silent 0% agreement. A commission must be a real, finite percentage strictly above 0 and at most 100.
export const COMMISSION_MIN_EXCLUSIVE = 0;
export const COMMISSION_MAX = 100;

/** True iff `pct` is a valid commission percentage (finite, > 0, ≤ 100). The single source of truth. */
export function isValidCommissionPct(pct: unknown): pct is number {
  return typeof pct === "number" && Number.isFinite(pct) && pct > COMMISSION_MIN_EXCLUSIVE && pct <= COMMISSION_MAX;
}

/**
 * One building's terms within an agreement. An agreement is building-scoped and multi-building:
 * one agreement covers one or more buildings, each with its OWN commission snapshot + scope.
 */
export type AgreementBuilding = {
  /** Catalog building id (lib/catalog.ts) this clause covers. */
  buildingId: string;
  /** SNAPSHOT of the commission % agreed for THIS building, frozen at proposal. A later change to
   *  the building's default never rewrites a signed agreement — a rate change is a new agreement. */
  commissionPct: number;
  /** "whole" building, OR an explicit NON-EXCLUSIVE list of unit ids. Exclusivity is the separate
   *  mechanism — a unit list here does NOT lock other agencies out of those units. */
  scope: "whole" | { units: string[] };
  /** the AGENCY-commission UNLOCK threshold: % of the unit PRICE the developer must have RECEIVED
   *  from the customer before the agency's commission on that unit becomes PAYABLE. Developer-set, sealed
   *  exactly like `commissionPct` (part of what the agency agrees to at signing — no hidden payout rule).
   *  Optional for backward-compat: an agreement sealed before this field falls back to `unlockPct = the
   *  plan's deposit%` at read time (lib/payment-ledger, later), so a legacy agreement never silently blocks
   *  or over-pays. Since it rides in the seal (buildings is hashed wholesale), an ABSENT value hashes
 * identically to the record — legacy seals still re-verify. A change is a NEW agreement. */
  unlockPct?: number;
  /** the AGENCY unlock is an AND of a signed S&P AND the paid-% threshold. Defaults to
   *  TRUE semantically for the agency (a signed S&P is required alongside `unlockPct`); stored explicitly so
   *  a future per-building override ("% alone suffices") is expressible without a schema change. Absent =
   *  treat as true (signing required) — the safe default. VRX's own commission uses the §3b working-day
   *  clock instead, NOT this field. */
  unlockOnSigning?: boolean;
};

/** valid agency-unlock threshold: a finite % in [0, 100]. 0 is allowed (payable as soon as signed +
 *  any payment logic applies); >100 is nonsense. Distinct from isValidCommissionPct, which excludes 0 (a 0%
 *  commission is meaningless, but a 0% unlock threshold — "payable on signing, no paid-% required" — is a
 *  legitimate developer choice). */
export function isValidUnlockPct(pct: unknown): pct is number {
  return typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= COMMISSION_MAX;
}

/**
 * The verifiable identity SNAPSHOT of a party, auto-populated from the immutable KYC profile. Folded
 * into the seal so ✓ Vetted attests WHO agreed, not just WHAT. Omitted (undefined) when the party has no
 * profile yet — an honest absence, never a fabricated identity. The embedded `seal` lets a verifier re-hash
 * the identity against the party's profile independently (lib/profiles.ts verifyProfile).
 */
export type PartyIdentity = {
  legalName: string;
  region: string;
  role: "developer" | "agency" | "agent";
  /** The profile's own salt+hash so the identity itself is independently re-verifiable. */
  seal: { salt: string; hash: string };
};

/**
 * The CANONICAL seal inputs — these fields, in this shape, ARE the agreement. Re-hashing this object with
 * the same domain ("vrx-agreement") + stableStringify + the record's salt reproduces `sealHash`.
 * Keep it minimal + verbatim: display extras ride alongside in the record but are NOT part of the seal.
 */
export type AgreementSeal = {
  /** The agency (Org) account — the selling party. */
  agency: string;
  /** The developer (Node) account — the inventory owner. */
  developer: string;
  /** Per-building terms. One or more buildings, each with its own snapshotted commission + scope. */
  buildings: AgreementBuilding[];
  /** Free-text terms that span the whole agreement (payment milestones, duration) — building-agnostic. */
  terms: string;
  /** Who proposed it — "agency" or "developer" (the side that signed first). */
  by: "agency" | "developer";
  /** ms epoch the proposing party set at creation — part of the seal so each agreement is unique. */
  proposedAt: number;
  /** the two parties' immutable-profile identity snapshots, auto-populated at proposal. Optional so
   *  a party without a vetted profile still produces a valid (identity-less) seal. */
  agencyIdentity?: PartyIdentity;
  developerIdentity?: PartyIdentity;
};

// Lifecycle of an agreement (off-chain; the chain isn't involved until the stamp lands). The three
//  origination modes map onto these states:
//   Mode 1 (developer→agency direct)  : proposed(by developer, agency named) → agreed/declined by agency.
//   Mode 2 (developer publishes→joins): published(by developer, agency="")   → a vetted agency JOINS →
//                                       agreed (the agency accepts the published terms AS-IS; it does NOT
//                                       set any commission — join ≠ counter-offer). Developer still gates
//                                       access separately ("set availability"); join ≠ live.
//   Mode 3 (agency→developer, 2ndary) : proposed(by agency, developer named) → agreed/declined by developer.
export type AgreementStatus = "published" | "proposed" | "agreed" | "declined" | "revoked";

/** The full stored agreement: the canonical seal inputs + the seal + lifecycle + optional chain witness. */
export type Agreement = {
  /** Opaque unique id (the store key). */
  id: string;
  /** The canonical hash-input object (verbatim, for exact re-hash). */
  seal: AgreementSeal;
  /** Per-record secret salt — mixed into the digest so a low-entropy agreement isn't precomputable.
   *  Stored only in this party-private record, NEVER on-chain. Lose it and the record stops re-verifying. */
  salt: string;
  /** The seal: SHA-256 over domain|salt|stableStringify(seal). The shared tamper-proof truth. */
  sealHash: string;
  /** Lifecycle. "proposed" by one party → the other "agreed"/"declined"; either may later "revoke". */
  status: AgreementStatus;
  /** The account that last moved the lifecycle (for the audit trail). */
  lastBy?: string;
  /** Mutual-revoke seam: the party that REQUESTED termination of an agreed agreement. The other party
   *  must confirm (mutualRevoke) before status becomes "revoked" — neither side can end it alone. */
  revokeRequestBy?: string;
  /** seam: the txn hash that witnessed `sealHash` on-chain, once the stamp method exists. undefined today. */
  onChainTx?: string;
  /** ms epoch created. */
  at: number;
  /** ms epoch last updated. */
  updatedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "agreements.json");

async function readAll(): Promise<Agreement[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Agreement[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Agreement[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as activity.ts/events.ts. Without
// this, two agreement moves at once (e.g. a developer accepting while an agency joins) race: both readAll
// the old list and the second writeAll drops the first's change. All mutators go through mutate.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: Agreement[]) => { next: Agreement[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * ROOT-SCOPE: every agreement, newest first. The God's-eye read for the VRX root relationships dashboard
 * — root is NOT a party to any agreement, so it can't use agreementsForParty/getAgreement (those
 * fail the party-auth on purpose). This reader exists ONLY for the operator-gated /api/root endpoint;
 * never expose it on a party-facing route (it would leak every pair's private relationship). Returned
 * records still get salt-stripped by publicAgreement at the API boundary (the salt never leaves the
 * server, fix #1).
 */
export async function listAllAgreements(): Promise<Agreement[]> {
  return (await readAll()).sort((a, b) => b.at - a.at);
}

// ── Expiry ──────────────────────────────────────────────────────────────────────────────────
// Agreement terms are free-text (e.g. "...Non-exclusive, 12 months."). The dashboard derives a best-effort
// expiry so the human team can remind BOTH parties ahead of it (: ~2 months ahead, both sides). This
// is a READ-TIME convenience, never sealed — a duration the parse can't find is reported honestly as
// "not stated" rather than guessed. Expiry is measured from when the agreement went LIVE (agreed), which
// is why the caller passes the base timestamp (updatedAt at agree-time for an agreed record).

/** How far ahead of expiry the team should start reminding both parties: ~2 months. */
export const EXPIRY_REMINDER_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Best-effort parse of a duration out of free-text terms → number of months, or null if none stated.
 * Handles "12 months", "1 year", "18 month", "2 yrs", "12-month". Years → ×12. First match wins.
 */
export function parseDurationMonths(terms: string): number | null {
  if (!terms) return null;
  const m = terms.match(/(\d+(?:\.\d+)?)[\s-]*(month|months|mo|year|years|yr|yrs)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const isYear = /^y/i.test(m[2]);
  return isYear ? Math.round(n * 12) : Math.round(n);
}

export type ExpiryInfo = {
  /** Months parsed from terms, or null if the terms don't state a duration. */
  months: number | null;
  /** ms epoch the agreement expires, or null when months is null / the agreement isn't live yet. */
  expiresAt: number | null;
  /** True iff live, dated, and within the reminder window (≤ EXPIRY_REMINDER_MS away) — nudge both sides. */
  expiringSoon: boolean;
  /** True iff the computed expiry is already in the past. */
  expired: boolean;
};

/**
 * Compute an agreement's expiry picture for the dashboard. Only an AGREED agreement has a live clock;
 * anything else (published/proposed/declined/revoked) has no running term. `now` is injectable for tests.
 */
export function agreementExpiry(g: Agreement, now = Date.now()): ExpiryInfo {
  const months = parseDurationMonths(g.seal.terms);
  // The term runs from when it went live. For an agreed record updatedAt is the agree moment; fall back
  // to `at` (creation) so a record missing a clean agree-stamp still yields a stable, if slightly early, date.
  const base = g.status === "agreed" ? g.updatedAt || g.at : 0;
  if (g.status !== "agreed" || months == null || !base) {
    return { months, expiresAt: null, expiringSoon: false, expired: false };
  }
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  const expiresAt = d.getTime();
  return {
    months,
    expiresAt,
    expired: now >= expiresAt,
    expiringSoon: now < expiresAt && expiresAt - now <= EXPIRY_REMINDER_MS,
  };
}

/** All agreements involving a party (as agency OR developer), newest first. Case-insensitive match. */
export async function agreementsForParty(account: string): Promise<Agreement[]> {
  const a = account.trim().toLowerCase();
  return (await readAll())
    .filter((g) => g.seal.agency.toLowerCase() === a || g.seal.developer.toLowerCase() === a)
    .sort((x, y) => y.at - x.at);
}

/** One agreement by id, or null. */
export async function getAgreement(id: string): Promise<Agreement | null> {
  const key = id.trim();
  if (!key) return null;
  return (await readAll()).find((g) => g.id === key) ?? null;
}

/** True iff `account` is a party (agency or developer) to agreement `g`. Case-insensitive. */
export function isPartyTo(g: Agreement, account: string): boolean {
  const a = account.trim().toLowerCase();
  if (!a) return false;
  return g.seal.agency.toLowerCase() === a || g.seal.developer.toLowerCase() === a;
}

// ── Public projection (review fix #1) ────────────────────────────────────────────────────────────
// A party's record is safe to serve BUT the per-record `salt` (secret) is NOT — serving it hands an
// attacker the one value that makes a low-entropy seal precomputable, defeating the whole point of.
// So every GET returns this projection: the full record MINUS salt, PLUS the re-hash result. (Profiles
// already do the equivalent via publicProfile; agreements were spreading the raw record — the leak.)
export type PublicAgreement = Omit<Agreement, "salt"> & { verified: boolean };

/** Strip the secret salt and attach the ✓ Vetted result. The ONLY shape an endpoint should return. */
export async function publicAgreement(g: Agreement): Promise<PublicAgreement> {
  const verified = await verifyAgreement(g);
  // Destructure salt out; keep everything else (incl. seal.*Identity + sealHash the UI reads).
  const { salt: _salt, ...rest } = g;
  void _salt;
  return { ...rest, verified };
}

/**
 * The DURABILITY guard, server-side (review fix #2 — was UI-only, and the agency Mode-3 propose path
 * had no guard at all). A new agreement must NOT be created between two parties who already have a LIVE one
 * (proposed OR agreed) — that is how new terms could be slipped over a signed, durable agreement.
 * Returns the existing live agreement if one exists, else null. (published has no named agency yet, so it
 * can't collide; revoked/declined are dead and may be superseded by a fresh proposal.)
 */
export async function liveAgreementBetween(
  developer: string,
  agency: string
): Promise<Agreement | null> {
  const dev = developer.trim().toLowerCase();
  const ag = agency.trim().toLowerCase();
  if (!dev || !ag) return null;
  return (
    (await readAll()).find(
      (g) =>
        (g.status === "proposed" || g.status === "agreed") &&
        g.seal.developer.toLowerCase() === dev &&
        g.seal.agency.toLowerCase() === ag
    ) ?? null
  );
}

// ── Verification (the re-hash that produces the ✓ VETTED seal) ──────────────────────────────────────
// The salted digest + verify live in lib/seal.ts (the primitive) — one implementation, no local
// copy of stableStringify/createHash. The per-record salt is what makes a low-entropy agreement (round
// commission %, short terms) non-precomputable by a rainbow table.

/** The canonical seal payload — the exact object that gets hashed. Kept minimal + verbatim. Optional
 *  identity fields are omitted when absent so an identity-less agreement hashes stably (stableStringify
 * drops undefined). Folding identities in means ✓ Vetted attests WHO as well as WHAT. */
function sealPayload(seal: AgreementSeal): Record<string, unknown> {
  const p: Record<string, unknown> = {
    agency: seal.agency,
    developer: seal.developer,
    buildings: seal.buildings,
    terms: seal.terms,
    by: seal.by,
    proposedAt: seal.proposedAt,
  };
  if (seal.agencyIdentity !== undefined) p.agencyIdentity = seal.agencyIdentity;
  if (seal.developerIdentity !== undefined) p.developerIdentity = seal.developerIdentity;
  return p;
}

/** Hash the canonical seal inputs with the agreement domain + the record's secret salt → hex digest. */
export function agreementDigest(seal: AgreementSeal, salt: string): string {
  return digest(sealPayload(seal), AGREEMENT_DOMAIN, salt);
}

/** True iff the stored plaintext + salt re-hash to the stored sealHash — the ✓ VETTED check. */
export async function verifyAgreement(g: Agreement): Promise<boolean> {
  try {
    if (!g.salt) return false; // no salt → can't re-verify (lost-salt / legacy record)
    if (agreementDigest(g.seal, g.salt) !== g.sealHash) return false;
    //  review fix #4: the agreement seal matching proves the terms + the EMBEDDED identity blobs are
    // unaltered — but NOT that those identities still match the live KYC profiles. Re-verify each embedded
    // identity against its live profile so ✓ Vetted means "terms AND identities current", not just "the
    // blob we froze is intact". A party whose profile was later root-corrected (new salt/hash) must no
    // longer show ✓ Vetted on an agreement carrying the stale snapshot.
    return await identitiesMatchLiveProfiles(g.seal);
  } catch {
    return false;
  }
}

/**
 * fix #4. For each party identity folded into the seal, confirm the embedded `{salt,hash}` still
 * matches that account's CURRENT profile. An identity-less agreement (no profile at seal time) passes — it
 * made no identity claim to break. A snapshot that no longer matches the live profile FAILS (loud, not a
 * silent ✓). This is the independent cross-check the embedded seal was always meant to enable.
 */
async function identitiesMatchLiveProfiles(seal: AgreementSeal): Promise<boolean> {
  for (const [account, snapshot] of [
    [seal.developer, seal.developerIdentity],
    [seal.agency, seal.agencyIdentity],
  ] as const) {
    if (!snapshot) continue; // no identity claim for this party → nothing to contradict
    const live = await getProfile(account);
    if (!live) return false; // claimed an identity that no longer exists
    // The live profile must itself verify AND its seal must equal the frozen snapshot's seal
    // (profiles.ts stores the identity seal as {salt, identityHash}; the snapshot mirrors it as seal.hash).
    if (!verifyProfile(live)) return false;
    if (live.salt !== snapshot.seal.salt || live.identityHash !== snapshot.seal.hash) return false;
  }
  return true;
}

// Auto-populate a party's KYC identity snapshot into the seal. Returns undefined for an unvetted or
// absent account — an honest "no identity claim", never a fabricated one. Kept here so propose/join share it.
async function identitySnapshot(account: string): Promise<PartyIdentity | undefined> {
  if (!account) return undefined;
  const id = await identityForSeal(account);
  if (!id) return undefined;
  return { legalName: id.legalName, region: id.region, role: id.role, seal: id.seal };
}

// Seal a seal object with a fresh salt → {salt, sealHash}. Used by propose/join (each produces a final
// two-party sealed truth; a join re-seals because the payload gains the agency's identity).
function seAl(seal: AgreementSeal): { salt: string; sealHash: string } {
  const salt = newSalt();
  return { salt, sealHash: agreementDigest(seal, salt) };
}

/**
 * Create an agreement. Server computes the salted seal (the server is the attesting authority until the
 * on-chain stamp lands). Auto-populates both parties' KYC identities when they exist.
 *
 * Mode selection by the seal's `by` + whether `agency` is named:
 *  - by:"developer", agency NAMED  → Mode 1 direct offer → status "proposed" (agency agrees/declines).
 *  - by:"developer", agency EMPTY  → Mode 2 PUBLISH → status "published" (a vetted agency later joins).
 *  - by:"agency"                   → Mode 3 agency pitches a named developer → "proposed" (dev agrees).
 */
export async function proposeAgreement(seal: AgreementSeal): Promise<Agreement> {
  const now = Date.now();
  const developerIdentity = await identitySnapshot(seal.developer);
  const agencyIdentity = seal.agency ? await identitySnapshot(seal.agency) : undefined;
  const fullSeal: AgreementSeal = { ...seal, developerIdentity, agencyIdentity };

  const isPublish = seal.by === "developer" && !seal.agency;
  const { salt, sealHash } = seAl(fullSeal);
  const g: Agreement = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    seal: fullSeal,
    salt,
    sealHash,
    status: isPublish ? "published" : "proposed",
    lastBy: seal.by === "agency" ? seal.agency : seal.developer,
    at: now,
    updatedAt: now,
  };
  return mutate((list) => ({ next: [...list, g], ret: g }));
}

/**
 * Mode 2 — a vetted AGENCY joins a PUBLISHED agreement, accepting the developer's terms AS-IS (it sets no
 * commission; the published per-building rates stand). Fills in the agency + its KYC identity, RE-SEALS
 * (the payload changed) and moves to "agreed" — join is acceptance of the published terms. The developer
 * still gates access separately ("set availability"); an agreed agreement is NOT automatically live.
 * Returns the updated record, or null if not a joinable published agreement.
 */
export async function joinAgreement(id: string, agency: string): Promise<Agreement | null> {
  const acct = agency.trim();
  if (!acct) return null;
  // Resolve the KYC identity BEFORE entering the serialized region (no await inside mutate). A concurrent
  // join of the same published agreement is still safe: the second mutate re-reads and finds status !=
  // "published" (the first already moved it to "agreed"), so it no-ops rather than racing.
  const agencyIdentity = await identitySnapshot(acct);
  return mutate((list) => {
    const idx = list.findIndex((g) => g.id === id);
    if (idx < 0) return { next: list, ret: null };
    const g = list[idx];
    if (g.status !== "published") return { next: list, ret: null }; // only a published offer can be joined
    const newSeal: AgreementSeal = { ...g.seal, agency: acct, agencyIdentity };
    const { salt, sealHash } = seAl(newSeal);
    const next = list.slice();
    next[idx] = { ...g, seal: newSeal, salt, sealHash, status: "agreed", lastBy: acct, updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/** Published agreements an agency can discover + join (status "published", newest first). */
export async function publishedAgreements(): Promise<Agreement[]> {
  return (await readAll()).filter((g) => g.status === "published").sort((a, b) => b.at - a.at);
}

/**
 * Move an agreement's lifecycle. `by` must be a party to it.
 *
 * ⚠️ A SIGNED (agreed) AGREEMENT IS A DURABLE COMMITMENT — it protects commission already earned on deals
 * done under it, so NEITHER party may unilaterally revoke it. The semantics:
 *   - "agreed" / "declined": a response to a PROPOSAL, by the COUNTERPARTY only, while still "proposed".
 *   - "revoked": only MUTUAL termination. It takes TWO steps — one party requests revoke, the other
 *     confirms (mutualRevoke below). setAgreementStatus NEVER flips an agreed agreement to revoked in one
 *     call; it only records a revoke REQUEST (lastRevokeRequestBy). A developer who wants to stop working
 *     with an agency going forward does NOT revoke — they WITHDRAW FUTURE-UNIT EXPOSURE via the access gate
 *     (whole or selected buildings), which never touches past deals or commission owed. Those are different
 *     levers: the agreement is the money commitment; the gate is the forward-looking access control.
 * The seal is NEVER mutated — terms are frozen at proposal; a change of terms is a NEW agreement.
 */
export async function setAgreementStatus(
  id: string,
  status: AgreementStatus,
  by: string
): Promise<Agreement | null> {
  const actor = by.trim().toLowerCase();
  // Revoke is NOT a one-sided status flip on an agreed agreement — route it through mutualRevoke so the
  // durable commitment can only end by mutual consent. Reject a direct "revoked" here (before touching store).
  if (status === "revoked") return null;
  if (status !== "agreed" && status !== "declined") return null;
  return mutate((list) => {
    const idx = list.findIndex((g) => g.id === id);
    if (idx < 0) return { next: list, ret: null };
    const g = list[idx];
    const isAgency = g.seal.agency.toLowerCase() === actor;
    const isDeveloper = g.seal.developer.toLowerCase() === actor;
    if (!isAgency && !isDeveloper) return { next: list, ret: null }; // only a party may move it
    // A proposal is accepted/declined by the COUNTERPARTY (the side that didn't propose).
    if (g.status !== "proposed") return { next: list, ret: null };
    const proposerIsAgency = g.seal.by === "agency";
    const actorIsCounterparty = proposerIsAgency ? isDeveloper : isAgency;
    if (!actorIsCounterparty) return { next: list, ret: null };
    const next = list.slice();
    next[idx] = { ...g, status, lastBy: by.trim(), updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/**
 * Mutual termination of an AGREED agreement. A durable agreement can only be unwound by BOTH
 * parties: the first party's call records a revoke REQUEST; the SECOND (counterparty) call confirms and the
 * agreement becomes "revoked". A single party can never kill it alone — that would let a developer escape
 * commission already owed. (To stop future business without touching past deals, the developer withdraws
 * EXPOSURE via the gate, not the agreement.) Returns the updated record, or null if not allowed.
 */
export async function mutualRevoke(id: string, by: string): Promise<Agreement | null> {
  const actor = by.trim().toLowerCase();
  return mutate((list) => {
    const idx = list.findIndex((g) => g.id === id);
    if (idx < 0) return { next: list, ret: null };
    const g = list[idx];
    if (g.status !== "agreed") return { next: list, ret: null };
    const isAgency = g.seal.agency.toLowerCase() === actor;
    const isDeveloper = g.seal.developer.toLowerCase() === actor;
    if (!isAgency && !isDeveloper) return { next: list, ret: null };

    const requestedBy = g.revokeRequestBy?.toLowerCase();
    const next = list.slice();
    if (!requestedBy) {
      // First step: record the request. No status change yet — the other party must confirm.
      next[idx] = { ...g, revokeRequestBy: by.trim(), lastBy: by.trim(), updatedAt: Date.now() };
    } else if (requestedBy !== actor) {
      // Second step by the OTHER party: both consent → revoked.
      next[idx] = { ...g, status: "revoked", lastBy: by.trim(), updatedAt: Date.now() };
    } else {
      // Same party calling again — idempotent no-op (still just a pending request).
      return { next: list, ret: g };
    }
    return { next, ret: next[idx] };
  });
}
