// AI Sales Director — the autonomous SIGNING VAULT: the pure AUTHORIZATION CORE (slice 9,
// the design docs §9b, D-). SERVER-ONLY, file-backed. [[ai-desk-autonomous-signing-vault-vision]].
//
// ── What this is (and what it deliberately is NOT yet) ─────────────────────────────────────────────────────
// The real on-chain grant_exclusive is NODE-signed (contract/src/lib.rs:1215 — predecessor must be the developer
// node). An AUTONOMOUS AI open_unit therefore can't sign it without a node key reachable by the server, which
// breaks "the route never holds a key." The vault's job: let the AI obtain EXACTLY ONE signature, for EXACTLY
// ONE unit+deal+window, ONLY when an external human issues a one-time AUTHORIZATION — so the key is never a
// standing capability the AI can abuse.
//
// This module is the APP-LAYER authorization half (the pure, testable, secret-light core):
//   • a one-time authorization TOKEN, BOUND to a scope (dealId, buildingId, unitId, window), SINGLE-USE, EXPIRING.
//  • evaluateAuthorization — a PURE decision: approve (matches scope, unused, unexpired) or a typed deny.
//  • consumeAuthorization — mark it used, idempotent per (token, scope).
// It is channel-agnostic (a TAN code list / a TG-OTP reply / a co-signer share all PRESENT a token to this core)
// and provider-agnostic. It does NOT go on-chain and does NOT open a live channel — both are V7-gated legs
// (grant_exclusive is in the V7 contract batch, not on testnet). This proves the authorization LOGIC cheaply so
// the V7 wiring is a contained swap, not a rewrite (the §0 split).
//
// ── Secret handling (spine, no new crypto) ────────────────────────────────────────────────────────────
// The token's SECRET value is NEVER stored in the clear. We persist a SALTED SEAL of it (lib/seal — the same
// primitive the soft-holds use): a store leak reveals sealed hashes + scopes, not live tokens. The plaintext
// token is returned to the ISSUER exactly ONCE (issueAuthorization) and then only its seal lives on disk — the
// issuer hands it to the human authorizer out-of-band (the TAN sheet / the TG prompt). To check a presented
// token we re-seal it with the record's salt and compare (constant work, no reverse lookup by value).
//
// ── Grain ──────────────────────────────────────────────────────────────────────────────────────────────────
// One authorization record per issued token. Keyed by an opaque record id; found at check time by matching the
// presented token's seal against the un-consumed, unexpired records for the requested SCOPE. A token authorizes
// ONE grant: consuming it marks it used (idempotent for the SAME scope so a retried identical grant doesn't fail
// or double-spend). Used/expired/revoked tokens are KEPT (audit), never deleted.
//
// ── Machine note ───────────────────────────────────────────────────────────────────────────────────────────
// Any SEED .data/ai-signing-auth.json must be written with the Write tool (clean UTF-8/LF) — NEVER a PowerShell
// Set-Content/here-string (BOM + CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { digest, newSalt } from "../seal";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "ai-signing-auth.json");

/** The seal domain tag for signing-authorization tokens (PUBLIC namespace; the SECRET is the per-record salt +
 * the token value itself, which never persists in the clear). */
const AUTH_DOMAIN = "vrx-ai-signing-auth";

/** Default lifetime of an issued authorization if the caller gives none: 30 min. A human-in-the-loop approval is
 *  expected promptly; a stale authorization is a risk, so it expires fast. The window is independent of the HOLD
 *  window (the hold's L1 2h lives in the signing seam) — this is how long the AUTHORIZATION to sign is good for. */
export const DEFAULT_AUTH_TTL_MS = 30 * 60 * 1000;

/** The scope an authorization is BOUND to. A token approves a grant ONLY for this exact tuple — a different unit,
 *  deal, or building is a scope_mismatch (the human approved a SPECIFIC hold, nothing else). */
export type AuthScope = {
  dealId: string;
  buildingId: string;
  unitId: string;
};

/** A persisted authorization record. The token value is NOT here — only its seal (salt + hash). */
export type AuthRecord = {
  /** Opaque record id. */
  id: string;
  scope: AuthScope;
  /**: per-record secret salt. The token's seal = digest(token, AUTH_DOMAIN, salt). */
  salt: string;
  /** SHA-256 seal of the one-time token value under the domain + salt. The ONLY trace of the token on disk. */
  tokenSeal: string;
  /** Which channel issued this (audit only; the core treats them identically). */
  channel: "code_list" | "tg_otp" | "co_signer";
  /** ms epoch issued. */
  issuedAt: number;
  /** ms epoch the authorization expires (can no longer approve a grant). */
  expiresAt: number;
  /** CONSUMED marker — set when a grant used this token. Idempotent: carries the dealId it was spent on so a
   *  retried identical grant re-reads it as the same spend rather than a fresh one. */
  consumed?: { at: number; dealId: string };
  /** REVOKED marker — a human/operator cancelled this authorization before use. */
  revoked?: { at: number; reason: string };
};

