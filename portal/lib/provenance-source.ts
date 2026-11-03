// PROVENANCE SOURCE — the ONE swappable place that turns a record's on-chain reference into an explorer
// URL. The shared <ProvenanceBadge> reads ONLY this, so demo↔real is a single switch, not an N-screen edit.
//
// WHY swappable ([[vrx-dont-bulk-stamp-until-contract-final]]): a contract redeploy is LIKELY
// still ahead, which would ORPHAN any per-record tx we stamp now. So today, records that don't yet carry a real
// tx hash resolve to a DEMO link (the contract account on the explorer) + a `demo:true` flag → the badge shows
// an honest "sandbox — representative on-chain record" caption. When the contract is FINAL and each on-chain
// write stores its real `tx`, those records pass a real hash here → the badge lights up real with ZERO UI change.
//
// HONESTY (pt5): never render a fabricated tx HASH as if it were a record's real tx. The demo path links to
// the real CONTRACT (which genuinely exists on testnet) and labels itself sandbox — it never invents a hash.
//
// See the design docs for which records are on-chain (real tx) vs off-chain sealed (no tx, never linked).

import { EXPLORER_URL, CONTRACT_ID } from "./config";

export type ProvenanceLink = {
  /** The explorer URL to open. */
  url: string;
  /** True when this is the representative/contract link (no real per-record tx yet) → show the sandbox caption. */
  demo: boolean;
};

/** Is a string a plausible NEAR tx hash (base58-ish, long)? Guards against passing junk/placeholder ids. */
function looksLikeTxHash(h: string): boolean {
  const s = h.trim();
  return s.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

/**
 * Resolve a record's on-chain reference to an explorer link.
 *  • Given a REAL tx hash → a direct transaction link (demo:false).
 *  • Given nothing (the common case today) → the CONTRACT account link + demo:true (honest sandbox receipt).
 * The caller (ProvenanceBadge) uses `demo` to choose the caption. This is the ONLY function that encodes the
 * demo↔real policy — flip it once when the contract is final and per-record txs exist.
 */
export function provenanceLink(txHash?: string | null): ProvenanceLink {
  const h = (txHash ?? "").trim();
  if (h && looksLikeTxHash(h)) {
    return { url: `${EXPLORER_URL}/transactions/${h}`, demo: false };
  }
  // No real per-record tx yet → point at the real contract account, labelled sandbox.
  return { url: `${EXPLORER_URL}/accounts/${CONTRACT_ID}`, demo: true };
}
