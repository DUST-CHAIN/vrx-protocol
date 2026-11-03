"use client";

// TwoFingerPan (B3) — a dependency-free react-leaflet child that makes a map behave the way phone
// users expect inside a scrollable page: ONE finger scrolls the PAGE (the map doesn't trap the drag), TWO
// fingers pan/zoom the MAP. the mobile review: the map grabbed one-finger drag so you couldn't scroll
// past it. No plugin (keeps the dep/licence surface clean for the curated public repo); pure Leaflet.
//
// How: on a touch device we disable map.dragging by default and set the container's touch-action to pan-y
// (so a vertical swipe is handed to the page scroller). On touchstart we enable dragging only while >=2
// touches are down, and disable it again when the gesture drops back to one finger. Desktop (mouse) is
// untouched — dragging stays on, so a laptop still click-drags the map normally.

import { useEffect } from "react";
import { useMap } from "react-leaflet";

export default function TwoFingerPan() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    // Only gate touch input. A coarse pointer (phone/tablet) is the case hit; a mouse keeps full drag.
    const isTouch =
      typeof window !== "undefined" &&
      (("ontouchstart" in window) || (navigator.maxTouchPoints ?? 0) > 0);
    if (!isTouch) return;

    // Let a one-finger vertical swipe scroll the page instead of being swallowed by the map.
    const prevTouchAction = container.style.touchAction;
    container.style.touchAction = "pan-y";

    // Start with dragging OFF; a two-finger gesture turns it on for the duration of that gesture.
    map.dragging.disable();

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        if (!map.dragging.enabled()) map.dragging.enable();
      } else {
        if (map.dragging.enabled()) map.dragging.disable();
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      // When fingers lift back below two, hand single-finger gestures back to the page.
      if (e.touches.length < 2 && map.dragging.enabled()) map.dragging.disable();
    };

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      container.style.touchAction = prevTouchAction;
      // Restore drag so a later non-gated consumer / desktop isn't left disabled.
      map.dragging.enable();
    };
  }, [map]);

  return null;
}
