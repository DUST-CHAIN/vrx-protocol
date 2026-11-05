// Pack export tests — buildPackFiles (pure). No zip/browser needed. Run via tsx (Node 18+ has Web Crypto).
// Covers: pack.json manifest shape, per-building files, terms files, checksum presence/validity, and
// LAW #2 backfill (a sparse building still emits a schema-valid building.json).

import { buildPackFiles, sha256Hex } from "./export";
import { emptyPack, type Pack } from "./pack";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

async function main() {
  // --- sha256 sanity (known vector: sha256("") ) ---
  const empty = await sha256Hex("");
  ok(empty === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256('') known vector");

  // --- a realistic pack ---
  const pack: Pack = {
    developer: { id: "acme-developments", name: "Acme Developments", holdingCompany: "Acme Holdings" },
    companies: [{ id: "acme-co", name: "Acme Co", registration: "TH-0001" }],
    complexes: [{ id: "riverside", name: "Riverside", companyId: "acme-co", amenities: ["Pool"], buildings: ["riverside-north"] }],
    buildings: [
      { id: "riverside-north", name: "Riverside North", complexId: "riverside", type: "High Rise", stories: 20, termsRef: "standard-2y" },
    ],
    buildingUnits: {
      "riverside-north": [
        { id: "unit-0801", type: "studio", subtype: "A", floor: 8, unitNumber: 801, sqm: 30, priceUsd: 95000 },
      ],
    },
    terms: [{ id: "standard-2y", data: { bookingFee: [1500], depositPct: [20, 30] } }],
  };

  const files = await buildPackFiles(pack);

  // --- the layout ---
  ok("pack.json" in files, "emits pack.json");
  ok("buildings/riverside-north/building.json" in files, "emits building.json");
  ok("buildings/riverside-north/units.csv" in files, "emits units.csv");
  ok("terms/standard-2y.json" in files, "emits terms/<id>.json");

  // --- manifest shape (schema: tree.complexes embedded) ---
  const manifest = JSON.parse(files["pack.json"]);
  ok(manifest.schemaVersion === "1.0", "manifest schemaVersion 1.0");
  ok(manifest.developer.id === "acme-developments", "manifest developer id");
  ok(Array.isArray(manifest.tree.complexes) && manifest.tree.complexes[0].id === "riverside", "tree.complexes embedded in manifest");
  ok(manifest.tree.complexes[0].buildings[0] === "riverside-north", "complex references its building id");
  ok(manifest.companies && manifest.companies[0].id === "acme-co", "companies carried");

  // --- checksums present + valid hex for every non-manifest file ---
  const cks = manifest.checksums as Record<string, string>;
  ok("buildings/riverside-north/building.json" in cks, "checksum present for building.json");
  ok("buildings/riverside-north/units.csv" in cks, "checksum present for units.csv");
  ok(Object.values(cks).every((h) => /^[a-f0-9]{64}$/.test(h)), "all checksums are 64-hex");
  // checksum actually matches the file content
  const bjson = files["buildings/riverside-north/building.json"];
  ok((await sha256Hex(bjson)) === cks["buildings/riverside-north/building.json"], "building.json checksum matches its content");

  // --- building.json content ---
  const b = JSON.parse(files["buildings/riverside-north/building.json"]);
  ok(b.id === "riverside-north" && b.type === "High Rise" && b.stories === 20, "building.json core fields");
  ok(b.units === 1, "building.units backfilled from the unit count");

  // --- LAW #2: a SPARSE pack still exports a schema-valid building.json (backfill) ---
  const sparse = emptyPack("Solo Dev");
  sparse.complexes = [{ id: "cx", name: "CX", buildings: ["b-min"] }];
  sparse.buildings = [{ id: "b-min", name: "", complexId: "cx", type: "", stories: 0 } as Pack["buildings"][number]];
  sparse.buildingUnits = { "b-min": [] };
  const sparseFiles = await buildPackFiles(sparse);
  const sb = JSON.parse(sparseFiles["buildings/b-min/building.json"]);
  ok(sb.name === "b-min", "backfill: empty name -> id");
  ok(sb.type === "High Rise", "backfill: empty type -> default High Rise");
  ok(sb.stories === 1, "backfill: stories 0 -> schema minimum 1");
  ok("pack.json" in sparseFiles, "sparse pack still exports a manifest (always-exportable)");

  console.log(`\nexport.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.log("FAIL (threw):", e); process.exit(1); });
