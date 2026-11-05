// /api/payments/evidence — serve ONE decrypted payment SLIP's bytes, to an AUTHORIZED reader only
// (step 5). This is the ONLY path a payment slip's plaintext leaves the server; the
// /api/payments route serves only metadata (contentHash, filename, size). Authorized readers:
//
//   STANDING (always, no dispute needed):
//   (A) THE OWNING DEVELOPER                 — ?id=&viewer=<developer account>
//   (B) THE BUYER NAMED ON THE RECORD        — ?id=&viewer=<buyer account>
//  (C) THE BUYER'S AGENT / AGENCY (PROXY) — ?id=&viewer=<agent|agency> (the agent does everything
//       for a customer they handle, so they see that buyer's own slips). Resolved via lib/participant off the
//       record's requestId.
//
//  DISPUTE-SHARED (only while buyerConfirm==="disputed" AND a party shared the slip to that audience):
//   (D) ANY SHARED AUDIENCE                  — ?id=&viewer=<account>  mapped to its role audience, OR
//   (E) VRX-ROOT                             — ?id= with the operator header, AND shared to "vrx".
//  Root is NOT a standing viewer of payment slips — amounts/slips are B2B developer↔buyer PII.
//
// Fail CLOSED for anyone else. PRIVACY: the slip is PII — decrypted in-memory, streamed no-store, never
// written to plaintext on disk, never logged, never on-chain (only a content HASH may ride in a seal).

import { NextResponse } from "next/server";
import { getPayment, decryptEvidence, sharedTo, type PaymentRecord } from "@/lib/payment-vault";
import { getOffer, contractStage } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const lc = (s: string) => s.trim().toLowerCase();

// Operator gate — FAIL CLOSED, same posture as /api/root/overview. An unset secret DENIES (except the
// explicit VRX_DEMO_OPEN=1 local escape hatch). Path (E) also requires the per-record disputed+shared-to-vrx.
function operator(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

// Decide whether `viewer` may see this slip. Standing viewers = owning developer + named buyer. The AGENT's
// standing view is STAGE-GATED (the legal rule): the agent/agency sees slips UNTIL the S&P is
// signed (actively brokering → needs visibility), but NOT after — unless the buyer has voluntarily shared this
// record with their agent (buyerShareToAgent) OR a dispute opened it to the "agent" audience. VRX-root is
// handled by the caller (operator header + sharedTo vrx).
async function viewerMaySee(rec: PaymentRecord, viewer: string): Promise<boolean> {
  if (!viewer) return false;
  const v = lc(viewer);
  // (A) owning developer — standing.
  if (lc(rec.developer) === v) return true;
  // (B) named buyer — standing.
  if (rec.buyer && lc(rec.buyer) === v) return true;

  // Resolve the deal role + stage (for the agent rule). No requestId → no deal context → no agent path.
  if (!rec.requestId) return false;
  const offer = await getOffer(rec.requestId);
  if (!offer) return false;
  const role = await roleOnOffer(offer, viewer);
  if (role !== "agent") return false; // only the deal's agent/agency reach the agent rule

  // (C) agent, BEFORE the S&P is signed — standing visibility while brokering.
  if (contractStage(offer) !== "signed") return true;
  // (C') agent, AFTER signing — only if the buyer chose to keep them in the loop on this record, or a dispute
  //      opened it to the agent audience.
  if (rec.buyerShareToAgent) return true;
  if (sharedTo(rec, "agent")) return true;
  return false;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id")?.trim() || "";
  const evidenceId = url.searchParams.get("evidenceId")?.trim() || undefined;
  const viewer = url.searchParams.get("viewer")?.trim() || "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const rec = await getPayment(id);
  if (!rec || rec.evidence.length === 0) return NextResponse.json({ error: "no evidence on this payment" }, { status: 404 });

  // (E) VRX-root, dispute-shared: operator header AND the slip was shared to "vrx".
  const rootOk = operator(req) && sharedTo(rec, "vrx");
  const ok = rootOk || (await viewerMaySee(rec, viewer));
  if (!ok) return NextResponse.json({ error: "not permitted" }, { status: 403 });

  const plain = await decryptEvidence(id, evidenceId);
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
