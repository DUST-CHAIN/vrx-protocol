"use client";

// AI keys store — the user's own DeepSeek (text) + Gemini (images) API keys, kept LOCALLY
// localStorage on this device and sent TRANSIENTLY per request (never persisted server-side, never logged). This
// is the single source of truth the Settings panel edits and the AI features read. Same lightweight pattern as
// useChrome. Keys are optional: without them the AI features explain how to add one (the rest of MM works offline).

import { useCallback, useEffect, useState } from "react";

export interface AiKeys {
  deepseek: string; // text stage (building-from-a-brief)
  gemini: string;   // image stage (✨ generate)
}

const LS = { deepseek: "mm.key.deepseek", gemini: "mm.key.gemini" };

export interface KeysApi extends AiKeys {
  hydrated: boolean;
  setDeepseek: (v: string) => void;
  setGemini: (v: string) => void;
}

export function useKeys(): KeysApi {
  const [deepseek, setDeepseekState] = useState("");
  const [gemini, setGeminiState] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setDeepseekState(localStorage.getItem(LS.deepseek) || "");
      setGeminiState(localStorage.getItem(LS.gemini) || "");
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  const setDeepseek = useCallback((v: string) => {
    setDeepseekState(v);
    try { v ? localStorage.setItem(LS.deepseek, v) : localStorage.removeItem(LS.deepseek); } catch { /* ignore */ }
  }, []);
  const setGemini = useCallback((v: string) => {
    setGeminiState(v);
    try { v ? localStorage.setItem(LS.gemini, v) : localStorage.removeItem(LS.gemini); } catch { /* ignore */ }
  }, []);

  return { deepseek, gemini, hydrated, setDeepseek, setGemini };
}

/** Read the keys once, outside React (used by non-hook callers like the generate flow). */
export function readKeys(): AiKeys {
  try {
    return {
      deepseek: localStorage.getItem(LS.deepseek) || "",
      gemini: localStorage.getItem(LS.gemini) || "",
    };
  } catch {
    return { deepseek: "", gemini: "" };
  }
}
