"use client";

// App chrome prefs: light/dark MODE + ACCENT colour + left-pane WIDTH, all persisted to
// localStorage and restored on load ("last color remembered"). Mode drives data-mode on <body>; accent is
// an inline --accent var; width is an inline --frame-w var on the shell.

import { useCallback, useEffect, useState } from "react";

export type Mode = "light" | "dark";
export type Face = "structured" | "studio" | "preview";

// VRX blue (the studio/board accent) leads the list and is the default — the unified identity colour.
export const ACCENTS: Array<{ key: string; label: string; value: string }> = [
  { key: "vrx", label: "VRX blue", value: "#3d7dff" },
  { key: "teal", label: "Teal", value: "#0d9488" },
  { key: "indigo", label: "Indigo", value: "#4f46e5" },
  { key: "blue", label: "Blue", value: "#2563eb" },
  { key: "violet", label: "Violet", value: "#7c3aed" },
  { key: "rose", label: "Rose", value: "#e11d48" },
  { key: "amber", label: "Amber", value: "#d97706" },
  { key: "emerald", label: "Emerald", value: "#059669" },
];

const LS = { mode: "mm.mode", accent: "mm.accent", width: "mm.frameW", railW: "mm.railW", face: "mm.face" };
const MIN_W = 220;
const MAX_W = 760; // left tree pane bounds
const RAIL_MIN_W = 280;
const RAIL_MAX_W = 720; //  (: the RIGHT inspector pane is too narrow often) — make it resizable

function clampW(n: number): number {
  return Math.max(MIN_W, Math.min(MAX_W, n));
}
function clampRailW(n: number): number {
  return Math.max(RAIL_MIN_W, Math.min(RAIL_MAX_W, n));
}

export interface ChromeApi {
  mode: Mode;
  setMode: (m: Mode) => void;
  toggleMode: () => void;
  accent: string; // hex
  setAccent: (hex: string) => void;
  frameW: number;
  setFrameW: (px: number) => void;
  railW: number;
  setRailW: (px: number) => void;
  face: Face;
  setFace: (f: Face) => void;
}

export function useChrome(): ChromeApi {
  const [mode, setModeState] = useState<Mode>("dark"); // dark is the unified default
  const [accent, setAccentState] = useState<string>(ACCENTS[0].value);
  const [frameW, setFrameWState] = useState<number>(300);
  const [railW, setRailWState] = useState<number>(320);
  const [face, setFaceState] = useState<Face>("structured");

  // restore on mount (client only)
  useEffect(() => {
    try {
      const m = localStorage.getItem(LS.mode) as Mode | null;
      const a = localStorage.getItem(LS.accent);
      const w = localStorage.getItem(LS.width);
      const rw = localStorage.getItem(LS.railW);
      const f = localStorage.getItem(LS.face) as Face | null;
      if (m === "light" || m === "dark") setModeState(m);
      if (a) setAccentState(a);
      if (w) setFrameWState(clampW(Number(w)));
      if (rw) setRailWState(clampRailW(Number(rw)));
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
    document.body.style.setProperty("--rail-w", `${railW}px`);
  }, [mode, accent, frameW, railW]);

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
  const setRailW = useCallback((px: number) => {
    const c = clampRailW(px);
    setRailWState(c);
    try { localStorage.setItem(LS.railW, String(c)); } catch {}
  }, []);
  const setFace = useCallback((f: Face) => {
    setFaceState(f);
    try { localStorage.setItem(LS.face, f); } catch {}
  }, []);

  return { mode, setMode, toggleMode, accent, setAccent, frameW, setFrameW, railW, setRailW, face, setFace };
}
