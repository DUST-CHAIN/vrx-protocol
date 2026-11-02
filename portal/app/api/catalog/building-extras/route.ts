// Building-specific (a schedule belongs to one building). Feeds the S&P "Construction and Handover" section;
// empty = the neutral "to be completed" fallback, exactly as before. (Furniture is NOT here — furniture packs
// are developer-GLOBAL + reusable; see /api/catalog/furniture-packs.)
// POST { building, constructionTimeline } — pass [] to clear. Server-validated.
// OFF-CHAIN, developer-authored. AUTH posture matches the rest of the off-chain demo layer (off-market, geo,
// KYC vault): trusted at the demo layer; the real signed-request binding is the deferred signing arc.

import { NextResponse } from "next/server";
import { getBuilding, saveBuilding, type BuildingMilestone } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate + normalise the construction timeline. Drops milestones without a label or date. */
function cleanTimeline(raw: unknown): BuildingMilestone[] {
  if (!Array.isArray(raw)) return [];
  const out: BuildingMilestone[] = [];
  for (const r of raw.slice(0, 40)) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const label = str(o.label, 120);
    const when = str(o.when, 80);
    if (!label || !when) continue;
    const m: BuildingMilestone = { label, when };
    if (o.projected === true) m.projected = true;
    out.push(m);
  }
  return out;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = str(body.building, 80);
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  if ("constructionTimeline" in body) {
    const t = cleanTimeline(body.constructionTimeline);
    building.constructionTimeline = t.length ? t : undefined;
  }

  await saveBuilding(building);
  return NextResponse.json({ ok: true, constructionTimeline: building.constructionTimeline ?? [] });
}
