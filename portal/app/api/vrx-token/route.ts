// /api/vrx-token — the real transferable $VRX ledger (replaces /api/demo-currency's play-money model).
// $VRX is a FIXED-SUPPLY (200M), TREASURY-HELD, TRANSFERABLE in-system credit. This route is the thin caller;
// lib/vrx-token.ts enforces the hard invariants (conservation, non-negative, claim cap). Off-chain ledger — no
// wallet crypto; the operator op is gated by the operator secret, user ops trust the resolved caller (same
// posture as the other off-chain stores).
//
//   GET  ?account=<acct>[&history=1][&limit=N]
//        → { account, balanceVrx, treasuryVrx, claim: {…}, history?: VrxHistoryRow[] }  (history only when requested)
//   POST { op:"claim",    account }               → { balanceVrx, claimsLeft }   — self-serve claim (75k ×2, ≥48h apart)
//   POST { op:"transfer", from, to, amount }      → { fromBalance, toBalance }    — holder→holder send
//   POST { op:"send",     to, amount }  (operator) → { toBalance, treasuryBalance } — treasury→account airdrop (x-vrx-operator)

import { NextResponse } from "next/server";
import {
  balanceOf, treasuryBalance, claimStatus, claim, transfer, operatorSend, historyOf, TREASURY_ACCOUNT,
} from "@/lib/vrx-token";
import { publish } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical posture to /api/root/* (fix #3). Only the treasury→account airdrop
// (op:send) needs it; claim/transfer are user-facing.
function operatorAuthed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1"; // dev convenience only; a real deploy sets the secret
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  const wantHistory = url.searchParams.get("history") === "1";
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const [balanceVrx, treasuryVrx, claim, history] = await Promise.all([
    balanceOf(account),
    treasuryBalance(),
    claimStatus(account),
    wantHistory ? historyOf(account, limit) : Promise.resolve(undefined),
  ]);
  return NextResponse.json({ account, balanceVrx, treasuryVrx, claim, ...(history ? { history } : {}) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const op = typeof body.op === "string" ? body.op : "";

  try {
    if (op === "claim") {
      const account = typeof body.account === "string" ? body.account.trim() : "";
      if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
      const res = await claim(account);
      publish("events");
      return NextResponse.json(res);
    }

    if (op === "transfer") {
      const from = typeof body.from === "string" ? body.from.trim() : "";
      const to = typeof body.to === "string" ? body.to.trim() : "";
      const amount = Number(body.amount);
      if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });
      // A user may not spoof a treasury-sourced move through the plain transfer op — that path is operator-only.
      if (from.toLowerCase() === TREASURY_ACCOUNT.toLowerCase()) {
        return NextResponse.json({ error: "treasury transfers require the operator (op:send)" }, { status: 403 });
      }
      const res = await transfer(from, to, amount);
      publish("events");
      return NextResponse.json(res);
    }

    if (op === "send") {
      if (!operatorAuthed(req)) return NextResponse.json({ error: "operator secret required" }, { status: 403 });
      const to = typeof body.to === "string" ? body.to.trim() : "";
      const amount = Number(body.amount);
      if (!to) return NextResponse.json({ error: "recipient (to) required" }, { status: 400 });
      const res = await operatorSend(to, amount);
      publish("events");
      return NextResponse.json(res);
    }

    return NextResponse.json({ error: "unknown op (claim | transfer | send)" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "request failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
