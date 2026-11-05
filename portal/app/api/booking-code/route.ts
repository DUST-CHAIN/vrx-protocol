// GET /api/booking-code?requestId=<id>         → { code }   mint (lazy) + return the booking's short code
// GET /api/booking-code?resolve=<typed code>   → { requestId, code } | 404   the "jump to booking" lookup
// POST /api/booking-code  { requestIds: [...] } → { codes: { <requestId>: <code> } }   batch for a list view
//
// The booking CODE is a short, spellable handle (VRX-DDD-NNN) anyone can quote to refer to a
// booking. It's registry-MINTED (lib/booking-codes) so it can never collide, and resolves back to the
// authoritative opaque requestId — one source of truth, contract FROZEN.
//
// The developer a code is scoped under comes from the booking's OFFER (offer.developer), so the client only
// ever passes a requestId (or a typed code) — it never needs to know/pass the developer. A booking we don't
// hold an offer for can't be scoped, so it isn't minted here (returns an empty code) — fail closed, same
// posture as /api/conversations.

import { NextResponse } from "next/server";
import { codeForBooking, resolveCode } from "@/lib/booking-codes";
import { getOffer } from "@/lib/offers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mint-or-get the code for one booking, resolving its developer + booking time from the offer. "" if not
 *  scopable (no offer held). The booking's `at` is carried so a later resolve can report WHEN it happened. */
async function codeOf(requestId: string): Promise<string> {
  const offer = await getOffer(requestId).catch(() => null);
  if (!offer?.developer) return "";
  return codeForBooking(requestId, offer.developer, offer.at ?? 0);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId")?.trim();
  const resolve = url.searchParams.get("resolve")?.trim();

  try {
    if (resolve) {
      const rec = await resolveCode(resolve);
      if (!rec) return NextResponse.json({ error: "not_found" }, { status: 404 });
      // Carry the booking time so the caller can say "placed <date/time>" and deep-link to the detail.
      return NextResponse.json({ requestId: rec.requestId, code: rec.code, bookingAt: rec.bookingAt });
    }
    if (requestId) {
      return NextResponse.json({ code: await codeOf(requestId) });
    }
    return NextResponse.json({ error: "missing_param" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "server_busy" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { requestIds?: unknown };
    const ids = Array.isArray(body.requestIds)
      ? body.requestIds.filter((x): x is string => typeof x === "string").slice(0, 500)
      : [];
    const codes: Record<string, string> = {};
    for (const rid of ids) codes[rid] = await codeOf(rid);
    return NextResponse.json({ codes });
  } catch {
    return NextResponse.json({ error: "server_busy" }, { status: 503 });
  }
}
