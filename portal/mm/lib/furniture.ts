// §6a furniture packages — auto-populate props on add. The PURE engine behind the Studio-face
// "Apply furniture package" action.
//
// THE MODEL (MM_ENGINE_AND_FACES §6a + §4d): a furniture PACKAGE is not placed prop-by-prop. It is a TEMPLATE
// of GeoNode prop-children; applying it to a unit seeds ALL its props at once, each at a sensible position
// RELATIVE to the unit (§4d rule 1) and scaled to the unit's footprint. Because a prop's footprint is stored
// in FRACTIONS of the unit (the same 0..1 space as every other node), "scaled to the unit" is automatic —
// a sofa at {x:.05,y:.55,w:.4,h:.3} is 40% of the unit wide whatever the unit's real metres are. The human/AI
// then nudges/scales/swaps individual props (that is just moveResize / this file's swap + the inspector).
//
// ILLUSTRATION-GRADE (same posture as the polygon editor): the seeded layout is a sensible DEFAULT you
// ride or rearrange — NOT a space-planning solver. No collision/fit logic; props may overlap and that's fine
// (a schematic plan, not a survey). The §6a line "the AI knows the scale" is a [planned] layer — this slice
// seeds by template fractions (which IS unit-relative scale); an AI placement pass can refine later.
//
// PROPS ARE DATA, NOT MESHES (§4d LOD rule): a prop is a pin/footprint + a LABEL + a PRICE, rendered as a
// schematic SVG icon only when zoomed INTO a unit's plan. 600 chairs = 600 priced inventory rows, never 600
// meshes. So this file carries the icon KEY per prop; Canvas maps the key → a tiny schematic glyph.

import type { GeoNode, NodePrice } from "./pack";
import { clampRect, type Rect } from "./geo";

// ---------------------------------------------------------------------------
// Prop icon vocabulary — schematic glyph keys. Canvas (app/Canvas.tsx) maps each to a tiny SVG primitive set.
// Keep this list and Canvas's PROP_GLYPH in lockstep. A key with no glyph falls back to a generic box.
// ---------------------------------------------------------------------------

// (Slice E) The pictogram vocabulary. INVENTORY FIXTURES only — a prop is a PRICED inventory row rendered as
// a schematic glyph (§4d). Architectural annotations that are NOT priced inventory — doors, windows, walls — are
// NOT here: they live on the SUBTYPE plan as PlanMarkers (lib/pack PlanMarker), drawn separately. So this
// list grows with sellable/countable pieces (a stove, a sink, a toilet), never with openings in a wall.
export type PropIcon =
  // seating + living
  | "sofa"
  | "chair"
  | "table"
  | "rug"
  | "plant"
  | "tv"
  // bedroom
  | "bed"
  | "wardrobe"
  | "dresser"
  | "nightstand"
  | "desk"
  // kitchen (Slice E)
  | "kitchen" // a kitchenette block (kept for back-compat with packages)
  | "counter"
  | "stove"
  | "sink"
  | "fridge"
  // bathroom (Slice E)
  | "bath"
  | "shower"
  | "toilet"
  | "washbasin"
  // circulation (Slice E) — a unit-internal stair (a duplex/loft), priced as a built element
  | "stairs";

/** One prop in a package template. Footprint is a rect in FRACTIONS of the unit (0..1); it nests + clamps. */
export interface PropTemplate {
  icon: PropIcon;
  label: string; // human name, also the node name ("Sofa", "Double bed")
  rect: Rect; // position + size as a fraction of the unit
  priceUsd?: number; // nominal inventory price (rule 2: every object carries a price, even a chair)
}

/** A furniture package = a named set of prop templates applied to a unit in one action. */
export interface FurniturePackage {
  key: string;
  label: string;
  description: string;
  props: PropTemplate[];
}

// ---------------------------------------------------------------------------
// The seed catalog — 3 small, domain-real packages (first slice). Deliberately a handful of props each:
// enough to prove seed → render → nudge → swap end-to-end before the AI-placement layer exists. Positions are
// a plausible default plan (illustration-grade), laid out so they read at a glance; the user rearranges freely.
// ---------------------------------------------------------------------------

