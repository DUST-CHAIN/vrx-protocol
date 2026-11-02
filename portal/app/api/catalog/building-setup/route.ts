// POST /api/catalog/building-setup — developer sets/updates ONE section of a building's rich setup record
// POST { building, section, data } → clean+save that section; data normalising to empty CLEARS it.
// Section-scoped (small writes, like /api/catalog/geo and /api/catalog/terms) so a half-filled setup never
// blocks and one section's save can't clobber another. `section` ∈ project | physical | fees | land. The
// SELLER-ENTITY block is NOT here — it's a reusable record with its own CRUD (api/seller-entities); a
// building attaches one via `sellerEntityId`, saved through the `sellerEntityId` section below.
// OFF-CHAIN, developer-authored PUBLIC building context ( family, not PII). Persists through the same
// file-backed catalog override store (lib/catalog.saveBuilding) used by geo/terms/off-market. AUTH posture
// matches the rest of the off-chain demo layer (trusted caller; the real signed-request binding is the
// deferred signing arc, F1). Server-side validated so a malformed payload can't corrupt the store.

import { NextResponse } from "next/server";
import { getBuilding, saveBuilding } from "@/lib/catalog";
import { cleanProject, cleanPhysical, cleanFees, cleanLand, cleanDirectSale, isTier0LandEdit } from "@/lib/catalog-building-setup";
import { requireEditable, requireRemark, buildingHasPartner, inventoryVerbFor, isMaterialChange } from "@/lib/catalog-edit-gate";
import { listAllAgreements } from "@/lib/agreements";
import type { ChangeClass } from "@/lib/dev-edit-policy";
import { logActivity } from "@/lib/activity";
import { changeNoticeParties } from "@/lib/affected-parties";
import { recordChangeEvidence, type EvidenceSnapshot } from "@/lib/change-evidence";
import { resolveHaltAffected } from "@/lib/halt-affected";
import { fileAmendment } from "@/lib/contract-amendment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which change class a setup section falls into (Slice 1 — the real CHANGE-GOVERNANCE tiers, replacing the
 * old crude fees+land→`terms`/rest→`copy` collapse). Each section maps to its own first-class change class so the
 * per-developer matrix carries its tier-correct disposition: `land` is TIER-0 immutable (the freeze gate refuses
 * it outright), `physical`/`fees` are TIER-2 material (version-gated), `sellerEntity`/`directorChange` are TIER-1
 * governance (version-gated), `project` is descriptive `copy` (self-serve). Governs the freeze gate + notice verb. */
function sectionChangeClass(section: string): ChangeClass {
  switch (section) {
    case "physical":
      return "physical";
    case "fees":
      return "fees";
    case "land":
      return "land";
    case "sellerEntity":
      return "sellerEntity";
    default:
      return "copy"; // project + directSale + anything else: descriptive, self-serve by default
  }
}

/** Snapshot the CURRENT value of a setup section from a building, for the sealed before/after evidence (
 * Slice 2). Returns a JSON-safe object (or null = the section is absent/unset). sellerEntity has no sub-object
 * on the building — it's the single `sellerEntityId` field — so it's wrapped as `{ sellerEntityId }` for a
 * uniform snapshot shape. Read-only; never mutates the building. */
function sectionSnapshot(building: Awaited<ReturnType<typeof getBuilding>>, section: string): EvidenceSnapshot {
  if (!building) return null;
  switch (section) {
    case "project":
      return building.project ? { ...building.project } : null;
    case "physical":
      return building.physical ? { ...building.physical } : null;
    case "fees":
      return building.fees ? { ...building.fees } : null;
    case "land":
      return building.land ? { ...building.land } : null;
    case "sellerEntity":
      return building.sellerEntityId ? { sellerEntityId: building.sellerEntityId } : null;
    case "directSale":
      return building.directSale ? { ...building.directSale } : null;
    default:
      return null;
  }
}

/** True iff ANY agreement (any status, any owner) lists this building — owner-agnostic "has a stake" check,
 * so we can tell an on-contract building from a free pre-contract one even on the no-`by` path.
 * Case-insensitive on the building id. Pure read over the agreement store. */
