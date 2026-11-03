// /api/escrow — the DEPOSIT-CUSTODY release/refund surface (Slice 2, the IdeaForge-escrow port). SERVER-ONLY.
//
// When VRX_ESCROW_CUSTODY=1, a paid deposit lives in the escrow CUSTODY account (buyer → escrow at pay time —
// lib/pay-deposit), NOT the developer's wallet. This route drives the custody FSM's release/refund transitions
// with the authority model: DEVELOPER self-release + a BUYER TIME-LOCK VETO window.
//
//   POST { conversationId, action:"request_release", unit? }  — DEVELOPER asks to take the held deposit → starts
//        the buyer's veto clock (held → release_pending). No money moves yet. → { ok, state, vetoMsLeft }.
//   POST { conversationId, action:"finalize_release", unit? } — DEVELOPER finalizes once the veto window elapsed
//        (release_pending → released; money custody → developer). Refused 409 while the window is still open
//        (the buyer may still veto). → { ok, state } | 409 "buyer veto window still open".
//   POST { conversationId, action:"veto", unit? }             — BUYER vetoes within the window → refund (custody
//        → buyer; release_pending → refunded). → { ok, state }.
//   POST { conversationId, action:"waive", unit? }            — BUYER WAIVES the rest of their veto window for a
//        FAST CLOSE: release the deposit to the developer NOW (release_pending → released). The buyer-consent twin
//  of the developer's finalize; only the BUYER may waive their own protection (D-). → { ok, state }.
//   GET  ?conversationId=&unit?                               — EITHER party reads the live custody state +
//        vetoMsLeft (the buyer countdown / the dev's "can finalize yet?"). → { custody|null, vetoMsLeft }.
//
// ── AUTHORIZATION (fail-closed, defence in depth — the VRX-0001 IDOR class) ────────────────────────────
//   1. The acting account is the PROVEN caller (requireCaller), never a trusted body field — so an attacker who
//      learns a conversationId cannot drive another party's custody (request release AS the dev, veto AS the buyer).
//   2. ROLE is resolved from the conversation (directRole), and the ALLOWED role depends on the action:
//        request_release / finalize_release → DEVELOPER only (the self-release authority).
//        veto                               → BUYER only (the time-lock veto is the buyer's protection).
//        GET (read the live state)          → either party.
//   The FSM + the funding adapter do NOT authorize (the V5-relocatable seam) — this route is the one authz point.
//
// The focus deposit is the one the buyer has in custody for this deal, resolved SERVER-SIDE from the held unit
// (never a client-trusted unit for the money); when the chip carries a unit we require THAT held unit (the
// multiple-holds disambiguation, same discipline as /api/desk-action's pay/read_sp gate).
//
// PRIVACY: parties resolved server-side from the conversation; neutral account ids; amounts stay off-chain
// (custody is the $VRX ledger, only a terms hash would ever anchor — D-). This is the release/refund twin of
// the pay surface — the ONE custody FSM is the shared business-logic path (lib/escrow/deposit-custody).

import { NextResponse } from "next/server";
import { directParties, directRole } from "@/lib/conversations-direct";
import { requireCaller } from "@/lib/caller";
import { depositsForBuyer } from "@/lib/direct-deposits";
import {
  requestRelease,
  finalizeRelease,
  refundCustody,
  waiveVeto,
  custodyStateOf,
  vetoMsLeft,
} from "@/lib/escrow/deposit-custody";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["request_release", "finalize_release", "veto", "waive"] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (s: unknown): s is Action => typeof s === "string" && (ACTIONS as readonly string[]).includes(s);

/** Resolve the buyer's deposit for this deal (the one whose money is in custody). When `unitId` is given we
 *  require THAT held unit (disambiguates multiple holds); otherwise the first in-custody / held deposit. */
