// KYC-VAULT KEY MODEL — TIER 2: the root KEK is SEALED to an OFFLINE operator keypair; a running
// server is LOCKED until an operator UNSEALS it into memory for the process lifetime. SERVER-ONLY.
// ── Why this module exists ────────────────────────────────────────────────────────────────────────────
// Tier 1 (lib/kyc-vault, as shipped) derived the KEK from an env secret (`VRX_KYC_VAULT_KEY`). That
// defends a DISK breach of `.data`, but the running server always holds the usable KEK → a full server
// compromise reads all KYC. Tier 2 raises that bar: the KEK is encrypted ("sealed") to an operator PUBLIC
// key and stored at rest; unsealing needs the operator PRIVATE key, which lives OFFLINE and is presented
// out-of-band to unlock a session. Boot = LOCKED (decrypt fails). After unlock the KEK lives ONLY in this
// module's memory; a restart/crash re-locks. Envelope encryption means this adds ZERO file re-encryption —
// only the small wrapped DEKs ever reference the KEK, and they're unchanged; we just gate HOW the KEK is
// obtained. (Tier 3 = true client-side E2E,, a separate arc.)
// ── The crypto ────────────────────────────────────────────────────────────────────────────────────────
// Operator keypair = X25519 (Node `crypto` 'x25519'). Sealing the KEK to the operator public key uses an
// ephemeral X25519 key + ECDH → HKDF → AES-256-GCM (a "sealed box"): anyone with the PUBLIC key can seal;
// only the PRIVATE key can open. The sealed KEK blob is stored in `.data/kyc-kek-sealed.json` (safe at rest).
// The operator PUBLIC key is also stored there (safe — it only lets you seal). The PRIVATE key is NEVER
// written by the server; it is handed to the operator ONCE at bootstrap and kept offline.
// ── Unlock sources (precedence) ───────────────────────────────────────────────────────────────────────
// 1. In-RAM already unsealed (a prior /unlock this process) → UNLOCKED
// 2. env `VRX_KYC_OPERATOR_KEY` set (base64 X25519 private key) → auto-unseal at first use (TESTING
// convenience / an explicit prod operator choice; documented as defeating at-rest breach-safety if used
// in prod — the whole point is the key is OFFLINE, so a prod env key is a deliberate trade-off).
// 3. dev deterministic operator key (NODE_ENV !== 'production') → auto-unseal, warns once (zero-setup
// demo; NOT secret — the private key is derived in-source).
// 4. otherwise → LOCKED; operator must POST the key
// to /api/kyc-vault/unlock. This is the real breach-safe production posture.

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

const DATA_DIR = path.join(process.cwd(), ".data");
const SEALED_STORE = path.join(DATA_DIR, "kyc-kek-sealed.json");

/** Thrown when a vault crypto op is attempted while the server is LOCKED (no unsealed KEK in memory). */
export class VaultLockedError extends Error {
  constructor() {
    super("KYC vault is LOCKED — operator must unlock it before documents can be read or written.");
    this.name = "VaultLockedError";
  }
}

/** On-disk sealed-KEK record. Holds NO plaintext KEK and NO private key — only the sealed box + the pubkey. */
type SealedKek = {
  /** X25519 operator PUBLIC key (base64 DER/SPKI) — safe at rest; only lets you SEAL. */
  operatorPub: string;
  /** Ephemeral X25519 public key used for this seal (base64 DER/SPKI). */
  ephPub: string;
  /** AES-256-GCM of the KEK under the ECDH-derived key. */
  iv: string;
  tag: string;
  ct: string;
  /** ms epoch sealed. */
  at: number;
};

// ── In-memory lock state (process lifetime only; never persisted) ───────────────────────────────────────
let unsealedKek: Buffer | null = null;
let warnedDevKey = false;
let warnedEnvKey = false;

// ── X25519 sealed-box (seal to a public key, open with the private key) ─────────────────────────────────

/** Derive a 32-byte AES key from an ECDH shared secret + both public keys (HKDF-SHA256). */
function deriveWrapKey(shared: Buffer, ephPubDer: Buffer, opPubDer: Buffer): Buffer {
  const salt = Buffer.concat([ephPubDer, opPubDer]);
  const out = hkdfSync("sha256", shared, salt, Buffer.from("vrx-kyc-kek-seal/v1"), 32);
  return Buffer.from(out);
}

