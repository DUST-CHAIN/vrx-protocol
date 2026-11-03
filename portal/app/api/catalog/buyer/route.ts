// BUYER-SCOPED catalog read (§9 step 2). What a logged-in, pre-conversation DIRECT BUYER may browse:
// ONLY direct-sale-visible buildings, projected to photos + description + unit count + price range (lib/
// buyer-catalog). Fail-closed — a hidden building 404s; its un-projected fields never leave the server.
//
//   GET /api/catalog/buyer            → all visible buildings (buyer projection)
//   GET /api/catalog/buyer?building=X → one building's buyer projection, or 404 if not visible/not found
//
// This is a SEPARATE route from the full developer/agent catalog (/api/catalog) on purpose: a buyer viewer
// has its own endpoint that can ONLY ever return the lossy projection. There is no auth beyond "this is the
// buyer surface" in this slice — the projection itself is the protection (nothing sensitive is reachable),
// matching the capability posture of the rest of the off-chain demo layer.

import { NextResponse } from "next/server";
import { buyerCatalog, buyerBuilding } from "@/lib/buyer-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("building");
  if (id && id.trim()) {
    const building = await buyerBuilding(id);
    if (!building) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ building });
  }
  const buildings = await buyerCatalog();
  return NextResponse.json({ buildings });
}
