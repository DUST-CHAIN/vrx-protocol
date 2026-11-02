// POST /api/faucet { account: "<id>" }
// The VRX gas faucet: auto-fund a vetted actor so their first on-chain write can pay gas + toll. Gated
// to provisioned/on-chain actors (lib/faucet-server.eligibility); rate-limited; skips already-funded
// the client maps reasons to plain copy, never leaks contract/error jargon).

import { NextResponse } from "next/server";
import { fundAccount } from "@/lib/faucet-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account : "";
  if (!account) return NextResponse.json({ ok: false, error: "account required" }, { status: 400 });
  const result = await fundAccount(account);
  // fundAccount returns ok:false only for real faults (misconfig / faucet empty / send failed) — 200
  // still, so the client can show a friendly message rather than a network error. Bad input → 400 above.
  return NextResponse.json(result);
}
