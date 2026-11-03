// /api/admin/images — ADMIN image-review surface. Lists every floorplan + rendering image
// under public/, grouped building → category → files, so the review page can show a visual grid and the
// operator can spot the "not good" ones + replace them surgically (see ./replace). READ-ONLY here.
//
// SCOPE: only public/floorplans and public/renderings (the buyer-facing visual set). NOT the .data/images
// portrait pyramid (a different store) and never anything outside these two roots.
//
// AUTH: gated behind the same operator posture as the rest of the admin surfaces — the dev-signer fence
// (demo/localnet armed) OR an operator secret. On the public demo box (NEXT_PUBLIC_VRX_DEMO=1) it is armed,
// which is acceptable because these are non-sensitive marketing images, not PII. A real prod deploy without
// the demo flag returns 403.

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";
import { getCatalog } from "@/lib/catalog";
import { expectedUnitPlanKey } from "@/lib/floorplans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const ROOTS = ["floorplans", "renderings"] as const;
const IMG_RE = /\.(jpe?g|png|webp)$/i;

type ImgNode = { name: string; url: string; relPath: string; sizeKb: number };
type CatNode = { category: string; images: ImgNode[] };
type BuildingNode = { building: string; categories: CatNode[] };
type RootNode = { root: string; buildings: BuildingNode[] };

/** Recursively collect image files under `dir`, returning paths RELATIVE to PUBLIC_DIR (forward-slashed). */
async function collectImages(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectImages(abs)));
    else if (IMG_RE.test(e.name)) out.push(path.relative(PUBLIC_DIR, abs).split(path.sep).join("/"));
  }
  return out;
}

export async function GET() {
  if (!demoRoleUxArmed()) {
    return NextResponse.json({ error: "admin image review is sandbox-only" }, { status: 403 });
  }
  const roots: RootNode[] = [];
  for (const root of ROOTS) {
    const rootDir = path.join(PUBLIC_DIR, root);
    const rel = await collectImages(rootDir); // e.g. "floorplans/palmgate/units/1BR_B.jpg"
    // Group: root/<building>/<category...>/<file>. category = the middle path segments joined (or "(root)").
    const byBuilding = new Map<string, Map<string, ImgNode[]>>();
    for (const r of rel) {
      const parts = r.split("/"); // [root, building...middle, file]
      const building = parts[1] ?? "(none)";
      const file = parts[parts.length - 1];
      const category = parts.slice(2, -1).join("/") || "(root)";
      let stat = { size: 0 };
      try {
        stat = await fs.stat(path.join(PUBLIC_DIR, r));
      } catch {
        /* ignore */
      }
      const sizeKb = Math.round(stat.size / 1024);
      const node: ImgNode = { name: file, url: `/${r}`, relPath: r, sizeKb };
      if (!byBuilding.has(building)) byBuilding.set(building, new Map());
      const cats = byBuilding.get(building)!;
      if (!cats.has(category)) cats.set(category, []);
      cats.get(category)!.push(node);
    }
    const buildings: BuildingNode[] = [...byBuilding.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([building, cats]) => ({
        building,
        categories: [...cats.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([category, images]) => ({ category, images: images.sort((x, y) => x.name.localeCompare(y.name)) })),
      }));
    roots.push({ root, buildings });
  }
  const total = roots.reduce((n, r) => n + r.buildings.reduce((m, b) => m + b.categories.reduce((k, c) => k + c.images.length, 0), 0), 0);

  // ── MISSING subtype plans: a {type, subtype} that EXISTS in a building's inventory but whose expected
  // unit-plan file is NOT on disk. The buyer's UnitDetail would show no floor plan for these — a mandatory gap
  //  wants to fill. We enumerate every distinct {type, subtype} per building, map it to its expected key
  // (lib/floorplans.expectedUnitPlanKey), and check whether ANY image file for that key exists in
  // public/floorplans/<building>/units/ (any image extension). Report the ones with no file as an upload slot.
  const missing: { building: string; type: string; subtype: string; expectedKey: string; uploadRelPath: string }[] = [];
  try {
    const catalog = await getCatalog();
    for (const bld of catalog) {
      const unitsDir = path.join(PUBLIC_DIR, "floorplans", bld.id, "units");
      let present: string[] = [];
      try {
        present = (await fs.readdir(unitsDir)).filter((f) => IMG_RE.test(f));
      } catch {
        /* no units dir → everything's missing for this building */
      }
      const presentKeys = new Set(present.map((f) => f.replace(IMG_RE, "").toUpperCase()));
      const seen = new Set<string>();
      for (const u of bld.inventory || []) {
        const key = expectedUnitPlanKey(u.type, u.subtype);
        if (!key || seen.has(key)) continue; // skip types with no plan family (e.g. plain penthouse) + dedupe
        seen.add(key);
        if (!presentKeys.has(key.toUpperCase())) {
          missing.push({
            building: bld.id,
            type: u.type,
            subtype: u.subtype || "A",
            expectedKey: key,
            // default to .jpg for the upload target; the replace route accepts the real mime on upload.
            uploadRelPath: `floorplans/${bld.id}/units/${key}.jpg`,
          });
        }
      }
    }
  } catch {
    /* catalog read failed — return images without the missing section rather than 500 */
  }

  return NextResponse.json({ ok: true, total, roots, missing });
}
