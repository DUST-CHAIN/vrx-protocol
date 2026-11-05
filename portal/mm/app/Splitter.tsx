"use client";

// Draggable vertical splitter that resizes the left FRAME. Drags update --frame-w live;
// on release the width is persisted via setFrameW. Keyboard-accessible (←/→ nudge).

import { useCallback, useEffect, useRef } from "react";

export function Splitter({ onResize }: { onResize: (px: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMove = useCallback(
    (clientX: number) => {
      // the shell starts at the viewport left edge, so the FRAME width is simply clientX.
      onResize(clientX);
    },
    [onResize]
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
        const cur = parseInt(getComputedStyle(document.body).getPropertyValue("--frame-w")) || 300;
        if (e.key === "ArrowLeft") onResize(cur - 16);
        else if (e.key === "ArrowRight") onResize(cur + 16);
      }}
    />
  );
}
