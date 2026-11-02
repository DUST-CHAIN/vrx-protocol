// /api/exclusives — the exclusive-hold write-through mirror. Mirrors what the developer did on-chain
// (grant_exclusive / release_exclusive) so the /node "Exclusive holds" panel answers from ONE request
// instead of scanning get_exclusive over every catalog unit (1,558 reads → keyless flood → hang). See
// lib/exclusives-store.ts; same reasoning as and the gate mirror.
// GET ?developer=<acct> → { holds: ExclusiveHold[] } — the LIVE holds this developer granted.
// POST { action:"grant", unitKey, buildingId, unitId, orgId, developer, until } → record a grant.
// POST { action:"release", unitKey } → mark a hold released early.
// NOT security-sensitive: the CONTRACT enforces the actual hold (get_exclusive is authoritative; a booking
// against a held unit reverts E58). This map only affects what the panel SHOWS, never what's allowed — a
// stale entry is filtered by `until` (expiry) and the real chain check still governs any booking.
// PRIVACY: neutral account ids + opaque unit key + an expiry window. No PII, no plaintext terms.

import { NextResponse } from "next/server";
import { liveHoldsForDeveloper, recordHold, releaseHold } from "@/lib/exclusives-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const developer = new URL(req.url).searchParams.get("developer")?.trim();
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
  const holds = await liveHoldsForDeveloper(developer);
  return NextResponse.json({ holds });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body.action;

  if (action === "release") {
    const unitKey = typeof body.unitKey === "string" ? body.unitKey : "";
    if (!unitKey) return NextResponse.json({ error: "unitKey required" }, { status: 400 });
    await releaseHold(unitKey);
    return NextResponse.json({ ok: true });
  }

  if (action === "grant") {
    const unitKey = typeof body.unitKey === "string" ? body.unitKey : "";
    const buildingId = typeof body.buildingId === "string" ? body.buildingId : "";
    const unitId = typeof body.unitId === "string" ? body.unitId : "";
    const orgId = typeof body.orgId === "string" ? body.orgId : "";
    const developer = typeof body.developer === "string" ? body.developer : "";
    const until = typeof body.until === "number" ? body.until : 0;
    if (!unitKey || !orgId || !developer || !until) {
      return NextResponse.json({ error: "grant needs unitKey, orgId, developer, until (ns)" }, { status: 400 });
    }
    await recordHold({ unitKey, buildingId, unitId, orgId, developer, until });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action must be grant|release" }, { status: 400 });
}
