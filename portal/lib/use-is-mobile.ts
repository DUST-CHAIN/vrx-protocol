"use client";

// useIsMobile — a shared narrow-viewport hook, mirroring the matchMedia pattern already used
// BookingSearch. Returns true below the shell's mobile breakpoint (860px, the same one globals.css uses to
// collapse the dashboard). SSR-safe: starts false, resolves on mount (so the server render is the desktop
// layout and the client corrects on hydrate — no layout flash on desktop, a one-frame correct on mobile).

import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 860px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isMobile;
}
