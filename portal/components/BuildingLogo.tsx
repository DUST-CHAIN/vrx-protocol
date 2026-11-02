"use client";

// for now"). Same building id → same logo/colour every render, so the demo feels consistent. A simple
// stylised tower glyph on a tinted rounded square; the hue is derived from the id. Real developer logos
// (from the MM archive) can replace this later.

function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return h % 360;
}

export default function BuildingLogo({ id, size = 44 }: { id: string; size?: number }) {
  const hue = hashHue(id);
  const bg = `hsl(${hue} 40% 16%)`;
  const bar = `hsl(${hue} 70% 62%)`;
  const barDim = `hsl(${hue} 55% 45%)`;
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" role="img" aria-label="Building logo" style={{ flexShrink: 0 }}>
      <rect x="0" y="0" width="44" height="44" rx="10" fill={bg} />
      {/* stylised tower: three rising bars */}
      <rect x="11" y="24" width="6" height="12" rx="1.5" fill={barDim} />
      <rect x="19" y="16" width="6" height="20" rx="1.5" fill={bar} />
      <rect x="27" y="20" width="6" height="16" rx="1.5" fill={barDim} />
      {/* window dots */}
      <circle cx="14" cy="28" r="1" fill={bg} />
      <circle cx="22" cy="21" r="1" fill={bg} />
      <circle cx="22" cy="27" r="1" fill={bg} />
      <circle cx="30" cy="25" r="1" fill={bg} />
    </svg>
  );
}
