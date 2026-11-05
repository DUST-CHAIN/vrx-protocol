// CATALOG EDIT GATE — the shared enforcement seam every developer catalog-mutation route calls (
//  items 4–5 of the vetting/release lifecycle). Design: docs/DESIGN_vetting_release_lifecycle.md
// §"PINNED ". Pure-ish (reads baseline/policy/versions via lib/inventory-version.canEdit); no store of
// its own, no I/O beyond what canEdit does.
//
// ── What this gives a route ────────────────────────────────────────────────────────────────────────────
//  • requireEditable(dev, building, changeClass) → the HARD-BLOCK freeze gate. Returns the canEdit
//     decision; a route 409-refuses with `blocked.body` when `!allowed`. Self-serve classes pass (then the
//     route emits a change notice); version-gated classes block until an approved covering version exists.
//   • classifyPriceChange(oldUsd, newUsd) → the ONE direction classifier. new>old → "priceUp" (version-gated
//  by default); new<old → "priceDown" (self-serve); equal → null (no change). The SAME classifier
//     gates both the new price tool AND the offmarket release-price, so there's no second door to raise a
//     price unsealed.
//   • resolvePriceTargets(building, scope, op) → turn a {units|floor|all} scope + a {set|pct|delta} op into the
//     concrete per-unit {id, from, to, changeClass} list, EXACT (never pre-rounded — storage is the truth,
// display rounding is a separate developer choice applied in the UI layer).
//   • inventoryVerbFor(changeClass) → the plain inventory.* change-notice verb to logActivity on allow.
//
// PRIVACY: no PII; operates on opaque developer/building/unit ids + public catalog prices. Nothing on-chain.

import type { Building } from "./catalog-client";
import { getPolicy, type ChangeClass, type NoticeAudience } from "./dev-edit-policy";
import { canEdit, type FreezeDecision } from "./inventory-version";
import type { ActivityVerb } from "./activity";
import { agreementsForParty } from "./agreements";

// ── The freeze-gate wrapper ──────────────────────────────────────────────────────────────────────────────

/** What a route gets back. On block it carries the ready-to-return 409 body + status. The `code` distinguishes
 *  a version-gated refusal (open a version) from a TIER-0 immutable refusal (no version unlocks it — only a
 * VRX-reviewed correction), so the route + UI steer to the right path (Slice 1). */
export type EditGate =
  | { allowed: true; decision: FreezeDecision }
  | {
      allowed: false;
      decision: FreezeDecision;
      status: 409;
      body: { error: string; code: "needs_version" | "immutable_tier0" };
    };

/**
 * The HARD BLOCK a mutation route honours before applying a change. Resolves the freeze decision for
 * (developer, building, changeClass); when refused, hands back a 409 payload the route returns verbatim. Same
 * fail-closed discipline as the bookable gate — the route MUST NOT apply the change on `!allowed`.
 * An `immutable` refusal (TIER-0 legal anchor) carries `code: "immutable_tier0"`; a version-gated refusal
 * carries `code: "needs_version"`.
 */
export async function requireEditable(
  developer: string,
  building: string,
  changeClass: ChangeClass
): Promise<EditGate> {
  const decision = await canEdit(developer, building, changeClass);
  if (decision.allowed) return { allowed: true, decision };
  const code = decision.reason === "immutable" ? "immutable_tier0" : "needs_version";
  return {
    allowed: false,
    decision,
    status: 409,
    body: { error: decision.message, code },
  };
}

// ── Change-notice audience (§2/§3) — who is subscribed to this developer/building ───────────────────

/**
 * Resolve the `parties` a developer's inventory change-notice should reach, honouring the developer's
 * `noticeAudience` policy (§3). ALWAYS includes the developer (so it shows in their own feed); VRX-root
 * is NOT listed — root reads the activity spine directly on the oversight screen. "Subscribed" = an agency
 * with a live (`agreed`) agreement with this developer:
 *   • "all_subscribed"  → every agency that holds an agreed agreement with the developer (any building).
 *   • "agreement_only"  → only agencies whose agreed agreement COVERS this specific building.
 *
 * Case-insensitive, deduped. Derivable purely from the agreement store — there is no separate subscription
 * record (§2: the agreement IS the subscription). Visibility is parties-membership only (activity-feed),
 * so adding these accounts here is exactly what makes a subscribed agency see the notice in getActivityFeed.
 */
