// /api/seller-entities — developer-GLOBAL, reusable seller-entity records (§3 Option A). An entity
// is the developer's selling-company identity + payee details, authored ONCE and attached to any number of
// buildings via Building.sellerEntityId (the building-setup route sets the pointer; this route owns the
// entity library).
//
//   GET    ?developer=<account>                          → { entities } this developer owns.
//  POST { developer, id?, label, companyName... } → create (no id) or update (id) an entity.
//   DELETE ?developer=&id=                               → delete an entity.
//
// OFF-CHAIN, developer-scoped (lib/seller-entities refuses cross-developer edits). This carries business/payee
// identity (company, TaxID, bank, director) — it appears on the S&P (the seller must be identified to the
// buyer), which is expected; it stays off-chain, only hashes/refs ever seal. AUTH posture matches the
// rest of the off-chain demo layer (the `developer` is self-named; the real signed-request binding is the
// deferred signing arc, F1).

import { NextResponse } from "next/server";
import { listEntitiesForDeveloper, saveEntity, deleteEntity, getEntity } from "@/lib/seller-entities";
import { getCatalog } from "@/lib/catalog";
import { buildingHasPartner, inventoryVerbFor } from "@/lib/catalog-edit-gate";
import { changeNoticeParties } from "@/lib/affected-parties";
import { recordChangeEvidence } from "@/lib/change-evidence";
import { logActivity } from "@/lib/activity";
import { governanceDiff, governanceClassOf } from "@/lib/seller-entity-governance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const developer = new URL(req.url).searchParams.get("developer")?.trim() || "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
  return NextResponse.json({ entities: await listEntitiesForDeveloper(developer) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const developer = typeof body.developer === "string" ? body.developer.trim() : "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });

  // Snapshot the entity BEFORE the save, so a TIER-1 governance diff (director / company / payment destination)
  // can be computed against the new state (Slice 4). Absent on a create (no id / unknown id) → no diff.
  const entityId = typeof body.id === "string" ? body.id.trim() : "";
  const before = entityId ? await getEntity(entityId).catch(() => null) : null;

  try {
    const entity = await saveEntity(developer, {
      id: typeof body.id === "string" ? body.id : undefined,
      label: body.label,
      companyName: body.companyName,
      companyNameTH: body.companyNameTH,
      address: body.address,
      addressTH: body.addressTH,
      email: body.email,
      telephone: body.telephone,
      taxId: body.taxId,
      directorName: body.directorName,
      bankPayable: body.bankPayable,
      // the developer's accepted-payment menu for this building's seller (per-building KYC).
      // Developer-scoped only; saveEntity refuses a cross-developer id, and there is no root/admin write path
      // (admin-lock, the #6). cleanSellerEntity validates/caps the list + migrates a legacy bankPayable.
      paymentOptions: body.paymentOptions,
    });

    // ── CHANGE-GOVERNANCE TIER-1 governance events (Slice 4) ──────────────────────────────────────────
    // A seller entity is reused across buildings; an edit to its director/signatory or company/payment
    // destination silently ripples to every building using it. The taxonomy (§3 TIER-1) makes those sealed +
    // notified events on each ON-CONTRACT building that relies on the entity. We diff the governed fields; for
    // each field that moved and each on-contract building pointing at this entity, seal before/after evidence
    // (the entity-level governed view, NOT buyer PII) + notify the affected set (agencies AND live buyers).
    // NOT an amendment trigger (TIER-1 is a sealed event, not a dispute right by itself — §3). Best-effort: a
    // governance-notify failure never breaks the developer's save. Only runs on an actual edit (before exists).
    const kinds = governanceDiff(before, entity);
    if (kinds.length > 0) {
      const affected = (await getCatalog().catch(() => []))
        .filter((b) => b.sellerEntityId === entity.id);
      for (const kind of kinds) {
        const changeClass = governanceClassOf(kind);
        const beforeSnap = { [kind === "director" ? "directorName" : "companyName"]: kind === "director" ? (before?.directorName ?? null) : (before?.companyName ?? null) };
        const afterSnap = { [kind === "director" ? "directorName" : "companyName"]: kind === "director" ? (entity.directorName ?? null) : (entity.companyName ?? null) };
        for (const b of affected) {
          if (!(await buildingHasPartner(developer, b.id).catch(() => false))) continue; // only on-contract
          const parties = await changeNoticeParties(developer, b.id).catch(() => [developer.toLowerCase()]);
          await recordChangeEvidence({
            building: b.id,
            section: "sellerEntity",
            changeClass,
            before: beforeSnap,
            after: afterSnap,
            by: developer.toLowerCase(),
            parties,
          }).catch(() => {});
          await logActivity(inventoryVerbFor(changeClass), developer.toLowerCase(), { kind: "unit", id: b.id }, parties, { building: b.name }).catch(() => {});
        }
      }
    }

    return NextResponse.json({ ok: true, entity });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const developer = url.searchParams.get("developer")?.trim() || "";
  const id = url.searchParams.get("id")?.trim() || "";
  if (!developer || !id) return NextResponse.json({ error: "developer + id required" }, { status: 400 });
  const ok = await deleteEntity(developer, id);
  return NextResponse.json({ ok });
}
