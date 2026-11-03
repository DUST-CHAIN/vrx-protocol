"use client";

// Draggable vertical splitter (; right-pane added). Drags update a width live; on release the
// width is persisted via onResize. Keyboard-accessible (←/→ nudge). `side` picks which pane it sizes:
//   "left"  → the FRAME (left tree): width = clientX (shell starts at the viewport left edge).
//   "right" → the RAIL (inspector):  width = viewport width − clientX (mirror; pane hugs the right edge).

import { useCallback, useEffect, useRef } from "react";

export function Splitter({
  onResize,
  side = "left",
  cssVar = "--frame-w",
  fallback = 300,
}: {
  onResize: (px: number) => void;
  side?: "left" | "right";
  cssVar?: string; // the CSS var the keyboard-nudge reads the current width from
  fallback?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMove = useCallback(
    (clientX: number) => {
      // left pane width = clientX; right pane width = distance from the cursor to the viewport's right edge.
      onResize(side === "right" ? window.innerWidth - clientX : clientX);
    },
    [onResize, side]
  );

  useEffect(() => {
    function move(e: MouseEvent) {
      if (!dragging.current) return;
      e.preventDefault();
      onMove(e.clientX);
    }
    function up() {
      if (!dragging.current) return;
      dragging.current = false;
      ref.current?.removeAttribute("data-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onMove]);

  return (
    <div
      ref={ref}
      className="mm-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabIndex={0}
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        ref.current?.setAttribute("data-dragging", "true");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onKeyDown={(e) => {
        const cur = parseInt(getComputedStyle(document.body).getPropertyValue(cssVar)) || fallback;
        // for the right pane, ArrowLeft WIDENS (the pane grows leftward) — mirror the nudge direction.
        const grow = side === "right" ? "ArrowLeft" : "ArrowRight";
        const shrink = side === "right" ? "ArrowRight" : "ArrowLeft";
        if (e.key === shrink) onResize(cur - 16);
        else if (e.key === grow) onResize(cur + 16);
      }}
    />
  );
}