async function focusDeposit(buyer: string, building: string, unitId: string) {
  const mine = (await depositsForBuyer(buyer)).filter((d) => d.building === building);
  // Prefer a deposit that is actually in custody (held/release_pending); fall back to a plain held deposit.
  const inCustody = mine.filter((d) => d.custody && d.custody.state !== "none" && d.custody.state !== "released" && d.custody.state !== "refunded");
  const pool = inCustody.length ? inCustody : mine.filter((d) => d.status === "held");
  return unitId ? pool.find((d) => d.unit === unitId) ?? null : pool[0] ?? null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId")?.trim() || "";
  const unitId = url.searchParams.get("unit")?.trim() || "";
  if (!conversationId) return NextResponse.json({ error: "conversationId required" }, { status: 400 });

  // Bind the caller to the session; either party may READ the custody state (buyer for the countdown, dev to
  // see if the window elapsed). The param is the god-mode/dev-fallback hint requireCaller allows.
  const claimed = url.searchParams.get("account")?.trim() || "";
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });

  const parties = await directParties(conversationId);
  if (!parties) return NextResponse.json({ error: "no deal" }, { status: 404 });
  const role = await directRole(conversationId, who.account);
  if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });

  const dep = await focusDeposit(parties.buyer, parties.building, unitId);
  if (!dep) return NextResponse.json({ custody: null, vetoMsLeft: 0 });
  return NextResponse.json({
    custody: { state: custodyStateOf(dep), ...dep.custody },
    vetoMsLeft: vetoMsLeft(dep),
    unit: dep.unit,
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const action = body.action;
  const unitId = typeof body.unit === "string" ? body.unit.trim() : "";
  const claimedAccount = typeof body.account === "string" ? body.account.trim() : "";

  if (!conversationId) return NextResponse.json({ ok: false, reason: "conversationId required" }, { status: 400 });
  if (!isAction(action)) return NextResponse.json({ ok: false, reason: "unknown action" }, { status: 400 });

  // Gate 1 — the acting account is the PROVEN caller, never the client body (the IDOR bind).
  const who = requireCaller(req, { param: claimedAccount });
  if (!who.ok) return NextResponse.json({ ok: false, reason: "sign-in required" }, { status: 401 });
  const account = who.account;

  const parties = await directParties(conversationId);
  if (!parties) return NextResponse.json({ ok: false, reason: "no deal" }, { status: 404 });

  // Gate 2 — ROLE from the conversation; the allowed role depends on the action.
  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ ok: false, reason: "not a participant" }, { status: 403 });
  // veto + waive are the BUYER's own controls over their protection; request/finalize are the DEVELOPER's.
  const allowedRole: "buyer" | "developer" = action === "veto" || action === "waive" ? "buyer" : "developer";
  if (role !== allowedRole) {
    return NextResponse.json(
      { ok: false, reason: allowedRole === "developer" ? "only the developer may release the deposit" : "only the buyer may veto or waive a release" },
      { status: 403 }
    );
  }

  const dep = await focusDeposit(parties.buyer, parties.building, unitId);
  if (!dep) return NextResponse.json({ ok: false, reason: "no_custody_deposit" }, { status: 409 });

  // Drive the ONE custody FSM. It guards the transition (illegal source state → 409), is idempotent on the
  // terminal states, and owns the real money move via the funding adapter. The deal UID stays (buyer,building,
  // unit) — no parallel id. developer passed from the resolved parties (never the client).
  let res;
  if (action === "request_release") {
    res = await requestRelease(parties.buyer, parties.building, dep.unit);
  } else if (action === "finalize_release") {
    res = await finalizeRelease(parties.buyer, parties.building, dep.unit, parties.developer);
  } else if (action === "waive") {
    res = await waiveVeto(parties.buyer, parties.building, dep.unit, parties.developer);
  } else {
    res = await refundCustody(parties.buyer, parties.building, dep.unit);
  }

  if (!res.ok) return NextResponse.json({ ok: false, reason: res.error, action }, { status: res.status });
  return NextResponse.json({
    ok: true,
    action,
    unit: dep.unit,
    state: custodyStateOf(res.deposit),
    vetoMsLeft: vetoMsLeft(res.deposit),
    noop: res.noop ?? false,
  });
}
