// Off-chain VRX↔DEVELOPER AGREEMENT registry — SERVER-ONLY (file-backed). The THIRD trust-critical consumer
// of the "Attested Off-Chain Records" spine (offers were first, agency↔developer agreements second —
// lib/agreements.ts; this is its sibling for the OTHER side of the relationship). Same shape, deliberately:
// plaintext off-chain + a salted SEAL (lib/seal.ts) + re-hash to verify (✓ Vetted). One pattern, N
// consumers (the "scan for the reusable PATTERN").
//
// WHAT IT IS (+ PAYMENT_LEDGER_DESIGN §7): the agreement a DEVELOPER signs with VRX when they onboard.
// It is the SIGNED surface that two owed things were waiting for:
//  1. The ACCURACY / ATTESTATION compact — the developer signs off each building as true before VRX
//      vets it; VRX's vetting is BOUNDED (a reasonableness/existence check, never a guarantee of every fact);
//      the developer bears FULL ONGOING responsibility for accuracy; found-wrong → correct-or-be-suspended;
//      and the pro-developer upside (exact tracking prevents double-bookings → agencies/agents/buyers trust
//      the listings, the developer always knows their standing; only fraud is hard to sustain).
//   2. The §3b/§3c DISCLOSURE — the protocol fee + the 14-working-day settlement clock, and the FULL staged
//      consequence routine if the developer is late paying VRX (grace → suspended → wind-down → removed),
//      what happens at each stage, what CONTINUES regardless (existing deals + agency commissions, through
//      every stage incl. removal — VRX never unwinds a signed buyer↔developer S&P), the in-chat notice to
//      all parties, and that re-entry after removal is a manual VRX review.
//
// THE RULE this surface exists to honour: **no VRX action against a developer that wasn't
// disclosed to them in the agreement they signed.** The §3c stage-advancement scheduler (the timed
// enforcement, PAYMENT_LEDGER_DESIGN §3c seam #4) is DELIBERATELY sequenced to land WITH / AFTER this surface
// — a scheduler that auto-fires adverse timed consequences is bound by this rule, so the disclosure must
// precede the auto-enforcement. Building this surface is what UNBLOCKS that scheduler.
//
// WHERE THE NUMBERS LIVE (don't duplicate): the fee rate (`protocolFeePct`) and the settlement window
// (`vrxSettleWorkingDays`) are PER-DEVELOPER terms that live interim on the `Developer` record
// (lib/developers.ts — their resolvers `protocolFeePct`/`vrxSettleWorkingDays` are the single source).
// This agreement SNAPSHOTS them into the seal at signing (so ✓ Vetted attests the exact terms the developer
// agreed to), but it is NOT a second store of the live rate — a later rate change is a NEW agreement (same
// discipline as the agency agreement's per-building commission snapshot).
//
// WHY THE TERMS COPY IS VERSIONED (not free-text): unlike the agency agreement (whose `terms` are the
// parties' own free-text), the VRX↔developer terms are VRX's OWN disclosure language — the same for every
// developer. So the copy lives in ONE versioned constant (VRX_DEVELOPER_TERMS below). The seal freezes the
// VERSION + a content hash of that version's copy, so: (a) a developer's signature provably commits to the
// exact words they were shown, and (b) re-wording the copy is ONE edit that bumps the version — old seals
// stay valid under THEIR version (they re-verify against the version they froze), never silently invalidated.
// ⚠ v1 copy is a PLACEHOLDER pending legal review — the structure is real; the words are not
// final. Bumping to a lawyer-reviewed v2 is a one-constant edit + a new version tag.
//
// ON-CHAIN STAMP — DESIGN NOW, BUILD LATER (same as for agency agreements): the developer onboarding is
// a trust-critical legal moment, so it later earns an on-chain stamp (a contract method witnesses `sealHash`).
// That needs a contract change → ships with the signing/defrost arc; the contract stays FROZEN now. The room
// is left: `sealHash` is computed + stored today, and an optional `onChainTx` records the witnessing txn when
// the stamp lands, no schema break.
//
// PRIVACY: server-side only; VRX is a party to every record here (it is VRX's own agreement with each
// developer), so the readable parties are the developer + VRX-root. The chain carries at most the opaque seal
// hash (when stamped). No PII beyond the developer's neutral account id + their own KYC identity snapshot.

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { digest, newSalt } from "./seal";
import { identityForSeal, getProfile, verifyProfile } from "./profiles";
import type { PartyIdentity } from "./agreements";
import { getDeveloper, protocolFeePct, vrxSettleWorkingDays } from "./developers";

