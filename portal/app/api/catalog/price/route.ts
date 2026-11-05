// POST /api/catalog/price — the developer PRICE TOOL. Change one unit, a few, a whole
// floor, or the whole building — by an absolute price, a percent (+3%), or a flat +/- delta.
//
//   POST { building, by, scope, op }
//     scope = { units:[...] } | { floor:N } | { all:true }
//     op    = { set:n } | { pct:±x } | { delta:±n }
//
// The stored price is EXACT — never force-rounded (invoices/settlement need the fractions). A
// developer's display rounding is a SEPARATE, display-only choice (not applied here).
//
// ── Freeze gate ──────────────────────────────────────────────────────────────────────────────
// Each affected unit's price move is classified by DIRECTION: higher → priceUp (version-gated by default),
// lower → priceDown (self-serve). A BATCH that raises ANY unit is a priceUp batch — the whole batch gates on
// ONE version (: "raise the 10th floor" = one reviewable act). Fail-closed: if the batch class is
// version-gated for this developer and no APPROVED covering version is open, the route 409-refuses the WHOLE
// batch (nothing is written). Self-serve (price-down) passes straight through and emits a change notice.
//
// Pre-sign-off (no baseline) there is nothing to gate — any price change applies (the lifecycle only freezes
// AFTER go-on-contract). On apply, a single `inventory.repriced` notice is emitted carrying only the building
// + unit COUNT + direction — never a price.
//
// AUTH posture matches the rest of the off-chain demo layer (the developer rides in `by`; the real signed-
// request binding is the deferred signing arc, F1). Server-validated so a malformed payload can't corrupt the
// store.

import { NextResponse } from "next/server";
import { getBuilding, saveBuilding } from "@/lib/catalog";
import {
  resolvePriceTargets,
  batchPriceClass,
  requireEditable,
  requireRemark,
  inventoryVerbFor,
  resolveNoticeParties,
  type PriceScope,
  type PriceOp,
} from "@/lib/catalog-edit-gate";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validate the scope shape (exactly one of units/floor/all). */
function parseScope(raw: unknown): PriceScope | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.units)) return { units: o.units.map(String) };
  if (typeof o.floor === "number" && Number.isFinite(o.floor)) return { floor: o.floor };
  if (o.all === true) return { all: true };
  return null;
}

/** Validate the op shape (exactly one of set/pct/delta, all finite). `set` must be positive. */
function parseOp(raw: unknown): PriceOp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.set === "number" && Number.isFinite(o.set) && o.set > 0) return { set: o.set };
  if (typeof o.pct === "number" && Number.isFinite(o.pct)) return { pct: o.pct };
  if (typeof o.delta === "number" && Number.isFinite(o.delta)) return { delta: o.delta };
  return null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = String(body.building ?? "").trim();
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });
  if (!by) return NextResponse.json({ error: "by (developer) required" }, { status: 400 });

  const scope = parseScope(body.scope);
  const op = parseOp(body.op);
  if (!scope) return NextResponse.json({ error: "scope must be { units } | { floor } | { all }" }, { status: 400 });
  if (!op) return NextResponse.json({ error: "op must be { set>0 } | { pct } | { delta }" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  // Resolve the concrete per-unit changes (EXACT prices), keep only units whose price actually moved.
  const all = resolvePriceTargets(building, scope, op);
  const moved = all.filter((t) => t.changeClass !== null);
  if (moved.length === 0) {
    return NextResponse.json({ error: "no units matched, or no price changed" }, { status: 400 });
  }
  // Guard a degenerate result (a delta/op that would drive a price non-positive). Refuse the whole batch.
  const bad = moved.find((t) => !(t.to > 0));
  if (bad) {
    return NextResponse.json(
      { error: `that would set ${bad.id} to a non-positive price` },
      { status: 400 }
    );
  }

  // The batch gates on ONE class — a batch that raises ANY unit is a priceUp batch.
  const batchClass = batchPriceClass(moved);
  if (batchClass) {
    const gate = await requireEditable(by, buildingId, batchClass);
    if (!gate.allowed) return NextResponse.json(gate.body, { status: gate.status });
  }

  // Mandatory-remark rule (Part A-finish): a reprice is counterparty-visible, so when this building has an
  // agency partner the developer must say why (400 if absent). Free when no partner (administrative).
  const remarkGate = await requireRemark(by, buildingId, body.remark);
  if (!remarkGate.ok) return NextResponse.json(remarkGate.body, { status: remarkGate.status });

  // Apply the EXACT new prices in place.
  const byId = new Map(moved.map((t) => [t.id, t]));
  for (const u of building.inventory) {
    const t = byId.get(u.id);
    if (t) u.priceUsd = t.to;
  }
  await saveBuilding(building);

  // Change notice (§2) — building + count + direction only, NEVER a price. Parties = the developer
  // (own feed) + the agencies subscribed under the developer's noticeAudience policy (so they see it in
  // getActivityFeed, dismiss via read-markers). VRX-root reads the spine directly on the oversight screen.
  const direction = batchClass === "priceUp" ? "up" : batchClass === "priceDown" ? "down" : "mixed";
  await logActivity(
    inventoryVerbFor(batchClass ?? "priceDown"),
    by.toLowerCase(),
    { kind: "unit", id: buildingId },
    await resolveNoticeParties(by, buildingId),
    { building: building.name, count: moved.length, direction, ...(remarkGate.remark ? { remark: remarkGate.remark } : {}) }
  );

  return NextResponse.json({
    ok: true,
    changed: moved.map((t) => ({ id: t.id, from: t.from, to: t.to, direction: t.changeClass })),
  });
}
