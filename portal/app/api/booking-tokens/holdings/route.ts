// /api/booking-tokens/holdings — a ROLE-AGNOSTIC read of how many booking-token "coins" an account currently
// holds, for the wallet's canonical coin display (D-: the wallet owns the count; other surfaces read it).
//
// Unlike /api/developer|agency|agent/tokens (role-scoped action consoles), this is a lean count+breakdown any
// account can read about ITSELF — the wallet shows it next to the $VRX balance. No actions here, pure read.
//
// PRIVACY: returns only this account's OWN holdings (counts + state breakdown + opaque token ids), never
// another party's. Booking tokens carry no customer PII / no plaintext deal terms (B2B capacity records).

import { NextResponse } from "next/server";
import { tokensInCustody } from "@/lib/booking-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = (new URL(req.url).searchParams.get("account") ?? "").trim();
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  const held = await tokensInCustody(account);
  // "Spendable" = capacity the holder can act on right now (issued / with_agency / with_agent — not mid-deal).
  const spendable = held.filter((t) => t.state === "issued" || t.state === "with_agency" || t.state === "with_agent");
  // Compact state breakdown for the wallet's hover/detail (e.g. "3 ready · 1 committed").
  const byState: Record<string, number> = {};
  for (const t of held) byState[t.state] = (byState[t.state] ?? 0) + 1;

  return NextResponse.json({
    account,
    held: held.length,       // total booking tokens in this account's custody
    spendable: spendable.length,
    byState,
    tokenIds: held.map((t) => t.id), // opaque ids only (no deal/PII)
  });
}
