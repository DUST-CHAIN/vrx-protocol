// /api/root/misrepresentations — the VRX-ROOT operator console for the §3c SECOND trigger.
//
// This is the surface that closes the misrepresentation seam end-to-end: operator → store → scheduler.
// built lib/misrepresentation-store.ts (the operator-asserted "this developer's listing was found materially
// wrong and not corrected" fact store) and lib/standing-scheduler.ts (the stage-advancement evaluator), but
// nothing joined them to a real VRX-root ACTION. This route is that join:
//
//   GET  ?developer=<acct>
//        → { assertions, standing }
//  assertions = every assertion (active + cleared) for the developer, salt-stripped.
//          standing   = the developer's CURRENT resolved standing stage, reading the store's own trigger —
//                       so the operator SEES the effect of what they asserted (stage + reasons + the clock).
//   POST { action: "assert", developer, buildingId?, reason? }
//        → { assertion }  — seals a new operator assertion (assertedBy = the operator label; §3c clock starts).
//   POST { action: "clear", id? , developer?, reason? }
//  → { cleared } — WITHDRAWS one assertion (by id) or ALL active for a developer (no-latch).
//   POST { action: "advance", developers?, asOf? }
//  → AdvanceReport — WIRES the store into the scheduler: reads misrepresentationTriggers and passes
//  them to advanceDeveloperStandings, so a flagged developer actually advances
//                           grace→suspended→removed and all parties on its deals are notified. Idempotent.
//
// ── AUTH: the EXISTING /root operator-secret gate (verify-before-acting) ───────────────────────────
// I matched the two sibling /root routes (overview, party) EXACTLY: fail-closed x-vrx-operator vs
// VRX_OPERATOR_SECRET, with the explicit local VRX_DEMO_OPEN=1 escape hatch. The portal's VRX-root boundary
// is a SHARED OPERATOR SECRET (a bearer credential for "the VRX team"), NOT a named-account check — so the
// store's `assertedBy` is an AUDIT LABEL of who acted, never the authorization itself. (A truly per-operator
// accountable model — a real signature / multi-sig for operator actions — is a future hardening, same family
// as the on-chain defrost arc; flagged owed, not built..) An unset secret DENIES — a misrepresentation
// action is destructive to a developer's standing, so it must never be open by default.
//
// PRIVACY: server-side only; nothing on-chain; the public projection strips the per-record salt.
// The raw operator `reason` is a sensitive B2B fact — this is a VRX-root-only surface, never party-facing.

import { NextResponse } from "next/server";
import {
  assertMisrepresentation,
  clearMisrepresentation,
  clearDeveloper,
  misrepsForDeveloper,
  misrepresentationTrigger,
  misrepresentationTriggers,
  publicMisrepresentation,
} from "@/lib/misrepresentation-store";
import { advanceDeveloperStandings } from "@/lib/standing-scheduler";
import { resolveStandingForDeveloper } from "@/lib/dev-standing";
import { logActivity } from "@/lib/activity";
import { getProfile } from "@/lib/profiles";

// Developer's display name for the activity-feed row's subjectName (best-effort; falls back to the account).
async function devName(account: string): Promise<string> {
  const p = await getProfile(account).catch(() => null);
  return p?.legalName?.trim() || account;
}

