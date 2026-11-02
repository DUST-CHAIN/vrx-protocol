// /api/direct-deposits — the MONEY half of the direct-sales firm-hold ( §9 step 9). The desk records a
// buyer's deposit (gated on LIVE offer-eligibility), attaches the on-chain firm-hold tx the developer signed,
// and releases it; the buyer reads their own deposits. Four shapes:
// POST { action:"record", caller, account, building, unit, unitKey, amountMinor, currency }
// — DESK records a deposit. caller == the building's desk developer. GATED: the buyer must be LIVE
// offer-eligible (profile ∧ kyc ∧ balance ≥ threshold, re-checked HERE — never the stale funnel
// label). Returns the deposit + the house org the firm-hold should be granted to.
// POST { action:"hold", caller, account, building, unit, holdTxHash, holdUntil }
// — DESK attaches the signed grant_exclusive tx to a recorded deposit (status → held). caller == desk.
// DELETE ?caller=&account=&building=&unit=
// — DESK releases the hold (deal fell through / early release). caller == desk.
// GET ?account=<buyer> — the BUYER reads their own deposits (hold status per unit).
// GET ?caller=&account=&building= — the DESK reads deposits it recorded for a buyer in a building.
// AUTH (this slice, same as the sibling direct routes): capability-based (caller names its account); the
// authorization that matters (caller == the building's desk developer) IS enforced via deskDeveloperFor. A
// view-only balance and records off-chain; the ONLY signed action (grant_exclusive) happens in the DESK's
// own wallet client-side — this route never holds a key, it only records the resulting tx hash.