/** The seal domain tag (public namespace; the SECRET is the per-record salt). */
const VRX_DEV_AGREEMENT_DOMAIN = "vrx-developer-agreement";

// ── The versioned DISCLOSURE TERMS — VRX's own language, the SAME for every developer ────────────────────
// This is the copy a developer is shown and signs. It is NOT free-text per agreement; it is VRX's standard
// disclosure, versioned so a signature provably commits to a specific wording and re-wording never silently
// invalidates past signatures (see the header). plain words — no field-names, no contract-speak, no
// D-refs, no error codes. These sections mirror PAYMENT_LEDGER_DESIGN §7 +.
//
// ⚠ PLACEHOLDER (v1-draft) — the STRUCTURE is final; the exact legal wording is pending review. Do not treat
// as vetted legal text. A reviewed v2 is a one-constant edit that bumps VRX_DEVELOPER_TERMS_VERSION.

/** The current disclosure-copy version. Bump when the wording below changes; old seals keep their frozen
 *  version and re-verify against it (VRX_DEVELOPER_TERMS_BY_VERSION preserves superseded versions).
 * v2-draft adds the booking-token clause — the issuance fee, scarcity cap, VRX-sole-issuer,
 *  crypto-only sale, and no-theft-by-freeze. Bumped only once the developer-facing token FLOW exists
 *  end-to-end (root issues → developer hands, slice 7a/7b), per document-alongside discipline — a binding
 *  clause for a capability a developer couldn't exercise would over-promise. */
export const VRX_DEVELOPER_TERMS_VERSION = "v2-draft";

/** The structured disclosure copy for a given version. Every section is plain-words. */
export type VrxDeveloperTerms = {
  version: string;
  /** Marked true while the wording is not yet legally reviewed (v1). Surfaces an honest "draft" badge. */
  draft: boolean;
  /** §3b — the fee + when it's earned + the settlement clock, in plain words. */
  fee: string;
  /** — the sign-off + bounded vetting + ongoing-accuracy + correct-or-be-suspended compact. */
  accuracy: string;
  /** §3c — the full staged consequence routine for late VRX payment (and, via the same stages,
   *  misrepresentation): grace → suspended → wind-down → removed, with what continues regardless. */
  consequence: string;
  /** §3c — what CONTINUES through every stage incl. removal (the reassurance half). */
  continues: string;
  /** — the upside / why it is pro-developer (a selling point, not only a warning). */
  upside: string;
  /** booking tokens: the VRX issuance fee + scarcity cap + VRX-sole-issuer + crypto-only sale + the
   *  no-theft-by-freeze guarantee. OPTIONAL so a pre-v2 version's copy object (which omits it) hashes exactly
   *  as it did before — stableStringify/JSON.stringify drop an absent field, so old seals never break. Present
   *  only from v2-draft onward (the version a developer signs once the token flow is real). */
  tokens?: string;
};

/** v1-draft copy. PLACEHOLDER — pending legal review (see header). Structure final, words not. */
const VRX_DEVELOPER_TERMS_V1: VrxDeveloperTerms = {
  version: "v1-draft",
  draft: true,
  fee:
    "VRX earns a protocol fee on each sale it helps you make. The fee is due within a set number of working " +
    "days after a unit leaves availability (and is not reversed). Your exact fee rate and settlement window " +
    "are shown with this agreement before you sign.",
  accuracy:
    "You confirm each building is true and complete before VRX reviews it. VRX's review is a reasonableness " +
    "and existence check — we verify the title deeds are real and shown to us and that the land exists and is " +
    "broadly as described. That review does NOT make VRX responsible for every fact: you remain fully and " +
    "continuously responsible for keeping every listing accurate in the system. If something is found to be " +
    "wrong you must correct it. Deliberate misrepresentation or fraud is not tolerated.",
  consequence:
    "If a protocol fee goes unpaid past its due date, or if a listing is found to be materially misrepresented " +
    "and not corrected, VRX applies a staged response: first a one-week grace period (your listings stay live " +
    "but flagged); then your listings are paused so no NEW bookings can be made against them; a further two " +
    "weeks is a final window to put it right and be reinstated; after that a developer may be removed from the " +
    "platform. Re-entry after removal is a manual VRX review, not automatic.",
  continues:
    "Deals that are already signed keep going — through every stage, including removal. VRX never unwinds a " +
    "sale agreement between you and a buyer, and never claws back commission an agency has already earned. A " +
    "pause stops only NEW bookings. When a pause is approaching, everyone on an affected deal is notified in " +
    "the deal chat so no consequence ever arrives as a surprise.",
  upside:
    "VRX tracks your units and bookings exactly, which prevents double-bookings and misrepresentation. For an " +
    "honest developer that is pure upside: agencies and agents work with full knowledge, buyers can trust your " +
    "listings, and you always know exactly where you stand. Everything is easier — only fraud becomes hard to " +
    "sustain.",
};

