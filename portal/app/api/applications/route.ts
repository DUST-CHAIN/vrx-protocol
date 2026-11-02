// Root-dashboard application API — list all + create an invite (Lane 2).
// AUTH (demo-laptop pragmatic gate): these two endpoints expose/create operator state (raw profiles),
// so they require the operator secret in the `x-vrx-operator` header, matched against VRX_OPERATOR_SECRET.
// This is NOT a substitute for real auth — it's a fence so the queue isn't world-readable when the dev
// server is reachable. The genuinely security-critical step (register_org) is still owner-wallet-signed
// on-chain; this gate only protects the off-chain application store. At mainnet, replace with proper auth
// (e.g. a signed-message challenge from the owner account). See ONBOARDING_ACCOUNTS open-Q #1/#4.

import { NextResponse } from "next/server";
import { createInvite, listApplications } from "@/lib/applications";

// File-backed store → this route must run on the Node runtime, not the edge, and never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  // If no secret is configured (local dev), allow — but that's an explicit local-only posture.
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ applications: await listApplications() });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const rec = await createInvite(typeof body.label === "string" ? body.label : undefined);
  return NextResponse.json({ application: rec }, { status: 201 });
}
