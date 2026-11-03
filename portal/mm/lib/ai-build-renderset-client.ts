// MM-by-AI — the DEFAULT image producer (CLIENT, fetch). Twin of ai-build-renderset.ts: same catalog + the same
// DETERMINISTIC slot→file mapping (renderset-map.ts), but FETCHES by public URL since the browser can't use fs.
// Each building picks one set (by name hash), every slot maps to its ACTUAL file — no round-robin — so the
// shell's default images are coherent (Floor N → Floor N's plan, 1BR-A → the 1BR-A layout) and match the CLI.

import type { MediaItem, Pack } from "./pack";
import { mediaCoverage } from "./media";
import { pickSet, rendersetFileForSlot } from "./renderset-map";

const BASE = "/renderings";

async function fetchImg(setDir: string, rel: string): Promise<{ b64: string; mime: string } | null> {
  try {
    const res = await fetch(`${BASE}/${setDir}/${rel}`);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return { b64: btoa(bin), mime: rel.endsWith(".png") ? "image/png" : "image/jpeg" };
  } catch {
    return null;
  }
}

/** Fill a pack's MISSING image slots from the catalog (client fetch), each building's slots mapped to its set. */
export async function fillFromRendersetClient(pack: Pack): Promise<MediaItem[]> {
  const { empty } = mediaCoverage(pack);
  const items: MediaItem[] = [];
  const setByBuilding = new Map<string, ReturnType<typeof pickSet>>();
  const rCursor: Record<string, number> = {};
  for (const slot of empty) {
    let set = setByBuilding.get(slot.buildingId);
    if (!set) { set = pickSet(slot.buildingId); setByBuilding.set(slot.buildingId, set); }
    const rel = rendersetFileForSlot(set, slot, rCursor);
    if (!rel) continue;
    const img = await fetchImg(set.dir, rel);
    if (!img) continue;
    items.push({
      id: `set-${slot.buildingId}-${slot.key.replace(/[^a-z0-9]+/gi, "-")}`,
      buildingId: slot.buildingId,
      slotKey: slot.key,
      source: "generated",
      mime: img.mime,
      dataB64: img.b64,
      caption: `${slot.label} — reference render`,
    });
  }
  return items;
}
