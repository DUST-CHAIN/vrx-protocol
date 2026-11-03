// /api/admin/images/plan — the TRACED UNIT PLAN sidecar (D-). The data-merge transport between the
// tracer (portal/app) and MM (portal/mm) — two separate Next apps that can't import each other (D-). The
// tracer POSTs a serializable TracedUnitPlan (lib/tracer-to-unitplan) for a unit-plan image path; MM GETs it and
// feeds the structural UnitPlan subset to setSubtypePlan. Stored as a JSON sidecar NEXT TO the image:
//   public/floorplans/<building>/units/<KEY>.plan.json
//
// Keyed by the SAME unit-plan path the tracer already opens on (?img=floorplans/<building>/units/<KEY>.<ext>),
// so a plan is bound to its type+subtype by construction — no separate id. Read-only GET needs demo-armed; the
// WRITE is operator-gated (x-vrx-operator), identical to the image-replace route (a demo visitor can trace in
// the browser but can't persist a plan over the server's data). Fails closed; ../ traversal fenced.

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — a plan with an inline backdrop data URL can be large but bounded

// Same operator gate as the image-replace route: the demo box has VRX_OPERATOR_SECRET set → a demo visitor is
// denied any write; local (unset) is open. Fails closed when the secret is set.
function isOperator(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

/** Validate the image relPath → the sidecar's absolute path, or null if it isn't a safe unit-plan path. The
 *  sidecar replaces the image extension with `.plan.json` and must resolve inside PUBLIC_DIR (no traversal). */
function sidecarFor(relPathRaw: string): { abs: string; rel: string } | null {
  const relPath = relPathRaw.trim().replace(/\\/g, "/").replace(/^\//, "");
  // must be a unit-plan image path: floorplans/<building>/units/<KEY>.<ext>
  if (!/^floorplans\/[^/]+\/units\/[^/]+\.(?:jpe?g|png|webp)$/i.test(relPath)) return null;
  const rel = relPath.replace(/\.(?:jpe?g|png|webp)$/i, ".plan.json");
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null; // traversal fence
  return { abs, rel };
}

/** GET ?relPath=<unit-plan image path> → the stored TracedUnitPlan, or { plan: null } if none. (MM import reads this.) */
export async function GET(req: Request) {
  if (!demoRoleUxArmed()) return NextResponse.json({ error: "sandbox-only" }, { status: 403 });
  const relPath = new URL(req.url).searchParams.get("relPath") || "";
  const side = sidecarFor(relPath);
  if (!side) return NextResponse.json({ error: "not a unit-plan path" }, { status: 400 });
  try {
    const raw = await fs.readFile(side.abs, "utf8");
    return NextResponse.json({ ok: true, plan: JSON.parse(raw) });
  } catch {
    return NextResponse.json({ ok: true, plan: null }); // no sidecar yet = nothing traced into data
  }
}

/** POST { relPath, plan } → write the TracedUnitPlan sidecar. Operator-gated. */
export async function POST(req: Request) {
  if (!demoRoleUxArmed()) return NextResponse.json({ error: "sandbox-only" }, { status: 403 });
  if (!isOperator(req)) {
    return NextResponse.json({ error: "saving a plan requires the operator key (view-only for demo users)" }, { status: 403 });
  }
  let body: { relPath?: unknown; plan?: unknown };
  try {
    body = (await req.json()) as { relPath?: unknown; plan?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const side = sidecarFor(typeof body.relPath === "string" ? body.relPath : "");
  if (!side) return NextResponse.json({ error: "not a unit-plan path" }, { status: 400 });

  // The plan must look like a TracedUnitPlan (a poly footprint). We don't deep-validate every marker — the
  // adapter produces it and MM structurally consumes it — but we refuse an obviously-wrong shape (fail closed).
  const plan = body.plan as { footprint?: { shape?: string; points?: unknown }; source?: string } | undefined;
  if (!plan || plan.footprint?.shape !== "poly" || !Array.isArray(plan.footprint.points) || plan.footprint.points.length < 3) {
    return NextResponse.json({ error: "plan must carry a poly footprint of >= 3 points" }, { status: 400 });
  }
  const serialized = JSON.stringify(plan);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "plan too large (reduce the backdrop image)" }, { status: 413 });
  }
  try {
    await fs.mkdir(path.dirname(side.abs), { recursive: true });
    await fs.writeFile(side.abs, serialized, "utf8");
    return NextResponse.json({ ok: true, rel: side.rel });
  } catch {
    return NextResponse.json({ error: "could not write the plan sidecar" }, { status: 500 });
  }
}
