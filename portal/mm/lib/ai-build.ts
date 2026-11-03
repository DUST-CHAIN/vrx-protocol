// MM-by-AI — the PURE core of the headless "author a whole building by AI" flow (the design docs).
//
// THE THESIS: skip the MM authoring SHELL for now; build the repeatable prompt+tool pipeline that
// emits exactly the importable pack. The AI (DeepSeek) fills a small structured BuildingSpec; this module turns
// that spec DETERMINISTICALLY into a valid Pack (lib/pack) — floor-stacking, the §4d geo tree, unit rows, unit
// types, terms, media slots — guaranteeing validatePack is clean and buildPackFiles emits a real ZIP. So
// whatever the model returns, the pack it produces is import-ready (law #2: always exportable).
//
// SPLIT (house style): this file is PURE + network-free (spec -> Pack + the prompt text), so it's unit-testable
// with a fixed spec and no DeepSeek. The orchestrator (ai-build.run.ts) does the DeepSeek call + the ZIP write.
//
// HONEST BOUNDARY: AI-authored plans/images are DEMO / MARKETING / EXHIBITION / ART — NOT real
// architecture. The data is a real importable pack; the geometry/imagery are presentation, never a surveyed
// drawing. The generator produces SYNTHETIC/mock content only (same discipline as the seed tools).

import type { Pack, Building, Unit, UnitType, GeoNode, Complex, Company, NodePrice } from "./pack";
import { slugify } from "./pack";

// ── The structured brief the AI returns (stage 1+2). Small, flat, easy for the model to produce as JSON. ──
// Everything load-bearing for a valid pack is here; the deterministic assembler below fills the rest.
/** A LAYOUT VARIATION within a unit type (: "each subtype is a different layout"). A type like "2BR"
 *  may have subtypes A/B/C — a different plan each (corner, sea-view, standard). Each carries its own size +
 *  a price delta + an optional view. The assembler distributes a floor's units of this type across its subtypes
 * (round-robin) and keys the unit-plan media slot by TYPE_SUBTYPE (the operator catalog convention), so each gets its own plan. */
export interface AiUnitSubtype {
  key: string;            // short variant tag: A | B | C | corner | seaview | standard …
  label?: string;         // human label, e.g. "Corner — sea view" (defaults to the key)
  sqm?: number;           // this layout's area (overrides the type range when set)
  /** price delta vs the type's headline price: a MULTIPLIER (1.0 = same, 1.15 = +15% for a corner/sea-view). */
  priceMult?: number;
  view?: string;          // a view specific to this layout (e.g. "Sea view") — overrides the type default
  /**  the SHARED floor-plan of this subtype — authored once, rendered by every placed unit of it (the
   *  plan "belongs to the VARIATION", FLOORPLAN_ENGINE_DESIGN.md:126). Its polygon area is constrained to `sqm`
 * above (the binding size), not free-resized. Absent = units render as plain boxes (behaviour). */
  plan?: import("./pack").UnitPlan;
}

export interface AiUnitType {
  key: string;            // studio | 1br | 2br | 3br | shop | penthouse | duplex …
  label: string;          // human label, e.g. "1 Bedroom"
  sqmMin: number;
  sqmMax: number;
  /** how many of this type PER FLOOR (the assembler stacks them across the floors) */
  perFloor: number;
  /** headline USD price for the type's low floor; the assembler escalates gently per floor */
  basePriceUsd: number;
  /** the LAYOUT VARIATIONS (subtypes) within this type — each a distinct plan. Optional; when absent the type
   *  is a single "Standard" layout. The assembler cycles a floor's units of this type across these. */
  subtypes?: AiUnitSubtype[];
  /** vertical floors this unit occupies (default 1). span 2 = a DUPLEX (one atomic unit over two floors). */
  span?: number;
  /** "core" = structural public space (elevator/lobby/gym…), occupies a cell but is NOT sellable inventory. */
  kind?: "unit" | "core";
}

