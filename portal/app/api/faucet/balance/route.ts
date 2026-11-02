// GET /api/faucet/balance?account=<id>
// Resilient balance read for the gear-menu display (fixes the placeholder "$0.00"). Returns the
// spendable NEAR, or busy:true on an RPC outage so the UI can show "—" instead of a false zero.

import { NextResponse } from "next/server";
import { getBalance } from "@/lib/balance-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account")?.trim();
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  try {
    const b = await getBalance(account);
    if (b === null) return NextResponse.json({ account, exists: false, availableNear: 0 });
    return NextResponse.json({ account, exists: true, availableNear: b.availableNear });
  } catch {
    // RPC unavailable — don't render a false 0. Client shows "—" / retries.
    return NextResponse.json({ account, busy: true });
  }
}
