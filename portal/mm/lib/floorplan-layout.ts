// Floor LAYOUT store — the user's hand-authored unit ARRANGEMENT (the correction replaces the
// mistaken drag-swap). The subdivision engine (subdivide.ts) auto-derives a default arrangement from the unit
// mix (seedsFromAi lays area-weighted door pins); THIS layer lets the user OVERRIDE where each unit sits ALONG
// the floor axis — nudging it left/right pixel-by-pixel — and PERSISTS those positions with the pack.
//
// WHAT A NUDGE IS (confirmed): an along-axis POSITION offset per unit. Width stays SIZE-computed
// (the engine's width∝area law is untouched) — the user moves WHERE a unit sits, not how wide it is. A reserved
// `widthOverrides` field is the later escape hatch (#2) for the odd case that needs a manual width; UNBUILT now.
//
// SCOPE — deliberately KEYED BY FLOOR SIGNATURE (: "not sure yet if 1 or 3 is best — vibe-code it"). The
// signature is the ordered (type+subtype) mix of a floor. Floors with the SAME mix collapse to ONE signature →
// a single shared layout (the typical repeating tower = one layout for floors 3–40). Floors that genuinely
// differ get their own. This keeps BOTH "per distinct floor shape" and "effectively per-floor" reachable
// WITHOUT a model rewrite — we pick the feel later. Pure + plain-JSON (the Pack stays serializable).

import type { Unit } from "./pack";
import type { DoorSeed } from "./subdivide";

/** One saved floor arrangement. `offsets` = per-unit along-axis shift in METRES (added to the auto pin). */
export interface FloorLayout {
  /** unitId -> along-axis offset in metres (+ = toward the far end of the corridor axis). */
  offsets: Record<string, number>;
  /** RESERVED (unbuilt, the #2 escape hatch): unitId -> a manual width override in metres. */
  widthOverrides?: Record<string, number>;
  /** free room for other per-floor metadata (a label, a note) — a real layout artifact, not just ordering. */
  meta?: Record<string, unknown>;
}

/** The pack-level store: floor signature -> its saved layout. Optional on Pack (back-compat; old packs = none). */
export type FloorLayouts = Record<string, FloorLayout>;

/**
 * A stable key for a floor's ARRANGEMENT: the ordered list of its cells as `type:subtype`. Two floors with the
 * same unit mix in the same order share a signature (→ share one layout). Pure, deterministic, plain string.
 * Order matters (it IS the arrangement), so we DON'T sort — we take the units in their given (unit-number) order.
 */
export function floorSignature(units: Unit[]): string {
  return units
    .slice()
    .sort((a, b) => (a.unitNumber ?? 0) - (b.unitNumber ?? 0) || a.id.localeCompare(b.id))
    .map((u) => `${u.type}:${(u.subtype || "").trim().toLowerCase()}`)
    .join("|");
}

/** Read a floor's layout from the store (or undefined). Convenience over the signature lookup. */
export function layoutForFloor(layouts: FloorLayouts | undefined, units: Unit[]): FloorLayout | undefined {
  if (!layouts) return undefined;
  return layouts[floorSignature(units)];
}

/** An empty layout (no overrides) — the starting point before the user nudges anything. PURE. */
export function emptyLayout(): FloorLayout {
  return { offsets: {} };
}

/**
 * Apply a saved layout to the engine seeds: shift each seed's pin ALONG the corridor axis by the unit's saved
 * offset. The axis is the plate's LONG axis (same rule subdivideFloor uses). Offsets are in metres; we clamp the
 * resulting pin into the plate so a nudge can't push a unit off the plate. Width is untouched (stays ∝ target m²
 * in the engine). Returns NEW seeds — pure. Unknown unit ids in the layout are ignored (mix changed under it).
 */
export function applyLayoutToSeeds(
  seeds: DoorSeed[],
  layout: FloorLayout | undefined,
  plate: { x: number; y: number; w: number; h: number },
): DoorSeed[] {
  if (!layout || !layout.offsets) return seeds;
  const horizontal = plate.w >= plate.h;
  return seeds.map((s) => {
    const off = s.id != null ? layout.offsets[s.id] : undefined;
    if (!off) return s;
    if (horizontal) {
      const x = Math.min(plate.x + plate.w, Math.max(plate.x, s.pin.x + off));
      return { ...s, pin: { ...s.pin, x } };
    }
    const y = Math.min(plate.y + plate.h, Math.max(plate.y, s.pin.y + off));
    return { ...s, pin: { ...s.pin, y } };
  });
}

/**
 * Set one unit's offset in a layout, returning a NEW FloorLayouts store (immutable). `signature` keys the floor;
 * a 0 offset is pruned (keeps the store clean / an unnudged floor absent). PURE — the UI calls this on each nudge.
 */
export function setUnitOffset(
  layouts: FloorLayouts | undefined,
  signature: string,
  unitId: string,
  offsetM: number,
): FloorLayouts {
  const next: FloorLayouts = { ...(layouts || {}) };
  const cur = next[signature] || emptyLayout();
  const offsets = { ...cur.offsets };
  if (Math.abs(offsetM) < 1e-6) delete offsets[unitId];
  else offsets[unitId] = Math.round(offsetM * 1e3) / 1e3;
  next[signature] = { ...cur, offsets };
  return next;
}

/** Clear a whole floor's layout (the per-floor "reset"), returning a NEW store. PURE. */
export function clearFloorLayout(layouts: FloorLayouts | undefined, signature: string): FloorLayouts {
  if (!layouts || !layouts[signature]) return layouts || {};
  const next = { ...layouts };
  delete next[signature];
  return next;
}
