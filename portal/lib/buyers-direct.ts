// DIRECT-BUYER RECORD — SERVER-ONLY (file-backed). The Direct-Sales Desk buyer (§9 step 1;
// the design docs §5). The FOURTH consumer of the "Attested Off-Chain Records"
// spine (offers → agreements → agent-roster buyers → this): plaintext off-chain + a salted hash SEAL
// (lib/seal.ts) + re-hash to verify. One pattern, N consumers.
//
// ── How this differs from lib/buyers.ts (the agent roster) ───────────────────────────────────────────
// lib/buyers.ts is the AGENT-OWNED roster: keyed by agent, an agent's private list of customers it books
// for. THIS record is BUYER-OWNED: keyed by the buyer's own wallet ACCOUNT, created when a walk-in
// wallet-connects and saves their own profile through the direct-sales funnel. Same seal spine, opposite
// ownership. The agent-roster buyer and a direct buyer are DIFFERENT actors (§2a) — do not merge.
//
// ── The funnel (§3) ─────────────────────────────────────────────────────────────────────────────
// A direct buyer's ACCESS is a STATE, not a role. This record carries that state. The OPERATOR advances
// it deliberately (steps 3–5); saving a profile does NOT advance it. States:
//   new            — logged in, no conversation. Sees only directSale-visible buildings (photos + count +
//  range, §8-resolved-2). Cannot see units / make offers.
//   in_conversation— opened a conversation with the desk; operator is vetting (what/why/referred).
//   units_opened   — operator has opened specific units to this buyer (per-unit grants live elsewhere).
//   offer_eligible — meets the bar: KYC complete ∧ profile saved ∧ balance ≥ threshold. May offer/deposit.
// This slice (step 1) only ever sets "new" on create; later steps advance it. The deposit rail that the
// final state unlocks is -deferred (§7, step 9).
//
// ── Wallet / ───────────────────────────────────────────────────────────────────────────────────
// The `account` is a connected wallet id (lib/wallet.tsx `accountId`) — a READ of the connected account,
// NO signing. Signing (the deposit) is the deferred piece. So creating/saving a buyer record touches
// no chain and signs nothing.
//
// PRIVACY: SERVER-ONLY; holds buyer plaintext (PII) deliberately. Nothing here goes on-chain by
// itself — at most a seal hash later. Same file-backed .data pattern as buyers.ts / kyc-vault.ts; the real
// per-party architecture is unchanged by this demo stand-in.

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";
import type { BuyerMask, MaskMode } from "./buyer-mask";

/** The seal domain tag for direct-buyer records (public namespace; the SECRET is the per-record salt). */
const BUYER_DIRECT_DOMAIN = "vrx-buyer-direct";

/** The funnel states (§3). Ordered; the operator advances a buyer forward through them. */
export type BuyerFunnelState = "new" | "in_conversation" | "units_opened" | "offer_eligible";

/**
 * The direct-buyer profile fields. Mirrors the KYC/contract fields the S&P will need (lib/kyc-vault
 * KycContractFields) so a direct buyer's own saved profile can populate the contract later. All optional
 * except `name` — but the KYC PRECONDITION (`kycPrecondition`) requires a fuller set before the buyer can
 * become offer-eligible. "Saved profile" and "KYC-complete enough to offer" are two different bars.
 */
export type BuyerDirectProfile = {
  /** How the buyer identifies themselves. The one field required to create a record. */
  name: string;
  /** Full legal name as on the ID/passport (for the S&P). */
  legalName?: string;
  /** Nationality / citizenship — relevant to the freehold quota. */
  nationality?: string;
  /** Contact phone (free-form). */
  phone?: string;
  /** Contact email. NB: NEVER the forbidden personal inbox — the buyer's own. */
  email?: string;
  /** Passport number (for the S&P). */
  passportNo?: string;
  /** National ID-card number. */
  idCardNo?: string;
  /** Residential address for the contract. */
  address?: string;
};

/** Every BuyerDirectProfile key EXCEPT the always-required `name` — the canonical optional-field list, the
 *  single source of truth for cleaning, diffing, and validating required-field overrides. */
export const PROFILE_FIELD_KEYS: Array<keyof BuyerDirectProfile> = [
  "legalName",
  "nationality",
  "phone",
  "email",
  "passportNo",
  "idCardNo",
  "address",
];

