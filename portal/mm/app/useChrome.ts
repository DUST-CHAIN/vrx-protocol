"use client";

// App chrome prefs: light/dark MODE + ACCENT colour + left-pane WIDTH, all persisted to
// localStorage and restored on load ("last color remembered"). Mode drives data-mode on <body>; accent is
// an inline --accent var; width is an inline --frame-w var on the shell.

import { useCallback, useEffect, useState } from "react";

export type Mode = "light" | "dark";
export type Face = "structured" | "studio" | "preview";

export const ACCENTS: Array<{ key: string; label: string; value: string }> = [
  { key: "teal", label: "Teal", value: "#0d9488" },
  { key: "indigo", label: "Indigo", value: "#4f46e5" },
  { key: "blue", label: "Blue", value: "#2563eb" },
  { key: "violet", label: "Violet", value: "#7c3aed" },
  { key: "rose", label: "Rose", value: "#e11d48" },
  { key: "amber", label: "Amber", value: "#d97706" },
  { key: "emerald", label: "Emerald", value: "#059669" },
];

const LS = { mode: "mm.mode", accent: "mm.accent", width: "mm.frameW", face: "mm.face" };
const MIN_W = 220;
const MAX_W = 520;

function clampW(n: number): number {
  return Math.max(MIN_W, Math.min(MAX_W, n));
}

export interface ChromeApi {
  mode: Mode;
  setMode: (m: Mode) => void;
  toggleMode: () => void;
  accent: string; // hex
  setAccent: (hex: string) => void;
  frameW: number;
  setFrameW: (px: number) => void;
  face: Face;
  setFace: (f: Face) => void;
}

export function useChrome(): ChromeApi {
  const [mode, setModeState] = useState<Mode>("light");
  const [accent, setAccentState] = useState<string>(ACCENTS[0].value);
  const [frameW, setFrameWState] = useState<number>(300);
  const [face, setFaceState] = useState<Face>("structured");

  // restore on mount (client only)
  useEffect(() => {
    try {
      const m = localStorage.getItem(LS.mode) as Mode | null;
      const a = localStorage.getItem(LS.accent);
      const w = localStorage.getItem(LS.width);
      const f = localStorage.getItem(LS.face) as Face | null;
      if (m === "light" || m === "dark") setModeState(m);
      if (a) setAccentState(a);
      if (w) setFrameWState(clampW(Number(w)));
      if (f === "structured" || f === "studio" || f === "preview") setFaceState(f);
    } catch {
      /* ignore */
    }
  }, []);

  // apply mode + accent to <body>; width to the shell via a CSS var on <body> (shell inherits).
  useEffect(() => {
    document.body.setAttribute("data-mode", mode);
    document.body.style.setProperty("--accent", accent);
    document.body.style.setProperty("--frame-w", `${frameW}px`);
  }, [mode, accent, frameW]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try { localStorage.setItem(LS.mode, m); } catch {}
  }, []);
  const toggleMode = useCallback(() => {
    setModeState((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try { localStorage.setItem(LS.mode, next); } catch {}
      return next;
    });
  }, []);
  const setAccent = useCallback((hex: string) => {
    setAccentState(hex);
    try { localStorage.setItem(LS.accent, hex); } catch {}
  }, []);
  const setFrameW = useCallback((px: number) => {
    const c = clampW(px);
    setFrameWState(c);
    try { localStorage.setItem(LS.width, String(c)); } catch {}
  }, []);
  const setFace = useCallback((f: Face) => {
    setFaceState(f);
    try { localStorage.setItem(LS.face, f); } catch {}
  }, []);

  return { mode, setMode, toggleMode, accent, setAccent, frameW, setFrameW, face, setFace };
}
