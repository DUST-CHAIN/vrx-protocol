// /api/ai-desk-report — the DEVELOPER-facing read of what the AI Sales Director is working on (the slice
// 6+7 follow-on, the design docs §6). The developer glances at their live deals: per deal where
// it stands (phase), which unit is in focus/held, the auto-release deadline, the expected close, and the AI's own
// running summary (the sidecar summary writer, also).
//
//   GET ?developer=<acct> → WorkReport  (deals across the developer's OWN buildings, newest-first + header counts)
//
// AUTH (this slice — the same capability posture as the sibling direct routes, e.g. /api/direct-deposits): the
// caller NAMES its developer account, and developerWorkReport SCOPES the result to exactly that developer's
// buildings (lib/developers buildingIds). So the scope is enforced by the read-model, not spoofable into another
// developer's deals by the account string alone beyond what they're registered for. A challenge-sign binding is
// the shared later-hardening open-Q across all these capability routes (not unique to this one).
//
// PRIVACY: server-side only; a developer sees only THEIR buildings' deals; the summary is the AI's
// PII-free prose about the deal SHAPE (no buyer identity, no cross-developer leakage) — guaranteed upstream (the
// context the AI wrote from was masked+scrubbed, and the sidecar carries no raw PII by construction).

import { NextResponse } from "next/server";
import { developerWorkReport } from "@/lib/ai-desk/work-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const developer = (new URL(req.url).searchParams.get("developer") ?? "").trim();
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });

  // developerWorkReport returns an EMPTY report (not null) for an unknown developer or one with no deals, so the
  // client can always render — no 404 branch needed.
  const report = await developerWorkReport(developer);
  return NextResponse.json(report);
}
