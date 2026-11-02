// /api/agency/tokens — the AGENCY's booking-token surface ( slice 7c). The agency holds tokens a
// developer handed/sold it, HANDS one down to one of its OWN field agents, and later CONFIRMS up the chain
// that it received the customer's cash from that agent (the middle hop of the three-hop reconcile).
// GET ?agency=<acct>&viewer=<acct>
// → { tokens, agents }
// tokens = tokens currently in the agency's custody OR carrying a cash leg its agent took (so the
// agency can both hand down AND confirm receipt), plain-words state labels.
// agents = the agency's OWN field agents (account + name) — the only legitimate hand-to targets
// (chain-constrained; peer-to-peer refused by the lib).
// POST { agency, op:"hand"|"confirmCash"... }
// op:"hand" { tokenId, toAgent } → hand a held token down to one of its agents.
// op:"confirmCash" { tokenId } → confirm the agency received the cash from
// the agent (cash_taken → reconciling). The lib
// checks `agency` supervises the token's agent.
// AUTH (demo-layer): the viewer/caller names its own account and must equal the agency subject. The lib
// enforces holder-scope + counterparty validation + the reconcile authorization anchor (agency must supervise
// the taker). PRIVACY: token ids + accounts + states only; the cash amount/photo stay off-chain.

import { NextResponse } from "next/server";
import { listProfiles } from "@/lib/profiles";
import { listAgents } from "@/lib/agents";
import {
  tokensInCustody,
  transferToken,
  confirmCash,
  type BookingToken,
} from "@/lib/booking-tokens";
import { publish } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  issued: "In the developer's hands",
  with_agency: "In your hands",
  with_agent: "With a field agent",
  committed: "Securing a booking",
  cash_taken: "Cash taken — confirm receipt",
  reconciling: "Reconciling with the developer",
  settled: "Settled",
  frozen: "Paused",
  recycled: "Returned",
};

function viewToken(t: BookingToken, nameOf: (a: string) => string) {
  return {
    id: t.id,
    state: t.state,
    stateLabel: STATE_LABEL[t.state] ?? t.state,
    economics: t.economics,
    custody: t.custody,
    custodyName: nameOf(t.custody),
    developer: t.developer,
    developerName: nameOf(t.developer),
    unitId: t.unitId ?? null,
    buildingId: t.buildingId ?? null,
    cash: t.cash ? { amountMinor: t.cash.amountMinor, currency: t.cash.currency, takenBy: t.cash.takenBy, takenByName: nameOf(t.cash.takenBy), disputed: !!t.cash.disputed, agencyConfirmedAt: t.cash.agencyConfirmedAt ?? null } : null,
    issuedAt: t.issuedAt,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agency = url.searchParams.get("agency")?.trim() || "";
  const viewer = url.searchParams.get("viewer")?.trim() || "";
  if (!agency) return NextResponse.json({ error: "agency required" }, { status: 400 });
  if (!viewer || viewer.toLowerCase() !== agency.toLowerCase()) {
    return NextResponse.json({ error: "viewer must match agency" }, { status: 403 });
  }

  const [held, agentRecords, profiles] = await Promise.all([tokensInCustody(agency), listAgents(), listProfiles()]);
  const nameByAccount = new Map(profiles.map((p) => [p.account.toLowerCase(), p.legalName]));
  const nameOf = (account: string): string => nameByAccount.get(account.trim().toLowerCase()) || account;
  const myAgents = agentRecords.filter((a) => a.agency.toLowerCase() === agency.toLowerCase());

  // Tokens to show: those in the agency's custody PLUS those an own-agent is carrying a cash leg on (so the
  // agency can confirm receipt even though the committed token is held by the agent, not the agency).
  const myAgentAccounts = new Set(myAgents.map((a) => a.account.toLowerCase()));
  const cashLegsToConfirm = (await Promise.all(
    [...myAgentAccounts].map((acc) => tokensInCustody(acc))
  )).flat().filter((t) => t.cash && (t.state === "cash_taken") && myAgentAccounts.has(t.cash.takenBy.toLowerCase()));

  const seen = new Set<string>();
  const tokens = [...held, ...cashLegsToConfirm]
    .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    .sort((a, b) => b.issuedAt - a.issuedAt)
    .map((t) => viewToken(t, nameOf));

  return NextResponse.json({
    tokens,
    agents: myAgents.map((a) => ({ account: a.account, name: nameOf(a.account) })),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const agency = typeof body.agency === "string" ? body.agency.trim() : "";
  const op = typeof body.op === "string" ? body.op : "";
  const tokenId = typeof body.tokenId === "string" ? body.tokenId.trim() : "";
  if (!agency || !tokenId) return NextResponse.json({ error: "agency and tokenId required" }, { status: 400 });

  try {
    if (op === "hand") {
      const toAgent = typeof body.toAgent === "string" ? body.toAgent.trim() : "";
      if (!toAgent) return NextResponse.json({ error: "toAgent required" }, { status: 400 });
      // A hand down to an agent is a free move (no economics change / no sale) — the economics were set when
      // the developer handed/sold to the agency. The lib validates toAgent is one of this agency's own agents.
      const token = await transferToken({ tokenId, by: agency, to: toAgent });
      publish("events");
      return NextResponse.json({ token });
    }

    if (op === "confirmCash") {
      const token = await confirmCash({ tokenId, by: agency, role: "agency" });
      publish("events");
      return NextResponse.json({ token });
    }

    return NextResponse.json({ error: "unknown op (hand | confirmCash)" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "request failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