/** The DEFAULT fields a buyer profile must have (non-empty) to be offer-eligible — used when a developer
 * sets no `requiredProfileFields` override. This is the long-standing KYC precondition set. */
export const DEFAULT_REQUIRED_PROFILE_FIELDS: Array<keyof BuyerDirectProfile> = [
  "legalName",
  "nationality",
  "phone",
];
/** @deprecated kept as the internal alias; prefer DEFAULT_REQUIRED_PROFILE_FIELDS / requiredFieldsFor. */
const KYC_REQUIRED_FIELDS = DEFAULT_REQUIRED_PROFILE_FIELDS;

/** A prior SEALED version of the profile, kept in the append-only edit trail (Phase 1). Each entry is
 * the outgoing sealed snapshot at the moment the buyer re-opened + re-saved, so the record of WHAT the
 * buyer attested and WHEN is tamper-evident and never silently overwritten. Independently ✓-verifiable:
 * re-hash `profile` with its own `salt` → must equal `sealHash`. The trail only ever grows. */
export type ProfileVersion = {
  /** The profile plaintext as it was when this version was sealed. */
  profile: BuyerDirectProfile;
  /** That version's own salt (so it re-verifies against its own sealHash). */
  salt: string;
  /** SHA-256(domain | salt | stableStringify(profile)) for this version. */
  sealHash: string;
  /** ms epoch this version was sealed. */
  sealedAt: number;
  /** ms epoch it was superseded (the re-seal that pushed it into history). */
  replacedAt: number;
  /** Which profile fields changed old→new at the re-seal that replaced this version (the diff). */
  changedFields: string[];
};

/** A direct-buyer record. Mirrors Buyer/Offer/Agreement: plaintext + salted seal + provenance + funnel. */
export type BuyerDirect = {
  /** The buyer's wallet account id — the login identity AND the store key (lowercased for lookup). */
  account: string;
  /** The buyer's saved profile plaintext. */
  profile: BuyerDirectProfile;
  /** The buyer's OWN per-field visibility choice for what a DESK (counterparty) sees up-front — the "visibility
 * dial" (the B slice of the direct-negotiation arc; the design docs §2). Keys are
   *  profile field names, values MaskMode ("show"|"partial"|"hide"). ABSENT or empty = the system default
   *  (DIRECT_PROFILE_MASK — fully masked). The override is MERGED OVER the default by publicDirectProfileView
 * (`{...DIRECT_PROFILE_MASK...override }`), so an unlisted (incl. future) field keeps the masked default;
   *  the buyer only ever RELAXES specific fields they chose to publish. This is the buyer's GLOBAL standing
   *  choice (travels with them to every desk); a specific desk's earned, consented reveal is separate (the C
   *  slice, on the conversation — do not merge).
   *
 * DELIBERATELY OUT OF THE SEAL: `maskOverride` is a VIEW preference, not part of the attested identity.
 * It is NOT fed to digest/sealHash — the seal covers who-the-buyer-IS, not who-they-chose-to-show-it-to. So
   *  changing the dial does NOT re-seal and does NOT break verifyBuyerDirect. Do not "fix" it into the seal. */
  maskOverride?: BuyerMask;
  /** Funnel state (§3). Defaults to "new" on create; only later steps advance it. */
  funnel: BuyerFunnelState;
  /** Who referred them — captured in the opening conversation (operator writes it, step 3). */
  referredBy?: string;
  /** True once the buyer has saved a profile at all (the "profile saved" half of the offer bar). */
  profileSaved: boolean;
  /** SEALED = the profile is LOCKED (Phase 1). A sealed profile is read-only: a plain save is rejected;
   * the buyer must explicitly re-open (sealed→false) to edit, and the next seal appends the outgoing version
   * to `history` with a diff. Absent/false on legacy records = unsealed (freely editable, as before). */
  sealed?: boolean;
  /** ms epoch the CURRENT sealed version was sealed (set when sealed flips true; cleared is fine to leave). */
  sealedAt?: number;
  /** Append-only edit trail — every prior SEALED version, oldest-first. Never mutated or shrunk. Absent on
   * records that have never been re-sealed after a seal. */
  history?: ProfileVersion[];
  /** Transient: the sealed version captured at the last `reopenProfile`, pending a re-seal that will diff it
   * and (if changed) append it to `history`. Cleared on seal. Not part of the attested state. */
  pendingBaseline?: ProfileVersion;
  /** Per-record secret salt (hex) — stored next to the plaintext, used to re-verify. NEVER on-chain. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify(profile)) — tamper-evident seal of the profile as saved. */
  sealHash: string;
  /** ms epoch created. */
  at: number;
  /** ms epoch last updated (== at on create). An edit re-seals (new salt+hash). */
  updatedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "buyers-direct.json");