export async function noticeParties(
  developer: string,
  building: string,
  audience: NoticeAudience
): Promise<string[]> {
  const dev = developer.trim().toLowerCase();
  const out = new Set<string>();
  if (dev) out.add(dev);
  if (!dev) return [...out];

  const bid = building.trim();
  for (const g of await agreementsForParty(dev)) {
    if (g.status !== "agreed") continue; // only a signed, live agreement subscribes an agency
    if (g.seal.developer.toLowerCase() !== dev) continue; // dev must be the inventory owner (not the agency side)
    const agency = g.seal.agency.trim().toLowerCase();
    if (!agency) continue;
    if (audience === "agreement_only") {
      const covers = g.seal.buildings.some((b) => b.buildingId === bid);
      if (!covers) continue;
    }
    out.add(agency);
  }
  return [...out];
}

/**
 * The route-facing convenience: read the developer's `noticeAudience` policy (default `all_subscribed` when
 * no policy is set yet — the openest tier) and resolve the notice parties for this building. One call per
 * emit site: `const parties = await resolveNoticeParties(dev, building);` then `logActivity(..., parties...)`.
 */
export async function resolveNoticeParties(developer: string, building: string): Promise<string[]> {
  const policy = await getPolicy(developer);
  const audience: NoticeAudience = policy?.noticeAudience ?? "all_subscribed";
  return noticeParties(developer, building, audience);
}

// ── The DEMOTE BOUNDARY (Part A-finish, the design docs §Cross-cutting) ───────────────
//
// The single predicate that gates two transparency rules on a developer's catalog change:
//   1. directSale.visible DEMOTE — a developer may freely flip a building's visibility ONLY while nobody is
//      watching; once an agency partner exists, hiding must go through the halt path (note + notify), not a
//      silent self-serve toggle.
//   2. MANDATORY REMARK — a counterparty-visible change must carry the developer's own words explaining it.
// Both bind at EXACTLY this boundary: "does this building have an agency relationship a change could surprise?"
//
// "Has a partner" = ANY agreement (ANY status) between this developer and some agency that COVERS this building.
// Rationale (matches relationship-channel.pairHasAgreement): a declined/revoked/proposed agreement still means
// a counterparty has SEEN this building and has a stake in knowing it changed — the whole point of the rule is
// that they're not left in the dark. A building nobody has ever been agreed-to-on is a free edit (nobody to
// surprise). Reads only the agreement store (opaque ids) — no PII, nothing on-chain.

/**
 * True iff `building` has an agency RELATIONSHIP under `developer` — i.e. some agreement (any status) names
 * this developer as the inventory owner and lists this building in its clauses. The demote boundary for both
 * the visibility-toggle fence and the mandatory-remark rule. Case-insensitive; pure read over the store.
 */
export async function buildingHasPartner(developer: string, building: string): Promise<boolean> {
  const dev = developer.trim().toLowerCase();
  const bid = building.trim();
  if (!dev || !bid) return false;
  for (const g of await agreementsForParty(dev)) {
    if (g.seal.developer.toLowerCase() !== dev) continue; // dev must be the inventory owner (not the agency side)
    if (g.seal.buildings.some((b) => b.buildingId === bid)) return true;
  }
  return false;
}

// ── The MANDATORY-REMARK rule (Part A-finish §Cross-cutting invariant) ───────────────────────────────────
//
// Every counterparty-visible developer change MUST carry a non-empty remark in the developer's OWN words — the
// source of the "what happened" explanation on the surprise card (Part B), the News line (Part C), and the
// relationship channel (Part D). The rule binds ONLY where a counterparty is affected (buildingHasPartner); a
// building with no partner is administrative and needs no stated reason (design §Cross-cutting). Trimmed, with
// a reasonable max length so the feed/card copy stays sane. Not retroactive — records simply have no
// remark and fall back to the plain-verb line.

/** Max stored length of a developer's change remark (plain words; longer is truncated by the route if it
 *  chooses — this is the hard reject bound). Generous enough for a real sentence or two. */
