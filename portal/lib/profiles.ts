// Immutable KYC PROFILES — SERVER-ONLY (file-backed). The identity layer
// (the design docs §2). Every vetted actor — developer (Node), agency (Org),
// agent (Peer) — has a profile of real KYC details that **VRX root sets at vetting** and the user can
// NOT edit. This is the KYC the marketplace's "legality" always implied: it's what lets a sealed
// record attest *who* agreed, not just *what*.
//
// ── Immutable BY THE USER, corrigible BY ROOT ────────────────────────────────────────────────────────
// A profile is set once at vetting by root (the operator-gated API). The user has NO write path — the
// portal never offers them an edit. If a detail genuinely must change (a legal-name correction), the user
// contacts VRX out-of-band → we vet the request → root edits. So "immutable" = immutable to the user,
// corrigible to an honest root.
//
// ── The ✓ Vetted upgrade (→ identity-in-the-seal) ──────────────────────────────────────────────
// The sealed, salted identity (name/region/role, salt) auto-populates into records that reference an
// actor (agreements now; arguably offers/bookings later). Folding identity into a record's sealed payload
// means the ✓ Vetted re-hash now also proves the identity wasn't swapped — no one can pretend to be someone
// else on a signed record. We expose `identityForSeal` as the canonical, minimal identity snapshot a
// consuming record embeds + re-hashes.
//
// ── HONEST CAVEAT (must not oversell — stated here AND in the UI copy) ─────────────────────────────
//  we put NO PII plaintext on-chain. So "immutable" has two layers:
//   (a) the OFF-CHAIN profile is root-set / user-read-only — enforced by our server + root. This is a
//  TRUSTED-ROOT property (the same kind of trust as the catalog info-gate), NOT cryptographic.
//  (b) the sealed hash (salted) makes ALTERATION of a referenced identity DETECTABLE in any record
//       that embedded it. That's tamper-evidence, not tamper-proofness.
// Cryptographic immutability of the identity itself (beyond "root is honest") would need a TEE or
// similar — a FUTURE layer, not claimed now. Any UI describing a profile must say this plainly.
//
// Same .data file-backed pattern as applications.ts / developers.ts / agents.ts; under portal/.data
// (gitignored). The real architecture distributes these to each party's node; the store surface
// doesn't change when it does.

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt, verifySeal, type Seal } from "./seal";

/** The seal domain for a profile identity (public namespace; the secret is the per-profile salt). */
const PROFILE_DOMAIN = "vrx-profile";

/** Which kind of actor this profile belongs to. Mirrors the contract roles (Node/Org/Peer) in the words. */
export type ProfileRole = "developer" | "agency" | "agent";

/**
 * The KYC identity fields. Low-entropy PII (a legal name, a region) — exactly the case 's salt exists
 * for. These are the fields that auto-populate + seal into records; keep this the canonical minimal set so
 * the sealed snapshot is stable (display extras can live outside the seal, like the offer store does).
 */
export type ProfileIdentity = {
  /** The actor's neutral on-chain account id — the join key to everything else. */
  account: string;
  /** developer | agency | agent. */
  role: ProfileRole;
  /** Legal / registered name (person or company), as verified at vetting. */
  legalName: string;
  /** Operating region (country / city) — coarse, verified. */
  region: string;
};

/** The full stored profile: the sealed identity + the salt + vetting metadata + optional free details. */
export type Profile = ProfileIdentity & {
  /** Per-profile secret salt. Stored only here, NEVER on-chain. Lose it → records stop re-verifying. */
  salt: string;
  /** SHA-256(domain | salt | identity) — the tamper-evident seal of the identity above. */
  identityHash: string;
  /** Free-text extra KYC notes root keeps (contact, registration no.) — NOT part of the sealed identity. */
  notes?: string;
  /** ms epoch the profile was vetted/set by root. */
  vettedAt: number;
  /** ms epoch last corrected by root (on an approved change request). */
  updatedAt: number;
  /** The root account that last set/edited it (audit trail). */
  setBy?: string;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "profiles.json");

async function readAll(): Promise<Profile[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Profile[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Profile[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** The canonical identity object that gets sealed — exactly these fields, verbatim. */
function identityPayload(p: ProfileIdentity): Record<string, unknown> {
  return { account: p.account, role: p.role, legalName: p.legalName, region: p.region };
}

/** All profiles, newest-vetted first. (Server-side; the API decides what to expose + to whom.) */
export async function listProfiles(): Promise<Profile[]> {
  return (await readAll()).sort((a, b) => b.vettedAt - a.vettedAt);
}

/** One profile by account (case-insensitive), or null. */
export async function getProfile(account: string): Promise<Profile | null> {
  const a = account.trim().toLowerCase();
  if (!a) return null;
  return (await readAll()).find((p) => p.account.toLowerCase() === a) ?? null;
}

/** True iff the stored identity + salt re-hash to the stored identityHash — the ✓ Vetted check. */
export function verifyProfile(p: Profile): boolean {
  return verifySeal(identityPayload(p), PROFILE_DOMAIN, { salt: p.salt, hash: p.identityHash });
}

/**
 * ROOT-ONLY: set or correct a profile (the ONLY write path — the API route gates this with the operator
 * secret, there is no user-facing edit). Re-seals the identity with a FRESH salt + hash each time it's set
 * (a correction is a new seal — the prior identity's seal simply no longer applies). Idempotent on account.
 */
export async function setProfile(
  identity: ProfileIdentity,
  opts?: { notes?: string; setBy?: string }
): Promise<Profile> {
  const account = identity.account.trim();
  if (!account) throw new Error("account required");
  const id: ProfileIdentity = {
    account,
    role: identity.role,
    legalName: identity.legalName.trim(),
    region: identity.region.trim(),
  };
  const salt = newSalt();
  const identityHash = digest(identityPayload(id), PROFILE_DOMAIN, salt);
  const now = Date.now();

  const list = await readAll();
  const idx = list.findIndex((p) => p.account.toLowerCase() === account.toLowerCase());
  const prior = idx >= 0 ? list[idx] : null;
  const rec: Profile = {
    ...id,
    salt,
    identityHash,
    notes: opts?.notes?.trim() || prior?.notes,
    vettedAt: prior?.vettedAt ?? now,
    updatedAt: now,
    setBy: opts?.setBy?.trim() || prior?.setBy,
  };
  if (idx >= 0) list[idx] = rec;
  else list.push(rec);
  await writeAll(list);
  return rec;
}

/**
 * The minimal, verifiable identity SNAPSHOT a consuming record (an agreement, later an offer) embeds into
 * its sealed payload so ✓ Vetted attests WHO. Returns the identity fields + the profile's seal so the
 * consumer stores both and can re-verify the identity independently. null if the account has no profile
 * (then the record carries no identity claim — honest absence, not a fake).
 */
export async function identityForSeal(
  account: string
): Promise<(ProfileIdentity & { seal: Seal }) | null> {
  const p = await getProfile(account);
  if (!p) return null;
  return {
    account: p.account,
    role: p.role,
    legalName: p.legalName,
    region: p.region,
    seal: { salt: p.salt, hash: p.identityHash },
  };
}

/** Public-safe projection — a vetted actor's NAME + region + vetting age, no notes/salt. For cards. */
export function publicProfile(p: Profile) {
  return {
    account: p.account,
    role: p.role,
    legalName: p.legalName,
    region: p.region,
    vettedAt: p.vettedAt,
  };
}
