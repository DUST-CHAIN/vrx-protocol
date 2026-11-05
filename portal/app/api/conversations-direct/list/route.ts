// GET /api/conversations-direct/list?viewer=<account>
//  → every DIRECT (pre-booking) conversation the viewer participates in (§9 step 3), as openable rows.
//     For a DESK developer this is their incoming buyer-enquiry list; for a BUYER it's their ongoing desk
//     threads. Each row carries the conversationId, the building, the counterpart (neutral account id), and a
//  last-message + count roll-up (the same shape the booking Conversations route returns).
//
// SCOPING (fail-closed): directConversationsFor only returns conversations where the viewer is the buyer OR
// the building's desk developer. Bodies stay behind the per-conversation gate; this is a metadata roll-up.
//
// PRIVACY: neutral account ids + building ids only; bodies off-chain, chain untouched.

import { NextResponse } from "next/server";
import { directConversationsFor } from "@/lib/conversations-direct";
import { getThread } from "@/lib/channels";
import { getBuilding } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const viewer = new URL(req.url).searchParams.get("viewer")?.trim() || "";
  if (!viewer) return NextResponse.json({ error: "viewer required" }, { status: 400 });

  const convs = await directConversationsFor(viewer);
  const rows = await Promise.all(
    convs.map(async (c) => {
      const [thread, bld] = await Promise.all([getThread(c.id), getBuilding(c.building)]);
      const last = thread.length > 0 ? thread[thread.length - 1] : null;
      const amDesk = c.developer.toLowerCase() === viewer.toLowerCase();
      return {
        conversationId: c.id,
        building: c.building,
        buildingName: bld?.name ?? c.building,
        // The counterpart is the OTHER side: a desk viewer talks to the buyer; a buyer talks to the desk.
        counterpart: amDesk ? c.buyer : c.developer,
        role: amDesk ? ("developer" as const) : ("buyer" as const),
        msgCount: thread.length,
        lastMsg: last ? { from: last.from, text: last.text, at: last.at } : null,
      };
    })
  );
  rows.sort((a, b) => (b.lastMsg?.at ?? 0) - (a.lastMsg?.at ?? 0));
  return NextResponse.json({ viewer, rows });
}
