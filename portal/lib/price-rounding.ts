// DISPLAY-PRICE ROUNDING. The STORED price is always EXACT — invoices, settlement and
// commission math read the authoritative `priceUsd` and fractions matter there. This is a pure DISPLAY-layer
// tidy: a developer may choose to show clean quotes ($424,360 → "$424,000") without ever touching storage.
// Order of operations in the UI (important): priceRounding operates on the STORED USD base FIRST (it's the
// developer's choice about THEIR quote), THEN currency conversion + formatMoney compaction happen on top
// (lib/currency.ts — a separate, per-viewer concern). So this never sees the viewer's currency; it only
// tidies the USD figure the card then formats.
// PRIVACY/NUMBERS: storage is truth, display is tidy — same snapshot-vs-live discipline as everywhere.
// Rounding NEVER mutates a stored price; a route that writes must pass the EXACT figure (catalog-edit-gate).

/** How a developer chooses to round the DISPLAYED USD price. `none` = show the exact stored figure. */
export type PriceRounding = "none" | "nearest_100" | "nearest_1000";

/** The code default when a building sets no preference — clean thousands read best on a listing card. */
export const DEFAULT_PRICE_ROUNDING: PriceRounding = "nearest_1000";

/** All valid modes (for a <select> / validation). */
export const PRICE_ROUNDING_MODES: PriceRounding[] = ["none", "nearest_100", "nearest_1000"];

/** Narrow an unknown (query/body/stored value) to a PriceRounding, falling back to the default. */
export function asPriceRounding(v: unknown): PriceRounding {
  return v === "none" || v === "nearest_100" || v === "nearest_1000" ? v : DEFAULT_PRICE_ROUNDING;
}

/**
 * Round a USD-base price for DISPLAY only. Rounds to the nearest step (half-up at.5 of the step) so a quote
 * reads clean; `none` returns the exact figure untouched. Never call this before writing a price — storage
 * stays exact. Non-finite input is returned as-is (the caller/formatter handles it).
 */
export function roundForDisplay(usd: number, mode: PriceRounding = DEFAULT_PRICE_ROUNDING): number {
  if (!Number.isFinite(usd)) return usd;
  if (mode === "none") return usd;
  const step = mode === "nearest_100" ? 100 : 1000;
  return Math.round(usd / step) * step;
}

/**
 * Resolve the HEADLINE display price for a unit under its building's rounding choice. Use ONLY for the
 * sticker/quote figure a listing or unit card shows — NEVER for derived math (price-per-m², payment-plan
 * schedules, projections, settlement, commission), which must read the EXACT stored price. Reads the
 * per-building `priceRounding` (absent = the code default). Pass the already-buyer-resolved USD price.
 */
export function displayPriceUsd(usd: number, priceRounding?: PriceRounding): number {
  return roundForDisplay(usd, priceRounding ?? DEFAULT_PRICE_ROUNDING);
}
