// Media library tests (lib/media.ts) + export media backfill (lib/export.ts). Pure, no browser. Run via tsx.
// Covers: slot registry derivation (renderings + levels + unit-type plans), coverage counting, placeholder
// SVG (deterministic, correct aspect, labeled), path/ext mapping, and export's ALWAYS-COMPLETE media backfill
// (every required slot ships a blob — real image if present, else a placeholder) with manifest checksums.

import { emptyPack, type MediaItem, type Pack } from "./pack";
import {
  extForMime,
  itemForSlot,
  mediaCoverage,
  mediaPath,
  placeholderSvg,
  requiredSlots,
} from "./media";
import { buildPackFiles, buildPackMedia } from "./export";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// --- a pack with one building, 2 floors, 2 distinct unit types ---
const pack: Pack = {
  ...emptyPack("Acme"),
  complexes: [{ id: "cx", name: "CX", buildings: ["b1"] }],
  buildings: [{ id: "b1", name: "B1", complexId: "cx", type: "High Rise", stories: 2 }],
  buildingUnits: {
    b1: [
      { id: "u1", type: "STD", subtype: "A", floor: 1, sqm: 30, priceUsd: 90000 },
      { id: "u2", type: "STD", subtype: "A", floor: 1, sqm: 30, priceUsd: 90000 }, // same type -> ONE slot
      { id: "u3", type: "2BR", floor: 2, sqm: 70, priceUsd: 200000 }, // no subtype
    ],
  },
};

// --- slot registry: 3 renderings + 2 levels (floors 1,2) + 2 unit types (STD_A, 2BR) = 7 ---
const slots = requiredSlots(pack);
ok(slots.length === 7, `requiredSlots = 7 (got ${slots.length})`);
ok(slots.filter((s) => s.kind === "rendering").length === 3, "3 building renderings (EXT/INT/FAC)");
ok(slots.some((s) => s.key === "levels/1") && slots.some((s) => s.key === "levels/2"), "a level plan per floor present");
ok(slots.some((s) => s.key === "units/STD_A"), "unit-type plan keyed TYPE_SUBTYPE");
ok(slots.some((s) => s.key === "units/2BR"), "unit-type plan with no subtype = just TYPE");
ok(!slots.some((s, i) => slots.findIndex((x) => x.key === s.key && x.buildingId === s.buildingId) !== i), "no duplicate slots (STD_A deduped)");

// --- aspect ratios ---
ok(slots.find((s) => s.key === "renderings/EXT_hero")!.aspectW === 16, "hero rendering is 16:9");
ok(slots.find((s) => s.key === "levels/1")!.aspectW === 4, "level plan is 4:3");

// --- coverage: no real images yet => all empty ---
const cov0 = mediaCoverage(pack);
ok(cov0.total === 7 && cov0.filled === 0 && cov0.empty.length === 7, "coverage: 0 filled, 7 empty");

// --- attach one real upload to the hero slot ---
const hero: MediaItem = { id: "m1", buildingId: "b1", slotKey: "renderings/EXT_hero", source: "upload", mime: "image/jpeg", dataB64: btoa("JPEGBYTES") };
const packWithImg: Pack = { ...pack, media: [hero] };
ok(!!itemForSlot(packWithImg, "b1", "renderings/EXT_hero"), "itemForSlot finds the uploaded hero");
ok(mediaCoverage(packWithImg).filled === 1, "coverage: 1 filled after upload");

// --- placeholder SVG: deterministic, labeled, correct aspect ---
const slotHero = slots.find((s) => s.key === "renderings/EXT_hero")!;
const svgA = placeholderSvg(slotHero);
const svgB = placeholderSvg(slotHero);
ok(svgA === svgB, "placeholderSvg is deterministic (stable checksums)");
ok(svgA.includes("16:9") && svgA.includes("placeholder") && svgA.includes("Exterior (hero)"), "placeholder labels slot + ratio");
ok(/width="1920" height="1080"/.test(svgA), "placeholder uses the 16:9 pixel size");

// --- path + ext mapping ---
ok(extForMime("image/jpeg") === "jpg" && extForMime("image/svg+xml") === "svg", "extForMime maps mimes");
ok(mediaPath("b1", "renderings/EXT_hero", "image/jpeg") === "buildings/b1/media/renderings/EXT_hero.jpg", "mediaPath lands under buildings/<id>/media/");

// --- export media: ALWAYS COMPLETE (every slot ships a blob) ---
const binsEmpty = buildPackMedia(pack);
ok(Object.keys(binsEmpty).length === 7, `buildPackMedia backfills all 7 slots even with 0 uploads (got ${Object.keys(binsEmpty).length})`);
ok("buildings/b1/media/renderings/EXT_hero.svg" in binsEmpty, "empty hero slot ships an SVG placeholder");

const binsImg = buildPackMedia(packWithImg);
ok("buildings/b1/media/renderings/EXT_hero.jpg" in binsImg, "uploaded hero ships as .jpg (not placeholder)");
ok(!("buildings/b1/media/renderings/EXT_hero.svg" in binsImg), "no placeholder for a filled slot");
ok(Object.keys(binsImg).length === 7, "still 7 total (1 real + 6 placeholder)");

// --- export checksums cover media (real + placeholder) ---
async function main() {
  const files = await buildPackFiles(packWithImg);
  const manifest = JSON.parse(files["pack.json"]);
  const cks = manifest.checksums as Record<string, string>;
  ok("buildings/b1/media/renderings/EXT_hero.jpg" in cks, "manifest checksum for the uploaded image");
  ok("buildings/b1/media/levels/1.svg" in cks, "manifest checksum for a placeholder-backfilled level plan");
  ok(Object.values(cks).every((h) => /^[a-f0-9]{64}$/.test(h)), "all checksums (incl. media) are 64-hex");

  console.log(`\nmedia.test: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
