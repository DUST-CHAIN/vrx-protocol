// POST /api/catalog/version/decide — the APPROVER signs a pending inventory-version off. Approve
// or reject an `open` version. The approver is the developer themselves by default today; a VRX/CEO approver
// slots in with no rework (the single `approver` abstraction, — decideVersion enforces that `by` is the
// version's approver).
//
//   POST { building, version, decision:"approved"|"rejected", by }
//
// ── What a decision does ──────────────────────────────────────────────────────────────────────────
// APPROVE → the version is the INSTRUCTION: we AUTO-APPLY its stored changeset to the live catalog (the exact
//   figures the approver signed off — the developer re-types nothing, so there's no drift between approved and
//   applied). The pending-approval HOLD lifts the instant the version is no longer `open`; the units are now
//   bookable on the NEW figures. A single `inventory.repriced` change notice fires NOW (the change has landed)
//  to the developer + subscribed agencies (§2) — never a price, just building + count + direction.
// REJECT → nothing is applied (the catalog write never happened — hard-blocked it). The hold lifts and
//   the units stay bookable on the OLD figures. "Fall back to before" = free (nothing to roll back). If the
//   developer wants to keep trying, they open a NEW version (request-approval again) → held again until
//  approvable. No notice (nothing changed for anyone to).
//
// AUTO-APPLY covers BOTH kinds now: a price changeClass lands via applyApprovedPriceVersion; a structural
// one (addUnit/removeUnit/sizeTypeLayout) lands via applyApprovedStructuralVersion. A removeUnit still honours
// the anti-fraud guard inside the applier (a live on-chain reservation is skipped, never dropped).

import { NextResponse } from "next/server";
import { decideVersion, versionsForBuilding } from "@/lib/inventory-version";
import { applyApprovedPriceVersion, applyApprovedStructuralVersion } from "@/lib/apply-version";
import { getBuilding } from "@/lib/catalog";
import { logActivity } from "@/lib/activity";
import { inventoryVerbFor, resolveNoticeParties } from "@/lib/catalog-edit-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = String(body.building ?? "").trim();
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  const version = Number(body.version);
  const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : null;

  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });
  if (!by) return NextResponse.json({ error: "by (approver) required" }, { status: 400 });
  if (!Number.isInteger(version) || version < 1) return NextResponse.json({ error: "version must be a positive integer" }, { status: 400 });
  if (!decision) return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });

  // Find the version before deciding so we have its changeset to apply on approve.
  const before = (await versionsForBuilding(buildingId)).find((v) => v.version === version);
  if (!before) return NextResponse.json({ error: "version not found" }, { status: 404 });

  const decided = await decideVersion({ building: buildingId, version, decision, by });
  if (!decided) {
    // null = not found (handled above) or `by` is not the version's approver.
    return NextResponse.json({ error: "only the version's approver can decide it", code: "not_approver" }, { status: 403 });
  }
  if (decided.status !== decision) {
    // A no-op (the version was already decided) — report its current state, apply nothing again.
    return NextResponse.json({ ok: true, version, status: decided.status, noop: true });
  }

  if (decision === "rejected") {
    // Nothing applied; the hold lifts because the version is no longer `open`. Old figures stand.
    return NextResponse.json({ ok: true, version, status: "rejected", applied: [] });
  }

  // APPROVED → auto-apply the attested changeset. Route by class: price vs structural.
  const isPrice = decided.changeClass === "priceUp" || decided.changeClass === "priceDown";

  if (isPrice) {
    const { applied, skipped } = await applyApprovedPriceVersion(buildingId, decided.changeset);
    // The change LANDED → emit the single change notice (building + count + direction only, never a price).
    // Parties = developer's own feed + subscribed agencies per their noticeAudience (§2).
    if (applied.length > 0) {
      const ups = applied.filter((a) => a.direction === "up").length;
      const direction = ups === applied.length ? "up" : ups === 0 ? "down" : "mixed";
      const building = await getBuilding(buildingId);
      await logActivity(
        inventoryVerbFor(decided.changeClass),
        decided.by,
        { kind: "unit", id: buildingId },
        await resolveNoticeParties(decided.by, buildingId),
        { building: building?.name ?? buildingId, count: applied.length, direction }
      );
    }
    return NextResponse.json({ ok: true, version, status: "approved", applied, skipped });
  }

  // Structural → add / remove / edit a unit. Same notice discipline: building + count only, the class-specific
  // verb (unit_added / unit_removed / unit_changed), never the unit's specifics. A removeUnit the guard
  // refused shows up in `skipped` (not applied) so the UI can tell the developer it must be lawfully cancelled.
  const { applied, skipped } = await applyApprovedStructuralVersion(buildingId, decided.changeset);
  if (applied.length > 0) {
    const building = await getBuilding(buildingId);
    await logActivity(
      inventoryVerbFor(decided.changeClass),
      decided.by,
      { kind: "unit", id: buildingId },
      await resolveNoticeParties(decided.by, buildingId),
      { building: building?.name ?? buildingId, count: applied.length }
    );
  }
  return NextResponse.json({ ok: true, version, status: "approved", applied, skipped });
}
