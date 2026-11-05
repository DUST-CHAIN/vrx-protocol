// GET /api/conversations/unread?viewer=<account>
//   → { count }  the number of the viewer's booking chats with unseen counterpart messages.
//
// The CHEAP sibling of /api/conversations (the full roll-up): a sidebar BADGE needs only a count, so this
// skips catalog name-enrichment + title building and returns a single integer. Same participant-scoping +
// same read-marker rule, via the shared lib/conversations-unread (so the badge and the list can never
// disagree on what "unread" means). This is what makes "log on → SEE the notification" work without opening
// the Conversations section (notify-on-login): the shell polls this on mount + on a channel SSE tick.
//
// AUTH caveat: the viewer arrives as the demo-layer `?viewer=` param (F1, unsigned — trusted for now; the
// real binding lands once in lib/participant). PRIVACY: the response is a single integer; the scoping
// drops every thread the viewer isn't a party to. No ids, no bodies leave here.

import { NextResponse } from "next/server";
import { unreadCountFor } from "@/lib/conversations-unread";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const viewer = new URL(req.url).searchParams.get("viewer")?.trim();
  if (!viewer) return NextResponse.json({ error: "missing_viewer" }, { status: 400 });
  try {
    return NextResponse.json({ count: await unreadCountFor(viewer) });
  } catch {
    return NextResponse.json({ error: "server_busy" }, { status: 503 });
  }
}
