// POST /api/offers/reveal — the REVEAL ACT. A reveal is never a silent state-flip: it is a consented,
// witnessed, consequential act that itself CREATES a sealed record.
// The actions (body.action, default inferred from trigger):
// • "request" (developer, pre-deposit T1) — the developer accepts the non-circumvention DECLARATION
// developer must not be able to force the mask off before deposit; the agent's protection is never
// broken unilaterally. The developer's self-incriminating undertaking is on record either way.
// • "approve" (agent) — the agent approves a pending developer request → the buyer unlocks (trigger T1).
// • "decline" (agent) — the agent declines the pending request → it's cleared, still masked, logged.
// • "reveal" (direct) — the agent reveals early (T2), the buyer self-acknowledges (T4), or a deposit
// rail fires (rail-token / rail-cash). Unlocks immediately; no agent gate (the agent IS in control, or
// the deposit — the withhold ceiling — has been met).
// Every branch seals an event on the booking's trail (buyer-events) so all sides see WHO did WHAT WHEN —
// the chronology is the agent's evidence bundle ( dispute path #1).
// PRIVACY/AUTH: this governs only what the SERVER ships; the contract still enforces who may ACT
// on-chain. A stricter by-vs-trigger cross-check (only the developer may request, only the agent approves)
// is a natural hardening follow-on; v1 records faithfully and relies on the UI surfacing the right action.

import { NextResponse } from "next/server";
import { revealBuyer, requestReveal, clearRevealRequest, getOffer } from "@/lib/offers";
import { appendBuyerEvent } from "@/lib/buyer-events";
import { sealRecord } from "@/lib/seal";
import { publish } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRIGGERS = ["T1-dev", "T2-agent", "T4-buyer", "rail-token", "rail-cash"] as const;
type Trigger = (typeof TRIGGERS)[number];
const ACTIONS = ["request", "approve", "decline", "reveal"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const trigger = (typeof body.trigger === "string" ? body.trigger : "") as Trigger;
  const by = typeof body.by === "string" ? body.by.trim() : "";
  const declaration = typeof body.declaration === "string" ? body.declaration : "";
  // Default action from the trigger: a developer T1 is a REQUEST; everything else reveals directly.
  const action = (typeof body.action === "string" ? body.action : trigger === "T1-dev" ? "request" : "reveal") as Action;

  if (!requestId || !ACTIONS.includes(action) || !by) {
    return NextResponse.json({ error: "requestId + valid action + by required" }, { status: 400 });
  }

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "unknown_offer" }, { status: 404 });
  if (offer.unlock?.revealed) {
    return NextResponse.json({ ok: true, alreadyRevealed: true });
  }

  // ── Developer REQUEST (pre-deposit T1) — seal the declaration, record the pending request, stay masked ──
  if (action === "request") {
    if (!declaration) return NextResponse.json({ error: "declaration required" }, { status: 400 });
    const seal = sealRecord({ requestId, by, declaration }, "vrx-noncircumvention");
    await appendBuyerEvent(requestId, "declaration", by, declaration, {
      trigger: "T1-dev",
      declarationSeal: seal.hash,
      declarationSalt: seal.salt,
    });
    const updated = await requestReveal(requestId, by, seal.hash);
    publish("events"); // push the pending request to the agent's protection view in real time
    return NextResponse.json({ ok: true, requested: true, unlock: updated?.unlock });
  }

  // ── Agent DECLINE of a pending request — clear it, stay masked, log it (the sealed declaration stays) ──
  if (action === "decline") {
    await appendBuyerEvent(requestId, "reveal", by, "Agent declined the developer's reveal request.", { action: "decline" });
    await clearRevealRequest(requestId);
    publish("events");
    return NextResponse.json({ ok: true, declined: true });
  }

  // ── Unlock NOW: agent approve (T1), agent reveal early (T2), buyer ack (T4), or a deposit rail ──
  const unlockTrigger: Trigger =
    action === "approve" ? "T1-dev" : TRIGGERS.includes(trigger) ? trigger : "T2-agent";
  const declarationSeal = offer.unlock?.revealRequest?.declarationSeal;
  const updated = await revealBuyer(requestId, unlockTrigger, by, declarationSeal);
  if (!updated) return NextResponse.json({ error: "unknown_offer" }, { status: 404 });

  const label =
    action === "approve"
      ? "Agent approved the developer's reveal request — buyer identity unlocked."
      : `Buyer identity revealed (${unlockTrigger}).`;
  await appendBuyerEvent(requestId, "reveal", by, label, { trigger: unlockTrigger, action });
  publish("events"); // the developer inbox re-reads → sees the now-unlocked full buyer

  return NextResponse.json({ ok: true, unlock: updated.unlock });
}
