// NODE LICENSES — the real BTC asset layer that FUNDS & runs VRX.
//
// WHAT THIS IS (and is NOT): the `VETTEDREALTY.VRX-XX-NN` subassets are NODE-OPERATOR LICENSES issued on
// Bitcoin via Counterparty (XCP). Buying one funds the VRX protocol and lets the holder run a node in a key
// location (operator passive income + dev funding; the same boxes double as dev-side private nodes). They are
// sold on the OPEN Counterparty market via dispensers — NOT inside VRX. VRX receives the BTC directly via our
// own wallet; this surface is PURELY a FUNNEL: awareness + a deep-link out to tokenscan.io. VRX custodies
// nothing here and does not process the purchase.
//
// HONESTY (project HARD rule): these are REAL Bitcoin-denominated assets — utterly DISTINCT from $VRX, which is
// off-chain PLAY credit. Copy must never conflate the two, never imply VRX holds/escrows the BTC, and must make
// clear the buy happens on Counterparty/tokenscan, not here. Contact for the equity parent is
// vrx@vettedrealty.com — NEVER the forbidden Gmail.
//
// DATA: a vendored SNAPSHOT (fetched from tokenscan.io 2026-11-03, cached C:\tmp\vrx_dispensers.json). We ship a
// snapshot rather than fetch at runtime so the funnel is zero-dependency and can't break on a third-party
// outage; the UI always links to tokenscan for the LIVE price/availability (the snapshot can go stale). A later
// arc can add a cached live fetch (tokenscan.io/api/dispensers/<asset>) behind the same shape.

/** The parent equity asset — shares in the real company (bought via vrx@vettedrealty.com, off-platform). */
export const PARENT_ASSET = "VETTEDREALTY";
export const TOKENSCAN_BASE = "https://tokenscan.io/asset/";

/** A node-operator license offered on the open Counterparty market. */
export type NodeLicense = {
  /** The Counterparty asset longname, e.g. "VETTEDREALTY.VRX-TH-02". */
  asset: string;
  /** Short license code (the subasset after the dot), e.g. "VRX-TH-02". */
  code: string;
  /** Region grouping derived from the code (CE/CN/RU/TH …) — a human label for the location family. */
  region: string;
  /** Dispenser price in BTC (string to preserve exactness; display-formatted by the UI). */
  priceBtc: string;
  /** Whether the dispenser is currently OPEN (snapshot — the UI points to tokenscan for live truth). */
  open: boolean;
  /** Remaining supply as reported by the dispenser, e.g. "1/1". */
  remaining: string;
  /** The Bitcoin dispenser address that vends this asset. */
  dispenser: string;
  /** Deep-link to the asset on tokenscan (the live market view + how to buy). */
  url: string;
  /** Real human node name, e.g. "Thailand · Bangkok" (from the on-chain asset metadata). */
  name: string;
  /** The node's city, e.g. "Bangkok". */
  city: string;
  /** Map coordinates (the node's city). */
  lat: number;
  lng: number;
  /** The minted-on-BTC node CARD image (pulled live from the remote; zoomable in the UI). */
  image: string;
};

/** Human label for a region code — the real node regions (from the on-chain asset metadata at
 *  vettedrealty.com/assets/<code>.json). Unknown codes fall back to the raw code (honest, never a guess). */
const REGION_LABELS: Record<string, string> = {
  CE: "Central Europe",
  CN: "China",
  RU: "Russia",
  TH: "Thailand",
};

export function regionLabel(code: string): string {
  const key = regionCode(code);
  return REGION_LABELS[key] ?? key ?? code;
}

/** Per-node location + card art, from the REAL on-chain asset metadata (vettedrealty.com/assets/<code>.json:
 *  name/custom_category/image_large — fetched & verified 2026-11-03). Vendored as a snapshot (see SNAPSHOT
 *  note) so the map/card are zero-dependency. ⚠ ONE table — correct a city/coord here. The image is pulled
 *  LIVE from the remote (the nice minted-on-BTC node card). */
