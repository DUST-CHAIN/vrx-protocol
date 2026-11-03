// /api/unit-grants — the desk OPENS/CLOSES specific units to a direct buyer (§9 3b–5), and the buyer
// READS the units opened to them. Two actors, two shapes:
//
//   POST   { caller, account, building, unit }  — DESK opens a unit to a buyer. caller must be the building's
//                                                 desk developer. AUTO-ADVANCES the buyer to units_opened
//                                                 (monotonic — never regresses someone further along).
//   DELETE ?caller=&account=&building=&unit=     — DESK closes a previously-opened unit. caller == desk dev.
//   GET    ?account=<buyer>                      — the BUYER reads units opened to them, joined to catalog
//  detail, LOSSY UNTIL OFFER-ELIGIBLE (§9 answer): specs
//                                                 only until the buyer clears the bar; full price/floorplan/
//                                                 terms once eligible.
//   GET    ?caller=&account=&building=           — the DESK reads which units it has opened to a buyer in a
//                                                 building (desk-scoped; full ids, no buyer PII).
//
// WHY the buyer GET bypasses directSale.visible: a grant is a deliberate operator offer (§8-3) — the buyer
// sees a granted unit even in a building that isn't in the public browse funnel. The grant store is the
// access decision; this route resolves the unit from the FULL catalog, scoped to the grant.
//
// AUTH (this slice): capability-based (caller names its account); the authorization that matters (caller ==
// the building's desk developer) IS enforced via deskDeveloperFor. A buyer can only read grants for the
// account it names. -safe: reads accounts + a view-only balance (for eligibility), signs nothing.

