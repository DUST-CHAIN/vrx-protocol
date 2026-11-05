// GET  /api/fastnear-keys → the key registry (keys MASKED) + the auto-escalation log + dashboard url +
//                           current escalation state. Owner-only (⚙ Settings FastNEAR card).
// POST /api/fastnear-keys → owner mutations:
//   { add: { key, email, label? } }            → add a key+email pair
//   { setStatus: { keyMasked, status } }        → active | spent | removed
//   { setEmail:  { keyMasked, email } }         → correct a key's account email
//
// Same owner-auth convention as /api/usage + the faucet (VRX_OPERATOR_SECRET; no secret set → open for the
// local demo). The RAW key NEVER leaves the server — list returns masked suffixes only; mutations address a
// key by its masked suffix.

import { NextResponse } from "next/server";
import { listKeysForOwner, addKey, setKeyStatus, setKeyEmail } from "@/lib/fastnear-keys";
import { escalationActive, escalationRemainingMs } from "@/lib/fastnear-escalation";

const escalationStateForOwner = () => ({
  active: escalationActive(),
  remainingMs: escalationRemainingMs(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return true;
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const reg = await listKeysForOwner();
  return NextResponse.json({ ...reg, escalation: escalationStateForOwner() });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: {
    add?: { key?: string; email?: string; label?: string };
    setStatus?: { keyMasked?: string; status?: "active" | "spent" | "removed" };
    setEmail?: { keyMasked?: string; email?: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (body.add?.key) {
    await addKey(body.add.key, body.add.email ?? "", body.add.label);
  } else if (body.setStatus?.keyMasked && body.setStatus.status) {
    await setKeyStatus(body.setStatus.keyMasked, body.setStatus.status);
  } else if (body.setEmail?.keyMasked && typeof body.setEmail.email === "string") {
    await setKeyEmail(body.setEmail.keyMasked, body.setEmail.email);
  } else {
    return NextResponse.json({ error: "nothing_to_do" }, { status: 400 });
  }

  const reg = await listKeysForOwner();
  return NextResponse.json({ ...reg, escalation: escalationStateForOwner() });
}
