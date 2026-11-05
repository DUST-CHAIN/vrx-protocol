// POST /api/catalog/invalidate  { building: "<id>" }
//
// Busts the server status cache for one building so the NEXT read rebuilds it from chain. The
// client calls this right after a stamp tx confirms (its own signed write), so other viewers — and the
// stamper's own next load — see the change without waiting out the 15s TTL. Fire-and-forget from the
// client; the client also optimistically updates its own grid + re-reads just the changed unit,
// so this is belt-and-suspenders for correctness, not the primary UI feedback.

import { NextResponse } from "next/server";
import { invalidateBuilding } from "@/lib/status-cache";

export async function POST(req: Request) {
  try {
    const { building } = (await req.json()) as { building?: string };
    if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });
    invalidateBuilding(building);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