export const REMARK_MAX = 500;

/** What a remark check returns. On block it carries the ready-to-return 400 body + status. */
export type RemarkGate =
  | { ok: true; remark: string }
  | { ok: false; status: 400; body: { error: string; code: "needs_remark" } };

/**
 * Enforce the mandatory-remark rule for a counterparty-visible change. When `building` has an agency partner,
 * a non-empty `remark` (≤ REMARK_MAX chars) is REQUIRED — reject 400 with `code: "needs_remark"` if absent. When
 * there is no partner, any remark is accepted (returned trimmed, may be empty) — the change is administrative.
 * The route calls this AFTER it knows the change is counterparty-visible and threads the returned remark into
 * the activity notice context. Reads the agreement store once (buildingHasPartner).
 */
export async function requireRemark(
  developer: string,
  building: string,
  rawRemark: unknown
): Promise<RemarkGate> {
  const remark = typeof rawRemark === "string" ? rawRemark.trim().slice(0, REMARK_MAX) : "";
  const partnered = await buildingHasPartner(developer, building);
  if (partnered && !remark) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "This building has an agency partner — add a short note saying why you're making this change.",
        code: "needs_remark",
      },
    };
  }
  return { ok: true, remark };
}

// ── The one price-direction classifier ───────────────────────────────────────────────────────────

/**
 * The single source of "which change class is a price move". new > old → priceUp (version-gated by default);
 * new < old → priceDown (self-serve); equal (or non-finite) → null (nothing changed, nothing to gate). Compares
 * the EXACT stored figures (no rounding — display rounding is a separate concern).
 */
export function classifyPriceChange(oldUsd: number, newUsd: number): "priceUp" | "priceDown" | null {
  if (!Number.isFinite(oldUsd) || !Number.isFinite(newUsd)) return null;
  if (newUsd > oldUsd) return "priceUp";
  if (newUsd < oldUsd) return "priceDown";
  return null;
}

// ── The price tool: scope + op → concrete per-unit changes ───────────────────────────────────────────────

/** WHICH units a price change targets. */
export type PriceScope = { units: string[] } | { floor: number } | { all: true };

/** HOW to change each targeted unit's price. `set` = absolute new price; `pct` = relative percent (+3 = +3%,
 * -5 = -5%); `delta` = flat +/- USD. EXACT math — the stored result is never pre-rounded. */
export type PriceOp = { set: number } | { pct: number } | { delta: number };

/** One resolved per-unit price change. `changeClass` is null when the price didn't actually move (skipped). */
export type PriceTarget = {
  id: string;
  from: number;
  to: number;
  changeClass: "priceUp" | "priceDown" | null;
};

/** Compute a unit's new EXACT price under `op`. Off-market/absent prices are left to the caller to filter. */
function applyOp(oldUsd: number, op: PriceOp): number {
  if ("set" in op) return op.set;
  if ("pct" in op) return oldUsd * (1 + op.pct / 100); // EXACT — fractions kept (invoices need them)
  return oldUsd + op.delta;
}

/** The units a scope selects from a building's inventory, in inventory order. An off-market unit is still a
 *  valid price target (a developer may reprice a withheld unit before releasing it); the route decides policy. */
function unitsInScope(building: Building, scope: PriceScope) {
  if ("units" in scope) {
    const want = new Set(scope.units.map((s) => String(s).trim()).filter(Boolean));
    return building.inventory.filter((u) => want.has(u.id));
  }
  if ("floor" in scope) return building.inventory.filter((u) => u.floor === scope.floor);
  return building.inventory.slice(); // all
}

/**
 * Resolve a {scope, op} into the concrete per-unit change list — EXACT `to` prices, each classified by
 * direction. Units whose price doesn't move (or that have no finite price) get `changeClass: null` and are
 * the caller's to skip. Pure: reads the building, computes, returns; applies nothing.
 */
export function resolvePriceTargets(building: Building, scope: PriceScope, op: PriceOp): PriceTarget[] {
  // Guard a destructive absolute set / negative result: a non-positive price is never written (a route
  // treats an empty/degenerate result as a 400). We still return it classified so the route can report it.
  return unitsInScope(building, scope).map((u) => {
    const from = u.priceUsd;
    const to = applyOp(from, op);
    return { id: u.id, from, to, changeClass: classifyPriceChange(from, to) };
  });
}

