// POST /api/identity/revoke — OPERATOR-ONLY (root). Withdraw or reinstate an account's vetting (the current-validity
// layer, lib/identity-revocation). Body:
//   { account, action: "revoke", reasonCode: "fraud"|"licence_lapsed"|"withdrawn"|"duplicate"|"other", tier? }
//   { account, action: "reinstate", tier? }
// Returns the resulting current-status view. Each revoke/reinstate ALSO anchors the event hash-only to OTS
// (symmetric with issuance — "VRX revoked X at T2" becomes durable + outsider-checkable).
//
// AUTH — operator-gated, REVIEWED + allowlisted in lib/route-auth-coverage.test.ts. `account` is the
// revocation TARGET (which party to revoke), NOT a self-identity scope — the x-vrx-operator secret is the real gate,
// so requireCaller is intentionally NOT used (same pattern as /api/profiles POST). Do NOT "fix" by adding it.
// FAIL CLOSED, the SAME convention as /api/profiles (the vetting write path): a revocation is
// a root KYC decision, so it must prove the operator secret (x-vrx-operator vs VRX_OPERATOR_SECRET). No secret
// configured ⇒ DENIED, unless the explicit VRX_DEMO_OPEN=1 local-demo escape. There is no user self-revoke by design.
//
// ⚠ This records + anchors the STATUS; it does not itself gate any action (provenance, not authorization — a gate
// stays explicit + elsewhere). PRIVACY: the store + anchor carry the handle, a neutral status, a timestamp, and
// a neutral reason enum — never free-text, never PII.

import { NextResponse } from "next/server";
import { revokeVetting, reinstateVetting, type RevocationReason } from "@/lib/identity-revocation";
import { type VettingTier } from "@/lib/identity-stamp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED (identical to /api/profiles authed). A missing secret means closed, not open.
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

const REASONS: RevocationReason[] = ["fraud", "licence_lapsed", "withdrawn", "duplicate", "other"];
const TIERS: VettingTier[] = ["developer", "agency", "agent", "buyer", "operator", "other"];

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const action = body.action === "reinstate" ? "reinstate" : body.action === "revoke" ? "revoke" : null;
  const tier = TIERS.includes(body.tier) ? (body.tier as VettingTier) : undefined;
  if (!account || !action) {
    return NextResponse.json({ error: "account and action (revoke|reinstate) required" }, { status: 400 });
  }

  if (action === "reinstate") {
    const view = await reinstateVetting({ account, tier });
    return NextResponse.json({ ok: true, current: view });
  }

  const reasonCode: RevocationReason = REASONS.includes(body.reasonCode) ? (body.reasonCode as RevocationReason) : "other";
  const view = await revokeVetting({ account, reasonCode, tier });
  return NextResponse.json({ ok: true, current: view });
}
