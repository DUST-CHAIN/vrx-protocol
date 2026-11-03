// ENCRYPTED WALLET-KEYED EVIDENCE PACK — the reusable delivery module (D- pt4 / OTS_ARC_PLAN_S383
// "the universal reusable evidence-pack module"). SERVER-ONLY. ONE generic sealed-box encryptor, MANY chokepoint
// consumers (deposit custody · S&P reconciliation · handover · signing · change-governance). The notary-not-bank
// durability half: at every money/consent chokepoint, seal a FULL evidence descriptor (which MAY carry amounts/terms
// — unlike the hash-only OTS anchor) ENCRYPTED to the receiving PARTY's key, so the party HOLDS their own
// independently-openable copy ("encrypted party-held evidence packs", [[vrx-money-privacy-durability-fork]]).
//
// ── HOW IT RELATES TO THE OTS ANCHOR (two complementary legs) ────────────────────────────────────────────────
//   • lib/ots-anchor + lib/escrow/deposit-evidence: anchor the HASH of an event to Bitcoin — a PUBLIC, hash-only
//  "this existed at T" proof that reveals nothing (no amounts, no PII). Already built.
//   • THIS module: seal the FULL content ENCRYPTED to the party so ONLY they can open it, and record `contentHash`
//     (the party's PRIVATE verify key for their decrypted copy). The pack lets the party re-open the real content
//     privately. Together: "a notary that outlives the notary" — the party can prove their copy is intact years
//     later, even if VRX is gone.
//   ⚠ CONTENT-HASH IS NOT AUTOMATICALLY PUBLIC. `contentHash` is the hash of the FULL payload. If that payload
//     carries a LOW-ENTROPY sensitive field (an amount, a plot number), publishing the hash would let it be
//     brute-forced. So a consumer decides what to anchor PUBLICLY: anchor `contentHash` directly ONLY when the
//     payload is already amount/PII-free (e.g. an S&P document seal); otherwise anchor a SEPARATE amount-free
//     descriptor (as lib/escrow/deposit-evidence does). This module never auto-anchors — anchoring is the consumer's
//     explicit call, so the privacy decision lives with the emitter that knows the payload's entropy.
//
// ── THE CRYPTO (reuses the proven kyc-vault-key sealed-box primitive — NOT a new scheme) ──────────────────────
// X25519 ECDH → HKDF-SHA256 → AES-256-GCM, pure Node `crypto` (same construction as lib/kyc-vault-key.ts sealKek/
// openKek, which is the audited in-repo pattern). "Seal to a public key, open with the private key": anyone holding
// the recipient's PUBLIC delivery key can seal a pack TO them; only the recipient's PRIVATE key opens it. An
// ephemeral X25519 keypair per seal gives forward secrecy for the sender side; the recipient key is long-lived.
//
// ── "WALLET-KEYED" — the honest scope line ───────────────────────────────────────────────────────────────────
// The recipient's delivery key is an X25519 (encryption) key. NEAR wallets sign with ed25519; ed25519→X25519
// conversion (crypto_sign_ed25519_pk_to_curve25519) to derive a delivery key straight from a NEAR wallet pubkey is
// a documented FOLLOW-ON (needs the conversion + a UX for the party to prove control). For now a party REGISTERS /
// is issued an X25519 delivery pubkey (exactly as the KYC operator key works today). The module is correct +
// reusable now; the "derive it from the NEAR wallet key" convenience is additive and flagged, never silently assumed.
//
// ── PRIVACY POSTURE ──────────────────────────────────────────────────────────────────────────────────────────
// The CIPHERTEXT may contain real amounts/terms — that's the point (it's party-held, NEVER on a public chain; only
// the recipient can open it). What goes PUBLIC (the OTS anchor) is ONLY the `contentHash`. This module stores the
// sealed blob server-side as a durable copy + exposes it for the party to pull; the server holds ciphertext it
// CANNOT read (it has no recipient private key) — breach-safe by construction. The `ref` is the deal's existing
// neutral UID so a party finds their packs by the booking id ([[vrx-deal-uid-is-requestId]]).

