// /api/conversations-direct/call-off — the bilateral "polite goodbye" (D-slice,;
// the design docs §4). A call-off is a HANDSHAKE, not a unilateral switch: one party PROPOSES,
// the OTHER party AGREES (→ the deal resets) or the proposer WITHDRAWS. No timeout (Q1). On a mutual
// agree the deal resets to a clean slate — consent wiped, the buyer's dial reset, a thread marker, epoch++.
// The CHAT survives; re-engagement is a new deal UNLESS a hard block (Slice E) is in force.
//
//   GET  ?account=&conversationId=            → the call-off state (either party, scoped). { callOff, role }
//   POST { account, conversationId, action }  → a handshake step:
//     action:"request"  — PROPOSE a call-off (either party).
//     action:"withdraw" — the ORIGINAL proposer takes back their pending proposal.
//     action:"agree"    — the OTHER party agrees → the deal RESETS (no-prejudice).
//
// SCOPING (fail-closed): directRole authorizes the caller as a participant. `withdraw` is allowed ONLY to the
// party who proposed; `agree` ONLY to the party who did NOT propose (you can't agree to your own proposal — that
// would be the unilateral reset the model forbids). Each step drops a `vrx` system notice into the thread so
// the close is legible + the append-only chat carries the record (no blame — explicitly no-prejudice).
//
// RESET orchestration (agree): the store (agreeCallOff) wipes C's grantedFields + the pending reveal request and
// bumps the epoch; THIS route also resets the buyer's GLOBAL dial (setMaskOverride → default) because it owns the
// buyers-direct dependency the store deliberately avoids. priorBlock is PRESERVED by the store (anti-launder).
//
// PRIVACY: no PII on the wire; the marker names no identity.: reads the named account, signs nothing.

import { NextResponse } from "next/server";
import {
  directRole,
  directParties,
  getCallOff,
  dealEpoch,
  requestCallOff,
  withdrawCallOff,
  agreeCallOff,
} from "@/lib/conversations-direct";
import { postSystemNotice } from "@/lib/channels";
import { setMaskOverride } from "@/lib/buyers-direct";
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
  const callOff = await getCallOff(conversationId);
  if (!callOff) return NextResponse.json({ error: "no such conversation" }, { status: 404 });
  return NextResponse.json({ callOff, role });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!account || !conversationId || !action) {
    return NextResponse.json({ error: "account + conversationId + action required" }, { status: 400 });
  }

  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ error: "not a participant in this conversation" }, { status: 403 });

  const ctx = { kind: "direct" as const, id: conversationId };
  const current = await getCallOff(conversationId);
  if (!current) return NextResponse.json({ error: "no such conversation" }, { status: 404 });

  if (action === "request") {
    const callOff = await requestCallOff(conversationId, role, account);
    if (!callOff) return NextResponse.json({ error: "could not propose (unknown conversation)" }, { status: 400 });
    // Only post a marker if THIS call actually created the proposal (idempotent-ish: a repeat is a no-op).
    if (callOff.proposal?.byAccount === account.toLowerCase()) {
      await postSystemNotice({
        requestId: conversationId,
        text: "A call-off was proposed — closing this deal, no hard feelings. The other side can agree to close it.",
        context: ctx,
      });
    }
    return NextResponse.json({ callOff });
  }

  if (action === "withdraw") {
    // Only the ORIGINAL proposer may withdraw their own proposal.
    if (current.proposal && current.proposal.byAccount !== account.toLowerCase()) {
      return NextResponse.json({ error: "only the party who proposed can withdraw it" }, { status: 403 });
    }
    const callOff = await withdrawCallOff(conversationId);
    if (!callOff) return NextResponse.json({ error: "unknown conversation" }, { status: 404 });
    // Post a marker only if there was actually a pending proposal to withdraw.
    if (current.proposal) {
      await postSystemNotice({ requestId: conversationId, text: "The call-off was withdrawn — the deal continues.", context: ctx });
    }
    return NextResponse.json({ callOff });
  }

  if (action === "agree") {
    if (!current.proposal) {
      return NextResponse.json({ error: "no call-off to agree to" }, { status: 404 });
    }
    // You can't agree to your OWN proposal — the other party must be the one who agrees (keeps it bilateral).
    if (current.proposal.byAccount === account.toLowerCase()) {
      return NextResponse.json({ error: "the other party must agree to the call-off" }, { status: 403 });
    }
    //  (slice 2) — VOID any materialized direct offer for the CURRENT epoch + release the firm-hold BEFORE
    // the epoch bumps (the offer is keyed by (conversationId, epoch); after agreeCallOff bumps it we'd compute
    // the wrong id). A called-off deal's papered offer must not linger (stale tailoring would leak into the
    // re-engaged deal — the same thing the epoch reset guards). Releasing the hold returns the unit to market,
    // consistent with "no prejudice, deal reset". voidDirectOffer is fail-closed (only touches a direct offer).
    const epoch = await dealEpoch(conversationId);
    await voidDirectOffer(directRequestId(conversationId, epoch));
    const parties = await directParties(conversationId);
    if (parties?.buyer && parties?.building) await releaseHoldsFor(parties.buyer, parties.building);

    const callOff = await agreeCallOff(conversationId);
    if (!callOff) return NextResponse.json({ error: "could not complete the call-off" }, { status: 400 });
    // Reset the buyer's GLOBAL dial to the masked default ("no junk"). Store already wiped grantedFields.
    if (parties?.buyer) await setMaskOverride(parties.buyer, {});
    // The horizontal-rule marker — a clean, no-prejudice close. Anything after is a new deal (new epoch).
    await postSystemNotice({
      requestId: conversationId,
      text: "──────── Deal closed — no prejudice. You can start fresh anytime; details reset to private. ────────",
      context: ctx,
    });
    return NextResponse.json({ callOff });
  }

  return NextResponse.json({ error: "unknown action (request | withdraw | agree)" }, { status: 400 });
}
