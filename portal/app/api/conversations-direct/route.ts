// /api/conversations-direct — the BUYER↔DESK (pre-booking) conversation thread ( §9 step 3). The direct-
// context twin of /api/channels/[requestId]: same generalized channel store, different context + party set.
// GET ?account=<viewer>&building=<id> → start/resolve the (viewer-as-buyer, building) conversation and
// return { conversationId, messages, role }. Fail-closed: the
// building must be direct-sale-visible and have a desk developer.
// GET ?account=<viewer>&conversationId= → read an EXISTING conversation by id (either party), scoped.
// POST { account, conversationId, text } → append a message; the author's role (buyer|developer) is
// resolved server-side from the conversation — the client can't
// claim a role. Returns { message }.
// SCOPING (fail-closed): lib/conversations-direct.directRole authorizes the viewer as the buyer OR the
// building's desk developer; anyone else gets 403. Transport is the same swappable poll+SSE as the booking
// channel (the message push uses the opaque channelTopic on the conversationId).
// PRIVACY: bodies off-chain plaintext; chain untouched; neutral account ids only.: reads the
// caller's named account, signs nothing.

import { NextResponse } from "next/server";
import { getThread, postMessage, postSystemNotice } from "@/lib/channels";
import { resolveDirectConversation, directRole, isBuyerBlocked } from "@/lib/conversations-direct";

/** The autoreply a hard-blocked buyer gets when they post (E-slice). The blocker (desk) still RECEIVES the
 * message — this is the honest, non-hostile signal to the sender (friction kept at bay), per the model. */
const BLOCK_AUTOREPLY = "This user doesn't want to talk to you anymore.";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  const conversationId = url.searchParams.get("conversationId")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  // Path A — resolve/start by (buyer, building). The caller is the BUYER starting an enquiry.
  if (building) {
    const conv = await resolveDirectConversation(account, building, /* ensure */ true);
    if (!conv) return NextResponse.json({ error: "no desk for this building" }, { status: 404 });
    const role = await directRole(conv.id, account);
    if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
    return NextResponse.json({ conversationId: conv.id, role, messages: await getThread(conv.id) });
  }

  // Path B — read an existing conversation by id (either party).
  if (conversationId) {
    const role = await directRole(conversationId, account);
    if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
    return NextResponse.json({ conversationId, role, messages: await getThread(conversationId) });
  }

  return NextResponse.json({ error: "building or conversationId required" }, { status: 400 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!account || !conversationId || !text.trim()) {
    return NextResponse.json({ error: "account + conversationId + text required" }, { status: 400 });
  }

  // The author's role is resolved from the conversation — not claimed by the client. Fail closed for a
  // non-participant.
  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ error: "not a participant in this conversation" }, { status: 403 });

  const message = await postMessage({
    requestId: conversationId, // the field name is historical; here it carries the conversationId
    from: role,
    by: account,
    text,
    context: { kind: "direct", id: conversationId },
  });
  if (!message) return NextResponse.json({ error: "could not post" }, { status: 400 });

  // E-slice: a hard-blocked BUYER's message STILL LANDS (the desk receives it — nothing lost), but the
  // buyer gets an honest autoreply. Desk-only block, so this only applies when the author is the buyer. The
  // autoreply is a `vrx` system notice in the thread so the buyer sees it inline; `blocked:true` tells the
  // client to show the signal. (The desk's own messages are never auto-replied.)
  if (role === "buyer" && (await isBuyerBlocked(conversationId))) {
    await postSystemNotice({
      requestId: conversationId,
      text: BLOCK_AUTOREPLY,
      context: { kind: "direct", id: conversationId },
    });
    return NextResponse.json({ message, blocked: true, autoreply: BLOCK_AUTOREPLY });
  }
  return NextResponse.json({ message });
}