/** v2-draft copy. Reuses v1's five sections VERBATIM + adds the booking-token clause. Still a
 *  PLACEHOLDER pending legal review (draft:true). ⚠ The five reused strings are byte-identical to v1 on
 *  purpose — only the NEW `tokens` section is added; this keeps the diff reviewable and the intent clear
 *  ("v1 + the token clause"). v1 is preserved untouched in the registry so pre-v2 seals still re-verify. */
const VRX_DEVELOPER_TERMS_V2: VrxDeveloperTerms = {
  ...VRX_DEVELOPER_TERMS_V1,
  version: "v2-draft",
  draft: true,
  tokens:
    "VRX may issue you booking tokens — scarce, numbered reservation slots you hand down to your agencies so " +
    "their field agents can secure bookings and take deposits on your units. Only VRX issues tokens (you " +
    "cannot create your own), which is how capacity stays scarce and double-bookings are prevented; VRX " +
    "charges a transparent issuance fee for them, shown to you before you issue, the same honest way the " +
    "protocol fee is shown. You decide how each token is given to an agency: free permission, a refundable " +
    "stake, or a prepaid credit toward the sale. A token you sell is paid in crypto so both sides hold a " +
    "verifiable receipt — and once you have sold or handed a token it has left your hands: you cannot freeze " +
    "or claw it back on your own. Pulling a sold token back needs either both sides' agreement or a VRX " +
    "review, and if it was paid for, the money is refunded. Unused tokens recycle back to you to re-use at no " +
    "new fee.",
};

/** All disclosure-copy versions, newest-keyed. A seal freezes a VERSION; verification re-hashes against the
 *  copy of THAT version (so superseded versions must stay here as long as any seal references them). ⚠ Never
 *  edit a published version's copy in place — add a NEW version (that is what v2-draft is). */
export const VRX_DEVELOPER_TERMS_BY_VERSION: Record<string, VrxDeveloperTerms> = {
  "v1-draft": VRX_DEVELOPER_TERMS_V1,
  "v2-draft": VRX_DEVELOPER_TERMS_V2,
};

/** The current terms (the version a new signature will freeze). */
export const VRX_DEVELOPER_TERMS: VrxDeveloperTerms =
  VRX_DEVELOPER_TERMS_BY_VERSION[VRX_DEVELOPER_TERMS_VERSION];

// Deterministic JSON with sorted keys — MUST match stableStringify in lib/seal.ts so the terms content hash
// is reproducible regardless of key order. (Local copy because seal.ts keeps its stableStringify private; the
// scheme — JSON.stringify(obj, sortedKeys) — is byte-identical.)
function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}

/** SHA-256 of a terms version's copy — the content hash folded into the seal. Changing a single word of a
 *  version's copy would change this hash (and so break every seal that froze it); that is WHY re-wording
 *  must bump the VERSION rather than edit a published version in place. */
export function termsContentHash(terms: VrxDeveloperTerms): string {
  return createHash("sha256")
    .update(stableStringify(terms as unknown as Record<string, unknown>), "utf8")
    .digest("hex");
}

// ── Building sign-off — the developer's explicit per-building attestation ────────────────────────
// Each building the agreement covers carries the developer's sign-off: "I attest this building's listing is
// true and complete." This is the formal assertion requires BEFORE VRX vets. It is part of the seal, so
// a developer's signature provably commits to having signed off each named building.

/** The developer's explicit attestation for one building. */
export type BuildingSignOff = {
  /** Catalog building id (lib/catalog.ts) being attested. */
  buildingId: string;
  /** True = the developer explicitly signed off this building as true/complete. A FALSE/absent sign-off means
   *  the building is NOT attested — the agreement can still be sealed, but that building is not vetted-ready
   *  (an honest absence, never a fabricated attestation). */
  attested: boolean;
  /** ms epoch the developer made this attestation — part of the seal (each sign-off is a dated act). */
  attestedAt: number;
};

