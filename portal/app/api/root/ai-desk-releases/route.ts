// /api/root/ai-desk-releases — the SCHEDULER CALLER for the AI desk's auto-release timers (the slice-6+7
// follow-on, the design docs §6 / D-).
//
// release-timers.advanceHoldReleases is a PURE-DRIVEN, idempotent evaluator (a function of the live holds +
// sidecars + asOf) — by design it has NO scheduler in front of it (a Next portal has no cron; the
// rule said "build the pure fn first, slot a trigger in front later"). This route IS that trigger: an operator /
// external pinger hits it and it (a) advances every expired hold one ladder step (extend → warn → release) and
// (b) FANS OUT the warn messages the evaluator returns into each deal thread (the evaluator never touches channels
// by design — it returns the warnings[], the caller posts them). Idempotent: re-hitting it with the same asOf is a
// no-op after the first pass (an extended/warned hold's new releaseAt is now in the future).
//
//   POST { action: "advance", asOf? }
//  → ReleaseReport + { warned } — runs the ladder, posts finalWarnCopy into each warned deal's thread.
//   GET
//        → { expired, asOf } — a NON-MUTATING glance: how many active holds are currently past their releaseAt
//          (i.e. what a POST advance would touch). Reads expiredActiveHolds; effects nothing.
//
// ── AUTH: the EXISTING /root operator-secret gate (verify-before-acting) — matched to the sibling root routes
// (overview / party / misrepresentations) EXACTLY: fail-closed x-vrx-operator vs VRX_OPERATOR_SECRET, with the
// explicit local VRX_DEMO_OPEN=1 escape hatch. Effecting an auto-release touches a developer's inventory, so it
// must never be open by default.
//
// PRIVACY: server-side only; the warn copy is plain words (no price/terms/PII); nothing on-chain (the
// soft-hold release is the off-chain signing-seam stub until the V7 on-chain leg ships).

import { NextResponse } from "next/server";
import { advanceHoldReleases } from "@/lib/ai-desk/release-timers";
import { expiredActiveHolds } from "@/lib/ai-desk/unit-holds";
import { postSystemNotice } from "@/lib/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical posture to the sibling /root routes.
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Non-mutating glance: how many active holds are currently past their releaseAt (what a POST advance would act
  // on). This only READS the holds store — it effects nothing (the ladder runs on POST). Lets a cron / the ops
  // panel decide whether a run is even needed.
  const asOf = Date.now();
  const expired = (await expiredActiveHolds(asOf)).length;
  return NextResponse.json({ expired, asOf });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action.trim() : "";

  if (action === "advance") {
    const asOf = typeof body.asOf === "number" && Number.isFinite(body.asOf) ? body.asOf : undefined;
    const report = await advanceHoldReleases(asOf !== undefined ? { asOf } : undefined);

    // Fan out the WARN messages the evaluator returned — one plain-words notice into each warned deal's thread
    // (the dealId IS the direct-conversation channel key). Best-effort per message; a post failure doesn't abort
    // the whole run (the hold state already advanced; a missed notice is recoverable, a half-run is worse).
    let warned = 0;
    for (const w of report.warnings) {
      try {
        const posted = await postSystemNotice({
          requestId: w.dealId,
          text: w.text,
          context: { kind: "direct", id: w.dealId },
        });
        if (posted) warned++;
      } catch {
        // swallow — keep advancing the rest; the ladder state is the source of truth, the notice is a courtesy.
      }
    }

    return NextResponse.json({ ...report, warned });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
