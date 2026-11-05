// The VRX brand MARK — a rounded logo chip that replaces the old ◆ diamond in the header.
//
// Two render paths:
//  • BRAND MARK (default) — rendered as INLINE SVG (BrandMarkSvg below), not an <img>. Inline is required
//    because the two node-tip circles ANIMATE (fly out "like aliens" then return via the sealed-node dot,
// ) and SMIL animation does NOT run inside an <img src="…svg">. The static file
//    portal/public/vrx-mark.svg carries the same geometry for favicon / PWA / plain-<img> contexts.
//  • USER PHOTO (future photo subsystem) — when `photoUrl` is set, show the photo via next/image in a
//  circular white chip. Clicking it opens the user's SEALED identity card ("like an ID card").
//    The seam is here now (optional `photoUrl`/`onClick`) so that arc only passes props.
//
// Sized "a little bigger than the Connect-wallet button height": that button is ~29px tall
// (padding 7px + ~15px line), so the mark defaults to 32px.

import Image from "next/image";

// The brand hexagon-V, inline so its SMIL animation actually plays. Geometry mirrors public/vrx-mark.svg
// (grown 12% about centre; V dropped 41px ≈ 8% of the canvas). The two node-tip circles idle most of each
// cycle, then dart outward, converge on the sealed-node dot at the top-left vertex, and glide home —
// the "fly out like aliens and come back via the small dot on the hexagon".
function BrandMarkSvg({ size, alt }: { size: number; alt: string }) {
  // Motion is in each circle's LOCAL frame (the parent scale/translate carry it along consistently).
  // Left circle centre (176,199) → sealed dot (151,74.1): offset (-25,-124.9). Right (336,199): (-185,-124.9).
  // keyTimes: idle (0→0.70), dart out (→0.80), to the dot (→0.90), home (→1.0). ~9s loop = "from time to time".
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <linearGradient id="vrxVmark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
      <g transform="translate(256 256) scale(1.12) translate(-256 -256)">
        <polygon
          points="466,256 361,437.9 151,437.9 46,256 151,74.1 361,74.1"
          fill="#0a0a0a"
          stroke="#f4f4f5"
          strokeWidth={16}
          strokeLinejoin="round"
        />
        {/* Sealed-node dot — the "home" the circles return through. */}
        <circle cx="151" cy="74.1" r="30" fill="#0a0a0a" stroke="#f4f4f5" strokeWidth={7} />
        <g transform="translate(0 41)">
          <path
            d="M176 158 L256 330 L336 158"
            fill="none"
            stroke="url(#vrxVmark)"
            strokeWidth={54}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Left node tip: dart up-left, converge on the dot, glide home. */}
          <circle cx="176" cy="158" r="30" fill="#7c3aed">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 0 0; -140 -90; -25 -124.9; 0 0"
              keyTimes="0; 0.70; 0.80; 0.90; 1"
              dur="9s"
              calcMode="spline"
              keySplines="0 0 1 1; 0.4 0 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1"
              repeatCount="indefinite"
            />
          </circle>
          {/* Right node tip: dart up-right, converge on the dot, glide home. */}
          <circle cx="336" cy="158" r="30" fill="#7c3aed">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 0 0; 150 -80; -185 -124.9; 0 0"
              keyTimes="0; 0.70; 0.80; 0.90; 1"
              dur="9s"
              calcMode="spline"
              keySplines="0 0 1 1; 0.4 0 0.2 1; 0.4 0 0.2 1; 0.4 0 0.2 1"
              repeatCount="indefinite"
            />
          </circle>
        </g>
      </g>
    </svg>
  );
}

export default function VrxLogoMark({
  size = 32,
  photoUrl,
  onClick,
  alt = "",
}: {
  /** Diameter of the circular mark in px. */
  size?: number;
  /** When set (logged-in user), show this instead of the VRX logo. */
  photoUrl?: string;
  /** When set, the mark is a button (future: open the sealed ID card). */
  onClick?: () => void;
  /** a11y label. Default "" (decorative) — the headers render a "VRX" wordmark right beside it, so an
   *  "VRX" alt here would make screen readers announce "VRX VRX". Pass a real label (e.g. the user's name)
   *  when this becomes the clickable profile photo. */
  alt?: string;
}) {
  const isPhoto = Boolean(photoUrl);
  const circle: React.CSSProperties = {
    width: size,
    height: size,
    // Pin the box to a RIGID square. A flex topbar row with the default `align-items: stretch` was stretching
    // the photo chip vertically → the avatar rendered SQUASHED, even though the source icon is a
    // perfect 72×72. minWidth/minHeight + aspectRatio + flex:none make the chip immune to parent stretch.
    minWidth: size,
    minHeight: size,
    maxWidth: size,
    maxHeight: size,
    aspectRatio: "1 / 1",
    alignSelf: "center",
    // User photos are framed in a circular white chip. The brand MARK is the hexagon artwork itself —
    // it must NOT be circle-clipped (that crops the hexagon corners + the sealed-node dot at the top vertex),
    // so it renders square with overflow visible.
    borderRadius: isPhoto ? "50%" : 0,
    overflow: isPhoto ? "hidden" : "visible",
    flex: "none",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    // User photos get a white chip + ring so they read as a deliberate framed avatar on the dark bar.
    // The brand MARK carries its own dark hexagon, so it sits bare (no white halo around the hexagon).
    background: isPhoto ? "#fff" : "transparent",
    boxShadow: isPhoto ? "0 0 0 1px #2a2f40" : "none",
    cursor: onClick ? "pointer" : "default",
    padding: 0,
    border: "none",
  };
  const inner = isPhoto ? (
    <Image
      src={photoUrl as string}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size, minWidth: size, minHeight: size, objectFit: "cover", display: "block" }}
      priority
    />
  ) : (
    <BrandMarkSvg size={size} alt={alt} />
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} style={circle} aria-label={alt} title={alt}>
        {inner}
      </button>
    );
  }
  return <span style={circle}>{inner}</span>;
}
