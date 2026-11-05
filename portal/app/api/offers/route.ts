// /api/offers — the attested-offer store (the design docs).
//
//   POST { requestId, requestHash, developer, seal, display }
//     → record the plaintext offer the agent made, keyed by the opaque on-chain requestId. Called
//       (fire-and-forget) by the agent screen right after open_claim confirms on-chain. The on-chain
//       request_hash stays exactly as-is = the seal; this keeps the readable plaintext off-chain.
//
//   GET ?requestId=<id>   → { offer, verified } for one booking (the inbox row expands this).
//  GET ?node=<developer> → { offers: [{ requestId, verified... }] } for the whole inbox in one call.
//
// `verified` is the ✓ VETTED result: the stored plaintext re-hashed (server-side, same algorithm as the
// browser's hashRef, domain "vrx-terms") and compared to the on-chain request_hash. true = unaltered
// since signing; false = a loud red mismatch (tamper tripwire) OR we hold no matching plaintext.
//
// PRIVACY: the chain is untouched and holds only the hash. The plaintext lives here server-side — it
// is the party's private copy, never put on-chain. Not security-sensitive to the booking itself: the
// contract still enforces who may act (NOT_PEER/NO_GATE/E58); this store only affects what's SHOWN.

import { NextResponse } from "next/server";
import { getOffer, offersForDeveloper, recordOffer, verifyOffer, developerView, type Offer } from "@/lib/offers";
import { appendBuyerEvent } from "@/lib/buyer-events";
import { isDeveloperHidden, NEW_DEAL_PAUSED_REASON } from "@/lib/listing-gate";
import { bookableResult } from "@/lib/bookable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const requestHash = typeof body.requestHash === "string" ? body.requestHash : "";
  const developer = typeof body.developer === "string" ? body.developer : "";
  const seal = body.seal;
  if (!requestId || !requestHash || !developer || !seal || typeof seal !== "object") {
    return NextResponse.json({ error: "requestId + requestHash + developer + seal required" }, { status: 400 });
  }
  const offer: Offer = {
    requestId,
    requestHash,
    developer,
    seal: {
      terms: typeof seal.terms === "string" ? seal.terms : "",
      plan: seal.plan ?? null,
      ownership: seal.ownership,
      freehold: seal.freehold,
      buyer: seal.buyer, //  seam — carried through verbatim when present
      buyerMask: seal.buyerMask, // the agent's per-field mask choice, part of the seal
      by: typeof seal.by === "string" ? seal.by : "",
    },
    display: {
      buildingId: typeof body.display?.buildingId === "string" ? body.display.buildingId : undefined,
      unitId: typeof body.display?.unitId === "string" ? body.display.unitId : undefined,
      buyerType: body.display?.buyerType ?? null,
      buyerId: typeof body.display?.buyerId === "string" ? body.display.buyerId : undefined,
    },
    at: Date.now(),
  };
  const existed = (await getOffer(requestId)) != null;
  // a booking is always FOR a buyer: refuse to witness a genuinely NEW booking with no buyer on record.
  // The agent screen already blocks reserve-with-no-buyer PRE-SUBMIT (commit 2); this is the fail-closed server
  // BELT so we never seal a buyer-less offer even if that UI guard is bypassed. Only `!existed` new records are
  // gated — an idempotent re-POST / seed / replay of a known requestId always passes (never break an existing
  // deal we already hold). Mirrors the §3c/release belt pattern below in the same `!existed` block.
  const hasBuyer =
    offer.seal.buyer != null && typeof offer.seal.buyer === "object" && Object.keys(offer.seal.buyer as object).length > 0;
  // §3c new-deal admission guard — the server BELT behind the agent-UI courtesy block. Refuse to
  // witness a genuinely NEW booking against a developer PAUSED for overdue VRX fees. Only `!existed` new
  // records are gated: an idempotent re-POST of a record we already hold (an EXISTING deal's witness, or a
  // replay) always passes — §3c keeps existing deals running. Fail-OPEN on a resolve error (never block a
  // legitimate booking because the standing read hiccuped). The eventual on-chain gate-suspend makes the
  // contract itself refuse open_claim (NO_GATE); until then this is the authoritative off-chain gate.
  if (!existed) {
    //  require-buyer belt — a NEW booking must carry a buyer. Refuse the buyer-less one (409) so the
    // introduction is always bilateral; an existing deal (re-POST) is never gated by this.
    if (!hasBuyer) {
      return NextResponse.json(
        { error: "buyer_required", reason: "A booking must be made for a buyer on record." },
        { status: 409 }
      );
    }
    // Fail-closed RELEASE belt: refuse to ATTEST a NEW booking for a unit that isn't
    // bookable — on contract AND stamped open. The agent screen's pre-submit guard is the real enforcement
    // (it refuses BEFORE open_claim is sent); this server belt ensures we never seal an offer we'd have
    // refused. We can only evaluate when the display carries the plaintext (building, unit); the opaque
    // requestId alone isn't checkable here. The agent path always supplies them; a record lacking them
    // (seed/replay without display) was already enforced upstream, so it records. The V7 contract's own
    // NO_GATE will make this authoritative on-chain.
    if (offer.display.buildingId && offer.display.unitId) {
      const b = await bookableResult(developer, offer.display.buildingId, offer.display.unitId).catch(
        () => ({ ok: true as const })
      );
      if (!b.ok) return NextResponse.json({ error: "not_bookable", reason: b.message }, { status: 409 });
    }
    const paused = await isDeveloperHidden(developer).catch(() => false);
    if (paused) return NextResponse.json({ error: "developer_paused", reason: NEW_DEAL_PAUSED_REASON }, { status: 409 });
  }
  await recordOffer(offer);
  //  proof-of-introduction: the moment the booking is witnessed off-chain, seal an "introduction" event
  // — "Agent A introduced Buyer X (sealed) to Developer D at T". Only when a buyer is actually attached, and
  // only ONCE (skip on an idempotent seed/replay of a known requestId). The on-chain open_claim tx is the
  // ultimate anchor (offer.at ≈ its block time); this is the readable, re-verifiable twin on our spine.
  // (`hasBuyer` computed above for the belt; a new booking that reached here always has a buyer.)
  if (!existed && hasBuyer && offer.seal.by) {
    await appendBuyerEvent(
      requestId,
      "introduction",
      offer.seal.by,
      `Introduced a vetted buyer to ${developer} for this unit. Registered claim at ${new Date(offer.at).toISOString()}.`,
      { developer, requestHash }
    ).catch(() => {});
  }
  return NextResponse.json({ ok: true, verified: await verifyOffer(offer) });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId")?.trim();
  const node = url.searchParams.get("node")?.trim();

  // both read paths are developer-facing, so they ship the MASKED projection (developerView) while
  // the buyer is locked; verification uses the full stored offer so ✓ VETTED stays honest. The sealed
  // plaintext leaves the server only after a reveal act flips the offer's unlock state.
  if (requestId) {
    const offer = await getOffer(requestId);
    if (!offer) return NextResponse.json({ offer: null, verified: false });
    return NextResponse.json({ offer: developerView(offer), verified: await verifyOffer(offer) });
  }

  if (node) {
    const list = await offersForDeveloper(node);
    const offers = await Promise.all(
      list.map(async (o) => ({ ...developerView(o), verified: await verifyOffer(o) }))
    );
    return NextResponse.json({ offers });
  }

  return NextResponse.json({ error: "requestId or node required" }, { status: 400 });
}
