// /api/account-images — resolve an account's image slots (photo subsystem).
//
//   GET ?account=<acct>  → { portrait: { imageId, iconUrl, displayUrl } | null,
//                            passport: { imageId } | null }
//
// Public-safe: it returns the PORTRAIT's serve URLs (the portrait is a public avatar) + whether a passport
// exists (an imageId only — the passport BYTES are gated by the serve route's mask spine; this endpoint never
// serves or confirms passport content, it just lets the owner's own UI know a sealed doc is on file).
//
// PRIVACY: the passport imageId alone is an opaque handle; it serves nothing without passing the serve
// route's self/consented gate. Portrait URLs are public by design (the avatar).

import { NextResponse } from "next/server";
import { imagesFor } from "@/lib/account-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account")?.trim();
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  const rec = await imagesFor(account);
  return NextResponse.json({
    portrait: rec?.portrait
      ? {
          imageId: rec.portrait,
          iconUrl: `/api/images/${rec.portrait}?variant=icon`,
          displayUrl: `/api/images/${rec.portrait}?variant=display`,
        }
      : null,
    passport: rec?.passport ? { imageId: rec.passport } : null,
  });
}
