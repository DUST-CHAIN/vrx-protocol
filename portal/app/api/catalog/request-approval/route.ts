// POST /api/catalog/request-approval — open a version for a version-GATED change so VRX can approve it (
// ). This is the path forward after a mutation route 409s with `needs_version`: the developer explicitly
// requests approval, which OPENS a sealed inventory-version capturing the intended changeset. The affected
// units go HELD-pending-approval immediately (lib/bookable reads the open version via heldUnits) so nobody can
// book on stale/soon-to-change terms while the review is pending. Nothing is written to the live catalog here —
// the change only LANDS when the version is approved (POST /api/catalog/version/decide auto-applies it).
// ── PRICE request (mirrors the price tool /api/catalog/price so the UI reuses the same payload) ──
// POST { building, by, scope, op }
// scope = { units:[...] } | { floor:N } | { all:true }
// op = { set:n } | { pct:±x } | { delta:±n }
// changeset → `{ "<unitId>": { from, to }... }` (the shape heldUnits + applyApprovedPriceVersion read).
// ── STRUCTURAL request (mirrors /api/catalog/unit so StructureTool reuses the same payload) ──
// POST { building, by, op:"add", unit:{ id, type, floor, sqm, priceUsd... } }
// POST { building, by, op:"remove", unit:"<id>" }
// POST { building, by, op:"edit", unit:"<id>", changes:{ type?, sqm?, floor?... } }
// changeset → SELF-DESCRIBING per-entry op, the shape heldUnits + applyApprovedStructuralVersion
// read: remove/edit are UNIT-ID keyed (→ held while pending); add is CONTROL-keyed under "add" (holds nothing,
// because an un-added unit isn't bookable yet).
// We only OPEN a version when the change is genuinely version-gated for this developer; a self-serve or
// pre-contract change doesn't need one (the caller should just use /price or /unit directly — we return
// `not_gated` so the UI falls through to the direct route).
// AUTH posture matches the off-chain demo layer (developer in `by`; signed-request binding = F1).

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import {
  resolvePriceTargets,
  batchPriceClass,
  type PriceScope,
  type PriceOp,
} from "@/lib/catalog-edit-gate";
import { requiresApproval, getPolicy, type ChangeClass } from "@/lib/dev-edit-policy";
import { getBaseline } from "@/lib/sale-baseline";
import { openVersion } from "@/lib/inventory-version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function parseScope(raw: unknown): PriceScope | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.units)) return { units: o.units.map(String) };
  if (typeof o.floor === "number" && Number.isFinite(o.floor)) return { floor: o.floor };
  if (o.all === true) return { all: true };
  return null;
}

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

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  // A STRING op (add/remove/edit) = a structural request (mirrors /api/catalog/unit). An OBJECT op (set/pct/
  // delta) = a price request (mirrors /api/catalog/price). Dispatch by op shape.
  const opName = typeof body.op === "string" ? str(body.op, 16) : "";
  if (opName === "add" || opName === "remove" || opName === "edit") {
    return structuralRequest(building, buildingId, by, opName, body);
  }

  const scope = parseScope(body.scope);
  const op = parseOp(body.op);
  if (!scope) return NextResponse.json({ error: "scope must be { units } | { floor } | { all }" }, { status: 400 });
  if (!op) return NextResponse.json({ error: "op must be { set>0 } | { pct } | { delta }" }, { status: 400 });

  // Resolve the concrete per-unit changes (EXACT), keep only units whose price actually moves.
  const moved = resolvePriceTargets(building, scope, op).filter((t) => t.changeClass !== null);
  if (moved.length === 0) {
    return NextResponse.json({ error: "no units matched, or no price changed" }, { status: 400 });
  }
  const bad = moved.find((t) => !(t.to > 0));
  if (bad) {
    return NextResponse.json({ error: `that would set ${bad.id} to a non-positive price` }, { status: 400 });
  }

  const batchClass = batchPriceClass(moved);
  if (!batchClass) return NextResponse.json({ error: "no price changed" }, { status: 400 });

  // Shape the changeset to the contract heldUnits + apply-version read: { "<unitId>": { from, to } }.
  const changeset: Record<string, { from: number; to: number }> = {};
  for (const t of moved) changeset[t.id] = { from: t.from, to: t.to };

  return openGatedVersion(buildingId, by, batchClass, changeset, moved.map((t) => t.id));
}

/**
 * STRUCTURAL request-approval — build the self-describing changeset for an add/remove/edit op, validated
 * the SAME way /api/catalog/unit validates it, then open a gated version. remove/edit are unit-id keyed (so the
 * unit is held while pending); add is control-keyed under "add" (holds nothing — it isn't in the catalog yet).
 */
