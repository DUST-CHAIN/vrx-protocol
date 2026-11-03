// EVIDENCE DELIVERY-KEY REGISTRY (the dependency lib/evidence-pack.ts flagged). SERVER-ONLY (file-backed).
// A party that wants to HOLD its own encrypted evidence packs must have an X25519 DELIVERY public key on file. This
// is the tiny registry that stores "account → X25519 delivery pubkey (base64 SPKI/DER)", so the pack-sealing path
// (lib/escrow/deposit-evidence.sealDepositEvidencePack) can look up a recipient's key and seal TO it. The PRIVATE
// key is the party's own — the server NEVER sees it (it only ever SEALS, never opens; mirrors kyc-vault-key, where
// the operator private key stays offline).
//
// ── WHY A REGISTRY (vs deriving from the NEAR wallet key) ─────────────────────────────────────────────────────
// The honest scope line from evidence-pack.ts: the ideal is to DERIVE the X25519 delivery key straight from the
// party's NEAR ed25519 wallet key (crypto_sign_ed25519_pk_to_curve25519) so there's nothing to register. That needs
// the conversion + a UX for the party to prove wallet control; it's the flagged FOLLOW-ON. For now a party REGISTERS
// (or is issued) an X25519 delivery pubkey — exactly how the KYC operator key works today. This registry is correct +
// reusable now; the wallet-derive convenience slots in later behind the SAME lookup (resolveDeliveryKey), so wiring
// built on this interface doesn't change when the derive path lands.
//
// ── PRIVACY ─────────────────────────────────────────────────────────────────────────────────────────────
// The stored value is a PUBLIC key (safe at rest — it only lets you SEAL to the party, never open their packs) + the
// account HANDLE (public in-system) + a timestamp. No PII, no private key. A party ROTATES by registering a new key;
// we keep prior keys archived so packs sealed to an OLD key stay openable by the party's old private key (the party
// decides which private key opens which pack — the registry never needs to know).
//
// ── INERT UNTIL USED ─────────────────────────────────────────────────────────────────────────────────────────
// No key registered ⇒ resolveDeliveryKey returns null ⇒ sealDepositEvidencePack is a NO-OP (the hash-only OTS anchor
// leg still stands). So wiring the pack seal at every custody transition is SAFE to ship with an empty registry: it
// does nothing until a party opts in by registering a delivery key. Additive, reversible, zero behavioural change.

import { promises as fs } from "fs";
import path from "path";
import { parseDeliveryPublicKey } from "./evidence-pack";
import { now as vrxNow } from "./clock";

const DATA_DIR = path.join(process.cwd(), ".data");
function storePath(): string {
  // Env-overridable for test isolation (mirrors the other .data stores; read lazily so a static-import test can set it).
  return process.env.VRX_DELIVERY_KEY_STORE || path.join(DATA_DIR, "evidence-delivery-keys.json");
}

/** One account's current + archived delivery keys. `current` is what new packs seal to; `archived` keeps prior keys
 *  so packs sealed before a rotation remain openable (by the party's matching old private key). */
export type DeliveryKeyRecord = {
  account: string;
  current: string; // base64 X25519 SPKI/DER public key — safe at rest (seal-only)
  archived: string[]; // prior public keys, newest-first (rotation history)
  updatedAt: number;
};

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

// ── Serialized writes (the shared .data lost-write guard) ─────────────────────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: DeliveryKeyRecord[]) => { next: DeliveryKeyRecord[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}
async function readAll(): Promise<DeliveryKeyRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(), "utf8"));
    return Array.isArray(parsed) ? (parsed as DeliveryKeyRecord[]) : [];
  } catch {
    return [];
  }
}
async function writeAll(list: DeliveryKeyRecord[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(list, null, 2), "utf8");
}

/**
 * REGISTER (or ROTATE) an account's X25519 delivery public key. Validates the key parses as a real X25519 SPKI/DER
 * public key (throws on garbage → the route maps to 400) BEFORE storing, so a bad key can never poison the seal path.
 * Rotation: a new key moves the prior `current` into `archived` (newest-first), so packs sealed to the old key stay
 * openable. Idempotent: registering the SAME current key again is a no-op (no churn, no duplicate archive entry).
 * Returns the stored record. Never silently accepts an unparseable key.
 */
export async function registerDeliveryKey(account: string, publicKeyB64: string, now?: number): Promise<DeliveryKeyRecord> {
  const a = clean(account);
  if (!a) throw new Error("account required");
  const key = clean(publicKeyB64);
  if (!key) throw new Error("delivery public key required");
  parseDeliveryPublicKey(key); // validate — throws on garbage, so we never store an unusable key
  const at = now ?? vrxNow();
  return mutate<DeliveryKeyRecord>((list) => {
    const idx = list.findIndex((r) => r.account === a);
    if (idx < 0) {
      const fresh: DeliveryKeyRecord = { account: a, current: key, archived: [], updatedAt: at };
      return { next: [...list, fresh], ret: fresh };
    }
    const prev = list[idx];
    if (prev.current === key) return { next: list, ret: prev }; // idempotent re-register of the same key
    // Rotation: archive the prior current (dedup — don't pile the same old key twice).
    const archived = [prev.current, ...prev.archived.filter((k) => k !== prev.current)];
    const updated: DeliveryKeyRecord = { ...prev, current: key, archived, updatedAt: at };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** Resolve an account's CURRENT delivery public key, or null if none registered. The seal path reads this: null ⇒
 *  no pack is sealed (the hash-only anchor still stands). This is the ONE lookup the pack wiring depends on — when
 *  the wallet-derive follow-on lands, it slots in HERE (try the registry, else derive from the NEAR key) without
 *  changing any caller. */
export async function resolveDeliveryKey(account: string): Promise<string | null> {
  const a = clean(account);
  if (!a) return null;
  const rec = (await readAll()).find((r) => r.account === a);
  return rec?.current || null;
}

/** The full record (current + rotation history) for a party-facing "your delivery key" surface. null if none. */
export async function deliveryKeyRecord(account: string): Promise<DeliveryKeyRecord | null> {
  const a = clean(account);
  if (!a) return null;
  return (await readAll()).find((r) => r.account === a) ?? null;
}

/** Test/teardown helper. */
export async function __resetForTests(): Promise<void> {
  await chain.catch(() => {});
  await mutate(() => ({ next: [], ret: null }));
}
