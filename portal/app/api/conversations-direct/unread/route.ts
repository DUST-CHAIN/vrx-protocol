// GET /api/conversations-direct/unread?viewer=<account>
// → { count } the number of the viewer's DIRECT (pre-booking) desk conversations with unseen counterpart
// messages. The direct-funnel twin of /api/conversations/unread: the booking-side badge scopes
// through an offer, which a direct thread doesn't have, so direct enquiries were invisible to any badge.
// Same participant-scoping + same server read-marker rule, via lib/conversations-direct, so the badge and
// the Direct-enquiries / Sales-desk lists can never disagree on what "unread" means.
// Used by BOTH sides: the developer's "Direct enquiries" nav badge and the buyer's "Talk to the sales desk"
// button badge — "log on anywhere → see you have unread" without opening the thread first ( twin).
// AUTH caveat: viewer arrives as the demo-layer `?viewer=` param (F1, unsigned — trusted for now). PRIVACY
//: the response is a single integer; scoping drops every thread the viewer isn't a party to.

import { NextResponse } from "next/server";
import { directUnreadCountFor } from "@/lib/conversations-direct";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const viewer = new URL(req.url).searchParams.get("viewer")?.trim();
  if (!viewer) return NextResponse.json({ error: "missing_viewer" }, { status: 400 });
  try {
    return NextResponse.json({ count: await directUnreadCountFor(viewer) });
  } catch {
    return NextResponse.json({ error: "server_busy" }, { status: 503 });
  }
}
