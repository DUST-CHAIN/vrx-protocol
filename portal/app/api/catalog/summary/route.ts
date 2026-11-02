// GET /api/catalog/summary
// → per-building summary stats for the building CARDS: total/available/sold/onHold, price range,
// unit types + size ranges. Availability comes from the persisted SNAPSHOT (no chain reads), so
// the cards paint instantly. A building with no snapshot yet reports availability as unknown.
// One call feeds the whole card grid. Detailed per-floor stats are computed client-side in the
// building view (lib/building-stats) from the same snapshot.

import { NextResponse } from "next/server";
import { getCatalog } from "@/lib/catalog";
import { loadSnapshot } from "@/lib/status-store";
import { buildingStats } from "@/lib/building-stats";
import { freeholdQuota } from "@/lib/freehold";
import { heroImage } from "@/lib/mm";
import type { Building } from "@/lib/catalog-client";
import { callerAccount, resolveCatalogScope, scopeAllows } from "@/lib/catalog-scope";

export async function GET(req: Request) {
  // Security Pass #3: scope the card grid to buildings this caller is entitled to (own ∪ gated).
  // god-mode (localnet) sees all; a non-entitled caller gets an empty grid, never a rival's stats.
  const scope = await resolveCatalogScope(callerAccount(req));
  const [catalogAll, snap] = await Promise.all([getCatalog(), loadSnapshot()]);
  const catalog = catalogAll.filter((b) => scopeAllows(scope, b.id));
  const summaries = await Promise.all(catalog.map(async (b) => {
    const status = snap[b.id]?.units ?? {};
    const building = b as unknown as Building;
    const s = buildingStats(building, status);
    // Freehold quota — computed from the same snapshot; null when the building has no quota.
    const q = freeholdQuota(building, status);
    return {
      id: b.id,
      name: b.name,
      area: b.area,
      tagline: b.tagline,
      stories: b.stories,
      total: s.total,
      available: s.available,
      sold: s.sold,
      onHold: s.onHold,
      unknown: s.unknown,
      notListed: s.notListed,
      offMarket: s.offMarket,
      hasSnapshot: !!snap[b.id],
      snapshotAt: snap[b.id]?.filledAt ?? null,
      hasGeo: !!b.geo, // a cheap flag for the card's "on the map" chip (no coords in the summary)
      heroImage: await heroImage(b.id), // the representative photo for the card banner
      priceMinUsd: s.priceMinUsd,
      priceMaxUsd: s.priceMaxUsd,
      priceRounding: b.priceRounding ?? null, // card rounds the display range, storage stays exact

      types: s.types.map((t) => ({ key: t.key, label: t.label, sqmMin: t.sqmMin, sqmMax: t.sqmMax })),
      freehold: q.enabled
        ? {
            pct: q.pct,
            sellableSqm: q.sellableSqm,
            foreign: { capSqm: q.foreign.capSqm, availableSqm: q.foreign.availableSqm, soldPct: q.foreign.soldPct },
            local: { capSqm: q.local.capSqm, availableSqm: q.local.availableSqm, soldPct: q.local.soldPct },
            undeclaredUnits: q.undeclaredUnits,
            foreignIsEstimate: q.foreignIsEstimate,
          }
        : null,
    };
  }));
  return NextResponse.json({ buildings: summaries });
}
