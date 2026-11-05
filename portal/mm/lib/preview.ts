// Preview adapter — map an MM Pack into the shape the REAL VRX view components expect, so the
// Preview face renders a building EXACTLY as developers/agents see it in the VRX app. This is the
// acceptance test: if the authored pack renders right here, it's right in production.
//
// The ported components (components/StackingPlan, components/UnitDetail) read a MINIMAL local Unit/Building
// type (PreviewUnit/PreviewBuilding) — a subset of portal/lib/catalog-client that MM can satisfy. We
// deliberately do NOT import the portal's catalog-client (MM is a separate app); the ports were adjusted to
// this local type. Keep this type a faithful SUBSET so a ported component never needs a field MM can't give.
//
// DEV-VIEW FIRST: the developer sees their OWN building — all units, full specs, stacking plan,
// images, terms. The agent view is a scoped subset of the same data (a later refinement).

import type { Pack, Unit as PackUnit } from "./pack";

/** The unit shape the ported StackingPlan/UnitDetail read (subset of portal catalog-client Unit). */
export interface PreviewUnit {
  id: string;
  type: string;
  floor: number;
  sqm: number;
  priceUsd: number;
  unitNumber?: number;
  subtype?: string;
  view?: string;
  corner?: boolean;
  baths?: number;
  note?: string;
  /** live on-chain status baked by the server in VRX; in Preview we stub 0 = available. */
  status?: number;
  /** developer off-market flag (VRX); absent in Preview. */
  offMarket?: { state: "blocked" | "killed" } | undefined;
}

/** The building shape the ported components read (subset of portal catalog-client Building). */
export interface PreviewBuilding {
  id: string;
  name: string;
  tagline: string;
  developer: string;
  area: string;
  address: string;
  type: string;
  stories: number;
  units: number;
  reservationFeeUsd: number;
  maintenancePerSqmUsd: number;
  amenities: string[];
  completion: string;
  unitTypes: Array<{ key: string; label: string; sqmMin: number; sqmMax: number }>;
  inventory: PreviewUnit[];
  bookingDepositUsd?: number;
  sinkingFundPerSqmUsd?: number;
  transferFeePct?: string;
  constructionEnd?: string;
  /** flat terms block (the developer's published plan), shown read-only in the detail. */
  terms?: Record<string, unknown>;
}

/** Building-level image buckets (subset of portal BuildingImages) — resolved URLs, dev view. */
export interface PreviewImages {
  exterior: string[];
  interior: string[];
  facilities: string[];
  floorplans: string[];
}

export interface PreviewModel {
  building: PreviewBuilding;
  units: PreviewUnit[];
  images: PreviewImages;
}

function packUnitToPreview(u: PackUnit): PreviewUnit {
  return {
    id: u.id,
    type: u.type,
    floor: u.floor,
    sqm: u.sqm,
    priceUsd: u.priceUsd,
    unitNumber: u.unitNumber,
    subtype: u.subtype,
    view: u.view,
    corner: u.corner,
    baths: u.baths,
    note: u.note,
    status: 0, // Preview: every unit shows "available" (no live chain). offMarket omitted.
  };
}

/**
 * Adapt a Pack's building into the Preview model. `images` is supplied by the caller (resolved URLs from
 * the renderings manifest or pack.media[]) — the adapter itself is pure and image-source-agnostic.
 * Returns null if the building id isn't in the pack.
 */
export function packToPreview(pack: Pack, buildingId: string, images: PreviewImages): PreviewModel | null {
  const b = pack.buildings.find((x) => x.id === buildingId);
  if (!b) return null;
  const units = (pack.buildingUnits[buildingId] || []).map(packUnitToPreview);
  const termsBlock = pack.terms.find((t) => t.id === b.termsRef)?.data;

  const building: PreviewBuilding = {
    id: b.id,
    name: b.name || b.id,
    tagline: b.tagline || "",
    developer: b.developer || pack.developer.name,
    area: b.area || "",
    address: b.address || "",
    type: b.type || "High Rise",
    stories: b.stories || 1,
    units: b.units ?? units.length,
    reservationFeeUsd: b.reservationFeeUsd || 0,
    maintenancePerSqmUsd: b.maintenancePerSqmUsd || 0,
    amenities: b.amenities || [],
    completion: b.completion || "",
    unitTypes: (b.unitTypes || []).map((t) => ({ key: t.key, label: t.label, sqmMin: t.sqmMin, sqmMax: t.sqmMax })),
    inventory: units,
    bookingDepositUsd: b.bookingDepositUsd,
    sinkingFundPerSqmUsd: b.sinkingFundPerSqmUsd,
    transferFeePct: b.transferFeePct,
    constructionEnd: b.constructionEnd,
    terms: termsBlock,
  };

  return { building, units, images };
}

const EMPTY_IMAGES: PreviewImages = { exterior: [], interior: [], facilities: [], floorplans: [] };

/** A convenience default when no images are supplied (placeholders handled by the UI). */
export function emptyImages(): PreviewImages {
  return { ...EMPTY_IMAGES };
}
