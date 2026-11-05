"use client";

// Portal — render children into document.body, escaping the DOM subtree they're declared in.
//
// WHY THIS EXISTS: a modal/overlay declared INSIDE a dropdown (e.g. TopbarMenu) is a DOM descendant of
// that menu. When the menu closes (TopbarMenu's children-wrapper fires setOpen(false) on any inner click),
// it unmounts the whole panel — taking the child modal with it. The modal opens and is destroyed in the
// SAME click, so it "does nothing" (the live-site "Help fund & run VRX" + "ID card" dead clicks, F-).
// Routing the overlay through a body-level portal detaches it from the menu subtree, so the menu closing
// no longer unmounts it. Modals belong at body level anyway (same reason AccountIdCard needed z-index
// 100000 to clear Leaflet's stacking context — a portal sidesteps stacking-context fights entirely).
//
// Reuse: wrap ANY fixed-position overlay that may be declared inside a collapsing/scrolling container.

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export default function Portal({ children }: { children: ReactNode }) {
  // SSR-safe: document only exists after mount. Render nothing on the server / first paint, then portal.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
