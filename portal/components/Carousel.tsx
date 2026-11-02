"use client";

// Image carousel (A3) — a simple, dependency-free photo carousel for the unit-detail + building
// dots, counter, graceful for 0/1 images. Presentational only.

import { useState, useEffect, useCallback, useRef, type CSSProperties } from "react";

export default function Carousel({
  images,
  alt = "",
  heightPx = 260,
  aspectRatio,
  rounded = 12,
  fit = "cover",
  index,
  onIndexChange,
  onImageClick,
}: {
  images: string[];
  alt?: string;
  heightPx?: number;
  /** When set, the frame uses a responsive aspect-ratio (e.g. "3 / 2") instead of a fixed px height —
   * so it adapts to the viewport width and stops the huge black letterbox bands on mobile.
   * Takes precedence over heightPx. */
  aspectRatio?: string;
  rounded?: number;
  /** cover = fill + crop (photos); contain = show the WHOLE image, letterboxed (floorplans). */
  fit?: "cover" | "contain";
  /** Optional controlled index — lets a parent jump the carousel (e.g. "Floor plan" button). */
  index?: number;
  onIndexChange?: (i: number) => void;
  /** Tap/click an image → parent opens a full-screen lightbox. */
  onImageClick?: (i: number) => void;
}) {
  // The frame sizing: a responsive aspect-ratio box when given (adapts to width, minimal dead space),
  // with slight rounded borders").
  const frameSize: CSSProperties = aspectRatio
    ? { width: "100%", aspectRatio, height: "auto" }
    : { width: "100%", height: heightPx };
  const [uncontrolled, setUncontrolled] = useState(0);
  const n = images.length;
  const controlled = index != null;
  const i = controlled ? Math.min(Math.max(index, 0), Math.max(0, n - 1)) : uncontrolled;
  const setI = useCallback(
    (next: number | ((p: number) => number)) => {
      const resolve = (p: number) => (typeof next === "function" ? (next as (p: number) => number)(p) : next);
      if (controlled) onIndexChange?.(resolve(i));
      else setUncontrolled((p) => resolve(p));
    },
    [controlled, onIndexChange, i]
  );

  const go = useCallback((d: number) => setI((p) => (n ? (p + d + n) % n : 0)), [n, setI]);

  // Reset to the first image only when the image SET actually changes (not on every render — `images`
  // is rebuilt inline by the parent each render, so keying on its identity would loop forever). We track
  // a content signature and reset once when it changes.
  const sig = images.join("|");
  const prevSig = useRef(sig);
  useEffect(() => {
    if (prevSig.current === sig) return;
    prevSig.current = sig;
    if (controlled) onIndexChange?.(0);
    else setUncontrolled(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  useEffect(() => {
    if (n < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [n, go]);

  if (n === 0) {
    return (
      <div
        style={{
          ...frameSize,
          borderRadius: rounded,
          background: "#0e1119",
          border: "1px solid #1c2130",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#4a5169",
          fontSize: 13,
        }}
      >
        No photos
      </div>
    );
  }

  // The tricky part: after touchend the browser also fires a synthetic CLICK — if the <img> had its own
  // and we swallow the synthetic click that follows. onClick only acts for a real MOUSE click (desktop).
  const touch = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const onTouchStart = (e: React.TouchEvent) => {
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!touch.current) return;
    const dx = e.touches[0].clientX - touch.current.x;
    const dy = e.touches[0].clientY - touch.current.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) touch.current.moved = true;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touch.current) return;
    const dx = e.changedTouches[0].clientX - touch.current.x;
    const dy = e.changedTouches[0].clientY - touch.current.y;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    if (touch.current.moved && horizontal && Math.abs(dx) > 40) {
      go(dx < 0 ? 1 : -1); // a real swipe
    } else if (!touch.current.moved) {
      onImageClick?.(i); // a clean tap → popout
    }
    touch.current = null;
    // Block the synthetic click the browser fires right after this touch sequence.
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 500);
  };
  const onImgClick = () => {
    if (swallowClick.current) return; // this click came from a touch → already handled
    onImageClick?.(i);
  };

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        borderRadius: rounded,
        overflow: "hidden",
        border: "1px solid #1c2130",
        background: "#0e1119",
        touchAction: "pan-y",
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={images[i]}
        alt={alt}
        onClick={onImgClick}
        style={{
          ...frameSize,
          objectFit: fit,
          objectPosition: "center", // center the image in its frame (no top/left anchoring)
          background: "#0e1119",
          display: "block",
          cursor: onImageClick ? "zoom-in" : "default",
        }}
      />
      {n > 1 && (
        <>
          <NavBtn side="left" onClick={() => go(-1)} />
          <NavBtn side="right" onClick={() => go(1)} />
          <div
            style={{
              position: "absolute",
              bottom: 6,
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 4,
              padding: "0 10px",
              flexWrap: "nowrap",
            }}
          >
            {images.map((_, k) => (
              <span
                key={k}
                onClick={(e) => { e.stopPropagation(); setI(k); }}
                style={{
                  width: k === i ? 14 : 5,
                  height: 5,
                  borderRadius: 999,
                  flex: "none",
                  background: k === i ? "#3d7dff" : "rgba(170,185,220,0.4)",
                  cursor: "pointer",
                  transition: "width 0.2s, background 0.2s",
                }}
              />
            ))}
          </div>
          <div
            style={{
              position: "absolute",
              bottom: 30,
              left: 10,
              fontSize: 11,
              color: "#e8ecf6",
              background: "rgba(0,0,0,0.5)",
              padding: "2px 8px",
              borderRadius: 999,
            }}
          >
            {i + 1} / {n}
          </div>
        </>
      )}
    </div>
  );
}

function NavBtn({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      // Stop the tap from bubbling to the parent's touch/click handler (else tapping an arrow would
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onTouchEnd={(e) => { e.stopPropagation(); }}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
      style={{
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        [side]: 4,
        width: 30,
        height: 44,
        borderRadius: 8,
        border: "none",
        background: "rgba(0,0,0,0.42)",
        color: "#fff",
        fontSize: 20,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}
