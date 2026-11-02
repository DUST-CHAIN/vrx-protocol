"use client";

// display currency and a STATIC rate, and the whole UI converts on the fly. Fiat or crypto (someone may
// hold ETH). The rate is a plain "1 USD = X <currency>" number the user can edit — no live feed (this is
// a demo, and a static rate keeps prices stable + auditable during a walkthrough). Selection + rate
// persist in localStorage so a role switch / reload keeps the chosen currency.
// This is a pure DISPLAY layer: it never changes the on-chain deposit (that settles in NEAR/stablecoin,
//) nor the stored USD base. It just answers "what does this cost in the currency I think in?".

import { createContext, useContext } from "react";
import { NEAR_PER_USD } from "./near-rate";

export type CurrencyDef = {
  code: string; // ISO-ish code / ticker, e.g. "USD", "THB", "ETH"
  label: string; // human label
  symbol: string; // display symbol / prefix
  /** Default static rate: how many units of THIS currency equal 1 USD. */
  defaultPerUsd: number;
  /** Decimal places to show (crypto wants more precision). */
  decimals: number;
  /** true = crypto (formatted differently: symbol suffix, more decimals). */
  crypto?: boolean;
};

// Default catalogue of currencies + a plausible static demo rate (1 USD = perUsd of this currency).
// Rates are editable at runtime — these are just sensible starting points.
export const CURRENCIES: CurrencyDef[] = [
  { code: "USD", label: "US Dollar", symbol: "$", defaultPerUsd: 1, decimals: 0 },
  { code: "THB", label: "Thai Baht", symbol: "฿", defaultPerUsd: 35, decimals: 0 },
  { code: "EUR", label: "Euro", symbol: "€", defaultPerUsd: 0.92, decimals: 0 },
  { code: "GBP", label: "British Pound", symbol: "£", defaultPerUsd: 0.79, decimals: 0 },
  { code: "AED", label: "UAE Dirham", symbol: "AED ", defaultPerUsd: 3.67, decimals: 0 },
  { code: "SGD", label: "Singapore Dollar", symbol: "S$", defaultPerUsd: 1.35, decimals: 0 },
  { code: "ETH", label: "Ethereum", symbol: "Ξ", defaultPerUsd: 0.0004, decimals: 3, crypto: true },
  { code: "BTC", label: "Bitcoin", symbol: "₿", defaultPerUsd: 0.0000152, decimals: 5, crypto: true },
  // NEAR rate comes from the shared single-source lib/near-rate (audit) so the display layer and the
  // server-side offer bar (lib/offer-eligibility USD_PER_NEAR) can never disagree on the NEAR price.
  { code: "NEAR", label: "NEAR", symbol: "Ⓝ", defaultPerUsd: NEAR_PER_USD, decimals: 1, crypto: true },
];

export function currencyByCode(code: string): CurrencyDef {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

export type CurrencyState = {
  code: string; // selected currency code
  perUsd: number; // static rate: units of `code` per 1 USD
};

export const DEFAULT_CURRENCY: CurrencyState = { code: "USD", perUsd: 1 };

/** Convert a USD-base amount into the selected currency at the chosen static rate. */
export function convert(usd: number, state: CurrencyState): number {
  return usd * (state.perUsd || 1);
}

/**
 * Format a USD-base amount for display in the selected currency. Fiat gets compact K/M suffixes for
 * large sums; crypto shows a fixed-decimal figure with the ticker symbol. Small amounts (fees) show in
 * full. This is the ONE formatter the UI should call — replaces the old thb.
 */
export function formatMoney(usd: number, state: CurrencyState): string {
  const def = currencyByCode(state.code);
  const v = convert(usd, state);
  if (def.crypto) {
    // e.g. "Ξ21.2" / "₿0.90" — fixed decimals, ticker prefix.
    return `${def.symbol}${v.toLocaleString(undefined, { maximumFractionDigits: def.decimals })}`;
  }
  // Fiat: compact for large values so a $8.25M unit reads cleanly.
  if (v >= 1_000_000) return `${def.symbol}${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 2)}M`;
  if (v >= 10_000) return `${def.symbol}${Math.round(v / 1000)}K`;
  return `${def.symbol}${Math.round(v).toLocaleString()}`;
}

/**
 * Format a USD-base amount in FULL (no K/M compaction) in the selected currency. Use this where an EXACT
 * figure matters and two nearby sums must stay distinguishable — e.g. a SETTLEMENT total, where compacting
 * $10,980 and $11,045 both to "$11K" would hide a real difference. `formatMoney` stays the default for
 * prices (a $8.25M unit reads cleaner compact); this is the opt-in for money-owed surfaces. Crypto keeps its
 * fixed-decimal form (already exact).
 */
export function formatMoneyFull(usd: number, state: CurrencyState): string {
  const def = currencyByCode(state.code);
  const v = convert(usd, state);
  if (def.crypto) {
    return `${def.symbol}${v.toLocaleString(undefined, { maximumFractionDigits: def.decimals })}`;
  }
  return `${def.symbol}${Math.round(v).toLocaleString()}`;
}

// ── React context so any component can read the chosen currency ──────────────────────────────────
export const CurrencyContext = createContext<{
  state: CurrencyState;
  setState: (s: CurrencyState) => void;
}>({ state: DEFAULT_CURRENCY, setState: () => {} });

export function useCurrency() {
  return useContext(CurrencyContext);
}

/** Convenience: read the current formatter bound to the active currency. */
export function useMoney(): (usd: number) => string {
  const { state } = useCurrency();
  return (usd: number) => formatMoney(usd, state);
}

/** Like useMoney, but EXACT (no K/M compaction) — for settlement/owed figures where the precise amount
 * matters and nearby sums must stay distinguishable. */
export function useMoneyFull(): (usd: number) => string {
  const { state } = useCurrency();
  return (usd: number) => formatMoneyFull(usd, state);
}
