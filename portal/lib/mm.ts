// Building marketing images + renderings — resolved from a BUNDLED manifest, served as static
// /public URLs. Self-contained for deploy (Coolify): images live in portal/public/renderings/, copied
// from the the operator catalog resources\ + mm\ archives by scripts/copy-renderings.mjs. No runtime dependency on the
// the operator catalog machine, no filesystem read per request, no /api/mm route.
//
// INHERITANCE: a building inherits its COMPLEX's shared marketing images (stored once) and adds
// its own building-specific renderings. listImages merges the two. URLs point at the physical folder
// each file lives in (building vs complex).
//
// ORDER FIX: the shared COMPLEX images (MM source, `m_`) are full-res marketing shots (1920×1080),
// while many per-building `resources` renderings (`r_`) are small 242×125 thumbnails. So we lead with the
// full-res complex images (the hero/first image a user sees is the good one) and APPEND the building-
// specific ones after. We also drop known-thumbnail dimensions is NOT possible from the name-only manifest,
// so ordering is the lever here; a later media re-grab can replace the thumbnails at source.
//
// Keeps the old API shape (listImages returns bucketed arrays) so app/api/catalog/route.ts is simple.

import manifest from "./renderings-manifest.json";

type Buckets = { exterior: string[]; interior: string[]; facilities: string[]; floorplans: string[] };
type Entry = Buckets & { complex: string | null };

const M = manifest as unknown as Record<string, Entry> & { __complex: Record<string, Buckets> };
const BUCKETS: (keyof Buckets)[] = ["exterior", "interior", "facilities", "floorplans"];

function urls(dirId: string, bucket: keyof Buckets, files: string[]): string[] {
  return files.map((f) => `/renderings/${dirId}/${bucket}/${f}`);
}

/**
 * Bucketed image URLs for a building = its OWN renderings + the shared images it inherits from its
 * complex. Returns null if neither has any image. Already full /renderings URLs (caller uses as-is).
 */
export async function listImages(buildingId: string): Promise<Buckets | null> {
  const e = M[buildingId];
  if (!e) return null;
  const shared = (e.complex && M.__complex?.[e.complex]) || null;
  const out: Buckets = { exterior: [], interior: [], facilities: [], floorplans: [] };
  for (const b of BUCKETS) {
    out[b] = [
      // Full-res shared complex images first (the hero), then building-specific renderings.
      ...(shared ? urls(e.complex as string, b, shared[b] || []) : []),
      ...urls(buildingId, b, e[b] || []),
    ];
  }
  const total = BUCKETS.reduce((s, b) => s + out[b].length, 0);
  return total ? out : null;
}

/**
 * The single REPRESENTATIVE image for a building — its hero. Exterior first (the building shot a card
 * should lead with), then facilities, then interior; floor plans are never a hero. null if no image.
 * Same priority as the buyer catalog's firstPhoto, kept here so every card surface agrees on "the hero".
 */
export async function heroImage(buildingId: string): Promise<string | null> {
  const imgs = await listImages(buildingId);
  if (!imgs) return null;
  return imgs.exterior[0] ?? imgs.facilities[0] ?? imgs.interior[0] ?? null;
}

/**
 * The hero image for a specific OPENED unit (the ask) — lead an opened-unit card with a unit-relevant
 * INTERIOR shot rather than the repeated building exterior, so two units of the same building don't look
 * identical. We don't have per-subtype art (interiors are building-level, generic: living/kitchen/bedroom/…),
 * so we pick ONE interior DETERMINISTICALLY per unit id — stable across renders (not random), and spread across
 * the bucket so adjacent units differ. Privacy-safe: a generic interior reveals nothing unit-specific (same
 * posture as the exterior hero, which already shows pre-eligibility). Falls back to the exterior hero when a
 * building has no interiors. Null only if the building has no imagery at all.
 */
export async function unitHeroImage(buildingId: string, unitId: string): Promise<string | null> {
  const imgs = await listImages(buildingId);
  if (!imgs) return null;
  const interiors = imgs.interior;
  if (interiors.length > 0) {
    // Stable per-unit index: a small FNV-ish hash of the unit id, modulo the interior count. Deterministic, so
    // a unit always shows the SAME interior (no flicker), and distinct ids spread across the available shots.
    let h = 2166136261;
    for (let i = 0; i < unitId.length; i++) {
      h ^= unitId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = (h >>> 0) % interiors.length;
    return interiors[idx];
  }
  return imgs.exterior[0] ?? imgs.facilities[0] ?? null;
}

/**
 * THE IMAGE-SET SCHEMA (the ask: "define the schemas so any time you reach out to 'images' you know
 * what sets are relevant"). The four buckets, and WHICH of them are applicable to a UNIT's subtype — so every
 * surface that shows "this unit's pictures" agrees on the same relevant set and never leaks another unit's art.
 *
 * Applicability rule (privacy-safe by construction — none of these are unit-specific):
 *   • exterior   — the building shell. Applies to EVERY unit. ✓
 *   • facilities — shared amenities (pool/gym/garden/lobby). Apply to every unit. ✓
 *   • interior   — generic subtype-representative interiors (living/kitchen/bedroom). Building-level, NOT
 * per-unit art (D-) — representative of what a unit of this subtype looks like. ✓
 *   • floorplans — the ONE subtype-specific image. Filtered to THIS unit-type's plan (matched by its
 *                  `floorplan` filename); other subtypes' plans are NOT this unit's. ✓ (filtered)
 *
 * So a unit's gallery = exterior + facilities + interior + (its own subtype floorplan). What it must NEVER
 * include: another unit's specific photos/plan. Callers: the buyer Review overlay carousel; any future
 * "show me this unit" surface reuses THIS, so the relevant-set decision lives in one place.
 */
export const IMAGE_SETS = {
  /** Buckets shown for a unit, in display order (hero-first). `floorplans` is handled specially (subtype-filtered). */
  unitApplicable: ["exterior", "facilities", "interior"] as (keyof Buckets)[],
} as const;

/**
 * The ordered image gallery for a specific unit SUBTYPE, honouring IMAGE_SETS: building exterior(s) → facilities
 * → representative interiors → the unit-type's own floorplan (if `floorplanFile` is given and present). De-duped,
 * order-stable. Returns [] when the building has no imagery. This is the single source for "all images applicable
 * to this unit" — the buyer carousel uses it; a role-sweep / other surfaces should too.
 */
export async function unitGallery(buildingId: string, floorplanFile?: string | null): Promise<string[]> {
  const imgs = await listImages(buildingId);
  if (!imgs) return [];
  const out: string[] = [];
  for (const b of IMAGE_SETS.unitApplicable) out.push(...imgs[b]);
  if (floorplanFile) {
    const fp = imgs.floorplans.find((u) => u.endsWith(`/${floorplanFile}`));
    if (fp) out.push(fp); // the subtype plan last — it's a diagram, not a photo (never a hero)
  }
  return [...new Set(out)];
}
