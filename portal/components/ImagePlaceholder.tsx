"use client";

// ImagePlaceholder — a set of nice, LEGIBLE, category-aware SVG stand-ins for when a real photo/render
// is missing.: a missing image shouldn't dull the UI with a flat "No image" box — each image KIND
// should get its own sensible, colourful illustration so a no-photo card still looks intentional and tells the
// viewer what WOULD be there (an exterior render / an interior / a facility / a floor plan).
//
// House style (consistent with BuildingLogo + the MM placeholder): deterministic — the hue + silhouette
// derive from the building id, so the same building always gets the same slide (stable across renders, no
// Math.random — which is also banned in some of our contexts). Colourful but calm: a two-stop gradient in the
// building's hue + a clean line/shape motif + a small caption of what the slot depicts.
//
// Kinds (one per image slot type the system carries — mirrors the MM media slots):
//   exterior  — a skyline of towers (the default for a building catalog card)
//   interior  — a room: window with a view, a sofa + lamp
//   facility  — a pool with ripples + a palm (amenity deck)
//   level     — a WHOLE-FLOOR stacking plan: several units around a central core/corridor
//   unit      — a SINGLE unit's layout: rooms, a door swing, a window
// Each is self-contained; add a kind by adding a branch. Reusable anywhere an <img> would go (catalog card,
// gallery slot, MM). PURE presentation.

export type PlaceholderKind = "exterior" | "interior" | "facility" | "level" | "unit";

function hashInt(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h);
}

const CAPTION: Record<PlaceholderKind, string> = {
  exterior: "Exterior view",
  interior: "Interior",
  facility: "Facilities",
  level: "Level plan",
  unit: "Unit plan",
};

export default function ImagePlaceholder({
  id,
  kind = "exterior",
  label,
}: {
  id: string;
  kind?: PlaceholderKind;
  /** Overrides the default caption (e.g. the building/unit name). */
  label?: string;
}) {
  const seed = hashInt(id + ":" + kind);
  // Each kind gets its OWN hue family so a facility doesn't look like an exterior, but still shifted per id so
  // two buildings differ. exterior=blue, interior=warm, facility=teal, plan=indigo — then nudged by the id.
  const baseHue = { exterior: 212, interior: 28, facility: 168, level: 262, unit: 230 }[kind];
  const hue = (baseHue + (seed % 40) - 20 + 360) % 360;
  const bgTop = `hsl(${hue} 46% 17%)`;
  const bgBot = `hsl(${(hue + 16) % 360} 40% 10%)`;
  const lit = `hsl(${hue} 62% 60%)`;
  const dim = `hsl(${hue} 46% 42%)`;
  const soft = `hsl(${hue} 50% 80%)`;
  const gid = `ph-${kind}-${seed}`;

  return (
    <svg
      // The viewBox IS 16:9 (100 × 56.25) and we use "slice" — so for a 16:9 card it fills edge-to-edge with
      // ZERO crop and ZERO letterbox (matching aspect). The sub-scenes are authored in a 0..62 band and scaled
      // DOWN into the upper ~82% via a <g transform>, leaving a caption strip at the bottom — so everything,
      // incl. the caption, lives inside the 16:9 box and the whole thing fills the card.
      viewBox="0 0 100 56.25"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={`${label ?? CAPTION[kind]} — illustration`}
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={bgTop} />
          <stop offset="1" stopColor={bgBot} />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="100" height="56.25" fill={`url(#${gid})`} />

      {/* Scene authored in a 0..62 tall band, scaled to fit the 0..46 region of the 16:9 box (≈0.742×). */}
      <g transform="scale(1, 0.742)">
        {kind === "exterior" && <Exterior id={id} lit={lit} dim={dim} win={soft} />}
        {kind === "interior" && <Interior lit={lit} dim={dim} soft={soft} />}
        {kind === "facility" && <Facility lit={lit} dim={dim} soft={soft} />}
        {kind === "level" && <Level lit={lit} dim={dim} soft={soft} />}
        {kind === "unit" && <UnitPlan lit={lit} dim={dim} soft={soft} />}
      </g>

      {/* caption strip pinned to the bottom of the 16:9 box */}
      <rect x="0" y="47.5" width="100" height="8.75" fill="#05070c" opacity="0.32" />
      <text
        x="50"
        y="53.2"
        fill="#ffffff"
        fillOpacity="0.74"
        fontFamily="system-ui, sans-serif"
        fontSize="4.2"
        fontWeight="600"
        textAnchor="middle"
        letterSpacing="0.3"
      >
        {(label ?? CAPTION[kind]).toUpperCase()}
      </text>
    </svg>
  );
}

