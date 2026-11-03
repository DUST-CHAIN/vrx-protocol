// SESSION REVOCATION SEAM — SERVER-ONLY, file-backed with a synchronous in-memory cache.
//
// WHY THIS EXISTS (OPEN_ITEMS 🔑 "have the place to plug it in"): the vrx_session cookie is a
// STATELESS HMAC bearer token — a copy impersonates the user until it expires, and the stateless design has NO
// way to kill a specific session before expiry (rotating VRX_SESSION_SECRET logs EVERYONE out). When a user
// reports a hack / lost device / stolen cookie, VRX must be able to revoke THEIR session(s) without a global
// logout. This is that seam: a thin "revoked" layer readSessionToken consults after the HMAC + expiry pass.
//
// ── DESIGN: two revocation primitives (both common support flows) ────────────────────────────────────────────
//   • revoke ONE session by its id (sid)        — "kill this specific stolen cookie" (session carries a sid).
//   • revoke ALL of an account's sessions before T — "log me out everywhere / I lost my device": a per-account
//     cutoff; any session minted (iat) before the cutoff fails, without touching other users. Re-login mints a
//     session with iat ≥ cutoff, so the user is NOT locked out — only the old cookies die.
//
// ── Why a SYNC check over an async store ─────────────────────────────────────────────────────────────────────
// readSessionToken is synchronous (it's on the hot path of every authenticated request via requireCaller, and
// is called sync throughout). Revocations are RARE and the revoked set is TINY, so we keep the authoritative
// data in a small file (survives restarts) but mirror it into a process-memory cache that isRevoked reads
// SYNCHRONOUSLY. The cache is loaded once at module init (best-effort) and updated in-process on every write, so
// a revoke takes effect immediately on THIS node. (Multi-node note below — same caveat the nonce store carries.)
//
// ── Fail-safe posture ────────────────────────────────────────────────────────────────────────────────────────
// A store/cache hiccup must NOT lock everyone out: isRevoked defaults to FALSE (not-revoked) on any doubt — a
// revocation layer that fails OPEN (session still valid) degrades to today's stateless behaviour, which is the
// safe direction for availability. The HMAC + expiry are the primary guards; this only ADDS the ability to kill.
//
// ── Multi-node caveat (same as the sign-in nonce store) ──────────────────────────────────────────────────────
// The in-memory cache is per-process. On a single-node deploy (the demo) this is correct + immediate. A
// multi-node deploy would back the cache with a shared store (or re-read the file on a short TTL) so a revoke on
// one node reaches the others; the FILE is the source of truth either way. Noted, not needed for the demo.
//
// PRIVACY: stores only an opaque session id (sid) + a lowercased account + ms timestamps. No PII, no token.

import { promises as fs } from "fs";
import { readFileSync } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "session-revocations.json");

/** The persisted revocation state. `sessions` = individually-killed session ids; `accounts` = per-account
 *  "revoke everything minted before this ms epoch" cutoffs (the newest cutoff wins). */
type RevocationState = {
  /** Explicitly-revoked individual session ids (sid). A session whose sid is here fails even if HMAC+exp pass. */
  sessions: string[];
  /** account (lowercased) → cutoff ms epoch: any session with iat < cutoff is revoked. */
  accounts: Record<string, number>;
};

const EMPTY: RevocationState = { sessions: [], accounts: {} };

// ── In-memory cache (the SYNC read path) ─────────────────────────────────────────────────────────────────────
// Mirrors the file; isRevoked reads THIS synchronously. Writes update both the file and this cache. Seeded
// best-effort at module load (a missing/garbage file → empty = nothing revoked, the safe default).
let cache: RevocationState = loadSync();
let revokedSids = new Set<string>(cache.sessions);

function loadSync(): RevocationState {
  try {
    const raw = readFileSync(STORE, "utf8");
    const parsed = JSON.parse(raw) as Partial<RevocationState>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter((s) => typeof s === "string") : [],
      accounts:
        parsed.accounts && typeof parsed.accounts === "object"
          ? Object.fromEntries(
              Object.entries(parsed.accounts).filter(([, v]) => typeof v === "number" && isFinite(v))
            )
          : {},
    };
  } catch {
    return { sessions: [], accounts: {} };
  }
}

