// GET ?viewer=<acct> → every live-halt notice touching this viewer (agent/agency),
// split set (a) unmissable / set (b) card. See lib/halt-notices.
// POST { viewer, haltId, action: "seen" } → mark a notice SEEN for the viewer. This ARMS the dismiss on a
// set-(a) unmissable notice (you may hide it only after it's
// been seen). The UI calls it the moment the notice is shown.
// There is NO separate "dismiss" write: a dismiss is a CLIENT-side hide, VALID only once `seen` is true (the
// unmissable guarantee lives in the gate below + the UI). The server's job is to record that the party was
// shown the notice — the audit-able "they were told" fact. A forward-only (set b) card is freely dismissible;
// the UI may still mark it seen for symmetry, but it isn't gated.
// AUTHZ (F1 seam, fail-closed): identity via requireCaller (verified session; param-fallback honours ?viewer=/
// body.viewer). A viewer can only ever read/mark their OWN notices — the resolver is scoped to the viewer and
// the marker store is keyed by the viewer, so there's no cross-party surface to leak.
// PRIVACY: a notice discloses only the viewer's OWN connection to a halted building (their deal count) +
// the developer's own-words note — never the other parties. Nothing on-chain; neutral ids + integers only.

import { NextResponse } from "next/server";
import { requireCaller } from "@/lib/caller";
import { resolveHaltNoticesFor, markHaltSeen } from "@/lib/halt-notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const caller = requireCaller(req, { param: url.searchParams.get("viewer") });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });

  const notices = await resolveHaltNoticesFor(caller.account);
  return NextResponse.json({ notices });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const haltId = typeof body.haltId === "string" ? body.haltId.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "seen";

  const caller = requireCaller(req, { param: typeof body.viewer === "string" ? body.viewer : "" });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });

  if (!haltId) return NextResponse.json({ error: "haltId required" }, { status: 400 });
  if (action !== "seen") return NextResponse.json({ error: "unknown action" }, { status: 400 });

  // Mark the viewer's own marker. We DON'T re-verify the viewer is in the halt's affected set: a stray mark on
  // a halt that doesn't touch them is harmless (the GET never surfaces it, so the marker is simply inert), and
  // the resolver is the single source of which notices exist. Keeps the write a pure, cheap latch.
  await markHaltSeen(caller.account, haltId);
  return NextResponse.json({ ok: true });
}
