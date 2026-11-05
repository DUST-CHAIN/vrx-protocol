// /api/conversations-direct/escalate — a PARTY flags the conversation for VRX review (F-slice,;
// the design docs §5b). Unlike D (call-off) and E (block) which are ENDINGS, escalation keeps
// the deal LIVE and brings VRX in to mediate. SYMMETRIC — either party may flag (it's the buyer's recourse, since
// E's block is desk-only). VRX responds/resolves via the root route (/api/root/escalations); here a participant
// raises or reads the flag.
//
//   GET  ?account=&conversationId=            → { escalation:{ status, by?, at?, reason? }, role }
//   POST { account, conversationId, reason? } → raise an escalation (either party). Posts a `vrx` ack in-thread.
//
// SCOPING (fail-closed): directRole authorizes the caller as a participant; anyone else → 403.
//
// PRIVACY/MOAT: flagging changes NO PII projection — VRX reviews the NEGOTIATION RECORD (the thread + the
// B/C/D/E state), never the buyer's sealed identity. The `reason` is an off-chain body (capped); no PII expected.

import { NextResponse } from "next/server";
import { directRole, escalateToVrx, getEscalation } from "@/lib/conversations-direct";
import { postSystemNotice } from "@/lib/channels";

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
  const escalation = await getEscalation(conversationId);
  if (!escalation) return NextResponse.json({ error: "no such conversation" }, { status: 404 });
  return NextResponse.json({ escalation, role });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  if (!account || !conversationId) {
    return NextResponse.json({ error: "account + conversationId required" }, { status: 400 });
  }

  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ error: "not a participant in this conversation" }, { status: 403 });

  const before = await getEscalation(conversationId);
  const escalation = await escalateToVrx(conversationId, role, account, reason);
  if (!escalation) return NextResponse.json({ error: "could not escalate (unknown conversation)" }, { status: 400 });

  // Post a `vrx` acknowledgement in-thread ONLY if this call actually opened a NEW escalation (idempotent: a
  // repeat on an already-open flag is a no-op, so don't spam the thread).
  if (before?.status !== "open") {
    await postSystemNotice({
      requestId: conversationId,
      text: "This conversation has been referred to VRX. We'll review and get back to you here. The deal stays open in the meantime.",
      context: { kind: "direct", id: conversationId },
    });
  }
  return NextResponse.json({ escalation });
}