export interface AiBuildingSpec {
  /** developer / brand display name (aliased, never a real protected brand) */
  developerName: string;
  /** optional holding company + a demo NEAR account id */
  holdingCompany?: string;
  nearAccount?: string;
  /** the development (complex) the building sits in */
  complexName: string;
  /** area / district (public market info, not PII) */
  area?: string;
  complexAmenities?: string[];
  /** the building */
  buildingName: string;
  tagline?: string;
  address?: string;
  buildingType?: string;  // "High Rise" | "Low Rise" (free label); default High Rise
  stories: number;        // >= 1
  buildingAmenities?: string[];
  /** marketing prose the listing step wrote */
  description?: string;
  /** the unit mix — the assembler stacks these across `stories` floors */
  unitTypes: AiUnitType[];
  /** optional per-building money fields (USD) */
  reservationFeeUsd?: number;
  bookingDepositUsd?: number;
  /** a view label to sprinkle (e.g. "Sea view" on higher floors) */
  premiumView?: string;
}

// ── Prompt (stage 1+2): blurb -> AiBuildingSpec JSON. Factual, low-invention; emit ONLY the JSON object. ──
export const AI_BUILD_SYSTEM_PROMPT = `You are the Model Maker authoring engine for VRX. You turn a short brief about a property development into a STRICT JSON object describing ONE building, which a deterministic tool then expands into a complete, importable real-estate pack.

OUTPUT: reply with ONLY a single JSON object matching this TypeScript shape — no prose, no markdown fence:
{
  "developerName": string,        // brand/developer display name
  "holdingCompany"?: string,
  "nearAccount"?: string,         // a plausible demo account like "acme-dev-01.testnet"
  "complexName": string,          // the development/project name
  "area"?: string,                // district / area (public info)
  "complexAmenities"?: string[],
  "buildingName": string,
  "tagline"?: string,
  "address"?: string,
  "buildingType"?: "High Rise" | "Low Rise",
  "stories": number,              // integer >= 1
  "buildingAmenities"?: string[],
  "description"?: string,         // 1–3 sentence marketing paragraph
  "unitTypes": [                  // the unit MIX; at least one
    { "key": string,              // short slug: studio|1br|2br|3br|shop|penthouse
      "label": string,            // "Studio","1 Bedroom"...
      "sqmMin": number, "sqmMax": number,
      "perFloor": number,         // how many of this type on each typical floor (integer >= 1)
      "basePriceUsd": number,     // headline USD price at a low floor
      "subtypes"?: [              // LAYOUT VARIATIONS within this type — each a DISTINCT plan (optional)
        { "key": string,          // short tag: A|B|C|corner|seaview|standard
          "label"?: string,       // "Corner — sea view"
          "sqm"?: number,         // this layout's area
          "priceMult"?: number,   // price vs the type headline: 1.0 same, 1.15 = +15% (corner/premium)
          "view"?: string }       // a view for this layout, e.g. "Sea view"
      ] }
  ],
  "reservationFeeUsd"?: number,
  "bookingDepositUsd"?: number,
  "premiumView"?: string          // e.g. "Sea view" — applied to higher floors
}

RULES:
- Derive from the brief; where the brief is silent, choose REALISTIC values for the area/segment (don't leave required fields empty).
- Use ALIASED / generic names — never a real protected brand you were given verbatim; invent a plausible brand if needed.
- Prices in USD, sensible for the segment. stories and perFloor are integers.
- SUBTYPES: where a type naturally has different LAYOUTS (a corner vs standard, a sea-view vs garden-view, an A/B/C plan), give it 2–3 "subtypes" — each is a different plan, so vary sqm and set a priceMult (corner/sea-view command a premium). If a type has just one layout, omit subtypes.
- Keep it ONE building. Return STRICT JSON only.`;

