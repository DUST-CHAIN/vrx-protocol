// Pricelist — the human-readable PRICED projection of a building's units (: "mm also needs to output
// a pricelist", ported from the operator catalog's "Matrix / Price list" PDF).
//
// WHAT the operator catalog'S PRICELIST IS (read from drt/protected/controllers/UnitreportController.php + the output PDFs
// drt/pricelist/public/*.pdf): a per-building sales document — every unit as a priced row (floor · unit no ·
// type · sqm · price · status), under a building header, with a level plan + a status legend. the operator catalog also renders
// the floor×column STACKING GRID (its `matrix/1.csv`) — MM already projects THAT (lib/matrix.ts, serialized to
// matrix.csv in the export). What was MISSING was the READABLE PRICED TABLE a developer hands to buyers. This
// module adds exactly that, as a sibling projection of the same units — nothing authored twice (reuse-pattern).
//
// TWO OUTPUTS, both PURE (Pack + buildingId -> text), unit-testable with no browser (same house style as
// units-csv.ts / matrix.ts):
//   1. serializePricelistCsv — the priced rows as CSV (data interchange / spreadsheet).
//   2. pricelistHtml — a self-contained printable HTML document (the "PDF" via the browser's Print-to-PDF; no
//  heavy PDF dep, matches how the operator catalog's end artifact is a printable sheet). Carries only CAPABILITY data — unit
//      inventory + prices — never PII.
//
// HONEST BOUNDARY: a generated pricelist is a DEMO / MARKETING sheet of the authored pack, not a signed offer.

import type { Building, Pack, Unit } from "./pack";
import { unitSqm } from "./pack";

export interface PricelistRow {
  unitNumber: string; // unit no (unitNumber || id)
  floor: number;
  type: string; // subtype || type (human label)
  sqm: number;
  priceUsd: number;
  pricePerSqmUsd: number; // derived (priceUsd / sqm), rounded
  view: string; // "" when none
  status: string; // "Available" by default (MM packs don't carry live sale status; demo sheet)
}

/** Currency: USD, no cents (pricelists quote whole dollars). Thousands separators for readability. */
export function usd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** The one display label for a unit's type (prefer the human subtype, else the type key upper-cased). */
function typeLabel(u: Unit): string {
  const sub = (u.subtype || "").trim();
  if (sub) return sub;
  const t = (u.type || "").trim();
  return t ? t.toUpperCase() : "Unit";
}

/**
 * The priced rows for one building, ordered floor-DESCENDING then unit number (how a pricelist reads — top
 * floor / premium first). PURE: a pure projection of pack.buildingUnits[buildingId]. $/sqm is derived.
 */
export function pricelistRows(pack: Pack, buildingId: string): PricelistRow[] {
  const units = pack.buildingUnits[buildingId] || [];
  return units
    .map((u): PricelistRow => {
      //  the authoritative size = land-office legal ?? architect ?? current sqm — so $/m² reflects the most
      // legally-correct measurement available (the drawn polygon never prices). See pack.unitSqm.
      const sqm = unitSqm(u);
      return {
        unitNumber: u.unitNumber != null ? String(u.unitNumber) : u.id,
        floor: u.floor,
        type: typeLabel(u),
        sqm,
        priceUsd: u.priceUsd,
        pricePerSqmUsd: sqm > 0 ? Math.round(u.priceUsd / sqm) : 0,
        view: (u.view || "").trim(),
        status: "Available",
      };
    })
    .sort((a, b) => (b.floor - a.floor) || (Number(a.unitNumber) - Number(b.unitNumber)) || a.unitNumber.localeCompare(b.unitNumber));
}

/** Summary stats for the pricelist header (count, price range, total sellable area). */
export interface PricelistSummary {
  count: number;
  minPriceUsd: number;
  maxPriceUsd: number;
  totalSqm: number;
}
export function pricelistSummary(rows: PricelistRow[]): PricelistSummary {
  if (!rows.length) return { count: 0, minPriceUsd: 0, maxPriceUsd: 0, totalSqm: 0 };
  let min = Infinity, max = 0, sqm = 0;
  for (const r of rows) {
    if (r.priceUsd < min) min = r.priceUsd;
    if (r.priceUsd > max) max = r.priceUsd;
    sqm += r.sqm;
  }
  return { count: rows.length, minPriceUsd: min === Infinity ? 0 : min, maxPriceUsd: max, totalSqm: Math.round(sqm) };
}

