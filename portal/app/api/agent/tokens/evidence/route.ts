// /api/agent/tokens/evidence — serve ONE decrypted booking-token CASH PHOTO's bytes, to an AUTHORIZED reader
// only (seam #2). This is the ONLY path a token cash-photo's plaintext leaves the server; the
// /api/*/tokens routes carry only the opaque evidenceId reference, never bytes.
//
//   GET ?id=<evidenceId>&viewer=<account>
//
// Authorized readers are the token's CASH-CUSTODY CHAIN — exactly the three parties who reconcile the cash:
//   (A) THE OWNING DEVELOPER                 — token.developer
//   (B) THE CURRENT HOLDER (the field agent) — token.custody (the agent who took + photographed the cash)
//   (C) THE SUPERVISING AGENCY               — agencyOf(cash.takenBy) (the agency the agent reports to)
// Fail CLOSED for anyone else (another agency, an unrelated agent, an unauthenticated caller).
//
// PRIVACY: the photo is PII/B2B — decrypted in-memory, streamed no-store, never written to plaintext on
// disk, never logged, never on-chain (only its contentHash rides in the token's custody seal).

import { NextResponse } from "next/server";
import { getToken } from "@/lib/booking-tokens";
import { getTokenEvidence, decryptTokenEvidence } from "@/lib/token-evidence";
import { agencyOf } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const lc = (s: string) => s.trim().toLowerCase();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id")?.trim() || "";
  const viewer = url.searchParams.get("viewer")?.trim() || "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!viewer) return NextResponse.json({ error: "viewer required" }, { status: 400 });

  const ev = await getTokenEvidence(id);
  if (!ev) return NextResponse.json({ error: "no such evidence" }, { status: 404 });
  const token = await getToken(ev.tokenId);
  if (!token) return NextResponse.json({ error: "token gone" }, { status: 404 });

  const v = lc(viewer);
  // (A) owning developer · (B) current holder (the field agent).
  let ok = lc(token.developer) === v || lc(token.custody) === v;
  // (C) the agency that supervises the agent who took the cash.
  if (!ok && token.cash?.takenBy) {
    const supervising = (await agencyOf(token.cash.takenBy))?.toLowerCase();
    ok = !!supervising && supervising === v;
  }
  if (!ok) return NextResponse.json({ error: "not permitted" }, { status: 403 });

  const plain = await decryptTokenEvidence(id);
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
