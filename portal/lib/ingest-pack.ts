// MM → Catalog ingest: the PURE pack reader (design: the design docs).
//
// Takes the files of an ingest-pack ZIP that MM's Export produces (../ingest-pack/README.md + schema/*)
// and assembles them into the portal catalog's Building[] shape (lib/catalog.ts). This is the
// GENERALISED, developer-facing replacement for scripts/import-drt.mjs (same output — an array of
// Building with .inventory — but the input is a pack ZIP, not hardcoded TSVs + a DEMO{} map).
//
// PURE + fixture-testable: parsePack takes an in-memory file map (path -> text) + optional media
// manifest, and returns the entity tree. No zip, no fs, no browser — unzipping is a thin wrapper above
// this (jszip) so this core stays unit-testable against ingest-pack/examples/minimal/.
//
// LAW #2 mirror: the pack is "always exportable -> always valid" on the MM side, so here we READ
// forgivingly — missing optional fields are fine, and per-row/per-building problems are COLLECTED as
// IngestError[] (so the UI can show them inline) rather than thrown. A hard-malformed pack.json (not
// valid JSON / no developer / no tree) is the one fatal case.
//
// GEOMETRY (decision, design doc §"OPEN DESIGN QUESTION"): the catalog is TABULAR — Unit carries
// sqm + staged areas, NOT a polygon. MM's metre-native footprint is drawing-board state and is stripped
// at export (same as the trace-over backdrop). So this reader consumes m² + specs + images; flowing the
// real footprint is a separate future enhancement to the pack contract (flagged, not built here).

import type { Building, PaymentTerms, Unit, UnitPlanGeometry, UnitType } from "./catalog";

// ── Pack-manifest shapes (a structural read of pack.json / building.json — see ingest-pack/schema/*). We
//    read the fields we map; unknown fields are ignored (forward-compatible). ─────────────────────────
export interface PackDeveloper {
  id: string;
  name: string;
  holdingCompany?: string;
  nearAccount?: string;
  logo?: string;
}

export interface PackComplex {
  id: string;
  name: string;
  companyId?: string;
  area?: string;
  amenities?: string[];
  buildings: string[];
}

export interface PackManifest {
  schemaVersion?: string;
  generatedAt?: string;
  generatedBy?: string;
  developer: PackDeveloper;
  companies?: { id: string; name: string; registration?: string }[];
  tree: { complexes: PackComplex[] };
  checksums?: Record<string, string>;
}

/** The parsed pack, in the catalog's own vocabulary — ready to stage into the store. */
export interface IngestResult {
  developer: PackDeveloper;
  complexes: PackComplex[];
  buildings: Building[];
  /** Resolved reusable terms blocks keyed by id (terms/<id>.json), for reference/debug. */
  terms: Record<string, PaymentTerms>;
  errors: IngestError[];
}

export interface IngestError {
  /** Where the problem is — a pack path, a building id, or a units.csv row. */
  where: string;
  message: string;
}

// ── small, correct CSV reader (the portal has none; MM's parseUnitsCsv lives in the separate mm app). It
//    honours double-quoted fields with embedded commas/quotes — the same contract serializeUnitsCsv emits. ──
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function toNumber(v: string): number | undefined {
  if (v === "" || v == null) return undefined;
  const n = Number(v.replace(/,/g, "")); // tolerate thousands separators
  return Number.isFinite(n) ? n : undefined;
}

function toBool(v: string): boolean | undefined {
  const s = (v || "").toLowerCase();
  if (s === "true" || s === "yes" || s === "1") return true;
  if (s === "false" || s === "no" || s === "0" || s === "") return false;
  return undefined;
}

/**
 * Parse one building's units.csv into Unit[] (columns per ingest-pack/schema/unit.columns.md, 1:1 with
 * catalog.Unit). Collects row problems into `errors` (keyed to the building) rather than throwing — a pack
 * always imports; bad rows are surfaced, not fatal. termsRef resolves to a per-unit terms override.
 */
