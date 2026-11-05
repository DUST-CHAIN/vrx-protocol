// Media library — marketing images for a pack, SOURCE-AGNOSTIC + always-complete-on-export.
//
// THREE requirements:
//   1. INGEST + CARRY + EXPORT — uploaded images live in the Pack (pack.media[]) and ship in the export ZIP.
//   2. SOURCE-AGNOSTIC — an uploaded blob and a (future) Gemini-GENERATED blob are the SAME MediaItem. The
//      Gemini integration later just adds a PRODUCER that writes a MediaItem with source:"generated"; storage,
//      slots and export are unchanged. (reuse-the-pattern: build the seam once, plug producers in.)
//   3. PLACEHOLDER BACKFILL — every KNOWN slot always exports. A slot with no upload/generated image gets a
//      static tinted placeholder (the exact required aspect ratio, labeled) so the pack is always complete.
//      This is law #2 (always exportable -> always valid) applied to images — same discipline as export.ts's
//      field backfill, and the "active backfill / tinted placeholder" the app promised (MM_ENGINE_AND_FACES §3).
//
// The SLOT VOCABULARY is the one that survived old-MM -> the operator catalog -> VRX (MM_ENGINE_AND_FACES §3/§4 + ingest-pack
// README): per building — renderings/{EXT_,INT_,FAC_}, levels/{floor}; per unit-type — units/{TYPE}_{SUBTYPE}.
// Export lays them under buildings/<id>/media/{renderings,units,levels}/ (ingest-pack README §"Pack layout").
//
// PURE where it counts: the slot REGISTRY (requiredSlots) + the PLACEHOLDER bytes (placeholderSvg) are pure
// and testable with no browser. Only the upload helper (file -> base64) touches browser APIs.

import type { MediaItem, Pack, Unit } from "./pack";

export type { MediaItem, MediaSource } from "./pack";
export type SlotKind = "rendering" | "level" | "unit";

/** A canonical image slot: WHERE it lands + what shape it should be. Derived from the pack, never hand-listed. */
export interface MediaSlot {
  /** path within the building's media/ dir, e.g. "renderings/EXT_hero", "levels/8", "units/STD_A". */
  key: string;
  buildingId: string; // the building (textual id) this slot belongs to
  kind: SlotKind;
  label: string; // human label shown in the UI + baked into the placeholder
  aspectW: number; // required aspect ratio width : height (e.g. 16:9 hero, 4:3 plan)
  aspectH: number;
}

// ---------------------------------------------------------------------------
// The SLOT REGISTRY — derived from the pack (never invented by AI). A building always needs its three
// renderings; a floor present in the units needs a level plan; each distinct unit TYPE_SUBTYPE needs a plan.
// ---------------------------------------------------------------------------

/** The three canonical building renderings (the EXT/INT/FAC vocabulary). 16:9 marketing hero shape. */
const BUILDING_RENDERINGS: Array<{ key: string; label: string }> = [
  { key: "renderings/EXT_hero", label: "Exterior (hero)" },
  { key: "renderings/INT_lobby", label: "Interior (lobby)" },
  { key: "renderings/FAC_amenity", label: "Facilities (amenity)" },
];

/** distinct `{TYPE}_{SUBTYPE}` keys present in a building's units (uppercased, subtype optional). */
function unitTypeKeys(units: Unit[]): string[] {
  const set = new Set<string>();
  for (const u of units) {
    const t = (u.type || "").trim().toUpperCase();
    if (!t) continue;
    const sub = (u.subtype || "").trim().toUpperCase();
    set.add(sub ? `${t}_${sub}` : t);
  }
  return [...set].sort();
}

/** distinct floor numbers present in a building's units. */
function floorKeys(units: Unit[]): number[] {
  const set = new Set<number>();
  for (const u of units) if (Number.isFinite(u.floor)) set.add(u.floor);
  return [...set].sort((a, b) => a - b);
}

/**
 * The complete set of REQUIRED image slots for a pack, derived from its buildings + units. Every slot here
 * MUST appear in the export (filled or placeholder). PURE.
 */
