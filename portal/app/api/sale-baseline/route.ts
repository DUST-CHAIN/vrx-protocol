// /api/sale-baseline — the developer establishes/reads a building's COMMISSION BASELINE (the clean-slate
// clean-slate stamp (stamp_tiles) is a separate, later step.
// POST { caller, building, availableUnits[] } — DEVELOPER establishes/re-establishes the baseline for
// their building. caller must be the building's owning
// developer. First call fixes establishedAt; a later call
// updates the available set but keeps the original date.
// GET ?caller=&building= — the owning developer reads ONE building's baseline.
// GET ?caller= — the developer reads ALL their baselines (across buildings).
// AUTH: capability-based (caller names its account); the authorization that matters (caller == the building's
// owning developer) IS enforced via deskDeveloperFor — the same resolution the desk uses (the developer whose

import { NextResponse } from "next/server";
import { establishBaseline, getBaseline, baselinesForDeveloper } from "@/lib/sale-baseline";
import { deskDeveloperFor } from "@/lib/conversations-direct";
import { getBuilding } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const caller = url.searchParams.get("caller")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  if (!caller) return NextResponse.json({ error: "caller required" }, { status: 400 });

  // ── One building's baseline — caller must own it. ──
  if (building) {
    const owner = await deskDeveloperFor(building);
    if (!owner || owner.toLowerCase() !== caller.toLowerCase()) {
      return NextResponse.json({ error: "not the developer for this building" }, { status: 403 });
    }
    return NextResponse.json({ baseline: await getBaseline(caller, building) });
  }

  // ── All of this developer's baselines. ──
  return NextResponse.json({ baselines: await baselinesForDeveloper(caller) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  const availableUnits = Array.isArray(body.availableUnits) ? body.availableUnits : [];
  if (!caller || !building) {
    return NextResponse.json({ error: "caller + building required" }, { status: 400 });
  }

  // AUTHORIZE: caller must be the building's owning developer.
  const owner = await deskDeveloperFor(building);
  if (!owner || owner.toLowerCase() !== caller.toLowerCase()) {
    return NextResponse.json({ error: "not the developer for this building" }, { status: 403 });
  }

  // The building must exist, and every named available unit must actually be in it (don't baseline a
  // phantom set). Fail closed on an unknown unit — the slate must reflect real inventory.
  const bld = await getBuilding(building);
  if (!bld) return NextResponse.json({ error: "no such building" }, { status: 404 });
  const known = new Set(bld.inventory.map((u) => u.id));
  const bad = availableUnits.filter((u: unknown) => !(typeof u === "string" && known.has(u.trim())));
  if (bad.length > 0) {
    return NextResponse.json({ error: "unknown unit(s) in the available set", units: bad }, { status: 400 });
  }

  const baseline = await establishBaseline({ developer: caller, building, availableUnits });
  if (!baseline) return NextResponse.json({ error: "could not establish baseline" }, { status: 400 });
  return NextResponse.json({ baseline });
}