export function buildSpecMessages(blurb: string, hints?: { area?: string; stories?: number; domainNote?: string }): { role: "user"; content: string }[] {
  const lines = [
    "Brief about the development (may be rough copy-paste from a listing site):",
    blurb.trim(),
  ];
  if (hints?.area) lines.push(`\nArea/location hint: ${hints.area}`);
  if (hints?.stories) lines.push(`Approximate number of floors: ${hints.stories}`);
  if (hints?.domainNote) lines.push(`\n${hints.domainNote}`);
  lines.push("\nReturn the STRICT JSON object for ONE building now.");
  return [{ role: "user", content: lines.join("\n") }];
}

/** Extract the JSON object from a model reply (tolerates a stray ```json fence or leading prose). */
export function parseSpec(raw: string): AiBuildingSpec | null {
  if (!raw) return null;
  let text = raw.trim();
  // strip a markdown fence if present
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // else grab the first {...} block
  if (!text.startsWith("{")) {
    const i = text.indexOf("{");
    const j = text.lastIndexOf("}");
    if (i >= 0 && j > i) text = text.slice(i, j + 1);
  }
  try {
    const o = JSON.parse(text) as AiBuildingSpec;
    if (!o || typeof o !== "object" || !Array.isArray(o.unitTypes)) return null;
    return o;
  } catch {
    return null;
  }
}

// ── Deterministic assembler: AiBuildingSpec -> a valid Pack. Guarantees validatePack clean. ──

const money = (n: number): NodePrice => ({ amountUsd: Math.max(0, Math.round(n)) });

/** Clamp + default the spec so a sloppy AI reply still assembles cleanly (fail-soft, never throw). */
function normalizeSpec(spec: AiBuildingSpec): Required<Pick<AiBuildingSpec, "stories" | "unitTypes">> & AiBuildingSpec {
  const stories = Math.max(1, Math.floor(Number(spec.stories) || 1));
  const unitTypes = (spec.unitTypes || [])
    .filter((t) => t && t.key)
    .map((t) => {
      const sqmMin = Math.max(1, Math.round(Number(t.sqmMin) || 30));
      const sqmMax = Math.max(sqmMin, Math.round(Number(t.sqmMax) || Number(t.sqmMin) || 40));
      const subtypes = (t.subtypes || [])
        .filter((s) => s && s.key)
        .map((s) => ({
          key: slugify(s.key),
          label: (s.label || s.key).toString(),
          sqm: Number.isFinite(Number(s.sqm)) && Number(s.sqm) > 0 ? Math.round(Number(s.sqm)) : undefined,
          priceMult: Number.isFinite(Number(s.priceMult)) && Number(s.priceMult) > 0 ? Number(s.priceMult) : 1,
          view: (s.view || "").toString().trim() || undefined,
          // carry the authored PLAN (footprint/markers/backdrop) through normalisation — the drawing board's
          // shared subtype plan must survive to the pack so every unit renders it (same class as span/kind).
          plan: s.plan,
        }));
      return {
        key: slugify(t.key),
        label: (t.label || t.key || "Unit").toString(),
        sqmMin,
        sqmMax,
        perFloor: Math.max(1, Math.floor(Number(t.perFloor) || 1)),
        basePriceUsd: Math.max(0, Math.round(Number(t.basePriceUsd) || 50000)),
        subtypes: subtypes.length ? subtypes : undefined,
        // carry the structural flags through normalisation (a DUPLEX span / a CORE kind must survive to the pack)..
        span: Number.isFinite(Number(t.span)) && Number(t.span) > 1 ? Math.floor(Number(t.span)) : undefined,
        kind: t.kind === "core" ? "core" as const : undefined,
      };
    });
  if (unitTypes.length === 0) {
    unitTypes.push({ key: "1br", label: "1 Bedroom", sqmMin: 35, sqmMax: 45, perFloor: 4, basePriceUsd: 60000, subtypes: undefined, span: undefined, kind: undefined });
  }
  return { ...spec, stories, unitTypes };
}

export interface AssembleResult {
  pack: Pack;
  totalUnits: number;
}

