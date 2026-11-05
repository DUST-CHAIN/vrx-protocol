// /api/conversations-direct/block — the DESK-ONLY hard block (E-slice,;
// the design docs §5). revision: only the DESK can hard-block (anti-scammer);
// the buyer's recourse is call-off (D) + escalate-to-VRX (F), not a block. A blocked buyer's messages still
// LAND (the desk receives them), but the buyer gets a `vrx` autoreply (handled in the conversation POST route).
// Blocking sets a PERMANENT priorBlock → the buyer's identity is force-shown to this desk (anti-cheat), which
// SURVIVES unblock + call-off. The desk can unblock (restores normal messaging, NOT anonymity).
//
//   GET  ?account=&conversationId=            → { block:{ blocked, priorBlock }, role } (either party, scoped)
//   POST { account, conversationId, action }  → action:"block" | "unblock" (DESK ONLY)
//
// SCOPING (fail-closed): directRole must resolve the caller to "developer" for a mutation; anyone else → 403.
// A `vrx` system notice marks the block/unblock in the thread so it's legible to both parties.
//
// PRIVACY: no PII on the wire; the notice names no identity. The force-show consequence is applied only
// the desk-read projection (advance/route.ts deskSafeBuyer), server-side.: reads the named account, no chain.

import { NextResponse } from "next/server";
import { directRole, directParties, getBlock, dealEpoch, blockBuyer, unblockBuyer } from "@/lib/conversations-direct";
import { postSystemNotice } from "@/lib/channels";
import { directRequestId } from "@/lib/direct-offer";
import { voidDirectOffer } from "@/lib/offers";
import { releaseHoldsFor } from "@/lib/direct-deposits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  const conversationId = url.searchParams.get("conversationId")?.trim() || "";
  if (!account || !conversationId) {
    return NextResponse.json({ error: "account + conversationId required" }, { status: 400 });
  }
  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
  const block = await getBlock(conversationId);
  if (!block) return NextResponse.json({ error: "no such conversation" }, { status: 404 });
  return NextResponse.json({ block, role });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!account || !conversationId || (action !== "block" && action !== "unblock")) {
    return NextResponse.json({ error: "account + conversationId + action (block|unblock) required" }, { status: 400 });
  }

  // DESK-ONLY: the caller must resolve to the desk developer of this conversation (fail closed).
  const role = await directRole(conversationId, account);
  if (role !== "developer") {
    return NextResponse.json({ error: "only the desk can block or unblock" }, { status: 403 });
  }

  const ctx = { kind: "direct" as const, id: conversationId };

  if (action === "block") {
    const block = await blockBuyer(conversationId);
    if (!block) return NextResponse.json({ error: "unknown conversation" }, { status: 404 });
    //  (slice 2) — a blocked deal is effectively dead, so void its materialized offer + release the firm-hold
    // (same reasoning as call-off, design §5). A block does NOT bump the epoch, so the current-epoch id is the
    // one to void. voidDirectOffer is fail-closed (only a direct offer is ever touched).
    const epoch = await dealEpoch(conversationId);
    await voidDirectOffer(directRequestId(conversationId, epoch));
    const parties = await directParties(conversationId);
    if (parties?.buyer && parties?.building) await releaseHoldsFor(parties.buyer, parties.building);
    await postSystemNotice({
      requestId: conversationId,
      text: "The desk has stopped this conversation. The buyer's messages will still arrive, but they'll be told the desk doesn't wish to continue.",
      context: ctx,
    });
    return NextResponse.json({ block });
  }

  // unblock
  const block = await unblockBuyer(conversationId);
  if (!block) return NextResponse.json({ error: "unknown conversation" }, { status: 404 });
  await postSystemNotice({ requestId: conversationId, text: "The desk has re-opened this conversation.", context: ctx });
  return NextResponse.json({ block });
}
