// change a unit's size/type/layout. These are the trust-sensitive classes — version-gated by default (they
// change the vetted SET or a unit's material shape). The price tool is separate (api/catalog/price).
// POST { building, by, op:"add", unit:{ id, type, floor, sqm, priceUsd... } } → addUnit
// POST { building, by, op:"remove", unit:"<id>" } → removeUnit
// POST { building, by, op:"edit", unit:"<id>", changes:{ type?, sqm?, floor?... } } → sizeTypeLayout
// ── Freeze gate ──────────────────────────────────────────────────────────────────────────────
// Each op maps to a ChangeClass (addUnit / removeUnit / sizeTypeLayout). On contract + the class is version-
// gated for this developer (the conservative default) → the route 409-refuses unless an APPROVED covering
// version is open. Pre-sign-off → applies freely (nothing frozen before go-on-contract). On apply, an
// inventory.* change notice is emitted (building only — never the unit's price/terms specifics).
// A removeUnit NEVER removes a unit with a live on-chain reservation (same anti-fraud spine the off-market
// route honours) — that must go through lawful cancellation, not be hidden by a structural edit.
// AUTH posture matches the rest of the off-chain demo layer (developer in `by`; the real signed-request
// binding is the deferred signing arc, F1). Server-validated.

import { NextResponse } from "next/server";
import { getBuilding, saveBuilding } from "@/lib/catalog";
import type { Unit } from "@/lib/catalog-client";
import { requireEditable, requireRemark, inventoryVerbFor, resolveNoticeParties } from "@/lib/catalog-edit-gate";
import type { ChangeClass } from "@/lib/dev-edit-policy";
import { logActivity } from "@/lib/activity";
import { getUnitsStatusMerged } from "@/lib/status-cache";
import { offMarketBlockedReason } from "@/lib/offmarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Build a clean Unit from an add payload (only the fields a developer sets at add time; the rest default). */
function cleanNewUnit(raw: unknown): Unit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, 80);
  const type = str(o.type, 40);
  const floor = num(o.floor);
  const sqm = num(o.sqm);
  const priceUsd = num(o.priceUsd);
  if (!id || !type || floor === undefined || sqm === undefined || sqm <= 0 || priceUsd === undefined || priceUsd <= 0) {
    return null;
  }
  const u: Unit = { id, type, floor, sqm, priceUsd };
  if (str(o.subtype, 40)) u.subtype = str(o.subtype, 40);
  if (str(o.view, 60)) u.view = str(o.view, 60);
  if (num(o.baths) !== undefined) u.baths = num(o.baths);
  if (num(o.unitNumber) !== undefined) u.unitNumber = num(o.unitNumber);
  return u;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = str(body.building, 80);
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  const opName = str(body.op, 16);
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });
  if (!by) return NextResponse.json({ error: "by (developer) required" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  // Resolve op → ChangeClass up front so the gate runs identically for every branch.
  const changeClass: ChangeClass | null =
    opName === "add" ? "addUnit" : opName === "remove" ? "removeUnit" : opName === "edit" ? "sizeTypeLayout" : null;
  if (!changeClass) return NextResponse.json({ error: "op must be add, remove, or edit" }, { status: 400 });

  // ── The freeze gate — same hard block for every structural op. ──
  const gate = await requireEditable(by, buildingId, changeClass);
  if (!gate.allowed) return NextResponse.json(gate.body, { status: gate.status });

  // Mandatory-remark rule (Part A-finish): a structural unit change is counterparty-visible, so when this
  // building has an agency partner the developer must say why (400 if absent). Free when no partner.
  const remarkGate = await requireRemark(by, buildingId, body.remark);
  if (!remarkGate.ok) return NextResponse.json(remarkGate.body, { status: remarkGate.status });
  const remarkCtx = remarkGate.remark ? { remark: remarkGate.remark } : {};

  if (opName === "add") {
    const unit = cleanNewUnit(body.unit);
    if (!unit) return NextResponse.json({ error: "unit requires id, type, floor, sqm>0, priceUsd>0" }, { status: 400 });
    if (building.inventory.some((u) => u.id === unit.id)) {
      return NextResponse.json({ error: `unit ${unit.id} already exists` }, { status: 409 });
    }
    building.inventory.push(unit);
    await saveBuilding(building);
    await logActivity(inventoryVerbFor("addUnit"), by.toLowerCase(), { kind: "unit", id: buildingId }, await resolveNoticeParties(by, buildingId), { building: building.name, ...remarkCtx });
    return NextResponse.json({ ok: true, added: unit.id });
  }

  if (opName === "remove") {
    const unitId = str(body.unit, 80);
    const unit = building.inventory.find((u) => u.id === unitId);
    if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });

    // anti-fraud: never structurally drop a unit that is live on-chain. Read a fresh-enough status; a
    // held/booked/sold unit must go through lawful cancellation, not be removed behind the scenes.
    let onChainStatus: number | undefined;
    try {
      const { status } = await getUnitsStatusMerged(buildingId, [unitId]);
      onChainStatus = status[unitId];
    } catch {
      onChainStatus = undefined; // unconfirmed → refused by the guard
    }
    const blocked = offMarketBlockedReason(onChainStatus);
    if (blocked) {
      return NextResponse.json({ error: blocked, code: "live_reservation" }, { status: 409 });
    }

    building.inventory = building.inventory.filter((u) => u.id !== unitId);
    await saveBuilding(building);
    await logActivity(inventoryVerbFor("removeUnit"), by.toLowerCase(), { kind: "unit", id: buildingId }, await resolveNoticeParties(by, buildingId), { building: building.name, ...remarkCtx });
    return NextResponse.json({ ok: true, removed: unitId });
  }

  // op === "edit" — size/type/layout. NOT price (that's /api/catalog/price) — a price field here is ignored.
  const unitId = str(body.unit, 80);
  const unit = building.inventory.find((u) => u.id === unitId);
  if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });
  const changes = (body.changes && typeof body.changes === "object" ? body.changes : {}) as Record<string, unknown>;
  let touched = false;
  if (str(changes.type, 40)) { unit.type = str(changes.type, 40); touched = true; }
  if (num(changes.sqm) !== undefined && num(changes.sqm)! > 0) { unit.sqm = num(changes.sqm)!; touched = true; }
  if (num(changes.floor) !== undefined) { unit.floor = num(changes.floor)!; touched = true; }
  if (str(changes.subtype, 40)) { unit.subtype = str(changes.subtype, 40); touched = true; }
  if (num(changes.baths) !== undefined) { unit.baths = num(changes.baths)!; touched = true; }
  if (!touched) return NextResponse.json({ error: "no valid structural change supplied" }, { status: 400 });
  await saveBuilding(building);
  await logActivity(inventoryVerbFor("sizeTypeLayout"), by.toLowerCase(), { kind: "unit", id: buildingId }, await resolveNoticeParties(by, buildingId), { building: building.name, ...remarkCtx });
  return NextResponse.json({ ok: true, edited: unitId });
}