/**
 * Expand a BuildingSpec into a complete, valid Pack: developer → company → complex → building → units (stacked
 * across floors) → unit types → terms → the §4d geo tree (land → building → floors → units, each priced). The
 * result passes validatePack with zero errors and emits a real ZIP via buildPackFiles.
 */
export function assembleBuildingPack(input: AiBuildingSpec, explicitUnits?: Unit[]): AssembleResult {
  const spec = normalizeSpec(input);

  const devId = slugify(spec.developerName || "developer");
  const companyId = slugify(`${spec.developerName}-co`) || "developer-co";
  const complexId = slugify(spec.complexName || "development");
  const buildingId = slugify(spec.buildingName || "building");
  const termsId = `${buildingId}-standard`;

  const developer: Pack["developer"] = {
    id: devId,
    name: spec.developerName || "Developer",
    holdingCompany: spec.holdingCompany,
    nearAccount: spec.nearAccount,
  };
  const companies: Company[] = [{ id: companyId, name: `${spec.developerName} Co., Ltd` }];
  const complexes: Complex[] = [{
    id: complexId,
    name: spec.complexName || "Development",
    companyId,
    area: spec.area,
    amenities: spec.complexAmenities,
    buildings: [buildingId],
  }];

  const unitTypes: UnitType[] = spec.unitTypes.map((t) => ({
    key: t.key, label: t.label, sqmMin: t.sqmMin, sqmMax: t.sqmMax, subtypes: t.subtypes, span: t.span, kind: t.kind,
  }));

  // Stack the unit mix across the floors. Floor 1 is ground (often shops); we keep it simple + realistic:
  // every floor gets the full mix, price escalates ~1.2% per floor + a premium view bump on the top third.
  // Each per-floor unit of a type is assigned a SUBTYPE (layout variant) cycled across the type's declared
  // subtypes (: each subtype is a distinct plan) — the subtype sets the area, a price multiplier and
  // an optional view. A type with no declared subtypes falls back to one "Standard" layout. unitNumber is
  // sequential per floor (floor*100 + n); the unit id carries the subtype so plans key by type+subtype.
  // When the caller authored explicit units (the /studio-ai per-floor grid, full fidelity), use them VERBATIM —
  // what the human set per floor/per unit is exactly what ships. Otherwise generate the mix from perFloor counts.
  const units: Unit[] = explicitUnits && explicitUnits.length ? explicitUnits.slice() : [];
  const topThird = Math.ceil(spec.stories * (2 / 3));
  if (!(explicitUnits && explicitUnits.length)) for (let floor = 1; floor <= spec.stories; floor++) {
    let n = 0;
    for (const t of spec.unitTypes) {
      const subs = t.subtypes && t.subtypes.length
        ? t.subtypes
        : [{ key: "std", label: "Standard", sqm: undefined as number | undefined, priceMult: 1, view: undefined as string | undefined }];
      for (let k = 0; k < t.perFloor; k++) {
        n++;
        const sub = subs[k % subs.length];
        const hasVariants = !!(t.subtypes && t.subtypes.length);
        // area: the subtype's own sqm if set, else varied within the type range across the per-floor units
        const sqm = sub.sqm ?? Math.round(t.sqmMin + ((t.sqmMax - t.sqmMin) * ((k + 1) / (t.perFloor + 1))));
        const floorBump = 1 + 0.012 * (floor - 1);
        const highFloor = floor >= topThird;
        // view: a declared subtype's view is INTRINSIC to the layout (a sea-view corner has it on every floor);
        // the building premiumView is a high-floor perk that applies ONLY when the layout has no view of its own
        // (and, when the type HAS variants, only to variants that don't declare one — so a "standard" subtype
        // stays view-less, keeping the layouts distinct).
        const view = sub.view || (highFloor && spec.premiumView && !hasVariants ? spec.premiumView : undefined);
        const viewBump = view ? 1.08 : 1;
        const priceUsd = Math.round(t.basePriceUsd * floorBump * viewBump * (sub.priceMult ?? 1));
        // unitNumber = the floor-prefixed NUMBER (consumers sort on it); the id spells floor + per-floor position
        // separately so a tall tower's ids don't read like a huge count (F55-36, not 5536). See authoring.toUnits.
        const unitNumber = floor * 100 + n;
        const posLabel = `F${floor}-${String(n).padStart(2, "0")}`;
        units.push({
          id: `${t.key}-${sub.key}-${posLabel}`,
          type: t.key,
          subtype: hasVariants ? sub.label : t.label,
          subtypeKey: sub.key, //  the STABLE subtype key — the geo tree links to the shared plan by this
          floor,
          unitNumber,
          sqm,
          priceUsd,
          view,
          baths: t.key === "studio" ? 1 : undefined,
        });
      }
    }
  }

  const building: Building = {
    id: buildingId,
    name: spec.buildingName || "Building",
    complexId,
    companyId,
    tagline: spec.tagline,
    developer: spec.developerName,
    area: spec.area,
    address: spec.address,
    type: spec.buildingType === "Low Rise" ? "Low Rise" : "High Rise",
    stories: spec.stories,
    units: units.length,
    amenities: spec.buildingAmenities,
    unitTypes,
    reservationFeeUsd: spec.reservationFeeUsd,
    bookingDepositUsd: spec.bookingDepositUsd,
    termsRef: termsId,
  };

  const terms: Pack["terms"] = [{
    id: termsId,
    data: {
      bookingFee: [spec.reservationFeeUsd ?? 1000],
      depositPct: [10, 20, 30],
      onContract: [{ installments: 1, amountPct: 20 }],
      ongoing: [{ installments: 24, amountPct: 2 }],
      frequencyDays: [30, 60],
      onKeyPct: [30],
      taxPct: [0],
      contractDays: 30,
    },
  }];

  const geo = buildGeoTree(buildingId, spec, units);

  const texts: Record<string, string> = {};
  if (spec.description) texts[`building:${buildingId}:description`] = spec.description;
  if (spec.tagline) texts[`building:${buildingId}:tagline`] = spec.tagline;

  const pack: Pack = {
    domain: "realestate",
    developer,
    companies,
    complexes,
    buildings: [building],
    buildingUnits: { [buildingId]: units },
    terms,
    texts,
    geo,
    overrides: [],
    media: [], // slots are placeholder-backfilled at export; the Gemini step fills source:"generated" items
  };

  return { pack, totalUnits: units.length };
}

