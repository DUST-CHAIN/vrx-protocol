// GET /api/faucet/log   — the notes-to-root: who was topped up, when, balance before, tx.
//
// Owner-gated with the same VRX_OPERATOR_SECRET convention as the applications decision route (no
// secret set → open, for the demo laptop). The Root dashboard reads this to see faucet activity.

import { NextResponse } from "next/server";
import { listFaucetNotes } from "@/lib/faucet-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ notes: await listFaucetNotes() });
}
