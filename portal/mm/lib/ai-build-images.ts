// MM-by-AI — the IMAGE producer seam (stage 4 of the design docs).
//
// THE SEAM (media.ts §2 "source-agnostic"): a generated image is just a MediaItem with source:"generated" +
// base64 bytes. This module is the PRODUCER that fills a pack's MISSING required slots (lib/media.requiredSlots
// minus the slots already carrying an upload/generated item) by calling an image model, and returns the new
// MediaItems. Storage, slots and export are untouched — export already placeholder-backfills every empty slot
// (law #2), so image-gen is ALWAYS best-effort, NEVER blocking: if the model is absent or fails, the pack still
// exports complete (tinted placeholders fill the gaps).
//
// STUB-FIRST: the DeepSeek text pass produces a full importable building on its own; images layer
// after. So the DEFAULT producer here is a STUB that generates nothing — a full building still exports, with
// placeholders in the image slots. Wiring the real Gemini call is a one-function swap (`generateSlotImage`):
// read GEMINI_API_KEY from env (server-only, same discipline as DEEPSEEK_API_KEY), call the image endpoint with
// the slot's prompt, return the bytes. Nothing else changes.
//
// HONEST BOUNDARY: generated plans/renderings are DEMO / MARKETING / EXHIBITION / ART — never a
// surveyed drawing. The prompt text below keeps that framing (illustrative, schematic).

import type { GeoNode, MediaItem, Pack, Unit } from "./pack";
import { type MediaSlot, mediaCoverage } from "./media";
import { ancestorsOf, cameraViewPhrase, geoNodes } from "./geo";

/** A built image: the raw bytes + their mime, ready to wrap in a source:"generated" MediaItem. */
export interface GeneratedImage {
  bytes: Uint8Array;
  mime: string; // image/png | image/jpeg | image/webp
}

/** The default house style when a project hasn't set its own — keeps a set coherent + marketing-safe. */
const DEFAULT_STYLE = "clean contemporary architectural illustration, soft daylight, no text, no watermark";

/** Options that enrich a prompt so a SET of images reads as one building: a shared project STYLE
 *  (look & feel), and the slot's own DESCRIPTION (the per-subtype caption the author wrote). The reference-image
 *  conditioning is passed separately to the model (not in the text) — see generateSlotImage. */
export interface PromptOpts {
  style?: string;   // the project's look-&-feel anchor, applied to EVERY image so the set matches
  caption?: string; // the author's description for THIS slot (per-subtype detail)
}

/** Find the representative unit behind a `units/<TYPE>_<SUB>` slot so its prompt carries the REAL data
 *  (size, type, view, baths) MM already holds — not just a generic label. PURE. */
function unitForSlot(pack: Pack, slot: MediaSlot): Unit | undefined {
  const m = /^units\/([^_]+)_?(.*)$/.exec(slot.key);
  if (!m) return undefined;
  const typeKey = m[1].toLowerCase();
  const subKey = (m[2] || "").toLowerCase();
  const units = pack.buildingUnits[slot.buildingId] || [];
  // match on type; prefer one whose subtype label slugifies to the slot's subtype tag, else the first of the type.
  const ofType = units.filter((u) => u.type.toLowerCase() === typeKey);
  if (!subKey) return ofType[0];
  return ofType.find((u) => (u.subtype || "").toLowerCase().replace(/[^a-z0-9]+/g, "").startsWith(subKey.replace(/[^a-z0-9]+/g, ""))) || ofType[0];
}

/** A short human phrase describing a unit from its data: "a 72 m² 2-bedroom corner unit, sea view". PURE. */
function unitPhrase(u: Unit, typeLabel: string): string {
  const parts: string[] = [];
  if (u.sqm > 0) parts.push(`${u.sqm} m²`);
  parts.push(typeLabel.toLowerCase());
  if (u.corner) parts.push("corner");
  let s = `a ${parts.join(" ")} unit`;
  const extra: string[] = [];
  if (u.baths) extra.push(`${u.baths} bath${u.baths > 1 ? "s" : ""}`);
  if (u.view) extra.push(`${u.view} view`);
  if (extra.length) s += `, ${extra.join(", ")}`;
  return s;
}

/** Loose slug for cross-tree name matching (geo node names vs slot labels/building names). */
function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, ""); }