// ── Exterior: a deterministic skyline ───────────────────────────────────────────────────────────────────
function Exterior({ id, lit, dim, win }: { id: string; lit: string; dim: string; win: string }) {
  const n = 7;
  const towers = Array.from({ length: n }, (_, i) => {
    const s = hashInt(id + ":tower:" + i);
    return { w: 8 + (s % 5), h: 18 + (s % 30), lit: (s >> 3) % 2 === 0 };
  });
  const gap = 2;
  const totalW = towers.reduce((a, t) => a + t.w, 0) + gap * (n - 1);
  let x = (100 - totalW) / 2;
  const baseY = 62;
  return (
    <g>
      {towers.map((t, i) => {
        const tx = x;
        x += t.w + gap;
        const ty = baseY - t.h;
        const dots = [];
        const rows = Math.max(2, Math.floor(t.h / 6));
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < 2; c++) {
            if ((hashInt(id + i + "w" + r + c) >> 2) % 3 !== 0) continue;
            dots.push(
              <rect key={`${r}-${c}`} x={tx + 1.6 + c * (t.w - 3.2) * 0.6} y={ty + 3 + r * 5} width={1.4} height={2} rx={0.3} fill={win} opacity={0.5} />
            );
          }
        }
        return (
          <g key={i}>
            <rect x={tx} y={ty} width={t.w} height={t.h} rx={1} fill={t.lit ? lit : dim} opacity={t.lit ? 0.92 : 0.78} />
            {dots}
          </g>
        );
      })}
    </g>
  );
}

// ── Interior: a window with a skyline view, a sofa + a lamp ─────────────────────────────────────────────
function Interior({ lit, dim, soft }: { lit: string; dim: string; soft: string }) {
  return (
    <g>
      {/* floor line */}
      <rect x="0" y="54" width="100" height="0.8" fill={dim} opacity="0.6" />
      {/* a big picture window with a tiny skyline inside */}
      <rect x="20" y="12" width="40" height="30" rx="1.5" fill="none" stroke={soft} strokeOpacity="0.55" strokeWidth="1.2" />
      <line x1="40" y1="12" x2="40" y2="42" stroke={soft} strokeOpacity="0.3" strokeWidth="0.8" />
      <line x1="20" y1="27" x2="60" y2="27" stroke={soft} strokeOpacity="0.3" strokeWidth="0.8" />
      {[24, 29, 34, 45, 50, 54].map((bx, i) => (
        <rect key={i} x={bx} y={38 - (i % 3) * 4 - 6} width={3} height={(i % 3) * 4 + 10} fill={lit} opacity={0.5} />
      ))}
      {/* sofa */}
      <rect x="22" y="46" width="26" height="8" rx="2" fill={lit} opacity="0.85" />
      <rect x="22" y="42" width="26" height="6" rx="2" fill={dim} opacity="0.9" />
      <rect x="20" y="44" width="4" height="10" rx="1.5" fill={dim} />
      <rect x="46" y="44" width="4" height="10" rx="1.5" fill={dim} />
      {/* floor lamp */}
      <rect x="68" y="30" width="1.2" height="24" fill={soft} opacity="0.5" />
      <path d="M64 30 h12 l-3 6 h-6 z" fill={lit} opacity="0.8" />
    </g>
  );
}

// ── Facility: a pool with ripples + a palm (amenity deck) ───────────────────────────────────────────────
function Facility({ lit, dim, soft }: { lit: string; dim: string; soft: string }) {
  return (
    <g>
      {/* deck */}
      <rect x="0" y="48" width="100" height="14" fill={dim} opacity="0.35" />
      {/* pool */}
      <rect x="18" y="40" width="54" height="18" rx="3" fill={lit} opacity="0.55" />
      {[44, 48, 52].map((ry, i) => (
        <path key={i} d={`M22 ${ry} q6 -2 12 0 t12 0 t12 0`} fill="none" stroke={soft} strokeOpacity="0.5" strokeWidth="0.8" />
      ))}
      {/* palm */}
      <rect x="80" y="30" width="1.8" height="22" fill={dim} />
      {[-1, -0.4, 0.4, 1].map((k, i) => (
        <path key={i} d={`M81 31 q ${k * 14} ${-6 - Math.abs(k) * 2} ${k * 20} ${2}`} fill="none" stroke={lit} strokeOpacity="0.85" strokeWidth="1.6" strokeLinecap="round" />
      ))}
      {/* sun */}
      <circle cx="14" cy="18" r="6" fill={lit} opacity="0.8" />
    </g>
  );
}