/** What a caller PRESENTS to spend an authorization: the plaintext token + the grant it's for. */
export type PresentedAuth = {
  /** The one-time token value (from the TAN sheet / the TG reply). Checked by re-sealing, never looked-up raw. */
  token: string;
  scope: AuthScope;
};

/** The vault's verdict on a presented authorization. `approve` carries the matched record id so the caller can
 *  CONSUME exactly that record. `deny` is typed so the reply can be honest about WHY. */
export type AuthVerdict =
  | { ok: true; decision: "approve"; recordId: string }
  | { ok: false; decision: "deny"; reason: "no_token" | "scope_mismatch" | "used" | "expired" | "revoked" };

const norm = (s: string | undefined) => (s ?? "").trim();
const lc = (s: string | undefined) => norm(s).toLowerCase();

/** Two scopes refer to the same grant? (case-insensitive on ids — matches the rest of the desk's id handling). */
function sameScope(a: AuthScope, b: AuthScope): boolean {
  return lc(a.dealId) === lc(b.dealId) && lc(a.buildingId) === lc(b.buildingId) && lc(a.unitId) === lc(b.unitId);
}

/** Seal a token value for storage/compare (spine). The scope is NOT in the seal — the scope is stored
 *  the clear (it's not a secret: unit/deal ids are already the desk's opaque refs) and matched separately. */
function sealToken(token: string, salt: string): string {
  return digest(token, AUTH_DOMAIN, salt);
}

// ── Store IO (mirrors unit-holds / vrx-receipts: a promise chain so concurrent writes can't clobber) ─────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: AuthRecord[]) => Promise<{ next: AuthRecord[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<AuthRecord[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuthRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: AuthRecord[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** Options for issuing an authorization. */
export type IssueOptions = {
  channel?: AuthRecord["channel"];
  /** Lifetime in ms (defaults to DEFAULT_AUTH_TTL_MS). */
  ttlMs?: number;
  /** Explicit "now" (test/replay hook) — defaults to Date.now. */
  asOf?: number;
  /** TEST/CHANNEL hook: supply the token value (e.g. a pre-printed TAN code) instead of a random one. The core
   *  still only persists its SEAL. */
  token?: string;
};

/** The result of issuing: the plaintext token (returned ONCE — persist nothing of it but the seal) + the record. */
export type IssuedAuth = {
  /** The one-time token value — hand this to the human authorizer out-of-band. NOT stored in the clear. */
  token: string;
  record: AuthRecord;
};

/**
 * Issue a one-time authorization bound to a scope. Generates a random token (or accepts a channel-supplied one),
 * seals it, persists only the seal + scope + window, and returns the plaintext token ONCE. The caller delivers
 * the token to the human authorizer via the chosen channel (a TAN sheet, a TG-OTP prompt); the human presents it
 * back to authorize the grant. NO on-chain effect, NO live channel — this is the app-layer authorization issue.
 */
export async function issueAuthorization(scope: AuthScope, opts: IssueOptions = {}): Promise<IssuedAuth> {
  const dealId = norm(scope.dealId);
  const buildingId = norm(scope.buildingId);
  const unitId = norm(scope.unitId);
  if (!dealId || !buildingId || !unitId) throw new Error("signing-auth: dealId/buildingId/unitId required");

  const now = Number.isFinite(opts.asOf) && (opts.asOf as number) > 0 ? (opts.asOf as number) : Date.now();
  const ttl = Number.isFinite(opts.ttlMs) && (opts.ttlMs as number) > 0 ? (opts.ttlMs as number) : DEFAULT_AUTH_TTL_MS;
  // A random token if none supplied. 128-bit, hex — the issuer hands THIS to the human; only the seal persists.
  const token = norm(opts.token) || randomBytes(16).toString("hex");
  const salt = newSalt();

  const record: AuthRecord = {
    id: `auth-${now}-${randomBytes(3).toString("hex")}`,
    scope: { dealId, buildingId, unitId },
    salt,
    tokenSeal: sealToken(token, salt),
    channel: opts.channel ?? "code_list",
    issuedAt: now,
    expiresAt: now + ttl,
  };

  await mutate(async (list) => ({ next: [...list, record], ret: record }));
  return { token, record };
}

