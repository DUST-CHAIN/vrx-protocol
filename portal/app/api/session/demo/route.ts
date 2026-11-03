// /api/session/demo — mint a DEMO session cookie for the wallet-less sandbox (audit VRX-0001 follow-on).
//
// WHY THIS EXISTS. The public demo (vrx.poolo.org, NEXT_PUBLIC_VRX_DEMO=1) is no-login: a visitor "assumes a
// role" via the landing picker, with no real wallet to sign a NEP-413 proof. Before the seam trusted the
// client's `?account=` param in demo mode — which is the SAME mechanism as the cross-tenant IDOR the external
// audit found (an anonymous browser could name ANY account). To close the IDOR *on the live demo itself* (not
// just on a hypothetical real deploy) we bind the demo browser to ONE account with a real signed session cookie,
// and make `requireCaller` strict everywhere (no param-trust branch). The demo stays one-click no-login; it just
// gets a proper session the moment a role is picked, so a browser can only ever act as the account in ITS cookie.
//
// SAFETY. This route refuses unless the SERVER is a demo/localnet build (demoRoleUxArmed) — a real production
// deploy (no demo flag, no god-mode) returns 403, so this is NOT an unauthenticated-session-minting backdoor in
// prod. The minted session is an ordinary lib/session token (HMAC-signed, httpOnly, 24h); the only difference
// from the real /api/session is that no NEP-413 proof is required, which is sound ONLY because the demo world is
// seeded aliases with no real PII and the mint is fenced to demo builds.

import { NextResponse } from "next/server";
import { mintSession, sessionCookie } from "@/lib/session";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { account } → mint a demo session cookie for that account. Demo/localnet builds only. */
export async function POST(req: Request) {
  if (!demoRoleUxArmed()) {
    return NextResponse.json({ error: "demo sessions are only available in the sandbox build" }, { status: 403 });
  }
  let body: { account?: unknown };
  try {
    body = (await req.json()) as { account?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const account = typeof body.account === "string" ? body.account.trim().toLowerCase() : "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  const token = mintSession(account);
  const res = NextResponse.json({ ok: true, account });
  res.headers.set("Set-Cookie", sessionCookie(token));
  return res;
}
