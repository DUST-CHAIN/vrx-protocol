// Building-Setup payload validation for POST /api/catalog/building-setup. Lives in lib/ (not the
// route file) because a Next route module may only export HTTP handlers + known config — extra exports break
// the generated route type (the lesson catalog-geo.ts / catalog-terms.ts record). Pure functions, unit-tested
// in lib/catalog-building-setup.test.ts.
//
// Each of the four groups (project / physical / fees / land) is section-scoped and absent-safe: a group that
// normalises to nothing returns null = CLEAR it. Every field is optional; blanks never persist as "". The
// setup is PUBLIC building context (family), not PII — the seller-entity identity block is a separate
// reusable record (lib/seller-entities), referenced by id, NOT cleaned here.

import type { BuildingProject, BuildingPhysical, BuildingFees, BuildingLand, BuildingDirectSale } from "@/lib/catalog";

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s === "" ? undefined : s;
};

/** A non-negative integer (car parks, CAM months, complete-within-months), or undefined. Throws if present
 *  but not a finite non-negative number. */
function nonNegInt(v: unknown, field: string): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field} must be a non-negative number`);
  return Math.round(n);
}

/** A non-negative money figure (sinking fund /m²), or undefined. */
function nonNegNum(v: unknown, field: string): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field} must be a non-negative number`);
  return Math.round(n);
}

/** Collapse an object to null if every value is undefined (an empty group = cleared). */
function orNull<T extends object>(obj: T): T | null {
  return Object.values(obj).some((v) => v !== undefined) ? obj : null;
}

export function cleanProject(raw: unknown): BuildingProject | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let status: BuildingProject["status"];
  const s = str(r.status, 20);
  if (s === "planning" || s === "building" || s === "complete") status = s;
  else if (s != null) throw new Error("status must be planning, building, or complete");
  const out: BuildingProject = {
    startConst: str(r.startConst, 80),
    endConst: str(r.endConst, 80),
    completeWithinMonths: nonNegInt(r.completeWithinMonths, "completeWithinMonths"),
    phase: str(r.phase, 80),
    status,
  };
  return orNull(stripUndefined(out));
}

export function cleanPhysical(raw: unknown): BuildingPhysical | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: BuildingPhysical = {
    landArea: str(r.landArea, 120),
    carParks: nonNegInt(r.carParks, "carParks"),
    floorToCeiling: str(r.floorToCeiling, 40),
  };
  return orNull(stripUndefined(out));
}

export function cleanFees(raw: unknown): BuildingFees | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: BuildingFees = {
    sinkingFundPerSqmUsd: nonNegNum(r.sinkingFundPerSqmUsd, "sinkingFundPerSqmUsd"),
    camAdvanceMonths: nonNegInt(r.camAdvanceMonths, "camAdvanceMonths"),
  };
  return orNull(stripUndefined(out));
}

export function cleanLand(raw: unknown): BuildingLand | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: BuildingLand = {
    titleDeedNum: str(r.titleDeedNum, 120),
    surveyPageNum: str(r.surveyPageNum, 120),
    landNumber: str(r.landNumber, 120),
    address: str(r.address, 400),
    addressTH: str(r.addressTH, 400),
    clauseText: str(r.clauseText, 8000),
  };
  return orNull(stripUndefined(out));
}

/** Direct-Sales Desk visibility (§9 step 2). visible is a hard boolean (coerced from the toggle);
 *  funnelCopy is optional prose. Returns null ONLY when not visible AND no copy — i.e. nothing to store =
 *  invisible (fail-closed default-deny). A building with visible:true persists even with no copy. */
export function cleanDirectSale(raw: unknown): BuildingDirectSale | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const visible = r.visible === true || r.visible === "true";
  const funnelCopy = str(r.funnelCopy, 2000);
  if (!visible && funnelCopy === undefined) return null; // nothing to store → invisible
  const out: BuildingDirectSale = { visible };
  if (funnelCopy !== undefined) out.funnelCopy = funnelCopy;
  return out;
}

/** Drop undefined keys so a cleared field vanishes from stored JSON (no `"x": undefined` noise). */
function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** Which section a building-setup POST targets. (`sellerEntity` + `directSale` are handled inline in the
 *  route, not via a cleanX here: sellerEntity attaches an id, directSale uses cleanDirectSale.) */
export type BuildingSetupSection = "project" | "physical" | "fees" | "land";

export const BUILDING_SETUP_SECTIONS: readonly BuildingSetupSection[] = ["project", "physical", "fees", "land"];

// ── CHANGE GOVERNANCE — TIER 0 immutable land anchors (the design docs §3) ────────────
// The land legal-identity fields a title deed + S&P are written against. Once a building has an agency partner
// these are NOT self-editable — a genuine typo is fixed through a VRX-reviewed correction (next arc), never a
// silent self-serve edit (which is indistinguishable from fraud). `clauseText` is deliberately NOT here: the
// free-text legal clause is editable prose, not a fixed identifier.
export const TIER0_LAND_FIELDS = ["titleDeedNum", "surveyPageNum", "landNumber", "address", "addressTH"] as const;

/** True iff the incoming `land` data CHANGES or CLEARS an already-set Tier-0 field (vs its current stored
 *  value). First-time population of an EMPTY field is allowed (completing the record); only mutating/clearing
 *  an existing legal anchor counts. Trimmed string compare. Pure — the route calls it; a test freezes it. */
export function isTier0LandEdit(current: Record<string, unknown> | undefined, incoming: unknown): boolean {
  const inc = (incoming && typeof incoming === "object" ? incoming : {}) as Record<string, unknown>;
  const cur = (current ?? {}) as Record<string, unknown>;
  const norm = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
  for (const f of TIER0_LAND_FIELDS) {
    // Only judge a field the payload actually PROVIDES — an omitted key is "unchanged", not "cleared" (a
    // partial save must not read as wiping anchors it didn't mention). Explicit empty-string IS a clear.
    if (!(f in inc)) continue;
    const was = norm(cur[f]);
    const now = norm(inc[f]);
    if (was !== "" && now !== was) return true; // changed or cleared an existing anchor
  }
  return false;
}
