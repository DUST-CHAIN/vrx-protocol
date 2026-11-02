// BUYER-OWNED ENCRYPTED KYC VAULT — SERVER-ONLY (file-backed). The direct-buyer analogue of the
// agent-owned vault (lib/kyc-vault): a direct buyer uploads their OWN selfie + passport/ID through the
// direct-sales funnel, encrypted at rest. SAME AES-256-GCM envelope crypto (reused from lib/kyc-vault), SAME
// KEK (lib/kyc-vault-key, Tier 2 — dev auto-unlocks), OPPOSITE ownership: keyed by the buyer's WALLET
// ACCOUNT, not an agent id. This mirrors exactly how lib/buyers-direct sits BESIDE lib/buyers ( §2a:
// "same seal spine, opposite ownership — do not merge"). One crypto implementation, two ownership models.
// WHY A SIDECAR, NOT A VAULT REFACTOR (the chosen slice): generalizing lib/kyc-vault's ownership to
// {agent|buyer} would touch shared, security-critical code used by the live agent/dev pre-sign path. The
// sidecar keeps that path untouched and matches the established buyers-direct precedent in this same arc.
// PRIVACY: SERVER-ONLY. The ciphertext blobs live in.data/kyc-vault-buyer/; a breach of.data alone
// leaks nothing (no KEK on disk). Plaintext images leave the server ONLY through the buyer's OWN decrypt
// route (the buyer reading back their own upload) — no cross-account read. Nothing goes on-chain but a
// content HASH later (docSetHashes), never the image.

import { promises as fs } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { getKek, VaultLockedError } from "./kyc-vault-key";
import { gcmEncrypt, gcmDecrypt, type KycDoc, type KycDocKind, docMeta } from "./kyc-vault";

export { VaultLockedError } from "./kyc-vault-key";
export type { KycDoc, KycDocKind } from "./kyc-vault";

const DATA_DIR = path.join(process.cwd(), ".data");
const VAULT_DIR = path.join(DATA_DIR, "kyc-vault-buyer"); // ciphertext blobs (separate from the agent vault)
const STORE = path.join(DATA_DIR, "kyc-vault-buyer.json"); // record index (metadata + wrapped DEKs)

/** A buyer-owned vault entry: the encrypted docs the buyer uploaded about themselves. Keyed by wallet account
 * (the same identity lib/buyers-direct keys by). No `agent` — the buyer owns it. */
export type BuyerVaultEntry = {
  /** The buyer's wallet account id (lowercased for lookup) — the owner AND the store key. */
  account: string;
  /** Encrypted document set (one per kind; a re-upload of the same kind replaces it). */
  docs: KycDoc[];
  at: number;
  updatedAt: number;
};

// ── Store IO (serialized promise chain — same lost-write guard as kyc-vault/buyers-direct) ──────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: BuyerVaultEntry[]) => Promise<{ next: BuyerVaultEntry[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<BuyerVaultEntry[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BuyerVaultEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: BuyerVaultEntry[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

function normAccount(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** The buyer's own vault entry (null if they've uploaded nothing). Case-insensitive on account. */
export async function getBuyerVault(account: string): Promise<BuyerVaultEntry | null> {
  const a = normAccount(account);
  if (!a) return null;
  return (await readAll()).find((e) => e.account === a) ?? null;
}

/**
 * Encrypt + store a document the BUYER uploaded about themselves. Full envelope: random DEK → AES-GCM the
 * file → wrap the DEK under the KEK → write ciphertext + metadata. One doc per `kind` (re-upload replaces).
 * Throws VaultLockedError if the vault is locked (route → 503). Returns the updated entry.
 */
export async function addBuyerDoc(
  account: string,
  kind: KycDocKind,
  file: { bytes: Buffer; filename: string; mime: string }
): Promise<BuyerVaultEntry> {
  const a = normAccount(account);
  if (!a) throw new Error("account required");

  const dek = randomBytes(32);
  const kek = await getKek(); // throws VaultLockedError if locked
  const fileEnc = gcmEncrypt(file.bytes, dek);
  const dekWrap = gcmEncrypt(dek, kek);
  const contentHash = createHash("sha256").update(file.bytes).digest("hex");
  const docId = `bkyc-${Date.now()}-${randomBytes(4).toString("hex")}`;

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
    by: a, // the buyer uploaded it themselves
  };

  return mutate(async (list) => {
    const now = Date.now();
    const idx = list.findIndex((e) => e.account === a);
    if (idx >= 0) {
      const docs = list[idx].docs.filter((d) => d.kind !== kind); // one per kind
      docs.push(doc);
      const next = list.slice();
      next[idx] = { ...next[idx], docs, updatedAt: now };
      return { next, ret: next[idx] };
    }
    const rec: BuyerVaultEntry = { account: a, docs: [doc], at: now, updatedAt: now };
    return { next: [...list, rec], ret: rec };
  });
}

/** Delete one of the buyer's own docs (removes the ciphertext blob + the record). */
export async function deleteBuyerDoc(account: string, docId: string): Promise<BuyerVaultEntry | null> {
  const a = normAccount(account);
  if (!a) return null;
  return mutate(async (list) => {
    const idx = list.findIndex((e) => e.account === a);
    if (idx < 0) return { next: list, ret: null };
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
 * DECRYPT one of the buyer's own docs. SERVER-ONLY; the route authorizes the reader = the SAME account that
 * owns it (buyer reading back their own upload). Unwraps the DEK with the KEK then decrypts the file; returns
 * null if the doc/blob is missing or the KEK can't unwrap (locked / tampered → GCM auth fails loudly).
 */
export async function decryptBuyerDoc(
  account: string,
  docId: string
): Promise<{ bytes: Buffer; mime: string; filename: string } | null> {
  const entry = await getBuyerVault(account);
  const doc = entry?.docs.find((d) => d.id === docId);
  if (!doc) return null;
  try {
    const kek = await getKek();
    const dek = gcmDecrypt(Buffer.from(doc.wrappedDek.ct, "hex"), kek, doc.wrappedDek.iv, doc.wrappedDek.tag);
    const ct = await fs.readFile(path.join(VAULT_DIR, `${doc.id}.enc`));
    const bytes = gcmDecrypt(ct, dek, doc.iv, doc.tag);
    return { bytes, mime: doc.mime, filename: doc.filename };
  } catch {
    return null;
  }
}

/** Metadata-only projection of the buyer's own entry (never bytes, never crypto material). */
export function buyerVaultMeta(e: BuyerVaultEntry | null) {
  if (!e) return { account: "", docs: [], updatedAt: 0 };
  return { account: e.account, docs: e.docs.map(docMeta), updatedAt: e.updatedAt };
}
