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
