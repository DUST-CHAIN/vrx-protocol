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
  type UnitGrant,
} from "@/lib/unit-grants";
import {
  advanceFunnel,
  funnelRank,
  getBuyerDirect,
  readinessFor,
  type BuyerDirectProfile,
} from "@/lib/buyers-direct";
import { deskDeveloperFor } from "@/lib/conversations-direct";
import { getDeveloper } from "@/lib/developers";
import { getBuilding, type Unit } from "@/lib/catalog";
import { heroImage, listImages } from "@/lib/mm";
import { offerEligibility } from "@/lib/offer-eligibility";
import { getBuildingSnapshot } from "@/lib/status-store";
import { publish } from "@/lib/bus";
import { grantTopic } from "@/lib/grant-topic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── The buyer-side projection of an opened unit. LOSSY until the buyer is offer-eligible. ──────────────
type OpenedUnitView = {
  building: string;
  buildingName: string;
  unit: string;
  /** Always shown once a unit is opened (specs the desk deliberately revealed). */
  specs: { label: string; type: string; floor: number; sqm: number; view?: string; baths?: number; corner?: boolean };
  /** FULL detail — present ONLY when the buyer is offer-eligible (two-stage reveal, §9 answer). */
  detail: { priceUsd: number; floorplan?: string; note?: string } | null;
  /** Building HERO image (exterior) — ALWAYS present once a unit is opened. Privacy-safe (same marketing
   *  shot the browse cards use; reveals nothing unit-specific), so it shows pre-eligibility too. Null if
 * the building has no renderings at all. (F4.) */
  photo: string | null;
  /** Unit-SPECIFIC imagery — present ONLY when offer-eligible (two-stage reveal). Today that is the
   *  unit-TYPE floorplan (deliberately withheld until eligible); kept as an ARRAY so per-unit photos can
 * flow through later without a reshape. Empty until eligible / if the type has no floorplan. (F4.) */
  unitPhotos: string[];
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
  const caller = url.searchParams.get("caller")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  // ── DESK read: which units has this desk opened to the buyer in a building? (caller + building present) ──
  if (caller && building) {
    const desk = await deskDeveloperFor(building);
    if (!desk || desk.toLowerCase() !== caller.toLowerCase()) {
      return NextResponse.json({ error: "not the desk for this building" }, { status: 403 });
    }
    const grants = await grantsForBuyerBuilding(account, building);
    return NextResponse.json({ units: grants.map((g) => ({ unit: g.unit, at: g.at })) });
  }

  // ── BUYER read: all units opened to me, joined + lossy-until-eligible. (account only) ──
  const grants = await grantsForBuyer(account);
  const views: OpenedUnitView[] = [];
  // Read the buyer's own record ONCE — readiness (per-developer) is a pure check against it (no per-grant IO).
  const buyer = await getBuyerDirect(account);
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
    const elig = await offerEligibility(account, dev);
    const r = readinessFor(buyer, dev?.requiredProfileFields);
    const typeLabel = bld.unitTypes.find((t) => t.key === unit.type)?.label ?? unit.type;
    // Building hero (exterior) — always safe to show; same helper every card surface uses (mm.heroImage).
    const photo = await heroImage(g.building);
    // Unit-specific imagery is a two-stage reveal: nothing until the buyer is offer-eligible, then the
    // unit-TYPE floorplan (matched by filename to its full /renderings URL). Array so per-unit photos slot in later.
    let unitPhotos: string[] = [];
    if (elig.eligible) {
      const fpFile = bld.unitTypes.find((t) => t.key === unit.type)?.floorplan;
      if (fpFile) {
        const imgs = await listImages(g.building);
        const url = imgs?.floorplans.find((u) => u.endsWith(`/${fpFile}`)) ?? null;
        if (url) unitPhotos = [url];
      }
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
          }
        : null,
      photo,
      unitPhotos,
      developerName: dev?.name ?? "the developer",
      readiness: { met: r.met, missing: r.missing, sealed },
      at: g.at,
    });
  }
  return NextResponse.json({ units: views });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  const unit = typeof body.unit === "string" ? body.unit.trim() : "";
  if (!caller || !account || !building || !unit) {
    return NextResponse.json({ error: "caller + account + building + unit required" }, { status: 400 });
  }

  // AUTHORIZE: caller must be the building's desk developer.
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
  const caller = url.searchParams.get("caller")?.trim() || "";
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