export type NodeMeta = { name: string; city: string; lat: number; lng: number; image: string };
const CARD = (code: string) => `https://vettedrealty.com/assets/node_cards/${code}.png`;
export const NODE_META: Record<string, NodeMeta> = {
  "VRX-CE-01": { name: "Central Europe · Munich", city: "Munich", lat: 48.1351, lng: 11.582, image: CARD("VRX-CE-01") },
  "VRX-CE-02": { name: "Central Europe · London", city: "London", lat: 51.5074, lng: -0.1278, image: CARD("VRX-CE-02") },
  "VRX-CE-03": { name: "Central Europe · Paris", city: "Paris", lat: 48.8566, lng: 2.3522, image: CARD("VRX-CE-03") },
  "VRX-CN-01": { name: "China · Shanghai", city: "Shanghai", lat: 31.2304, lng: 121.4737, image: CARD("VRX-CN-01") },
  "VRX-RU-01": { name: "Russia · Moscow", city: "Moscow", lat: 55.7558, lng: 37.6173, image: CARD("VRX-RU-01") },
  "VRX-RU-02": { name: "Russia · Saint Petersburg", city: "Saint Petersburg", lat: 59.9311, lng: 30.3609, image: CARD("VRX-RU-02") },
  "VRX-TH-01": { name: "Thailand · Pattaya", city: "Pattaya", lat: 12.9236, lng: 100.8825, image: CARD("VRX-TH-01") },
  "VRX-TH-02": { name: "Thailand · Bangkok", city: "Bangkok", lat: 13.7563, lng: 100.5018, image: CARD("VRX-TH-02") },
  "VRX-TH-03": { name: "Thailand · Phuket", city: "Phuket", lat: 7.8804, lng: 98.3923, image: CARD("VRX-TH-03") },
  "VRX-TH-04": { name: "Thailand · Koh Samui", city: "Koh Samui", lat: 9.512, lng: 100.0136, image: CARD("VRX-TH-04") },
  "VRX-TH-05": { name: "Thailand · Chiang Mai", city: "Chiang Mai", lat: 18.7883, lng: 98.9853, image: CARD("VRX-TH-05") },
};

// The vendored snapshot. As of 2026-11-03 all 11 dispensers are OPEN (tokenscan.io/asset/VETTEDREALTY).
type Raw = { Asset: string; ForSale: string; PriceBTC: string; Remaining: string; Source: string };
const SNAPSHOT: Raw[] = [
  { Asset: "VETTEDREALTY.VRX-CE-01", ForSale: "OPEN", PriceBTC: "1.40000000", Remaining: "1/1", Source: "16AJiCYsquW79RFTdxrBZPvy8J3ZVwALry" },
  { Asset: "VETTEDREALTY.VRX-CE-02", ForSale: "OPEN", PriceBTC: "1.30000000", Remaining: "1/1", Source: "1am7vgPHHutQqdzQnJmHFqSFFWL5X6Q76" },
  { Asset: "VETTEDREALTY.VRX-CE-03", ForSale: "OPEN", PriceBTC: "1.20000000", Remaining: "1/1", Source: "12QAFau43hJasWbtUN67NRnrLBCEQKS2G7" },
  { Asset: "VETTEDREALTY.VRX-CN-01", ForSale: "OPEN", PriceBTC: "2.00000000", Remaining: "1/1", Source: "1GjD8z7yaeWXwvtoGGhrXzmvRP7usDKx4V" },
  { Asset: "VETTEDREALTY.VRX-RU-01", ForSale: "OPEN", PriceBTC: "1.40000000", Remaining: "1/1", Source: "1KNtA7foKfoWvmrzFvgBhUtXaupoWNf8Jf" },
  { Asset: "VETTEDREALTY.VRX-RU-02", ForSale: "OPEN", PriceBTC: "1.50000000", Remaining: "1/1", Source: "1BQZh7ubHMdJp2qUpfSqUSAKCCwsYhQACQ" },
  { Asset: "VETTEDREALTY.VRX-TH-01", ForSale: "OPEN", PriceBTC: "2.00000000", Remaining: "1/1", Source: "1NHddd5gma97AkjgUpKMh9fRkNVF2Sx8qs" },
  { Asset: "VETTEDREALTY.VRX-TH-02", ForSale: "OPEN", PriceBTC: "4.00000000", Remaining: "1/1", Source: "1CrFb5CQBqZyjnXh84dHaxAxSagzLJANjx" },
  { Asset: "VETTEDREALTY.VRX-TH-03", ForSale: "OPEN", PriceBTC: "2.00000000", Remaining: "1/1", Source: "1FCCLAUtkvGaBHBoqRdQE8NwrNmphhjuSw" },
  { Asset: "VETTEDREALTY.VRX-TH-04", ForSale: "OPEN", PriceBTC: "1.60000000", Remaining: "1/1", Source: "1HL15hpnNpHueqzScsq8179rSbcdV9vEsH" },
  { Asset: "VETTEDREALTY.VRX-TH-05", ForSale: "OPEN", PriceBTC: "1.40000000", Remaining: "1/1", Source: "1NAbMAYaexP3fDXK4roSxDFqYVxv8TFe1c" },
];

/** As-of date of the vendored snapshot (shown in the UI so a stale price is never passed off as live). */
export const SNAPSHOT_AS_OF = "2026-11-03";

/** The 2-letter region code inside a license code, e.g. "VRX-TH-02" → "TH". "" if it doesn't match. */
function regionCode(code: string): string {
  return /^VRX-([A-Z]+)-\d+$/.exec(code)?.[1] ?? "";
}

