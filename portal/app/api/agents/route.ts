// GET /api/agents?agency=<agencyAccount> — this agency's registered agents (roster). Lets the
// performance view show agents with ZERO bookings too (not just those appearing in the deal rows).
// POST /api/agents { account, agency } — record an agency→agent registration off-chain.
// Called (fire-and-forget) by the agency dashboard right after register_peer confirms on-chain, so the
// SERVER has a record of the agent (browser localStorage/provisioned.ts is invisible to server routes).
// The gas faucet's provisioned-list gate reads this to recognise a freshly-onboarded mobile agent —
// exactly the actor who hits the first-write gas wall (lib/faucet-server.eligibility).
// Not security-sensitive: it only claims "agency X onboarded agent Y", which the faucet cross-checks
// against the chain anyway; worst case a bogus row just makes an ineligible account still fail the
// on-chain fallback. PRIVACY: neutral account ids only.

import { NextResponse } from "next/server";
import { recordAgent, listAgentsForAgency } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const agency = new URL(req.url).searchParams.get("agency")?.trim();
  if (!agency) return NextResponse.json({ error: "missing_agency" }, { status: 400 });
  const agents = await listAgentsForAgency(agency).catch(() => []);
  // Neutral account ids + join time only — no PII; the agent's sealed profile is never returned here.
  return NextResponse.json({ agents: agents.map((a) => ({ account: a.account, at: a.at })) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account : "";
  const agency = typeof body.agency === "string" ? body.agency : "";
  if (!account || !agency) return NextResponse.json({ error: "account + agency required" }, { status: 400 });
  await recordAgent(account, agency);
  return NextResponse.json({ ok: true });
}
