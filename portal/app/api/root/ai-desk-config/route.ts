// GET/POST /api/root/ai-desk-config — the VRX-root control panel for the AI Sales Director. GET returns
// the live AiDeskConfig; POST applies a partial update (the panel sends only changed fields). Operator-gated
// with the same x-vrx-operator convention as /api/faucet/* (no secret set → open, for the demo laptop).
//
// This is the ONE place the AI's authority is governed: the per-action toggles (reveal/concede/call-off/block),
// the concession bound, the PII-scrub switch, and the master `enabled` all live in the config store this writes.
// PRIVACY: config booleans/numbers only, no PII.

import { NextResponse } from "next/server";
import { getAiDeskConfig, updateAiDeskConfig } from "@/lib/ai-desk/config";
import type { AiDeskConfig } from "@/lib/ai-desk/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getAiDeskConfig());
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let patch: Partial<AiDeskConfig>;
  try {
    patch = (await req.json()) as Partial<AiDeskConfig>;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  return NextResponse.json(await updateAiDeskConfig(patch));
}
