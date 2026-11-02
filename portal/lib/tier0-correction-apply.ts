// TIER-0 CORRECTION — the shared APPLY step (S190h Slice 7). SERVER-ONLY.
// Extracted so BOTH the demo-layer decide route (app/api/catalog/tier0-correction/decide) AND the VRX-root
// review surface (app/api/root/change-governance) run the EXACT same attested write — never two drifting copies
// (lib/tier0-correction) stays pure of cross-module I/O per its header; this helper owns the cross-module apply:
// land write + sealed evidence + notify + evidence-link back onto the correction.
// 1. merge the correction's proposed TIER-0 anchors into building.land + saveBuilding — the write the normal
// edit path REFUSES as immutable_tier0; the VRX review is what authorises it.
// 2. seal a before/after change-evidence record (changeClass "land") — the "what changed" proof.
// 3. notify every affected party (agencies AND live buyers) via the Slice-2 spine.
// 4. link the evidence id back onto the correction (attachEvidence).
// The actor recorded is the reviewer `by` (a correction is VRX-applied by definition). VRX anchors the review +
// the evidence; VRX does NOT warrant the new value or adjudicate any dispute ( pt5).
// decideCorrection (status transition, idempotent) is still called by the ROUTE before this — this helper runs
// ONLY on a freshly-approved correction and performs the side effects. Best-effort on the seal/notify (a sealing
// failure must not strand an already-applied land write): evidence/notify are caught; the land write itself is
// the authoritative act and surfaces if it throws.

import { getBuilding, saveBuilding } from "./catalog";
import { attachEvidence, type Tier0Correction } from "./tier0-correction";
import { recordChangeEvidence } from "./change-evidence";
import { changeNoticeParties } from "./affected-parties";
import { inventoryVerbFor } from "./catalog-edit-gate";
import { logActivity } from "./activity";

export type ApplyResult = {
  applied: boolean;
  evidenceId: string;
  /** Set when nothing could be applied (e.g. the building vanished between open and decide). */
  note?: string;
};

/**
 * Apply an APPROVED TIER-0 correction: the land write + evidence + notify. Call AFTER decideCorrection returned
 * changed:true with status "approved". `by` = the reviewer account (lowercased by the caller or here). Returns
 * whether the land write landed + the sealed evidence id (for linking/reporting).
 */
export async function applyApprovedCorrection(c: Tier0Correction, by: string): Promise<ApplyResult> {
  const reviewer = by.trim().toLowerCase();
  const building = await getBuilding(c.building);
  if (!building) {
    // The building vanished between open and decide — the decision stands (recorded) but there is nothing to
    // apply. Honest: report applied:false so the reviewer knows the target is gone.
    return { applied: false, evidenceId: "", note: "building not found" };
  }

  // Merge only the TIER-0 anchor fields the correction carries; leave clauseText + any other land prose untouched.
  const nextLand = { ...(building.land ?? {}) };
  for (const [k, v] of Object.entries(c.after)) {
    if (typeof v === "string" && v.trim()) (nextLand as Record<string, unknown>)[k] = v.trim();
  }
  building.land = nextLand;
  await saveBuilding(building);

  // Seal before/after evidence (changeClass "land") + notify the affected set. Reuses the Slice-2 spine.
  const parties = await changeNoticeParties(c.developer || building.developer || "", c.building).catch(() => []);
  const evidence = await recordChangeEvidence({
    building: c.building,
    section: "land",
    changeClass: "land",
    before: c.before,
    after: c.after,
    by: reviewer,
    parties,
  }).catch(() => null);
  if (evidence) await attachEvidence(c.id, evidence.id).catch(() => {});
  await logActivity(inventoryVerbFor("land"), reviewer, { kind: "unit", id: c.building }, parties, {
    building: building.name,
  }).catch(() => {});

  return { applied: true, evidenceId: evidence?.id ?? "" };
}
