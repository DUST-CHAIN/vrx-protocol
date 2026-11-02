// api/session — the sign-in handshake (F1 signing arc).
// GET → issue a fresh single-use challenge (nonce + recipient) for the client to sign.
// POST → verify a NEP-413 proof (lib/nep413) + consume the nonce → mint a verified session cookie.
// DELETE → clear the session (sign-out).
// This is the ONLY place a session cookie is minted; everything downstream just reads it via
// lib/caller.ts requireCaller. god-mode (localnet) never needs this — the dev switcher is the identity
// source there — but the route stays strict (always requires a real, owned signature) so it can't be a
// weak link. Nothing on-chain; fail closed on any verification failure.

import { NextResponse } from "next/server";
import { verifyNep413Proof, SESSION_RECIPIENT, type Nep413Proof } from "@/lib/nep413";
import { issueNonce, consumeNonce, mintSession, sessionCookie, clearSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/session — hand the client a challenge to sign. */
export async function GET() {
  const nonce = issueNonce();
  return NextResponse.json({ nonce, recipient: SESSION_RECIPIENT });
}

/** POST /api/session — verify the signed challenge, mint the session. Body = the SignedMessage + the
 * nonce/recipient/message the client signed. */
export async function POST(req: Request) {
  let body: Partial<Nep413Proof>;
  try {
    body = (await req.json()) as Partial<Nep413Proof>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { accountId, publicKey, signature, nonce, recipient, message, callbackUrl } = body;
  if (!accountId || !publicKey || !signature || !nonce || !recipient || !message) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  // The proof must be for THIS app's recipient — a signature issued for another dApp won't authenticate.
  if (recipient !== SESSION_RECIPIENT) {
    return NextResponse.json({ error: "bad_recipient" }, { status: 400 });
  }
  // Single-use nonce: reject replays and stale/forged challenges BEFORE spending an RPC call.
  if (!consumeNonce(nonce)) {
    return NextResponse.json({ error: "stale_or_unknown_nonce" }, { status: 400 });
  }

  const result = await verifyNep413Proof({
    accountId,
    publicKey,
    signature,
    nonce,
    recipient,
    message,
    callbackUrl,
  });
  if (!result.ok) {
    const status = result.reason === "rpc_error" ? 503 : 401;
    return NextResponse.json({ error: result.reason }, { status });
  }

  const token = mintSession(result.account);
  const res = NextResponse.json({ ok: true, account: result.account });
  res.headers.set("Set-Cookie", sessionCookie(token));
  return res;
}

/** DELETE /api/session — sign out (clear the cookie). */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearSessionCookie());
  return res;
}
