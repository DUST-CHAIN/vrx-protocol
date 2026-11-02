// POST /api/gates { developer, agency, active? } — record a grant (or revoke) the portal witnessed.
// Called (fire-and-forget) by the developer dashboard right after grant_gate / revoke_gate confirms
// on-chain. This is the write-through that lets the agent picker resolve access from the server without
// reading the chain (lib/gates.ts). Not security-sensitive: the on-chain gate still enforces the actual
// booking (NO_GATE/E58), so this map only affects what's shown, never what's allowed.
// PRIVACY: neutral account ids only.

import { NextResponse } from "next/server";
import { recordGate } from "@/lib/gates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const developer = typeof body.developer === "string" ? body.developer : "";
  const agency = typeof body.agency === "string" ? body.agency : "";
  const active = body.active !== false; // default true (a grant); pass false for a revoke
  if (!developer || !agency) return NextResponse.json({ error: "developer + agency required" }, { status: 400 });
  await recordGate(developer, agency, active);
  return NextResponse.json({ ok: true });
}