import { promises as fs } from "fs";
import path from "path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "crypto";
import { now as vrxNow } from "./clock";

const DATA_DIR = path.join(process.cwd(), ".data");
function storePath(): string {
  // Env-overridable so a test process uses its OWN isolated file (mirrors ots-anchor's VRX_OTS_STORE; read lazily
  // so a statically-importing test can set it before first use).
  return process.env.VRX_EVIDENCE_STORE || path.join(DATA_DIR, "evidence-packs.json");
}

/** The chokepoint kinds a pack can seal — mirrors the OTS emitter kinds so an anchor + a pack line up by kind. */
export type EvidencePackKind =
  | "deposit_custody"
  | "sp_document"
  | "handover"
  | "signing"
  | "change_governance"
  | "other";

/** The X25519 sealed box — identical shape to kyc-vault-key's SealedKek (the proven primitive). Holds NO plaintext
 *  and NO private key; `ephPub` + `ct` are useless without the recipient's private key. Safe at rest. */
export type SealedBox = {
  /** Recipient X25519 PUBLIC key this was sealed TO (base64 SPKI/DER) — safe at rest; only lets you SEAL. */
  recipientPub: string;
  /** Ephemeral X25519 public key for this seal (base64 SPKI/DER). */
  ephPub: string;
  /** AES-256-GCM of the plaintext under the ECDH-derived key. */
  iv: string; // hex
  tag: string; // hex
  ct: string; // base64
};

/** One stored evidence pack. The server holds the SEALED box (unreadable without the recipient key) + neutral
 *  metadata. `contentHash` is the deterministic hash of the plaintext payload — the PRIVATE value the party re-derives
 *  to prove their opened copy is intact. (It is published to OTS only by a consumer that knows the payload is
 *  amount/PII-free; a sensitive-amount consumer anchors a separate amount-free descriptor instead — see header.) */
export type EvidencePack = {
  packId: string; // deterministic = contentHash (first-writer-wins; re-sealing the same content is idempotent)
  kind: EvidencePackKind;
  ref: string; // the deal's neutral UID (requestId / (buyer,building,unit)) — no PII beyond handles the deal carries
  recipient: string; // a neutral label for the receiving party (an account handle) — who the pack is FOR
  contentHash: string; // sha256 hex of the canonical plaintext — the party's PRIVATE verify digest (NOT auto-public)
  sealed: SealedBox; // the encrypted body (server can't read it)
  createdAt: number;
};

/** Public-safe metadata (no ciphertext, no crypto material) — what a listing surface shows. */
export type EvidencePackMeta = Pick<EvidencePack, "packId" | "kind" | "ref" | "recipient" | "contentHash" | "createdAt">;
export function packMeta(p: EvidencePack): EvidencePackMeta {
  const { packId, kind, ref, recipient, contentHash, createdAt } = p;
  return { packId, kind, ref, recipient, contentHash, createdAt };
}

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

// ── Canonical plaintext + content hash ──────────────────────────────────────────────────────────────────────
/** Stable JSON stringify (sorted keys) so the SAME logical payload always hashes + seals to the same bytes —
 *  the party can re-derive contentHash from their opened copy deterministically. (Mirrors lib/seal's stable form.) */
function canonical(payload: unknown): string {
  // ⚠ The party must later re-derive this EXACT string from their decrypted copy to verify against contentHash. So
  // the payload MUST round-trip through JSON losslessly — a function / circular ref / Date / BigInt would silently
  // coerce or drop, and the party's re-hash would then NOT match. Validate the round-trip up front and throw a clear
  // error (design-pass), rather than let it fail opaquely at party-open time.
  let roundTrip: unknown;
  try {
    roundTrip = JSON.parse(JSON.stringify(payload));
  } catch {
    throw new Error("evidence-pack: payload is not JSON-serializable (no functions/circular refs/BigInt)");
  }
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {} as Record<string, unknown>);
    }
    return v;
  };
  return JSON.stringify(sort(roundTrip)); // sort the CLEAN round-tripped value (not the original — Dates etc. coerced)
}

