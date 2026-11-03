// Brochure — the rendered marketing document for a building (: "a brochure template that renders a
// page for the building, a page per unit type, with notices for the subtype variations"). Ported from the operator catalog's
// "property offer / brochure" (drt/protected/controllers/ApiController.php generate_property_offer): a building
// hero page + per-unit-type pages, each with a plan image, size/price range, key features, and — the specific
// ask — a NOTICE listing the subtype variations within that type (e.g. "Type 2BR has variants A/B/C: corner,
// sea-view, standard" with their size/price spreads).
//
// PURE (Pack + buildingId -> html string), like pricelist.ts. Inline CSS + @media print so it exports as a
// self-contained doc the developer saves to PDF (same artifact as the operator catalog's brochure, no PDF-engine dep). Images
// are referenced by the pack's media-slot PATHS (export lays real/placeholder bytes at those paths in the ZIP),
// so a brochure opened FROM the unpacked ZIP shows the images; standalone it degrades to the slot labels.
//
// HONEST BOUNDARY: a generated brochure is a DEMO / MARKETING sheet of the authored pack — indicative, not an
// offer. Capability data only (inventory + prices + prose), never PII.

import type { Building, Pack, Unit } from "./pack";
import { unitSqm } from "./pack";
import { usd } from "./pricelist";
import { itemForSlot, mediaPath, placeholderSvg, requiredSlots } from "./media";

/** Range helper. */
interface Range { min: number; max: number }
function range(nums: number[]): Range {
  if (!nums.length) return { min: 0, max: 0 };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}
function rangeText(r: Range, fmt: (n: number) => string): string {
  if (!r.max) return "—";
  return r.min === r.max ? fmt(r.min) : `${fmt(r.min)} – ${fmt(r.max)}`;
}

/** A subtype VARIATION within a unit type — the "notice" rows the brochure lists under each type page. */
export interface SubtypeVariation {
  subtype: string; // e.g. "A", "Corner", "Sea view" ("Standard" when a unit carries no subtype)
  count: number;
  sqm: Range;
  priceUsd: Range;
  views: string[]; // distinct view labels present in this subtype (e.g. ["Sea view"])
}

/** One unit-type page's worth of data, derived from the building's units. */
export interface BrochureTypePage {
  typeKey: string; // the raw type (studio|1br|2br…)
  typeLabel: string; // human label from the building's unitTypes if present, else uppercased key
  count: number;
  sqm: Range;
  priceUsd: Range;
  planSlotKey: string; // the media slot a type plan lives at (units/{TYPE}) — uppercased, the operator catalog vocabulary
  variations: SubtypeVariation[]; // the subtype notices (>= 1; "Standard" when none carry a subtype)
}

/** The human label for a unit type — prefer the building's declared unitTypes, else the uppercased key. */
function typeLabelFor(b: Building | undefined, typeKey: string): string {
  const decl = (b?.unitTypes || []).find((t) => t.key === typeKey);
  if (decl?.label) return decl.label;
  return typeKey ? typeKey.toUpperCase() : "Unit";
}

/**
 * Group a building's units into per-type pages, each carrying its subtype VARIATIONS (the notice the brochure
 * must show). A unit with no subtype folds into a "Standard" variation so every type always has >= 1 notice.
 * PURE.
 */