import { NextResponse } from "next/server";
import {
  grantUnit,
  revokeUnit,
  grantsForBuyer,
  grantsForBuyerBuilding,
  isUnitGranted,
  type UnitGrant,
} from "@/lib/unit-grants";
import {
  advanceFunnel,
  funnelRank,
  getBuyerDirect,
  readinessFor,
  type BuyerDirectProfile,
} from "@/lib/buyers-direct";
import { deskDeveloperFor, resolveDirectConversation } from "@/lib/conversations-direct";
import { postSystemNotice } from "@/lib/channels";
import { getDeveloper } from "@/lib/developers";
import { getBuilding, effectiveTerms, type Unit } from "@/lib/catalog";
import type { PaymentTerms } from "@/lib/catalog-client";
import { unitHeroImage, listImages, unitGallery } from "@/lib/mm";
import { offerEligibility } from "@/lib/offer-eligibility";
import { getBuildingSnapshot } from "@/lib/status-store";
import { publish } from "@/lib/bus";
import { grantTopic } from "@/lib/grant-topic";
import { requireCaller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AUTH: the acting identity (desk `caller` / buyer `account`) was taken from the client and used for
// scoping — so a buyer could read another buyer's opened units (+ eligible-gated prices) by naming them, and
// the desk `caller` ownership check trusted a claimed id. Each verb binds its acting identity to requireCaller:
// POST/DELETE bind `caller` (the desk), GET binds `caller` (desk branch) or `account` (buyer branch), PATCH
// binds `account` (the buyer). deskDeveloperFor + isUnitGranted then run on a PROVEN identity.

// ── The buyer-side projection of an opened unit. LOSSY until the buyer is offer-eligible. ──────────────
type OpenedUnitView = {
  building: string;
  buildingName: string;
  unit: string;
  /** Always shown once a unit is opened (specs the desk deliberately revealed). */
  specs: { label: string; type: string; floor: number; sqm: number; view?: string; baths?: number; corner?: boolean };
  /** FULL detail — present ONLY when the buyer is offer-eligible (two-stage reveal, §9 answer). `terms`
 * carries the developer's payment caps so the buyer can COMPOSE their offer with the A4 calculator
   *  in the review overlay (sliders bound to the dev's ranges); null terms → the overlay falls back to the
   *  indicative preview. Revealed only with the price (same eligibility gate — caps are a commercial term). */
  detail: { priceUsd: number; floorplan?: string; note?: string; terms?: PaymentTerms } | null;
  /** Building HERO image (exterior) — ALWAYS present once a unit is opened. Privacy-safe (same marketing
   *  shot the browse cards use; reveals nothing unit-specific), so it shows pre-eligibility too. Null if
 * the building has no renderings at all. (F4.) */
  photo: string | null;
  /** Unit-SPECIFIC imagery — present ONLY when offer-eligible (two-stage reveal). Today that is the
   *  unit-TYPE floorplan (deliberately withheld until eligible); kept as an ARRAY so per-unit photos can
 * flow through later without a reshape. Empty until eligible / if the type has no floorplan. (F4.) */
  unitPhotos: string[];
  /** the ORDERED image gallery applicable to this unit's SUBTYPE (building exterior → facilities →
   *  representative interiors → the subtype floorplan), per the IMAGE_SETS schema in lib/mm. Drives the review
   *  overlay's carousel. Privacy-safe by construction (no other-unit art); present only when offer-eligible
   *  (same detail-reveal gate as unitPhotos). Empty until eligible / if the building has no renderings. */
  gallery: string[];
  /** The desk developer's display name (demo label) — for the per-card "requires X for {dev}" copy. */
  developerName: string;
  /** Per-developer verification readiness of the buyer's profile against THIS card's desk developer
 * (Phase 2): `met` = the developer's required fields are all filled; `missing` = the field KEYS
   *  still needed (the client labels them); `sealed` = the buyer's single seal state. The red-border cue
   *  fires when `!met || !sealed`. Readiness is per-developer, so two cards can differ for the same buyer. */
  readiness: { met: boolean; missing: Array<keyof BuyerDirectProfile>; sealed: boolean };
  at: number;
};

/** Resolve a grant → its catalog Unit (from the FULL catalog, bypassing directSale.visible per §8-3). */
async function unitOfGrant(g: UnitGrant): Promise<{ bld: Awaited<ReturnType<typeof getBuilding>>; unit: Unit | null }> {
  const bld = await getBuilding(g.building);
  const unit = bld?.inventory.find((u) => u.id === g.unit) ?? null;
  return { bld, unit };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  const callerParam = url.searchParams.get("caller")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  // ── DESK read: which units has this desk opened to the buyer in a building? (caller + building present) ──
  if (callerParam && building) {
    const whoDesk = requireCaller(req, { param: callerParam });
    if (!whoDesk.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
    const desk = await deskDeveloperFor(building);
    if (!desk || desk.toLowerCase() !== whoDesk.account.toLowerCase()) {
      return NextResponse.json({ error: "not the desk for this building" }, { status: 403 });
    }
    const grants = await grantsForBuyerBuilding(account, building);
    return NextResponse.json({ units: grants.map((g) => ({ unit: g.unit, at: g.at })) });
  }

  // ── BUYER read: all units opened to me, joined + lossy-until-eligible. (account only) ── bind `account` to
  // the proven caller so a buyer can only read THEIR OWN opened units (+ eligible-gated prices).
  const whoBuyer = requireCaller(req, { param: account });
  if (!whoBuyer.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const buyerAccount = whoBuyer.account;
  const grants = await grantsForBuyer(buyerAccount);
  const views: OpenedUnitView[] = [];
  // Read the buyer's own record ONCE — readiness (per-developer) is a pure check against it (no per-grant IO).
  const buyer = await getBuyerDirect(buyerAccount);
  const sealed = !!buyer?.sealed;
  // Cache desk-developer lookups per building so repeated grants in the same building don't re-read the registry.
  const deskCache = new Map<string, Awaited<ReturnType<typeof getDeveloper>>>();
  const deskFor = async (building: string) => {
    if (deskCache.has(building)) return deskCache.get(building)!;
    const acct = await deskDeveloperFor(building);
    const dev = acct ? await getDeveloper(acct) : null;
    deskCache.set(building, dev);
    return dev;
  };

  for (const g of grants) {
    const { bld, unit } = await unitOfGrant(g);
    if (!bld || !unit) continue; // the unit/building vanished → drop (fail closed)

    // Eligibility is per-developer; scope it to THIS granted building's desk developer (the threshold owner).
    const dev = await deskFor(g.building);
    const elig = await offerEligibility(buyerAccount, dev);
    const r = readinessFor(buyer, dev?.requiredProfileFields);
    const typeLabel = bld.unitTypes.find((t) => t.key === unit.type)?.label ?? unit.type;
    // : lead an opened-unit card with a unit-RELEVANT interior shot (deterministic per unit) rather
    // than the repeated building exterior, so two units in the same building don't look identical. Privacy-safe
    // (generic interior, nothing unit-specific); falls back to the exterior hero if the building has no interiors.
    const photo = await unitHeroImage(g.building, unit.id);
    // Unit-specific imagery is a two-stage reveal: nothing until the buyer is offer-eligible, then the
    // unit-TYPE floorplan (matched by filename to its full /renderings URL). Array so per-unit photos slot in later.
    let unitPhotos: string[] = [];
    // the full subtype gallery for the review-overlay carousel (exterior → facilities → interiors →
    // subtype floorplan), via the IMAGE_SETS schema. Eligible-gated like unitPhotos (a detail reveal).
    let gallery: string[] = [];
    if (elig.eligible) {
      const fpFile = bld.unitTypes.find((t) => t.key === unit.type)?.floorplan;
      if (fpFile) {
        const imgs = await listImages(g.building);
        const url = imgs?.floorplans.find((u) => u.endsWith(`/${fpFile}`)) ?? null;
        if (url) unitPhotos = [url];
      }
      gallery = await unitGallery(g.building, fpFile);
    }
    views.push({
      building: g.building,
      buildingName: bld.name,
      unit: unit.id,
      specs: {
        label: typeLabel,
        type: unit.type,
        floor: unit.floor,
        sqm: unit.sqm,
        view: unit.view,
        baths: unit.baths,
        corner: unit.corner,
      },
      detail: elig.eligible
        ? {
            priceUsd: unit.priceUsd,
            floorplan: bld.unitTypes.find((t) => t.key === unit.type)?.floorplan,
            note: unit.note,
            // the developer's payment caps (fallback-filled) so the review overlay's A4 calculator binds
            // its sliders to the real allowed ranges. `undefined` (no building/unit terms) → overlay falls back
            // to the static indicative plan. Uses the SERVER catalog `effectiveTerms` (now fills the off-plan
            // caps itself) — NOT the client `withFallbackCaps`, which is a "use client" module the server route
            // can't call at runtime (that was the live 500: "withFallbackCaps is on the client").
            terms: effectiveTerms(bld, unit) ?? undefined,
          }
        : null,
      photo,
      unitPhotos,
      gallery,
      developerName: dev?.name ?? "the developer",
      readiness: { met: r.met, missing: r.missing, sealed },
      at: g.at,
    });
  }
  return NextResponse.json({ units: views });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  // AUTH: bind the desk `caller` to the proven session before the deskDeveloperFor ownership check.
  const who = requireCaller(req, { param: typeof body.caller === "string" ? body.caller.trim() : "" });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const caller = who.account;
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  const unit = typeof body.unit === "string" ? body.unit.trim() : "";
  if (!caller || !account || !building || !unit) {
    return NextResponse.json({ error: "caller + account + building + unit required" }, { status: 400 });
  }

  // AUTHORIZE: caller (proven) must be the building's desk developer.
  const desk = await deskDeveloperFor(building);
  if (!desk || desk.toLowerCase() !== caller.toLowerCase()) {
    return NextResponse.json({ error: "not the desk for this building" }, { status: 403 });
  }
  // The unit must actually exist in that building (don't grant a phantom).
  const bld = await getBuilding(building);
  if (!bld || !bld.inventory.some((u) => u.id === unit)) {
    return NextResponse.json({ error: "no such unit in this building" }, { status: 404 });
  }

  // AVAILABILITY GATE: the desk may only OPEN a unit that is published AND currently available
  // (tile status 0 = open). Opening a unit reveals its specs to the buyer — so an unpublished unit
  // (-1, not listed by the developer) must stay hidden, and a held/closed/sold unit (1/2/3) must not
  // be offered as if it were available. We read the SNAPSHOT (our authoritative base, no RPC);
  // the firm-hold step later re-checks LIVE via getTile before any on-chain reservation. A unit the
  // snapshot doesn't know yet (absent) is treated as not-available (fail-closed).
  const snap = await getBuildingSnapshot(building);
  const status = snap?.units?.[unit];
  if (status !== 0) {
    return NextResponse.json(
      { error: "This unit isn't available to open to a buyer right now (it's unpublished, held, closed or sold)." },
      { status: 409 },
    );
  }

  const grant = await grantUnit(account, building, unit, caller);
  if (!grant) return NextResponse.json({ error: "could not open unit" }, { status: 400 });

  // Opening a unit IS a funnel event → auto-advance to units_opened (monotonic, won't regress someone at
  // offer_eligible). Only if the buyer has a record (they must, to have talked to the desk).
  const buyer = await getBuyerDirect(account);
  if (buyer && funnelRank(buyer.funnel) < funnelRank("units_opened")) {
    await advanceFunnel(account, "units_opened");
  }
  // Real-time push: nudge the buyer's "units opened to you" list so a freshly-opened unit appears
  // without a reload. Opaque per-buyer topic — reveals no account to other SSE listeners (grant-topic.ts).
  publish(grantTopic(account));
  return NextResponse.json({ grant });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  // AUTH: bind the desk `caller` to the proven session before the deskDeveloperFor ownership check.
  const who = requireCaller(req, { param: url.searchParams.get("caller")?.trim() || "" });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const caller = who.account;
  const account = url.searchParams.get("account")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  const unit = url.searchParams.get("unit")?.trim() || "";
  if (!caller || !account || !building || !unit) {
    return NextResponse.json({ error: "caller + account + building + unit required" }, { status: 400 });
  }
  const desk = await deskDeveloperFor(building);
  if (!desk || desk.toLowerCase() !== caller.toLowerCase()) {
    return NextResponse.json({ error: "not the desk for this building" }, { status: 403 });
  }
  const removed = await revokeUnit(account, building, unit);
  // Real-time push: nudge the buyer's list so a closed unit disappears without a reload.
  if (removed) publish(grantTopic(account));
  return NextResponse.json({ removed });
}

// PATCH { account, building, unit } — the BUYER dismisses a unit opened to them ("not interested"). This is the
// mirror of the desk-only DELETE above: DELETE is the DESK closing a unit; PATCH is the BUYER declining one.
// Auth is the opposite direction — the buyer names ONLY their OWN account and may release ONLY their own grant
// (capability-based: isUnitGranted is the fail-closed check that this grant is actually theirs). Dismissing:
//   (1) posts a `vrx` system notice into the buyer↔desk thread so the operator SEES the buyer passed (reuses
//       the existing channel — no new store); the desk keeps its record of the decline in the conversation.
//   (2) revokes the grant so the buyer's "Units opened to you" list stays meaningful (the unit frees up).
// The buyer's funnel state is NOT rolled back (opening the unit was a real event; declining it doesn't un-happen
// it — same soft-delete semantics as revokeUnit). SSE push refreshes the list so the card disappears live.
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  // AUTH: bind the buyer `account` to the proven session — a buyer may only dismiss/withdraw their OWN
  // grant (isUnitGranted then runs on the proven identity).
  const who = requireCaller(req, { param: typeof body.account === "string" ? body.account.trim() : "" });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const account = who.account;
  const building = typeof body.building === "string" ? body.building.trim() : "";
  const unit = typeof body.unit === "string" ? body.unit.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!account || !building || !unit) {
    return NextResponse.json({ error: "account + building + unit required" }, { status: 400 });
  }
  //  (Step 6): "request-withdraw" is the PAID-buyer twin of "dismiss". Once a deposit is paid the deal is
  // binding, so a casual dismiss that silently releases the grant is wrong (the buyer paid; money reversal is a
  // real refund decision for the desk). This action does NOT revoke the grant or move money — it only posts a
  // withdraw REQUEST notice into the desk thread so the desk can handle the refund/cancellation explicitly.
  if (action !== "dismiss" && action !== "request-withdraw") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  // FAIL-CLOSED: the buyer may only act on a unit that is actually granted to THEM. A request for someone
  // else's grant (or a phantom) is a no-op 404 — never reveals whether another buyer holds that grant.
  if (!(await isUnitGranted(account, building, unit))) {
    return NextResponse.json({ error: "no such grant for this buyer" }, { status: 404 });
  }

  const bld = await getBuilding(building);
  // The unit id (e.g. "unit-321") is already self-labelling, so DON'T prefix the message with another "unit "
  // (that produced "unit unit-321" — nit, fixed). Strip a leading "unit-"/"unit " so the sentence
  // reads "passed on unit 321" regardless of whether a future id carries the prefix or not.
  const rawId = bld?.inventory.find((u) => u.id === unit)?.id ?? unit;
  const unitLabel = rawId.replace(/^unit[-\s]*/i, "");

  // ── request-withdraw: notify only (no grant release, no refund). The desk follows up on the money. ──
  if (action === "request-withdraw") {
    try {
      const conv = await resolveDirectConversation(account, building, true);
      if (conv) {
        await postSystemNotice({
          requestId: conv.id,
          text: `The buyer has requested to WITHDRAW from their purchase of unit ${unitLabel} after paying the deposit. Please follow up on the refund / cancellation.`,
          context: { kind: "direct", id: conv.id },
        });
      }
    } catch {
      /* notice is best-effort */
    }
    return NextResponse.json({ requested: true });
  }

  // Notify the desk inline (best-effort — a notice failure must not block the dismiss). The thread already
  // exists (the buyer talked to the desk to get here); ensure:true is cheap insurance.
  try {
    const conv = await resolveDirectConversation(account, building, true);
    if (conv) {
      await postSystemNotice({
        requestId: conv.id,
        text: `The buyer passed on unit ${unitLabel} — it has been removed from the units opened to them.`,
        context: { kind: "direct", id: conv.id },
      });
    }
  } catch {
    /* notice is best-effort; the dismiss itself is the authoritative action */
  }

  const removed = await revokeUnit(account, building, unit);
  if (removed) publish(grantTopic(account));
  return NextResponse.json({ dismissed: removed });
}
