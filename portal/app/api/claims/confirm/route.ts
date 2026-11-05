// POST /api/claims/confirm — the DURABLE record of a SALE.
//
// WHY THIS EXISTS: confirm_claim closes the on-chain TILE but leaves claim.status at 1 (contract
// FROZEN). So the chain truth the inbox reads back (/api/claims) can't tell "accepted, awaiting deposit"
// (status 1) from "deposit paid, unit closed" (also status 1). Without an off-chain marker the developer's
// "Confirm" button re-appears on every refresh and the sold state is lost (hit this). This route is
// called AFTER the confirm tx succeeds on-chain: it stamps offer.confirmed (survives refresh, rides along
// in the same /api/claims blob) and seals a "confirmed" event on the booking trail — the sale anchor that
// the recent-sales surface and (future) cancellation flow both read.
//
// PRIVACY: no PII, no plaintext terms. Only the opaque requestId + the confirming developer account.
// The contract still enforces who may confirm on-chain; this records the act faithfully for the UI + trail.

import { NextResponse } from "next/server";
import { markConfirmed, getOffer } from "@/lib/offers";
import { buildObligationSnapshot } from "@/lib/commission";
import { appendBuyerEvent } from "@/lib/buyer-events";
import { publish } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const by = typeof body.by === "string" ? body.by.trim() : "";
  // the on-chain receipt (confirm_claim tx hash). Optional: the client sends it from state.tx after
  // the wallet returns, but a confirm can still succeed without it (older client / tx read lost). Persisted
  // so the SoldBadge can show tx + explorer link. No validation beyond trimming — it's an opaque hash ref.
  const tx = typeof body.tx === "string" ? body.tx.trim() : "";
  if (!requestId || !by) {
    return NextResponse.json({ error: "requestId + by required" }, { status: 400 });
  }

  const offer = await getOffer(requestId);
  // No local offer = booked outside this portal; nothing off-chain to stamp. The on-chain close still
  // happened — the UI falls back to its ephemeral guard for that session. Report cleanly, don't 500.
  if (!offer) return NextResponse.json({ ok: true, noOffer: true });

  // Idempotent: a replay keeps the first confirmation (markConfirmed never clobbers, but backfills a
  // missing tx receipt). Only seal a trail event on the FIRST confirm, so the sale anchor isn't duplicated
  // on a double-click or a re-read.
  const alreadyConfirmed = Boolean(offer.confirmed);
  // H1 — FREEZE the obligation (commission + VRX fee + unlock clause) at close, while the agreement is
  // still live, so a later agreement revoke/expiry can't erase money genuinely owed. Resolved from the live
  // pre-confirmation offer; undefined when nothing was facilitated (then no snapshot is written). Skipped on a
  // replay that already carries a snapshot (markConfirmed never overwrites the first-frozen figures anyway).
  const obligation = offer.obligation ? undefined : await buildObligationSnapshot(offer);
  const updated = await markConfirmed(requestId, by, tx || undefined, obligation);

  if (!alreadyConfirmed) {
    await appendBuyerEvent(requestId, "confirmed", by, "Deposit confirmed — unit closed on-chain.", {
      at: updated?.confirmed?.at,
      ...(updated?.confirmed?.tx ? { tx: updated.confirmed.tx } : {}),
    });
    publish("events"); // push the sold state to any open inbox / recent-sales view in real time
  }

  return NextResponse.json({ ok: true, confirmed: updated?.confirmed ?? null });
}