export function brochureTypePages(pack: Pack, buildingId: string): BrochureTypePage[] {
  const b = pack.buildings.find((x) => x.id === buildingId);
  const units = pack.buildingUnits[buildingId] || [];

  // group by type -> subtype
  const byType = new Map<string, Unit[]>();
  for (const u of units) {
    const key = (u.type || "").trim().toLowerCase();
    (byType.get(key) ?? byType.set(key, []).get(key)!).push(u);
  }

  const pages: BrochureTypePage[] = [];
  for (const [typeKey, typeUnits] of byType) {
    const bySub = new Map<string, Unit[]>();
    for (const u of typeUnits) {
      const sub = (u.subtype || "").trim() || "Standard";
      (bySub.get(sub) ?? bySub.set(sub, []).get(sub)!).push(u);
    }
    const variations: SubtypeVariation[] = [...bySub.entries()]
      .map(([subtype, us]): SubtypeVariation => ({
        subtype,
        count: us.length,
        sqm: range(us.map((u) => unitSqm(u))), //  authoritative size: legal ?? architect ?? sqm
        priceUsd: range(us.map((u) => u.priceUsd)),
        views: [...new Set(us.map((u) => (u.view || "").trim()).filter(Boolean))],
      }))
      .sort((a, b) => a.subtype.localeCompare(b.subtype));

    // the per-type plan slot must match EXACTLY what media.ts requiredSlots emits (units/<TYPE>_<SUBTYPE>,
    // uppercased, subtype optional) — else the render-set-filled image isn't found and we'd show a placeholder.
    const first = typeUnits[0];
    const t = (first?.type || typeKey).trim().toUpperCase();
    const sub = (first?.subtype || "").trim().toUpperCase();
    pages.push({
      typeKey,
      typeLabel: typeLabelFor(b, typeKey),
      count: typeUnits.length,
      sqm: range(typeUnits.map((u) => unitSqm(u))), //  authoritative size: legal ?? architect ?? sqm
      priceUsd: range(typeUnits.map((u) => u.priceUsd)),
      planSlotKey: `units/${sub ? `${t}_${sub}` : t}`,
      variations,
    });
  }
  // order by headline (ascending) price so studios/1BR first, penthouses last — how a brochure reads
  return pages.sort((a, b) => a.priceUsd.min - b.priceUsd.min);
}

// ── Printable HTML (the brochure document) ──────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The three building renderings, in brochure order (exterior hero, interior, facilities). */
const HERO_SLOTS = [
  { key: "renderings/EXT_hero", label: "Exterior" },
  { key: "renderings/INT_lobby", label: "Interior" },
  { key: "renderings/FAC_amenity", label: "Facilities" },
];

/** An <img> for a slot. If the pack already carries the image bytes (upload/generated/render-set), embed them
 *  as a self-contained data: URL so the brochure shows the image IN A BROWSER PREVIEW (not just inside the
 *  unpacked ZIP). When a slot has no real image, embed the exact tinted PLACEHOLDER SVG as data: so there's
 *  never a broken <img>. Fully self-contained either way. */
/** The self-contained data: URL for a slot's image (stored bytes → data:; else the tinted placeholder as data:).
 *  Always resolvable in a browser preview AND in the ZIP — never a broken <img>. */
function slotSrc(pack: Pack, buildingId: string, slotKey: string): string {
  const item = itemForSlot(pack, buildingId, slotKey);
  if (item) return `data:${item.mime};base64,${item.dataB64}`;
  const slot = requiredSlots(pack).find((s) => s.buildingId === buildingId && s.key === slotKey);
  const svg = slot ? placeholderSvg(slot) : `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#1e293b"/></svg>`;
  return `data:image/svg+xml;base64,${b64(svg)}`;
}

/** A HERO figure (16:9 cover, 3-up grid). */
function slotFigure(pack: Pack, buildingId: string, slotKey: string, label: string): string {
  return `<figure class="shot">
    <img src="${slotSrc(pack, buildingId, slotKey)}" alt="${esc(label)}"/>
    <figcaption>${esc(label)}</figcaption>
  </figure>`;
}

/** A LEVEL-PLAN card — the wide the operator catalog composite shown large + uncropped (contain), labeled on top. */
function levelCard(pack: Pack, buildingId: string, floor: number): string {
  return `<div class="level-card">
    <div class="cap">Floor ${floor}</div>
    <img src="${slotSrc(pack, buildingId, `levels/${floor}`)}" alt="Floor ${floor} plan"/>
  </div>`;
}

/** A UNIT-TYPE plan — the whole layout shown uncropped (contain), framed, captioned. */
function unitPlanFigure(pack: Pack, buildingId: string, slotKey: string, label: string): string {
  return `<div class="unit-plan">
    <img src="${slotSrc(pack, buildingId, slotKey)}" alt="${esc(label)}"/>
    <div class="cap">${esc(label)}</div>
  </div>`;
}