// ── Store IO (serialized via a promise chain to avoid lost writes — the pattern from kyc-vault.ts,
// since a buyer self-writes concurrently with operator reads). ──────────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: BuyerDirect[]) => Promise<{ next: BuyerDirect[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<BuyerDirect[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BuyerDirect[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: BuyerDirect[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** Normalize a wallet account id to the store key form (trimmed, lowercased). "" if not a usable string. */
function normAccount(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * Normalize + trim the profile fields; drop empty optionals so the seal is stable (no "" vs undefined
 * drift). Returns null if `name` (the one required field) is missing.
 */
function cleanProfile(raw: unknown): BuyerDirectProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = str(r.name);
  if (!name) return null;
  const p: BuyerDirectProfile = { name };
  for (const k of PROFILE_FIELD_KEYS) {
    const v = str(r[k]);
    if (v) (p as Record<string, string>)[k] = v;
  }
  return p;
}

/** The buyer's own record, by wallet account (case-insensitive). Null if they've never saved a profile. */
export async function getBuyerDirect(account: string): Promise<BuyerDirect | null> {
  const a = normAccount(account);
  if (!a) return null;
  return (await readAll()).find((b) => b.account === a) ?? null;
}

/**
 * Create or update the direct-buyer record for a wallet account. On first save the record is created with
 * funnel = "new" (a saved profile does NOT advance the funnel — only the operator does, later steps). On a
 * later save the profile is re-sealed with a NEW salt; funnel + referredBy are PRESERVED (a profile edit is
 * not a funnel event). Returns the saved record, or null if the profile is invalid (no name) or the account
 * is unusable.
 *
 * SEAL LOCK (Phase 1): if the existing record is `sealed`, a plain save is REFUSED — returns the
 * sentinel `"sealed"` (callers map it to a 409). The buyer must `reopenProfile` first. This is the lib-layer
 * invariant (not just a disabled UI button): a sealed profile never changes silently. Serialized through
 * `mutate` so concurrent saves don't lose writes.
 */
export async function saveBuyerProfile(
  account: string,
  profile: unknown
): Promise<BuyerDirect | "sealed" | null> {
  const a = normAccount(account);
  if (!a) return null;
  const clean = cleanProfile(profile);
  if (!clean) return null;

  return mutate<BuyerDirect | "sealed">(async (list) => {
    const now = Date.now();
    const salt = newSalt();
    const sealHash = digest(clean as unknown as Record<string, unknown>, BUYER_DIRECT_DOMAIN, salt);
    const idx = list.findIndex((b) => b.account === a);

    if (idx >= 0) {
      // The lock: a sealed profile is read-only until explicitly re-opened. Refuse the plain save.
      if (list[idx].sealed) return { next: list, ret: "sealed" as const };
      const updated: BuyerDirect = {
        ...list[idx],
        profile: clean,
        profileSaved: true,
        salt,
        sealHash,
        updatedAt: now,
        // funnel + referredBy deliberately preserved — a profile edit is not a funnel event.
      };
      const next = [...list];
      next[idx] = updated;
      return { next, ret: updated };
    }

    const rec: BuyerDirect = {
      account: a,
      profile: clean,
      funnel: "new",
      profileSaved: true,
      salt,
      sealHash,
      at: now,
      updatedAt: now,
    };
    return { next: [...list, rec], ret: rec };
  });
}

// ── Visibility dial (the B slice) ────────────────────────────────────────────────────────────────────
// The buyer's own per-field choice of what a desk sees up-front. It is a view preference, NOT attested identity:
// it is stored next to (not inside) the sealed profile and never enters the seal payload, so changing it does
// not re-seal and does not break verifyBuyerDirect. The server enforces it (publicDirectProfileView merges it
// over DIRECT_PROFILE_MASK before the desk-facing wire) — it is not a UI-only blur.

/** The MaskMode values a buyer may choose per field. Local const so this store doesn't depend on a runtime
 *  import from buyer-mask (the type alone is erased at build). Kept in lockstep with buyer-mask's MaskMode. */
const MASK_MODES: ReadonlySet<string> = new Set<MaskMode>(["show", "partial", "hide"]);

