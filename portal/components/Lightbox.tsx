"use client";

// 2nd consumer appeared (the buyer-vault document gallery) — one pop-out, many callers. Swipe/tap-arrows
// or ←/→ to move; Esc / tap-backdrop / ✕ to close. Images are shown `contain` (whole image, never cropped) so
// a portrait passport or a wide site photo both read fully. `caption` labels the popped-out image.

import { useEffect, useState } from "react";

export default function Lightbox({
  images,
  start,
  caption,
  onClose,
}: {
  images: string[];
  start: number;
  caption: string;
  onClose: () => void;
}) {
  const [i, setI] = useState(start);
  const n = images.length;
  const go = (d: number) => setI((p) => (n ? (p + d + n) % n : 0));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(5,7,12,0.92)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{ position: "absolute", top: 14, right: 16, width: 40, height: 40, borderRadius: 999, border: "none", background: "rgba(255,255,255,0.12)", color: "#fff", fontSize: 20, cursor: "pointer" }}
      >
        ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={images[i]}
        alt={caption}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "100%", maxHeight: "82vh", objectFit: "contain", borderRadius: 10 }}
      />
      <div style={{ color: "#c7cde0", fontSize: 13, marginTop: 12 }}>
        {caption}
        {n > 1 ? ` · ${i + 1} / ${n}` : ""}
      </div>
      {n > 1 && (
        <>
          <button type="button" onClick={(e) => { e.stopPropagation(); go(-1); }} aria-label="Previous"
            style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 44, height: 64, borderRadius: 10, border: "none", background: "rgba(255,255,255,0.12)", color: "#fff", fontSize: 26, cursor: "pointer" }}>‹</button>
          <button type="button" onClick={(e) => { e.stopPropagation(); go(1); }} aria-label="Next"
            style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", width: 44, height: 64, borderRadius: 10, border: "none", background: "rgba(255,255,255,0.12)", color: "#fff", fontSize: 26, cursor: "pointer" }}>›</button>
        </>
      )}
    </div>
  );
}