/** Seal (encrypt) the KEK to an operator public key. Anyone with the public key can do this. */
function sealKek(kek: Buffer, operatorPub: KeyObject): SealedKek {
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: operatorPub });
  const ephPubDer = eph.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const opPubDer = operatorPub.export({ type: "spki", format: "der" }) as Buffer;
  const wrapKey = deriveWrapKey(shared, ephPubDer, opPubDer);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, iv);
  const ct = Buffer.concat([cipher.update(kek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    operatorPub: opPubDer.toString("base64"),
    ephPub: ephPubDer.toString("base64"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ct: ct.toString("base64"),
    at: Date.now(),
  };
}

/** Open (decrypt) a sealed KEK with the operator PRIVATE key. Throws if the key is wrong / blob tampered. */
function openKek(sealed: SealedKek, operatorPriv: KeyObject): Buffer {
  const ephPub = createPublicKey({ key: Buffer.from(sealed.ephPub, "base64"), type: "spki", format: "der" });
  const shared = diffieHellman({ privateKey: operatorPriv, publicKey: ephPub });
  const ephPubDer = Buffer.from(sealed.ephPub, "base64");
  const opPubDer = Buffer.from(sealed.operatorPub, "base64");
  const wrapKey = deriveWrapKey(shared, ephPubDer, opPubDer);
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(sealed.iv, "hex"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
}

// ── Operator key parsing ────────────────────────────────────────────────────────────────────────────────

/** Parse a base64 X25519 PRIVATE key (DER/PKCS8) into a KeyObject. Throws on garbage. */
export function parseOperatorPrivate(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64.trim(), "base64"), type: "pkcs8", format: "der" });
}

/** The deterministic DEV operator private key (NOT secret — derived in-source). Dev/demo only. */
function devOperatorKeyPair(): { priv: KeyObject; pub: KeyObject } {
  // Derive a stable X25519 keypair from a fixed seed so the demo decrypts across restarts without setup.
  // X25519 PKCS8 DER = a fixed 16-byte prefix + 32 raw private scalar bytes. We splice a deterministic scalar.
  const scalar = createHash("sha256").update("vrx-kyc-dev-operator-key-do-not-use-in-prod").digest(); // 32 bytes
  const pkcs8Prefix = Buffer.from("302e020100300506032b656e04220420", "hex"); // X25519 PKCS8 header
  const der = Buffer.concat([pkcs8Prefix, scalar]);
  const priv = createPrivateKey({ key: der, type: "pkcs8", format: "der" });
  const pub = createPublicKey(priv);
  return { priv, pub };
}

// ── Sealed-store IO ─────────────────────────────────────────────────────────────────────────────────────

async function readSealed(): Promise<SealedKek | null> {
  try {
    const raw = await fs.readFile(SEALED_STORE, "utf8");
    const p = JSON.parse(raw);
    return p && typeof p.ct === "string" ? (p as SealedKek) : null;
  } catch {
    return null;
  }
}

async function writeSealed(s: SealedKek): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SEALED_STORE, JSON.stringify(s, null, 2), "utf8");
}

/**
 * BOOTSTRAP: ensure a sealed KEK exists on disk. If none, generate a fresh random KEK and seal it to the
 * given operator public key. Returns the operator public key (base64) actually in force. Idempotent — never
 * overwrites an existing seal (that would orphan every already-encrypted doc). Called with the dev operator
 * pubkey in dev, or an explicitly-provisioned operator pubkey in a real deploy.
 */
async function ensureSealed(operatorPub: KeyObject): Promise<SealedKek> {
  const existing = await readSealed();
  if (existing) return existing;
  const kek = randomBytes(32);
  const sealed = sealKek(kek, operatorPub);
  await writeSealed(sealed);
  return sealed;
}

// ── Public API: lock / unlock / obtain the KEK ──────────────────────────────────────────────────────────

export type VaultStatus = {
  unlocked: boolean;
  /** How the current unlock happened (for the operator UI) — never reveals key material. */
  via?: "session" | "env" | "dev";
  /** Whether a sealed KEK exists on disk yet (bootstrap done). */
  provisioned: boolean;
};

