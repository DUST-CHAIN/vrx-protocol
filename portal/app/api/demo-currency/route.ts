// /api/demo-currency — the $VRX DEMO play-money surface (slice 4). FAIL-CLOSED behind NEXT_PUBLIC_VRX_DEMO:
// $VRX is explicitly-fake, demo-only play money (1 $VRX "= $1" display convention ONLY — never real value, never
// redeemable, never a peg). It exists so agents can LEARN the system and place DEMO bookings. The lib enforces
// the hard invariants (demo-gated, always visibly fake, never settles a real obligation, self-cleaning). This
// route is the thin caller. Design: `the design docs`.
//
//   GET  ?account=<acct>
//        → { enabled, balanceVrx, holds }  — the actor's play-money balance + their demo holds (with an
//          `active` flag + `expiresAt` so the UI shows the revert countdown). `enabled:false` (never 500) when
//          the demo flag is off — the UI simply hides the surface.
//   GET  ?developer=<acct>
//        → { enabled, holds }  — the practice holds parked on the DEVELOPER's OWN inventory (resolved via the
//          developer registry's buildingIds), so the developer can UPGRADE an active one to a real booking.
//          Scoped to the developer's buildings only (never another developer's holds).
//   POST { op:"place",  account, buildingId, unitId, amountVrx, ttlMs? } → { hold }  — place a demo hold.
//   POST { op:"upgrade", holdId, requestId }                            → { hold }  — DEVELOPER upgrades a demo
//          hold to a real booking (the forcing-function handoff; the REAL booking + REAL fee are placed on the
//  direct-deposit path elsewhere — this records the crossing). Authorization (is the caller the
//          unit's developer?) is the real-path route's job; this records the demo-side handoff.
//
// PRIVACY: $VRX never touches a seal or the chain as value — it is off-chain demo state, period.

import { NextResponse } from "next/server";
import {
  demoEnabled,
  balanceOf,
  demoHoldsForAccount,
  demoHoldsForBuildings,
  getDemoHold,
  placeDemoHold,
  upgradeDemoHold,
  isDemoHoldActive,
  isDemoHoldExpired,
  type VrxDemoHold,
} from "@/lib/vrx-demo-currency";
import { getDeveloper } from "@/lib/developers";
import { publish } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function viewHold(h: VrxDemoHold, now: number) {
  return {
    id: h.id,
    buildingId: h.buildingId,
    unitId: h.unitId,
    amountVrx: h.amountVrx,
    placedAt: h.placedAt,
    expiresAt: h.expiresAt,
    active: isDemoHoldActive(h, now),
    expired: isDemoHoldExpired(h, now),
    upgradedToRequestId: h.upgradedToRequestId ?? null,
  };
}

export async function GET(req: Request) {
  if (!demoEnabled()) return NextResponse.json({ enabled: false, balanceVrx: 0, holds: [] });
  const url = new URL(req.url);
  const now = Date.now();

  // Developer view — practice holds on the developer's OWN inventory (for the upgrade handoff).
  const developer = url.searchParams.get("developer")?.trim() || "";
  if (developer) {
    const dev = await getDeveloper(developer);
    const buildingIds = dev?.buildingIds ?? [];
    const holds = buildingIds.length ? await demoHoldsForBuildings(buildingIds) : [];
    return NextResponse.json({ enabled: true, holds: holds.map((h) => viewHold(h, now)) });
  }

  // Actor view — the caller's own balance + holds.
  const account = url.searchParams.get("account")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account or developer required" }, { status: 400 });

  const [balanceVrx, holds] = await Promise.all([balanceOf(account), demoHoldsForAccount(account)]);
  return NextResponse.json({ enabled: true, balanceVrx, holds: holds.map((h) => viewHold(h, now)) });
}

export async function POST(req: Request) {
  if (!demoEnabled()) return NextResponse.json({ error: "$VRX is demo-only (not available here)" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const op = typeof body.op === "string" ? body.op : "";

  try {
    if (op === "place") {
      const account = typeof body.account === "string" ? body.account.trim() : "";
      const buildingId = typeof body.buildingId === "string" ? body.buildingId.trim() : "";
      const unitId = typeof body.unitId === "string" ? body.unitId.trim() : "";
      const amountVrx = Number(body.amountVrx);
      const ttlMs = Number.isFinite(Number(body.ttlMs)) && Number(body.ttlMs) > 0 ? Number(body.ttlMs) : undefined;
      if (!account || !buildingId || !unitId) return NextResponse.json({ error: "account, buildingId, unitId required" }, { status: 400 });
      const hold = await placeDemoHold({ account, buildingId, unitId, amountVrx, ttlMs });
      publish("events");
      return NextResponse.json({ hold });
    }

    if (op === "upgrade") {
      const holdId = typeof body.holdId === "string" ? body.holdId.trim() : "";
      const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
      const developer = typeof body.developer === "string" ? body.developer.trim() : "";
      if (!holdId) return NextResponse.json({ error: "holdId required" }, { status: 400 });
      // Demo-layer authorization: the upgrading developer must OWN the hold's building — only the inventory
      // owner may retire a practice hold into a real booking. `developer` is REQUIRED (an empty field must not
      // skip the guard — the check would otherwise be bypassable by omitting it). (The real fee/booking is
      // placed on the direct-deposit path; this records the handoff. Real wallet binding lands with the
      // signing arc, where `developer` becomes the wallet-verified account.)
      if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
      const hold = await getDemoHold(holdId);
      if (!hold) return NextResponse.json({ error: "demo hold not found" }, { status: 404 });
      const dev = await getDeveloper(developer);
      const owns = (dev?.buildingIds ?? []).map((b) => b.toLowerCase()).includes(hold.buildingId.toLowerCase());
      if (!owns) return NextResponse.json({ error: "only the unit's developer may upgrade this practice hold" }, { status: 403 });
      const upgraded = await upgradeDemoHold({ holdId, requestId });
      publish("events");
      return NextResponse.json({ hold: upgraded });
    }

    return NextResponse.json({ error: "unknown op (place | upgrade)" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "request failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
