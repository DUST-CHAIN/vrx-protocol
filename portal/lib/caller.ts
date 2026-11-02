// requireCaller — the ONE seam every API route reads the caller's identity from (F1 signing arc).
// trust the value as-is — forgeable. This seam replaces "whatever the client claimed" with "who the server
// can PROVE the caller is" (a verified session, lib/session.ts, minted after a NEP-413 proof). Routes adopt
// it incrementally; the one place the identity SOURCE lives means flipping honour-system → guaranteed
// happens here, not in 57 edits (mirrors lib/participant.ts's "change it in exactly one place" design).
// ROLLOUT POSTURE (reversible, flagged, fail-closed):
// • VRX_REQUIRE_SIGNIN unset/0 → PARAM-FALLBACK mode (today's behaviour). A verified session is USED when
// present, else the legacy query param is accepted. Nothing breaks; the demo + unmigrated routes run as
// • VRX_REQUIRE_SIGNIN=1 → STRICT mode. Identity MUST come from a verified session; a route with no
// session refuses (fail closed). god-mode still bypasses on localnet.
// • god-mode (localnet:3030) → ALWAYS short-circuits to the dev-switcher account (the ?account= param),
// in BOTH modes, so the dev account switcher keeps working. Fenced: can never arm off localnet.
// A route migrates by swapping `new URL(req.url).searchParams.get("viewer")` → `requireCaller(req, {param})`.
// Until a route migrates it keeps reading the param directly — so this is a safe, per-route, reversible pass.

import { readSessionToken, sessionTokenFromRequest } from "./session";
import { godModeArmed } from "./dev-signer-fence";

/** Strict mode on? When true, identity MUST be a verified session (god-mode still bypasses on localnet). */
export const REQUIRE_SIGNIN = process.env.VRX_REQUIRE_SIGNIN === "1";

export type Caller =
  | { ok: true; account: string; source: "session" | "param" | "god-mode" }
  | { ok: false; status: 401; reason: "signin_required" };

/**
 * Resolve the caller's PROVEN identity for an API route.
 *
 * @param req the incoming Request (carries the session cookie).
 * @param opts.param the legacy client-supplied identity (what the route used to read from the query), used
 * as the god-mode account and, in param-fallback mode, as the fallback when no session.
 *
 * Resolution order:
 * 1. god-mode (localnet) → trust `opts.param` as the dev-switcher account (bypass, fenced).
 * 2. verified session present → use it (always preferred over the param, even in fallback mode).
 * 3. no session, strict mode → refuse (401 signin_required), fail closed.
 * 4. no session, fallback → use `opts.param` (legacy behaviour; empty param → refuse).
 */
export function requireCaller(req: Request, opts: { param?: string | null }): Caller {
  const param = (opts.param ?? "").trim().toLowerCase();

  // 1) god-mode: the dev switcher is the identity source on localnet (no real wallet to sign).
  if (godModeArmed()) {
    if (!param) return { ok: false, status: 401, reason: "signin_required" };
    return { ok: true, account: param, source: "god-mode" };
  }

  // 2) a verified session always wins.
  const sessionAccount = readSessionToken(sessionTokenFromRequest(req));
  if (sessionAccount) return { ok: true, account: sessionAccount, source: "session" };

  // 3) strict mode with no session → refuse.
  if (REQUIRE_SIGNIN) return { ok: false, status: 401, reason: "signin_required" };

  // 4) param-fallback (default this session): accept the legacy param, refuse if empty.
  if (!param) return { ok: false, status: 401, reason: "signin_required" };
  return { ok: true, account: param, source: "param" };
}
