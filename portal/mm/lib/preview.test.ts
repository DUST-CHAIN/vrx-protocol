// Preview adapter tests (lib/from-catalog.ts + lib/preview.ts). Pure, no browser. Run via tsx.
// Covers: catalog building -> Pack mapping (developer/company/complex/building/units/terms), the Miracle
// Tower demo load (real 476-unit building), and Pack -> Preview model (building + units + images, status stub).

import { catalogBuildingToPack, miracleTowerPack, MIRACLE_TOWER_ID, MIRACLE_TOWER_IMAGES } from "./from-catalog";
import { packToPreview } from "./preview";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// --- catalogBuildingToPack: a tiny synthetic building maps to a complete Pack ---
const cb = {
  id: "demo-b",
  name: "Demo Building",
  developer: "Summit Estates",
  area: "Central Pattaya",
  type: "High Rise",
  stories: 3,
  units: 2,
  amenities: ["Pool", "Gym"],
  unitTypes: [{ key: "studio", label: "Studio", sqmMin: 24, sqmMax: 24 }],
  terms: { bookingFee: [500], depositPct: [1] },
  inventory: [
    { id: "unit-101", type: "studio", floor: 1, sqm: 24, priceUsd: 90000, view: "Pool view", corner: true, baths: 1 },
    { id: "unit-201", type: "studio", floor: 2, sqm: 24, priceUsd: 95000 },
  ],
};
const pack = catalogBuildingToPack(cb);
ok(pack.developer.name === "Summit Estates" && pack.developer.id === "summit-estates", "developer mapped + slugged");
ok(pack.companies.length === 1 && pack.complexes.length === 1, "a company + complex wrapper is synthesized");
ok(pack.complexes[0].buildings[0] === "demo-b", "complex references the building id");
ok(pack.buildings.length === 1 && pack.buildings[0].stories === 3, "building mapped");
ok((pack.buildingUnits["demo-b"] || []).length === 2, "units mapped under the building id");
ok(pack.buildingUnits["demo-b"][0].termsRef === "demo-b-terms", "units reference the terms id");
ok(pack.terms.length === 1 && (pack.terms[0].data as any).bookingFee[0] === 500, "terms block carried verbatim");

// --- miracleTowerPack: the real demo building loads with its full inventory ---
const mt = miracleTowerPack();
ok(mt.buildings[0].id === MIRACLE_TOWER_ID && MIRACLE_TOWER_ID === "miracle-tower", "miracle tower id");
ok((mt.buildingUnits["miracle-tower"] || []).length === 476, `miracle tower has 476 units (got ${(mt.buildingUnits["miracle-tower"] || []).length})`);
ok(mt.buildings[0].stories === 29, "miracle tower = 29 stories");
ok(mt.terms.length === 1, "miracle tower carries its terms block");
ok(MIRACLE_TOWER_IMAGES.exterior.length >= 1 && MIRACLE_TOWER_IMAGES.exterior[0].startsWith("/renderings/miracle-tower/"), "real image URLs resolve under /renderings");

// --- packToPreview: Pack -> the view model the ported components read ---
const model = packToPreview(mt, "miracle-tower", MIRACLE_TOWER_IMAGES);
ok(!!model, "packToPreview returns a model for a real building id");
ok(model!.units.length === 476, "preview model carries all 476 units");
ok(model!.units.every((u) => u.status === 0), "preview stubs every unit status = 0 (available)");
ok(model!.building.name === "Miracle Tower" && model!.building.stories === 29, "preview building header mapped");
ok(model!.images.exterior.length >= 1, "preview carries the image buckets");
ok(packToPreview(mt, "no-such-building", MIRACLE_TOWER_IMAGES) === null, "packToPreview null for an unknown building");

// --- a unit's fields survive the round-trip to the preview model ---
const u101 = model!.units.find((u) => u.id === "unit-101");
ok(!!u101 && u101!.sqm > 0 && u101!.priceUsd > 0 && typeof u101!.floor === "number", "a preview unit has sqm/price/floor");

console.log(`\npreview.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
