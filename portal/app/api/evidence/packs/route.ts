// GET /api/evidence/packs — the AUTHENTICATED party's own encrypted evidence packs (metadata only, newest-first).
// Each row = a sealed "your own copy" of a money/consent event (deposit custody today; handover/signing later),
// encrypted to the party's X25519 delivery key — the server holds ciphertext it CANNOT read ([[vrx-money-privacy-
// durability-fork]], the "notary that outlives the notary" durability leg).
//
// AUTH — CALLER-SCOPED, FAIL CLOSED (VRX-0001 class). Packs are PARTY-PRIVATE: a pack is addressed to exactly one
// recipient (the party who can decrypt it), so the listing MUST be scoped to the PROVEN caller, never a client-
// supplied ?account=. A stranger must not be able to enumerate another party's packs by naming their handle. The
// caller's identity comes from the session via requireCaller; the store filter is evidencePacksForRecipient(that
// proven account). (The listing is metadata-only — packId, kind, ref, contentHash, createdAt — NO ciphertext and NO
// crypto material; opening a pack happens client-side with the party's OWN private key, never through this server.)
//
// PRIVACY: the metadata carries no amount/PII (contentHash is the party's PRIVATE verify digest — opaque to
// anyone without the plaintext). The server never sees the party's private key; it cannot open these packs.

import { NextResponse } from "next/server";
import { requireCaller } from "@/lib/caller";
import { evidencePacksForRecipient } from "@/lib/evidence-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Derive the party from the PROVEN session, never the client param (same posture as /api/buyer/purchases).
  const claimed = new URL(req.url).searchParams.get("account")?.trim() || "";
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: who.reason }, { status: who.status });

  const packs = await evidencePacksForRecipient(who.account);
  return NextResponse.json({ packs });
}
