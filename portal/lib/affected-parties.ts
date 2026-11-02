// AFFECTED PARTIES — SERVER-ONLY. The buyer-INCLUSIVE change-notice audience for a change to an on-contract
// a change on a live contract notifies EVERY affected party — agencies AND the buyers with live/paying deals —
// not just the subscribed agencies. Until now the catalog change-notice reached only agencies
// (lib/catalog-edit-gate.resolveNoticeParties, §3). This unions that with the BUYERS (and agents) who have
// a live deal on the building.
// We do NOT build a new buyer resolver. lib/halt-affected.resolveHaltAffected already answers the exact same
// question for the halt path — "this building changed, who relied on it, including buyers" — and returns
// `existingParties` (every agent + their agency + the buyer ref on a confirmed sale / live booking / open
// negotiation). A change notice is the same shape of fact as a halt notice, so changeNoticeParties simply
// unions:
// • resolveNoticeParties(dev, building) — the subscribed AGENCIES (the agreement-is-subscription model).
// • resolveHaltAffected(dev, building).existingParties — the live-deal AGENTS + AGENCIES + BUYER refs.
// Deduped, lowercased. The developer is always present (resolveNoticeParties adds them).
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────
// Returns opaque account / buyer REFERENCE strings only (the buyerRef is the off-seal display id, never a
// resolved identity — the consumer that may show a buyer applies the mask. No PII, nothing on-chain.
// Pure read over the agreement + offer stores.

import { resolveNoticeParties } from "./catalog-edit-gate";
import { resolveHaltAffected } from "./halt-affected";

const lc = (s: string) => s.trim().toLowerCase();

/**
 * The full set of accounts a change on `building` (owned by `developer`) must notify: the subscribed agencies
 * UNION the live-deal parties (agents + agencies + buyer refs). Deduped, lowercased, developer included. Both
 * halves are scoped to the one developer's inventory, so there is no cross-developer leak. A building with no
 * subscribers and no live deals returns just the developer (its own feed) — never empty for a real developer.
 *
 * Best-effort over two stores; a failure in either half must not drop the other, so each is guarded and the
 * union is whatever resolved. (A change notice reaching SOME affected parties beats reaching none.)
 */
export async function changeNoticeParties(developer: string, building: string): Promise<string[]> {
  const dev = lc(developer);
  const out = new Set<string>();
  if (dev) out.add(dev);
  if (!dev || !building.trim()) return [...out];

  // Subscribed agencies ( §3 audience) — the existing agency-only notice set.
  try {
    for (const a of await resolveNoticeParties(dev, building)) {
      const v = lc(a);
      if (v) out.add(v);
    }
  } catch {
    /* keep whatever the other half resolves */
  }

  // Live-deal parties INCLUDING BUYERS — the reuse of the halt affected-set resolver.
  try {
    const affected = await resolveHaltAffected(dev, building);
    for (const p of affected.existingParties) {
      const v = lc(p);
      if (v) out.add(v);
    }
  } catch {
    /* keep whatever the other half resolves */
  }

  return [...out];
}