/**
 * Resolve the camera a given image slot should render FROM, if the author placed one. The geo tree and the
 * authored building/unit records are PARALLEL trees (not id-linked — the finding), so we match across them by
 * the only durable link they share: NAME. For a `unit`/`level` slot we look for a geo `unit`/`floor` node that
 * (a) carries a camera, (b) sits under a `building` ancestor whose name slugifies to the slot building's name, and
 * (c) for a unit slot, whose own name aligns to the slot's type/subtype label (a floor slot just needs the floor).
 * Deterministic (first match in geo order) and fail-soft — no geo / no camera / no match → undefined, prompt
 * unchanged. PURE. The camera's {x,y,facingDeg,fovDeg} become an accurate-angle phrase via cameraViewPhrase. */
export function cameraForSlot(pack: Pack, slot: MediaSlot): GeoNode["camera"] {
  const nodes = geoNodes(pack);
  if (nodes.length === 0) return undefined;
  const wantKind = slot.kind === "level" ? "floor" : slot.kind === "unit" ? "unit" : undefined;
  if (!wantKind) return undefined; // only room-level slots (unit/floor) have a meaningful interior viewpoint
  const bName = slug(pack.buildings.find((x) => x.id === slot.buildingId)?.name || slot.buildingId);
  // the slot's own descriptive tail (type/subtype for a unit, "floor N" for a level) — used to disambiguate
  // when a building has more than one camera at this kind. Falls back to any camera of the kind under the building.
  const wantLabel = slug(slot.label.replace(/^unit plan:|^level plan,/i, ""));
  let fallback: GeoNode["camera"] | undefined;
  for (const n of nodes) {
    if (n.kind !== wantKind || !n.camera) continue;
    const bAnc = ancestorsOf(pack, n.id).find((a) => a.kind === "building");
    if (bName && slug(bAnc?.name || "") !== bName) continue; // wrong building
    if (!fallback) fallback = n.camera; // first camera of the right kind+building
    if (wantLabel && slug(n.name).includes(wantLabel)) return n.camera; // a label-aligned camera wins
  }
  return fallback;
}

/**
 * Turn a required slot into the text prompt an image model gets. Capability-level, schematic framing — never
 * "surveyed" or "as-built". Now enriched with the REAL unit data MM holds, the author's per-slot
 * description, and a SHARED project style so a whole set reads as one building. for a room slot (unit/floor)
 * with a placed camera, the accurate-angle VIEWPOINT phrase is appended so Gemini renders the room FROM it.
 */
export function slotImagePrompt(pack: Pack, slot: MediaSlot, opts: PromptOpts = {}): string {
  const cam = cameraForSlot(pack, slot);
  const view = cam ? ` Camera: ${cameraViewPhrase(cam)}.` : "";
  const b = pack.buildings.find((x) => x.id === slot.buildingId);
  const name = b?.name || slot.buildingId;
  const area = b?.area ? `, ${b.area}` : "";
  const style = (opts.style || DEFAULT_STYLE).trim();
  const desc = opts.caption?.trim() ? ` ${opts.caption.trim()}.` : "";
  switch (slot.kind) {
    case "rendering":
      if (slot.key.includes("INT_"))
        return `Interior lobby of a modern residential building "${name}"${area}.${desc} Style: ${style}. Wide 16:9.`;
      if (slot.key.includes("FAC_"))
        return `Amenity / facilities area (pool deck or sky lounge) of "${name}"${area}.${desc} Style: ${style}. Wide 16:9.`;
      return `Exterior hero render of a modern residential tower "${name}"${area}.${desc} Style: ${style}. Wide 16:9.`;
    case "level":
      // With a placed camera the author wants the room SEEN from that viewpoint (a perspective interior), not a
      // top-down plan — the two framings would contradict. Without a camera, keep the schematic plan (unchanged).
      if (cam)
        return `Interior perspective render of a floor of "${name}", ${slot.label}, seen from inside the space.${view}${desc} Style: ${style}. 4:3.`;
      return `Schematic floor-level plan diagram (top-down, illustrative, not a survey) for "${name}", ${slot.label}.${desc} Flat vector style, 4:3.`;
    case "unit": {
      const u = unitForSlot(pack, slot);
      const typeLabel = b?.unitTypes?.find((t) => t.key === u?.type)?.label || u?.type || slot.label;
      const detail = u ? ` This is ${unitPhrase(u, typeLabel)}.` : "";
      // Same camera rule: a placed viewpoint means an interior perspective OF the unit, not its top-down plan.
      if (cam)
        return `Interior perspective render of an apartment unit, ${slot.label}.${detail}${view}${desc} Style: ${style}. 4:3.`;
      return `Schematic apartment unit floor plan (top-down, illustrative, not a survey), ${slot.label}.${detail}${desc} Flat vector style, 4:3.`;
    }
    default:
      return `${slot.label} for "${name}"${area}.${desc} Style: ${style}.`;
  }
}

