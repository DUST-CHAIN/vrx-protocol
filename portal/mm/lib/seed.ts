// A realistic starter pack — mirrors ../ingest-pack/examples/minimal so the Structured face opens with
// something to see/edit (law #1: guided). Users can "Start empty" instead (emptyPack). Not exported itself.

import type { Pack } from "./pack";

export function seedPack(): Pack {
  return {
    domain: "realestate",
    developer: {
      id: "acme-developments",
      name: "Acme Developments",
      holdingCompany: "Acme Holdings Ltd",
      nearAccount: "acme-dev-01.testnet",
    },
    companies: [
      { id: "acme-riverside-co", name: "Acme Riverside Co., Ltd", registration: "TH-0105500000001" },
    ],
    complexes: [
      {
        id: "riverside",
        name: "Riverside",
        companyId: "acme-riverside-co",
        area: "Riverside District",
        amenities: ["Shared pool", "Riverfront promenade", "24h security"],
        buildings: ["riverside-north"],
      },
    ],
    buildings: [
      {
        id: "riverside-north",
        name: "Riverside North",
        complexId: "riverside",
        companyId: "acme-riverside-co",
        tagline: "Wake up to the river",
        developer: "Acme Developments",
        area: "Riverside District",
        address: "1 Riverside Road",
        type: "High Rise",
        stories: 20,
        units: 2,
        completion: "Off-plan — completes 2028",
        constructionEnd: "2028-06-30",
        reservationFeeUsd: 1500,
        bookingDepositUsd: 1500,
        maintenancePerSqmUsd: 1.2,
        sinkingFundPerSqmUsd: 15,
        transferFeePct: "6.30%",
        amenities: ["Sky lounge", "Fitness"],
        unitTypes: [
          { key: "studio", label: "Studio", sqmMin: 28, sqmMax: 32 },
          { key: "1br", label: "1 Bedroom", sqmMin: 42, sqmMax: 48 },
        ],
        termsRef: "standard-2y",
        quota: {
          sellableSqm: 1200,
          foreignQuotaPct: 49,
          foreignSoldSqm: 0,
          stage: "presale",
          labels: { freehold: "Foreign Freehold", company: "Thai Company", private: "Thai Private" },
        },
      },
    ],
    buildingUnits: {
      "riverside-north": [
        { id: "unit-0801", type: "studio", subtype: "A", floor: 8, unitNumber: 801, sqm: 30, priceUsd: 95000, view: "River", corner: false, baths: 1 },
        { id: "unit-0802", type: "1br", subtype: "B", floor: 8, unitNumber: 802, sqm: 45, priceUsd: 142000, view: "City", corner: true, baths: 1 },
      ],
    },
    terms: [
      { id: "standard-2y", data: { bookingFeeUsd: 1500, depositPct: 20, balancePct: 80, schedule: "On transfer 2028" } },
    ],
    texts: {
      "complex.overview": "Riverside is a riverfront residential complex combining promenade living with city access.",
    },
    geo: [],
    overrides: [],
  };
}
