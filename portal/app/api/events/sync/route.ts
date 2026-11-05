// POST /api/events/sync — run one sync tick of the event MIRROR: (1) SEED from known-booking
// claims (cheap get_claim — closes the held-units gap), then (2) TAIL forward from the block cursor to
// head (archival RPC, key-pool round-robin), ingesting contract txns' EVENT_JSON logs into
// .data/events.json. Cursor-driven, so steady state walks only the handful of new blocks since last tick.
//   body (optional): { blocks?: number }  → override the per-tick block cap (one-off deeper catch-up).
// GET is allowed too (convenience: a browser/cron hit). Returns the SyncResult (seeded/added/walked/cursor).
//
// This is the FRESHNESS owner — a cron/poller (or the SSE layer later) calls it; the read routes
// (/api/events, /api/claims) just read the mirror. Owner-gated with the usual VRX_OPERATOR_SECRET
// convention (no secret set → open, for the demo), so a stranger can't burn our FastNEAR quota.

import { NextResponse } from "next/server";
import { syncEvents } from "@/lib/event-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

async function run(req: Request, blocks?: number) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = blocks && blocks > 0 ? await syncEvents(blocks) : await syncEvents();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

export async function POST(req: Request) {
  let blocks: number | undefined;
  try {
    const body = (await req.json()) as { blocks?: number };
    blocks = typeof body.blocks === "number" ? body.blocks : undefined;
  } catch {
    // no/invalid body → default block cap
  }
  return run(req, blocks);
}

export async function GET(req: Request) {
  const n = Number(new URL(req.url).searchParams.get("blocks"));
  return run(req, Number.isFinite(n) && n > 0 ? n : undefined);
}
