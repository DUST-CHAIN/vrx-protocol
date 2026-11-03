// MM-by-AI — the DEFAULT image producer (SERVER, fs). Fills a pack's missing image slots from the render-set
// CATALOG (renderset-map.ts) with a DETERMINISTIC slot→file mapping — NO round-robin (: "bad idea"). Each
// generated building PICKS one complete the operator catalog set (by name hash) so Floor N shows Floor N's actual plan and a
// 1BR-A shows the 1BR-A layout, and different buildings look different. Gemini + the placeholder backfill remain
// the FALLBACK for any slot the set can't map (e.g. a set with no interiors). Export names each image BY SLOT in
// the ZIP (media.ts mediaPath), so the mapping carries into the imported pack.
//
// SERVER-ONLY (reads files via fs) — used by the headless CLI + /api/ai-build. Returns source:"generated"
// MediaItems (base64).

import { promises as fs } from "fs";
import path from "path";
import type { MediaItem, Pack } from "./pack";
import { type MediaSlot, mediaCoverage } from "./media";
import { pickSet, rendersetFileForSlot, RENDER_SETS } from "./renderset-map";

const SETS_ROOT = path.join(process.cwd(), "public", "renderings");

async function readB64(setDir: string, rel: string): Promise<{ b64: string; mime: string } | null> {
  try {
    const buf = await fs.readFile(path.join(SETS_ROOT, setDir, rel));
    return { b64: buf.toString("base64"), mime: rel.endsWith(".png") ? "image/png" : "image/jpeg" };
  } catch {
    return null;
  }
}

export interface RendersetResult {
  items: MediaItem[];
  attempted: number;
  filled: number;
}

/**
 * Fill a pack's MISSING image slots from the catalog — each BUILDING picks one set, each slot maps to its ACTUAL
 * file. Fail-soft: an unmappable slot is left for the next producer / the export placeholder.
 */
export async function fillFromRenderset(pack: Pack): Promise<RendersetResult> {
  const { empty } = mediaCoverage(pack);
  const items: MediaItem[] = [];
  // one set per building (by id), so a floor's plan stays within that building's chosen set.
  const setByBuilding = new Map<string, ReturnType<typeof pickSet>>();
  const rCursor: Record<string, number> = {};
  for (const slot of empty) {
    let set = setByBuilding.get(slot.buildingId);
    if (!set) { set = pickSet(slot.buildingId); setByBuilding.set(slot.buildingId, set); }
    const rel = rendersetFileForSlot(set, slot, rCursor);
    if (!rel) continue;
    const img = await readB64(set.dir, rel);
    if (!img) continue;
    items.push(mkItem(slot, img.mime, img.b64));
  }
  return { items, attempted: empty.length, filled: items.length };
}

function mkItem(slot: MediaSlot, mime: string, dataB64: string): MediaItem {
  return {
    id: `set-${slot.buildingId}-${slot.key.replace(/[^a-z0-9]+/gi, "-")}`,
    buildingId: slot.buildingId,
    slotKey: slot.key,
    source: "generated",
    mime,
    dataB64,
    caption: `${slot.label} — reference render`,
  };
}

export { RENDER_SETS };
