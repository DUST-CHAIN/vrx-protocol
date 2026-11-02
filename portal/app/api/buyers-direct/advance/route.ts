// POST /api/buyers-direct/advance — the DESK operator advances a direct buyer's funnel state ( §9 3b–5).
// Developer-only: the caller must be the DESK DEVELOPER of a building the buyer has an enquiry about (so a
// stranger can't advance an arbitrary buyer, and only a desk that's actually talking to the buyer can move
// them). Advancement is monotonic unless `allowRegress` (a deliberate pull-back) — lib/buyers-direct.
// POST { caller, account, building, to, allowRegress? }
// caller — the operator's wallet account (must be `building`'s desk developer)
// account — the buyer being advanced
// building — a building the operator runs the desk for (authorizes the caller)
// to — target funnel state (new|in_conversation|units_opened|offer_eligible)
// allowRegress? — move the buyer backward (default forward-only)
// AUTH model (this slice): capability-based like the sibling routes — the caller names its account; a
// challenge-sign binding is later hardening (the same open-Q as /api/buyers-direct). The authorization that
// MATTERS here (caller == the building's desk developer) IS enforced server-side via deskDeveloperFor.

import { NextResponse } from "next/server";
import {
  advanceFunnel,
  kycPrecondition,
  getBuyerDirect,
  type BuyerDirect,
  type BuyerFunnelState,
} from "@/lib/buyers-direct";
import { deskDeveloperFor, directConversationId, grantedFieldsFor, priorBlockFor } from "@/lib/conversations-direct";
import { offerEligibility } from "@/lib/offer-eligibility";
import { publicDirectProfileView, type BuyerMask, type MaskMode } from "@/lib/buyer-mask";

/**
 * The DESK-SAFE projection of a direct buyer (d — the privacy gate). This route answers the DESK
 * DEVELOPER (a COUNTERPARTY), so the buyer's identifying PII must NEVER leave the server unmasked: the
 * profile is run through `publicDirectProfileView` (name → hint, nationality shown, passport/ID/address/
 * contact dropped) BEFORE it hits the wire. The funnel/seal/provenance metadata the desk legitimately needs
 * passes through untouched. The buyer's OWN read (GET /api/buyers-direct?account=) stays full — this masking
 * is only for the counterparty-facing desk route.
 *
 * The EFFECTIVE mask is resolved MOST-PERMISSIVE across the layers (the design docs §6):
 * 1. DIRECT_PROFILE_MASK — the fully-masked floor (inside publicDirectProfileView).
 * 2. `b.maskOverride` — the buyer's OWN global visibility dial.
 * 3. `grantedFields` — fields the buyer CONSENTED to reveal to THIS desk, forced to
 * `show` on top. A grant is per-CONVERSATION (buyer↔this building's desk), never global.
 * 4. `forceShow` (the E slice — anti-cheat) — if this desk has EVER hard-blocked this buyer
 * (`priorBlock`), the buyer's WHOLE identity is force-shown to THIS desk so they can't re-approach
 * anonymously. This INVERTS the privacy floor deliberately, scoped to the blocking desk only (never global).
 * `maskOverride` is stripped from the desk response — it's the buyer's private preference, and shipping it
 * would reveal which fields the buyer deliberately kept hidden (a small leak of intent).
 */
function deskSafeBuyer(
  b: BuyerDirect,
  grantedFields: string[] = [],
  forceShow = false
): Omit<BuyerDirect, "profile" | "maskOverride"> & { profile: Record<string, string> } {
  const { profile, maskOverride, ...rest } = b;
  // Layer 4 (E, anti-cheat): a once-blocked buyer's whole identity is force-shown to this desk — every present
  // profile field to `show`, overriding the dial + the floor. This is the ONE place masking is intentionally
  // inverted; it is desk-scoped (the caller passes forceShow only for THIS conversation's priorBlock).
  if (forceShow) {
    const shown: BuyerMask = {};
    for (const k of Object.keys(profile)) shown[k] = "show" as MaskMode;
    return { ...rest, profile: publicDirectProfileView(profile, shown) ?? {} };
  }
  // Layer 3 over layer 2: a consented field is forced to full `show` regardless of the buyer's dial default.
  const effective: BuyerMask = { ...(maskOverride ?? {}) };
  for (const f of grantedFields) effective[f] = "show" as MaskMode;
  return { ...rest, profile: publicDirectProfileView(profile, effective) ?? {} };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATES: BuyerFunnelState[] = ["new", "in_conversation", "units_opened", "offer_eligible"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  const to = typeof body.to === "string" ? (body.to.trim() as BuyerFunnelState) : ("" as BuyerFunnelState);
  const allowRegress = body.allowRegress === true;

  if (!caller || !account || !building || !STATES.includes(to)) {
    return NextResponse.json({ error: "caller + account + building + valid `to` required" }, { status: 400 });
  }

  // AUTHORIZE: the caller must be the building's desk developer (fail closed otherwise).
  const desk = await deskDeveloperFor(building);
  if (!desk || desk.toLowerCase() !== caller.toLowerCase()) {
    return NextResponse.json({ error: "not the desk for this building" }, { status: 403 });
  }

  const buyer = await advanceFunnel(account, to, { allowRegress });
  if (!buyer) return NextResponse.json({ error: "no such buyer" }, { status: 404 });
  // C-slice: fold in consented fields. E-slice: if this desk ever blocked this buyer, force-show.
  const convId = directConversationId(account, building);
  const granted = await grantedFieldsFor(convId);
  const forceShow = await priorBlockFor(convId);
  // kycPrecondition reads the FULL profile server-side (never shipped); the response buyer is MASKED.
  return NextResponse.json({ buyer: deskSafeBuyer(buyer, granted, forceShow), kycPrecondition: kycPrecondition(buyer) });
}

/** GET ?caller=&account=&building= — the desk reads a buyer's current funnel + KYC state (desk-scoped). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const caller = url.searchParams.get("caller")?.trim() || "";
  const account = url.searchParams.get("account")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  if (!caller || !account || !building) {
    return NextResponse.json({ error: "caller + account + building required" }, { status: 400 });
  }
  const desk = await deskDeveloperFor(building);
  if (!desk || desk.toLowerCase() !== caller.toLowerCase()) {
    return NextResponse.json({ error: "not the desk for this building" }, { status: 403 });
  }
  const buyer = await getBuyerDirect(account);
  if (!buyer) return NextResponse.json({ error: "no such buyer" }, { status: 404 });
  // The desk also wants the LIVE bar (incl. the balance half) so it can see what blocks an offer.
  const eligibility = await offerEligibility(account, desk);
  // C-slice: consented fields. E-slice: force-show if this desk ever blocked this buyer.
  const convId = directConversationId(account, building);
  const granted = await grantedFieldsFor(convId);
  const forceShow = await priorBlockFor(convId);
  // kycPrecondition/eligibility read the FULL profile server-side; the response buyer is MASKED.
  return NextResponse.json({ buyer: deskSafeBuyer(buyer, granted, forceShow), kycPrecondition: kycPrecondition(buyer), eligibility });
}
