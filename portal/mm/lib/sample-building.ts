// The "Load sample" demo — a LARGE, interesting tower authored directly in the store so it opens
// fully editable in every face and shows off Preview + performance. Rich type mix (shops, studio, 1BR, 2BR, 3BR,
// penthouse) with a public-space core column, a FEW DUPLEXES on the upper floors, and the real Miracle-Tower image
// set attached. Built as an AuthoredProject (not the lossy catalog→pack path), so it is the authored truth.

import type { AuthoredProject, AuthoredBuilding } from "./project";
import { newBuilding } from "./project";
import { defaultTypes, type UnitCell } from "./authoring";
import type { MediaItem } from "./pack";

export const SAMPLE_BUILDING_ID = "aurora-tower";

// The sample's building shape: a tall tower so performance + a long scroll are visible.
const FLOORS = 34;
const PER_FLOOR = 8;

// CONSTANT-PLATE model: every floor is the SAME physical footprint — it never grows going up. So the floor
// AREA stays ~constant; what changes is the UNIT MIX. Lower floors pack MORE, SMALLER units into the plate; higher
// floors have FEWER, LARGER units (the same plate, partitioned differently). The top is a penthouse level: 1–2 big
// units + a few others, the FEWEST units of any floor → its total m² is ≤ a normal floor, never more.
//
// Each band below lists the residential units PLACED on a floor (left→right, the core column is inserted mid-row).
// Unit COUNT drops as we go up; the default-palette sizes (studio≈34, 1br≈48, 2br≈75, 3br≈105, penthouse≈180,
// duplex≈150) mean each floor's units sum to roughly the same plate while the per-unit size grades upward.
const CORE_COL_FRACTION = 0.5; // the public-space core sits mid-plate on every floor

// Each band fills the SAME ~plate (≈450 m² of sellable units) so the floor area stays constant up the tower. Lower
// floors = MORE, SMALLER units; higher floors = FEWER, LARGER units; totals stay within a tight band (never growing
// upward). Default-palette sizes: studio≈34, 1br≈48, 2br≈75, 3br≈105, penthouse≈180, duplex≈150, shop≈45.
type Placed = { type: string; sub: string };
function bandUnits(floor: number): Placed[] {
  // floors are 1-based here (floor = index+1); FLOORS total.
  if (floor <= 2) return [ // ground retail — many small shop units (~7×45 ≈ 315; retail plate reads lighter, fine)
    { type: "shop", sub: "a" }, { type: "shop", sub: "b" }, { type: "shop", sub: "c" }, { type: "shop", sub: "a" },
    { type: "shop", sub: "b" }, { type: "shop", sub: "c" }, { type: "shop", sub: "a" },
  ];
  if (floor >= FLOORS) // TOP — just 2 penthouses (~180+180 ≈ 360): the FEWEST units, plate ≤ the floors below
    return [{ type: "penthouse", sub: "a" }, { type: "penthouse", sub: "b" }];
  if (floor >= FLOORS - 3) return [ // sky band — 4 large (105+75+105+75 ≈ 360): fewer, bigger
    { type: "3br", sub: "a" }, { type: "2br", sub: "b" }, { type: "3br", sub: "c" }, { type: "2br", sub: "a" },
  ];
  if (floor >= Math.round(FLOORS * 0.66)) return [ // upper — 5 units (75+75+105+75+105 ≈ 435)
    { type: "2br", sub: "a" }, { type: "2br", sub: "b" }, { type: "3br", sub: "a" }, { type: "2br", sub: "c" }, { type: "3br", sub: "b" },
  ];
  if (floor >= Math.round(FLOORS * 0.33)) return [ // mid — 6 units (48+75+48+75+48+75 ≈ 369)
    { type: "1br", sub: "a" }, { type: "2br", sub: "a" }, { type: "1br", sub: "b" }, { type: "2br", sub: "b" }, { type: "1br", sub: "c" }, { type: "2br", sub: "c" },
  ];
  return [ // lower residential — 7 units, a studio/1br/2br mix that fills the plate (34+48+75+34+48+75+48 ≈ 362)
    { type: "studio", sub: "a" }, { type: "1br", sub: "a" }, { type: "2br", sub: "a" }, { type: "studio", sub: "b" },
    { type: "1br", sub: "b" }, { type: "2br", sub: "b" }, { type: "1br", sub: "c" },
  ];
}