export const FURNITURE_PACKAGES: FurniturePackage[] = [
  {
    key: "studio",
    label: "Studio",
    description: "A compact studio: bed, wardrobe, kitchenette, sofa and a small table.",
    props: [
      { icon: "bed", label: "Double bed", rect: { x: 0.06, y: 0.08, w: 0.34, h: 0.3 }, priceUsd: 600 },
      { icon: "wardrobe", label: "Wardrobe", rect: { x: 0.06, y: 0.42, w: 0.14, h: 0.22 }, priceUsd: 350 },
      { icon: "kitchen", label: "Kitchenette", rect: { x: 0.62, y: 0.06, w: 0.32, h: 0.16 }, priceUsd: 1200 },
      { icon: "sofa", label: "Sofa", rect: { x: 0.56, y: 0.6, w: 0.36, h: 0.18 }, priceUsd: 450 },
      { icon: "table", label: "Table", rect: { x: 0.44, y: 0.42, w: 0.16, h: 0.16 }, priceUsd: 180 },
    ],
  },
  {
    key: "one-bed",
    label: "1-Bedroom",
    description: "A one-bedroom layout: bedroom set, living sofa + TV, dining table and chairs.",
    props: [
      { icon: "bed", label: "Double bed", rect: { x: 0.06, y: 0.08, w: 0.34, h: 0.3 }, priceUsd: 600 },
      { icon: "wardrobe", label: "Wardrobe", rect: { x: 0.42, y: 0.08, w: 0.12, h: 0.28 }, priceUsd: 350 },
      { icon: "sofa", label: "Sofa", rect: { x: 0.58, y: 0.1, w: 0.36, h: 0.18 }, priceUsd: 450 },
      { icon: "tv", label: 'TV 55"', rect: { x: 0.68, y: 0.34, w: 0.18, h: 0.05 }, priceUsd: 700 },
      { icon: "table", label: "Dining table", rect: { x: 0.56, y: 0.56, w: 0.22, h: 0.18 }, priceUsd: 300 },
      { icon: "chair", label: "Chair", rect: { x: 0.52, y: 0.58, w: 0.08, h: 0.08 }, priceUsd: 90 },
      { icon: "chair", label: "Chair", rect: { x: 0.8, y: 0.58, w: 0.08, h: 0.08 }, priceUsd: 90 },
    ],
  },
  {
    key: "living-dining",
    label: "Living + Dining",
    description: "A living/dining fit-out: sofa, coffee table, TV wall, dining set and a rug.",
    props: [
      { icon: "sofa", label: "Sofa", rect: { x: 0.06, y: 0.12, w: 0.4, h: 0.2 }, priceUsd: 450 },
      { icon: "rug", label: "Rug", rect: { x: 0.08, y: 0.36, w: 0.36, h: 0.22 }, priceUsd: 200 },
      { icon: "table", label: "Coffee table", rect: { x: 0.16, y: 0.42, w: 0.18, h: 0.1 }, priceUsd: 160 },
      { icon: "tv", label: 'TV 65"', rect: { x: 0.08, y: 0.04, w: 0.2, h: 0.05 }, priceUsd: 900 },
      { icon: "table", label: "Dining table", rect: { x: 0.58, y: 0.5, w: 0.26, h: 0.22 }, priceUsd: 300 },
      { icon: "chair", label: "Chair", rect: { x: 0.54, y: 0.52, w: 0.08, h: 0.08 }, priceUsd: 90 },
      { icon: "chair", label: "Chair", rect: { x: 0.86, y: 0.52, w: 0.08, h: 0.08 }, priceUsd: 90 },
      { icon: "plant", label: "Plant", rect: { x: 0.88, y: 0.08, w: 0.08, h: 0.1 }, priceUsd: 60 },
    ],
  },
  // (Slice E) two fixture packages exercising the richer vocabulary — a kitchen and a bathroom fit-out.
  {
    key: "kitchen-full",
    label: "Full kitchen",
    description: "A full kitchen fit-out: counter run, stove, sink and a fridge.",
    props: [
      { icon: "counter", label: "Counter", rect: { x: 0.06, y: 0.06, w: 0.5, h: 0.12 }, priceUsd: 700 },
      { icon: "stove", label: "Stove", rect: { x: 0.1, y: 0.2, w: 0.14, h: 0.14 }, priceUsd: 650 },
      { icon: "sink", label: "Kitchen sink", rect: { x: 0.3, y: 0.2, w: 0.14, h: 0.1 }, priceUsd: 280 },
      { icon: "fridge", label: "Fridge", rect: { x: 0.6, y: 0.06, w: 0.14, h: 0.2 }, priceUsd: 900 },
    ],
  },
  {
    key: "bathroom",
    label: "Bathroom",
    description: "A bathroom fit-out: bath, shower, toilet and a washbasin.",
    props: [
      { icon: "bath", label: "Bathtub", rect: { x: 0.06, y: 0.1, w: 0.36, h: 0.2 }, priceUsd: 800 },
      { icon: "shower", label: "Shower", rect: { x: 0.06, y: 0.36, w: 0.2, h: 0.2 }, priceUsd: 550 },
      { icon: "toilet", label: "Toilet", rect: { x: 0.6, y: 0.1, w: 0.12, h: 0.16 }, priceUsd: 320 },
      { icon: "washbasin", label: "Washbasin", rect: { x: 0.6, y: 0.36, w: 0.16, h: 0.1 }, priceUsd: 220 },
    ],
  },
];

