// POST /api/claims/contract — advance the S&P CONTRACT stage (the FINAL/validity state machine).
// body { requestId, by, action } where action ∈ "final" | "payment_arrived" | "signed".
// → { ok, contract } the updated offer.contract overlay (or an error + status).
// advances exactly one step (monotonic — lib/offers enforces the ordering; an out-of-order call is a no-op).
// GATES (enforced HERE, where the participant + reveal state are known):
// • final — DEVELOPER only, and the buyer identity must already be REVEALED to them (offer.unlock.revealed,
//). The developer also accepts the "I have seen the buyer KYC and will use it only for this purpose"
// • payment_arrived — DEVELOPER only (they witness the on-contract payment). This is the VALIDITY gate: only
// from here is an online signature binding.
// • signed — either party; the real signing ACT rides the later wallet arc, this records the stage.
// Participant scope via lib/participant (the F1 chokepoint). Fail closed for non-parties / wrong role.
// Each successful transition seals a buyer-event (contract_final | payment_arrived | contract_signed) for the
// audit trail + activity feed, and publishes "events" so open dashboards refresh. PRIVACY: no PII, no
// plaintext terms — opaque requestId + account + the sealed ack hash only.

import { NextResponse } from "next/server";
import {
  getOffer,
  contractStage,
  markContractFinal,
  markPaymentArrived,
  markContractSigned,
} from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";
import { appendBuyerEvent } from "@/lib/buyer-events";
import { sealRecord } from "@/lib/seal";
import { publish } from "@/lib/bus";
import { getEntry, docSetHashes } from "@/lib/kyc-vault";
import { getBuilding } from "@/lib/catalog";
import { getEntity, hasUsablePaymentDestination } from "@/lib/seller-entities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["final", "payment_arrived", "signed"] as const;
type Action = (typeof ACTIONS)[number];

// The undertaking the developer accepts to mark a contract final ( pt-2). Sealed as evidence that the
// developer saw the buyer KYC and limited its use — kept in one place so the agreed text is reproducible.
const KYC_SEEN_UNDERTAKING =
  "I confirm I have seen the buyer's KYC for this booking and will use it solely to prepare and execute this Sale & Purchase agreement.";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const by = typeof body.by === "string" ? body.by.trim() : "";
  const action = ACTIONS.includes(body.action) ? (body.action as Action) : null;
  if (!requestId || !by || !action) {
    return NextResponse.json({ error: "requestId + by + action (final|payment_arrived|signed) required" }, { status: 400 });
  }

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  const role = await roleOnOffer(offer, by);
  if (!role) return NextResponse.json({ error: "not a party to this booking" }, { status: 403 });

  const stage = contractStage(offer);

  if (action === "final") {
    if (role !== "developer") return NextResponse.json({ error: "only the developer can mark the contract final" }, { status: 403 });
    if (stage !== "preview") return NextResponse.json({ error: `contract already at "${stage}"` }, { status: 409 });
    // Gate: the buyer identity must be disclosed to the developer first. Full name shows at "final",
    // so we must not reach final while the buyer is still masked.
    if (!offer.unlock?.revealed) {
      return NextResponse.json({ error: "reveal the buyer's identity before marking the contract final" }, { status: 409 });
    }
    // pt-2 — the buyer-KYC DOCUMENTS must actually be on file before the developer can finalise: the
    // "seen the KYC" ack is meaningless if there's nothing to see. Require at minimum a headshot + one ID
    // document (id_card OR passport). The join key is the off-seal offer.display.buyerId (stamped at booking).
    const buyerId = offer.display?.buyerId?.trim() || "";
    const vault = buyerId ? await getEntry(buyerId) : null;
    const kinds = new Set((vault?.docs ?? []).map((d) => d.kind));
    const hasId = kinds.has("id_card") || kinds.has("passport");
    if (!vault || !kinds.has("headshot") || !hasId) {
      return NextResponse.json(
        { error: "buyer KYC incomplete — a headshot and an ID/passport must be uploaded before the contract can be finalised" },
        { status: 409 }
      );
    }
    // omit WHERE to pay. Resolve this deal's building → reusable seller entity (same path as the S&P generator
    // in /api/claims/sp) and require at least one usable destination (a payment option, or a legacy
    // `bankPayable` — resolvePaymentOptions migrates that read-side). Block `final` otherwise. The invariant
    // "a signable contract always states a payee" is also asserted in lib/payment-methods.test.ts.
    const buildingId = offer.display?.buildingId?.trim() || "";
    const building = buildingId ? await getBuilding(buildingId) : null;
    const sellerEntity = building?.sellerEntityId ? await getEntity(building.sellerEntityId) : null;
    if (!hasUsablePaymentDestination(sellerEntity)) {
      return NextResponse.json(
        { error: "add at least one payment method for this building's seller before this deal can be marked ready to sign" },
        { status: 409 }
      );
    }
    // Seal the undertaking BOUND to the exact doc set the developer is attesting to (content hashes, never
    // the images). A later alteration of any uploaded doc makes this ack stop re-verifying — the ack proves
    // WHICH documents were seen, not just that some undertaking was clicked.
    const ack = sealRecord({ undertaking: KYC_SEEN_UNDERTAKING, docs: docSetHashes(vault) }, "vrx-kyc-ack");
    const updated = await markContractFinal(requestId, by, ack.hash);
    await appendBuyerEvent(requestId, "contract_final", by, "Contract marked ready to sign; developer acknowledged seeing the buyer KYC.", {
      kycAckSeal: ack.hash,
    });
    publish("events");
    return NextResponse.json({ ok: true, contract: updated?.contract ?? null });
  }

  if (action === "payment_arrived") {
    if (role !== "developer") return NextResponse.json({ error: "only the developer can confirm the on-contract payment" }, { status: 403 });
    if (stage !== "final") return NextResponse.json({ error: `contract must be "final" first (is "${stage}")` }, { status: 409 });
    const updated = await markPaymentArrived(requestId, by);
    await appendBuyerEvent(requestId, "payment_arrived", by, "On-contract payment confirmed received — contract is valid to sign online.");
    publish("events");
    return NextResponse.json({ ok: true, contract: updated?.contract ?? null });
  }

  // action === "signed"
  if (stage !== "payment_arrived") {
    return NextResponse.json({ error: `contract must be "payment_arrived" first (is "${stage}")` }, { status: 409 });
  }
  const updated = await markContractSigned(requestId);
  await appendBuyerEvent(requestId, "contract_signed", by, "Sale & Purchase agreement signed.");
  publish("events");
  return NextResponse.json({ ok: true, contract: updated?.contract ?? null });
}
