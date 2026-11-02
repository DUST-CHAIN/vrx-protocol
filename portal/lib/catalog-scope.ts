// SERVER-ONLY — the caller-scope resolver for the TIER-3 (full-detail) off-chain catalog reads
// (Security Pass #3). It answers one question for the leaky reads (summary / catalog?building /
// held / status): "which buildingIds is THIS caller entitled to see in full detail?"
// WHY (the gap named): the chain is safe by construction (opaque hashes), but the plaintext
// catalog — names, exact prices, availability — lives off-chain and was served to ANY caller. A developer
// (or anyone reaching the API) could GET /api/catalog?building=<rival-id> and read a rival's units and
// prices. Tier-1 (buyer projection) and tier-2 (gated-agent /api/agent/developers) were already scoped;
// this closes tier-3 + the shared summary/catalog reads. See the design docs.
// The entitlement, reusing the SAME resolution the agent picker already uses (no new trust model):
// - a DEVELOPER → their own registry buildingIds (lib/developers);
// - a gated AGENCY/AGENT → the buildingIds of developers their agency has an ACTIVE gate to
// (lib/gates developersForAgency + lib/agents agencyOf, write-through — same as
// /api/agent/developers);
// - anyone else → nothing (a non-entitled full-detail read refuses; the tier-1 buyer projection is
// the public surface, served by its own endpoint).
// ⚠️ HONEST CAVEAT: the caller identity is a client-supplied
// `?account=` today, which an attacker can FORGE. So this is a GUARD (kills accidental cross-developer
// leaks + makes the UI honest + readies the seam), NOT a hard cryptographic guarantee. The scoping LOGIC
// here survives the signing arc unchanged — only the identity SOURCE swaps from `?account=` to a
// wallet-signed caller (lib/participant). Do not present this as real security until then.
// GOD-MODE (localnet:3030): deliberately all-seeing — a fenced dev exception, never in prod.

import { getDeveloper } from "./developers";
import { developersForAgency } from "./gates";
import { agencyOf } from "./agents";
import { godModeArmed } from "./dev-signer-fence";

/** The parsed caller account from a request's `?account=` (the interim identity source, F1). Trimmed;
 * null/empty → no caller (an outsider). Never trust this beyond a lookup key — see the header caveat. */
export function callerAccount(req: Request): string | null {
  const v = new URL(req.url).searchParams.get("account")?.trim();
  return v || null;
}

/** The scope verdict for a caller over the full-detail catalog reads.
 * - all=true → god-mode (localnet): see everything. `buildingIds` is empty + unused.
 * - all=false → scoped: `buildingIds` is the EXACT set the caller may read in full detail
 * (may be empty = entitled to nothing). */
export type CatalogScope = {
  all: boolean;
  buildingIds: Set<string>;
};

/** Resolve a caller account → the buildingIds they may read in full detail (own ∪ gated-developers').
 * God-mode short-circuits to all=true. An unknown/absent caller resolves to the empty set (refuse).
 * Case-insensitive on account ids (on-chain ids are lower-cased by convention; be defensive). */
export async function resolveCatalogScope(account: string | null): Promise<CatalogScope> {
  // God-mode (localnet, fenced): see all. This is the only all=true path.
  if (godModeArmed()) return { all: true, buildingIds: new Set() };

  const ids = new Set<string>();
  if (!account) return { all: false, buildingIds: ids };

  // 1) The caller as a DEVELOPER → their own buildings.
  const asDev = await getDeveloper(account).catch(() => null);
  if (asDev) for (const id of asDev.buildingIds) ids.add(id);

  // 2) The caller as an AGENCY (direct) or AGENT (via its agency) → gated developers' buildings.
  // Reuse the picker's write-through resolution so the two surfaces can never diverge.
  const agency = (await agencyOf(account).catch(() => null)) ?? account;
  const gatedDevs = await developersForAgency(agency).catch(() => [] as string[]);
  for (const devAcct of gatedDevs) {
    const dev = await getDeveloper(devAcct).catch(() => null);
    if (dev) for (const id of dev.buildingIds) ids.add(id);
  }

  return { all: false, buildingIds: ids };
}

/** Convenience: may this caller read THIS building in full detail? (god-mode → always true.) */
export function scopeAllows(scope: CatalogScope, buildingId: string): boolean {
  return scope.all || scope.buildingIds.has(buildingId);
}