/** The deterministic content hash (sha256 hex) of a payload — the party's VERIFY key for their decrypted copy.
 *  UNSALTED on purpose: both the sealing server AND the party (from the opened plaintext) must reach the SAME hash so
 *  the party can confirm their copy is intact. ⚠ This is the hash of the FULL payload (which MAY carry an amount), so
 *  it is a PRIVATE verification value — it is NEVER published to the public OTS anchor (that would let the amount be
 *  brute-forced). The public existence proof is a SEPARATE amount-free descriptor hash (see deposit-evidence). */
export function evidenceContentHash(payload: unknown): string {
  return createHash("sha256").update(canonical(payload), "utf8").digest("hex");
}

// ── The X25519 sealed box (seal to a public key, open with the private key) — same as kyc-vault-key ───────────
function deriveWrapKey(shared: Buffer, ephPubDer: Buffer, recipientPubDer: Buffer): Buffer {
  const salt = Buffer.concat([ephPubDer, recipientPubDer]);
  const out = hkdfSync("sha256", shared, salt, Buffer.from("vrx-evidence-pack-seal/v1"), 32);
  return Buffer.from(out);
}

/** Parse a base64 X25519 PUBLIC key (SPKI/DER) into a KeyObject. Throws on garbage. */
export function parseDeliveryPublicKey(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(clean(b64), "base64"), type: "spki", format: "der" });
}
/** Parse a base64 X25519 PRIVATE key (PKCS8/DER) into a KeyObject. Throws on garbage. */
export function parseDeliveryPrivateKey(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(clean(b64), "base64"), type: "pkcs8", format: "der" });
}

/** Generate a fresh X25519 delivery keypair (base64). A party is issued / registers one; the PRIVATE key is theirs
 *  to keep (the server never needs it — it only ever SEALS). Mirrors kyc-vault-key.provisionOperatorKey. */
export function generateDeliveryKeypair(): { publicKeyB64: string; privateKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKeyB64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
    privateKeyB64: (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"),
  };
}

/** Seal plaintext bytes to a recipient X25519 public key. Pure crypto, no store. */
function sealTo(plain: Buffer, recipientPub: KeyObject): SealedBox {
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const ephPubDer = eph.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const recipientPubDer = recipientPub.export({ type: "spki", format: "der" }) as Buffer;
  const wrapKey = deriveWrapKey(shared, ephPubDer, recipientPubDer);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    recipientPub: recipientPubDer.toString("base64"),
    ephPub: ephPubDer.toString("base64"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ct: ct.toString("base64"),
  };
}

/** Open a sealed box with the recipient PRIVATE key. Throws if the key is wrong / blob tampered (GCM auth fail). */
function openWith(sealed: SealedBox, recipientPriv: KeyObject): Buffer {
  const ephPub = createPublicKey({ key: Buffer.from(sealed.ephPub, "base64"), type: "spki", format: "der" });
  const shared = diffieHellman({ privateKey: recipientPriv, publicKey: ephPub });
  const ephPubDer = Buffer.from(sealed.ephPub, "base64");
  const recipientPubDer = Buffer.from(sealed.recipientPub, "base64");
  const wrapKey = deriveWrapKey(shared, ephPubDer, recipientPubDer);
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(sealed.iv, "hex"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
}

// ── Store IO (serialized via a promise chain — the shared .data lost-write guard) ─────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: EvidencePack[]) => { next: EvidencePack[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}
async function readAll(): Promise<EvidencePack[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(), "utf8"));
    return Array.isArray(parsed) ? (parsed as EvidencePack[]) : [];
  } catch {
    return [];
  }
}
async function writeAll(list: EvidencePack[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(list, null, 2), "utf8");
}

