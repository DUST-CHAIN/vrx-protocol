// Single application by token (Lane 2).
// GET — public-safe view for the applicant page (no auth: the token IS the capability).
// DELETE — revoke an unused invite (operator-gated).
// The applicant never sees other applications or internal notes (publicView projection).

import { NextResponse } from "next/server";
import { getApplication, publicView, revokeInvite } from "@/lib/applications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const rec = await getApplication(token);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ application: publicView(rec) });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { token } = await params;
  await revokeInvite(token);
  return NextResponse.json({ ok: true });
}