function toLicense(r: Raw): NodeLicense {
  const code = r.Asset.includes(".") ? r.Asset.split(".")[1] : r.Asset;
  const meta = NODE_META[code] ?? { name: code, city: code, lat: 13.7563, lng: 100.5018, image: CARD(code) };
  return {
    asset: r.Asset,
    code,
    region: regionLabel(code),
    priceBtc: r.PriceBTC,
    open: r.ForSale.toUpperCase() === "OPEN",
    remaining: r.Remaining,
    dispenser: r.Source,
    url: TOKENSCAN_BASE + r.Asset,
    name: meta.name,
    city: meta.city,
    lat: meta.lat,
    lng: meta.lng,
    image: meta.image,
  };
}

/** All node licenses from the snapshot, cheapest first (an approachable entry price leads). */
export function nodeLicenses(): NodeLicense[] {
  return SNAPSHOT.map(toLicense).sort((a, b) => Number(a.priceBtc) - Number(b.priceBtc));
}

/** Format a BTC price for display: trim trailing zeros, always keep it unmistakably BTC. "1.40000000" → "1.4". */
export function formatBtc(priceBtc: string): string {
  const n = Number(priceBtc);
  if (!Number.isFinite(n)) return priceBtc;
  return `${Number(n.toFixed(8))}`; // drop trailing zeros without losing precision
}

/** The cheapest open license price (for the nudge's "from X BTC" teaser). Null if none are open. */
export function fromPriceBtc(): string | null {
  const open = nodeLicenses().filter((l) => l.open);
  if (open.length === 0) return null;
  return formatBtc(open[0].priceBtc);
}

// ── The ecosystem map: agencies (and eventually everyone) ────────────────────────────────────────────────
// the map shows nodes + the mesh between them, and EVENTUALLY all nodes AND agencies. These are
// INDICATIVE ecosystem markers (the real vetting regions the platform already uses — Pattaya/Bangkok/Phuket/
// Singapore/Dubai/London), illustrating reach, not a live registry. A later arc can replace this with the real
// provisioned-agency list (lib/seed-funnel VET_REGIONS / the on-chain org registry).
export type EcosystemAgency = { name: string; city: string; lat: number; lng: number };
// Agencies sit in the DRAWN node countries (so none float in the ocean — the choropleth only draws the 6 node
// countries). Illustrative ecosystem reach; a later arc swaps in the real provisioned-agency registry.
export function ecosystemAgencies(): EcosystemAgency[] {
  return [
    { name: "Vetted Realty — Bangkok", city: "Bangkok, Thailand", lat: 13.7563, lng: 100.5018 },
    { name: "Vetted Realty — Pattaya", city: "Pattaya, Thailand", lat: 12.9236, lng: 100.8825 },
    { name: "Vetted Realty — Phuket", city: "Phuket, Thailand", lat: 7.8804, lng: 98.3923 },
    { name: "Partner agency — London", city: "London, UK", lat: 51.5074, lng: -0.1278 },
    { name: "Partner agency — Frankfurt", city: "Frankfurt, Germany", lat: 50.1109, lng: 8.6821 },
    { name: "Partner agency — Lyon", city: "Lyon, France", lat: 45.764, lng: 4.8357 },
    { name: "Partner agency — Shenzhen", city: "Shenzhen, China", lat: 22.5431, lng: 114.0579 },
    { name: "Partner agency — Sochi", city: "Sochi, Russia", lat: 43.5855, lng: 39.7231 },
  ];
}

// ── Countries where VRX has nodes (the choropleth layer: name + borders + GDP) ──────────────────────────────
// the map shows the node COUNTRIES with their name, borders, and GDP. ISO-3 code = the join key to a
// world-borders GeoJSON (the map draws each country's polygon from it). GDP = nominal USD, approx (source:
// IMF/World Bank 2024, trillions), shown as context for the market each node serves. ⚠ ONE table to correct.
export type NodeCountry = { iso3: string; name: string; gdpUsdTrillions: number };
export function nodeCountries(): NodeCountry[] {
  // Derived from the node regions: Central Europe (DE/GB/FR), China, Russia, Thailand. One entry per country.
  return [
    { iso3: "DEU", name: "Germany", gdpUsdTrillions: 4.59 },
    { iso3: "GBR", name: "United Kingdom", gdpUsdTrillions: 3.59 },
    { iso3: "FRA", name: "France", gdpUsdTrillions: 3.17 },
    { iso3: "CHN", name: "China", gdpUsdTrillions: 18.56 },
    { iso3: "RUS", name: "Russia", gdpUsdTrillions: 2.18 },
    { iso3: "THA", name: "Thailand", gdpUsdTrillions: 0.55 },
  ];
}
