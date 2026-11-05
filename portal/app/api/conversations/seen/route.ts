// /api/conversations/seen — the DURABLE per-participant read-marker for the everlasting chat.
//
//   GET  ?viewer=<acct>                         → { seen: { threadId: count } }  the viewer's whole seen-map.
//   POST { viewer, requestId, count }           → { count }  mark one BOOKING thread seen at `count`.
//  POST { viewer, conversationId, count, kind:"direct" } → { count } mark one DIRECT thread seen.
//
// This is the server truth that replaces the per-browser localStorage unread hack, so "log on anywhere →
// see the unread" works across devices/logins. A viewer may only touch their OWN markers; a POST also
// requires the viewer be a PARTICIPANT of that thread (lib/participant for bookings, lib/conversations-direct
// for the pre-booking desk funnel) so you can't mark — or probe — a thread you're not on. Fail closed.
// (GET returns only the caller's own map, so it needs no per-thread check.) The read-marker store is keyed by
// a plain thread id, so a direct conversationId and a booking requestId share the one map without collision
// (both are opaque, non-colliding digests).
//
// AUTH caveat: like every read here, the viewer arrives as the demo-layer `?viewer=` param (F1, unsigned —
// trusted for now; the real binding lands once in lib/participant). PRIVACY: integers + ids only.

import { NextResponse } from "next/server";
import { seenFor, markSeen } from "@/lib/read-markers";
import { roleOnBooking } from "@/lib/participant";
import { directRole } from "@/lib/conversations-direct";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const viewer = new URL(req.url).searchParams.get("viewer")?.trim() ?? "";
  if (!viewer) return NextResponse.json({ error: "missing_viewer" }, { status: 400 });
  return NextResponse.json({ seen: await seenFor(viewer) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const viewer = typeof body.viewer === "string" ? body.viewer.trim() : "";
  const count = typeof body.count === "number" ? body.count : NaN;
  const isDirect = body.kind === "direct";
  // A direct POST carries `conversationId`; a booking POST carries `requestId`. The read-marker store is a
  // flat threadId→count map, so either id is a valid key — we just scope-check with the right module.
  const threadId =
    (isDirect
      ? typeof body.conversationId === "string"
        ? body.conversationId
        : ""
      : typeof body.requestId === "string"
        ? body.requestId
        : ""
    ).trim();
  if (!viewer || !threadId || !Number.isFinite(count)) {
    return NextResponse.json({ error: "viewer + thread id + count required" }, { status: 400 });
  }
  // Must be a party to this thread to mark it seen (and so we never confirm a thread's existence to a
  // non-participant). Fail closed. Booking → lib/participant; direct → lib/conversations-direct.
  const isParty = isDirect
    ? (await directRole(threadId, viewer)) !== null
    : (await roleOnBooking(threadId, viewer)) !== null;
  if (!isParty) {
    return NextResponse.json({ error: "not a participant" }, { status: 403 });
  }
  const stored = await markSeen(viewer, threadId, count);
  return NextResponse.json({ count: stored });
}