// ── CSV output (data interchange) ──────────────────────────────────────────

const PRICELIST_COLUMNS = ["unitNumber", "floor", "type", "sqm", "priceUsd", "pricePerSqmUsd", "view", "status"] as const;

/** Escape one CSV field (same rule as units-csv.ts / matrix.ts). */
function csvField(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Serialize a building's pricelist to CSV (header + priced rows, floor-descending). Empty "" when no units. */
export function serializePricelistCsv(pack: Pack, buildingId: string): string {
  const rows = pricelistRows(pack, buildingId);
  if (!rows.length) return "";
  const header = PRICELIST_COLUMNS.join(",");
  const body = rows.map((r) => PRICELIST_COLUMNS.map((c) => csvField((r as unknown as Record<string, unknown>)[c])).join(","));
  return [header, ...body].join("\n") + "\n";
}

// ── Printable HTML output (the "PDF" via browser Print-to-PDF) ──────────────

/** Escape text for HTML. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A self-contained printable pricelist document for one building. Inline CSS only (so it prints/exports with no
 * external assets), @media print tuned for A4. The developer opens it and uses the browser's "Save as PDF" —
 * the same end artifact as the operator catalog's pricelist PDF, without a PDF engine dependency. PURE (Pack -> html string).
 */
export function pricelistHtml(pack: Pack, buildingId: string): string {
  const b: Building | undefined = pack.buildings.find((x) => x.id === buildingId);
  const name = b?.name || buildingId;
  const dev = b?.developer || pack.developer.name || "";
  const area = b?.area || "";
  const rows = pricelistRows(pack, buildingId);
  const s = pricelistSummary(rows);
  const asOf = new Date().toISOString().slice(0, 10);

  const head = [
    `Unit`, `Floor`, `Type`, `Area (m²)`, `Price`, `$/m²`, `View`, `Status`,
  ].map((h) => `<th>${esc(h)}</th>`).join("");

  const body = rows.map((r) => `<tr>
      <td class="mono">${esc(r.unitNumber)}</td>
      <td class="num">${r.floor}</td>
      <td>${esc(r.type)}</td>
      <td class="num">${r.sqm}</td>
      <td class="num price">${esc(usd(r.priceUsd))}</td>
      <td class="num">${esc(usd(r.pricePerSqmUsd))}</td>
      <td>${esc(r.view)}</td>
      <td>${esc(r.status)}</td>
    </tr>`).join("\n");

  const range = s.count ? `${esc(usd(s.minPriceUsd))} – ${esc(usd(s.maxPriceUsd))}` : "—";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(name)} — Price list</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#1e3a5f; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); margin: 0; padding: 28px 32px; }
  header { border-bottom: 2px solid var(--accent); padding-bottom: 12px; margin-bottom: 18px; }
  h1 { margin: 0 0 2px; font-size: 22px; }
  .sub { color: var(--muted); font-size: 13px; }
  .meta { display:flex; gap:24px; flex-wrap:wrap; margin-top:10px; font-size:12px; color:var(--muted); }
  .meta b { color: var(--ink); font-weight:600; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; background: var(--accent); color:#fff; padding: 7px 9px; font-weight:600; font-size:11.5px; letter-spacing:.02em; }
  td { padding: 6px 9px; border-bottom: 1px solid var(--line); }
  tr:nth-child(even) td { background:#f8fafc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .price { font-weight: 600; }
  .mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
  footer { margin-top: 16px; color: var(--muted); font-size: 11px; border-top:1px solid var(--line); padding-top:8px; }
  @media print {
    body { padding: 12mm; }
    th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    tr:nth-child(even) td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style></head>
<body>
  <header>
    <h1>${esc(name)} — Price list</h1>
    <div class="sub">${esc([dev, area].filter(Boolean).join(" · "))}</div>
    <div class="meta">
      <span><b>${s.count}</b> units</span>
      <span>Price range <b>${range}</b></span>
      <span>Total sellable area <b>${s.totalSqm.toLocaleString("en-US")} m²</b></span>
      <span>As of <b>${esc(asOf)}</b></span>
    </div>
  </header>
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
  <footer>
    Generated by VRX Model Maker · demo / marketing pricelist — prices indicative, not a signed offer. Figures and availability subject to change.
  </footer>
</body></html>`;
}