// Standing activity-feed rows are visible to the DEVELOPER + VRX-root ONLY. The raw operator reason is
// NEVER put in the feed context — only the stage/reason CATEGORY. Other parties learn of a pause via the
// scheduler's deal-chat notice, not this feed.
const STANDING_PARTIES = (developer: string) => [developer, OPERATOR_LABEL];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical posture to /api/root/overview + /api/root/party (fix #3).
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

// The audit label recorded as `assertedBy` on an operator action. Not an auth check (the secret is) — just
// who/what the audit trail should name. Configurable so a real deploy can stamp a specific operator identity.
const OPERATOR_LABEL = process.env.VRX_OPERATOR_LABEL?.trim() || "vrx-root";

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const developer = (new URL(req.url).searchParams.get("developer") ?? "").trim();
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });

  // Every assertion (active + cleared) for the audit view, salt-stripped. Plus the CURRENT standing resolved
  // from the store's own trigger, so the operator sees exactly what their assertions did to this developer.
  const [records, trigger] = await Promise.all([
    misrepsForDeveloper(developer),
    misrepresentationTrigger(developer),
  ]);
  const standing = await resolveStandingForDeveloper(developer, { misrepresentation: trigger ?? undefined });

  return NextResponse.json({
    assertions: records.map(publicMisrepresentation),
    standing,
  });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action.trim() : "";

  if (action === "assert") {
    const developer = typeof body.developer === "string" ? body.developer.trim() : "";
    if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
    const assertion = await assertMisrepresentation({
      developer,
      assertedBy: OPERATOR_LABEL,
      buildingId: typeof body.buildingId === "string" ? body.buildingId : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    // Activity-feed row (#7): developer + VRX-root only; NO raw reason. Best-effort — never blocks.
    await logActivity("standing.flagged", OPERATOR_LABEL, { kind: "developer", id: developer }, STANDING_PARTIES(developer), {
      subjectName: await devName(developer),
    });
    return NextResponse.json({ assertion: publicMisrepresentation(assertion) });
  }

  if (action === "clear") {
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    // Clear ONE assertion by id, or ALL active for a developer (the common "they corrected it, withdraw" action).
    if (typeof body.id === "string" && body.id.trim()) {
      const cleared = await clearMisrepresentation(body.id.trim(), OPERATOR_LABEL, reason);
      if (!cleared) return NextResponse.json({ error: "not found or already cleared" }, { status: 404 });
      await logActivity("standing.cleared", OPERATOR_LABEL, { kind: "developer", id: cleared.developer }, STANDING_PARTIES(cleared.developer), {
        subjectName: await devName(cleared.developer),
      });
      return NextResponse.json({ cleared: publicMisrepresentation(cleared) });
    }
    const developer = typeof body.developer === "string" ? body.developer.trim() : "";
    if (!developer) return NextResponse.json({ error: "id or developer required" }, { status: 400 });
    const n = await clearDeveloper(developer, OPERATOR_LABEL, reason);
    // Emit only when something was actually withdrawn (n > 0) — a no-op clear shouldn't log a non-event.
    if (n > 0) {
      await logActivity("standing.cleared", OPERATOR_LABEL, { kind: "developer", id: developer }, STANDING_PARTIES(developer), {
        subjectName: await devName(developer),
      });
    }
    return NextResponse.json({ cleared: n });
  }

  if (action === "advance") {
    // THE WIRING: turn the scheduler's `misrepresentations` param from an injected arg into a
    // store-driven read. The scheduler keys the map by developer.toLowerCase (standing-scheduler.ts), so we
    // lower-case the keys here — misrepresentationTriggers keys by the STORED casing, which may differ.
    const developers = Array.isArray(body.developers)
      ? body.developers.filter((d: unknown): d is string => typeof d === "string")
      : undefined;
    const asOf = typeof body.asOf === "number" && Number.isFinite(body.asOf) ? body.asOf : undefined;

    const rawTriggers = await misrepresentationTriggers(developers);
    const misrepresentations = Object.fromEntries(
      Object.entries(rawTriggers).map(([dev, t]) => [dev.toLowerCase(), t])
    );

    const report = await advanceDeveloperStandings({ developers, misrepresentations, asOf });
    // Activity-feed rows (#7): one per REAL stage transition the scheduler recorded (it only pushes a new
    // transition, so this never double-logs a re-run). Developer + VRX-root only; stage category, no raw reason.
    for (const a of report.advances) {
      await logActivity("standing.advanced", OPERATOR_LABEL, { kind: "developer", id: a.developer }, STANDING_PARTIES(a.developer), {
        subjectName: await devName(a.developer),
        stage: a.stage,
      });
    }
    return NextResponse.json(report);
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
