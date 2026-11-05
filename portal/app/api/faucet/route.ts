// POST /api/faucet  { account: "<id>" }
//
// The VRX gas faucet: auto-fund a vetted actor so their first on-chain write can pay gas + toll. Gated
// to provisioned/on-chain actors (lib/faucet-server.eligibility); rate-limited; skips already-funded
// accounts; logs a note to VRX root either way. Returns a small, UI-friendly shape (the vocab —
// the client maps reasons to plain copy, never leaks contract/error jargon).

import { NextResponse } from "next/server";
import { fundAccount } from "@/lib/faucet-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account : "";
  // `connect:true` marks the first-connect auto-fire (wallet.tsx). It alone unlocks the opt-in, testnet-only,
  // 1-ever stranger grant for a non-provisioned wallet (lib/faucet-server). A plain POST without it can never
  // drip a stranger — so a scraper hitting this route still gets the strict provisioned-only gate.
  const connect = body.connect === true;
  if (!account) return NextResponse.json({ ok: false, error: "account required" }, { status: 400 });
  const result = await fundAccount(account, { connect });
  // fundAccount returns ok:false only for real faults (misconfig / faucet empty / send failed) — 200
  // still, so the client can show a friendly message rather than a network error. Bad input → 400 above.
  return NextResponse.json(result);
}
