"use client";

// TopbarMenu — on mobile the whole topbar control set collapses into ONE ☰ overflow menu, so
// the bar is just ◆ VRX + ☰ (: "put most of the top bar and all buttons inside"). It reuses the EXACT
// same control components (role switch, search, connect, settings) + the section nav, rendered stacked inside
// a dropdown panel — nothing is rewritten, so desktop behaviour is untouched (desktop never renders this).
//
// "Don't break what we have": DashboardShell renders EITHER the inline control row (desktop) OR this menu
// (mobile) via useIsMobile, so each control mounts exactly once — no duplicate state.
//
// TWO WIDTHS: a right-anchored COMPACT card (best practice for a short action list) OR a
// FULL-WIDTH top DRAWER, toggled by the user and remembered (localStorage). The drawer is the "fancy, costs
// nothing" option; the card is the sensible default. Either way the panel is position:fixed with a high
// z-index so it escapes the sticky-topbar / main-content stacking contexts (the invisible-menu bug).

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { T } from "@/lib/theme";

const WIDE_KEY = "vrx.menuWide"; // "1" = full-width drawer, else compact card

export default function TopbarMenu({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Restore the remembered width mode once on mount.
  useEffect(() => {
    try {
      setWide(window.localStorage.getItem(WIDE_KEY) === "1");
    } catch {
      /* storage blocked — default compact */
    }
  }, []);

  const toggleWide = () => {
    setWide((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(WIDE_KEY, next ? "1" : "0");
      } catch {
        /* non-persistent, still works this session */
      }
      return next;
    });
  };

  // Close on outside click / Escape — standard dropdown dismissal.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Shared panel chrome; the width/anchor differs by mode.
  const panelBase: React.CSSProperties = {
    position: "fixed",
    top: 64, // ≈ topbar height; hangs just under the bar
    zIndex: 905, // above page content; like the Help widget (900). Escapes the topbar/main stacking contexts.
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 14,
    background: T.panel ?? "#121826",
    border: `1px solid ${"#394867"}`,
    boxShadow: "0 12px 34px rgba(0,0,0,0.55)",
  };
  const panelStyle: React.CSSProperties = wide
    ? {
        ...panelBase,
        // Full-width top drawer — spans the screen (minus a small gutter), reads as a nav surface.
        left: 16,
        right: 16,
        borderRadius: 14,
      }
    : {
        ...panelBase,
        // Compact right-anchored card — wider + tidier than the first cut so the account id isn't truncated.
        right: 16, // match the topbar's 16px right padding so the panel's right edge lines up under the ☰
        minWidth: 240,
        maxWidth: "min(92vw, 360px)",
        borderRadius: 12,
      };

  return (
    <div ref={ref} style={{ position: "relative", ...style }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu"
        aria-expanded={open}
        title="Menu"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 38,
          height: 38,
          minHeight: 38,
          borderRadius: 9,
          border: `1px solid ${"#39507e"}`,
          background: "#141b2d",
          color: "#cdd8f2",
          fontSize: 18,
          cursor: "pointer",
          lineHeight: 1,
        }}
      >
        {open ? "✕" : "☰"}
      </button>

      {open && (
        <div role="menu" style={panelStyle}>
          {/* Panel header: a small width toggle (fancy, costs nothing) — expand to full width / collapse to a
              card. Stops click-propagation so toggling width doesn't close the menu. */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -4 }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleWide();
              }}
              aria-label={wide ? "Collapse menu to a card" : "Expand menu to full width"}
              title={wide ? "Collapse to a card" : "Expand to full width"}
              style={{
                border: `1px solid ${"#394867"}`,
                background: "#141b2d",
                color: "#9ab0ff",
                borderRadius: 7,
                fontSize: 13,
                lineHeight: 1,
                padding: "4px 8px",
                cursor: "pointer",
              }}
            >
              {wide ? "⤢ card" : "⤡ wide"}
            </button>
          </div>
          {/* Tapping a CONTROL inside acts then closes the menu (nav pushes a route / opens a modal). Scoped to
              this wrapper so the width toggle above is excluded. */}
          <div onClick={() => setOpen(false)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