import { NextResponse } from "next/server";
import {
  recordDeposit,
  attachHold,
  releaseDeposit,
  depositsForBuyer,
  depositsByDesk,
  getDeposit,
} from "@/lib/direct-deposits";
import { deskDeveloperFor, directConversationId, dealEpoch } from "@/lib/conversations-direct";
import { materializeDirectOffer } from "@/lib/direct-offer";
import { getDeveloper, houseOrgFor } from "@/lib/developers";
import { getBuilding } from "@/lib/catalog";
import { offerEligibility } from "@/lib/offer-eligibility";
import { publish } from "@/lib/bus";
import { grantTopic } from "@/lib/grant-topic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Authorize caller as the building's desk developer; returns the desk account or an error response. */
async function requireDesk(building: string, caller: string) {
  const desk = await deskDeveloperFor(building);
  if (!desk || desk.toLowerCase() !== caller.toLowerCase()) {
    return { error: NextResponse.json({ error: "not the desk for this building" }, { status: 403 }) };
  }
  return { desk };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  const caller = url.searchParams.get("caller")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  // DESK read: deposits this desk recorded for the buyer in a building.
  if (caller && building) {
    const auth = await requireDesk(building, caller);
    if (auth.error) return auth.error;
    const list = await depositsByDesk(caller, account);
    return NextResponse.json({ deposits: list.filter((d) => d.building === building) });
  }

  // BUYER read: all my deposits + their hold status.
  const list = await depositsForBuyer(account);
  return NextResponse.json({ deposits: list });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action.trim() : "record";
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  const unit = typeof body.unit === "string" ? body.unit.trim() : "";
  if (!caller || !account || !building || !unit) {
    return NextResponse.json({ error: "caller + account + building + unit required" }, { status: 400 });
  }
  const auth = await requireDesk(building, caller);
  if (auth.error) return auth.error;

  // ── action: hold — attach the signed grant_exclusive tx to an existing deposit ──
  if (action === "hold") {
    const holdTxHash = typeof body.holdTxHash === "string" ? body.holdTxHash.trim() : "";
    const holdUntil = Number(body.holdUntil);
    if (!holdTxHash || !Number.isFinite(holdUntil) || holdUntil <= 0) {
      return NextResponse.json({ error: "holdTxHash + holdUntil required" }, { status: 400 });
    }
    const dep = await attachHold(account, building, unit, holdTxHash, holdUntil);
    if (!dep) return NextResponse.json({ error: "no deposit to hold (record one first)" }, { status: 404 });
    // Real-time push: nudge the buyer's opened-units list so "✓ Reserved for you" appears live.
    publish(grantTopic(account));
    return NextResponse.json({ deposit: dep });
  }

  // ── action: materialize — "open the paperwork". The EXPLICIT desk action that turns a
  // serious direct deal into a tailorable Offer so the whole /api/offers/* + S&P path applies verbatim.
  // The firm-hold is the EARLIEST-ALLOWED moment, not a forced one (design §2): we require a HELD deposit
  // for (buyer, building, unit) before materializing — the unit must actually be off the market for this
  // buyer. The offer is keyed by (conversationId, epoch) so the B–F lifecycle can void it. Idempotent. ──
  if (action === "materialize") {
    const dep = await getDeposit(account, building, unit);
    if (!dep || dep.status !== "held") {
      return NextResponse.json(
        { error: "firm-hold the unit first — the paperwork opens only once the unit is held for this buyer" },
        { status: 409 }
      );
    }
    const conversationId = directConversationId(account, building);
    // unknown/absent value falls through to the bare price-only plan (back-compatible with slices 1–3). The
    // deposit line is seeded from the deposit the desk actually took (minor → whole USD).
    const TEMPLATES = ["off_plan_standard", "deposit_then_transfer", "full_on_transfer", "refundable_deposit"] as const;
    const template = TEMPLATES.includes(body.template) ? (body.template as (typeof TEMPLATES)[number]) : undefined;
    const instalments = Number.isFinite(Number(body.instalments)) ? Math.max(0, Math.round(Number(body.instalments))) : 0;
    // depositUsd is the plan's deposit LINE, in USD — passed explicitly by the desk (the stored deposit is in
    // the buyer's currency, e.g. THB, so we do NOT derive the USD plan figure from it; that would mix units).
    // Absent → 0 (the whole price falls on transfer; the desk can tune the deposit in the plan editor).
    const depositUsd = Number.isFinite(Number(body.depositUsd)) ? Math.max(0, Math.round(Number(body.depositUsd))) : 0;
    const res = await materializeDirectOffer({ conversationId, buyer: account, building, unit, by: caller, template, instalments, depositUsd });
    if (!res.ok) return NextResponse.json({ error: `could not open the paperwork (${res.reason})` }, { status: 409 });
    const epoch = await dealEpoch(conversationId);
    return NextResponse.json({ offer: { requestId: res.offer.requestId, origin: res.offer.display.origin }, conversationId, epoch, created: res.created });
  }

  // ── action: record — the deposit itself, GATED on LIVE eligibility ──
  const unitKey = typeof body.unitKey === "string" ? body.unitKey.trim() : "";
  const amountMinor = Number(body.amountMinor);
  const currency = typeof body.currency === "string" ? body.currency.trim() : "";
  if (!unitKey || !currency) {
    return NextResponse.json({ error: "unitKey + currency required" }, { status: 400 });
  }
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return NextResponse.json({ error: "amountMinor must be a positive integer (minor units)" }, { status: 400 });
  }

  // The unit must exist in the building (don't record a deposit against a phantom unit).
  const bld = await getBuilding(building);
  if (!bld || !bld.inventory.some((u) => u.id === unit)) {
    return NextResponse.json({ error: "no such unit in this building" }, { status: 404 });
  }

  // THE LOCK ( §9 step 5): no deposit before the buyer clears the LIVE bar. Re-checked here, not the
  // funnel label — a buyer whose balance later dropped below the bar can't deposit even if marked eligible.
  const dev = await getDeveloper(caller);
  const elig = await offerEligibility(account, dev);
  if (!elig.eligible) {
    return NextResponse.json(
      { error: "buyer is not offer-eligible", reasons: elig.reasons, thresholdUsd: elig.thresholdUsd, balanceUsd: elig.balanceUsd },
      { status: 409 }
    );
  }

  // The house org must be set up (the firm-hold is granted to it). Fail closed if the desk hasn't registered one.
  const houseOrg = houseOrgFor(dev);
  if (!houseOrg) {
    return NextResponse.json(
      { error: "desk has no house org yet — register + gate one on-chain before firm-holding" },
      { status: 409 }
    );
  }

  const deposit = await recordDeposit({ buyer: account, building, unit, unitKey, by: caller, amountMinor, currency });
  if (!deposit) return NextResponse.json({ error: "could not record deposit" }, { status: 400 });

  // Return the house org so the client can immediately build the grant_exclusive(unit_key, houseOrg, window).
  return NextResponse.json({ deposit, houseOrg });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const caller = url.searchParams.get("caller")?.trim() || "";
  const account = url.searchParams.get("account")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  const unit = url.searchParams.get("unit")?.trim() || "";
  if (!caller || !account || !building || !unit) {
    return NextResponse.json({ error: "caller + account + building + unit required" }, { status: 400 });
  }
  const auth = await requireDesk(building, caller);
  if (auth.error) return auth.error;
  const released = await releaseDeposit(account, building, unit);
  // Real-time push: nudge the buyer's list so a released hold clears "✓ Reserved for you" live.
  if (released) publish(grantTopic(account));
  return NextResponse.json({ released });
}
