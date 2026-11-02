// Agency submits its application against an invite token (Lane 2, step 3).
// No operator auth — the unguessable token is the capability. Guards expiry + single-use in the store.
// The raw profile stays off-chain here; only its hash reaches the chain on approval.

import { NextResponse } from "next/server";
import { submitApplication, publicView } from "@/lib/applications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account : "";
  const profile = typeof body.profile === "string" ? body.profile : "";
  try {
    const rec = await submitApplication(token, account, profile);
    return NextResponse.json({ application: publicView(rec) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
