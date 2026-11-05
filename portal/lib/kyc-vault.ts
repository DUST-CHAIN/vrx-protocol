// ENCRYPTED KYC DOCUMENT VAULT — SERVER-ONLY (file-backed). pt-2 / "Buyer KYC = ENCRYPTED
// DOCUMENT UPLOADS". Customers can't be VETTED like dev/agency/agent (lib/profiles) — instead the agent
// (today) or the buyer (a later arc) UPLOADS identity documents: a headshot, a photo/scan of the
// ID card and/or passport, and OPTIONALLY the front of a credit card. These are PII images → they must be
// ENCRYPTED AT REST so a breach of the.data dir alone leaks NOTHING (explicit).
//
// ── Envelope encryption (the realistic vault — the choice) ───────────────────────────────────
// Each uploaded file gets its OWN random 256-bit Data-Encryption-Key (DEK). The file bytes are encrypted
// with AES-256-GCM under that DEK. The DEK is then WRAPPED (encrypted) under a single root Key-Encryption-
// Key (KEK) and the wrapped DEK is stored IN the record. So:
//   plaintext file --AES-GCM(DEK)--> ciphertext on disk (.data/kyc-vault/<id>.enc)
//   DEK            --AES-GCM(KEK)--> wrappedDek stored in the record metadata
// To read a file you need BOTH the record (holds the wrapped DEK) AND the KEK (never on disk). A breach of
// .data gives ciphertext + wrapped DEKs but no KEK → useless. Rotating the KEK only requires re-wrapping
// the small DEKs, never re-encrypting the (large) files. This is standard envelope encryption.
//
// ── The KEK (root key) — key MODEL lives in lib/kyc-vault-key.ts ──────────────────────────────────────
// The root KEK is now owned by `lib/kyc-vault-key.ts` (TIER 2, — BUILT): the KEK is SEALED to an
// OFFLINE operator keypair and only lives in memory after an operator UNSEALS it (the server boots LOCKED).
// This module just ASKS for the KEK via `getKek` and doesn't care how it's obtained. If the vault is
// locked, `getKek` throws `VaultLockedError` → writes surface it (route → 503), reads fail-closed (null).
//
// ── Key-model roadmap ──────────────────────────────────────────────────────────────────────────
// TIER 1 (shipped): KEK = a SERVER env secret — defends a `.data` DISK breach only. SUPERSEDED by Tier 2.
// TIER 2 (BUILT lib/kyc-vault-key.ts): KEK sealed to an operator keypair whose private half lives
//   OFFLINE; a running server is LOCKED until unsealed → even a full server compromise at rest can't recover
//   KYC without the offline key. Envelope encryption means NO file re-encryption — only the KEK's wrapping
//   changed. Dev/testing auto-unlocks (non-secret dev key or `VRX_KYC_OPERATOR_KEY`); prod stays locked.
// TIER 3 (true client-side E2E, buyer-vault): a bigger, separate arc. Neither tier 1 nor 2 is E2E — the
//  server sees plaintext when it shows the developer at the pre-sign gate. +.
//
// ── privacy ─────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. Plaintext images never leave the server except through a party-SCOPED decrypt route (the
// developer at the pre-sign gate, a "seen, this purpose only" ack recorded). Nothing here goes on-chain —
// at most a content HASH of the (plaintext) doc set rides in a seal, never the image. Same file-backed
// .data pattern as profiles.ts / buyers.ts; the real architecture distributes per-party, unchanged.

import { promises as fs } from "fs";
import path from "path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { getKek, VaultLockedError } from "./kyc-vault-key";

export { VaultLockedError } from "./kyc-vault-key";

const DATA_DIR = path.join(process.cwd(), ".data");
const VAULT_DIR = path.join(DATA_DIR, "kyc-vault"); // ciphertext blobs live here
const STORE = path.join(DATA_DIR, "kyc-vault.json"); // the record index (metadata + wrapped DEKs)

/** The kinds of KYC document we capture. The human visual-match vetting (photo ↔ ID ↔ card name). */
export type KycDocKind = "headshot" | "id_card" | "passport" | "card_front";

