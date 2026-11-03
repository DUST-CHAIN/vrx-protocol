// /api/admin/images/expected-area — the EXPECTED unit size (m²) for a floor-plan image, read from the catalog
// data. The tracer opens on ?img=/floorplans/<building>/units/<KEY>.jpg; the catalog already knows
// each unit's `sqm`, so instead of making the operator read + type "33.27" by hand, we look it up and offer a
// one-click "set to the data's size". Read-only; same demo-armed gate as the image list route.
//
// A plan KEY (e.g. "1BR_A") is shared by every unit of that type+subtype, so there may be several matching
// units. They SHOULD share a size; we return the distinct sqm values (and the modal/first as the suggestion).

import { NextResponse } from "next/server";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";
import { getCatalog } from "@/lib/catalog";
import { expectedUnitPlanKey } from "@/lib/floorplans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!demoRoleUxArmed()) {
    return NextResponse.json({ error: "sandbox-only" }, { status: 403 });
  }
  const relPath = (new URL(req.url).searchParams.get("relPath") || "").replace(/^\//, "");
  // expect floorplans/<building>/units/<KEY>.<ext>
  const m = /^floorplans\/([^/]+)\/units\/([^/]+)\.(?:jpe?g|png|webp)$/i.exec(relPath);
  if (!m) return NextResponse.json({ ok: true, expected: null, reason: "not a unit plan path" });
  const [, building, key] = m;
  const keyUpper = key.toUpperCase();

  try {
    const catalog = await getCatalog();
    const bld = catalog.find((b) => b.id === building);
    if (!bld) return NextResponse.json({ ok: true, expected: null, reason: "building not found" });
    const sizes = new Map<number, number>(); // sqm -> count
    for (const u of bld.inventory || []) {
      const k = expectedUnitPlanKey(u.type, u.subtype);
      if (k && k.toUpperCase() === keyUpper && typeof u.sqm === "number" && u.sqm > 0) {
        sizes.set(u.sqm, (sizes.get(u.sqm) || 0) + 1);
      }
    }
    if (sizes.size === 0) return NextResponse.json({ ok: true, expected: null, reason: "no matching unit with a size" });
    // suggestion = the most common size (modal); also return the distinct set for transparency.
    const entries = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
    return NextResponse.json({
      ok: true,
      building,
      key: keyUpper,
      expected: entries[0][0],
      allSizes: entries.map(([sqm, count]) => ({ sqm, count })),
    });
  } catch {
    return NextResponse.json({ ok: true, expected: null, reason: "catalog read failed" });
  }
}
