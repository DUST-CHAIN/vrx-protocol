// DIRECT-BUYER record API (§9 step 1). The buyer's own wallet-connect login saves/reads its own
// direct-sales profile. SERVER-ONLY store (lib/buyers-direct) — plaintext PII off-chain, nothing
// signed, nothing on-chain (-safe: the deposit rail that signing needs is step 9, deferred).
//
// AUTH model (this slice): the caller passes its connected wallet `account` (lib/wallet.tsx accountId).
// There is no signed-session proof yet — same capability-based trust as the agency self-apply route
// (app/api/applications/.../apply): submitting records intent; a challenge-sign binding account→caller is
// a later hardening (tracked as the direct-buyer analogue of the apply open-Q). A buyer can only ever
// read/write the record for the account it names — there is no cross-account read here.

import { NextResponse } from "next/server";
import {
  getBuyerDirect,
  saveBuyerProfile,
  sealProfile,
  reopenProfile,
  setMaskOverride,
  kycPrecondition,
  readinessAcross,
  type BuyerDirect,
} from "@/lib/buyers-direct";
import { grantsForBuyer } from "@/lib/unit-grants";
import { deskDeveloperFor } from "@/lib/conversations-direct";
import { getDeveloper } from "@/lib/developers";
import { publish } from "@/lib/bus";
import { grantTopic } from "@/lib/grant-topic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A buyer record projected for the wire. WHITELISTED (not a `...rest` spread) so the seal SECRET never
 * leaves the server: the security of the attestation rests on the per-record `salt` being secret
 *  (and `sealHash` is derived from it) — neither may reach the browser, or a client could forge/verify seals
 *  offline. Also drops the transient `pendingBaseline` and returns a history COUNT instead of the full trail
 *  bodies (the trail is desk/audit-facing — its contents aren't buyer-page data). */
function projectBuyer(buyer: Awaited<ReturnType<typeof getBuyerDirect>>) {
  if (!buyer) return null;
  return {
    account: buyer.account,
    profile: buyer.profile,
    // the buyer's OWN visibility dial — safe on a SELF read (it's the buyer's own preference), drives the
    // dial UI. NEVER shipped on the desk-facing route (deskSafeBuyer strips it). Absent = fully-masked default.
    maskOverride: buyer.maskOverride ?? {},
    funnel: buyer.funnel,
    referredBy: buyer.referredBy,
    profileSaved: buyer.profileSaved,
    sealed: !!buyer.sealed,
    sealedAt: buyer.sealedAt,
    historyCount: buyer.history?.length ?? 0,
  };
}

/**
 * Per-developer verification readiness for the nudge banner (Phase 2). The developers IN SCOPE are the
 * distinct desk developers of the buildings whose units have been OPENED to this buyer — i.e. the only
 * developers the buyer can actually make an offer to. A buyer with NO opened units has an EMPTY scope, so
 * `perDev` is [] and `allMet` is vacuously true → the UI shows no nudge (never gate a fresh walk-in before
 * the desk has engaged them — browsing must stay friction-free).
 */
async function readinessSummary(buyer: BuyerDirect | null, account: string) {
  const grants = await grantsForBuyer(account);
  const buildings = [...new Set(grants.map((g) => g.building))];
  // Resolve each opened building to its desk developer, then dedupe by developer account.
  const devByAccount = new Map<string, { account: string; name: string; requiredProfileFields?: string[] }>();
  for (const b of buildings) {
    const acct = await deskDeveloperFor(b);
    if (!acct || devByAccount.has(acct.toLowerCase())) continue;
    const dev = await getDeveloper(acct);
    if (dev) devByAccount.set(acct.toLowerCase(), { account: dev.account, name: dev.name, requiredProfileFields: dev.requiredProfileFields });
  }
  return readinessAcross(buyer, [...devByAccount.values()]);
}

/** GET /api/buyers-direct?account=<id> — the buyer's own record (or { buyer: null } if none yet), plus the
 *  per-developer readiness summary across the buyer's opened developers (for the nudge banner). */
export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account") ?? "";
  if (!account.trim()) {
    return NextResponse.json({ error: "account required" }, { status: 400 });
  }
  const buyer = await getBuyerDirect(account);
  const readiness = await readinessSummary(buyer, account);
  return NextResponse.json({
    buyer: projectBuyer(buyer),
    kycPrecondition: kycPrecondition(buyer),
    readiness,
  });
}

/** POST /api/buyers-direct
 *   { account, profile }              → create/update the profile (funnel stays "new"). Refused 409 if SEALED.
 *   { account, action:"seal" }        → lock the current profile (attest it). Idempotent.
 *   { account, action:"reopen" }      → unlock a sealed profile for editing (trail captured on next seal).
 * { account, action:"visibility", → set the buyer's visibility dial: which profile fields a desk sees
 *     override: { field: mode } }        up-front. Self-only; a view preference, NOT a re-seal (see setMaskOverride).
 *  A sealed profile never changes silently — the lock is enforced here (not just the UI). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account : "";
  if (!account.trim()) {
    return NextResponse.json({ error: "account required" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "seal") {
    const buyer = await sealProfile(account);
    if (!buyer) return NextResponse.json({ error: "no saved profile to seal" }, { status: 404 });
    publish(grantTopic(account)); // push the new locked state to the buyer's open view
    return NextResponse.json({ buyer: projectBuyer(buyer), kycPrecondition: kycPrecondition(buyer) });
  }

  if (action === "reopen") {
    const res = await reopenProfile(account);
    if (res === null) return NextResponse.json({ error: "no profile to re-open" }, { status: 404 });
    if (res === "not_sealed") {
      return NextResponse.json({ error: "profile isn't sealed" }, { status: 409 });
    }
    publish(grantTopic(account));
    return NextResponse.json({ buyer: projectBuyer(res), kycPrecondition: kycPrecondition(res) });
  }

  if (action === "visibility") {
    // The buyer sets their OWN visibility dial. Note: setMaskOverride does NOT re-seal the profile — it's
    // a view preference, so a sealed buyer can still change what a desk sees without re-opening their identity.
    const buyer = await setMaskOverride(account, body.override);
    if (!buyer) return NextResponse.json({ error: "no saved profile to set visibility on" }, { status: 404 });
    publish(grantTopic(account)); // push the new dial state to the buyer's open view
    return NextResponse.json({ buyer: projectBuyer(buyer), kycPrecondition: kycPrecondition(buyer) });
  }

  // Default: a plain save.
  const buyer = await saveBuyerProfile(account, body.profile);
  if (buyer === "sealed") {
    return NextResponse.json(
      { error: "This profile is sealed. Re-open it to make changes (your edits are recorded)." },
      { status: 409 },
    );
  }
  if (!buyer) {
    return NextResponse.json({ error: "profile invalid (name required)" }, { status: 400 });
  }
  publish(grantTopic(account));
  return NextResponse.json({ buyer: projectBuyer(buyer), kycPrecondition: kycPrecondition(buyer) });
}