export function parseUnitsCsv(
  text: string,
  buildingId: string,
  terms: Record<string, PaymentTerms>,
  errors: IngestError[],
): Unit[] {
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    errors.push({ where: `buildings/${buildingId}/units.csv`, message: "empty units.csv" });
    return [];
  }
  const headers = splitCsvLine(lines[0]);
  const idx = (name: string) => headers.indexOf(name);
  const units: Unit[] = [];

  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]);
    const get = (name: string): string => {
      const i = idx(name);
      return i >= 0 && i < cells.length ? cells[i] : "";
    };
    const where = `buildings/${buildingId}/units.csv row ${r}`;

    const id = get("id");
    const type = get("type");
    const floor = toNumber(get("floor"));
    const sqm = toNumber(get("sqm"));
    const priceUsd = toNumber(get("priceUsd"));
    if (!id) errors.push({ where, message: "missing id" });
    if (!type) errors.push({ where, message: "missing type" });
    if (floor == null) errors.push({ where, message: "missing/invalid floor" });
    if (sqm == null) errors.push({ where, message: "missing/invalid sqm" });
    if (priceUsd == null) errors.push({ where, message: "missing/invalid priceUsd" });

    const sqmBefore = toNumber(get("sqmBefore"));
    const sqmAfter = toNumber(get("sqmAfter"));
    const sqmFinal = toNumber(get("sqmFinal"));
    const sqmStages = (sqmBefore != null || sqmAfter != null || sqmFinal != null)
      ? { beforeBuilding: sqmBefore, afterBuilding: sqmAfter, final: sqmFinal }
      : undefined;

    const freeholdUsd = toNumber(get("priceFreehold"));
    const companyUsd = toNumber(get("priceCompany"));
    const pricing = (freeholdUsd != null || companyUsd != null) ? { freeholdUsd, companyUsd } : undefined;

    const termsRef = get("termsRef") || undefined;
    const termsOverride = termsRef ? terms[termsRef] : undefined;
    if (termsRef && !termsOverride) {
      errors.push({ where, message: `termsRef "${termsRef}" has no terms/${termsRef}.json` });
    }

    const unit: Unit = {
      id,
      type,
      floor: floor ?? 0,
      sqm: sqm ?? 0,
      priceUsd: priceUsd ?? 0,
      subtype: get("subtype") || undefined,
      unitNumber: toNumber(get("unitNumber")),
      sqmStages,
      pricing,
      view: get("view") || undefined,
      corner: toBool(get("corner")),
      baths: toNumber(get("baths")),
      note: get("note") || undefined,
      terms: termsOverride,
    };
    // strip undefined so the stored JSON stays clean (matches import-drt's generous-but-tidy output)
    for (const k of Object.keys(unit) as (keyof Unit)[]) if (unit[k] === undefined) delete unit[k];
    units.push(unit);
  }
  return units;
}

/** Derive the UnitType[] (key/label/sqm range) from the parsed inventory when building.json omits it. */
function deriveUnitTypes(units: Unit[]): UnitType[] {
  const byKey = new Map<string, { label: string; min: number; max: number }>();
  for (const u of units) {
    const cur = byKey.get(u.type) || { label: u.type, min: Infinity, max: 0 };
    cur.min = Math.min(cur.min, u.sqm);
    cur.max = Math.max(cur.max, u.sqm);
    byKey.set(u.type, cur);
  }
  return [...byKey.entries()].map(([key, v]) => ({
    key,
    label: v.label,
    sqmMin: Math.round(v.min === Infinity ? 0 : v.min),
    sqmMax: Math.round(v.max),
  }));
}

/**
 * Extract true-shape unit geometry from a building.json's unitTypes[].subtypes[].plan. The MM pack
 * now carries the per-subtype plan FOOTPRINT (+ markers; backdrop stripped at export). We flatten it to the
 * catalog's {type, subtype}-keyed UnitPlanGeometry[]. A subtype with no poly plan is skipped. Absent/empty
 * -> undefined (tabular-only building). Defensive: only a valid poly footprint with points is carried.
 */
