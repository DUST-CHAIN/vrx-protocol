// /api/buyer-vault/doc — serve ONE of the buyer's OWN decrypted KYC documents back to THAT buyer.
// Buyer-owned twin of /api/kyc-vault/doc. The only authorized reader is the SAME wallet account that owns
// the doc (the buyer viewing their own upload) — fail CLOSED for anyone else. (A developer/operator view of
// a direct buyer's docs at a future pre-offer gate is a separate authorized path, added when that gate exists
// — not here; this slice only lets the buyer see what they uploaded.)
//
// PRIVACY: the image is PII — decrypted in-memory, streamed with no-store caching, never written to
// disk in plaintext, never logged, never on-chain (only a content hash may ride in a seal later).

import { NextResponse } from "next/server";
import { decryptBuyerDoc } from "@/lib/kyc-vault-buyer";
import { requireCaller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const claimed = url.searchParams.get("account")?.trim() || "";
  const docId = url.searchParams.get("docId")?.trim() || "";
  if (!docId) return NextResponse.json({ error: "docId required" }, { status: 400 });

  // AUDIT VRX-0002 sibling: serves DECRYPTED buyer passport bytes — derive the account from the proven
  // caller, never a forgeable `?account=`. A stranger can no longer name a victim to pull their KYC image.
  const caller = requireCaller(req, { param: claimed });
  if (!caller.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });

  const plain = await decryptBuyerDoc(caller.account, docId);
  if (!plain) return NextResponse.json({ error: "not found or undecryptable" }, { status: 404 });

  return new NextResponse(new Uint8Array(plain.bytes), {
    status: 200,
    headers: {
      "content-type": plain.mime || "application/octet-stream",
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "content-disposition": `inline; filename="${encodeURIComponent(plain.filename)}"`,
    },
  });
}
