// api/building-docs — building legal/physical documents (title-deed stub).
// GET ?building=<id> → list a building's documents (metadata only).
// POST (multipart: building, kind, file) → upload/replace a document (encrypted at rest).
// DELETE ?building=<id>&kind=<kind> → remove a document.
// The DOCUMENT stays off-chain, encrypted at rest; only its hash is sealed on-chain at "this is final"
// ( §2 — the on-chain seal is the DEFERRED wallet-arc part). Per §3 the title deed is PARTY-OPEN
// (meant to be seen by the deal parties), so listing/viewing is not reveal-gated. Writes are a developer
// action; AUTH posture matches the rest of the off-chain demo layer (trusted caller; the real signed-request
// binding is the deferred signing arc, F1). Server-side validated so a malformed payload can't corrupt the store.

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import {
  addDoc,
  listDocs,
  removeDoc,
  BUILDING_DOC_KINDS,
  OK_DOC_MIME,
  MAX_DOC_BYTES,
  type BuildingDocKind,
} from "@/lib/building-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const building = new URL(req.url).searchParams.get("building")?.trim() || "";
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });
  return NextResponse.json({ docs: await listDocs(building) });
}

export async function POST(req: Request) {
  if (!req.headers.get("content-type")?.includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart/form-data required" }, { status: 415 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid form" }, { status: 400 });

  const building = String(form.get("building") || "").trim();
  const kind = String(form.get("kind") || "").trim() as BuildingDocKind;
  const file = form.get("file");
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });
  if (!BUILDING_DOC_KINDS.includes(kind)) {
    return NextResponse.json({ error: "kind must be one of " + BUILDING_DOC_KINDS.join("|") }, { status: 400 });
  }
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (!OK_DOC_MIME.test(file.type)) return NextResponse.json({ error: "PDF or image only" }, { status: 400 });
  if (file.size > MAX_DOC_BYTES) return NextResponse.json({ error: "file too large (max 12 MB)" }, { status: 400 });

  const b = await getBuilding(building);
  if (!b) return NextResponse.json({ error: "building not found" }, { status: 404 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const entry = await addDoc(building, kind, {
    bytes,
    filename: file.name || `${kind}`,
    mime: file.type,
  });
  return NextResponse.json({ ok: true, doc: entry });
}

export async function DELETE(req: Request) {
  const sp = new URL(req.url).searchParams;
  const building = sp.get("building")?.trim() || "";
  const kind = (sp.get("kind")?.trim() || "") as BuildingDocKind;
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });
  if (!BUILDING_DOC_KINDS.includes(kind)) return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  await removeDoc(building, kind);
  return NextResponse.json({ ok: true });
}
