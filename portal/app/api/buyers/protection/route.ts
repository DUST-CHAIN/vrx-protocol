// GET /api/buyers/protection?agent=<account>
//  → the AGENT's protection surface: every booking this agent authored that has a buyer attached,
//     with its reveal/mask state, any pending developer reveal REQUEST awaiting the agent's approval, and
//     the sealed EVENT TRAIL (the evidence bundle — proof-of-introduction + declaration + reveals +
//     revisions). The agent sees the FULL buyer (it's their own record; no masking applies to the owner).
//
// This is the agent's half of the masked-until-deposit loop: the developer can only REQUEST a pre-deposit
// reveal; the agent approves/declines it here, and can reveal early (T2) at will.
//
// PRIVACY: agent-scoped (seal.by == agent). The trail's seals re-verify server-side for the ✓ badge.

import { NextResponse } from "next/server";
import { offersForAgent, type Offer } from "@/lib/offers";
import { eventsForBooking, verifyBuyerEvent, type BuyerEvent } from "@/lib/buyer-events";
import { getCatalog } from "@/lib/catalog";
import { requireCaller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // AUTH (VRX-0003 PII class): this returns the agent's bookings with FULL UNMASKED buyer detail
  // (o.seal.buyer) — naming another agent would expose their buyers' PII. Bind `agent` to the proven caller.
  const who = requireCaller(req, { param: new URL(req.url).searchParams.get("agent")?.trim() || "" });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const agent = who.account;
  if (!agent) return NextResponse.json({ error: "missing_agent" }, { status: 400 });

  const offers = await offersForAgent(agent).catch(() => [] as Offer[]);
  const catalog = await getCatalog().catch(() => []);
  const nameOf = (o: Offer) => {
    const b = catalog.find((x) => x.id === o.display.buildingId);
    const u = b?.inventory.find((x) => x.id === o.display.unitId);
    return { building: b?.name, unit: u?.id?.replace(/^unit-/, "") ?? o.display.unitId };
  };

  const rows = await Promise.all(
    offers.map(async (o) => {
      const trail = await eventsForBooking(o.requestId).catch(() => [] as BuyerEvent[]);
      return {
        requestId: o.requestId,
        developer: o.developer,
        names: nameOf(o),
        buyer: o.seal.buyer, // FULL detail — the agent owns it
        unlock: o.unlock ?? { revealed: false },
        at: o.at,
        // the sealed evidence bundle, each event with its ✓ verification
        evidence: trail.map((e) => ({
          id: e.id,
          kind: e.kind,
          by: e.by,
          detail: e.detail,
          at: e.at,
          verified: verifyBuyerEvent(e),
        })),
      };
    })
  );
  rows.sort((a, b) => b.at - a.at);
  return NextResponse.json({ agent, rows });
}
