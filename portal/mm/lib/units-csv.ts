// units.csv <-> Unit[] — the bulk inventory interchange (../ingest-pack/schema/unit.columns.md).
//
// UTF-8, header row required, comma-separated. Columns map 1:1 to lib/pack Unit. parse is forgiving
// (collects per-row errors for the validation rail); serialize emits the canonical column order the
// VRX importer expects. No CSV lib — a small correct parser that handles quoted fields + commas.

import type { Unit } from "./pack";

// Canonical column order (unit.columns.md). serialize always writes this header.
export const UNIT_COLUMNS = [
  "id", "type", "subtype", "floor", "unitNumber", "sqm",
  "sqmBefore", "sqmAfter", "sqmFinal", "priceUsd", "priceFreehold", "priceCompany",
  "view", "corner", "baths", "note", "termsRef",
] as const;

export interface CsvRowError {
  row: number; // 1-based data row (header excluded)
  column?: string;
  message: string;
}

export interface CsvParseResult {
  units: Unit[];
  errors: CsvRowError[];
  headers: string[];
}

/** Split one CSV line into fields, honouring double-quoted fields with embedded commas/quotes. */
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
  const s = v.toLowerCase();
  if (s === "true" || s === "yes" || s === "1") return true;
  if (s === "false" || s === "no" || s === "0" || s === "") return false;
  return undefined;
}

/**
 * Parse a units.csv string. Maps known headers to Unit fields by NAME (column-mapping is forgiving:
 * unknown headers are ignored; order doesn't matter). Required-field problems become CsvRowErrors so the
 * UI can show them inline; validatePack re-checks on the assembled Pack too.
 */
export function parseUnitsCsv(text: string): CsvParseResult {
  const errors: CsvRowError[] = [];
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { units: [], errors: [{ row: 0, message: "empty CSV" }], headers: [] };

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => headers.indexOf(name);
  const units: Unit[] = [];

  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]);
    const get = (name: string): string => {
      const i = idx(name);
      return i >= 0 && i < cells.length ? cells[i] : "";
    };
    const rowNo = r; // 1-based data row

    const floor = toNumber(get("floor"));
    const sqm = toNumber(get("sqm"));
    const priceUsd = toNumber(get("priceUsd"));

    const id = get("id");
    const type = get("type");
    if (!id) errors.push({ row: rowNo, column: "id", message: "missing id" });
    if (!type) errors.push({ row: rowNo, column: "type", message: "missing type" });
    if (floor == null) errors.push({ row: rowNo, column: "floor", message: "missing/invalid floor" });
    if (sqm == null) errors.push({ row: rowNo, column: "sqm", message: "missing/invalid sqm" });
    if (priceUsd == null) errors.push({ row: rowNo, column: "priceUsd", message: "missing/invalid priceUsd" });

    const unit: Unit = {
      id,
      type,
      subtype: get("subtype") || undefined,
      floor: floor ?? 0,
      unitNumber: toNumber(get("unitNumber")),
      sqm: sqm ?? 0,
      sqmBefore: toNumber(get("sqmBefore")),
      sqmAfter: toNumber(get("sqmAfter")),
      sqmFinal: toNumber(get("sqmFinal")),
      priceUsd: priceUsd ?? 0,
      priceFreehold: toNumber(get("priceFreehold")),
      priceCompany: toNumber(get("priceCompany")),
      view: get("view") || undefined,
      corner: toBool(get("corner")),
      baths: toNumber(get("baths")),
      note: get("note") || undefined,
      termsRef: get("termsRef") || undefined,
    };
    units.push(unit);
  }

  return { units, errors, headers };
}

/** Escape one CSV field (quote if it contains comma/quote/newline). */
function csvField(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Serialize Unit[] back to a canonical units.csv string (header + rows, UNIT_COLUMNS order). */
export function serializeUnitsCsv(units: Unit[]): string {
  const header = UNIT_COLUMNS.join(",");
  const rows = units.map((u) =>
    UNIT_COLUMNS.map((col) => {
      const v = (u as unknown as Record<string, unknown>)[col];
      if (typeof v === "boolean") return v ? "true" : "false";
      return csvField(v);
    }).join(",")
  );
  return [header, ...rows].join("\n") + "\n";
}
