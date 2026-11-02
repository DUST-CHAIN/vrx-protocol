// api/settlement — the read surface over lib/earmark's settlementRollup. The money
// LOGIC half of (EARMARK→TAKE) surfaced per-role: a developer sees what it OWES (agency commission +
// VRX protocol fee); an agency sees what it's OWED (commission across its developers). TAKE/on-rail
// GET ?account=<acct>&role=developer|agency → the slice of the rollup that belongs to that account:
// developer → { role, account, owesAgencies: AgencyLine[], owesVrx: VrxLine|null, totals:{commission,vrxFee} }
// agency → { role, account, owedBy: AgencyLine[], totals:{commission} } (no VRX line — the fee is the
// DEVELOPER's obligation to VRX; an agency neither owes nor is owed it)
// AUTH posture (matches the rest of the off-chain developer/agency-authored demo layer, e.g.
// /api/developer/profile-requirements): trusted caller — `account` is the caller's own account, the signed-
// request binding is the deferred F1 signing arc. The rollup is computed server-side over the sealed off-chain
// records (lib/earmark) so no B2B money figure is ever derived on the client. PRIVACY: nothing on-chain;
// these USD figures are B2B and never appear on a buyer's S&P (same rule as commission).

import { NextResponse } from "next/server";
import { settlementRollup, projectForAccount } from "@/lib/earmark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  const role = url.searchParams.get("role")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  if (role !== "developer" && role !== "agency") {
    return NextResponse.json({ error: "role must be developer or agency" }, { status: 400 });
  }
  const rollup = await settlementRollup();
  return NextResponse.json(projectForAccount(rollup, account, role));
}
