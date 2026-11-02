// GET /api/catalog → the full demo catalog (all buildings + units).
// GET /api/catalog?building=<id> → one building + images. Status is LAZY by default (A1):
// the grid paints instantly from specs and the client fills status progressively (see
// /api/catalog/status). NO on-chain bake here → instant, even for a 476-unit tower.
// GET /api/catalog?building=<id>&status=full → "Live" mode: bake every unit's on-chain status now
// GET /api/catalog?building=<id>&status=full&fresh=1 → Live + force a fresh chain read (post-stamp).
// The catalog is off-chain demo data (lib/catalog.ts); images via lib/mm.ts (server-only).
// tripped FastNEAR's limiter. Default lazy + progressive per-chunk reads + a Live toggle for a
// complete fresh snapshot. Either way the shared cache warms for the next viewer.

import { NextResponse } from "next/server";
import { getCatalog, getBuilding } from "@/lib/catalog";
import { listImages } from "@/lib/mm";
import { getBuildingStatus, refreshBuildingIfStale } from "@/lib/status-cache";
import { getBuildingSnapshot } from "@/lib/status-store";
import { callerAccount, resolveCatalogScope, scopeAllows } from "@/lib/catalog-scope";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("building");
  const full = searchParams.get("status") === "full";
  const fresh = searchParams.get("fresh") === "1";

  // Security Pass #3: this full-detail read (every unit, exact prices, terms) is a TIER-3
  // developer/internal surface — the public buyer path is the separate lossy /api/catalog/buyer. Scope
  // to the caller's entitled buildings (own ∪ gated); god-mode (localnet) sees all. A non-entitled
  // single-building read returns the SAME not_found as a missing id (never confirm a rival's building
  // exists), and the no-building full dump is filtered to the entitled set.
  const scope = await resolveCatalogScope(callerAccount(req));

  if (id) {
    const building = await getBuilding(id);
    if (!building || !scopeAllows(scope, id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // Bundled static /renderings URLs (own building images + inherited complex images, merged).
    const images = await listImages(id);

    // LAZY (default): return immediately + attach the persisted SNAPSHOT status map so the grid paints
    // snapshot's age (filledAt) to decide which floors are fresh-enough to show vs. show a "tap to load
    // latest" overlay. NO chain read here — the snapshot is served straight from disk.
    if (!full) {
      const snap = await getBuildingSnapshot(building.id);
      // background refresh so a cold building freshens within moments of someone viewing it. Non-
      // blocking + deduped + throttled — we still return the snapshot INSTANTLY below.
      refreshBuildingIfStale(building.id, building.inventory.map((u) => u.id), snap?.filledAt ?? null);
      return NextResponse.json({
        building,
        images,
        lazy: true,
        snapshot: snap ? { units: snap.units, filledAt: snap.filledAt, unitAt: snap.unitAt ?? {} } : null,
      });
    }

    // FULL / "Live" mode: bake the whole building's status now (bounded + cached). A total RPC failure
    // still returns the catalog with no status baked (client falls back), so it never blanks the page.
    let statusAsOf: number | null = null;
    let statusCached = false;
    try {
      const unitIds = building.inventory.map((u) => u.id);
      const { status, asOf, cached } = await getBuildingStatus(building.id, unitIds, fresh);
      statusAsOf = asOf;
      statusCached = cached;
      building.inventory = building.inventory.map((u) => ({ ...u, status: status[u.id] ?? -1 }));
    } catch {
      // leave inventory without `status`; client falls back to per-unit reads
    }

    return NextResponse.json({ building, images, statusAsOf, statusCached, lazy: false });
  }

  const all = await getCatalog();
  return NextResponse.json({ buildings: all.filter((b) => scopeAllows(scope, b.id)) });
}
