// POST /api/offmarket — take a unit off-market (block/kill), or reverse it (unblock/unkill).
// OFF-CHAIN developer control surface. This mutates the off-chain catalog ONLY; it never
// touches the chain. The on-chain reservation remains the anti-fraud spine: before blocking/killing
// a unit we read its LIVE on-chain tile status server-side and REFUSE if a live hold/booking/sale exists —
// that must go through the recorded lawful cancellation door, not be hidden behind an off-chain flag.
// Body:
// { action: "block"|"kill", building, unit, reason, category, by, confirmedBy? }
// { action: "unblock"|"unkill", building, unit, by, newPriceUsd? }
// AUTH: demo-grade like the other portal write-throughs (gates/agents) — the developer label rides in
// `by`; there's no signature check because this state is display-only and the chain enforces the real
// reservation. Tighten (owner/developer-signed) alongside the pre-public-deploy rate-limit gate.
// PRIVACY: the reason/category/by are OFF-CHAIN catalog metadata; nothing here goes on-chain.

import { NextResponse } from "next/server";
import { getBuilding, saveBuilding } from "@/lib/catalog";
import { getUnitsStatusMerged } from "@/lib/status-cache";
import {
  applyOffMarket,
  reverseOffMarket,
  offMarketBlockedReason,
  defaultStateFor,
} from "@/lib/offmarket";
import type { BlockCategory, OffMarketState } from "@/lib/catalog-client";
import { requireEditable, classifyPriceChange, inventoryVerbFor, resolveNoticeParties } from "@/lib/catalog-edit-gate";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES: BlockCategory[] = [
  "executive-hold",
  "affiliate-hold",
  "external-party",
  "vip-hold",
  "phase-pricing",
  "company-shop",
  "regulatory",
  "other",
];

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const buildingId = String(body.building ?? "");
  const unitId = String(body.unit ?? "");
  const by = typeof body.by === "string" && body.by ? body.by : "developer";

  if (!buildingId || !unitId) {
    return NextResponse.json({ error: "building + unit required" }, { status: 400 });
  }

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });
  const unit = building.inventory.find((u) => u.id === unitId);
  if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });

  if (action === "block" || action === "kill") {
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const category = (CATEGORIES.includes(body.category) ? body.category : "other") as BlockCategory;
    const confirmedBy =
      typeof body.confirmedBy === "string" && body.confirmedBy.trim() ? body.confirmedBy.trim() : undefined;
    if (!reason) return NextResponse.json({ error: "a reason is required" }, { status: 400 });

    // ── Freeze gate: taking a unit off-market is the `offMarket` change class. On contract +
    // version-gated for this developer → refuse until an approved covering version exists. Pre-contract and
    // self-serve pass straight through. ──
    const gate = await requireEditable(by, buildingId, "offMarket");
    if (!gate.allowed) return NextResponse.json(gate.body, { status: gate.status });

    // ── anti-fraud guard: confirm the unit is NOT live on-chain before taking it off-market. ──
    // Read a FRESH-enough live status for just this one unit (cheap; served from cache/snapshot, falls
    // back to a single chain read). If it's held/booked/sold, refuse and point to cancellation.
    let onChainStatus: number | undefined;
    try {
      const { status } = await getUnitsStatusMerged(buildingId, [unitId]);
      onChainStatus = status[unitId];
    } catch {
      onChainStatus = undefined; // treated as "unconfirmed" → refused by the guard
    }
    const blocked = offMarketBlockedReason(onChainStatus);
    if (blocked) {
      return NextResponse.json(
        { error: blocked, code: "live_reservation", onChainStatus: onChainStatus ?? null },
        { status: 409 }
      );
    }

    // `kill` is explicit; `block` honours the category's natural state (regulatory → killed).
    const state: OffMarketState = action === "kill" ? "killed" : defaultStateFor(category);
    unit.offMarket = applyOffMarket(unit.offMarket, state, { reason, category, by, confirmedBy });
    await saveBuilding(building);
    await logActivity(inventoryVerbFor("offMarket"), by.toLowerCase(), { kind: "unit", id: buildingId }, await resolveNoticeParties(by, buildingId), { building: building.name });
    return NextResponse.json({ ok: true, offMarket: unit.offMarket });
  }

  if (action === "unblock" || action === "unkill") {
    if (!unit.offMarket) {
      return NextResponse.json({ error: "unit is not off-market" }, { status: 409 });
    }
    const newPriceUsd =
      typeof body.newPriceUsd === "number" && body.newPriceUsd > 0 ? Math.round(body.newPriceUsd) : undefined;

    // ── Freeze gate: releasing a unit back on market is the `withholdToggle` class. If the
    // release ALSO changes the price, that price move gates through the SAME direction classifier the price
    // tool uses — so a developer cannot raise a price via the release door while priceUp is version-gated.
    // Fail-closed: refuse the whole release if either the toggle OR the price raise is blocked. ──
    const releaseGate = await requireEditable(by, buildingId, "withholdToggle");
    if (!releaseGate.allowed) return NextResponse.json(releaseGate.body, { status: releaseGate.status });
    if (newPriceUsd !== undefined) {
      const priceClass = classifyPriceChange(unit.priceUsd, newPriceUsd);
      if (priceClass) {
        const priceGate = await requireEditable(by, buildingId, priceClass);
        if (!priceGate.allowed) return NextResponse.json(priceGate.body, { status: priceGate.status });
      }
    }

    const { history } = reverseOffMarket(unit.offMarket, by, newPriceUsd);
    // Clear the live off-market state (unit floats back to available) but PRESERVE the audit trail on the
    // unit so the story survives for a later decision ( — reversible WITH context). The completed
    // history (block → … → release) accumulates on offMarketHistory across episodes.
    unit.offMarketHistory = [...(unit.offMarketHistory ?? []), ...history];
    unit.offMarket = undefined;
    // reversal typically updates the price at the same time (release at the new, higher price).
    if (newPriceUsd) unit.priceUsd = newPriceUsd;
    await saveBuilding(building);
    await logActivity(inventoryVerbFor("withholdToggle"), by.toLowerCase(), { kind: "unit", id: buildingId }, await resolveNoticeParties(by, buildingId), { building: building.name });
    return NextResponse.json({ ok: true, released: true, history, priceUsd: unit.priceUsd });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