async function structuralRequest(
  building: Awaited<ReturnType<typeof getBuilding>> & object,
  buildingId: string,
  by: string,
  opName: "add" | "remove" | "edit",
  body: Record<string, unknown>
) {
  const changeClass: ChangeClass = opName === "add" ? "addUnit" : opName === "remove" ? "removeUnit" : "sizeTypeLayout";
  let changeset: Record<string, unknown>;
  let held: string[]; // the unit ids that will go held (empty for add — no existing unit)

  if (opName === "add") {
    const raw = (body.unit && typeof body.unit === "object" ? body.unit : {}) as Record<string, unknown>;
    const id = str(raw.id, 80);
    const type = str(raw.type, 40);
    const floor = num(raw.floor);
    const sqm = num(raw.sqm);
    const priceUsd = num(raw.priceUsd);
    if (!id || !type || floor === undefined || sqm === undefined || sqm <= 0 || priceUsd === undefined || priceUsd <= 0) {
      return NextResponse.json({ error: "unit requires id, type, floor, sqm>0, priceUsd>0" }, { status: 400 });
    }
    if (building.inventory.some((u) => u.id === id)) {
      return NextResponse.json({ error: `unit ${id} already exists` }, { status: 409 });
    }
    // Carry the full clean add payload so apply-on-approve re-creates the exact unit the approver signed off.
    const unit: Record<string, unknown> = { id, type, floor, sqm, priceUsd };
    if (str(raw.subtype, 40)) unit.subtype = str(raw.subtype, 40);
    if (str(raw.view, 60)) unit.view = str(raw.view, 60);
    if (num(raw.baths) !== undefined) unit.baths = num(raw.baths);
    if (num(raw.unitNumber) !== undefined) unit.unitNumber = num(raw.unitNumber);
    changeset = { add: { op: "add", unit } };
    held = [];
  } else if (opName === "remove") {
    const unitId = str(body.unit, 80);
    if (!building.inventory.some((u) => u.id === unitId)) {
      return NextResponse.json({ error: "unit not found" }, { status: 404 });
    }
    changeset = { [unitId]: { op: "remove" } };
    held = [unitId];
  } else {
    const unitId = str(body.unit, 80);
    if (!building.inventory.some((u) => u.id === unitId)) {
      return NextResponse.json({ error: "unit not found" }, { status: 404 });
    }
    const raw = (body.changes && typeof body.changes === "object" ? body.changes : {}) as Record<string, unknown>;
    const changes: Record<string, string | number> = {};
    if (str(raw.type, 40)) changes.type = str(raw.type, 40);
    if (num(raw.sqm) !== undefined && num(raw.sqm)! > 0) changes.sqm = num(raw.sqm)!;
    if (num(raw.floor) !== undefined) changes.floor = num(raw.floor)!;
    if (str(raw.subtype, 40)) changes.subtype = str(raw.subtype, 40);
    if (num(raw.baths) !== undefined) changes.baths = num(raw.baths)!;
    if (Object.keys(changes).length === 0) {
      return NextResponse.json({ error: "no valid structural change supplied" }, { status: 400 });
    }
    changeset = { [unitId]: { op: "edit", changes } };
    held = [unitId];
  }

  return openGatedVersion(buildingId, by, changeClass, changeset, held);
}

/**
 * Shared tail for every request-approval branch: only OPEN a version when the change is genuinely version-gated
 * for THIS developer on contract. Pre-contract (no baseline) or a self-serve class never needs approval — return
 * `not_gated` so the UI falls through to the direct route. Stamps the version APPROVER from the developer's edit
 * policy: `approver`/`approverRole` is the single trust-dial VRX-root sets per developer (setApprover,
 * surfaced on the /root oversight screen) — defaults to the developer, can point at a VRX/CEO wallet with no
 * rework; decideVersion enforces only this approver may decide. A developer with no policy → openVersion's own
 * default (the developer). (This passthrough was the inert line fixed.)
 */
async function openGatedVersion(
  buildingId: string,
  by: string,
  changeClass: ChangeClass,
  changeset: Record<string, unknown>,
  held: string[]
) {
  const direct = changeClass === "priceUp" || changeClass === "priceDown" ? "/api/catalog/price" : "/api/catalog/unit";
  const baseline = await getBaseline(by, buildingId);
  const gated = baseline ? await requiresApproval(by, changeClass) : false;
  if (!gated) {
    return NextResponse.json(
      { error: `this change is self-serve — apply it directly via ${direct}`, code: "not_gated" },
      { status: 409 }
    );
  }

  const policy = await getPolicy(by);
  const version = await openVersion({
    developer: by,
    building: buildingId,
    changeClass,
    changeset,
    approver: policy?.approver,
    approverRole: policy?.approverRole,
  });
  if (!version) return NextResponse.json({ error: "could not open a version" }, { status: 500 });

  // The affected units are now HELD pending approval (derived — no stamp, no on-chain write). On approval the
  // decide route auto-applies the stored changeset. We do NOT emit a change notice yet — the change hasn't
  // landed; the notice fires when it's approved+applied (so parties aren't told of a change that may be
  // rejected). Report back the version + the held units so the UI can show "held pending approval".
  return NextResponse.json({
    ok: true,
    version: version.version,
    changeClass,
    held,
    status: version.status, // "open" — awaiting approval
  });
}