/** Valid building id for a sign-off: a non-empty trimmed string. */
export function isValidBuildingId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0;
}

// ── The canonical seal ──────────────────────────────────────────────────────────────────────────────────

/**
 * The CANONICAL seal inputs — these fields, in this shape, ARE the VRX↔developer agreement. Re-hashing this
 * object with the domain + stableStringify + the record's salt reproduces `sealHash`. Minimal +
 * verbatim; display extras ride alongside in the record but are NOT part of the seal.
 */
export type VrxDeveloperAgreementSeal = {
  /** The developer (Node) account — the signing party. */
  developer: string;
  /** The disclosure-copy VERSION the developer signed (freezes WHICH words they committed to). */
  termsVersion: string;
  /** SHA-256 of that version's copy (freezes the EXACT words — re-wording a published version would break
   *  this, which is why re-wording bumps the version instead). */
  termsHash: string;
  /** SNAPSHOT of the fee rate (%) the developer agreed to, frozen at signing (read from the Developer record
   *  at seal time; a later change is a NEW agreement). */
  protocolFeePct: number;
  /** SNAPSHOT of the settlement window (working days) agreed to, frozen at signing. */
  vrxSettleWorkingDays: number;
  /** The developer's explicit per-building sign-offs. May be empty (an agreement with no buildings
   *  attested yet is valid but vets nothing). */
  signOffs: BuildingSignOff[];
  /** ms epoch the developer signed — part of the seal so each agreement is unique. */
  signedAt: number;
  /** the developer's immutable-profile identity snapshot, auto-populated at signing. Optional so a
   *  developer without a vetted profile still produces a valid (identity-less) seal. */
  developerIdentity?: PartyIdentity;
};

// Lifecycle. VRX publishes standard terms; the developer SIGNS (one-sided accept of VRX's disclosure — there
// is no counter-offer, the terms are VRX's own). Either side may later revoke (e.g. offboarding).
//   signed   — the developer has signed VRX's current terms (the live, in-force state).
//   revoked  — the relationship was ended (by the developer or VRX-root).
export type VrxDeveloperAgreementStatus = "signed" | "revoked";

/** The full stored record: canonical seal inputs + the seal + lifecycle + optional chain witness. */
export type VrxDeveloperAgreement = {
  /** Opaque unique id (the store key). */
  id: string;
  /** The canonical hash-input object (verbatim, for exact re-hash). */
  seal: VrxDeveloperAgreementSeal;
  /** Per-record secret salt — NEVER goes on-chain / off the server. Lose it and the record stops
   *  re-verifying (degrades to an opaque anchor, same as agreements.ts). */
  salt: string;
  /** SHA-256 over domain|salt|stableStringify(seal). The shared tamper-proof truth. */
  sealHash: string;
  /** Lifecycle. */
  status: VrxDeveloperAgreementStatus;
  /** The account that last moved the lifecycle (audit trail). */
  lastBy?: string;
  /** seam: the txn hash that witnessed `sealHash` on-chain, once the stamp method exists. */
  onChainTx?: string;
  /** ms epoch created / last updated. */
  at: number;
  updatedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "vrx-developer-agreements.json");