// ── Public API ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Seal a FULL evidence payload ENCRYPTED to the recipient's delivery public key, store the sealed box server-side,
 * and return the pack + its `contentHash` (the party's PRIVATE verify digest — the CONSUMER decides whether to anchor
 * it publicly or anchor a separate amount-free descriptor; see the header privacy note). The server stores ciphertext
 * it CANNOT read.
 * IDEMPOTENT on the content: `packId` = `contentHash`, so re-sealing the same payload for the same recipient returns
 * the existing pack (first-writer-wins) — a replay doesn't pile up packs. (Re-sealing produces a fresh ephemeral
 * box each call; we keep the FIRST stored box, whose contentHash is identical, so the party's copy is stable.)
 * ⚠ The `ref` is NOT part of the idempotency key — the same content sealed to the same recipient is ONE pack even if
 * refs differ. Callers must ensure the payload is distinct per deal (the deposit consumer includes dealRef+event+at,
 * so two deals never collide); a careless caller reusing identical content across deals would get one shared pack.
 *
 * Throws only on a genuinely malformed recipient key (so a caller can surface "register a delivery key first"); a
 * caller on a hot path should wrap this fire-and-forget (the sealing is local + fast, but treat like the anchor:
 * the in-system record is already final; the pack is added durable assurance).
 */
export async function sealEvidencePack(args: {
  kind: EvidencePackKind;
  ref: string;
  recipient: string;
  recipientDeliveryPubB64: string;
  payload: unknown;
  now?: number;
}): Promise<EvidencePack> {
  const kind = args.kind;
  const ref = clean(args.ref);
  const recipient = clean(args.recipient);
  const recipientPub = parseDeliveryPublicKey(args.recipientDeliveryPubB64); // throws on garbage → caller maps to 400
  const plain = Buffer.from(canonical(args.payload), "utf8");
  const contentHash = createHash("sha256").update(plain).digest("hex");
  const now = args.now ?? vrxNow();

  return mutate<EvidencePack>((list) => {
    const existing = list.find((p) => p.packId === contentHash && p.recipient === recipient);
    if (existing) return { next: list, ret: existing }; // idempotent — the party already holds this exact pack
    const sealed = sealTo(plain, recipientPub);
    const pack: EvidencePack = { packId: contentHash, kind, ref, recipient, contentHash, sealed, createdAt: now };
    return { next: [...list, pack], ret: pack };
  });
}

/** Open a stored pack with the recipient's PRIVATE delivery key, returning the decrypted payload (parsed JSON) +
 *  a `verified` flag asserting the opened plaintext hashes back to the stored contentHash (tamper check). Throws if
 *  the key can't open the box (wrong recipient / tampered ciphertext → GCM auth failure). SERVER-ONLY (the private
 *  key is presented out-of-band; it is never stored). */
export async function openEvidencePack(
  packId: string,
  recipientPrivB64: string
): Promise<{ payload: unknown; verified: boolean } | null> {
  const pack = (await readAll()).find((p) => p.packId === clean(packId));
  if (!pack) return null;
  const priv = parseDeliveryPrivateKey(recipientPrivB64); // throws on garbage
  const plain = openWith(pack.sealed, priv); // throws on wrong key / tampered box
  const reHash = createHash("sha256").update(plain).digest("hex");
  let payload: unknown;
  try {
    payload = JSON.parse(plain.toString("utf8"));
  } catch {
    payload = plain.toString("utf8");
  }
  return { payload, verified: reHash === pack.contentHash };
}

/** All packs for a deal ref (newest first), metadata only (no ciphertext) — a party-facing listing surface. */
export async function evidencePacksForRef(ref: string): Promise<EvidencePackMeta[]> {
  const r = clean(ref);
  if (!r) return [];
  return (await readAll())
    .filter((p) => p.ref === r)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(packMeta);
}

/** All packs addressed to a recipient (newest first), metadata only. */
export async function evidencePacksForRecipient(recipient: string): Promise<EvidencePackMeta[]> {
  const who = clean(recipient);
  if (!who) return [];
  return (await readAll())
    .filter((p) => p.recipient === who)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(packMeta);
}

/** Test/teardown helper. */
export async function __resetForTests(): Promise<void> {
  await chain.catch(() => {});
  await mutate(() => ({ next: [], ret: null }));
}
