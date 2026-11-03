// Floor-plan SEED generators — the three input modes (the design docs step 3). All three
// modes feed the SAME pure engine (subdivide.subdivideFloor); they differ ONLY in how the DoorSeed[] is produced:
//   - Mode C (door-pins): the human drops one pin per unit — no generator, the pins ARE the seeds (the UI step).
//   - Mode B (sliders):   seedsFromSliders — #units · which side(s) · corridor width → evenly spaced door pins.
//   - Mode A (AI):         seedsFromAi — a unit mix (type/variation/target m²) → pins laid along the plate, sized.
// Pure (plate in metres → DoorSeed[]); no engine coupling beyond the DoorSeed shape. Testable standalone.

import type { DoorSeed } from "./subdivide";

/** The floor plate (metres) seeds are laid onto — the bounding box the engine also works in. */
export interface Plate { x: number; y: number; w: number; h: number }

/** Where units sit relative to the corridor. "both" = double-loaded (two bands); "near"/"far" = single-loaded. */
export type LoadSide = "near" | "far" | "both";

// ── Mode B — sliders ────────────────────────────────────────────────────────

export interface SliderSpec {
  units: number;            // how many units on this floor
  side: LoadSide;           // near | far | both (double-loaded)
  corridorWidthM: number;   // the spine width (passed through to the engine separately)
  targetSqmEach?: number;   // optional uniform target area; absent → the engine splits equally
}

/**
 * Lay `units` door pins evenly along the plate's LONG axis, on the chosen side(s) of where the corridor will be.
 * Double-loaded ("both") alternates pins top/bottom so the engine builds two bands. Pins sit at the band centre
 * depth (the engine only uses the ACROSS coordinate to decide which band, and the ALONG coordinate to order).
 */
export function seedsFromSliders(plate: Plate, spec: SliderSpec): DoorSeed[] {
  const n = Math.max(0, Math.floor(spec.units));
  if (n === 0) return [];
  const horizontal = plate.w >= plate.h;
  const axisLen = horizontal ? plate.w : plate.h;   // along the corridor
  const crossLen = horizontal ? plate.h : plate.w;  // across
  const seeds: DoorSeed[] = [];

  // cross-depth for a pin on the near side (upper quarter) vs far side (lower quarter)
  const nearCross = crossLen * 0.25;
  const farCross = crossLen * 0.75;

  for (let i = 0; i < n; i++) {
    const alongFrac = (i + 0.5) / n;          // evenly spaced along the axis
    const along = alongFrac * axisLen;
    let cross: number;
    if (spec.side === "both") cross = i % 2 === 0 ? nearCross : farCross;
    else if (spec.side === "far") cross = farCross;
    else cross = nearCross;
    const pin = horizontal
      ? { x: plate.x + along, y: plate.y + cross }
      : { x: plate.x + cross, y: plate.y + along };
    seeds.push({ pin, targetSqm: spec.targetSqmEach, id: `u${i + 1}` });
  }
  return seeds;
}

// ── Mode A — AI / unit-mix ────────────────────────────────────────────────────

/** One unit the AI (or the generator's unit mix) wants on this floor. */
export interface MixUnit {
  typeKey: string;          // studio|1br|2br …
  variationKey?: string;    // a|b|c …
  targetSqm: number;        // the unit's area
  side?: LoadSide;          // optional per-unit side; default alternates for a double-loaded look
  id?: string;
}

/**
 * Turn a unit MIX into door pins laid along the plate, each carrying its type/variation/target m². Pins are
 * ordered as given and spaced by their RELATIVE target area (a bigger unit gets more axis room → its pin sits
 * at the centre of its share), so the engine's area-proportional slicing lines up with the pin order. Side:
 * per-unit `side` wins; else alternate near/far so a mixed floor reads double-loaded.
 */
export function seedsFromAi(plate: Plate, mix: MixUnit[]): DoorSeed[] {
  const items = mix.filter((m) => m && m.typeKey);
  if (items.length === 0) return [];
  const horizontal = plate.w >= plate.h;
  const axisLen = horizontal ? plate.w : plate.h;
  const crossLen = horizontal ? plate.h : plate.w;
  const nearCross = crossLen * 0.25;
  const farCross = crossLen * 0.75;

  const totalSqm = items.reduce((a, m) => a + Math.max(1, m.targetSqm), 0);
  const seeds: DoorSeed[] = [];
  let acc = 0; // accumulated axis fraction
  items.forEach((m, i) => {
    const share = Math.max(1, m.targetSqm) / totalSqm;
    const centreFrac = acc + share / 2;
    acc += share;
    const along = centreFrac * axisLen;
    const side: LoadSide = m.side ?? (i % 2 === 0 ? "near" : "far");
    const cross = side === "far" ? farCross : side === "both" ? crossLen / 2 : nearCross;
    const pin = horizontal
      ? { x: plate.x + along, y: plate.y + cross }
      : { x: plate.x + cross, y: plate.y + along };
    seeds.push({
      pin,
      targetSqm: m.targetSqm,
      typeKey: m.typeKey,
      variationKey: m.variationKey,
      id: m.id ?? `${m.typeKey}-${i + 1}`,
    });
  });
  return seeds;
}
