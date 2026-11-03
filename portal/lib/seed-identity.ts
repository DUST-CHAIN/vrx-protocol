// SEED IDENTITY — the PURE predicates that recognise the demo-seed's synthetic world, extracted from
// lib/seed-funnel. Zero Node-only deps (no fs/zlib/catalog) so it is safe to import from the server
// INSTRUMENTATION graph. seed-funnel.ts drags a heavy Node-only graph (catalog, zlib, …); the seller
// auto-responder only needs these two string checks, and pulling them via seed-funnel broke the edge trace of
// instrumentation.ts ("Can't resolve 'zlib'" — the same class of bug the instrumentation files warn
// about). Keeping the predicates here, zlib-free, is the proper separation. seed-funnel re-exports them so
// every existing caller is unchanged.

// The legacy synthetic buyer handles the seed created. Single source of truth (seed-funnel re-exports as
// SEEDED_ACCOUNTS / BUYER_ACCOUNTS).
export const SEED_BUYER_ACCOUNTS = [
  "quiet-harbor.testnet",
  "amber-finch.testnet",
  "slate-meadow.testnet",
  "copper-wren.testnet",
  "harbor-lantern.testnet",
  "violet-ridge.testnet",
  "cedar-moth.testnet",
  "ivory-kestrel.testnet",
  "umber-solstice.testnet",
  "pale-cartographer.testnet",
  "russet-anchor.testnet",
  "glass-sparrow.testnet",
] as const;

// All word tokens the synthetic-account generators + the legacy handles draw from (kept in sync with the
// synthAccount pools in seed-funnel).
const SEED_WORD_TOKENS = new Set<string>([
  ...["quiet", "amber", "slate", "copper", "harbor", "violet", "cedar", "ivory", "umber", "pale", "russet", "glass", "jade", "coral", "onyx", "linen", "ember", "frost", "sable", "dune"],
  ...["harbor", "finch", "meadow", "wren", "lantern", "ridge", "moth", "kestrel", "solstice", "atlas", "anchor", "sparrow", "willow", "cove", "spire", "heron", "cipher", "lark", "vale", "reef", "cartographer"],
]);

// The seed's own fictional developer accounts.
const SEED_DEVELOPERS = ["vvv-dev-01.testnet", "vvv-dev-02.testnet", "vvv-dev-03.testnet"];

/** True iff `account` looks like a SEED-created synthetic buyer handle (two word-tokens from the seed pools +
 *  ".testnet"), OR is one of the explicit legacy seeded accounts. Conservative: a non-matching (hand-made/real)
 *  account is NEVER matched — hand-made demo accounts (e.g. highbird.testnet) are preserved. */
export function isSeedAccount(account: string): boolean {
  const a = account.trim().toLowerCase();
  if (!a) return false;
  if ((SEED_BUYER_ACCOUNTS as readonly string[]).includes(a)) return true;
  const m = /^([a-z]+)-([a-z]+)\.testnet$/.exec(a);
  if (!m) return false;
  return SEED_WORD_TOKENS.has(m[1]) && SEED_WORD_TOKENS.has(m[2]);
}

/** True iff `developer` is one of the seed's own fictional developer accounts. */
export function isSeedDeveloper(developer: string | undefined | null): boolean {
  if (!developer) return false;
  return SEED_DEVELOPERS.includes(developer.trim().toLowerCase());
}