async function readAll(): Promise<VrxDeveloperAgreement[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VrxDeveloperAgreement[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: VrxDeveloperAgreement[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as agreements.ts.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: VrxDeveloperAgreement[]) => { next: VrxDeveloperAgreement[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

// ── Verification (the ✓ VETTED re-hash) ─────────────────────────────────────────────────────────────────

/** The canonical seal payload — the exact object hashed. Minimal + verbatim; optional identity omitted when
 *  absent so an identity-less agreement hashes stably (stableStringify drops undefined). */
function sealPayload(seal: VrxDeveloperAgreementSeal): Record<string, unknown> {
  const p: Record<string, unknown> = {
    developer: seal.developer,
    termsVersion: seal.termsVersion,
    termsHash: seal.termsHash,
    protocolFeePct: seal.protocolFeePct,
    vrxSettleWorkingDays: seal.vrxSettleWorkingDays,
    signOffs: seal.signOffs,
    signedAt: seal.signedAt,
  };
  if (seal.developerIdentity !== undefined) p.developerIdentity = seal.developerIdentity;
  return p;
}

/** Hash the canonical seal inputs with the domain + the record's secret salt → hex digest. */
export function vrxDeveloperAgreementDigest(seal: VrxDeveloperAgreementSeal, salt: string): string {
  return digest(sealPayload(seal), VRX_DEV_AGREEMENT_DOMAIN, salt);
}

/**
 * True iff the stored plaintext + salt re-hash to the stored sealHash AND the frozen terms version's copy
 * still hashes to the sealed `termsHash` AND (if an identity was claimed) it still matches the live profile.
 * The ✓ VETTED check. Three independent re-hashes, any mismatch = loud false.
 */
export async function verifyVrxDeveloperAgreement(g: VrxDeveloperAgreement): Promise<boolean> {
  try {
    if (!g.salt) return false; // no salt → can't re-verify (lost-salt / legacy)
    if (vrxDeveloperAgreementDigest(g.seal, g.salt) !== g.sealHash) return false;
    // The sealed terms version must still resolve to copy that hashes to the frozen termsHash. If a published
    // version's words were edited in place (forbidden — bump the version instead), this fails LOUDLY rather
    // than silently attesting words the developer never saw. An unknown version also fails (copy is gone).
    const terms = VRX_DEVELOPER_TERMS_BY_VERSION[g.seal.termsVersion];
    if (!terms) return false;
    if (termsContentHash(terms) !== g.seal.termsHash) return false;
    // If the developer's identity was folded in, it must still match the live profile (same cross-check as
    // agreements.ts fix #4 — ✓ Vetted means "terms AND identity current", not just "the blob is intact").
    const snap = g.seal.developerIdentity;
    if (snap) {
      const live = await getProfile(g.seal.developer);
      if (!live) return false;
      if (!verifyProfile(live)) return false;
      if (live.salt !== snap.seal.salt || live.identityHash !== snap.seal.hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Public projection (strip the secret salt — fix #1 discipline) ───────────────────────────────────
export type PublicVrxDeveloperAgreement = Omit<VrxDeveloperAgreement, "salt"> & { verified: boolean };

/** Strip the secret salt + attach the ✓ Vetted result. The ONLY shape an endpoint should return. */
export async function publicVrxDeveloperAgreement(
  g: VrxDeveloperAgreement
): Promise<PublicVrxDeveloperAgreement> {
  const verified = await verifyVrxDeveloperAgreement(g);
  const { salt: _salt, ...rest } = g;
  void _salt;
  return { ...rest, verified };
}

// Auto-populate the developer's KYC identity snapshot into the seal. undefined for an unvetted/absent
// account — an honest "no identity claim", never fabricated.
async function identitySnapshot(account: string): Promise<PartyIdentity | undefined> {
  if (!account) return undefined;
  const id = await identityForSeal(account);
  if (!id) return undefined;
  return { legalName: id.legalName, region: id.region, role: id.role, seal: id.seal };
}

// Seal a seal object with a fresh salt → {salt, sealHash}.
function seAl(seal: VrxDeveloperAgreementSeal): { salt: string; sealHash: string } {
  const salt = newSalt();
  return { salt, sealHash: vrxDeveloperAgreementDigest(seal, salt) };
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────

/** All VRX↔developer agreements, newest first. ROOT-SCOPE (VRX is a party to every record; this is the
 *  operator read for the root dashboard). */
export async function listAllVrxDeveloperAgreements(): Promise<VrxDeveloperAgreement[]> {
  return (await readAll()).sort((a, b) => b.at - a.at);
}

/** All of ONE developer's VRX agreements, newest first. Case-insensitive. */
export async function vrxDeveloperAgreementsFor(developer: string): Promise<VrxDeveloperAgreement[]> {
  const d = developer.trim().toLowerCase();
  if (!d) return [];
  return (await readAll())
    .filter((g) => g.seal.developer.toLowerCase() === d)
    .sort((a, b) => b.at - a.at);
}

/** The developer's CURRENT in-force (signed) agreement, or null. A signed agreement on the LIVE terms version
 *  wins; if the developer has only superseded-version signatures, the most-recent signed record wins (kept for
 * the audit trail). (fix: `vrxDeveloperAgreementsFor` sorts newest-first by `at`, and a developer who
 *  re-signed a bumped terms version has BOTH an old- and a new-version signed row. A plain `.find(signed)`
 *  returned whichever sorted first — which could be the SUPERSEDED version — making every re-signed developer
 *  read as not-current and emptying the buyer catalog. Prefer the current-version signature explicitly.) */
export async function currentVrxDeveloperAgreement(
  developer: string
): Promise<VrxDeveloperAgreement | null> {
  const all = await vrxDeveloperAgreementsFor(developer); // already sorted newest-first by `at`
  const signed = all.filter((g) => g.status === "signed");
  return signed.find((g) => g.seal.termsVersion === VRX_DEVELOPER_TERMS_VERSION) ?? signed[0] ?? null;
}

/** One agreement by id, or null. */
export async function getVrxDeveloperAgreement(id: string): Promise<VrxDeveloperAgreement | null> {
  const key = id.trim();
  if (!key) return null;
  return (await readAll()).find((g) => g.id === key) ?? null;
}

/** True iff this developer has a CURRENT signed agreement whose sign-off attests the given building. This is
 * the gate the vetting flow reads (the developer must have signed off a building before VRX vets it).
 *  A developer with no signed agreement, or a signed agreement that doesn't attest the building, returns
 *  false — an honest "not attested", never a silent pass. */
export async function hasSignedOffBuilding(developer: string, buildingId: string): Promise<boolean> {
  const g = await currentVrxDeveloperAgreement(developer);
  if (!g) return false;
  const bid = buildingId.trim();
  return g.seal.signOffs.some((s) => s.buildingId === bid && s.attested === true);
}

// ── Write: the developer SIGNS VRX's current terms ──────────────────────────────────────────────────────

/**
 * The developer signs the VRX agreement — accepting VRX's CURRENT disclosure terms + attesting each building
 * they sign off. The server:
 *  - freezes the current terms VERSION + its content hash into the seal (so the signature commits to the
 *    exact words shown);
 *  - SNAPSHOTS the developer's fee + settlement window from the Developer record (the single source — not a
 *    second store of the rate);
 * - auto-populates the developer's KYC identity when it exists;
 *  - computes the salted seal (the server is the attesting authority until the on-chain stamp lands).
 *
 * `signOffs` is the per-building attestation set the developer explicitly made. Building ids are
 * trimmed + validated; an invalid id is dropped (honest — a bad id can't be a real attestation).
 */
export async function signVrxDeveloperAgreement(args: {
  developer: string;
  signOffs?: Array<{ buildingId: string; attested: boolean }>;
  /** Injectable for tests/determinism; defaults to now. */
  now?: number;
}): Promise<VrxDeveloperAgreement> {
  const developer = args.developer.trim();
  if (!developer) throw new Error("signVrxDeveloperAgreement: developer account required");
  const now = args.now ?? Date.now();

  // Snapshot the agreed terms from the single source (the Developer record resolvers — defaults applied).
  const dev = await getDeveloper(developer);
  const feePct = protocolFeePct(dev);
  const settleDays = vrxSettleWorkingDays(dev);

  // Freeze the current disclosure copy by version + content hash.
  const terms = VRX_DEVELOPER_TERMS;
  const termsHash = termsContentHash(terms);

  const signOffs: BuildingSignOff[] = (args.signOffs ?? [])
    .filter((s) => isValidBuildingId(s.buildingId))
    .map((s) => ({ buildingId: s.buildingId.trim(), attested: s.attested === true, attestedAt: now }));

  const developerIdentity = await identitySnapshot(developer);
  const sealInputs: VrxDeveloperAgreementSeal = {
    developer,
    termsVersion: terms.version,
    termsHash,
    protocolFeePct: feePct,
    vrxSettleWorkingDays: settleDays,
    signOffs,
    signedAt: now,
    developerIdentity,
  };
  const { salt, sealHash } = seAl(sealInputs);
  const g: VrxDeveloperAgreement = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    seal: sealInputs,
    salt,
    sealHash,
    status: "signed",
    lastBy: developer,
    at: now,
    updatedAt: now,
  };
  return mutate((list) => ({ next: [...list, g], ret: g }));
}

/**
 * Revoke a VRX↔developer agreement (offboarding). Either the developer or VRX-root may revoke. Returns the
 * updated record, or null if not found / already revoked. Signed deals are unaffected (handled by §3c's
 * "existing deals continue" invariant elsewhere — revoking the onboarding agreement is NOT a §3c removal).
 */
export async function revokeVrxDeveloperAgreement(
  id: string,
  by: string
): Promise<VrxDeveloperAgreement | null> {
  const actor = by.trim();
  return mutate((list) => {
    const idx = list.findIndex((g) => g.id === id);
    if (idx < 0) return { next: list, ret: null };
    const g = list[idx];
    if (g.status === "revoked") return { next: list, ret: null };
    const updated: VrxDeveloperAgreement = {
      ...g,
      status: "revoked",
      lastBy: actor || g.lastBy,
      updatedAt: Date.now(),
    };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}
