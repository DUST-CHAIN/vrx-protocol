// Verified session — SERVER-ONLY (F1 signing arc).
//
// After lib/nep413.ts proves the caller controls a NEAR account, we mint a short-lived session so the
// user signs ONCE (good mobile UX — the F1 arc is agent-mobile-facing) and every subsequent API call
// reads identity from the VERIFIED session instead of a forgeable query param. The session is a stateless,
// HMAC-signed token in an httpOnly cookie: no server-side session store to scale/evict, and a tampered or
// expired token simply fails to verify (fail closed).
//
// REPLAY / NONCE: the sign-in challenge (nonce) is single-use with a short TTL, tracked in-process here.
// A replayed proof (same nonce) is rejected because the nonce is consumed on first use. The process-memory
// store is fine for a single-node demo; a multi-node deploy would back this with a shared store (noted).
//
// SECRET: HMAC key from VRX_SESSION_SECRET. In dev/localnet a deterministic fallback keeps the demo
// working without config; a loud warning fires if it's missing in a non-localnet context (see getSecret).

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { godModeArmed } from "./dev-signer-fence";

// ── Tunables (one-line config) ─────────────────────────────────────────────────────────────────────
/** Session lifetime. the call: 24h; re-sign NOT required for high-stakes yet (that's the
 *  deferred Option-B layer). Change this one constant to retune. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a sign-in challenge (nonce) stays valid before the client must request a fresh one. */
export const NONCE_TTL_MS = 5 * 60 * 1000;
/** The cookie name the verified session rides in. */
export const SESSION_COOKIE = "vrx_session";

type SessionClaims = { account: string; exp: number };

// ── HMAC secret ──────────────────────────────────────────────────────────────────────────────────
function getSecret(): string {
  const fromEnv = process.env.VRX_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  // No real secret configured. On localnet (god-mode / dev) a deterministic fallback keeps the demo
  // alive; anywhere else this is a misconfiguration — warn loudly (the token is then only as strong as
  // a known constant, so a real deploy MUST set VRX_SESSION_SECRET).
  if (!godModeArmed()) {
    console.warn(
      "[session] VRX_SESSION_SECRET is unset/short — using a dev fallback. SET IT before any real deploy."
    );
  }
  return "vrx-dev-session-secret-not-for-production";
}

function sign(payloadB64: string): string {
  return createHmac("sha256", getSecret()).update(payloadB64).digest("base64url");
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Mint a signed session token for a PROVEN account. `now` is injectable for tests. */
export function mintSession(account: string, now: number = Date.now()): string {
  const claims: SessionClaims = { account: account.trim().toLowerCase(), exp: now + SESSION_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Verify + decode a session token. Returns the account, or null if tampered/expired/malformed. */
export function readSessionToken(token: string | undefined | null, now: number = Date.now()): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEq(sig, sign(payloadB64))) return null; // tampered or wrong secret
  try {
    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SessionClaims;
    if (typeof claims.account !== "string" || typeof claims.exp !== "number") return null;
    if (now >= claims.exp) return null; // expired
    return claims.account;
  } catch {
    return null;
  }
}

/** The Set-Cookie header value for a freshly minted session (httpOnly, SameSite=Lax, path=/). Secure
 *  only off-localnet (localnet is plain http). maxAge mirrors SESSION_TTL_MS. */
export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = godModeArmed() ? "" : " Secure;";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=${maxAge}`;
}

/** The Set-Cookie header value that CLEARS the session (sign-out). */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Read the raw session cookie value from a Request's Cookie header. */
export function sessionTokenFromRequest(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// ── Single-use sign-in nonces (replay guard) ───────────────────────────────────────────────────────
// Process-memory, TTL'd, single-use. A multi-node deploy would swap this for a shared store; for the
// demo (single node) this is correct and simple. Keyed by the base64 nonce itself.
const nonces = new Map<string, number>(); // nonce → issuedAt

function sweepNonces(now: number) {
  for (const [n, issued] of nonces) if (now - issued > NONCE_TTL_MS) nonces.delete(n);
}

/** Issue a fresh 32-byte challenge (base64) for the client to sign. */
export function issueNonce(now: number = Date.now()): string {
  sweepNonces(now);
  const nonce = randomBytes(32).toString("base64");
  nonces.set(nonce, now);
  return nonce;
}

/** Consume a nonce: true exactly once per issued, unexpired nonce; false if unknown/expired/reused. */
export function consumeNonce(nonce: string, now: number = Date.now()): boolean {
  const issued = nonces.get(nonce);
  if (issued === undefined) return false;
  nonces.delete(nonce); // single-use regardless of outcome
  return now - issued <= NONCE_TTL_MS;
}