/** Build the grid floor-by-floor under the constant-plate model, then overlay a few SKY DUPLEXES. PURE. */
function sampleMatrix(): UnitCell[][] {
  const coreCol = Math.floor(PER_FLOOR * CORE_COL_FRACTION);
  const grid: UnitCell[][] = [];
  for (let f = 0; f < FLOORS; f++) {
    const row: UnitCell[] = Array.from({ length: PER_FLOOR }, () => ({ typeKey: "", subtypeKey: "" }));
    // the public-space core on every floor except the very top (engine room above)
    if (f < FLOORS - 1) row[coreCol] = { typeKey: "public", subtypeKey: "a" };
    // place this floor's band units into the non-core columns, left→right
    const units = bandUnits(f + 1);
    let u = 0;
    for (let c = 0; c < PER_FLOOR && u < units.length; c++) {
      if (c === coreCol && f < FLOORS - 1) continue;
      row[c] = { typeKey: units[u].type, subtypeKey: units[u].sub };
      u++;
    }
    grid.push(row);
  }
  // A FEW SKY DUPLEXES in the upper band (each = a lower cell + a continuation above), on free non-core columns.
  const top = FLOORS - 1;
  const free = (f: number, c: number) => grid[f]?.[c]?.typeKey && grid[f][c].typeKey !== "public";
  const placeDuplex = (floor: number, col: number, sub: string) => {
    if (floor + 1 > top || !free(floor, col) || !free(floor + 1, col)) return;
    grid[floor][col] = { typeKey: "duplex", subtypeKey: sub };
    grid[floor + 1][col] = { typeKey: "duplex", subtypeKey: sub, cont: true };
  };
  placeDuplex(FLOORS - 6, 0, "a");
  placeDuplex(FLOORS - 6, PER_FLOOR - 1, "b");
  placeDuplex(FLOORS - 8, 1, "c");
  return grid;
}

/** The full sample project — a developer + one development holding the big tower. PURE. */
export function sampleProject(): AuthoredProject {
  const building: AuthoredBuilding = newBuilding({
    id: "aurora-tower",
    name: "Aurora Tower",
    type: "High Rise",
    area: "northpoint",
    tagline: "A 34-storey landmark of shops, homes, sky duplexes & penthouses.",
    floors: FLOORS,
    unitsPerFloor: PER_FLOOR,
    floorAreaM2: 1400,
    types: defaultTypes(),
    matrix: sampleMatrix(),
    reservationFeeUsd: 2000,
    bookingDepositUsd: 10000,
    maintenancePerSqmUsd: 1.5,
    transferFeePct: "6.30%",
    termsRef: "aurora-standard",
    amenities: ["Infinity pool", "Sky lounge", "Fitness & sauna", "Co-working", "24h security"],
  });
  return {
    v: 1,
    domain: "realestate",
    developer: { id: "meridian-living", name: "Meridian Living", holdingCompany: "Meridian Living Co., Ltd" },
    companies: [{ id: "meridian-co", name: "Meridian Living Co., Ltd" }],
    complexes: [{ id: "aurora-residences", name: "Aurora Residences", companyId: "meridian-co", area: "northpoint", buildings: [building] }],
    terms: [{
      id: "aurora-standard",
      data: {
        bookingFee: [2000], depositPct: [20, 30], contractDays: 30,
        onContract: [{ installments: 1, amountPct: 20 }],
        ongoing: [{ installments: 24, amountPct: 2.5 }],
        onKeyPct: [30], taxPct: [0],
      },
    }],
    activeBuildingId: "aurora-tower",
  };
}

// The real Miracle-Tower photos (self-contained under MM's /public/renderings) → source:"upload" MediaItems on the
// sample's slots, so Preview/brochure show real photography. Fetched + base64-encoded at LOAD time (MediaItem is
// base64-only; fetching avoids bloating the bundle). Best-effort: a missing file is simply skipped (placeholder fills).
const MT = "/renderings/miracle-tower";
const SAMPLE_IMAGE_MAP: Array<{ slotKey: string; url: string }> = [
  { slotKey: "renderings/EXT_hero", url: `${MT}/exterior/ext-1-hero.jpeg` },
  { slotKey: "renderings/INT_lobby", url: `${MT}/interior/int-1-living.jpeg` },
  { slotKey: "renderings/FAC_amenity", url: `${MT}/facilities/fac-1-pool.jpeg` },
];

async function urlToB64(url: string): Promise<{ b64: string; mime: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const mime = blob.type || "image/jpeg";
    const b64: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(String(r.result).split(",")[1] || ""); // strip the data: prefix
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return b64 ? { b64, mime } : null;
  } catch {
    return null;
  }
}

/** Fetch the sample's real images (browser only) as MediaItems for the Aurora Tower building. Best-effort. */
export async function sampleMediaItems(): Promise<MediaItem[]> {
  if (typeof window === "undefined") return [];
  const items: MediaItem[] = [];
  for (const { slotKey, url } of SAMPLE_IMAGE_MAP) {
    const enc = await urlToB64(url);
    if (enc) items.push({
      id: `${SAMPLE_BUILDING_ID}:${slotKey}`.replace(/[^a-z0-9]+/gi, "-"),
      buildingId: SAMPLE_BUILDING_ID, slotKey, source: "upload", mime: enc.mime, dataB64: enc.b64,
    });
  }
  return items;
}
