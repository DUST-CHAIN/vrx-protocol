// GET /api/activity?viewer=<account>&role=<role>&limit=<n>
// → { feed: FeedLine[] } — the humanised, VIEWER-SCOPED activity timeline (the "recently happened"
// event mirror (bookings), the sealed buyer-events trail (reveals/revisions), the agreements store, and
// the off-chain spine (lib/activity.ts) — into one reverse-chronological, plain-language list, returning
// only the entries the viewer is a party to ("each sees their own activities in respect to the
// counterparty"). Reusable across roles: /node surfaces it this session; /agency, /agent, /root call the
// SAME endpoint with their own `viewer` later.
// AUTH (F1 seam, fail-closed): identity via requireCaller (verified session; param-fallback honours ?viewer=).
// The engine returns only that account's slice — no server widening of a party's existing view: booking lines
// come from the public on-chain mirror, buyer/agreement lines from the two deal parties' own records. An
// empty/absent identity refuses (401 signin_required) — the UI never calls without a viewer, so this closes a
// direct forged read rather than changing any live path. (migrated off the trust-the-param posture that

import { NextResponse } from "next/server";
import { requireCaller } from "@/lib/caller";
import { getActivityFeed } from "@/lib/activity-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const caller = requireCaller(req, { param: url.searchParams.get("viewer") });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });

  const role = url.searchParams.get("role")?.trim() ?? "";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;

  try {
    const feed = await getActivityFeed(caller.account, role, limit);
    return NextResponse.json({ feed });
  } catch {
    return NextResponse.json({ error: "activity_unavailable" }, { status: 503 });
  }
}
