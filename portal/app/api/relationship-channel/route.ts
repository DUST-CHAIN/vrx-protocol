// api/relationship-channel — the developer↔agency RELATIONSHIP thread (Part D, docs/GOVERNED_CHANGE_DESIGN
// _S180.md). The relationship-context sibling of /api/channels/[requestId] (booking) and
// /api/conversations-direct (direct): same generalized channel store, a cross-deal party set.
// GET ?viewer=<acct>&developer=<d>&agency=<a> → resolve/start the (developer, agency) channel; returns
// { channelId, role, messages }. Fail-closed: the pair must
// have an agreement between them, and the viewer must be a
// party (developer / agency / an agent of that agency).
// GET ?viewer=<acct>&channelId=<id> → read an EXISTING channel by id (either party), scoped.
// POST { by, channelId, text } → append a message; the author's role (developer|agency) is
// resolved SERVER-SIDE from the channel — the client can't
// claim a role. An agent authors as "agency". Returns
// { message }.
// AUTHZ (F1 seam, fail-closed): identity via requireCaller (verified session; param-fallback honours ?viewer=/
// body.by in the default mode); lib/relationship-channel.relationshipRole authorizes the viewer as the
// developer, the agency, or an agent of that agency — anyone else gets 403.
// PRIVACY: bodies are off-chain plaintext; the chain is untouched; neutral account ids only. The channelId
// is an opaque digest of the pair, so neither party is read off the wire.

import { NextResponse } from "next/server";
import { getThread, postMessage } from "@/lib/channels";
import {
  resolveRelationshipChannel,
  relationshipRole,
} from "@/lib/relationship-channel";
import { requireCaller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const developer = url.searchParams.get("developer")?.trim() || "";
  const agency = url.searchParams.get("agency")?.trim() || "";
  const channelId = url.searchParams.get("channelId")?.trim() || "";

  const caller = requireCaller(req, { param: url.searchParams.get("viewer") });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });
  const viewer = caller.account;

  // Path A — resolve/start by (developer, agency). Materialize the channel (ensure) only for a real party.
  if (developer && agency) {
    const chan = await resolveRelationshipChannel(developer, agency, /* ensure */ true);
    if (!chan) return NextResponse.json({ error: "no relationship between these parties" }, { status: 404 });
    const role = await relationshipRole(chan.id, viewer);
    if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
    return NextResponse.json({ channelId: chan.id, role, messages: await getThread(chan.id) });
  }

  // Path B — read an existing channel by id (either party).
  if (channelId) {
    const role = await relationshipRole(channelId, viewer);
    if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
    return NextResponse.json({ channelId, role, messages: await getThread(channelId) });
  }

  return NextResponse.json({ error: "(developer + agency) or channelId required" }, { status: 400 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";

  const caller = requireCaller(req, { param: typeof body.by === "string" ? body.by : "" });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });
  const by = caller.account;

  if (!channelId || !text.trim()) {
    return NextResponse.json({ error: "channelId + text required" }, { status: 400 });
  }

  // The author's role is resolved from the channel — NOT claimed by the client. An agent of the agency authors
  // as "agency" (relationshipRole folds them in). Fail closed for a non-participant.
  const role = await relationshipRole(channelId, by);
  if (!role) return NextResponse.json({ error: "not a participant in this channel" }, { status: 403 });

  const message = await postMessage({
    requestId: channelId, // the field name is historical; here it carries the relationship channelId
    from: role,
    by,
    text,
    context: { kind: "relationship", id: channelId },
  });
  if (!message) return NextResponse.json({ error: "could not post" }, { status: 400 });
  return NextResponse.json({ message });
}