export function requiredSlots(pack: Pack): MediaSlot[] {
  const slots: MediaSlot[] = [];
  for (const b of pack.buildings) {
    for (const r of BUILDING_RENDERINGS) {
      slots.push({ key: r.key, buildingId: b.id, kind: "rendering", label: r.label, aspectW: 16, aspectH: 9 });
    }
    const units = pack.buildingUnits[b.id] || [];
    for (const f of floorKeys(units)) {
      slots.push({ key: `levels/${f}`, buildingId: b.id, kind: "level", label: `Level plan — floor ${f}`, aspectW: 4, aspectH: 3 });
    }
    for (const t of unitTypeKeys(units)) {
      slots.push({ key: `units/${t}`, buildingId: b.id, kind: "unit", label: `Unit plan — ${t}`, aspectW: 4, aspectH: 3 });
    }
  }
  return slots;
}

/** The MediaItem a building+slot currently holds (upload/generated wins; undefined if only a placeholder would fill it). */
export function itemForSlot(pack: Pack, buildingId: string, slotKey: string): MediaItem | undefined {
  return (pack.media || []).find((m) => m.buildingId === buildingId && m.slotKey === slotKey && m.source !== "placeholder");
}

/** Count real (non-placeholder) images a pack carries, and how many required slots are still empty. */
export function mediaCoverage(pack: Pack): { filled: number; total: number; empty: MediaSlot[] } {
  const slots = requiredSlots(pack);
  const empty = slots.filter((s) => !itemForSlot(pack, s.buildingId, s.key));
  return { filled: slots.length - empty.length, total: slots.length, empty };
}

// ---------------------------------------------------------------------------
// PLACEHOLDER — a deterministic tinted SVG in the slot's exact aspect ratio, labeled. Bytes are stable for a
// given slot (so checksums are reproducible). "Tinted" = a soft slot-kind colour so the user sees it's injected.
// ---------------------------------------------------------------------------

const TINT: Record<SlotKind, string> = {
  rendering: "#1e3a5f", // deep blue — exteriors/renders
  level: "#334155", // slate — level plans
  unit: "#3f3a2f", // warm — unit plans
};

/** Escape text for inclusion in SVG. */
function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A static placeholder image for a slot, as an SVG string — the slot's exact aspect ratio, tinted by kind,
 * labeled with the slot label + "placeholder" + the required ratio so it's unmistakably injected (law #2 /
 * the app's "active backfill" promise). Deterministic: same slot -> same bytes -> stable checksum. PURE.
 */
export function placeholderSvg(slot: MediaSlot): string {
  const w = slot.aspectW * 120;
  const h = slot.aspectH * 120;
  const tint = TINT[slot.kind];
  const ratio = `${slot.aspectW}:${slot.aspectH}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="${tint}"/>`,
    `<rect x="8" y="8" width="${w - 16}" height="${h - 16}" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="3" stroke-dasharray="12 10"/>`,
    `<text x="50%" y="46%" fill="#ffffff" fill-opacity="0.85" font-family="system-ui,sans-serif" font-size="${Math.round(h / 12)}" font-weight="600" text-anchor="middle">${xml(slot.label)}</text>`,
    `<text x="50%" y="58%" fill="#ffffff" fill-opacity="0.5" font-family="system-ui,sans-serif" font-size="${Math.round(h / 20)}" text-anchor="middle">placeholder • ${ratio} • ${xml(slot.key)}</text>`,
    `</svg>`,
  ].join("");
}

/** The MIME for a placeholder (always SVG). */
export const PLACEHOLDER_MIME = "image/svg+xml";

// ---------------------------------------------------------------------------
// Export path helpers — the per-building media path + file extension from a MIME.
// ---------------------------------------------------------------------------

/** File extension for an image MIME. */
export function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    default: return "bin";
  }
}

/** The full ZIP path for a building+slot image with a given mime (ingest-pack layout: buildings/<id>/media/<slot>.<ext>). */
export function mediaPath(buildingId: string, slotKey: string, mime: string): string {
  return `buildings/${buildingId}/media/${slotKey}.${extForMime(mime)}`;
}

// ---------------------------------------------------------------------------
// Browser-only upload helper (kept apart from the pure path so tests never need it).
// ---------------------------------------------------------------------------

/** Read a File into a MediaItem (base64), source:"upload". Browser only (FileReader). */
export async function fileToMediaItem(file: File, buildingId: string, slotKey: string, id: string): Promise<MediaItem> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const dataB64 = btoa(bin);
  return { id, buildingId, slotKey, source: "upload", mime: file.type || "application/octet-stream", dataB64 };
}