/** UTF-8 string → base64 (Node Buffer or browser btoa, handling non-ASCII in the SVG text). */
function b64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * The full brochure document for a building: a building hero page + one page per unit type (page-break between),
 * each type page listing its subtype variations as a notice table. Self-contained printable HTML. PURE.
 */
export function brochureHtml(pack: Pack, buildingId: string): string {
  const b = pack.buildings.find((x) => x.id === buildingId);
  const name = b?.name || buildingId;
  const dev = b?.developer || pack.developer.name || "";
  const area = b?.area || "";
  const tagline = pack.texts?.[`building:${buildingId}:tagline`] || b?.tagline || "";
  const description = pack.texts?.[`building:${buildingId}:description`] || "";
  const amenities = b?.amenities || [];
  const pages = brochureTypePages(pack, buildingId);

  const heroFigures = HERO_SLOTS.map((s) => slotFigure(pack, buildingId, s.key, s.label)).join("\n");

  // Level (floor) plans — one per distinct floor present in the units (the levels/<floor> slots). The render-set
  // fills these; a slot with no image shows the inlined placeholder. This is the "level plans" section.
  const floors = [...new Set((pack.buildingUnits[buildingId] || []).map((u) => u.floor))].sort((a, c) => a - c);
  const levelFigures = floors.map((f) => levelCard(pack, buildingId, f)).join("\n");

  const amenityList = amenities.length
    ? `<ul class="feat">${amenities.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`
    : "";

  // Building page
  const buildingPage = `<section class="page">
    <header class="bro-head">
      <div class="eyebrow">${esc([dev, area].filter(Boolean).join(" · "))}</div>
      <h1>${esc(name)}</h1>
      ${tagline ? `<p class="tagline">${esc(tagline)}</p>` : ""}
    </header>
    <div class="shots">${heroFigures}</div>
    ${description ? `<p class="lead">${esc(description)}</p>` : ""}
    ${amenities.length ? `<h2>Highlights</h2>${amenityList}` : ""}
    <div class="typegrid">
      ${pages.map((p) => `<div class="typecard">
        <div class="t">${esc(p.typeLabel)}</div>
        <div class="m">${p.count} units · ${rangeText(p.sqm, (n) => `${n} m²`)}</div>
        <div class="p">${rangeText(p.priceUsd, usd)}</div>
      </div>`).join("")}
    </div>
    ${floors.length ? `<h2>Level plans</h2><div class="levels">${levelFigures}</div>` : ""}
  </section>`;

  // Per-unit-type pages with the subtype-variation notice
  const typePages = pages.map((p) => `<section class="page">
    <header class="bro-head">
      <div class="eyebrow">${esc(name)}${area ? ` · ${esc(area)}` : ""}</div>
      <h1>${esc(p.typeLabel)}</h1>
      <p class="tagline">${p.count} units · ${rangeText(p.sqm, (n) => `${n} m²`)} · from ${rangeText(p.priceUsd, usd)}</p>
    </header>
    ${unitPlanFigure(pack, buildingId, p.planSlotKey, `${p.typeLabel} — layout`)}
    <h2>Variations</h2>
    <p class="notice">This type has <b>${p.variations.length}</b> variation${p.variations.length === 1 ? "" : "s"}. Layouts, areas and prices vary by subtype — confirm the specific unit before reserving.</p>
    <table class="var">
      <thead><tr><th>Subtype</th><th>Units</th><th>Area (m²)</th><th>Price</th><th>View</th></tr></thead>
      <tbody>
        ${p.variations.map((v) => `<tr>
          <td><b>${esc(v.subtype)}</b></td>
          <td class="num">${v.count}</td>
          <td class="num">${rangeText(v.sqm, (n) => String(n))}</td>
          <td class="num price">${rangeText(v.priceUsd, usd)}</td>
          <td>${esc(v.views.join(", "))}</td>
        </tr>`).join("\n")}
      </tbody>
    </table>
  </section>`).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(name)} — Brochure</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#1e3a5f; --soft:#f1f5f9; }
  * { box-sizing: border-box; }
  body { font-family: system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); margin:0; background:#fff; }
  .page { padding: 36px 44px; max-width: 1040px; margin: 0 auto; }
  .page + .page { border-top: 1px dashed var(--line); }
  .bro-head { border-bottom: 2px solid var(--accent); padding-bottom: 12px; margin-bottom: 20px; }
  .eyebrow { color: var(--muted); font-size: 12px; letter-spacing:.06em; text-transform: uppercase; }
  h1 { margin: 4px 0 0; font-size: 30px; letter-spacing:-.01em; }
  h2 { font-size: 13px; margin: 26px 0 10px; color: var(--accent); text-transform:uppercase; letter-spacing:.08em; border-bottom:1px solid var(--line); padding-bottom:5px; }
  .tagline { color: var(--muted); font-size: 15px; margin: 6px 0 0; }
  .lead { font-size: 14px; line-height: 1.65; margin: 16px 0; max-width: 72ch; }

  /* hero — 3 across, filling (cover is fine for marketing renders) */
  .shots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0; }
  .shots .shot img { width:100%; aspect-ratio:16/9; object-fit:cover; border-radius:8px; background:var(--soft); display:block; }

  /* LEVEL PLANS — the the operator catalog level images are WIDE COMPOSITES (banner + views + plan). Show them LARGE, 1-up,
     natural wide ratio, CONTAIN so nothing is cropped. A thin framed card per floor with the label on top. */
  .levels { display: grid; grid-template-columns: 1fr; gap: 16px; margin: 10px 0; }
  @media (min-width: 900px) { .levels { grid-template-columns: 1fr 1fr; } }
  .level-card { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#fff; }
  .level-card .cap { font-size:12px; font-weight:600; color:var(--ink); padding:8px 12px; border-bottom:1px solid var(--line); background:var(--soft); }
  .level-card img { width:100%; aspect-ratio:16/9; object-fit:contain; background:#0f172a; display:block; }

  /* UNIT TYPE PLAN — a real layout; show the WHOLE plan (contain), centered, framed. */
  .unit-plan { border:1px solid var(--line); border-radius:10px; overflow:hidden; max-width:680px; margin:4px 0 2px; background:#fff; }
  .unit-plan img { width:100%; aspect-ratio:3/2; object-fit:contain; background:var(--soft); display:block; }
  .unit-plan .cap { font-size:11px; color:var(--muted); padding:6px 12px; border-top:1px solid var(--line); }

  .shot figcaption { font-size: 11px; color: var(--muted); margin-top: 5px; }
  ul.feat { columns: 2; gap: 28px; font-size: 13px; line-height: 1.7; margin: 6px 0; padding-left: 18px; }
  .typegrid { display:grid; grid-template-columns: repeat(auto-fill, minmax(165px,1fr)); gap:12px; margin-top:10px; }
  .typecard { border:1px solid var(--line); border-radius:9px; padding:12px 14px; }
  .typecard .t { font-weight:600; font-size:14px; }
  .typecard .m { font-size:12px; color:var(--muted); margin:4px 0; }
  .typecard .p { font-weight:600; color:var(--accent); }
  .notice { background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:9px 12px; font-size:12.5px; max-width:72ch; }
  table.var { width:100%; max-width:780px; border-collapse:collapse; font-size:12.5px; margin-top:10px; }
  table.var th { text-align:left; background:var(--accent); color:#fff; padding:7px 10px; font-size:11.5px; }
  table.var td { padding:7px 10px; border-bottom:1px solid var(--line); }
  table.var tr:nth-child(even) td { background:var(--soft); }
  .num { text-align:right; font-variant-numeric: tabular-nums; }
  .price { font-weight:600; }
  footer { max-width:1040px; margin:0 auto; padding:14px 44px 32px; color:var(--muted); font-size:11px; }
  @media print {
    .page { page-break-after: always; max-width:none; }
    .page + .page { border-top: none; }
    .levels { grid-template-columns: 1fr 1fr; }
    th, .level-card .cap, .shots .shot img, .level-card img, .unit-plan img { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style></head>
<body>
  ${buildingPage}
  ${typePages}
  <footer>Generated by VRX Model Maker · demo / marketing brochure — indicative only, not a signed offer. Images may be illustrative. Figures and availability subject to change.</footer>
</body></html>`;
}
