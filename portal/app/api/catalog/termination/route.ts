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
import { requireEditable, inventoryVerbFor, resolveNoticeParties, callerOwnsBuilding } from "@/lib/catalog-edit-gate";
import { logActivity } from "@/lib/activity";
import { requireCaller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = String(body.building ?? "").trim();
  // AUTH (F3 class): same as /api/catalog/terms — the real UI sends NO `by` (legacy path), but a supplied
  // `by` drives the freeze gate on an ownership-blind decision, so a forged `by` could rewrite another dev's
  // buyer-default/termination figures. `by` present → MUST be the PROVEN caller; absent → legacy path untouched.
  let by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  if (by) {
    const who = requireCaller(req, { param: by });
    if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
    by = who.account;
  }
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  // Freeze gate: buyer-default/termination figures are material `terms` (version-gated by
  // default). Gate only when a developer identity (`by`) is supplied (the pre-gate demo path is left to the
  // deferred signing arc).
  if (by) {
    // OWNERSHIP: a supplied `by` is the PROVEN caller and must own this building (freeze gate is
    // ownership-blind). Only on the `by` path — the no-`by` legacy UI path is bound by the signing arc.
    if (!(await callerOwnsBuilding(by, buildingId))) {
      return NextResponse.json({ error: "only the building's developer may set its termination terms" }, { status: 403 });
    }
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