function extractUnitPlans(bj: Record<string, unknown>): UnitPlanGeometry[] | undefined {
  if (!Array.isArray(bj.unitTypes)) return undefined;
  const plans: UnitPlanGeometry[] = [];
  for (const t of bj.unitTypes as Record<string, unknown>[]) {
    const typeKey = typeof t?.key === "string" ? t.key : undefined;
    const subtypes = Array.isArray(t?.subtypes) ? (t.subtypes as Record<string, unknown>[]) : [];
    if (!typeKey) continue;
    for (const s of subtypes) {
      const plan = s?.plan as Record<string, unknown> | undefined;
      const fp = plan?.footprint as Record<string, unknown> | undefined;
      if (!fp || fp.shape !== "poly" || !Array.isArray(fp.points) || fp.points.length < 3) continue;
      const geom: UnitPlanGeometry = {
        type: typeKey,
        subtype: typeof s.key === "string" ? s.key : undefined,
        footprint: {
          shape: "poly",
          points: fp.points as Array<{ x: number; y: number }>,
          pointsM: Array.isArray(fp.pointsM) ? (fp.pointsM as Array<{ x: number; y: number }>) : undefined,
          frozenVerts: Array.isArray(fp.frozenVerts) ? (fp.frozenVerts as number[]) : undefined,
          frozenEdges: Array.isArray(fp.frozenEdges) ? (fp.frozenEdges as number[]) : undefined,
        },
        markers: Array.isArray(plan?.markers) ? (plan!.markers as UnitPlanGeometry["markers"]) : undefined,
      };
      for (const k of Object.keys(geom.footprint) as (keyof typeof geom.footprint)[]) {
        if (geom.footprint[k] === undefined) delete geom.footprint[k];
      }
      if (geom.subtype === undefined) delete geom.subtype;
      if (geom.markers === undefined) delete geom.markers;
      plans.push(geom);
    }
  }
  return plans.length ? plans : undefined;
}

/**
 * Build one catalog Building from its building.json + parsed units. Mirrors import-drt.mjs's building
 * assembly (same output Building shape), but reads the pack's building.json instead of a DEMO{} map.
 * Missing display fields backfill from the id / developer name so the result always renders.
 */
