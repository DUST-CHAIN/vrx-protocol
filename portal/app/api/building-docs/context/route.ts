// api/building-docs/context — the "deal-terms control center" read for a building (ask #1).
// GET ?building=<id> → { developer, agencies, agreements, furniturePacks }
// This is PURE SURFACING of state that already exists elsewhere — it introduces no new data model. It joins
// the three stores the DocumentsPanel needs to show WHO IS SUBSCRIBED to this building and on what terms:
// • gates (lib/gates) — the ACCESS relationship. A gate is developer↔agency (not building-scoped);
// the catalog maps developer→buildings, so "agencies subscribed to THIS
// building" = the agencies with an active gate to the building's developer.
// • agreements (lib/agreements)— the per-agency TERMS. Filtered to the ones whose seal.buildings includes
// this building. Each carries the snapshotted commissionPct + scope + status
// + party identities. Served through publicAgreement so the secret per-record
// salt NEVER leaves the server (fix #1).
// • furniture packs (lib/furniture-packs) — the packs ATTACHED to this building (packsForBuilding).
// The developer is resolved SERVER-SIDE from the building (getBuilding.developer) so the client needn't pass
// it. AUTH posture matches the rest of the off-chain demo layer (trusted caller; the real signed-request
// binding is the deferred signing arc, F1). Read-only; no mutation here.

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import { listDevelopers } from "@/lib/developers";
import { agenciesForDeveloper } from "@/lib/gates";
import { listAllAgreements, publicAgreement, type PublicAgreement } from "@/lib/agreements";
import { packsForBuilding } from "@/lib/furniture-packs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const building = new URL(req.url).searchParams.get("building")?.trim() || "";
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });

  const b = await getBuilding(building);
  if (!b) return NextResponse.json({ error: "building not found" }, { status: 404 });

  // Resolve the developer ACCOUNT id (gates/agreements key on the neutral account, — NOT the catalog
  // display name b.developer). The developer registry maps account → its buildingIds, so the building's
  // developer is the row whose buildingIds include it. Fall back to the display name if unmapped (a new
  // building not yet registered) — the join just comes back empty, which is honest.
  const devs = await listDevelopers();
  const developer = devs.find((d) => d.buildingIds.includes(building))?.account ?? b.developer;

  // Access: agencies gated to this building's developer (gate is dev↔agency, catalog maps dev→building).
  const agencies = await agenciesForDeveloper(developer);

  // Terms: agreements that cover THIS building, salt-stripped + ✓-verified. An agreement is multi-building;
  // we keep only the clause for this building so the panel quotes the right commission snapshot + scope.
  const all = await listAllAgreements();
  const forBuilding = all.filter((g) => g.seal.buildings.some((bld) => bld.buildingId === building));
  const agreements: PublicAgreement[] = await Promise.all(forBuilding.map((g) => publicAgreement(g)));

  // Furniture packs attached to this building (developer-global packs "marked" for it).
  const furniturePacks = await packsForBuilding(building);

  // The developer's soft commission terms-envelope — lets the panel flag out-of-band snapshots.
  const termsEnvelope = b.termsEnvelope ?? null;

  return NextResponse.json({ developer, agencies, agreements, furniturePacks, termsEnvelope });
}
