// Pack validation — checks a Pack against the ingest-pack schema rules (../ingest-pack/schema/*).
//
// Returns STRUCTURED findings, not throws: the Structured face's validation rail renders greens/reds and
// "N rows need fix". Severity split (law #2 "always exportable"):
//   - "error"   = would make the EXPORTED pack invalid against the JSON schema (blocks a CLEAN export,
//                 though export still runs with backfill — see export.ts; errors are surfaced, not fatal).
//   - "warning" = recommended-but-optional per the schema/columns (e.g. missing subtype, no media).
//
// Plain predicate checks (house style — no JSON-schema lib; mirrors the lib/*.test.ts convention).

import type { Pack, Unit } from "./pack";

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  where: string; // human path, e.g. "building:riverside-north / unit row 2"
  field?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean; // no errors (warnings allowed)
  findings: Finding[];
  counts: { errors: number; warnings: number };
}

const ID_RE = /^[a-z0-9-]+$/;
const BUILDING_TYPES = ["High Rise", "Low Rise"]; // enum documents common values; free label in practice

function idOk(s: string | undefined): boolean {
  return !!s && ID_RE.test(s);
}

/** Validate the required + recommended unit columns (unit.columns.md). */
function validateUnit(u: Unit, where: string, out: Finding[]): void {
  if (!u.id) out.push({ severity: "error", where, field: "id", message: "unit id is required" });
  if (!u.type) out.push({ severity: "error", where, field: "type", message: "unit type is required" });
  if (u.floor == null || !Number.isFinite(u.floor))
    out.push({ severity: "error", where, field: "floor", message: "floor is required (integer)" });
  if (u.sqm == null || !(u.sqm > 0))
    out.push({ severity: "error", where, field: "sqm", message: "sqm is required (> 0)" });
  if (u.priceUsd == null || !(u.priceUsd >= 0))
    out.push({ severity: "error", where, field: "priceUsd", message: "priceUsd is required (>= 0)" });
  // recommended
  if (!u.subtype)
    out.push({ severity: "warning", where, field: "subtype", message: "subtype recommended (selects the floor plan with type)" });
  if (u.unitNumber == null)
    out.push({ severity: "warning", where, field: "unitNumber", message: "unitNumber recommended" });
}

export function validatePack(pack: Pack): ValidationResult {
  const findings: Finding[] = [];

  // developer
  if (!pack.developer.name)
    findings.push({ severity: "error", where: "developer", field: "name", message: "developer name is required" });
  if (!idOk(pack.developer.id))
    findings.push({ severity: "error", where: "developer", field: "id", message: "developer id must match ^[a-z0-9-]+$" });

  // companies
  for (const c of pack.companies) {
    if (!c.name) findings.push({ severity: "error", where: `company:${c.id}`, field: "name", message: "company name is required" });
    if (!idOk(c.id)) findings.push({ severity: "error", where: `company:${c.id}`, field: "id", message: "company id must match ^[a-z0-9-]+$" });
  }

  // complexes + building-id references
  const buildingIds = new Set(pack.buildings.map((b) => b.id));
  for (const cx of pack.complexes) {
    if (!cx.name) findings.push({ severity: "error", where: `complex:${cx.id}`, field: "name", message: "complex name is required" });
    if (!idOk(cx.id)) findings.push({ severity: "error", where: `complex:${cx.id}`, field: "id", message: "complex id must match ^[a-z0-9-]+$" });
    for (const bid of cx.buildings) {
      if (!buildingIds.has(bid))
        findings.push({ severity: "error", where: `complex:${cx.id}`, field: "buildings", message: `references building "${bid}" which has no building.json` });
    }
  }

  // buildings
  const complexIds = new Set(pack.complexes.map((c) => c.id));
  const termIds = new Set(pack.terms.map((t) => t.id));
  for (const b of pack.buildings) {
    const where = `building:${b.id}`;
    if (!idOk(b.id)) findings.push({ severity: "error", where, field: "id", message: "building id must match ^[a-z0-9-]+$" });
    if (!b.name) findings.push({ severity: "error", where, field: "name", message: "building name is required" });
    if (!b.complexId || !complexIds.has(b.complexId))
      findings.push({ severity: "error", where, field: "complexId", message: "building must reference an existing complex" });
    if (!b.type) findings.push({ severity: "error", where, field: "type", message: "building type is required" });
    else if (!BUILDING_TYPES.includes(b.type))
      findings.push({ severity: "warning", where, field: "type", message: `type "${b.type}" is not a common value (${BUILDING_TYPES.join(" / ")})` });
    if (b.stories == null || !(b.stories >= 1))
      findings.push({ severity: "error", where, field: "stories", message: "stories is required (>= 1)" });
    if (b.termsRef && !termIds.has(b.termsRef))
      findings.push({ severity: "error", where, field: "termsRef", message: `references terms "${b.termsRef}" with no terms/<id>.json` });

    // units for this building
    const rows = pack.buildingUnits[b.id] || [];
    if (rows.length === 0)
      findings.push({ severity: "warning", where, message: "building has no units yet" });
    const seen = new Set<string>();
    rows.forEach((u, i) => {
      validateUnit(u, `${where} / unit row ${i + 1}`, findings);
      if (u.id) {
        if (seen.has(u.id))
          findings.push({ severity: "error", where: `${where} / unit row ${i + 1}`, field: "id", message: `duplicate unit id "${u.id}" within the building` });
        seen.add(u.id);
      }
      if (u.termsRef && !termIds.has(u.termsRef))
        findings.push({ severity: "error", where: `${where} / unit row ${i + 1}`, field: "termsRef", message: `references terms "${u.termsRef}" with no terms/<id>.json` });
    });
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  return { ok: errors === 0, findings, counts: { errors, warnings } };
}
