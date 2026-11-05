// /api/buyer-vault — the DIRECT BUYER uploads/manages their OWN encrypted KYC documents. Buyer-owned
// twin of /api/kyc-vault (which is agent-owned). Scoped to the buyer's connected wallet `account`; there is
// no cross-account read/write. Reuses the same AES-256-GCM envelope vault (lib/kyc-vault-buyer → lib/
// kyc-vault crypto + the Tier-2 KEK). Encrypted at rest; nothing signed, nothing on-chain (-safe).
//
//   GET    ?account=<id>              → { docs } metadata (NO bytes, NO crypto) the buyer has uploaded.
//   POST   (multipart/form-data)      → UPLOAD one encrypted doc. fields: account, kind, file.
//   DELETE ?account=&docId=           → delete one of the buyer's own docs.
//
// AUTH POSTURE (demo-layer, same as /api/buyers-direct): the caller NAMES its wallet `account`; a signed-
// session binding account→caller is the deferred signing-arc hardening. A buyer can only ever touch the
// documents for the account it names.

import { NextResponse } from "next/server";
import { getBuyerVault, addBuyerDoc, deleteBuyerDoc, buyerVaultMeta, VaultLockedError, type KycDocKind } from "@/lib/kyc-vault-buyer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The direct buyer uploads a selfie (headshot) + a passport and/or national ID. `card_front` is excluded
// here — a direct buyer has no reason to upload a credit card to browse (that stays an agent-flow concept).
const KINDS: KycDocKind[] = ["headshot", "passport", "id_card"];
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — a phone photo of an ID/passport fits comfortably
const OK_MIME = /^image\/(jpeg|png|webp|heic|heif)$/i;

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  const entry = await getBuyerVault(account);
  return NextResponse.json(buyerVaultMeta(entry));
}

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") || "";
  if (!ctype.includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart/form-data required" }, { status: 415 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid form" }, { status: 400 });

  const account = String(form.get("account") || "").trim();
  const kind = String(form.get("kind") || "").trim() as KycDocKind;
  const file = form.get("file");
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  if (!KINDS.includes(kind)) return NextResponse.json({ error: "kind must be one of " + KINDS.join("|") }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (!OK_MIME.test(file.type)) return NextResponse.json({ error: "images only (jpeg/png/webp/heic)" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "image too large (max 8 MB)" }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    const entry = await addBuyerDoc(account, kind, { bytes, filename: file.name || `${kind}.img`, mime: file.type });
    return NextResponse.json({ ok: true, ...buyerVaultMeta(entry) });
  } catch (e) {
    if (e instanceof VaultLockedError) {
      return NextResponse.json({ error: "vault is locked — an operator must unlock it before uploads" }, { status: 503 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "upload failed" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  const docId = url.searchParams.get("docId")?.trim() || "";
  if (!account || !docId) return NextResponse.json({ error: "account + docId required" }, { status: 400 });
  const entry = await deleteBuyerDoc(account, docId);
  return NextResponse.json({ ok: true, ...buyerVaultMeta(entry) });
}
