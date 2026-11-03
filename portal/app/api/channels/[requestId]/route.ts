// /api/channels/[requestId] — the channel thread for one booking (the design docs §2).
//
//   GET  → { messages } : the whole thread, oldest-first. Clients gently poll this (store-and-forward
//          v0 transport). Upgrading to SSE/near.email later changes DELIVERY, not this shape (§2c).
//   POST { from, by, text } → append a message; returns { message }.
//
// TRANSPORT NOTE: this is the demo store-and-forward transport. It is deliberately a plain poll+append so
// a later SSE/WebSocket (§2c v1) or near.email transport can replace delivery without changing the
// store or callers. Do not weld real-time logic into callers.
//
// PRIVACY: message bodies are off-chain plaintext (the parties' private words); the chain is never
// touched. Neutral account ids only.

import { NextResponse } from "next/server";
import { getThread, postMessage } from "@/lib/channels";
import { roleOnBooking as participantRole } from "@/lib/participant";
import { requireCaller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A channel is a PRIVATE thread about a booking (review fix #1b). The participant scope — developer
// | the authoring agent | that agent's supervising agency, else fail closed — is the shared rule in
// lib/participant (consolidated the F1 chokepoint). Imported here as `participantRole` so the two call
// sites below read unchanged.

export async function GET(req: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  // F1: the caller's identity comes from the VERIFIED session via requireCaller — in param-fallback
  // mode it still honours the legacy ?viewer= param (flag off = today's behaviour); in strict mode a
  // forged ?viewer= is ignored (session only). god-mode uses the dev-switcher account. Fail closed.
  const caller = requireCaller(req, { param: new URL(req.url).searchParams.get("viewer") });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });
  const viewer = caller.account;
  if (!(await participantRole(requestId, viewer))) {
    return NextResponse.json({ error: "not a participant in this conversation" }, { status: 403 });
  }
  return NextResponse.json({ messages: await getThread(requestId) });
}

export async function POST(req: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const body = await req.json().catch(() => ({}));
  const from = body.from === "developer" || body.from === "agent" ? body.from : null;
  const text = typeof body.text === "string" ? body.text : "";
  // F1: the message AUTHOR is the verified caller, not a client-claimed `by`. In param-fallback
  // mode the body's `by` is still honoured (today's behaviour); in strict mode the author is the session
  // account and a forged `by` cannot post as someone else. god-mode uses the dev-switcher account.
  const caller = requireCaller(req, { param: typeof body.by === "string" ? body.by : "" });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });
  const by = caller.account;
  if (!from || !by || !text.trim()) {
    return NextResponse.json({ error: "from (developer|agent) + by + text required" }, { status: 400 });
  }
  // The author must actually BE a participant, AND the role they claim must match their account (an agent
  // can't post as the developer). Fail closed otherwise.
  const role = await participantRole(requestId, by);
  if (!role || role !== from) {
    return NextResponse.json({ error: "not a participant, or role mismatch" }, { status: 403 });
  }
  const message = await postMessage({ requestId, from, by, text });
  if (!message) return NextResponse.json({ error: "could not post" }, { status: 400 });
  return NextResponse.json({ message });
}
