// GET /api/building-docs/view?id=<docId> — stream a decrypted building document for inline viewing.
//
// Party-open §3 (a title deed is meant to be seen by the deal parties). Decrypts on the server and
// streams the plaintext bytes with the right content-type so the browser renders the PDF/image inline (the
// reusable document lightbox points an <iframe>/<img> at this URL). Not reveal-gated; the signed-request
// binding is the deferred signing arc (F1).

import { NextResponse } from "next/server";
import { decryptDoc } from "@/lib/building-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id")?.trim() || "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const doc = await decryptDoc(id);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(doc.bytes), {
    status: 200,
    headers: {
      "content-type": doc.mime,
      "content-disposition": `inline; filename="${doc.filename.replace(/[^\w.\- ]/g, "_")}"`,
      "cache-control": "private, no-store",
    },
  });
}