async function anyAgreementCoversBuilding(buildingId: string): Promise<boolean> {
  const bid = buildingId.trim();
  if (!bid) return false;
  for (const g of await listAllAgreements()) {
    if (g.seal.buildings.some((b) => b.buildingId === bid)) return true;
  }
  return false;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const buildingId = String(body.building ?? "").trim();
  const section = String(body.section ?? "").trim();
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "";
  if (!buildingId) return NextResponse.json({ error: "building required" }, { status: 400 });

  const building = await getBuilding(buildingId);
  if (!building) return NextResponse.json({ error: "building not found" }, { status: 404 });

  // UI sends no `by`, so ON-CONTRACT edits went through fully ungated + unnoticed. The FULL identity+remark+
  // version gate needs the UI upgraded (next arc). This slice does the two things that are safe + high-value
  // WITHOUT breaking the current UI: (1) hard-refuse a TIER-0 legal-anchor change on a partnered building;
  // (2) make sure NOTHING is silent — log a change notice even on the no-`by` path. "Partnered" = any
  // agreement (any status, any owner) covers this building = someone has a stake worth protecting.
  const partnered = await anyAgreementCoversBuilding(buildingId).catch(() => false);

  // TIER 0 — IMMUTABLE legal anchors (§3). The land legal-identity fields (title deed / survey page / land
  // number / address) are what the title + S&P are written against; they are NOT self-editable once the
  // building has a partner. A genuine typo is fixed through a VRX-reviewed CORRECTION (next arc) — NOT by
  // killing + rebuilding the building (that would orphan live contracts/bookings). Refuse the edit path here.
  if (section === "land" && partnered && isTier0LandEdit(building.land as Record<string, unknown> | undefined, body.data)) {
    return NextResponse.json(
      { error: "The title deed, survey page, land number and address are fixed once a building is on contract. To correct a genuine error, contact VRX — the change is reviewed and all parties are notified with evidence.", code: "immutable_tier0" },
      { status: 409 }
    );
  }

  // Freeze gate (+ tiers): each section now maps to its REAL change class (physical/fees =
  // TIER-2 version-gated; sellerEntity = TIER-1 version-gated; land = TIER-0 immutable; project/directSale =
  // copy self-serve). Gate only when a developer identity (`by`) is supplied; the pre-gate demo path (no `by`)
  // is still covered for the TIER-0 case by the granular block above. `copy` self-serve passes.
  const changeClass = sectionChangeClass(section);
  let remarkCtx: { remark?: string } = {};
  if (by) {
    // LAND is gated EXCLUSIVELY by the granular Tier-0 block above (isTier0LandEdit) — it correctly ALLOWS a
    // first-time populate of an empty anchor and only REFUSES an actual change/clear. We must NOT also route it
    // through requireEditable, whose `immutable` disposition would blanket-refuse even a legitimate populate (it
    // can't see first-time-vs-change). So the freeze gate runs for every section EXCEPT land; land's two paths
    // are: populate → allowed (falls through to the remark rule + save), change-an-anchor → already 409'd above.
    // The remark rule + change notice STILL apply to a land populate. (Slice 1.)
    if (section !== "land") {
      const gate = await requireEditable(by, buildingId, changeClass);
      if (!gate.allowed) return NextResponse.json(gate.body, { status: gate.status });
    }

    // (b) directSale.visible DEMOTE-on-write (Part A-finish): a developer may freely flip visibility ONLY
    // while no agency partner exists; once this building has a partner, HIDING it must go through the halt
    // path (note + notify), not a silent self-serve toggle. A hide = currently visible, incoming not visible.
    // Showing (→visible) is never a surprise, so it stays free. 409 steers to the halt control.
    if (section === "directSale") {
      const incoming = cleanDirectSale(body.data);
      const hiding = (building.directSale?.visible === true) && !(incoming?.visible === true);
      if (hiding && (await buildingHasPartner(by, buildingId))) {
        return NextResponse.json(
          {
            error:
              "This building has an agency partner — use the halt control to pause it (with a note), so your partners are told why.",
            code: "use_halt",
          },
          { status: 409 }
        );
      }
    }

    // (c) Mandatory-remark rule: every section here is a counterparty-visible building change, so when this
    // building has an agency partner the developer must say why (400 if absent). Free when no partner.
    const remarkGate = await requireRemark(by, buildingId, body.remark);
    if (!remarkGate.ok) return NextResponse.json(remarkGate.body, { status: remarkGate.status });
    if (remarkGate.remark) remarkCtx = { remark: remarkGate.remark };
  }

  // Snapshot the section's value BEFORE the switch mutates it, for the sealed before/after evidence (
  // Slice 2). Taken here so it reflects the on-disk state the change is departing from.
  const beforeSnapshot = sectionSnapshot(building, section);

  try {
    switch (section) {
      case "project":
        building.project = cleanProject(body.data) ?? undefined;
        break;
      case "physical":
        building.physical = cleanPhysical(body.data) ?? undefined;
        break;
      case "fees": {
        const fees = cleanFees(body.data) ?? undefined;
        building.fees = fees;
        // Reconcile with the top-level published figure (one source of truth): the authored sinking-fund value
        // IS the authoritative figure, so mirror it up; clearing it in setup clears the top-level too.
        building.sinkingFundPerSqmUsd = fees?.sinkingFundPerSqmUsd;
        break;
      }
      case "land":
        building.land = cleanLand(body.data) ?? undefined;
        break;
      case "sellerEntity": {
        // Attach/detach a reusable seller entity by id (the entity itself lives in /api/seller-entities).
        const id = String(body.data?.sellerEntityId ?? "").trim();
        building.sellerEntityId = id || undefined;
        break;
      }
      case "directSale":
        // Direct-Sales Desk visibility ( §9 step 2). cleanDirectSale returns null when not visible and
        // no copy → clears the field = fail-closed invisible.
        building.directSale = cleanDirectSale(body.data) ?? undefined;
        break;
      default:
        return NextResponse.json(
          { error: "section must be project, physical, fees, land, sellerEntity, or directSale" },
          { status: 400 }
        );
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid data" }, { status: 400 });
  }

  await saveBuilding(building);

  // Two promises for EVERY change on an on-contract building, regardless of the `by` path (closes the silent-
  // notice gap the slice left: the notice used to fire only `if (by)`, but the real UI sends no `by`):
  // (1) SEAL before/after EVIDENCE (lib/change-evidence) — the tamper-evident record "section S went from
  // <before> to <after>, by <who>, told <whom>". VRX anchors it; VRX does not adjudicate ( pt5).
  // (2) NOTIFY the full affected set — agencies AND live buyers (lib/affected-parties.changeNoticeParties,
  // which reuses resolveHaltAffected's buyer resolution), not just the subscribed agencies.
  // Only fires when the building is on contract (partnered) — a free pre-contract building has nobody to notify
  // and no live contract to protect, so a change there is administrative (no evidence, no notice). The owning
  // developer scopes the audience; on the no-`by` path we fall back to the building's own `developer` field, and
  // the notice is attributed to a neutral "vrx" system actor (honest: an unattributed change, still never silent).
  if (partnered) {
    const actor = by ? by.toLowerCase() : "vrx";
    const owner = by ? by.toLowerCase() : (building.developer || "").toLowerCase();
    const evidenceBy = actor === "vrx" ? "" : actor; // "" records an unattributed (no-`by`) change explicitly
    const afterSnapshot = sectionSnapshot(building, section);
    const parties = await changeNoticeParties(owner, buildingId).catch(() => (owner ? [owner] : []));

    // (1) SEAL evidence (Slice 2). Keep the record id to link any amendments to the "what changed" proof.
    const evidence = await recordChangeEvidence({
      building: buildingId,
      section,
      changeClass,
      before: beforeSnapshot,
      after: afterSnapshot,
      by: evidenceBy,
      parties,
    }).catch(() => null);

    // (2) NOTIFY the full affected set — agencies AND live buyers (Slice 2).
    await logActivity(inventoryVerbFor(changeClass), actor, { kind: "unit", id: buildingId }, parties, {
      building: building.name,
      ...remarkCtx,
    });

    // (TIER-2 — physical/fees/land/priceUp/sizeTypeLayout/terms) entitles every buyer with a LIVE contract on
    // the building to an amendment record + an explicit dispute right (§4). A LIVE contract = a confirmed sale
    // or an in-flight booking (dealStage !== "open_negotiation" — an early unsettled negotiation isn't baked in
    // yet, so there is nothing to amend). We reuse resolveHaltAffected (the same affected-set computation Slice
    // 2's buyer-notify rides on) to enumerate the deals — no new offer walk. A non-material change does Slice 2
    // only (no amendment). VRX records the amendment + the RIGHT; VRX never records a dispute outcome ( pt5).
    if (isMaterialChange(changeClass) && owner) {
      const affected = await resolveHaltAffected(owner, buildingId).catch(() => null);
      const liveDeals = (affected?.deals ?? []).filter((d) => d.stage !== "open_negotiation");
      for (const deal of liveDeals) {
        await fileAmendment({
          requestId: deal.requestId,
          building: buildingId,
          changeClass,
          evidenceId: evidence?.id ?? "",
          buyerRef: deal.buyerRef ?? "",
          developer: owner,
          disputeRight: true,
        }).catch(() => {});
      }
    }
  }
  return NextResponse.json({ ok: true });
}
