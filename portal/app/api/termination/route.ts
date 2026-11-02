// POST /api/termination — take ONE lawful step of the DEFAULT / TERMINATION process on a booking ( slice 2b).
// GET /api/termination?requestId=&viewer= — read a deal's current termination overlay + its sealed step trail.
// POST body { requestId, by, step, note?, cureWindowMs? }
// step ∈ serve_buyer_default | serve_seller_default | record_cure | terminate_buyer_default
// | terminate_seller_default
// → { ok, overlay, record } on success, or { error } + status on refusal.
// THE ARC ("no fraud, no holes"): a live/signed reservation can only return to the developer through the
// contract's lawful default process — served notice → cure window → termination — never a silent off-chain
// freeze. This route is the gated CALLER of the pure machine (lib/termination) + its store (lib/termination-store).
// The machine decides legality and seals each step; the store persists append-only and REFUSES an unlawful step
// (it throws TerminationError → the store writes nothing → we map it to 409). So this route holds exactly ONE
// responsibility the lower layers can't: WHO is allowed to act.
// is a REFUND to the buyer — a developer admitting they can't get a required regulatory approval and triggering the refund is
// the honest act, not a gamed one; and the sealed append-only trail + the operator's God's-eye read keep
// it tamper-evident regardless). If a neutral-arbiter requirement emerges, an operator gate on the seller-default
// steps is a one-line addition here. Scope resolved via lib/participant.roleOnOffer (the F1 chokepoint).
// AUTHENTICATION caveat (F1, unchanged honest posture): the actor arrives as an unsigned `by`/`viewer` param,
// trusted as-is in the demo layer. This route enforces AUTHORIZATION (is this actor, IF they are who they claim,
// allowed to act?) — not AUTHENTICATION (are they who they claim?). The real wallet/session binding lands with
// the signing arc and changes in ONE place (lib/participant), which this route inherits.
// PRIVACY: the body carries only the opaque requestId + actor + step verb + an optional free NOTE +
// (for a serve) the cure-window length. No PII, no price/terms plaintext; retain/refund AMOUNTS are the
// payment-ledger/vault's job (slice 5), referenced not duplicated. Each persisted step is sealed (lib/seal).

import { NextResponse } from "next/server";
import { getOffer } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";
import { recordStep, overlayFor, stepsFor } from "@/lib/termination-store";
import { TerminationError, type TerminationStep } from "@/lib/termination";
import { publish } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STEPS: TerminationStep[] = [
  "serve_buyer_default",
  "serve_seller_default",
  "record_cure",
  "terminate_buyer_default",
  "terminate_seller_default",
];

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const by = typeof body.by === "string" ? body.by.trim() : "";
  const step = STEPS.includes(body.step) ? (body.step as TerminationStep) : null;
  if (!requestId || !by || !step) {
    return NextResponse.json(
      { error: "requestId + by + step (serve_buyer_default|serve_seller_default|record_cure|terminate_buyer_default|terminate_seller_default) required" },
      { status: 400 }
    );
  }

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  // AUTHZ — developer-only (the Seller). Fail closed for non-parties and for the agent/agency role.
  const role = await roleOnOffer(offer, by);
  if (role !== "developer") {
    return NextResponse.json({ error: "only the developer may act on the default/termination process" }, { status: 403 });
  }

  const note = typeof body.note === "string" ? body.note.trim() || undefined : undefined;
  const cureWindowMs =
    typeof body.cureWindowMs === "number" && Number.isFinite(body.cureWindowMs) ? body.cureWindowMs : undefined;

  try {
    const { overlay, record } = await recordStep(requestId, { step, by, note, cureWindowMs });
    publish("events"); // open dashboards refresh (the deal's termination state changed)
    return NextResponse.json({ ok: true, overlay, record });
  } catch (e) {
    // The store re-throws TerminationError for an UNLAWFUL/too-early step (and wrote nothing). That's a client
    // error on the CURRENT state (e.g. terminate before the cure window elapses, or a step from a terminal
    // state), so 409 Conflict with the machine's own message — never a 500. Anything else is a real server fault.
    if (e instanceof TerminationError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestId = (url.searchParams.get("requestId") ?? "").trim();
  const viewer = (url.searchParams.get("viewer") ?? "").trim();
  if (!requestId || !viewer) {
    return NextResponse.json({ error: "requestId + viewer required" }, { status: 400 });
  }

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  // READ authz — any PARTICIPANT may read the deal's termination state (the developer acts; the agent/agency
  // need to see that a default is in progress on a deal they booked). Non-parties fail closed. (The buyer is
  // not a participant in this module yet — buyer-side login is deferred; when it lands it reads here too.)
  const role = await roleOnOffer(offer, viewer);
  if (!role) return NextResponse.json({ error: "not a party to this booking" }, { status: 403 });

  const [overlay, steps] = await Promise.all([overlayFor(requestId), stepsFor(requestId)]);
  return NextResponse.json({ ok: true, overlay, steps });
}
