// Stamping tiles (the background job) and GOING ON CONTRACT are decoupled on purpose. A developer runs one or
// more stamp batches (e.g. phase 1 = all units → available; phase 2 = the sold/closed/blocked exceptions).
// Only when the whole slate is FINAL does the developer take THIS action: it reads the building's current
// on-chain `open` (status 0) set and writes the commission BASELINE (lib/sale-baseline via goOnContract) —
// THE moment the VRX↔developer contract takes effect and the "on contract since <date>" banner lights up.
// POST { caller, building } — DEVELOPER establishes zero-time for their building. caller must own it.
// The available set = the building's current `open` units (read server-side
// from the status snapshot — the durable mirror of on-chain tile state).
// Idempotent: a re-call corrects the set but PRESERVES the original date.
// GET ?caller=&building= — read the current baseline (the "on contract since" fact), owner-only.
// accounts/ids only, signs nothing. (The on-chain stamps that MAKE a unit `open` happen in the stamp job;
// this action only READS the resulting slate and dates it.)

import { NextResponse } from "next/server";
import { goOnContract } from "@/lib/stamp-jobs";
import { getBaseline } from "@/lib/sale-baseline";
import { deskDeveloperFor } from "@/lib/conversations-direct";
import { getBuilding } from "@/lib/catalog";
import { getBuildingSnapshot } from "@/lib/status-store";
import { releaseReadiness } from "@/lib/release-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(caller: string, building: string) {
  const owner = await deskDeveloperFor(building);
  if (!owner || owner.toLowerCase() !== caller.toLowerCase()) return false;
  return true;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const caller = url.searchParams.get("caller")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  if (!caller || !building) return NextResponse.json({ error: "caller + building required" }, { status: 400 });
  if (!(await authorize(caller, building))) {
    return NextResponse.json({ error: "not the developer for this building" }, { status: 403 });
  }
  // Alongside the baseline, return the RELEASE READINESS of the slate — which units still have
  // no explicit vetted status (-1). The panel surfaces this as a pre-sign-off note so the developer knows the
  // surface the drift, don't force it — the booking gate already fails closed on the unvetted units).
  return NextResponse.json({
    baseline: await getBaseline(caller, building),
    readiness: await releaseReadiness(building),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  if (!caller || !building) return NextResponse.json({ error: "caller + building required" }, { status: 400 });
  if (!(await authorize(caller, building))) {
    return NextResponse.json({ error: "not the developer for this building" }, { status: 403 });
  }

  const bld = await getBuilding(building);
  if (!bld) return NextResponse.json({ error: "no such building" }, { status: 404 });

  // The available set = units currently `open` (status 0) on-chain, read from the server snapshot (the
  // durable mirror). Truth is whatever is actually stamped after all batches, regardless of how many jobs.
  const snap = await getBuildingSnapshot(building);
  const units = snap?.units ?? {};
  const known = new Set(bld.inventory.map((u) => u.id));
  const availableUnits = Object.entries(units)
    .filter(([unit, status]) => status === 0 && known.has(unit))
    .map(([unit]) => unit);

  if (availableUnits.length === 0) {
    // Guard: going on contract with an empty available set is almost certainly a mistake (the slate hasn't
    // been stamped yet, or the snapshot is stale). Fail closed with a plain-language reason.
    return NextResponse.json(
      { error: "no units are marked available yet — stamp the slate before going on contract" },
      { status: 409 }
    );
  }

  const baseline = await goOnContract({ developer: caller, building, availableUnits });
  if (!baseline) return NextResponse.json({ error: "could not establish the contract date" }, { status: 400 });
  return NextResponse.json({ baseline });
}