/** The profile field keys a dial entry may name — the always-present `name` plus every optional field. Unknown
 *  keys in a submitted override are DROPPED (fail-closed: an unknown key can never accidentally reveal a field). */
const DIAL_FIELD_KEYS: ReadonlySet<string> = new Set<string>(["name", ...PROFILE_FIELD_KEYS]);

/** Clean a submitted visibility override: keep only known field keys with valid MaskMode values; drop the rest.
 *  Returns undefined when nothing valid remains (so an empty/garbage override clears the dial to the default). */
function cleanMaskOverride(raw: unknown): BuyerMask | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: BuyerMask = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (DIAL_FIELD_KEYS.has(k) && typeof v === "string" && MASK_MODES.has(v)) {
      out[k] = v as MaskMode;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Set (or clear) the buyer's visibility dial for their OWN record. Self-scoped: the buyer chooses what any
 * desk sees of their profile up-front. The override is validated (unknown keys / invalid modes dropped,
 * fail-closed) and stored next to the profile; an empty/garbage override CLEARS the dial back to the fully-masked
 * default (field removed). Does NOT re-seal: `maskOverride` is a view preference, not attested identity, so the
 * sealed profile + salt + sealHash are untouched and verifyBuyerDirect still passes. Funnel/history untouched.
 * Returns the updated record, or null if the buyer has no record yet (nothing to set a dial on). Serialized
 * through `mutate` so it can't race a concurrent profile save.
 */
export async function setMaskOverride(account: string, override: unknown): Promise<BuyerDirect | null> {
  const a = normAccount(account);
  if (!a) return null;
  const cleaned = cleanMaskOverride(override);
  return mutate<BuyerDirect | null>(async (list) => {
    const idx = list.findIndex((b) => b.account === a);
    if (idx < 0) return { next: list, ret: null };
    const updated: BuyerDirect = { ...list[idx], maskOverride: cleaned, updatedAt: Date.now() };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** The ✓-verifiable check: re-hash the held profile with the record's salt and compare to its seal. */
export function verifyBuyerDirect(b: BuyerDirect): boolean {
  try {
    if (!b?.salt || !b?.sealHash) return false;
    return (
      digest(b.profile as unknown as Record<string, unknown>, BUYER_DIRECT_DOMAIN, b.salt) === b.sealHash
    );
  } catch {
    return false;
  }
}

/**
 * The KYC PRECONDITION for offer-eligibility (§9 step 1 + the bar in §3): the buyer has saved a
 * profile AND the KYC-required fields are all present. This is the "KYC complete ∧ profile saved" half of
 * the offer bar; the balance-≥-threshold half is checked separately at the eligibility gate (step 8), and
 * the operator-opened-units gate is separate again. A PURE predicate — no IO — so routes and the operator
 * dashboard can both call it. Returns false for null (no record = precondition unmet).
 */
export function kycPrecondition(b: BuyerDirect | null): boolean {
  if (!b || !b.profileSaved) return false;
  return missingFields(b.profile, DEFAULT_REQUIRED_PROFILE_FIELDS).length === 0;
}

/** True iff `profile[field]` is a present, non-blank string. The single notion of "a field is filled". */
function fieldFilled(profile: BuyerDirectProfile, field: keyof BuyerDirectProfile): boolean {
  const v = profile[field];
  return typeof v === "string" && v.trim().length > 0;
}

/** Which of `required` are NOT filled in `profile` (in the required order). [] = all present. */
function missingFields(
  profile: BuyerDirectProfile,
  required: Array<keyof BuyerDirectProfile>
): Array<keyof BuyerDirectProfile> {
  return required.filter((k) => !fieldFilled(profile, k));
}

/** The required profile fields for a developer — its `requiredProfileFields` override, else the DEFAULT set
 *. Pass the developer's override array (or undefined); keeps this store free of a developers import.
 *  Unknown field keys in an override are ignored (only real BuyerDirectProfile keys count). */
export function requiredFieldsFor(override?: string[] | null): Array<keyof BuyerDirectProfile> {
  if (!override || override.length === 0) return DEFAULT_REQUIRED_PROFILE_FIELDS;
  const valid = new Set<string>(PROFILE_FIELD_KEYS);
  const picked = override.filter((k) => valid.has(k)) as Array<keyof BuyerDirectProfile>;
  return picked.length > 0 ? picked : DEFAULT_REQUIRED_PROFILE_FIELDS;
}

/** Per-developer readiness: does this buyer's profile satisfy a developer's required field set?
 *  `met` + the ordered `missing` list (for the "you still need: nationality, phone" copy). A null/
 *  unsaved buyer is not ready and "missing" the whole required set. PURE — routes + UI both call it. */
export function readinessFor(
  b: BuyerDirect | null,
  override?: string[] | null
): { met: boolean; missing: Array<keyof BuyerDirectProfile> } {
  const required = requiredFieldsFor(override);
  if (!b || !b.profileSaved) return { met: false, missing: [...required] };
  const missing = missingFields(b.profile, required);
  return { met: missing.length === 0, missing };
}

/** Per-developer readiness for ONE buyer across SEVERAL developers (Phase 2) — drives the buyer's
 *  "ready for A · missing nationality for B" nudge. Each entry pairs a developer (its account + display
 *  name + its required-field override) with the readiness of this one buyer against THAT developer's set.
 *  `sealed` is the buyer's single seal state (orthogonal to per-developer required fields); `allMet` folds
 *  the seal requirement in (an offer needs BOTH a sealed profile AND the developer's fields met — the same
 *  bar the offer gate enforces). PURE — routes compute the developer list (opened-building desks) and call
 *  this; the UI consumes the result without ever seeing the registry. */
export type DevReadiness = {
  developer: string;
  developerName: string;
  met: boolean;
  missing: Array<keyof BuyerDirectProfile>;
};
export function readinessAcross(
  b: BuyerDirect | null,
  developers: Array<{ account: string; name: string; requiredProfileFields?: string[] }>
): { sealed: boolean; perDev: DevReadiness[]; allMet: boolean } {
  const sealed = !!b?.sealed;
  const perDev: DevReadiness[] = developers.map((d) => {
    const r = readinessFor(b, d.requiredProfileFields);
    return { developer: d.account, developerName: d.name, met: r.met, missing: r.missing };
  });
  // allMet = the buyer could make an offer to EVERY opened developer: sealed AND every dev's fields met.
  const allMet = sealed && perDev.every((d) => d.met);
  return { sealed, perDev, allMet };
}

// ── Seal / re-open — the lock + append-only edit trail (Phase 1) ───────────────────────────────────────
// A buyer SEALS their profile to attest it ("this is me, as given"). Sealing LOCKS it: `saveBuyerProfile`
// then refuses (returns "sealed") until the buyer explicitly RE-OPENS. On the next seal after a re-open, the
// outgoing sealed version is pushed into `history` with a field diff — so no attested version is ever lost or
// silently overwritten. The seal itself is the existing salted hash; sealing adds no new crypto, just the
// lock + the trail discipline. Requiring a minimum field set to seal is the CALLER's policy (route/offer gate
// via readinessFor) — the store lets a buyer seal whatever they've saved (so a partial seal is possible and
// the per-developer readiness check stays the one source of "good enough").

/** Seal (lock) the buyer's current profile. Idempotent — sealing an already-sealed record returns it
 *  unchanged. Returns null if there's no saved record to seal.
 *
 *  TRAIL FINALIZE: if the record carries a `pendingBaseline` (set by `reopenProfile` — the version that was
 *  live when the buyer last re-opened), the seal compares it to the now-current profile; IF ANYTHING CHANGED
 *  it appends that baseline to `history` with the diff (`changedFields`) + `replacedAt`. If nothing changed
 *  (re-opened then re-sealed identically), no trail entry is added — the trail records real amendments, not
 *  no-ops. Either way `pendingBaseline` is cleared. */
export async function sealProfile(account: string): Promise<BuyerDirect | null> {
  const a = normAccount(account);
  if (!a) return null;
  return mutate<BuyerDirect | null>(async (list) => {
    const idx = list.findIndex((b) => b.account === a);
    if (idx < 0 || !list[idx].profileSaved) return { next: list, ret: null };
    const cur = list[idx];
    if (cur.sealed && !cur.pendingBaseline) return { next: list, ret: cur }; // already locked — idempotent

    const now = Date.now();
    let history = cur.history;
    const base = cur.pendingBaseline;
    if (base) {
      const allKeys: Array<keyof BuyerDirectProfile> = ["name", ...PROFILE_FIELD_KEYS];
      const changed = allKeys.filter((k) => (base.profile[k] ?? "") !== (cur.profile[k] ?? ""));
      if (changed.length > 0) {
        const entry: ProfileVersion = {
          profile: base.profile,
          salt: base.salt,
          sealHash: base.sealHash,
          sealedAt: base.sealedAt,
          replacedAt: now,
          changedFields: changed,
        };
        history = [...(cur.history ?? []), entry];
      }
    }
    const updated: BuyerDirect = { ...cur, sealed: true, sealedAt: now, history, pendingBaseline: undefined };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** Re-open (unlock) a sealed profile for editing. Captures the CURRENT sealed version as `pendingBaseline`
 *  so the next `sealProfile` can diff against it and append the trail entry. Returns the unlocked record,
 *  null if none, or "not_sealed" if it wasn't sealed. Re-opening twice without re-sealing keeps the FIRST
 *  baseline (the real pre-edit version), so a mid-edit re-open never loses the attested original. */
export async function reopenProfile(account: string): Promise<BuyerDirect | "not_sealed" | null> {
  const a = normAccount(account);
  if (!a) return null;
  return mutate<BuyerDirect | "not_sealed" | null>(async (list) => {
    const idx = list.findIndex((b) => b.account === a);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (!cur.sealed) return { next: list, ret: "not_sealed" as const };
    const baseline: ProfileVersion = cur.pendingBaseline ?? {
      profile: cur.profile,
      salt: cur.salt,
      sealHash: cur.sealHash,
      sealedAt: cur.sealedAt ?? cur.updatedAt,
      replacedAt: 0, // filled when the amendment is re-sealed
      changedFields: [],
    };
    const updated: BuyerDirect = { ...cur, sealed: false, pendingBaseline: baseline };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

// ── Funnel advancement (§9 steps 3b–5) ──────────────────────────────────────────────────────────────
// The OPERATOR (the desk developer) advances a buyer through the funnel as they vet them. The states are
// ORDERED; advancement is MONOTONIC (forward only) by default so a late/duplicate call can never regress a
// buyer who's already further along (e.g. a second unit-grant arriving after the buyer self-advanced). The
// deposit rail that `offer_eligible` finally unlocks is -deferred (step 9) — this just moves the state.

/** The funnel order. Index = rank; higher = further along. */
const FUNNEL_ORDER: BuyerFunnelState[] = ["new", "in_conversation", "units_opened", "offer_eligible"];

/** Numeric rank of a funnel state (for monotonic comparisons). Unknown → 0 ("new"). */
export function funnelRank(s: BuyerFunnelState): number {
  const i = FUNNEL_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

/**
 * Advance a buyer's funnel state, operator-driven. MONOTONIC by default: if the buyer is already at or past
 * `to`, the state is left unchanged (returns the record as-is) — a grant arriving after the buyer moved on
 * can't drag them back. Pass `allowRegress` to move a buyer BACKWARD (a desk deliberately pulling someone
 * back to "in_conversation"). Returns null if the buyer has no record yet (nothing to advance). Serialized
 * through `mutate`. Note: advancing to `offer_eligible` here is a DESK OVERRIDE of the state label — the real
 * gate the deposit respects is the live `offerEligibility` bar (lib/offer-eligibility), which re-checks
 * KYC ∧ profile ∧ balance regardless of this label. The label is the operator's funnel view, not the lock.
 */
export async function advanceFunnel(
  account: string,
  to: BuyerFunnelState,
  opts?: { allowRegress?: boolean }
): Promise<BuyerDirect | null> {
  const a = normAccount(account);
  if (!a) return null;
  return mutate(async (list) => {
    const idx = list.findIndex((b) => b.account === a);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    // Monotonic unless an explicit regress is requested.
    if (!opts?.allowRegress && funnelRank(to) <= funnelRank(cur.funnel)) {
      return { next: list, ret: cur };
    }
    const updated: BuyerDirect = { ...cur, funnel: to, updatedAt: Date.now() };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** Record who referred a buyer (captured by the operator in the opening conversation). No funnel change. */
export async function setReferredBy(account: string, referredBy: string): Promise<BuyerDirect | null> {
  const a = normAccount(account);
  if (!a) return null;
  const ref = typeof referredBy === "string" ? referredBy.trim() : "";
  return mutate(async (list) => {
    const idx = list.findIndex((b) => b.account === a);
    if (idx < 0) return { next: list, ret: null };
    const updated: BuyerDirect = { ...list[idx], referredBy: ref || undefined, updatedAt: Date.now() };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}