let unlockedVia: VaultStatus["via"] | undefined;

/** Current lock status — safe to expose to an operator UI. Reveals NO key material. */
export async function vaultStatus(): Promise<VaultStatus> {
  const sealed = await readSealed();
  return { unlocked: unsealedKek !== null, via: unlockedVia, provisioned: sealed !== null };
}

/**
 * UNLOCK with an operator private key presented out-of-band (the /unlock route). Bootstraps the sealed KEK
 * against this operator's public key if none exists yet (first run), then opens it into memory. Throws if
 * the key doesn't open an existing seal (wrong operator). Returns the status.
 */
export async function unlockWithKey(privB64: string): Promise<VaultStatus> {
  const priv = parseOperatorPrivate(privB64); // throws on malformed → route maps to 400
  const pub = createPublicKey(priv);
  const sealed = await ensureSealed(pub);
  const kek = openKek(sealed, priv); // throws if this key can't open the existing seal → wrong operator
  unsealedKek = kek;
  unlockedVia = "session";
  return vaultStatus();
}

/** LOCK — wipe the in-memory KEK (operator sign-out / panic). The server returns to breach-safe at rest. */
export function lockVault(): void {
  if (unsealedKek) unsealedKek.fill(0);
  unsealedKek = null;
  unlockedVia = undefined;
}

/**
 * Obtain the root KEK for a crypto op. Honors the unlock-source precedence (see header). Returns the KEK or
 * throws VaultLockedError if the server is locked and no auto-unlock source applies. SERVER-ONLY.
 */
export async function getKek(): Promise<Buffer> {
  if (unsealedKek) return unsealedKek;

  // (2) explicit env operator key — testing convenience / deliberate prod operator choice.
  const envKey = process.env.VRX_KYC_OPERATOR_KEY?.trim();
  if (envKey) {
    try {
      const priv = parseOperatorPrivate(envKey);
      const pub = createPublicKey(priv);
      const sealed = await ensureSealed(pub);
      unsealedKek = openKek(sealed, priv);
      unlockedVia = "env";
      if (!warnedEnvKey) {
        warnedEnvKey = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[kyc-vault] auto-unlocked from VRX_KYC_OPERATOR_KEY. Convenient for testing; in production this " +
            "keeps a usable operator key on the server and so DEFEATS the at-rest breach-safety of Tier 2."
        );
      }
      return unsealedKek;
    } catch {
      throw new VaultLockedError(); // env key present but doesn't open the seal → treat as locked, loudly
    }
  }

  // (3) dev deterministic operator key — zero-setup demo only.
  if (process.env.NODE_ENV !== "production") {
    const { priv, pub } = devOperatorKeyPair();
    const sealed = await ensureSealed(pub);
    unsealedKek = openKek(sealed, priv);
    unlockedVia = "dev";
    if (!warnedDevKey) {
      warnedDevKey = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[kyc-vault] auto-unlocked with the NON-SECRET dev operator key (NODE_ENV!=production). KYC is NOT " +
          "breach-safe in dev. In production the server stays LOCKED until an operator unlocks it."
      );
    }
    return unsealedKek;
  }

  // (4) production, no session, no env key → LOCKED.
  throw new VaultLockedError();
}

/**
 * ONE-TIME provisioning helper for a REAL deploy: generate a fresh operator keypair, seal a new KEK to it,
 * and return the operator PRIVATE key (base64) to hand offline ONCE. Refuses if a seal already exists (so it
 * can never orphan encrypted docs). The private key is NEVER written to disk by this call. Intended to run
 * once via a throwaway script / protected route, then the operator stores the returned key offline.
 */
export async function provisionOperatorKey(): Promise<{ operatorPrivateKeyB64: string; operatorPublicKeyB64: string }> {
  const existing = await readSealed();
  if (existing) throw new Error("a sealed KEK already exists — provisioning again would orphan all encrypted docs");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const kek = randomBytes(32);
  const sealed = sealKek(kek, publicKey);
  await writeSealed(sealed);
  return {
    operatorPrivateKeyB64: (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"),
    operatorPublicKeyB64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
  };
}