function refreshDerived() {
  revokedSids = new Set<string>(cache.sessions);
}

// ── Serialized writes (the concurrency guard — two revokes never interleave a read-modify-write) ──────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (state: RevocationState) => { next: RevocationState; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    // Re-read the file so a concurrent process's write isn't clobbered (the file is the source of truth).
    const current = await readFile();
    const { next, ret } = fn(current);
    await writeFile(next);
    cache = next;
    refreshDerived();
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readFile(): Promise<RevocationState> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw) as Partial<RevocationState>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter((s) => typeof s === "string") : [],
      accounts:
        parsed.accounts && typeof parsed.accounts === "object"
          ? Object.fromEntries(
              Object.entries(parsed.accounts).filter(([, v]) => typeof v === "number" && isFinite(v))
            )
          : {},
    };
  } catch {
    return { sessions: [], accounts: {} };
  }
}

async function writeFile(state: RevocationState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(state, null, 2), "utf8");
}

/** The claims shape isRevoked checks. `sid`/`iat` are OPTIONAL — a legacy token minted before this seam has
 *  neither, so it can't be individually revoked (it simply expires within the 6h TTL). An account cutoff with no
 *  iat on the token can't be evaluated per-session, so such a token is treated as NOT revoked (fail-safe). */
export type RevocableClaims = { account: string; sid?: string; iat?: number };

/**
 * SYNC revocation check — the hot path. Returns true if this session should be refused despite a valid HMAC +
 * unexpired exp. Reads the in-memory cache only (no I/O). Fail-safe: any ambiguity → false (not revoked).
 *   1. sid explicitly revoked → revoked.
 *   2. the account has a cutoff AND the token's iat is BEFORE it → revoked (log-out-everywhere).
 */
export function isRevoked(claims: RevocableClaims): boolean {
  if (claims.sid && revokedSids.has(claims.sid)) return true;
  const cutoff = cache.accounts[claims.account?.toLowerCase?.() ?? ""];
  if (typeof cutoff === "number" && typeof claims.iat === "number" && claims.iat < cutoff) return true;
  return false;
}

/** Revoke ONE session by its id (the "kill this stolen cookie" primitive). Idempotent. Persists + updates the
 *  sync cache so the next request on this node is refused immediately. */
export async function revokeSession(sid: string): Promise<void> {
  const id = (sid ?? "").trim();
  if (!id) return;
  await mutate((state) => {
    if (state.sessions.includes(id)) return { next: state, ret: undefined };
    return { next: { ...state, sessions: [...state.sessions, id] }, ret: undefined };
  });
}

/** Revoke ALL of an account's sessions minted before `before` (default: now) — "log me out everywhere". A later
 *  re-login mints iat ≥ before, so the user is not locked out; only older cookies die. Monotonic: a new cutoff
 *  only ever moves forward (a smaller cutoff never un-revokes already-killed sessions). */
export async function revokeAllForAccount(account: string, before: number = Date.now()): Promise<void> {
  const acct = (account ?? "").trim().toLowerCase();
  if (!acct || !isFinite(before)) return;
  await mutate((state) => {
    const existing = state.accounts[acct] ?? 0;
    const cutoff = Math.max(existing, before);
    return { next: { ...state, accounts: { ...state.accounts, [acct]: cutoff } }, ret: undefined };
  });
}

/** Test/ops helper: the current revocation state (a copy). Not on the hot path. */
export function revocationSnapshot(): RevocationState {
  return { sessions: [...cache.sessions], accounts: { ...cache.accounts } };
}

/** Test helper: clear all revocations (used by the test harness to isolate cases). SERVER-ONLY. */
export async function _clearRevocationsForTest(): Promise<void> {
  await mutate(() => ({ next: { sessions: [], accounts: {} }, ret: undefined }));
}
