"use client";

// User preferences — small, localStorage-backed settings that live behind the gear menu.
// Kept separate from currency (which has its own provider) but surfaced in the same settings panel.
// staleMinutes: how old a building's status snapshot may be before a floor is shown greyed with a

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

export type Prefs = {
  /** Snapshot age (minutes) under which floors are shown instantly; older floors need a tap. */
  staleMinutes: number;
};

export const DEFAULT_PREFS: Prefs = { staleMinutes: 60 };

const LS_KEY = "vrx.prefs";

const PrefsContext = createContext<{ prefs: Prefs; setPrefs: (p: Prefs) => void }>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {},
});

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Prefs>;
        setPrefsState({ ...DEFAULT_PREFS, ...parsed });
      }
    } catch {
      /* ignore */
    }
  }, []);

  const setPrefs = (p: Prefs) => {
    setPrefsState(p);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  };

  return <PrefsContext.Provider value={{ prefs, setPrefs }}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  return useContext(PrefsContext);
}
