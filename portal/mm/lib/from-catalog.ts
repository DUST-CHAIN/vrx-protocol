// Import a REAL building straight from the VRX catalog into an MM Pack. The Preview face is
// the acceptance test — "when the pack is imported, does it render exactly as the real VRX developer view?"
// — so Preview needs REAL data. Rather than build the full ZIP round-trip first (deferred), we bring the
// building directly from the VRX catalog seed: demo-miracle-tower.json is the Miracle Tower slice of
// portal/lib/catalog-seed.json (476 units, 29 stories — the largest, fullest building; Explore).
//
// This is a one-way READ adapter (catalog building -> MM Pack). It is NOT the ZIP import (that round-trip
// "what we export we can import" is a separate owed slice). Pure + deterministic.

import type { Building, Pack, PaymentTerms, Unit, UnitType } from "./pack";
import type { PreviewImages } from "./preview";
import demoBuilding from "./demo-miracle-tower.json";

// The shape of a catalog-seed building (only the fields we read — the JSON has more). Loose by design:
// the catalog is the source of truth, we map a subset into MM's schema.
interface CatalogUnit {
  id: string;
  type: string;
  subtype?: string;
  floor: number;
  unitNumber?: number;
  sqm: number;
  priceUsd: number;
  view?: string;
  corner?: boolean;
  baths?: number;
  note?: string;
}
interface CatalogBuilding {
  id: string;
  name: string;
  tagline?: string;
  developer?: string;
  area?: string;
  address?: string;
  type?: string;
  stories?: number;
  units?: number;
  reservationFeeUsd?: number;
  maintenancePerSqmUsd?: number;
  bookingDepositUsd?: number;
  sinkingFundPerSqmUsd?: number;
  transferFeePct?: string;
  constructionEnd?: string;
  completion?: string;
  amenities?: string[];
  unitTypes?: UnitType[];
  terms?: Record<string, unknown>;
  inventory?: CatalogUnit[];
}

const slug = (s: string) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

/** Map one catalog building (+ its inventory + terms) into a complete, valid MM Pack. */
export function catalogBuildingToPack(cb: CatalogBuilding): Pack {
  const developerName = cb.developer || "Developer";
  const developerId = slug(developerName);
  const companyId = `${slug(developerName)}-co`;
  const complexId = `${cb.id}-cx`;
  const termsId = `${cb.id}-terms`;

  const units: Unit[] = (cb.inventory || []).map((u) => ({
    id: u.id,
    type: u.type,
    subtype: u.subtype,
    floor: u.floor,
    unitNumber: u.unitNumber,
    sqm: u.sqm,
    priceUsd: u.priceUsd,
    view: u.view,
    corner: u.corner,
    baths: u.baths,
    note: u.note,
    termsRef: termsId,
  }));

  const building: Building = {
    id: cb.id,
    name: cb.name,
    complexId,
    companyId,
    tagline: cb.tagline,
    developer: developerName,
    area: cb.area,
    address: cb.address,
    type: cb.type || "High Rise",
    stories: cb.stories && cb.stories >= 1 ? cb.stories : 1,
    units: cb.units ?? units.length,
    completion: cb.completion,
    constructionEnd: cb.constructionEnd,
    reservationFeeUsd: cb.reservationFeeUsd,
    bookingDepositUsd: cb.bookingDepositUsd,
    maintenancePerSqmUsd: cb.maintenancePerSqmUsd,
    sinkingFundPerSqmUsd: cb.sinkingFundPerSqmUsd,
    transferFeePct: cb.transferFeePct,
    amenities: cb.amenities,
    unitTypes: cb.unitTypes,
    termsRef: termsId,
  };

  const terms: PaymentTerms[] = cb.terms ? [{ id: termsId, data: cb.terms }] : [];

  return {
    domain: "realestate",
    developer: { id: developerId, name: developerName },
    companies: [{ id: companyId, name: `${developerName} Co., Ltd` }],
    complexes: [
      {
        id: complexId,
        name: cb.area || cb.name,
        companyId,
        area: cb.area,
        amenities: cb.amenities,
        buildings: [cb.id],
      },
    ],
    buildings: [building],
    buildingUnits: { [cb.id]: units },
    terms,
    texts: cb.tagline ? { "building.tagline": cb.tagline } : {},
    geo: [],
    overrides: [],
    media: [], // marketing images loaded separately (renderings-manifest, public/renderings) — see Preview
  };
}

/** The bundled demo building (Miracle Tower) as an MM Pack. The "Load Miracle Tower" entry point. */
export function miracleTowerPack(): Pack {
  return catalogBuildingToPack(demoBuilding as unknown as CatalogBuilding);
}

/** The demo building's id (so callers can select it after loading). */
export const MIRACLE_TOWER_ID = (demoBuilding as unknown as CatalogBuilding).id;

// The Miracle Tower real image set (from portal/lib/renderings-manifest.json), copied into MM's own
// public/renderings/miracle-tower/ so the demo is self-contained (MM is a separate Next app — its /public
// is not the portal's). Served as static /renderings/<id>/<bucket>/<file> URLs. These are REAL photography/
// renders (no AI-generated building images exist yet — finding; AI gen is the future media producer).
const MT = "/renderings/miracle-tower";
export const MIRACLE_TOWER_IMAGES: PreviewImages = {
  exterior: ["ext-1-hero.jpeg", "ext-2-approach.jpeg", "ext-3-amenity-deck.jpeg", "ext-4-night.jpeg"].map((f) => `${MT}/exterior/${f}`),
  interior: ["int-1-living.jpeg", "int-2-kitchen.jpeg", "int-3-bedroom.jpeg", "int-4-bathroom.jpeg", "int-5-balcony.jpeg"].map((f) => `${MT}/interior/${f}`),
  facilities: ["fac-1-pool.jpeg", "fac-2-fitness-sauna.jpeg", "fac-3-lobby.jpeg"].map((f) => `${MT}/facilities/${f}`),
  floorplans: [
    "flr-1-floor-plate.jpeg", "flr-2-site-plan.jpeg", "flr-3-unit-lineup.jpeg",
  ].map((f) => `${MT}/floorplans/${f}`),
};
