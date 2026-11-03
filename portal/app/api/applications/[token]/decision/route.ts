// Operator records the decision on an applied application (Lane 2, steps 4-5).
//
// APPROVE: the owner has ALREADY signed register_org on-chain in the browser (key custody stays in the
// wallet, never server-side); the client passes the resulting orgRef + tx here so the store
// reflects the on-chain truth. This endpoint does NOT sign anything.
// REJECT: pure off-chain state change — never touches the chain (ONBOARDING_ACCOUNTS).

import { NextResponse } from "next/server";
import { markApproved, markRejected } from "@/lib/applications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    if (body.decision === "approve") {
      if (typeof body.orgRef !== "string" || !body.orgRef) {
        return NextResponse.json({ error: "orgRef required (register_org must be signed first)" }, { status: 400 });
      }
      const rec = await markApproved(token, body.orgRef, typeof body.tx === "string" ? body.tx : undefined);
      return NextResponse.json({ application: rec });
    }
    if (body.decision === "reject") {
      const rec = await markRejected(token, typeof body.reason === "string" ? body.reason : undefined);
      return NextResponse.json({ application: rec });
    }
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