function assembleBuilding(
  bj: Record<string, unknown>,
  buildingId: string,
  units: Unit[],
  developerName: string,
  terms: Record<string, PaymentTerms>,
  errors: IngestError[],
): Building {
  const str = (k: string, fallback = ""): string => {
    const v = bj[k];
    return typeof v === "string" && v.length ? v : fallback;
  };
  const num = (k: string): number | undefined => {
    const v = bj[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };

  // unitTypes: prefer the authored list in building.json, else derive from the inventory. PROJECT to the clean
  // catalog UnitType shape (key/label/sqm range/floorplan) — the MM pack's unitTypes also carry `subtypes[].plan`
  // geometry, but that flows into the dedicated `unitPlans[]` carrier (extractUnitPlans), NOT leaked raw here.
  const authoredTypes = Array.isArray(bj.unitTypes)
    ? (bj.unitTypes as Record<string, unknown>[])
        .filter((t) => !!t && typeof t.key === "string")
        .map((t): UnitType => {
          const ut: UnitType = {
            key: t.key as string,
            label: typeof t.label === "string" ? t.label : (t.key as string),
            sqmMin: typeof t.sqmMin === "number" ? t.sqmMin : 0,
            sqmMax: typeof t.sqmMax === "number" ? t.sqmMax : 0,
          };
          if (typeof t.floorplan === "string") ut.floorplan = t.floorplan;
          return ut;
        })
    : undefined;
  const unitTypes = authoredTypes && authoredTypes.length ? authoredTypes : deriveUnitTypes(units);

  // building-default terms: a building may reference a shared terms block via termsRef.
  const termsRef = str("termsRef") || undefined;
  const buildingTerms = termsRef ? terms[termsRef] : undefined;
  if (termsRef && !buildingTerms) {
    errors.push({ where: `buildings/${buildingId}/building.json`, message: `termsRef "${termsRef}" has no terms/${termsRef}.json` });
  }

  const b: Building = {
    id: buildingId,
    name: str("name", buildingId),
    tagline: str("tagline"),
    developer: str("developer", developerName),
    area: str("area"),
    address: str("address"),
    type: str("type", "High Rise"),
    stories: num("stories") ?? 0,
    units: units.length,
    reservationFeeUsd: num("reservationFeeUsd") ?? num("bookingDepositUsd") ?? 0,
    maintenancePerSqmUsd: num("maintenancePerSqmUsd") ?? 0,
    amenities: Array.isArray(bj.amenities) ? (bj.amenities as string[]) : [],
    completion: str("completion"),
    unitTypes,
    unitPlans: extractUnitPlans(bj),
    inventory: units,
    terms: buildingTerms,
    bookingDepositUsd: num("bookingDepositUsd"),
    sinkingFundPerSqmUsd: num("sinkingFundPerSqmUsd"),
    transferFeePct: str("transferFeePct") || undefined,
    constructionEnd: str("constructionEnd") || undefined,
  };

  // quota — building.json may carry a `quota` block (schema building.schema.json). Map the figures
  // the catalog reads directly; absent = quota not tracked (behaves exactly as before).
  const quota = bj.quota as Record<string, unknown> | undefined;
  if (quota && typeof quota === "object") {
    const qnum = (k: string): number | undefined => (typeof quota[k] === "number" ? (quota[k] as number) : undefined);
    const summed = Math.round(units.reduce((n, u) => n + (u.sqm || 0), 0));
    b.sellableSqm = qnum("sellableSqm") ?? (summed > 0 ? Math.round(summed / 100) * 100 : undefined);
    b.foreignQuotaPct = qnum("foreignQuotaPct") ?? qnum("pct") ?? 49;
    const stage = quota.stage;
    if (stage === "presale" || stage === "built" || stage === "final") b.stage = stage;
    const soldSqm = qnum("foreignSoldSqm");
    if (soldSqm != null) b.foreignSoldSqm = soldSqm;
    const committed = qnum("foreignCommittedSqm");
    if (committed != null) b.foreignCommittedSqm = committed;
    const local = qnum("localSoldSqm");
    if (local != null) b.localSoldSqm = local;
    const labels = quota.labels;
    if (labels && typeof labels === "object") b.quotaLabels = labels as Building["quotaLabels"];
  }

  for (const k of Object.keys(b) as (keyof Building)[]) if (b[k] === undefined) delete b[k];
  return b;
}

/**
 * Parse an entire ingest-pack from an in-memory file map (path -> text). PURE: no zip, no fs. The unzip
 * step feeds this (jszip wrapper above). Media is passed as a manifest of available paths (the reader
 * doesn't need the bytes — it only validates slot presence); bytes are wired at the staging step.
 *
 * @param files  relative-path -> UTF-8 text (pack.json, building.json, units.csv, terms/*.json, matrix.csv)
 * @param mediaPaths  optional list of media relative-paths present in the pack (for slot-presence notes)
 */
export function parsePack(files: Record<string, string>, mediaPaths: string[] = []): IngestResult {
  const errors: IngestError[] = [];

  const manifestText = files["pack.json"];
  if (!manifestText) throw new Error("ingest-pack: pack.json missing");
  let manifest: PackManifest;
  try {
    manifest = JSON.parse(manifestText) as PackManifest;
  } catch (e) {
    throw new Error(`ingest-pack: pack.json is not valid JSON (${(e as Error).message})`);
  }
  if (!manifest.developer || !manifest.developer.id) throw new Error("ingest-pack: pack.json missing developer");
  if (!manifest.tree || !Array.isArray(manifest.tree.complexes)) throw new Error("ingest-pack: pack.json missing tree.complexes");

  // reusable terms blocks (terms/<id>.json) -> PaymentTerms keyed by id.
  const terms: Record<string, PaymentTerms> = {};
  for (const [path, text] of Object.entries(files)) {
    const m = path.match(/^terms\/(.+)\.json$/);
    if (!m) continue;
    try {
      const { _comment, ...data } = JSON.parse(text) as Record<string, unknown>;
      void _comment;
      terms[m[1]] = data as unknown as PaymentTerms;
    } catch (e) {
      errors.push({ where: path, message: `invalid terms JSON (${(e as Error).message})` });
    }
  }

  // every building declared across all complexes (the tree is the source of which buildings exist).
  const buildings: Building[] = [];
  const seen = new Set<string>();
  for (const cx of manifest.tree.complexes) {
    for (const buildingId of cx.buildings || []) {
      if (seen.has(buildingId)) continue; // a building belongs to one complex; de-dup defensively
      seen.add(buildingId);

      const bjText = files[`buildings/${buildingId}/building.json`];
      if (!bjText) {
        errors.push({ where: `complex ${cx.id}`, message: `building "${buildingId}" declared but buildings/${buildingId}/building.json missing` });
        continue;
      }
      let bj: Record<string, unknown>;
      try {
        bj = JSON.parse(bjText) as Record<string, unknown>;
      } catch (e) {
        errors.push({ where: `buildings/${buildingId}/building.json`, message: `invalid JSON (${(e as Error).message})` });
        continue;
      }

      const csvText = files[`buildings/${buildingId}/units.csv`] || "";
      const units = csvText
        ? parseUnitsCsv(csvText, buildingId, terms, errors)
        : [];
      if (!csvText) errors.push({ where: `buildings/${buildingId}`, message: "no units.csv (building imported with 0 units)" });

      buildings.push(assembleBuilding(bj, buildingId, units, manifest.developer.name, terms, errors));
    }
  }
  void mediaPaths; // reserved for the staging step's slot-presence check (bytes wired there)

  // biggest building first (matches import-drt's flagships-up-top ordering).
  buildings.sort((a, b) => b.inventory.length - a.inventory.length);

  return { developer: manifest.developer, complexes: manifest.tree.complexes, buildings, terms, errors };
}

// ── the thin unzip wire (step 2) ─────────────────────────────────────────────────────────────────────
/** A pack ZIP split into its text files + media bytes (what the reader + the staging step consume). */
export interface UnpackedPack {
  /** relative-path -> UTF-8 text (pack.json, building.json, units.csv, terms/*.json, matrix.csv, *.html). */
  files: Record<string, string>;
  /** relative-path -> raw bytes (images under the buildings and complexes media folders). */
  media: Record<string, Uint8Array>;
}

/** Is this entry a text file we read as UTF-8 (vs a media blob we keep as bytes)? */
function isTextEntry(path: string): boolean {
  return /\.(json|csv|html|md|txt|svg)$/i.test(path);
}

/**
 * Unzip an ingest-pack ZIP into text files + media bytes. jszip is already a dependency; imported lazily
 * so the PURE parsePack path (and its test) never needs it. Browser + Node (18+) safe. The SVG placeholder
 * backfills are text but live under media/ — treated as media bytes is fine (the reader ignores media
 * content), but we classify by extension so .svg stays text if ever read; media paths are collected for
 * the staging slot-presence check.
 */
export async function unzipPack(zipBytes: Uint8Array | ArrayBuffer): Promise<UnpackedPack> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(zipBytes);
  const files: Record<string, string> = {};
  const media: Record<string, Uint8Array> = {};
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  await Promise.all(entries.map(async (e) => {
    // media images (jpg/png/webp) under media/ -> bytes; everything else -> text. SVG placeholders are
    // media-slot content too, so route anything under a media/ folder that isn't a known text doc to bytes.
    const isMediaImage = /\/media\//.test(e.name) && !/\.(json|csv|html|md|txt)$/i.test(e.name);
    if (isTextEntry(e.name) && !isMediaImage) files[e.name] = await e.async("string");
    else media[e.name] = await e.async("uint8array");
  }));
  return { files, media };
}