/**
 * Build the §4d "Russian-doll" geo tree: land → building → floors → units, each posed relative to its parent
 * and carrying a price (rule 2). Land-first: the land is the outer shell; the title deed attaches
 * to the land node later (non-blocking). Geometry here is SCHEMATIC (even grid) — demo/marketing, not surveyed.
 */
function buildGeoTree(buildingId: string, spec: ReturnType<typeof normalizeSpec>, units: Unit[]): GeoNode[] {
  const nodes: GeoNode[] = [];
  const landId = `${buildingId}-land`;
  const bNodeId = `${buildingId}-bld`;

  // land (outer shell) — a real-world metre anchor so nested fractions resolve to m²
  nodes.push({
    id: landId, name: `${spec.complexName} — land`, kind: "land",
    metreW: 80, metreH: 60,
    footprint: { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } },
  });
  // building — fits inside the land (containment). Position lives in the footprint rect (the canvas renders from
  // it), not only in transform — else it draws at the land's origin, not inset. Inset 0.15 so it sits within the plate.
  nodes.push({
    id: bNodeId, name: spec.buildingName, kind: "building", parentId: landId,
    transform: { x: 0.15, y: 0.15, scale: 1, rotation: 0 },
    footprint: { shape: "rect", rect: { x: 0.15, y: 0.15, w: 0.7, h: 0.7 } },
    heightM: spec.stories * 3.2,
  });
  // short type-label + variant lookup so a unit's CANVAS caption reads like the architect's plan
  // ("Studio A 48m²" / "1BR 56m²"), not "Type B 103" (item #2). Keyed by the stable type key.
  // `hasVariants` (>1) decides whether the caption shows a letter; `hasSubtypes` (>=1) decides whether a REAL
  // subtype exists in the pack to link to (a single-layout type's synthesized "std" fallback isn't persisted,
  // so we must NOT stamp a subtypeRef at it — that would dangle). Both read from the spec's declared subtypes.
  const typeInfo = new Map<string, { label: string; hasVariants: boolean; hasSubtypes: boolean }>();
  for (const t of spec.unitTypes) {
    const n = t.subtypes?.length ?? 0;
    typeInfo.set(t.key, { label: shortTypeLabel(t.key, t.label), hasVariants: n > 1, hasSubtypes: n >= 1 });
  }
  // floors + their units (schematic even grid per floor)
  const byFloor = new Map<number, Unit[]>();
  for (const u of units) (byFloor.get(u.floor) ?? byFloor.set(u.floor, []).get(u.floor)!).push(u);
  for (const [floor, rows] of [...byFloor.entries()].sort((a, b) => a[0] - b[0])) {
    const floorId = `${buildingId}-f${floor}`;
    nodes.push({
      id: floorId, name: `Floor ${floor}`, kind: "floor", parentId: bNodeId,
      heightM: 3.2,
      footprint: { shape: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } },
    });
    const cols = Math.max(1, Math.ceil(Math.sqrt(rows.length)));
    const cell = 1 / cols;
    rows.forEach((u, i) => {
      const cx = (i % cols) * cell;
      const cy = Math.floor(i / cols) * cell;
      nodes.push({
        id: `${floorId}-${u.id}`, name: unitCaption(u, typeInfo.get(u.type)), kind: "unit",
        parentId: floorId,
        //  the STABLE link to the unit's subtype, so the shared plan resolves + the sqm stays pinned to
        // the subtype's declared size. Only when a REAL subtype exists in the pack (never at the synthesized
        // "std" fallback of a single-layout type — that key isn't persisted, so the ref would dangle).
        subtypeRef: u.subtypeKey && typeInfo.get(u.type)?.hasSubtypes
          ? { typeKey: u.type, subtypeKey: u.subtypeKey } : undefined,
        transform: { x: cx, y: cy, scale: 1, rotation: 0 },
        // the POSITION lives in the footprint rect (where the canvas renders + moveResize writes it), NOT only in
        // transform — otherwise every unit draws at (0,0) and they stack (floor/unit). cx/cy ∈ 0..1.
        footprint: { shape: "rect", rect: { x: cx, y: cy, w: cell, h: cell } },
        sqm: u.sqm,
        status: "available",
        price: money(u.priceUsd),
      });
    });
  }
  return nodes;
}

