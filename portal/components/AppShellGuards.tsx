"use client";

// any one page:
// wait." This shows a top-layer spinner (reusing the existing.vrx-spin) on ROUTE TRANSITIONS (the role
// switch / nav case — the 'No buildings' flash was a page painting its empty state before data arrived)
// AND on demand for any slow action via `const busy = useBusy; busy.run(fetch(...))`. It is DELIBERATELY
// would flash constantly and feel worse. So it fires only for navigations + explicitly-wrapped actions.
// must not — or at least warn. In an installed PWA (display: standalone, see app/manifest.ts) Back already
// behaves app-like; this guard covers the in-BROWSER case: it pushes a history entry so the FIRST Back is
// caught (popstate) and shows a "Leave VRX?" confirm instead of leaving, and arms a beforeunload warning.
// The guard only arms AFTER the user has interacted/navigated (so a fresh load or refresh never warns).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

// ── 1. Busy context ────────────────────────────────────────────────────────────────────────────────────
type BusyCtx = {
  /** True while any navigation or wrapped action is in flight. */
  busy: boolean;
  /** Manually push/pop a busy token (returns a release fn). Prefer `run` for promises. */
  start: () => () => void;
  /** Wrap a promise so the overlay shows while it runs, then clears (even on error). Returns the promise. */
  run: <T>(p: Promise<T>) => Promise<T>;
};

const Ctx = createContext<BusyCtx>({
  busy: false,
  start: () => () => {},
  run: (p) => p,
});

/** Access the global busy overlay — `const { run } = useBusy; await run(fetch(...))`. */
export function useBusy(): BusyCtx {
  return useContext(Ctx);
}

export default function AppShellGuards({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const pathname = usePathname();

  const start = useCallback(() => {
    setCount((c) => c + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setCount((c) => Math.max(0, c - 1));
    };
  }, []);

  const run = useCallback(
    <T,>(p: Promise<T>): Promise<T> => {
      const release = start();
      return p.finally(release);
    },
    [start]
  );

  // ── Route-transition overlay ─────────────────────────────────────────────────────────────────────────
  // App Router gives us no "navigation started" event, but a pathname change means a transition completed.
  // We flash the overlay briefly on every pathname change so the user gets feedback that the new screen is
  // mounting/loading its data (the role-switch 'No buildings' flash window). Short + self-clearing so it never
  // sticks. Skips the very first render (initial mount isn't a "transition" the user triggered).
  const firstPath = useRef(true);
  const [routeBusy, setRouteBusy] = useState(false);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    setRouteBusy(true);
    const t = setTimeout(() => setRouteBusy(false), 650);
    return () => clearTimeout(t);
  }, [pathname]);

  // Also catch in-app link clicks so the overlay appears the INSTANT a nav is requested (not only once the new
  // route commits) — the snappy-feedback half. Only same-origin, left-click, no-modifier internal links.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href");
      const target = a.getAttribute("target");
      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("http") ||
        href.startsWith("//") || // protocol-relative external — doesn't same-page nav, would hang the spinner
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("javascript:") ||
        href.startsWith("data:") ||
        a.hasAttribute("download") ||
        target === "_blank"
      )
        return;
      // A genuine in-app navigation to a DIFFERENT path → show feedback, auto-clearing in case nav is cancelled.
      try {
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) return; // cross-origin → not an in-app nav
        if (url.pathname === window.location.pathname) return;
      } catch {
        return;
      }
      const release = start();
      window.setTimeout(release, 1200); // safety net — cleared by the next render / pathname effect anyway
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [start]);

  // ── 2. Back-button guard (phones) ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    let armed = false;

    // Arm only after the user has engaged (any pointer/key/scroll). A fresh load or refresh then never warns.
    const arm = () => {
      if (armed) return;
      armed = true;
      // Push a sentinel history entry so the FIRST Back press pops to us (caught below) instead of leaving.
      try {
        window.history.pushState({ vrxGuard: true }, "");
      } catch {
        /* history blocked — fall back to beforeunload only */
      }
    };

    const onPop = () => {
      if (!armed) return;
      const leave = window.confirm("Leave VRX? Your place in the preview won't be saved.");
      if (leave) {
        armed = false;
        window.history.back(); // let the real back happen (we're now one entry behind the sentinel)
      } else {
        // Stay: re-push the sentinel so the next Back is caught again.
        try {
          window.history.pushState({ vrxGuard: true }, "");
        } catch {
          /* ignore */
        }
      }
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!armed) return;
      e.preventDefault();
      e.returnValue = ""; // required for the native "leave site?" prompt in most browsers
    };

    const engage = () => arm();
    window.addEventListener("pointerdown", engage, { once: true });
    window.addEventListener("keydown", engage, { once: true });
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pointerdown", engage);
      window.removeEventListener("keydown", engage);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  const busy = count > 0 || routeBusy;

  return (
    <Ctx.Provider value={{ busy, start, run }}>
      {children}
      {busy && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            // A slim top progress bar + a corner spinner — unobtrusive, never a full-screen block (the app
            // stays usable underneath; this is feedback, not a modal).
            height: 0,
            zIndex: 9999,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "fixed",
              top: 12,
              right: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 12px",
              borderRadius: 999,
              background: "rgba(14,17,25,0.92)",
              border: "1px solid #232d40",
              color: "#9aa6be",
              fontSize: 12.5,
              boxShadow: "0 4px 18px rgba(0,0,0,0.4)",
            }}
          >
            <span className="vrx-spin" style={{ color: "#38d39f" }} />
            Loading…
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