// ── Level: a WHOLE-FLOOR stacking plan — units around a central core/corridor ───────────────────────────
function Level({ lit, dim, soft }: { lit: string; dim: string; soft: string }) {
  // Six units (3 top, 3 bottom) flanking a central horizontal corridor + a lift/stair core in the middle.
  const units = [
    { x: 14, y: 14, w: 18, h: 16 }, { x: 34, y: 14, w: 18, h: 16 }, { x: 68, y: 14, w: 18, h: 16 },
    { x: 14, y: 44, w: 18, h: 16 }, { x: 34, y: 44, w: 18, h: 16 }, { x: 68, y: 44, w: 18, h: 16 },
  ];
  return (
    <g>
      {/* outer slab */}
      <rect x="10" y="12" width="80" height="50" fill="none" stroke={dim} strokeWidth="1.2" strokeOpacity="0.5" />
      {units.map((u, i) => (
        <rect key={i} x={u.x} y={u.y} width={u.w} height={u.h} rx="0.8" fill={lit} opacity={0.22} stroke={lit} strokeOpacity="0.8" strokeWidth="1" />
      ))}
      {/* central corridor */}
      <rect x="10" y="33" width="80" height="8" fill={soft} opacity="0.1" />
      <line x1="10" y1="33" x2="90" y2="33" stroke={soft} strokeOpacity="0.25" strokeWidth="0.6" />
      <line x1="10" y1="41" x2="90" y2="41" stroke={soft} strokeOpacity="0.25" strokeWidth="0.6" />
      {/* lift / stair core */}
      <rect x="54" y="30" width="12" height="14" rx="1" fill={dim} opacity="0.85" stroke={soft} strokeOpacity="0.3" strokeWidth="0.6" />
      <line x1="60" y1="30" x2="60" y2="44" stroke={soft} strokeOpacity="0.4" strokeWidth="0.6" />
      <path d="M56 37 l8 0 M61 34 l3 3 l-3 3" fill="none" stroke={soft} strokeOpacity="0.5" strokeWidth="0.7" />
    </g>
  );
}

// ── Unit: a schematic floor outline on a grid, with a door swing ─────────────────────────────────────────
function UnitPlan({ lit, dim, soft }: { lit: string; dim: string; soft: string }) {
  return (
    <g>
      {/* faint grid */}
      {Array.from({ length: 9 }, (_, i) => (
        <line key={`v${i}`} x1={10 + i * 10} y1="8" x2={10 + i * 10} y2="56" stroke={soft} strokeOpacity="0.08" strokeWidth="0.5" />
      ))}
      {Array.from({ length: 5 }, (_, i) => (
        <line key={`h${i}`} x1="10" y1={10 + i * 11} x2="90" y2={10 + i * 11} stroke={soft} strokeOpacity="0.08" strokeWidth="0.5" />
      ))}
      {/* outer walls */}
      <rect x="22" y="14" width="56" height="40" fill="none" stroke={lit} strokeWidth="1.8" />
      {/* interior partitions */}
      <line x1="52" y1="14" x2="52" y2="40" stroke={dim} strokeWidth="1.3" />
      <line x1="52" y1="40" x2="78" y2="40" stroke={dim} strokeWidth="1.3" />
      <line x1="22" y1="34" x2="40" y2="34" stroke={dim} strokeWidth="1.3" />
      {/* a door swing */}
      <path d="M40 34 a6 6 0 0 1 6 -6" fill="none" stroke={soft} strokeOpacity="0.6" strokeWidth="0.8" />
      {/* a window tick on the top wall */}
      <line x1="30" y1="14" x2="40" y2="14" stroke={soft} strokeWidth="2.2" strokeOpacity="0.7" />
    </g>
  );
}
