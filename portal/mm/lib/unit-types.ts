// Type VOCABULARY — the visual + textual language for unit types. Two surfaces need a SHARED,
// same-sized representation of each type: (1) the per-cell TYPE dropdown in the authoring grid, and (2) the
// labels on the drawn SVG floor plan. So the acronym + the glyph live in ONE place, keyed by the AuthoringType
// `key`, and both surfaces read from here. (Presentation only — it does NOT touch the pure authoring model.)
//
// GLYPHS are SVG paths on a FIXED 24×24 viewBox (same-sized,: "that visuality is important"), drawn
// currentColor so a caller tints them (type colour, or ink on a filled cell). Simple schematic marks, not art —
// readable at 14px. edits this legend (acronyms + shapes); it's deliberately data so it's easy to change.

/** One type's visual identity: a short ACRONYM (≤3 chars) + a 24×24 SVG glyph (paths in currentColor). */
export interface TypeVocab {
  key: string;        // matches AuthoringType.key
  acronym: string;    // ST, 1B, 2B … — shown in the dropdown + optionally on the plan
  label: string;      // full human label (fallback / tooltip)
  glyph: string;      // inner SVG markup for a 0 0 24 24 viewBox (paths/rects), stroke/fill = currentColor
}

// ── the glyph set (24×24, schematic) ────────────────────────────────────────
// Bedrooms = N small "room" squares in a row (studio = 1, 1BR = 2 … reading the count at a glance). Non-residential
// types get a distinct mark. All stroked in currentColor at ~1.6; filled marks use currentColor.
const rooms = (n: number): string => {
  // n squares, centred on the 24-wide canvas, 6px boxes with 1px gaps, vertically centred.
  const box = 5.5, gap = 1.5, total = n * box + (n - 1) * gap;
  const x0 = (24 - total) / 2, y = (24 - box) / 2;
  return Array.from({ length: n }, (_, i) => {
    const x = x0 + i * (box + gap);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${box}" height="${box}" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
  }).join("");
};

/** The canonical vocabulary. Order = the natural progression (residential by bed count, then specials). */
export const TYPE_VOCAB: TypeVocab[] = [
  { key: "studio", acronym: "ST", label: "Studio",      glyph: rooms(1) },
  { key: "1br",    acronym: "1B", label: "1 Bedroom",   glyph: rooms(2) },
  { key: "2br",    acronym: "2B", label: "2 Bedroom",   glyph: rooms(3) },
  { key: "3br",    acronym: "3B", label: "3 Bedroom",   glyph: rooms(4) },
  { key: "4br",    acronym: "4B", label: "4 Bedroom",   glyph: rooms(5) },
  // duplex — two stacked levels (a unit over two floors)
  { key: "duplex", acronym: "DX", label: "Duplex",      glyph:
    `<rect x="7" y="4" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
    `<rect x="7" y="13" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
    `<path d="M12 11 v2" stroke="currentColor" stroke-width="1.5"/>` },
  // penthouse — a star / crown mark (top-tier)
  { key: "penthouse", acronym: "PH", label: "Penthouse", glyph:
    `<path d="M12 4 l2.2 4.5 4.8 .7 -3.5 3.4 .9 4.9 -4.4-2.3 -4.4 2.3 .9-4.9 -3.5-3.4 4.8-.7 z" fill="currentColor" stroke="none"/>` },
  // shop — a storefront (awning + opening)
  { key: "shop", acronym: "SH", label: "Shop",          glyph:
    `<path d="M5 9 h14 l-1.5-4 h-11 z" fill="currentColor" stroke="none"/>` +
    `<rect x="5" y="9" width="14" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
    `<path d="M10 20 v-6 h4 v6" fill="none" stroke="currentColor" stroke-width="1.5"/>` },
  // office — a desk / screen
  { key: "office", acronym: "OF", label: "Office",      glyph:
    `<rect x="5" y="6" width="14" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
    `<path d="M9 19 h6 M12 15 v4" stroke="currentColor" stroke-width="1.5"/>` },
  // core / elevator — an X (structural, not sellable)
  { key: "elevator", acronym: "CR", label: "Core / Lift", glyph:
    `<rect x="7" y="4" width="10" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
    `<path d="M12 7 l-2 3 h4 z M12 17 l-2-3 h4 z" fill="currentColor" stroke="none"/>` },
];

const BY_KEY = new Map(TYPE_VOCAB.map((v) => [v.key, v]));

/** The vocab for a type key, or a neutral fallback (acronym = the key upper-cased, a dot glyph). */
export function typeVocab(key: string): TypeVocab {
  return BY_KEY.get(key) ?? { key, acronym: (key || "?").slice(0, 3).toUpperCase(), label: key || "—",
    glyph: `<circle cx="12" cy="12" r="3" fill="currentColor"/>` };
}

/** Just the acronym (for compact labels). */
export function typeAcronym(key: string): string {
  return typeVocab(key).acronym;
}