/** A single encrypted document in the vault. Holds NO plaintext and NO bare DEK — only wrapped crypto. */
export type KycDoc = {
  /** Opaque doc id (also the ciphertext filename stem). */
  id: string;
  kind: KycDocKind;
  /** Original filename (for display) + mime (images only, enforced at the route). */
  filename: string;
  mime: string;
  /** Plaintext byte length (before encryption) — for display; the ciphertext is slightly larger. */
  size: number;
  /** SHA-256 of the PLAINTEXT bytes (hex). The only thing safe to put in a seal — proves the doc unaltered
   *  without revealing it. The image itself is never hashed into anything on-chain. */
  contentHash: string;
  /** AES-GCM IV for the FILE encryption (hex, 12 bytes). */
  iv: string;
  /** AES-GCM auth tag for the FILE (hex, 16 bytes). */
  tag: string;
  /** The DEK, wrapped under the root KEK: { iv, tag, ct } all hex. Unwrap needs the KEK (never on disk). */
  wrappedDek: { iv: string; tag: string; ct: string };
  /** ms epoch uploaded. */
  at: number;
  /** Who uploaded (agent account today; the buyer in the arc). Audit trail. */
  by: string;
};

/**
 * The per-buyer KYC vault entry: the encrypted docs + the optional captured upload GPS (evidence)
 * + the structured contract fields the S&P actually needs (collected right from the start). Keyed by
 * buyer id (lib/buyers.Buyer.id) so it hangs off the agent's roster record.
 */
export type KycVaultEntry = {
  /** The owning buyer record id (lib/buyers). The join key. */
  buyerId: string;
  /** The agent account that owns the buyer (scope guard — only this agent may upload/read via the agent path). */
  agent: string;
  /** Encrypted document set. */
  docs: KycDoc[];
  /** Structured KYC/contract fields the S&P needs — captured alongside the docs (plaintext PII, server-only). */
  fields: KycContractFields;
  /** Optional GPS captured at upload time (buyer's browser geolocation) — evidence, shown on an OSM map later. */
  gps?: { lat: number; lng: number; accuracy?: number; at: number; by: string };
  at: number;
  updatedAt: number;
};

/**
 * The structured identity/contract fields a Sale & Purchase agreement needs about the buyer. Collected with
 * the documents so the S&P can be fully populated. All optional except they're meant to be completable up to
 * signing time (like the agency agreement). PII → server-only, never on-chain in plaintext.
 */
export type KycContractFields = {
  /** Full legal name as on the ID/passport. */
  legalName?: string;
  /** Nationality / citizenship (relevant to the freehold quota). */
  nationality?: string;
  /** Passport number (the "passport number details" asked for). */
  passportNo?: string;
  /** National ID-card number. */
  idCardNo?: string;
  /** Date of birth (ISO yyyy-mm-dd; free text, not validated as identity). */
  dob?: string;
  /** Residential address for the contract. */
  address?: string;
  /** Contact phone. */
  phone?: string;
  /** Contact email (NEVER the forbidden personal inbox — the buyer's own). */
  email?: string;
};

// ── The root KEK ───────────────────────────────────────────────────────────────────────────────────────
// Obtained from lib/kyc-vault-key.ts (Tier 2). `getKek` throws VaultLockedError if the server is locked.

// ── AES-256-GCM helpers ──────────────────────────────────────────────────────────────────────────────

// Exported so the BUYER-owned sidecar vault (lib/kyc-vault-buyer) reuses the exact same envelope
// crypto instead of duplicating it — one AES-256-GCM implementation, two ownership models (agent / buyer).
export function gcmEncrypt(plain: Buffer, key: Buffer): { iv: string; tag: string; ct: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), tag: tag.toString("hex"), ct };
}

