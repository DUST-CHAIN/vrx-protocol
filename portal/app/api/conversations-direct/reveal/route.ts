// /api/conversations-direct/reveal — the DESK↔BUYER reveal ceremony (C-slice,;
// no agent — the BUYER is their own protector, so the desk REQUESTS and the buyer CONSENTS directly.
// GET ?account=&conversationId= → the reveal state (either party, scoped). { reveal }
// POST { account, conversationId, action } → a ceremony step:
// action:"request" { fields[], declaration } — DESK asks to see/obtain `fields`; accepts a sealed
// action:"grant" { fields?[] } — BUYER consents (subset via `fields`, else the whole ask).
// action:"decline" — BUYER declines; the pending request is dropped.
// SCOPING (fail-closed): directRole authorizes the caller. Only the DESK DEVELOPER may "request"; only the
// BUYER may "grant"/"decline". Anyone else → 403. Each step drops a human-visible marker into the thread (the
// request as a desk message; the grant/decline as a `vrx` system notice) so the negotiation is legible + the
// append-only chat carries the evidence trail alongside the per-conversation reveal state.
// PRIVACY: the request names FIELD KEYS, never values; the sealed declaration is a hash, not text. The
// buyer's actual PII is still masked/revealed only by the desk-read projection (advance/route.ts deskSafeBuyer),

import { NextResponse } from "next/server";
import {
  directRole,
  getDirectReveal,
  requestDirectReveal,
  grantDirectReveal,
  declineDirectReveal,
} from "@/lib/conversations-direct";
import { postMessage, postSystemNotice } from "@/lib/channels";
import { sealRecord } from "@/lib/seal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The seal domain for the desk's non-circumvention declaration (public namespace; the SECRET is the salt). */
const DECLARATION_DOMAIN = "vrx-direct-reveal-declaration";

/** The standing non-circumvention undertaking the desk accepts when it asks for a reveal ( T1 analogue).
 * Sealed verbatim so "what the desk agreed to, and when" is tamper-evident on the trail. Domain-general wording
 * (no jurisdiction-specific law — matches the structural legal posture, pt5). */
const DECLARATION_TEXT =
  "I will not use the buyer's revealed details to contact, solicit, or deal with them outside VRX, " +
  "nor to circumvent this platform or any agent/agency relationship.";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  const conversationId = url.searchParams.get("conversationId")?.trim() || "";
  if (!account || !conversationId) {
    return NextResponse.json({ error: "account + conversationId required" }, { status: 400 });
  }
  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
  const reveal = await getDirectReveal(conversationId);
  if (!reveal) return NextResponse.json({ error: "no such conversation" }, { status: 404 });
  return NextResponse.json({ reveal, role });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!account || !conversationId || !action) {
    return NextResponse.json({ error: "account + conversationId + action required" }, { status: 400 });
  }

  // Authorize the caller's role in THIS conversation (fail closed).
  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ error: "not a participant in this conversation" }, { status: 403 });

  const ctx = { kind: "direct" as const, id: conversationId };

  if (action === "request") {
    // Only the DESK may request a reveal.
    if (role !== "developer") {
      return NextResponse.json({ error: "only the desk can request a reveal" }, { status: 403 });
    }
    const fields = Array.isArray(body.fields) ? body.fields : [];
    // === true in the body) — the UI shows the text; we seal the canonical TEXT, not client-sent prose.
    if (body.declaration !== true) {
      return NextResponse.json({ error: "the desk must accept the non-circumvention undertaking" }, { status: 400 });
    }
    const seal = sealRecord(DECLARATION_TEXT, DECLARATION_DOMAIN);
    const reveal = await requestDirectReveal(conversationId, account, fields, seal.hash);
    if (!reveal) {
      return NextResponse.json({ error: "could not record request (no valid fields, or unknown conversation)" }, { status: 400 });
    }
    // Human-visible marker: the desk's ask, posted as a desk message so the buyer sees it inline + can act.
    const asked = reveal.request?.fields ?? [];
    await postMessage({
      requestId: conversationId,
      from: "developer",
      by: account,
      text: `🔐 The desk has asked to see or add: ${asked.join(", ")}. You can share these or decline — your details stay masked until you agree.`,
      context: ctx,
    });
    return NextResponse.json({ reveal });
  }

  if (action === "grant") {
    // Only the BUYER may consent.
    if (role !== "buyer") {
      return NextResponse.json({ error: "only the buyer can grant a reveal" }, { status: 403 });
    }
    const consentFields = Array.isArray(body.fields) ? body.fields : undefined;
    const reveal = await grantDirectReveal(conversationId, consentFields);
    if (!reveal) return NextResponse.json({ error: "no pending request to grant" }, { status: 404 });
    // System notice (centred, both parties): records the consent in the thread.
    const shared = reveal.grantedFields ?? [];
    await postSystemNotice({
      requestId: conversationId,
      text: `The buyer agreed to share: ${shared.join(", ")}.`,
      context: ctx,
    });
    return NextResponse.json({ reveal });
  }

  if (action === "decline") {
    if (role !== "buyer") {
      return NextResponse.json({ error: "only the buyer can decline a reveal" }, { status: 403 });
    }
    const reveal = await declineDirectReveal(conversationId);
    if (!reveal) return NextResponse.json({ error: "unknown conversation" }, { status: 404 });
    await postSystemNotice({
      requestId: conversationId,
      text: "The buyer kept their details masked for now.",
      context: ctx,
    });
    return NextResponse.json({ reveal });
  }

  return NextResponse.json({ error: "unknown action (request | grant | decline)" }, { status: 400 });
}
