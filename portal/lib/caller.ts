// requireCaller — the ONE seam every API route reads the caller's identity from (F1 signing arc).
//
// THE WHOLE POINT (Finding F1): today ~57 sites do `searchParams.get("account|viewer|by|…")` and
// trust the value as-is — forgeable. This seam replaces "whatever the client claimed" with "who the server
// can PROVE the caller is" (a verified session, lib/session.ts, minted after a NEP-413 proof). Routes adopt
// it incrementally; the one place the identity SOURCE lives means flipping honour-system → guaranteed
// happens here, not in 57 edits (mirrors lib/participant.ts's "change it in exactly one place" design).
//
// ROLLOUT POSTURE (FAIL-CLOSED BY DEFAULT — flipped after audit VRX-0001; strict even on the demo):
//   • VRX_REQUIRE_SIGNIN unset/1  → STRICT mode (the DEFAULT now). Identity MUST come from a VERIFIED SESSION;
//     a route with no proven caller refuses (401, fail closed). A bare client-supplied `?account=` is NO LONGER
//     trusted — this is the fix for the anonymous cross-tenant impersonation root cause.
//   • THE PUBLIC DEMO is NOT exempt. The wallet-less demo (vrx.poolo.org, NEXT_PUBLIC_VRX_DEMO=1) mints a REAL
//     demo-session cookie when a role is assumed (POST /api/session/demo → mintSession, fenced to demo builds),
//     so it reaches identity through the SAME session path as a real sign-in. A demo browser can therefore only
//     act as the account in ITS OWN cookie → the IDOR is closed on the live demo too, with no-login UX intact.
//  ⚠ This means the demo deploy MUST set a strong VRX_SESSION_SECRET — otherwise getSecret falls back to the
//     repo-public constant (VRX-0009) and a demo session becomes forgeable, reopening VRX-0001.
//   • VRX_REQUIRE_SIGNIN=0        → PARAM-FALLBACK (opt-IN, a deliberate dev/testing escape only). Not used by
//     the public demo anymore. Never unset-by-accident into insecure: unset means STRICT.
//   • god-mode (localnet :3030)   → short-circuits to the dev-switcher account (the ?account= param), fenced to
//  localnet so local dev keeps working; can never arm off localnet.
//
// A route migrates by swapping `new URL(req.url).searchParams.get("viewer")` → `requireCaller(req, {param})`.
// Until a route migrates it keeps reading the param directly — so this is a safe, per-route, reversible pass.

import { readSessionToken, sessionTokenFromRequest } from "./session";
import { godModeArmed } from "./dev-signer-fence";

/**
 * Strict mode on? FAIL-CLOSED BY DEFAULT (audit VRX-0001): identity MUST be a verified session (or the
 * armed demo/god-mode posture). Only an EXPLICIT `VRX_REQUIRE_SIGNIN=0` re-opens the old param-fallback — which
 * is the deliberate wallet-less public-demo posture, never the accidental default.
 */
export const REQUIRE_SIGNIN = process.env.VRX_REQUIRE_SIGNIN !== "0";

export type Caller =
  | { ok: true; account: string; source: "session" | "param" | "god-mode" }
  | { ok: false; status: 401; reason: "signin_required" };

/**
 * Resolve the caller's PROVEN identity for an API route.
 *
 * @param req    the incoming Request (carries the session cookie).
 * @param opts.param  the legacy client-supplied identity (what the route used to read from the query), used
 *                    as the god-mode account and, in param-fallback mode, as the fallback when no session.
 *
 * Resolution order:
 *   1. god-mode (localnet)      → trust `opts.param` as the dev-switcher account (bypass, fenced to :3030).
 *   2. verified session present → use it. This is the identity path for a real sign-in AND the demo (whose
 *                                 picker mints a demo-session cookie) — a client param can never override it.
 * 3. no session, strict mode → refuse (401 signin_required), fail closed. THE DEFAULT (VRX-0001).
 *   4. no session, param-fallback (VRX_REQUIRE_SIGNIN=0, opt-IN dev escape) → use `opts.param` (empty → refuse).
 */
export function requireCaller(req: Request, opts: { param?: string | null }): Caller {
  const param = (opts.param ?? "").trim().toLowerCase();

  // 1) god-mode: the dev switcher is the identity source on localnet (no real wallet to sign).
  if (godModeArmed()) {
    if (!param) return { ok: false, status: 401, reason: "signin_required" };
    return { ok: true, account: param, source: "god-mode" };
  }

  // 2) a verified session always wins. This is the identity path for BOTH a real NEP-413 sign-in AND the
  //    wallet-less public demo: the demo picker mints a real demo-session cookie (/api/session/demo) when a role
  //    is assumed, so even the no-login demo carries a proven, single-account identity here. That is what closes
  //    the cross-tenant IDOR ON the live demo (a browser can only ever act as the account in its OWN cookie) —
  //    the seam no longer trusts a client-supplied `?account=` just because a demo build is running (VRX-0001).
  const sessionAccount = readSessionToken(sessionTokenFromRequest(req));
  if (sessionAccount) return { ok: true, account: sessionAccount, source: "session" };

  // 3) strict mode (THE DEFAULT, VRX-0001) with no session → refuse, fail closed. The demo reaches here only
  //    before its session cookie lands (first paint / a cleared cookie); the next request carries the cookie.
  if (REQUIRE_SIGNIN) return { ok: false, status: 401, reason: "signin_required" };

  // 4) param-fallback — opt-IN only (VRX_REQUIRE_SIGNIN=0), a deliberate dev/testing escape: accept the legacy
  //    param, refuse if empty. Not used by the public demo anymore (it has a session); kept for local workflows.
  if (!param) return { ok: false, status: 401, reason: "signin_required" };
  return { ok: true, account: param, source: "param" };
}