export function packageByKey(key: string | undefined): FurniturePackage | undefined {
  return FURNITURE_PACKAGES.find((p) => p.key === key);
}

/** The single-piece palette — used BOTH by the "swap this piece" action (§6a) AND the Slice E "add one
 *  piece" affordance. Each entry is a priced inventory default (type, human name, nominal price). A sensible
 *  default footprint for an added piece is taken from DEFAULT_PROP_RECT (per icon) so a dropped piece reads
 *  at a plausible size. Order groups living → bedroom → kitchen → bathroom → circulation for a legible menu. */
export const PROP_PALETTE: Array<{ icon: PropIcon; label: string; priceUsd: number }> = [
  // living
  { icon: "sofa", label: "Sofa", priceUsd: 450 },
  { icon: "chair", label: "Chair", priceUsd: 90 },
  { icon: "table", label: "Table", priceUsd: 180 },
  { icon: "tv", label: "TV", priceUsd: 700 },
  { icon: "rug", label: "Rug", priceUsd: 200 },
  { icon: "plant", label: "Plant", priceUsd: 60 },
  // bedroom
  { icon: "bed", label: "Double bed", priceUsd: 600 },
  { icon: "wardrobe", label: "Wardrobe", priceUsd: 350 },
  { icon: "dresser", label: "Dresser", priceUsd: 300 },
  { icon: "nightstand", label: "Nightstand", priceUsd: 120 },
  { icon: "desk", label: "Desk", priceUsd: 260 },
  // kitchen
  { icon: "kitchen", label: "Kitchenette", priceUsd: 1200 },
  { icon: "counter", label: "Counter", priceUsd: 700 },
  { icon: "stove", label: "Stove", priceUsd: 650 },
  { icon: "sink", label: "Kitchen sink", priceUsd: 280 },
  { icon: "fridge", label: "Fridge", priceUsd: 900 },
  // bathroom
  { icon: "bath", label: "Bathtub", priceUsd: 800 },
  { icon: "shower", label: "Shower", priceUsd: 550 },
  { icon: "toilet", label: "Toilet", priceUsd: 320 },
  { icon: "washbasin", label: "Washbasin", priceUsd: 220 },
  // circulation
  { icon: "stairs", label: "Internal stair", priceUsd: 2500 },
];

/** A sensible default footprint (fraction of the unit) for a SINGLE piece dropped via the "add a piece"
 *  affordance — roughly the real relative size of each fixture so a freshly-added piece reads plausibly before
 *  the user nudges it. Centred-ish, clamped on seed. A piece not listed falls back to a neutral ~0.2×0.2 block. */
export const DEFAULT_PROP_RECT: Partial<Record<PropIcon, Rect>> = {
  sofa: { x: 0.3, y: 0.4, w: 0.36, h: 0.18 },
  chair: { x: 0.45, y: 0.45, w: 0.09, h: 0.09 },
  table: { x: 0.4, y: 0.4, w: 0.2, h: 0.18 },
  tv: { x: 0.4, y: 0.06, w: 0.2, h: 0.05 },
  rug: { x: 0.3, y: 0.4, w: 0.4, h: 0.26 },
  plant: { x: 0.85, y: 0.08, w: 0.09, h: 0.11 },
  bed: { x: 0.08, y: 0.1, w: 0.34, h: 0.32 },
  wardrobe: { x: 0.08, y: 0.5, w: 0.14, h: 0.24 },
  dresser: { x: 0.26, y: 0.5, w: 0.2, h: 0.1 },
  nightstand: { x: 0.44, y: 0.1, w: 0.09, h: 0.09 },
  desk: { x: 0.5, y: 0.5, w: 0.24, h: 0.12 },
  kitchen: { x: 0.62, y: 0.06, w: 0.32, h: 0.16 },
  counter: { x: 0.62, y: 0.06, w: 0.3, h: 0.1 },
  stove: { x: 0.62, y: 0.2, w: 0.12, h: 0.12 },
  sink: { x: 0.78, y: 0.2, w: 0.12, h: 0.1 },
  fridge: { x: 0.86, y: 0.34, w: 0.12, h: 0.16 },
  bath: { x: 0.06, y: 0.7, w: 0.3, h: 0.16 },
  shower: { x: 0.06, y: 0.7, w: 0.16, h: 0.16 },
  toilet: { x: 0.4, y: 0.74, w: 0.1, h: 0.12 },
  washbasin: { x: 0.54, y: 0.76, w: 0.12, h: 0.08 },
  stairs: { x: 0.7, y: 0.5, w: 0.18, h: 0.3 },
};

