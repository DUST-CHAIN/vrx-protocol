// /api/kyc-vault/doc — serve ONE decrypted KYC document's bytes, to an AUTHORIZED reader only (pt-2).
// This is the ONLY path plaintext KYC leaves the server; everything else is metadata. Two authorized paths:
//
//   (A) THE OWNING AGENT — GET ?buyerId=&docId=&agent=<account>
//       The agent that owns the buyer roster record may view what they uploaded. Scoped by lib/kyc-vault.
//
//   (B) THE DEVELOPER AT THE PRE-SIGN GATE — GET ?requestId=&docId=&viewer=<developer account>
//  Before signing the S&P the developer is SHOWN the buyer KYC (: "shown all these buyer-KYC
//       docs + must click an acknowledgement"). We authorize via the participant chokepoint (lib/participant)
//  AND require the buyer identity to be REVEALED to them (offer.unlock.revealed) — the same gate
//       that guards the full buyer detail. The requestId → buyerId join is the off-seal offer.display.buyerId
//       the agent stamped at booking time. The developer never gets the agent-scoped path; the agent never
//       needs the requestId path. Fail CLOSED for anyone else.
//
// PRIVACY: the image is PII — it is decrypted in-memory and streamed with no-store caching; it is never
// written to disk in plaintext, never logged, never put on-chain (only a content HASH may ride in a seal).

import { NextResponse } from "next/server";
import { decryptDoc, getEntry, getEntryForAgent } from "@/lib/kyc-vault";
import { getOffer } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const docId = url.searchParams.get("docId")?.trim() || "";
  const agent = url.searchParams.get("agent")?.trim() || "";
  const requestId = url.searchParams.get("requestId")?.trim() || "";
  const viewer = url.searchParams.get("viewer")?.trim() || "";
  if (!docId) return NextResponse.json({ error: "docId required" }, { status: 400 });

  let buyerId = "";

  // (A) agent path — scoped to the owning agent.
  if (agent) {
    const bId = url.searchParams.get("buyerId")?.trim() || "";
    if (!bId) return NextResponse.json({ error: "buyerId required" }, { status: 400 });
    const entry = await getEntryForAgent(bId, agent);
    if (!entry) return NextResponse.json({ error: "not found" }, { status: 404 });
    buyerId = bId;
  }
  // (B) developer-at-the-gate path — participant-scoped + reveal-gated.
  else if (requestId && viewer) {
    const offer = await getOffer(requestId);
    if (!offer) return NextResponse.json({ error: "booking not on file" }, { status: 404 });
    const role = await roleOnOffer(offer, viewer);
    if (role !== "developer") return NextResponse.json({ error: "not permitted" }, { status: 403 });
    // The buyer identity must already be disclosed to the developer (the same gate as the full detail).
    if (!offer.unlock?.revealed) {
      return NextResponse.json({ error: "buyer identity not yet revealed" }, { status: 403 });
    }
    const bId = offer.display?.buyerId?.trim() || "";
    if (!bId) return NextResponse.json({ error: "no KYC on file for this booking" }, { status: 404 });
    // Confirm the doc belongs to that buyer's entry (guards a crafted docId from another buyer).
    const entry = await getEntry(bId);
    if (!entry || !entry.docs.some((d) => d.id === docId)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    buyerId = bId;
  } else {
    return NextResponse.json({ error: "authorize via agent+buyerId, or requestId+viewer" }, { status: 400 });
  }

  const plain = await decryptDoc(buyerId, docId);
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