/** A reference image (user-uploaded) used to CONDITION the whole set's look & feel. Base64 + mime. */
export interface ReferenceImage { dataB64: string; mime: string; }

/** Per-call image-gen options: the user's Gemini key, the project style + reference images (set-wide look & feel). */
export interface ImageGenOpts {
  signal?: AbortSignal;
  max?: number;
  apiKey?: string;              // the user's Gemini key (from Settings) — without it we stay stubbed
  style?: string;               // project look-&-feel, applied to every prompt
  references?: ReferenceImage[]; // reference images that condition the whole set so it reads as one building
  caption?: (slot: MediaSlot) => string | undefined; // the author's per-slot description lookup
}

/**
 * The single swap-point for a real image model — a REAL Gemini image call when a key is given, else the STUB
 * (returns null → the slot keeps its placeholder; export never blocks, law #2). Fail-soft: any fault → null.
 * Reference images are passed as extra inlineData parts so the whole set shares a look. Runs client-side with the
 * user's own key (reference images never leave the user's device except to Google under their key).
 */
export async function generateSlotImage(
  prompt: string,
  _slot: MediaSlot,
  opts?: { signal?: AbortSignal; apiKey?: string; references?: ReferenceImage[] },
): Promise<GeneratedImage | null> {
  const key = opts?.apiKey?.trim();
  if (!key) return null; // STUB path — no key, no image (placeholder backfills at export)
  try {
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const r of opts?.references || []) parts.push({ inlineData: { mimeType: r.mime, data: r.dataB64 } });
    const model = "gemini-2.0-flash-preview-image-generation";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts?.signal,
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } }),
    });
    if (!res.ok) return null;
    const j = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> };
    const inline = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) return null;
    return { bytes: b64ToBytes(inline.data), mime: inline.mimeType || "image/png" };
  } catch {
    return null; // fail-soft — never block export on an image fault
  }
}

export interface GenerateImagesResult {
  items: MediaItem[]; // the newly generated source:"generated" MediaItems (empty when no key / all failed)
  attempted: number; // how many empty slots we tried
  filled: number; // how many came back with real bytes
}

/**
 * Fill a pack's MISSING image slots with generated images. Pure orchestration over the swap-point above:
 * find the empty required slots (mediaCoverage), ask the model per slot (enriched with the unit data, the slot's
 * description + the shared style + reference images), wrap any bytes as a source:"generated" MediaItem. Returns the
 * new items. Best-effort — no key / a null / failed slot is simply left for the export placeholder. Never throws.
 */
export async function generateMissingImages(
  pack: Pack,
  opts?: ImageGenOpts,
): Promise<GenerateImagesResult> {
  const { empty } = mediaCoverage(pack);
  const slots = typeof opts?.max === "number" ? empty.slice(0, Math.max(0, opts.max)) : empty;
  const items: MediaItem[] = [];
  for (const slot of slots) {
    try {
      const prompt = slotImagePrompt(pack, slot, { style: opts?.style, caption: opts?.caption?.(slot) });
      const img = await generateSlotImage(prompt, slot, { signal: opts?.signal, apiKey: opts?.apiKey, references: opts?.references });
      if (img && img.bytes.length > 0) {
        items.push({
          id: `gen-${slot.buildingId}-${slot.key.replace(/[^a-z0-9]+/gi, "-")}`,
          buildingId: slot.buildingId,
          slotKey: slot.key,
          source: "generated",
          mime: img.mime,
          dataB64: bytesToB64(img.bytes),
        });
      }
    } catch {
      // fail-soft: leave this slot to the export placeholder
    }
  }
  return { items, attempted: slots.length, filled: items.length };
}

/** bytes -> base64 (Node Buffer or browser btoa). The Pack stores image bytes as base64 (pack.ts MediaItem). */
export function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 -> bytes (the Gemini reply's inlineData.data is base64). */
function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
