// GET /api/change-governance/amendments?requestId=..&viewer=.. — the PARTY-FACING read of the sealed
// §Slice 7). This is the buyer's side of the arc: a MAJOR material change to their building filed a sealed
// amendment + an explicit dispute right (lib/contract-amendment, Slice 3) — here the buyer (or any party to
// the deal) retrieves the before/after proof and sees that the right exists. VRX anchors the evidence + the
// RIGHT; VRX does NOT adjudicate ( pt5) — no dispute OUTCOME is ever stored or shown.
// GET { requestId, viewer } → { amendments:[{ changeClass, evidenceId, disputeRight, at, verified }] }
// scoped to the ONE contract (by requestId). salt STRIPPED; the buyerRef is dropped entirely (a party
// viewing their OWN contract has no need to see the opaque ref, and we never surface it party-side).
// ── AUTH (mirrors /api/claims/sp exactly — the same party gate) ─────────────────────────────────────────────
// requireCaller resolves the PROVEN identity (F1, param-fallback today). Only a PARTY to the deal may read it:
// • a DIRECT buyer/desk → authorized via the conversation's directRole (the buyer side has no agent party,
// so roleOnOffer alone can't authorize them — same reason the S&P route resolves it).
// • a booking developer / agent / supervising agency → authorized via roleOnOffer.
// Anyone else (or an unknown deal) → 403, fail closed. This is NOT the operator-secret path (that's the VRX-root
// console /api/root/change-governance); this is party-facing, so requireCaller is the correct gate.
// ── PRIVACY + MASKING ──────────────────────────────────────────────────────────────────────
// SERVER-side only; nothing on-chain. The projection strips the per-record salt ( — never leaves the server)
// and the buyerRef (not needed party-side). The remaining fields are the change class, the evidence id (the link
// to the sealed before/after), the dispute-right flag, the timestamp, and the ✓-verify result. No PII.

import { NextResponse } from "next/server";
import { getOffer } from "@/lib/offers";
import { isDirectOffer } from "@/lib/direct-offer";
import { directRole } from "@/lib/conversations-direct";
import { roleOnOffer } from "@/lib/participant";
import { requireCaller } from "@/lib/caller";
import { amendmentsForContract } from "@/lib/contract-amendment";
import { partyAmendmentView } from "@/lib/amendment-party-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId")?.trim() ?? "";
  if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });

  // F1: identity from the verified session (param-fallback honours the legacy ?viewer= today).
  const caller = requireCaller(req, { param: url.searchParams.get("viewer") });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });
  const viewer = caller.account;

  const stored = await getOffer(requestId);
  if (!stored) return NextResponse.json({ error: "deal not on file" }, { status: 404 });

  // Party gate — identical shape to /api/claims/sp. A direct deal's BUYER is authorized through directRole
  // (no agent party to match); a booking developer/agent/agency through roleOnOffer. Not a party → 403.
  let authorized = false;
  if (isDirectOffer(stored)) {
    const convId = stored.display.conversationId?.trim() || "";
    const dRole = convId ? await directRole(convId, viewer) : null;
    authorized = dRole === "buyer" || dRole === "developer";
  } else {
    authorized = (await roleOnOffer(stored, viewer)) !== null;
  }
  if (!authorized) return NextResponse.json({ error: "not a party to this deal" }, { status: 403 });

  // Salt-stripped, buyerRef-dropped projection (the salt never leaves the server,; the ref is not needed
  // party-side). `verified` is the ✓-check a party can trust — the record still hashes to its seal.
  const amendments = (await amendmentsForContract(requestId)).map(partyAmendmentView);

  return NextResponse.json({ amendments });
}
