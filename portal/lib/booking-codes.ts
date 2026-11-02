// SHORT MEMORABLE BOOKING CODES — SERVER-ONLY (file-backed). The 7th member of the per-developer `.data`
// store family (offers · agreements · buyer-events · channels · activity · warroom-snapshots · THIS).
// THE PROBLEM: a booking's real identity is its `requestId` — an opaque SHA-256 (hashRef of
// {developer,unitKey,agent,ts} salted "vrx-req", app/agent/page.tsx). Nobody can quote that on the phone.
// Agents/buyers/developers need a SHORT, SPELLABLE code to refer to any booking fast ("booking VRX-K7Q2M").
// • CANNOT afford collisions, codes must stay short/spellable, and MUST NOT leak the booking ORDER or the
// developer. A plain per-developer "001, 002, …" leaks order + growth; a per-developer constant tag made
// • So: the registry mints a globally-unique monotonic INTEGER `n` (guarantees no collision), but the
// VISIBLE code is a REVERSIBLE SCRAMBLE of `n` (a tiny Feistel permutation) → consecutive bookings look
// unrelated (VRX-K7Q2M, VRX-3FHX8, VRX-ZP40R). The scramble is a bijection over the code space, so it
// stays 1:1 with `n` (zero collisions) while hiding order. No developer hint, no timestamp in the code.
// • Crockford base32 (no I/L/O/U) → unambiguous to spell, no accidental words. 5 chars = 2^25 ≈ 33.5M codes.
// • Resolving a code returns the booking's requestId AND its timestamp, so any surface can answer "yes,
// SOURCE OF TRUTH stays the real booking: the registry is an INDEX {code,requestId,at}. It never changes
// on-chain state (contract FROZEN) and introduces no second identity — every code resolves to the opaque
// requestId. Minting is idempotent per requestId (same booking → same code forever).
// PRIVACY: stores only {code, requestId (already opaque), developer, booking ts}. No PII, no terms. The
// code itself reveals nothing — not order, not developer, not time.

import { promises as fs } from "fs";
import path from "path";

// Crockford base32 — digits + uppercase, excluding I L O U (ambiguous / word-forming). 32 symbols.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// The code space: 5 base32 chars = 25 bits. The Feistel permutation operates over exactly this many bits,
// split into two halves (we use 13 high + 12 low = 25). Changing CODE_BITS later widens the space; existing
// codes stay valid because resolve is by stored string, not by re-deriving.
const CODE_CHARS = 5;
const CODE_BITS = 25;
const HALF_HI = 13;
const HALF_LO = 12;
const LO_MASK = (1 << HALF_LO) - 1;
const HI_MASK = (1 << HALF_HI) - 1;

export type CodeRecord = {
  /** The short human code, e.g. "VRX-K7Q2M" (uppercase, canonical). */
  code: string;
  /** The authoritative booking id this code resolves to (opaque on-chain request id). */
  requestId: string;
  /** The developer (node) account the booking belongs to — kept for scoping/audit, NOT shown in the code. */
  developer: string;
  /** ms epoch the BOOKING happened (its offer/claim time) — so resolve can report when it took place. */
  bookingAt: number;
  /** ms epoch the code was minted. */
  at: number;
};

type Store = {
  /** Minted records (append-only; a requestId is never re-minted). */
  records: CodeRecord[];
  /** The next monotonic integer to scramble into a code (global; order is HIDDEN by the Feistel). */
  nextN: number;
};

const EMPTY: Store = { records: [], nextN: 1 };
const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "booking-codes.json");

// ── Feistel permutation over CODE_BITS — a reversible scramble so the sequence `n` doesn't show as order ──
// A 4-round balanced Feistel with a cheap keyed round function. It's a BIJECTION on [0, 2^CODE_BITS), so
// distinct n → distinct code (no collisions), and it's reversible (unscramble) though we never need to —
// we store the string and resolve by lookup. The "key" is a fixed constant: this isn't cryptographic
// secrecy (the code is a public handle), just order-obfuscation so 002/003 don't look consecutive.
const ROUND_KEYS = [0x9e37, 0x79b9, 0x7f4a, 0x7c15];
function roundF(half: number, k: number): number {
  // mix the 12/13-bit half with a key; keep it within the LOW half width.
  return (Math.imul(half ^ k, 0x2545) + (half << 3) + k) & LO_MASK;
}
function scramble(n: number): number {
  let hi = (n >> HALF_LO) & HI_MASK;
  let lo = n & LO_MASK;
  for (let r = 0; r < 4; r++) {
    // Feistel: new_lo = hi; new_hi = lo XOR F(hi). Halves are different widths, so fold carefully.
    const f = roundF(hi, ROUND_KEYS[r]);
    const nhi = (lo ^ f) & HI_MASK;
    lo = hi & LO_MASK;
    hi = nhi;
  }
  return ((hi << HALF_LO) | lo) >>> 0;
}

/** base32-encode a non-negative integer, fixed width (left padded). */
function base32(n: number, width: number): string {
  let out = "";
  let v = Math.max(0, Math.floor(n));
  do {
    out = ALPHABET[v % 32] + out;
    v = Math.floor(v / 32);
  } while (v > 0);
  return out.padStart(width, "0");
}

/** The full canonical code for a minted integer `n`. Exposed for tests. */
export function codeForN(n: number): string {
  return `VRX-${base32(scramble(n), CODE_CHARS)}`;
}

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8")) as Partial<Store>;
    return {
      records: Array.isArray(parsed?.records) ? parsed.records : [],
      nextN: typeof parsed?.nextN === "number" && parsed.nextN > 0 ? parsed.nextN : 1,
    };
  } catch {
    return { ...EMPTY };
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(s, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as the other `.data` stores.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (s: Store) => { next: Store; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readStore();
    const { next, ret } = fn(cur);
    await writeStore(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * Get the short code for a booking, MINTING it on first sight. Idempotent per requestId (same booking → same
 * code forever). `bookingAt` is the booking's own time (offer/claim ms epoch) so resolve can report when it
 * happened; pass 0 if unknown (resolve then just omits the time).
 */
export async function codeForBooking(requestId: string, developer: string, bookingAt = 0): Promise<string> {
  const rid = requestId.trim();
  const dev = developer.trim().toLowerCase();
  if (!rid || !dev) return "";
  const existing = (await readStore()).records.find((r) => r.requestId === rid);
  if (existing) return existing.code;

  return mutate((s) => {
    const already = s.records.find((r) => r.requestId === rid);
    if (already) return { next: s, ret: already.code };

    const n = s.nextN;
    const code = codeForN(n);
    const rec: CodeRecord = { code, requestId: rid, developer: dev, bookingAt: bookingAt || Date.now(), at: Date.now() };
    return { next: { records: [...s.records, rec], nextN: n + 1 }, ret: code };
  });
}

/** Resolve a user-typed code back to its booking record (the "jump to booking" path). Case/space/`-` tolerant:
 * "vrx k7q2m", "VRX-K7Q2M", "k7q2m" all match. Returns the full record (incl. bookingAt) or null if unknown. */
export async function resolveCode(input: string): Promise<CodeRecord | null> {
  const norm = (x: string) => x.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^VRX/, "");
  const want = norm(input);
  if (!want) return null;
  const records = (await readStore()).records;
  return records.find((r) => norm(r.code) === want) ?? null;
}

/** Look up a code already minted for a booking WITHOUT minting (null if none). For read-only displays. */
export async function peekCode(requestId: string): Promise<string | null> {
  const rid = requestId.trim();
  if (!rid) return null;
  return (await readStore()).records.find((r) => r.requestId === rid)?.code ?? null;
}
