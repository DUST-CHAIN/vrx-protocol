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
import { godModeArmed, demoRoleUxArmed } from "./dev-signer-fence";
import { isRevoked } from "./session-revocation";

// ── Tunables (one-line config) ─────────────────────────────────────────────────────────────────────
/** Session lifetime. the call: 6h (TIGHTENED from 24h: a copied bearer cookie impersonates the user
 *  until it expires, with no per-session revocation [stateless], so a shorter window limits a stolen-cookie blast
 *  radius. The real fix for high-stakes is RE-SIGN at the dangerous moment [deferred, OPEN_ITEMS] + a future
 *  revocation seam; this TTL is the cheap belt until then). Change this one constant to retune. */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
/** How long a sign-in challenge (nonce) stays valid before the client must request a fresh one. */
export const NONCE_TTL_MS = 5 * 60 * 1000;
/** The cookie name the verified session rides in. */
export const SESSION_COOKIE = "vrx_session";

// sid = an opaque per-session id (lets VRX revoke THIS session without a global secret rotation — seam).
// iat = issued-at ms (lets "revoke everything before T" work per-account). Both are OPTIONAL at READ time so a
// token minted BEFORE this seam (no sid/iat) still verifies — it just can't be individually revoked (it expires
// within the 6h TTL). mintSession always writes them now.
type SessionClaims = { account: string; exp: number; sid?: string; iat?: number };

// ── HMAC secret (FAIL-CLOSED off-localnet, audit VRX-0009) ─────────────────────────────────────
// Before this WARNED and used a public constant when VRX_SESSION_SECRET was unset — so anyone could
// forge a vrx_session for any account (the constant is in the public repo), which DEFEATED strict mode. Now
// the dev fallback is permitted ONLY where it's harmless: localnet god-mode, or an EXPLICIT wallet-less demo
// build (NEXT_PUBLIC_VRX_DEMO=1, where sessions aren't the auth path anyway). Any OTHER context with no real
// secret THROWS — a real deploy MUST set VRX_SESSION_SECRET, and a misconfigured one fails closed, not open.
const DEV_SESSION_FALLBACK = "vrx-dev-session-secret-not-for-production";

function getSecret(): string {
  const fromEnv = process.env.VRX_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  // No real secret. The public-constant fallback is safe ONLY where no real identity rides on it: localnet
  // god-mode, the explicit wallet-less demo build (sessions aren't the auth path there), or dev/test (no real
  // users). A genuine SERVING deploy is NODE_ENV=production without the demo flag — there, a forgeable session
  // is worse than none, so FAIL CLOSED (throw). The demo build is NODE_ENV=production too, but it sets
  // NEXT_PUBLIC_VRX_DEMO=1 → demoRoleUxArmed short-circuits above this check, so the live demo keeps working.
  if (godModeArmed() || demoRoleUxArmed() || process.env.NODE_ENV !== "production") return DEV_SESSION_FALLBACK;
  throw new Error(
    "[session] VRX_SESSION_SECRET is unset or too short in a production deploy — refusing to mint/verify a " +
      "forgeable session (set VRX_SESSION_SECRET to a strong value, or run the demo build with NEXT_PUBLIC_VRX_DEMO=1)."
  );
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

/** Mint a signed session token for a PROVEN account. `now` is injectable for tests. Every session now carries an
 *  opaque `sid` (so a single session can be revoked) + `iat` (so "revoke everything before T" works) — the
 *  revocation seam (lib/session-revocation). The HMAC covers the whole payload, so neither can be forged. */
export function mintSession(account: string, now: number = Date.now()): string {
  const claims: SessionClaims = {
    account: account.trim().toLowerCase(),
    exp: now + SESSION_TTL_MS,
    sid: randomBytes(12).toString("base64url"),
    iat: now,
  };
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
    // REVOCATION: HMAC + expiry passed, but VRX may have killed this session (reported hack / lost device)
    // without rotating the global secret. The check is SYNC + fail-safe (any doubt → not revoked). A legacy token
    // with no sid/iat can't be individually revoked — it just expires within the TTL.
    if (isRevoked({ account: claims.account, sid: claims.sid, iat: claims.iat })) return null;
    return claims.account;
  } catch {
    return null;
  }
}

/** The Set-Cookie header value for a freshly minted session (httpOnly, SameSite=Lax, path=/). `Secure` only
 *  in a real production deploy — localnet god-mode AND a local demo build run plain HTTP, where a Secure cookie
 * would be silently dropped (this bit the demo-session mint). In production (behind Cloudflare HTTPS)
 *  Secure is set. maxAge mirrors SESSION_TTL_MS. */
export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // Omit Secure only when we're plainly NOT on HTTPS: localnet god-mode (:3030 http) or any non-production
  // build (local dev/test runs http://localhost — a Secure cookie there is silently dropped; this bit the
  // demo-session mint). A production deploy (incl. the public demo, served HTTPS behind Cloudflare) keeps Secure.
  const plainHttp = godModeArmed() || process.env.NODE_ENV !== "production";
  const secure = plainHttp ? "" : " Secure;";
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
