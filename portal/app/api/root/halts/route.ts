// /api/root/halts — the VRX-ROOT operator console for developer building HALTS (Part A,
// the design docs). The VRX side of the halt lever: see every halt, and ACKNOWLEDGE a
// REGULAR (pending) halt so it takes effect.
//
//   GET  → { pending, all? }
//          pending = every halt awaiting a VRX acknowledgement (regular, status `pending`) — the queue.
//          (A GET with ?building=<id> returns that building's full halt history instead, for a drill-down.)
//   POST { action: "acknowledge", id }
//        → { halt }  — activates a pending (regular) halt (pending → active). The "ask VRX first" tier takes
//                      effect here. Urgent halts are already active and never pass through this.
//
// ── WHY a regular halt needs this ──────────────────────────────────────────────────────────
// A REGULAR halt is "ask VRX first": it is recorded `pending` and does NOT hide the building until VRX
// acknowledges it (the literal "applied on VRX acknowledgement" reading of the design). In this demo there is
// no human VRX actor, so THIS route is the acknowledgement action. An URGENT halt is active on assertion and
// never needs acknowledging (the developer's safety case can't wait). TRANSPARENCY not permission (
// ): VRX acknowledging a regular halt is NOT VRX granting permission to halt (a developer may always
// halt) — it is VRX being in the loop before a non-urgent pause takes effect, exactly as the developer asked.
//
// ── AUTH: the EXISTING /root operator-secret gate (identical to /api/root/misrepresentations) ───────────────
// Fail-closed x-vrx-operator vs VRX_OPERATOR_SECRET, with the explicit local VRX_DEMO_OPEN=1 escape hatch. The
// VRX-root boundary is a SHARED OPERATOR SECRET (a bearer credential for "the VRX team"), not a named-account
// check. An unset secret DENIES (a halt acknowledgement changes what buyers can see — never open by default).
//
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-side only; nothing on-chain; the projection strips the per-record salt. The developer's note
// IS visible to VRX here (VRX is a party to every halt) — it is the whole point of the "ask VRX first" tier.

import { NextResponse } from "next/server";
import {
  acknowledgeHalt,
  pendingHalts,
  haltsForBuilding,
  publicHalt,
} from "@/lib/building-halt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical posture to /api/root/misrepresentations + /api/root/overview.
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

// The audit label recorded as the acknowledger. Not an auth check (the secret is) — just who the audit names.
const OPERATOR_LABEL = process.env.VRX_OPERATOR_LABEL?.trim() || "vrx-root";

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const building = (new URL(req.url).searchParams.get("building") ?? "").trim();
  if (building) {
    // Drill-down: one building's full halt history (newest first).
    const history = await haltsForBuilding(building);
    return NextResponse.json({ history: history.map(publicHalt) });
  }

  // The acknowledgement queue: every regular halt still pending VRX ack.
  const pending = await pendingHalts();
  return NextResponse.json({ pending: pending.map(publicHalt) });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action.trim() : "";

  if (action === "acknowledge") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const halt = await acknowledgeHalt(id, OPERATOR_LABEL);
    // Null = not found OR not pending (already active/urgent/lifted) — a no-op acknowledgement, 404 honestly.
    if (!halt) return NextResponse.json({ error: "not found or not pending" }, { status: 404 });
    return NextResponse.json({ halt: publicHalt(halt) });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
