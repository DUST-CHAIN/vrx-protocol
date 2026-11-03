// /api/admin/images/replace — overwrite ONE floorplan/rendering image in place. The surgical
// half of the review UI: the operator downloads a bad image, edits it locally, uploads it back here to the
// EXACT same path → the live file is replaced. No new path is created; you can only overwrite an EXISTING
// image under public/floorplans or public/renderings.
//
// SECURITY: the target is a client-supplied relPath — HARD-validated to (1) start with floorplans/ or
// renderings/, (2) resolve (after normalization) to a path that stays inside PUBLIC_DIR (no ../ traversal),
// (3) point at a file that ALREADY exists (replace, never create). Fails closed on any of these. Same
// demo-armed gate as the list route (non-sensitive marketing images; 403 on a non-demo prod build).

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const ALLOWED_ROOTS = ["floorplans/", "renderings/"];
const OK_MIME = /^image\/(jpeg|png|webp)$/i;
const MAX_BYTES = 6 * 1024 * 1024; // 6 MB — generous for a high-res plan/render

// WRITE gate — same x-vrx-operator convention as /api/root, /api/faucet, /api/developers: the public
// demo box has VRX_OPERATOR_SECRET SET, so a demo visitor (no secret) is DENIED any image overwrite. On the
// local laptop the secret is unset → open. Demo users can still BROWSE (the GET route only needs demo-armed)
// and trace in-browser — they just can't SAVE over the server's images. Fails closed when the secret is set.
function isOperator(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

export async function POST(req: Request) {
  if (!demoRoleUxArmed()) {
    return NextResponse.json({ error: "admin image replace is sandbox-only" }, { status: 403 });
  }
  if (!isOperator(req)) {
    return NextResponse.json({ error: "editing images requires the operator key (view-only for demo users)" }, { status: 403 });
  }
  const ctype = req.headers.get("content-type") || "";
  if (!ctype.includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart/form-data required" }, { status: 415 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid form" }, { status: 400 });

  const relPath = String(form.get("relPath") || "").trim().replace(/\\/g, "/");
  const file = form.get("file");
  // allowCreate=true lets the review UI fill a MISSING subtype plan (create a new file). Fenced to the
  // floorplans/<building>/units/ shape so it can only ever create a well-formed unit-plan slot, never an
  // arbitrary new path. Default false = strict replace-only.
  const allowCreate = String(form.get("allowCreate") || "") === "true";

  // 1. must target an allowed root
  if (!ALLOWED_ROOTS.some((r) => relPath.startsWith(r))) {
    return NextResponse.json({ error: "relPath must be under floorplans/ or renderings/" }, { status: 400 });
  }
  // 2. must resolve inside PUBLIC_DIR (defeat ../ traversal)
  const abs = path.resolve(PUBLIC_DIR, relPath);
  if (abs !== path.normalize(abs) || !abs.startsWith(PUBLIC_DIR + path.sep)) {
    return NextResponse.json({ error: "path escapes public dir" }, { status: 400 });
  }
  // 3. the target file: must EXIST (replace) — UNLESS allowCreate for a well-formed units/ plan slot.
  let exists = true;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    exists = false;
  }
  if (!exists) {
    const isUnitPlanSlot = /^floorplans\/[^/]+\/units\/[^/]+\.(jpe?g|png|webp)$/i.test(relPath);
    if (!allowCreate || !isUnitPlanSlot) {
      return NextResponse.json({ error: "target image does not exist (replace only)" }, { status: 404 });
    }
    // creating a new plan slot → ensure the units/ dir exists.
    await fs.mkdir(path.dirname(abs), { recursive: true });
  }
  // 4. a valid image upload
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (!OK_MIME.test(file.type)) return NextResponse.json({ error: "images only (jpeg/png/webp)" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "image too large (max 6 MB)" }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  // Back up the previous file once (first replace) so a mistaken overwrite is recoverable.
  const bak = abs + ".bak";
  try {
    await fs.access(bak);
  } catch {
    try {
      await fs.copyFile(abs, bak);
    } catch {
      /* best-effort backup */
    }
  }
  await fs.writeFile(abs, bytes);
  return NextResponse.json({ ok: true, relPath, sizeKb: Math.round(bytes.length / 1024), replacedAt: Date.now() });
}