/** A SHORT type label for canvas captions: "1 Bedroom" → "1BR", "2 Bedroom" → "2BR", "Studio" stays, etc. Falls
 *  back to the full label. Pure + heuristic (illustration-grade) — the caption is for the author's eye, not export. */
function shortTypeLabel(key: string, label: string): string {
  const k = (key || "").toLowerCase();
  const m = k.match(/^(\d+)\s*(?:br|bed|bedroom)/) || label.toLowerCase().match(/^(\d+)\s*(?:br|bed|bedroom)/);
  if (m) return `${m[1]}BR`;
  if (k === "studio" || /studio/i.test(label)) return "Studio";
  return label || key;
}

/** The unit's canvas caption: "<ShortType> <Letter> <sqm>m²" (the letter only when the type has real variants).
 * e.g. "Studio A 48m²", "1BR 56m²". item #2 — the author must see the TYPE + area, not "Type B 103". */
function unitCaption(u: Unit, info: { label: string; hasVariants: boolean } | undefined): string {
  const typeLabel = info?.label ?? (u.type || "Unit");
  const letter = info?.hasVariants && u.subtypeKey ? ` ${u.subtypeKey.toUpperCase()}` : "";
  const area = u.sqm ? ` ${Math.round(u.sqm)}m²` : "";
  return `${typeLabel}${letter}${area}`.trim();
}
