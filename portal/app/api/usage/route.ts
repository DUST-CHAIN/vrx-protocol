// GET  /api/usage  → our RPC-call usage estimate (owner dashboard). FastNEAR has no credits API, so this
//  is what WE measured (calls through the key) + any baseline entered + the real
//                    dashboard LINK (the source of truth).
// POST /api/usage  { baselineCredits } → record the reserve balance read off the dashboard (for a
//                    remaining estimate); { reset: true } → start a new counting period.
//
// Owner-gated with the same VRX_OPERATOR_SECRET convention as the faucet log (no secret → open, demo).

import { NextResponse } from "next/server";
import { getUsage, setBaseline, resetUsage } from "@/lib/rpc-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The FastNEAR dashboard for this project (the — project VRX, id 226). Source of truth for credits.
const DASHBOARD_URL = "https://dashboard.fastnear.com/dashboard/226";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

function withDerived(u: Awaited<ReturnType<typeof getUsage>>) {
  // Rough remaining estimate = baseline − (callsNow − callsWhenBaselineSet). ~1 credit/call assumed.
  const usedSinceBaseline =
    u.baselineCalls != null ? Math.max(0, u.calls - u.baselineCalls) : null;
  const remainingEstimate =
    u.baselineCredits != null && usedSinceBaseline != null
      ? Math.max(0, u.baselineCredits - usedSinceBaseline)
      : null;
  return { ...u, usedSinceBaseline, remainingEstimate, dashboardUrl: DASHBOARD_URL };
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(withDerived(await getUsage()));
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { baselineCredits?: number; reset?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (body.reset) return NextResponse.json(withDerived(await resetUsage()));
  if (typeof body.baselineCredits === "number" && body.baselineCredits >= 0) {
    return NextResponse.json(withDerived(await setBaseline(body.baselineCredits)));
  }
  return NextResponse.json({ error: "nothing_to_do" }, { status: 400 });
}
