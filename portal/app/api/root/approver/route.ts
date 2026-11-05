// POST /api/root/approver — VRX-ROOT sets WHO signs a developer's version-gated changes off.
// The "approver" is the trust-dial twin of the per-class policy matrix: it defaults to the developer themselves
// ("developer" — self-approve), but VRX/CEO can point it at a CEO/VRX wallet ("ceo"/"vrx") so the CEO, not the
// developer, decides pending inventory versions. Wraps lib/dev-edit-policy.setApprover (re-seals the policy).
//
//   POST { developer, approver, approverRole:"developer"|"ceo"|"vrx" }
//     → { ok, approver, approverRole }   (the updated policy's approver fields)
//
// Request-approval stamps this `approver` onto each opened version; decideVersion enforces that only that
// approver may decide — so flipping this here is exactly what re-routes the Approve/Reject power to the CEO.
//
// ── AUTH: the EXISTING /root operator-secret gate (fail-closed) — identical to /api/root/inventory-oversight.
// This is a VRX-root trust action (it changes who controls a developer's changes), so it must never be party-
// facing. x-vrx-operator vs VRX_OPERATOR_SECRET, with the explicit local VRX_DEMO_OPEN=1 escape hatch; an unset
// secret DENIES. The policy must already exist (ensurePolicy runs at go-on-contract) — setApprover returns null
// for an unknown developer, which we surface as 404.
//
// PRIVACY: server-side only; neutral developer/approver accounts only. Nothing on-chain.

import { NextResponse } from "next/server";
import { setApprover, type ApproverRole } from "@/lib/dev-edit-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

const ROLES: ReadonlySet<string> = new Set(["developer", "ceo", "vrx"]);

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const developer = typeof body.developer === "string" ? body.developer.trim() : "";
  const approver = typeof body.approver === "string" ? body.approver.trim() : "";
  const approverRole = typeof body.approverRole === "string" ? body.approverRole.trim() : "";

  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
  if (!approver) return NextResponse.json({ error: "approver (NEAR account) required" }, { status: 400 });
  if (!ROLES.has(approverRole)) {
    return NextResponse.json({ error: "approverRole must be developer, ceo, or vrx" }, { status: 400 });
  }

  const updated = await setApprover({ developer, approver, approverRole: approverRole as ApproverRole });
  if (!updated) {
    // null = no policy on record for this developer yet (it's created at go-on-contract), or bad account.
    return NextResponse.json({ error: "no edit policy for that developer yet", code: "no_policy" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, approver: updated.approver, approverRole: updated.approverRole });
}
