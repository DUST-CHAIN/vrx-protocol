// /api/settlement/balance — ON-DEMAND wallet balance read for the developer settlement view (the
// "is the developer's balance OK to pay the VRX bill?"). DELIBERATELY its own endpoint, hit only when the
// developer clicks "Check my balance" — honouring the standing rule "nothing hits FastNEAR unless it's a
// must" (a balance read is a chain read; we don't do it on every settlement-view open, only on request).
//
//   GET ?account=<acct> → { availableNear, availableUsd, rate } | { error }  (404 = never-funded account)
//
// This is a view_account RPC call (NO signing, no key beyond the server's read key) proxied THROUGH our
// server (the browser never calls RPC directly). availableUsd is INDICATIVE only: the balance is
// NEAR and the VRX bill is in USD, converted at the app's STATIC demo rate (USD_PER_NEAR, the same rate the
// eligibility bar uses) — not an authoritative FX figure. The UI labels the verdict "indicative" for that
// reason. PRIVACY: an account's NEAR balance is public on-chain anyway; no contract state / opaque refs read.

import { NextResponse } from "next/server";
import { getBalance } from "@/lib/balance-server";
import { USD_PER_NEAR } from "@/lib/offer-eligibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  try {
    const bal = await getBalance(account);
    if (!bal) return NextResponse.json({ error: "account not found or never funded" }, { status: 404 });
    return NextResponse.json({
      availableNear: bal.availableNear,
      availableUsd: Math.round(bal.availableNear * USD_PER_NEAR),
      rate: USD_PER_NEAR, // 1 NEAR = $rate (static demo rate; indicative only)
    });
  } catch {
    // Every endpoint failed (RPC outage) — surface it so the UI says "couldn't read" rather than a false 0.
    return NextResponse.json({ error: "balance unavailable right now" }, { status: 503 });
  }
}
