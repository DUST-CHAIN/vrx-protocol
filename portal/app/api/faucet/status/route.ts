// GET /api/faucet/status — operator snapshot of the gas faucet: balance, grants-remaining, reserve, and the
// faucet account id to top up. Powers the /root "Gas faucet" panel (the manual-refill UI — the faucet does
// NOT self-refill; an operator sends NEAR to this account when it runs low).
//
// Owner-gated with the same VRX_OPERATOR_SECRET convention as /api/faucet/log (no secret set → open, for the
// demo laptop). Read-only; no funds move here. PRIVACY: only neutral faucet config + balance, no PII.

import { NextResponse } from "next/server";
import { faucetStatus } from "@/lib/faucet-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await faucetStatus());
}
