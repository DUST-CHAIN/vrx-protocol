"use client";

// SealedRing — a VISUAL "this identity is sealed/vetted" treatment, beyond a plain lock icon.
// Wraps any avatar content (a photo chip OR the brand mark) in a subtle animated iridescent ring — the
// "holographic credential" look of a passport/ID hologram — with a small ✓ seal badge notched into the ring.
//
// WHY: "if an identity is sealed we want to SHOW it (visually), not just a lock icon." A vetted actor
// should LOOK verified at a glance. The ring reads as a tamper-evident credential; the ✓ badge confirms it.
//
// HONESTY: this is a UI cue for a profile that PASSED the off-chain identity-seal re-hash (the card's
// `verified` flag, from /api/profiles). It is NOT itself a cryptographic proof — it reflects the verify
// result, same as the card's "✓ Vetted — identity seal verifies" line. When `sealed` is false, the ring is
// NOT shown (an unverified/anonymous avatar must never wear the seal).
//
// Works WITH OR WITHOUT a photo — so it also covers the "no portrait yet" case gracefully (the ring hugs the
// brand mark). Reduced-motion users get the ring without the shimmer animation.

import { useId } from "react";

export default function SealedRing({
  size,
  sealed,
  children,
  showBadge = true,
}: {
  /** Diameter of the INNER avatar content (px). The ring is drawn just outside it. */
  size: number;
  /** True only when the identity seal verified. When false, no ring/badge is rendered. */
  sealed: boolean;
  /** The avatar content (photo chip or brand mark). */
  children: React.ReactNode;
  /** Show the small ✓ seal badge notched into the ring. Hide for very small avatars if cramped. */
  showBadge?: boolean;
}) {
  const gid = useId().replace(/[:]/g, "");
  if (!sealed) return <>{children}</>;

  const ring = Math.max(2, Math.round(size * 0.056)); // ring thickness scales with the avatar (~20% thinner)
  const pad = ring + 2; // gap between content and ring
  const box = size + pad * 2; // outer box incl. ring
  const badge = Math.max(12, Math.round(size * 0.28)); // slightly smaller badge to match the lighter ring

  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: box,
        height: box,
        flex: "none",
      }}
      title="Vetted — identity seal verifies"
    >
      {/* The iridescent ring (a conic shimmer masked to a ring band). SMIL-free: CSS animation on the gradient
          angle. Degrades to a static ring under prefers-reduced-motion. */}
      <span
        aria-hidden
        className={`vrx-seal-ring-${gid}`}
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          padding: ring,
          background:
            "conic-gradient(from 0deg, #00EC97, #45B7FF, #8b5cf6, #ff7ab0, #00EC97)",
          // mask so only the ring BAND shows (hollow centre)
          WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - " + ring + "px), #000 calc(100% - " + ring + "px))",
          mask: "radial-gradient(farthest-side, transparent calc(100% - " + ring + "px), #000 calc(100% - " + ring + "px))",
          opacity: 0.72,
        }}
      />
      {/* Inner content, centred inside the ring. */}
      <span style={{ position: "relative", width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        {children}
      </span>
      {/* The ✓ seal badge, notched at the bottom-right of the ring. */}
      {showBadge && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: badge,
            height: badge,
            borderRadius: "50%",
            background: "#00EC97",
            color: "#06281c",
            border: "2px solid #0a0a0a",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: Math.round(badge * 0.62),
            fontWeight: 800,
            lineHeight: 1,
            boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          ✓
        </span>
      )}
      <style>{`
        .vrx-seal-ring-${gid} { animation: vrxSealSpin-${gid} 6s linear infinite; }
        @keyframes vrxSealSpin-${gid} {
          to { filter: hue-rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .vrx-seal-ring-${gid} { animation: none; }
        }
      `}</style>
    </span>
  );
}
