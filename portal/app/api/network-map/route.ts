// GET /api/network-map — the ecosystem map's live data (: "feed the map from real system geodata").
//
// Returns the REAL building locations from the catalog (name + area + lat/lng). A building's location is NOT
// PII — it's public market info, safe to show anyone INCLUDING buyers. So buildings are returned
// unconditionally. (Agencies/devs are DEMO-ONLY and buyers are NEVER mapped; those layers stay
// client-side/vendored for now. This route is deliberately buildings-only so it can never leak a
// party's location.)
//
// PRIVACY: only { id, name, area, lat, lng } per building — no units, no PII, no terms. Exactly the public
// map-pin fields the read-only LocationMap already shows per building.

import { NextResponse } from "next/server";
import { getCatalog } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export type MapBuilding = { id: string; name: string; area: string; lat: number; lng: number };

export async function GET() {
  try {
    const catalog = await getCatalog();
    const buildings: MapBuilding[] = catalog
      .filter((b) => b.geo && Number.isFinite(b.geo.lat) && Number.isFinite(b.geo.lng))
      .map((b) => ({ id: b.id, name: b.name, area: b.area ?? "", lat: b.geo!.lat, lng: b.geo!.lng }));
    return NextResponse.json({ buildings });
  } catch {
    // The map is decoration — never 500 the page; return empty so the node/agency layers still render.
    return NextResponse.json({ buildings: [] });
  }
}
