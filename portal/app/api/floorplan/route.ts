// /api/floorplan — SERVE a GATED floor-plan image (the rule: "plans are NOT for anyone — only what is
// marked as marketing materials is for anyone"). SERVER-ONLY.
//
// Floor plans reveal exact unit LAYOUTS, so they are SENSITIVE (unlike renderings, which are marketing and stay
// public static). They are served ONLY through this route, from a NON-PUBLIC media dir (private-media/floorplans)
// — the files are NO LONGER under /public, so the old /floorplans/… static path 404s (no bypass).
//
//   GET /api/floorplan?building=<id>&kind=units|levels&file=<name>&account=<viewer>
//     -> the image bytes (200) | 401 (no session) | 403 (not entitled) | 404 (no such plan)
//
// ── ACCESS (fail-closed) ─────────────────────────────────────────────────────────────────────────────────────
//   • requireCaller binds the viewer to the proven session (never a trusted ?account=).
//   • ENTITLED = the building's DESK DEVELOPER (callerOwnsBuilding) OR a BUYER who has been OPENED at least one
//     unit in this building (grantsForBuyerBuilding ≥ 1). A browsing-but-not-opened buyer does NOT see plans —
//     that is the leak this closes. Plans are building-scoped (shared by unit type/floor), so a single grant in
//     the building is the right granularity (we don't tie a shared plan to one specific unit).
//
// PRIVACY: only the bytes leave; identity is never in the response. Served no-store (not cacheable by a
// shared cache — a gated asset must re-check entitlement each time, unlike a public render).

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { requireCaller } from "@/lib/caller";
import { callerOwnsBuilding } from "@/lib/catalog-edit-gate";
import { grantsForBuyerBuilding } from "@/lib/unit-grants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The non-public media root the gated plans live under (hardlinked here at deploy from the persistent media dir,
// NOT into /public). Co-located with .data under the app cwd.
const PLAN_ROOT = path.join(process.cwd(), "private-media", "floorplans");

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

/** A filename component is safe iff it has no path separators / traversal. The building id + kind + file are each
 *  validated so a crafted `file=../../etc/passwd` cannot escape PLAN_ROOT. */
const safe = (s: string) => /^[A-Za-z0-9._-]+$/.test(s);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const building = (url.searchParams.get("building") ?? "").trim();
  const kind = (url.searchParams.get("kind") ?? "").trim(); // "units" | "levels"
  const file = (url.searchParams.get("file") ?? "").trim();
  const claimed = (url.searchParams.get("account") ?? "").trim();

  if (!building || !file || (kind !== "units" && kind !== "levels")) {
    return NextResponse.json({ error: "building + kind(units|levels) + file required" }, { status: 400 });
  }
  if (!safe(building) || !safe(file)) {
    return NextResponse.json({ error: "bad path" }, { status: 400 });
  }

  // Bind the viewer to the proven session (never the ?account= param).
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const viewer = who.account;

  // ENTITLEMENT: the owning developer, OR a buyer opened ≥1 unit in this building. Else 403 (fail-closed).
  const owns = await callerOwnsBuilding(viewer, building);
  const hasGrant = owns ? true : (await grantsForBuyerBuilding(viewer, building)).length > 0;
  if (!owns && !hasGrant) {
    return NextResponse.json({ error: "not permitted" }, { status: 403 });
  }

  const abs = path.join(PLAN_ROOT, building, kind, file);
  // Defence in depth: the resolved path MUST stay within PLAN_ROOT (belt for the regex above).
  if (!abs.startsWith(PLAN_ROOT + path.sep)) {
    return NextResponse.json({ error: "bad path" }, { status: 400 });
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(abs);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const mime = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": mime, "cache-control": "no-store, private" },
  });
}