/** Full path: ZIP bytes -> parsed catalog entities. Unzips then runs the pure reader. */
export async function parsePackZip(zipBytes: Uint8Array | ArrayBuffer): Promise<IngestResult> {
  const { files, media } = await unzipPack(zipBytes);
  return parsePack(files, Object.keys(media));
}

// ── the write primitive (step 3): merge an imported pack's buildings into the catalog (PURE) ───────────
export interface StageResult {
  /** The merged catalog list (existing with incoming buildings superseding by id, then new ones appended). */
  merged: Building[];
  /** Ids that REPLACED an existing catalog building (e.g. the pack's skyline-tower supersedes the DB seed). */
  superseded: string[];
  /** Ids that were ADDED (no prior building with that id). */
  added: string[];
}

/**
 * Merge a parsed pack's buildings into an existing catalog list, BY ID. A pack is the authoritative source
 * for any building it declares, so an incoming building REPLACES an existing one with the same id (the
 * design's dedup: the MM Skyline pack supersedes the DB-seeded skyline-tower) and a new id is appended.
 *
 * PURE — returns the merged list + a report; it does NOT persist. Persistence/activation is the caller's
 * job (the README's staged-then-root-activates flow). Keeping this pure makes the supersede/add behaviour
 * unit-testable and lets a future staging store, an admin preview, or a direct seed-write all reuse it.
 */
export function stageIntoCatalog(existing: Building[], incoming: Building[]): StageResult {
  const byId = new Map(existing.map((b) => [b.id, b]));
  const superseded: string[] = [];
  const added: string[] = [];
  for (const b of incoming) {
    if (byId.has(b.id)) superseded.push(b.id);
    else added.push(b.id);
    byId.set(b.id, b);
  }
  // preserve existing order, then append the genuinely-new buildings (biggest-first already applied upstream).
  const merged: Building[] = existing.map((b) => byId.get(b.id)!);
  for (const id of added) merged.push(byId.get(id)!);
  return { merged, superseded, added };
}