export function gcmDecrypt(ct: Buffer, key: Buffer, ivHex: string, tagHex: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── Store IO (mirrors buyers.ts; serialized via a simple promise chain to avoid lost writes, bug) ──

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: KycVaultEntry[]) => Promise<{ next: KycVaultEntry[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<KycVaultEntry[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as KycVaultEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: KycVaultEntry[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

function cleanFields(raw: unknown): KycContractFields {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const out: KycContractFields = {};
  for (const k of ["legalName", "nationality", "passportNo", "idCardNo", "dob", "address", "phone", "email"] as const) {
    const v = s(r[k]);
    if (v) out[k] = v;
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────

/** Get the vault entry for a buyer, SCOPED to the owning agent (null if not that agent's — never leak). */
export async function getEntryForAgent(buyerId: string, agent: string): Promise<KycVaultEntry | null> {
  const a = agent.trim().toLowerCase();
  const rec = (await readAll()).find((e) => e.buyerId === buyerId.trim());
  return rec && rec.agent.toLowerCase() === a ? rec : null;
}

/** Get the vault entry by buyer id WITHOUT agent scoping — for the developer pre-sign view (route gates it). */
export async function getEntry(buyerId: string): Promise<KycVaultEntry | null> {
  return (await readAll()).find((e) => e.buyerId === buyerId.trim()) ?? null;
}

/** Ensure an entry exists for (buyerId, agent); create an empty one if absent. Returns it. */
async function ensureEntry(buyerId: string, agent: string): Promise<KycVaultEntry> {
  return mutate(async (list) => {
    const id = buyerId.trim();
    const a = agent.trim();
    const idx = list.findIndex((e) => e.buyerId === id);
    if (idx >= 0) {
      if (list[idx].agent.toLowerCase() !== a.toLowerCase()) throw new Error("not your buyer");
      return { next: list, ret: list[idx] };
    }
    const now = Date.now();
    const rec: KycVaultEntry = { buyerId: id, agent: a, docs: [], fields: {}, at: now, updatedAt: now };
    return { next: [...list, rec], ret: rec };
  });
}

/** Save/merge the structured contract fields on a buyer's vault entry (agent-scoped). */
export async function saveFieldsForAgent(
  buyerId: string,
  agent: string,
  fields: unknown
): Promise<KycVaultEntry> {
  await ensureEntry(buyerId, agent);
  const clean = cleanFields(fields);
  return mutate(async (list) => {
    const idx = list.findIndex((e) => e.buyerId === buyerId.trim());
    if (idx < 0) throw new Error("no entry");
    if (list[idx].agent.toLowerCase() !== agent.trim().toLowerCase()) throw new Error("not your buyer");
    const next = list.slice();
    next[idx] = { ...next[idx], fields: { ...next[idx].fields, ...clean }, updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/** Record the buyer's captured GPS on the vault entry (agent-scoped). Evidence; shown on a map later. */
export async function saveGpsForAgent(
  buyerId: string,
  agent: string,
  gps: { lat: number; lng: number; accuracy?: number }
): Promise<KycVaultEntry> {
  await ensureEntry(buyerId, agent);
  return mutate(async (list) => {
    const idx = list.findIndex((e) => e.buyerId === buyerId.trim());
    if (idx < 0) throw new Error("no entry");
    if (list[idx].agent.toLowerCase() !== agent.trim().toLowerCase()) throw new Error("not your buyer");
    const next = list.slice();
    next[idx] = {
      ...next[idx],
      gps: { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy, at: Date.now(), by: agent.trim() },
      updatedAt: Date.now(),
    };
    return { next, ret: next[idx] };
  });
}

/**
 * Encrypt + store an uploaded document for a buyer (agent-scoped). Does the full envelope: random DEK →
 * AES-GCM the file → wrap the DEK under the KEK → write the ciphertext blob + the metadata record. Replaces
 * any existing doc of the same `kind` (one headshot, one id, etc. — re-upload overwrites). Returns the entry.
 */
export async function addDocForAgent(
  buyerId: string,
  agent: string,
  kind: KycDocKind,
  file: { bytes: Buffer; filename: string; mime: string }
): Promise<KycVaultEntry> {
  await ensureEntry(buyerId, agent);

  const dek = randomBytes(32);
  const kek = await getKek(); // throws VaultLockedError if the vault is locked → route returns 503
  const fileEnc = gcmEncrypt(file.bytes, dek);
  const dekWrap = gcmEncrypt(dek, kek);
  const contentHash = createHash("sha256").update(file.bytes).digest("hex");
  const docId = `kyc-${Date.now()}-${randomBytes(4).toString("hex")}`;

  await fs.mkdir(VAULT_DIR, { recursive: true });
  await fs.writeFile(path.join(VAULT_DIR, `${docId}.enc`), fileEnc.ct);

  const doc: KycDoc = {
    id: docId,
    kind,
    filename: file.filename.slice(0, 200),
    mime: file.mime,
    size: file.bytes.length,
    contentHash,
    iv: fileEnc.iv,
    tag: fileEnc.tag,
    wrappedDek: { iv: dekWrap.iv, tag: dekWrap.tag, ct: dekWrap.ct.toString("hex") },
    at: Date.now(),
    by: agent.trim(),
  };

  return mutate(async (list) => {
    const idx = list.findIndex((e) => e.buyerId === buyerId.trim());
    if (idx < 0) throw new Error("no entry");
    if (list[idx].agent.toLowerCase() !== agent.trim().toLowerCase()) throw new Error("not your buyer");
    const next = list.slice();
    const docs = next[idx].docs.filter((d) => d.kind !== kind); // one per kind — re-upload replaces
    docs.push(doc);
    next[idx] = { ...next[idx], docs, updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/** Delete one doc (agent-scoped) — removes the blob + the record entry. */
export async function deleteDocForAgent(buyerId: string, agent: string, docId: string): Promise<KycVaultEntry | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((e) => e.buyerId === buyerId.trim());
    if (idx < 0) return { next: list, ret: null };
    if (list[idx].agent.toLowerCase() !== agent.trim().toLowerCase()) return { next: list, ret: list[idx] };
    const doc = list[idx].docs.find((d) => d.id === docId);
    if (doc) {
      try {
        await fs.unlink(path.join(VAULT_DIR, `${doc.id}.enc`));
      } catch {
        /* blob already gone — fine */
      }
    }
    const next = list.slice();
    next[idx] = { ...next[idx], docs: next[idx].docs.filter((d) => d.id !== docId), updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/**
 * DECRYPT one doc's plaintext bytes. SERVER-ONLY; the calling route is responsible for authorizing the
 * reader (agent-owns-buyer, or developer-at-the-pre-sign-gate). Unwraps the DEK with the KEK, then decrypts
 * the file. Returns the bytes + mime, or null if the doc/blob is missing or the KEK can't unwrap it (wrong
 * KEK / tampered record → GCM auth fails loudly, never a silent wrong-plaintext).
 */
export async function decryptDoc(buyerId: string, docId: string): Promise<{ bytes: Buffer; mime: string; filename: string } | null> {
  const entry = await getEntry(buyerId);
  const doc = entry?.docs.find((d) => d.id === docId);
  if (!doc) return null;
  try {
    const kek = await getKek(); // VaultLockedError caught below → locked read fails closed (null)
    const dek = gcmDecrypt(Buffer.from(doc.wrappedDek.ct, "hex"), kek, doc.wrappedDek.iv, doc.wrappedDek.tag);
    const ct = await fs.readFile(path.join(VAULT_DIR, `${doc.id}.enc`));
    const bytes = gcmDecrypt(ct, dek, doc.iv, doc.tag);
    return { bytes, mime: doc.mime, filename: doc.filename };
  } catch {
    return null;
  }
}

/** Public-safe metadata projection of a doc — NO crypto, NO bytes. Safe to send to an authorized client. */
export function docMeta(d: KycDoc) {
  return { id: d.id, kind: d.kind, filename: d.filename, mime: d.mime, size: d.size, contentHash: d.contentHash, at: d.at };
}

/** Metadata-only projection of a whole entry (what a KYC card shows — never bytes, never crypto material). */
export function entryMeta(e: KycVaultEntry) {
  return {
    buyerId: e.buyerId,
    fields: e.fields,
    gps: e.gps ? { lat: e.gps.lat, lng: e.gps.lng, accuracy: e.gps.accuracy, at: e.gps.at } : undefined,
    docs: e.docs.map(docMeta),
    updatedAt: e.updatedAt,
  };
}

/** The content hashes of all docs (sorted) — the only vault data safe to fold into a seal (proves the doc
 * set unaltered without revealing any image). Used by the `final`-gate KYC-ack seal (pt-2). */
export function docSetHashes(e: KycVaultEntry): string[] {
  return e.docs.map((d) => `${d.kind}:${d.contentHash}`).sort();
}