/**
 * The single ChangeClass a batch of price targets needs gating against (a batch opens ONE version).
 * A batch that raises ANY unit is a `priceUp` batch (the trust-sensitive case gates the whole thing); a batch
 * that only lowers is `priceDown`; a no-op batch (nothing moved) is null. This is what the route passes to
 * `requireEditable` and what a single covering version records.
 */
export function batchPriceClass(targets: PriceTarget[]): "priceUp" | "priceDown" | null {
  if (targets.some((t) => t.changeClass === "priceUp")) return "priceUp";
  if (targets.some((t) => t.changeClass === "priceDown")) return "priceDown";
  return null;
}

// ── The change-notice verb for each class ────────────────────────────────────────────────────────────────

/**
 * The plain `inventory.*` activity verb a route emits (via logActivity) when a change is ALLOWED, so agents
 * see a change notice and VRX sees it on the grouped oversight screen. Maps the ChangeClass to its surfaced
 * verb; the humaniser (activity-feed.ts) turns it into plain words. Structural classes share verbs where
 * the distinction doesn't matter to a viewer (a size/type/layout change reads as "updated a unit").
 */
export function inventoryVerbFor(changeClass: ChangeClass): ActivityVerb {
  switch (changeClass) {
    case "priceUp":
    case "priceDown":
      return "inventory.repriced";
    case "offMarket":
      return "inventory.off_market";
    case "withholdToggle":
      return "inventory.availability";
    case "addUnit":
      return "inventory.unit_added";
    case "removeUnit":
      return "inventory.unit_removed";
    case "sizeTypeLayout":
      return "inventory.unit_changed";
    // CHANGE-GOVERNANCE TIER-1 governance events (Slice 4): seller-entity swap / director change get their
    // own first-class governance verbs so the feed line reads "the seller company / director changed" rather than
    // the flat "updated the listing".
    case "sellerEntity":
      return "governance.seller_changed";
    case "directorChange":
      return "governance.director_changed";
    case "copy":
    case "images":
    case "terms":
    // physical/fees/land setup changes read as a listing update to a viewer (the before/after is in the evidence).
    case "physical":
    case "fees":
    case "land":
    default:
      return "inventory.listing_updated";
  }
}

// ── MATERIALITY — the TIER-2 amendment trigger (Slice 3, the design docs §Slice 3) ──
//
// Which change classes are MATERIAL to a buyer's live contract — i.e. a change entitles each buyer with a live
// deal on the building to an AMENDMENT record + an explicit dispute right (§3 TIER-2, §4 the S&P change clause).
// A material change still seals evidence + notifies (Slice 2) AND additionally files amendments (Slice 3); a
// non-material change does Slice 2 only.
//
// The rule is deliberately COARSE and BIAS-TO-EVIDENCE (: "we do NOT try to auto-detect 'it's just a
// typo' … cheap to over-notify, expensive to under-notify"). Every change to the building's physical specs,
// fees, or land is treated as material — we do NOT (yet) grade a numeric magnitude ("car-parks −1 vs losing the
// whole car park", §3). A per-field magnitude threshold is a documented refinement, intentionally NOT built
// speculatively (no spec'd numbers yet). TIER-1 governance events (sellerEntity / directorChange) are NOT an
// amendment trigger BY THEMSELVES (§3 — they are sealed events in their own right, Slice 4). Descriptive copy
// (project / directSale / copy / images) is never material.
const MATERIAL_CLASSES: ReadonlySet<ChangeClass> = new Set<ChangeClass>([
  "physical",
  "fees",
  "land",
  // the pre-existing material inventory classes also qualify (a price/size/terms change is material to a buyer):
  "priceUp",
  "sizeTypeLayout",
  "terms",
]);

/** True iff a change of this class is MATERIAL to a buyer's live contract (→ files a TIER-2 amendment + dispute
 *  right, Slice 3). See the MATERIAL_CLASSES rationale above (coarse, bias-to-evidence; no magnitude grading). */
export function isMaterialChange(changeClass: ChangeClass): boolean {
  return MATERIAL_CLASSES.has(changeClass);
}
