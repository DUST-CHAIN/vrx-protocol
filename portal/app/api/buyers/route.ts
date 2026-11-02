// /api/buyers — the agent CUSTOMER-ROSTER store, the THIRD consumer of the attested-records
// spine (after /api/offers and /api/agreements). The agent owns a reusable roster of buyers; a booking
// attaches a buyer snapshot into the offer seal (see lib/buyers.ts buyerSnapshot + the agent screen).
// GET ?agent=<account> → { buyers: [{...record, verified }] } — THIS agent's whole roster,
// newest first, salt stripped, each with its ✓-verified re-hash.
// POST { agent, fields } → create a buyer the agent owns (name required; other detail optional
// per its "minimal is ok, the developer can refuse" stance).
// POST { agent, id, fields } → update an existing buyer the agent owns (re-seals; no revisions).
// AUTH POSTURE (demo-layer, same as /api/agreements + the operator gate): the caller NAMES itself via
// `agent`. The store is scoped so an agent only ever sees/writes ITS OWN roster — a cross-agent read
// returns an empty roster and a cross-agent write is refused (saveBuyerForAgent returns null). This is PII
//: the roster is one agent's private customer list and must never leak to another party. No wallet-sig
// infra here yet, so this mirrors the established by-party convention rather than inventing new auth.

import { NextResponse } from "next/server";
import { listForAgent, saveBuyerForAgent, verifyBuyer, type Buyer } from "@/lib/buyers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Strip the secret per-record salt ( — must never leave the server) and attach the ✓-verified flag. */
function publicBuyer(b: Buyer): Omit<Buyer, "salt"> & { verified: boolean } {
  const { salt, ...rest } = b; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...rest, verified: verifyBuyer(b) };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent")?.trim();
  if (!agent) {
    return NextResponse.json({ error: "agent required" }, { status: 400 });
  }
  const list = await listForAgent(agent);
  return NextResponse.json({ buyers: list.map(publicBuyer) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : undefined;
  const fields = body.fields;
  if (!agent) {
    return NextResponse.json({ error: "agent required" }, { status: 400 });
  }
  const saved = await saveBuyerForAgent(agent, fields, id);
  if (!saved) {
    // Either invalid fields (no name) OR an attempt to edit a buyer owned by a different agent (refused).
    return NextResponse.json(
      { error: "a buyer needs a name, and you can only edit buyers you own" },
      { status: 400 }
    );
  }
  return NextResponse.json({ buyer: publicBuyer(saved) });
}
