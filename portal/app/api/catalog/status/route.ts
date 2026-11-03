// GET /api/catalog/status?building=<id>&units=<id1,id2...>
//   → on-chain tile status for the given units { status: { unitId: code }, asOf }.
//
// The engine behind the lazy/progressive grid (A1, the lazy-load): the client paints the grid
// instantly from cached specs, then asks for status in small chunks (showing a progress spinner as
// each lands) OR for a single unit when the user clicks it. Each read MERGES into + is served from the
// shared building cache, so any viewer warms it for the next. code: 0 open · 1 hold · 2 closed ·
// 3 done · -1 not stamped/unknown.
//
// PRIVACY: the server derives each unit's opaque unit_key from the catalog ref and reads the
// chain; only hashes touch the chain, exactly like the client would.

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import { getUnitsStatusMerged } from "@/lib/status-cache";
import { callerAccount, resolveCatalogScope, scopeAllows } from "@/lib/catalog-scope";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const building = searchParams.get("building")?.trim();
  const unitsParam = searchParams.get("units")?.trim();
  // fresh=1 → an EXPLICIT refresh (developer's ↻ Refresh / floor-tap after a stamp): re-read the chain
  // for the requested units even if the snapshot already knows them, so the actor sees their own action.
  const force = searchParams.get("fresh") === "1";
  if (!building) return NextResponse.json({ status: {}, asOf: null });

  // Security Pass #3: this endpoint returns UNIT-LEVEL state (open/hold/sold per unit) — MORE than
  // the lossy buyer projection (/api/catalog/buyer, which bakes availability itself and never calls here).
  // So there is no legitimate BUYER caller: it's developer/agent tier. Scope it to entitled buildings only
  // (own ∪ gated) so an outsider can't enumerate a private building's unit states (the bar is
  // "a pretender sees nothing unit-level"). god-mode (localnet) sees all. Non-entitled → empty, not an error.
  const scope = await resolveCatalogScope(callerAccount(req));
  if (!scopeAllows(scope, building)) return NextResponse.json({ status: {}, asOf: null });

  try {
    // Validate the requested units against the building's real inventory (never read arbitrary refs).
    const b = await getBuilding(building);
    if (!b) return NextResponse.json({ status: {}, asOf: null });
    const valid = new Set(b.inventory.map((u) => u.id));
    const requested = (unitsParam ? unitsParam.split(",") : []).map((s) => s.trim()).filter((id) => valid.has(id));
    if (requested.length === 0) return NextResponse.json({ status: {}, asOf: null });

    const { status, asOf, cached, busy, source } = await getUnitsStatusMerged(building, requested, force);
    // Return only the requested slice (the cache may hold more; the client asked for these). A unit the
    // snapshot/chain doesn't know yet is omitted (undefined) rather than forced to -1, so the client can
    // tell "unknown, still loading" from a confirmed "not listed".
    const slice: Record<string, number> = {};
    for (const id of requested) if (status[id] !== undefined) slice[id] = status[id];
    return NextResponse.json({ status: slice, asOf, cached, busy: !!busy, source });
  } catch {
    // Fail soft — the client keeps units in "loading" and can retry the chunk.
    return NextResponse.json({ status: {}, asOf: null, rpcError: true }, { status: 200 });
  }
}