// ---------------------------------------------------------------------------
// Seeding — build the prop GeoNodes a package produces under a unit. PURE: returns the new nodes; the caller
// (useGeo) inserts them into pack.geo[]. Ids are unique against `existingIds`. Each prop carries its icon via
// `factoryName` = "prop:<icon>" (the model has no dedicated icon field; factoryName is the clipper-style tag
// the renderer reads — no schema change needed). Footprints are clamped (never protrude the unit).
// ---------------------------------------------------------------------------

/** The icon of a prop node, read back from its factoryName tag ("prop:sofa" → "sofa"). */
export function propIcon(node: GeoNode): PropIcon | undefined {
  const fn = node.factoryName || "";
  if (fn.startsWith("prop:")) return fn.slice(5) as PropIcon;
  return undefined;
}

function uniqueId(base: string, taken: Set<string>): string {
  let n = Array.from(taken).filter((i) => i.startsWith("prop-")).length + 1;
  let id = `prop-${n}`;
  while (taken.has(id)) id = `prop-${++n}`;
  return id;
}

/**
 * Seed a package's props as GeoNodes under `unitId`. Returns the array of new prop nodes (clamped, unique ids,
 * each tagged with its icon + a label + a price). Empty array for an unknown package key. Does NOT mutate.
 */
export function seedPackage(unitId: string, packageKey: string, existingIds: Iterable<string>): GeoNode[] {
  const pkg = packageByKey(packageKey);
  if (!pkg) return [];
  const taken = existingIds instanceof Set ? new Set(existingIds) : new Set(existingIds);
  const out: GeoNode[] = [];
  for (const t of pkg.props) {
    const id = uniqueId("prop", taken);
    taken.add(id);
    const rect = clampRect(t.rect);
    const price: NodePrice | undefined = t.priceUsd != null ? { amountUsd: t.priceUsd, label: t.label } : undefined;
    out.push({
      id,
      name: t.label,
      kind: "prop",
      parentId: unitId,
      transform: { x: rect.x, y: rect.y, scale: 1, rotation: 0 },
      footprint: { shape: "rect", rect },
      factoryName: `prop:${t.icon}`,
      ...(price ? { price } : {}),
    });
  }
  return out;
}

/**
 * (Slice E) Seed ONE prop under `unitId` — the "drop a single piece" affordance (vs seedPackage's whole
 * layout). Returns the single new prop node (unique id, clamped footprint at the icon's DEFAULT_PROP_RECT, tagged
 * with its icon + label + price). PURE — the caller (useGeo.addProp) appends it. Mirrors a seedPackage entry so
 * one piece and a package piece are structurally identical nodes. */
export function seedSingleProp(
  unitId: string,
  icon: PropIcon,
  label: string,
  priceUsd: number,
  existingIds: Iterable<string>,
): GeoNode {
  const taken = new Set(existingIds);
  const id = uniqueId("prop", taken);
  const rect = clampRect(DEFAULT_PROP_RECT[icon] ?? { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  return {
    id,
    name: label,
    kind: "prop",
    parentId: unitId,
    transform: { x: rect.x, y: rect.y, scale: 1, rotation: 0 },
    footprint: { shape: "rect", rect },
    factoryName: `prop:${icon}`,
    price: { amountUsd: priceUsd, label },
  };
}

/** Re-tag a prop node to a new icon/label/price (the swap action). Returns the patch to apply. */
export function swapPropPatch(icon: PropIcon, label: string, priceUsd: number): Partial<GeoNode> {
  return { factoryName: `prop:${icon}`, name: label, price: { amountUsd: priceUsd, label } };
}