/**
 * Evaluate a PRESENTED authorization against a grant request. PURE DECISION (reads the store, no writes): finds
 * the record whose token seal matches the presented token FOR THE REQUESTED SCOPE, then checks it's live.
 *
 * Deny precedence (the most specific true reason wins, so the reply can be honest):
 *   • no_token       — no record's seal matches this token at all (wrong/garbage token).
 *   • scope_mismatch — a token matched, but NOT for this (deal, building, unit) — the human approved a diff hold.
 *   • revoked        — the matching record was cancelled.
 *   • used           — already consumed (single-use), UNLESS it was consumed for THIS SAME deal (idempotent
 *                      re-grant → still approve, so a retried identical open_unit doesn't fail).
 *   • expired        — past expiresAt at asOf.
 * approve → carries the recordId to consume.
 */
export async function evaluateAuthorization(
  presented: PresentedAuth,
  asOf: number = Date.now()
): Promise<AuthVerdict> {
  const token = norm(presented.token);
  if (!token) return { ok: false, decision: "deny", reason: "no_token" };
  const want = { dealId: norm(presented.scope.dealId), buildingId: norm(presented.scope.buildingId), unitId: norm(presented.scope.unitId) };
  const list = await readAll();

  // Does ANY record's seal match this token (regardless of scope)? If none, the token is simply unknown.
  const tokenMatches = list.filter((r) => r.tokenSeal === sealToken(token, r.salt));
  if (tokenMatches.length === 0) return { ok: false, decision: "deny", reason: "no_token" };

  // Of those, the one for THIS scope. A token-match on a DIFFERENT scope ⇒ the human approved another hold.
  const scoped = tokenMatches.find((r) => sameScope(r.scope, want));
  if (!scoped) return { ok: false, decision: "deny", reason: "scope_mismatch" };

  if (scoped.revoked) return { ok: false, decision: "deny", reason: "revoked" };

  // Single-use — but idempotent for the SAME deal (a retried identical grant re-reads its own spend as approved).
  if (scoped.consumed) {
    if (lc(scoped.consumed.dealId) === lc(want.dealId)) return { ok: true, decision: "approve", recordId: scoped.id };
    return { ok: false, decision: "deny", reason: "used" };
  }

  if (asOf >= scoped.expiresAt) return { ok: false, decision: "deny", reason: "expired" };

  return { ok: true, decision: "approve", recordId: scoped.id };
}

/**
 * Consume an approved authorization (mark it used for a deal). Idempotent: consuming an already-consumed record
 * for the SAME deal is a no-op that returns the record; for a DIFFERENT deal it throws (that must never happen —
 * evaluateAuthorization would have denied `used` first). Returns the consumed record, or null if the id is gone.
 */
export async function consumeAuthorization(recordId: string, dealId: string, asOf: number = Date.now()): Promise<AuthRecord | null> {
  const id = norm(recordId);
  const deal = norm(dealId);
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return { next: list, ret: null };
    const rec = list[idx];
    if (rec.consumed) {
      if (lc(rec.consumed.dealId) !== lc(deal)) throw new Error("signing-auth: token already consumed for a different deal");
      return { next: list, ret: rec }; // idempotent re-consume for the same deal
    }
    const consumed: AuthRecord = { ...rec, consumed: { at: asOf, dealId: deal } };
    const next = [...list];
    next[idx] = consumed;
    return { next, ret: consumed };
  });
}

/** Revoke an issued authorization before use (a human/operator cancels). No-op if already consumed/revoked. */
export async function revokeAuthorization(recordId: string, reason: string, asOf: number = Date.now()): Promise<AuthRecord | null> {
  const id = norm(recordId);
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return { next: list, ret: null };
    const rec = list[idx];
    if (rec.consumed || rec.revoked) return { next: list, ret: rec };
    const revoked: AuthRecord = { ...rec, revoked: { at: asOf, reason: norm(reason) || "revoked" } };
    const next = [...list];
    next[idx] = revoked;
    return { next, ret: revoked };
  });
}

/** The PUBLIC projection of an auth record — strips the salt + tokenSeal (never served). Scope + status stay so a
 *  /root audit panel can show "an authorization for unit X, deal Y, consumed/expired/live" without the secret. */
export function publicAuth(r: AuthRecord): Omit<AuthRecord, "salt" | "tokenSeal"> {
  const { salt: _s, tokenSeal: _t, ...rest } = r;
  void _s; void _t;
  return rest;
}

/** TEST-ONLY reset (the store is cwd-scoped via DATA_DIR; tests chdir to a temp dir). */
export async function __resetForTests(): Promise<void> {
  await writeAll([]);
}
