// POST /api/catalog/termination — developer sets/updates a BUILDING's buyer-default / termination clause
// numbers (§config-surface): the per-building override of the §Default-and-Termination
// figures (threshold %, cure-day floor, interest % p.a.) for that building's buyers' S&Ps.
//
//   POST { building, terminationTerms }  → save the override; terminationTerms:null (or no valid field) CLEARS
//                                          it (the building then inherits the developer's house default).
//
// THE TOP TIER of the 3-tier chain (building → developer house default → code default, lib/termination-terms
// resolveTerminationChain). These are the DEVELOPER's OWN terms toward buyers — NOT VRX's fee/settlement terms.
// A specific project may need different buyer-default figures than the developer's house default (a luxury
// tower vs a budget block), which is why it lives per-building, exactly like tax (taxPct) and the commission
// envelope (termsEnvelope) already do.
//
// OFF-CHAIN, developer-authored building context (not PII, like geo/ and the commission terms-envelope).
// Persists through the same file-backed catalog override store (saveBuilding). AUTH posture matches the rest
// of the off-chain demo layer (trusted caller; the real signed-request binding is the deferred signing arc,
// F1). Server-side validated (cleanTerminationTerms) so a malformed payload can't corrupt the store. Only NEW
// S&P renders use the override; an already-sealed agreement keeps its frozen numbers.

import { NextResponse } from "next/server";
import { getBuilding, saveBuilding } from "@/lib/catalog";
import { cleanTerminationTerms } from "@/lib/termination-terms";
import { requireEditable, inventoryVerbFor, resolveNoticeParties } from "@/lib/catalog-edit-gate";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = String(body.building ?? "").trim();
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  // Freeze gate: buyer-default/termination figures are material `terms` (version-gated by
  // default). Gate only when a developer identity (`by`) is supplied (the pre-gate demo path is left to the
  // deferred signing arc).
  if (by) {
    const gate = await requireEditable(by, buildingId, "terms");
    if (!gate.allowed) return NextResponse.json(gate.body, { status: gate.status });
  }

  // null/invalid → cleared (the building inherits the developer house default). A valid partial is stored
  // field-by-field (a building may override only its threshold, inheriting the rest).
  const cleaned = cleanTerminationTerms(body.terminationTerms);
  building.terminationTerms = cleaned ?? undefined;
  await saveBuilding(building);
  if (by) await logActivity(inventoryVerbFor("terms"), by.toLowerCase(), { kind: "unit", id: buildingId }, await resolveNoticeParties(by, buildingId), { building: building.name });
  return NextResponse.json({ ok: true, terminationTerms: building.terminationTerms ?? null });
}
