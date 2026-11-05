"use client";

// CurrencyProvider + CurrencyPicker — wraps the app so any screen can show prices in the user's
// chosen currency at a static, user-editable rate. Selection + rate persist in localStorage. Pure
// display; never touches the chain or the USD-base catalog (see lib/currency.ts for the rationale).

import { useEffect, useState, ReactNode } from "react";
import {
  CurrencyContext,
  CurrencyState,
  DEFAULT_CURRENCY,
  CURRENCIES,
  currencyByCode,
  useCurrency,
} from "./currency";

const LS_KEY = "vrx.currency";

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [state, setStateRaw] = useState<CurrencyState>(DEFAULT_CURRENCY);

  // Restore persisted choice on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CurrencyState;
        if (parsed?.code && typeof parsed.perUsd === "number") setStateRaw(parsed);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const setState = (s: CurrencyState) => {
    setStateRaw(s);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };

  return (
    <CurrencyContext.Provider value={{ state, setState }}>{children}</CurrencyContext.Provider>
  );
}

/**
 * Compact currency selector: pick a currency, then optionally edit the static rate. Drop it in any
 * header/toolbar. When the currency changes, the rate resets to that currency's default (the user can
 * then fine-tune). USD hides the rate field (it's always 1).
 */
export function CurrencyPicker({ compact = false }: { compact?: boolean }) {
  const { state, setState } = useCurrency();
  const def = currencyByCode(state.code);

  const onPick = (code: string) => {
    const c = currencyByCode(code);
    setState({ code, perUsd: c.defaultPerUsd });
  };

  const fieldStyle = {
    background: "rgba(255,255,255,0.06)",
    color: "inherit",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 6,
    padding: compact ? "2px 6px" : "3px 8px",
    fontSize: compact ? 12 : 13,
  } as const;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: compact ? 12 : 13, minWidth: 0 }}>
      {!compact && <label style={{ opacity: 0.7 }}>Show prices in</label>}
      <select
        value={state.code}
        onChange={(e) => onPick(e.target.value)}
        style={{ ...fieldStyle, cursor: "pointer", maxWidth: compact ? 130 : undefined }}
        title="Show prices in"
      >
        {CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {compact ? `${c.symbol} ${c.code}` : `${c.symbol} ${c.code} — ${c.label}`}
          </option>
        ))}
      </select>
      {state.code !== "USD" && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, opacity: 0.85 }}>
          <span style={{ opacity: 0.7 }}>$1=</span>
          <input
            type="number"
            step="any"
            value={state.perUsd}
            onChange={(e) => setState({ ...state, perUsd: Number(e.target.value) || 0 })}
            style={{ ...fieldStyle, width: compact ? 64 : 90 }}
            title={`1 USD = ? ${def.code}`}
          />
          {!compact && <span>{def.code}</span>}
        </span>
      )}
    </div>
  );
}
