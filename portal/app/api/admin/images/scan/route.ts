// /api/admin/images/scan — OPT-IN quality scan. Runs the sharp-based analyzer over every floorplan +
// rendering image and returns a { relPath -> {w,h,flags} } map. SEPARATE from the (fast) list route so the
// grid loads instantly; the operator clicks "Scan quality" to pay the sharp cost once. Cached by file
// mtime+size in lib/image-quality, so a re-scan after an edit is near-instant for unchanged files.

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";
import { analyzeImage, type Quality } from "@/lib/image-quality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const ROOTS = ["floorplans", "renderings"];
const IMG_RE = /\.(jpe?g|png|webp)$/i;

async function collect(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collect(abs)));
    else if (IMG_RE.test(e.name)) out.push(path.relative(PUBLIC_DIR, abs).split(path.sep).join("/"));
  }
  return out;
}

export async function GET() {
  if (!demoRoleUxArmed()) {
    return NextResponse.json({ error: "admin image scan is sandbox-only" }, { status: 403 });
  }
  const quality: Record<string, Quality> = {};
  let flaggedCount = 0;
  for (const root of ROOTS) {
    const rel = await collect(path.join(PUBLIC_DIR, root));
    for (const r of rel) {
      const q = await analyzeImage(path.join(PUBLIC_DIR, r));
      // only return entries that carry signal (dimensions or flags) to keep the payload small
      if (q.flags.length || q.w) quality[r] = q;
      if (q.flags.length) flaggedCount++;
    }
  }
  return NextResponse.json({ ok: true, flaggedCount, quality });
}
