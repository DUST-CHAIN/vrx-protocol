// /api/root/escalations — VRX-ROOT reviews + resolves direct-desk escalations (F-slice). The mediator end
// of the "escalate to VRX" move: a party flagged a conversation (/api/conversations-direct/escalate); here VRX
// sees the OPEN queue and responds IN the thread, then marks it resolved. The deal stays live throughout.
//
//   GET                                     → { open: [ { id, buyer, building, by, at, reason } ] }  (the queue)
//   POST { conversationId, message? }       → post a `vrx` resolution notice in-thread + mark the flag resolved
//
// ── AUTH: the EXISTING /root operator-secret gate (fail-closed) — identical to /api/root/approver &
// /api/root/inventory-oversight. This is a VRX-root action, never party-facing: x-vrx-operator vs
// VRX_OPERATOR_SECRET, with the explicit VRX_DEMO_OPEN=1 escape hatch; an unset secret DENIES.
//
// PRIVACY/MOAT: VRX reviews the NEGOTIATION RECORD only (the queue carries the neutral buyer ACCOUNT +
// building + who-flagged + reason — never the buyer's sealed identity/PII). The resolution `message` is a `vrx`
// system notice (off-chain body). Nothing on-chain.

import { NextResponse } from "next/server";
import { openEscalations, resolveEscalation } from "@/lib/conversations-direct";
import { postSystemNotice } from "@/lib/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ open: await openEscalations() });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!conversationId) return NextResponse.json({ error: "conversationId required" }, { status: 400 });

  const resolved = await resolveEscalation(conversationId);
  if (!resolved) return NextResponse.json({ error: "unknown conversation" }, { status: 404 });

  // VRX speaks into the thread (the "return to them in a chat" asked for). A default resolution line if
  // no custom message is supplied.
  await postSystemNotice({
    requestId: conversationId,
    text: message || "VRX has reviewed this conversation. If you have any further concern, you can refer it to us again.",
    context: { kind: "direct", id: conversationId },
  });
  return NextResponse.json({ resolved });
}
