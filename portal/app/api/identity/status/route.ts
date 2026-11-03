// /api/identity/status?account=<acct>[&tz=<IANA>] — the composed identity picture for ONE account:
//   its immutable ISSUANCE anchors ("VRX-vetted as of T", Bitcoin-anchored — lib/identity-stamp) PLUS its mutable
//   CURRENT status (active | revoked + since + neutral reason — lib/identity-revocation). A reader renders BOTH
//   honestly: "VRX-vetted as of <T> (Bitcoin confirmation pending) · ⚠ vetting REVOKED as of <T2> (fraud)".
//
// AUTH — PUBLIC by design (NOT caller-scoped), REVIEWED + allowlisted in lib/route-auth-coverage.test.ts.
// ⚠ Do NOT "fix" this by adding requireCaller — that would BREAK the counterparty-visibility guarantee below.
// Vetting status is COUNTERPARTY-VISIBLE: the whole point of a
// vetting badge is that the other side of a deal can see who they're dealing with (same posture as GET /api/profiles,
// which serves public profiles to counterparties). The response is already a public-safe projection: the account
// HANDLE (public in-system), a neutral tier, timestamps, a neutral reason enum, and OTS anchor status/labels. NO PII,
// NO KYC payload, NO salt — those never leave lib/profiles. So there is no cross-tenant leak to gate here; a stranger
// seeing "account X is VRX-vetted, not revoked" is the intended, designed disclosure.
//
// ⚠ NOT AN AUTHORIZATION. This read surfaces TRUTH (what was vetted at T + what's true now); it never gates an
// action. A gate stays explicit + elsewhere (the "a stamp is provenance, not authorization" invariant).
//
// PRIVACY: hash-only anchors; no amount, no PII. tz only affects DATE display (viewer's day boundary).

import { NextResponse } from "next/server";
import { identityWithCurrentStatus } from "@/lib/identity-revocation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  // tz is the VIEWER's IANA zone (so "as of <date>" respects their day boundary, not UTC). Optional.
  const tz = url.searchParams.get("tz")?.trim() || undefined;

  const picture = await identityWithCurrentStatus(account, tz);
  // Project to a public-safe shape: the current status view + the issuance anchors as {status,label} + the
  // ready "as of" labels. No salt, no KYC, no raw store rows.
  return NextResponse.json({
    account: picture.account,
    current: picture.current, // { account, state, since, reasonCode?, label }
    issuance: picture.issuance.map((v) => ({ status: v.status, label: v.label, stampedAt: v.stampedAt, provenAt: v.provenAt ?? null })),
    issuanceLabels: picture.issuanceLabels, // "VRX-vetted as of <date> (<seal state>)", viewer-TZ
  });
}
