// §6a furniture-package engine tests (lib/furniture.ts). Pure, no I/O. Run via tsx.
// Covers: the catalog shape, seedPackage (count/parent/clamp/labels/prices/unique ids/icon tag), propIcon
// read-back, swapPropPatch, and that seeding is non-destructive (returns new nodes, doesn't touch inputs).

import { emptyPack, type GeoNode, type Pack } from "./pack";
import { deriveSqm, makeNode } from "./geo";
import {
  FURNITURE_PACKAGES,
  PROP_PALETTE,
  packageByKey,
  propIcon,
  seedPackage,
  swapPropPatch,
} from "./furniture";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// --- catalog shape ---
ok(FURNITURE_PACKAGES.length === 3, "catalog has the 3 seed packages");
ok(FURNITURE_PACKAGES.every((p) => p.props.length >= 1), "every package has at least one prop");
ok(FURNITURE_PACKAGES.every((p) => p.props.every((t) => t.rect.w > 0 && t.rect.h > 0)), "every prop template has a positive footprint");
ok(packageByKey("studio")?.label === "Studio", "packageByKey resolves a known key");
ok(packageByKey("nope") === undefined, "packageByKey returns undefined for an unknown key");

// --- seedPackage basics ---
const seeded = seedPackage("unit-1", "studio", new Set<string>(["unit-1"]));
ok(seeded.length === packageByKey("studio")!.props.length, "seedPackage emits one node per template prop");
ok(seeded.every((n) => n.kind === "prop"), "all seeded nodes are props");
ok(seeded.every((n) => n.parentId === "unit-1"), "all seeded props parent to the unit");
ok(seeded.every((n) => n.footprint?.shape === "rect"), "all seeded props carry a rect footprint");
ok(seeded.every((n) => !!n.name), "all seeded props carry a name/label");
ok(seeded.some((n) => n.price != null), "seeded props carry a price (inventory rule 2)");
ok(seeded.every((n) => (n.price ? n.price.label === n.name : true)), "a priced prop's price label matches its name");

// --- unique ids (seed against an id space that already holds a prop-1) ---
const seeded2 = seedPackage("unit-1", "studio", new Set<string>(["unit-1", "prop-1"]));
const ids = new Set(seeded2.map((n) => n.id));
ok(ids.size === seeded2.length, "seeded prop ids are unique");
ok(!ids.has("prop-1"), "seedPackage avoids an id already taken");

// --- icon round-trips through factoryName (no schema field for icon) ---
ok(seeded.every((n) => propIcon(n) !== undefined), "every seeded prop exposes its icon via factoryName");
ok(propIcon({ id: "x", name: "x", kind: "prop" }) === undefined, "propIcon undefined when no prop: tag");

// --- clamp: a template deliberately out of bounds comes back inside 0..1 ---
const bad = seedPackage("u", "studio", new Set<string>());
ok(bad.every((n) => {
  const fp = n.footprint;
  if (fp?.shape !== "rect") return false;
  const r = fp.rect;
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9;
}), "seeded prop footprints are clamped inside the unit (never protrude)");

// --- unknown package → empty ---
ok(seedPackage("u", "nope", new Set<string>()).length === 0, "seedPackage returns [] for an unknown package");

// --- non-destructive: seeding doesn't mutate the existing-id set's membership semantics (returns fresh nodes) ---
const existing = new Set<string>(["unit-1"]);
const before = existing.size;
seedPackage("unit-1", "one-bed", existing);
ok(existing.size === before, "seedPackage does not mutate the caller's id set");

// --- a seeded prop derives a real m² under a unit with a metre anchor (it's geometry too) ---
let gi = new Set<string>();
const building = makeNode("building", undefined, { metreW: 40, metreH: 25, rect: { x: 0, y: 0, w: 1, h: 1 } }, gi); gi.add(building.id);
const floor = makeNode("floor", building.id, { rect: { x: 0, y: 0, w: 1, h: 1 } }, gi); gi.add(floor.id);
const unit = makeNode("unit", floor.id, { rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, gi); gi.add(unit.id);
const props = seedPackage(unit.id, "studio", gi);
const pack: Pack = { ...emptyPack("Furn Test"), geo: [building, floor, unit, ...props] };
const sofa = props.find((n) => propIcon(n) === "sofa")!;
const sofaSqm = deriveSqm(pack, sofa.id);
ok(sofaSqm != null && sofaSqm > 0, "a seeded prop has a derived m² under a metre-anchored unit");

// --- swapPropPatch ---
const patch = swapPropPatch("chair", "Bar stool", 120);
ok(patch.factoryName === "prop:chair", "swapPropPatch tags the new icon");
ok(patch.name === "Bar stool" && patch.price?.amountUsd === 120, "swapPropPatch carries the new name + price");
ok(PROP_PALETTE.length >= 5, "the swap palette offers a reasonable set of pieces");

console.log(`furniture.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
