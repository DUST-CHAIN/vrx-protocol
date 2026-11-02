// VRX TOKEN-EVIDENCE VAULT — the agent's cash-photo store for a booking token (seam #2).
// ── What it holds ───────────────────────────────────────────────────────────────────────────────────────
// One encrypted PHOTO/slip per booking token: the proof the field agent snaps when they take the customer's
// cash on the spot (committed → cash_taken). The token record (lib/booking-tokens) stores only an opaque
// `evidenceId` REFERENCE into this store (never bytes). A re-upload for the same token REPLACES the prior
// photo (one cash-photo per token; the custody chain confirms ONE cash leg).
// ── Why its OWN store (the FOURTH ownership model) ──────────────────────────────────────────────────────
// This is the same AES-256-GCM envelope the KYC vault and the payment vault use — but a cash photo is scoped
// to the TOKEN's custody (the holding agent, their supervising agency, the owning developer), NOT to buyer-KYC
// docs (agent-owned, buyer-keyed) nor to developer payment records (developer-owned, unit-keyed). Same crypto,
// a distinct ownership/scope model, so — exactly as payment-vault did ( reuse pattern) — it REUSES the
// exported envelope crypto (gcmEncrypt/gcmDecrypt + the Tier-2 locked KEK) and keeps its own store + scope
// guard. ONE AES-256-GCM implementation, FOUR ownership models now (agent-KYC / buyer-KYC / developer-payments
// / token-cash). We did NOT fork payment-vault's PaymentRecord-coupled pipeline — that coupling is exactly what
// this seam decouples from.
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. The photo bytes are PII/B2B → off-chain, encrypted at rest, NEVER on-chain. The token layer
// seals only a plaintext contentHash reference into its custody log (proves the slip unaltered without
// revealing it); the bytes themselves leave the server only through the authorized read route, decrypted
// in-memory and streamed no-store.
// ── Machine note ────────────────────────────────────────────────────────────────────────────────────────
// Any SEED `.data/token-evidence.json` must be written with the Write tool (clean UTF-8/LF) — NEVER a
// PowerShell Set-Content/here-string (BOM + CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { gcmEncrypt, gcmDecrypt, VaultLockedError } from "./kyc-vault";
import { getKek } from "./kyc-vault-key";

export { VaultLockedError } from "./kyc-vault";

const DATA_DIR = path.join(process.cwd(), ".data");
const VAULT_DIR = path.join(DATA_DIR, "token-evidence"); // ciphertext photo blobs
const STORE = path.join(DATA_DIR, "token-evidence.json"); // the metadata index

/** Encrypted cash-photo metadata — the exact envelope shape as a payment slip (reused crypto, own store).
 * Holds NO plaintext and NO bare DEK: only the file IV/tag + the DEK wrapped under the root KEK. */
export type TokenEvidence = {
  /** Opaque evidence id — ALSO the ciphertext blob filename stem (`{id}.enc`). This is the `evidenceId`
   * reference the token record carries. */
  id: string;
  /** The booking token this photo belongs to — the scope anchor the read route authorizes against. */
  tokenId: string;
  /** The account that uploaded it (the field agent who took the cash). */
  uploadedBy: string;
  /** ms epoch the photo was attached. */
  at: number;
  filename: string;
  mime: string;
  /** Plaintext byte length (ciphertext is slightly larger). */
  size: number;
  /** SHA-256 of the PLAINTEXT bytes (hex) — proves this photo unaltered (bound into the token's custody seal). */
  contentHash: string;
  /** AES-GCM IV + auth tag for the FILE (hex). */
  iv: string;
  tag: string;
  /** The DEK wrapped under the root KEK: { iv, tag, ct } all hex. Unwrap needs the KEK (never on disk). */
  wrappedDek: { iv: string; tag: string; ct: string };
};

// ── Store IO (mirrors payment-vault.ts: serialized via a promise chain so concurrent writes can't clobber) ──

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: TokenEvidence[]) => Promise<{ next: TokenEvidence[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<TokenEvidence[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TokenEvidence[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: TokenEvidence[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────────

/** A photo to attach to a token: the raw bytes + its metadata + who uploaded it. */
export type EvidenceUpload = { bytes: Buffer; filename: string; mime: string; uploadedBy: string };

/**
 * STORE one cash photo for a token: random DEK → AES-GCM the bytes → wrap the DEK under the KEK → write the
 * ciphertext blob `{id}.enc` + the metadata record → return the metadata (whose `id` is the token's
 * `evidenceId` reference). A re-upload for the same token REPLACES the prior photo (one photo per token — the
 * custody chain reconciles ONE cash leg) and unlinks the old blob. Throws VaultLockedError (→ route 503) if the
 * vault is locked (no KEK). SERVER-ONLY.
 */
export async function putTokenEvidence(tokenId: string, up: EvidenceUpload): Promise<TokenEvidence> {
  const tid = tokenId.trim();
  if (!tid) throw new Error("tokenId required");
  const id = `tev-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dek = randomBytes(32);
  const kek = await getKek(); // VaultLockedError → route 503, BEFORE we mutate the store
  const fileEnc = gcmEncrypt(up.bytes, dek);
  const dekWrap = gcmEncrypt(dek, kek);
  const contentHash = createHash("sha256").update(up.bytes).digest("hex");
  await fs.mkdir(VAULT_DIR, { recursive: true });
  await fs.writeFile(path.join(VAULT_DIR, `${id}.enc`), fileEnc.ct);

  const meta: TokenEvidence = {
    id,
    tokenId: tid,
    uploadedBy: up.uploadedBy.trim(),
    at: Date.now(),
    filename: up.filename.slice(0, 200),
    mime: up.mime,
    size: up.bytes.length,
    contentHash,
    iv: fileEnc.iv,
    tag: fileEnc.tag,
    wrappedDek: { iv: dekWrap.iv, tag: dekWrap.tag, ct: dekWrap.ct.toString("hex") },
  };

  return mutate(async (list) => {
    // Replace any prior photo for the same token (one per token) — unlink its blob first.
    const prior = list.filter((e) => e.tokenId === tid);
    for (const p of prior) {
      try { await fs.unlink(path.join(VAULT_DIR, `${p.id}.enc`)); } catch { /* gone — fine */ }
    }
    return { next: [...list.filter((e) => e.tokenId !== tid), meta], ret: meta };
  });
}

/** Load one evidence record by its id (SERVER-ONLY) — the read route uses it to resolve the owning token for
 * the custody-scope authorization check BEFORE decrypting. */
export async function getTokenEvidence(evidenceId: string): Promise<TokenEvidence | null> {
  const id = evidenceId.trim();
  return (await readAll()).find((e) => e.id === id) ?? null;
}

/** The current photo for a token, if any (one per token). */
export async function evidenceForToken(tokenId: string): Promise<TokenEvidence | null> {
  const tid = tokenId.trim();
  return (await readAll()).find((e) => e.tokenId === tid) ?? null;
}

/** DELETE a token's photo(s) + its blob(s). Used when a token is recycled/re-issued (the cash leg is gone).
 * Returns how many were removed. SERVER-ONLY. */
export async function deleteTokenEvidence(tokenId: string): Promise<number> {
  const tid = tokenId.trim();
  return mutate(async (list) => {
    const gone = list.filter((e) => e.tokenId === tid);
    for (const e of gone) {
      try { await fs.unlink(path.join(VAULT_DIR, `${e.id}.enc`)); } catch { /* gone — fine */ }
    }
    return { next: list.filter((e) => e.tokenId !== tid), ret: gone.length };
  });
}

/**
 * DECRYPT one cash photo's plaintext bytes (by its evidence id). SERVER-ONLY; the route authorizes the reader
 * against the owning token's custody chain. Unwraps the DEK with the KEK, then decrypts the blob. null if the
 * record/blob is missing or the KEK can't unwrap (wrong KEK / tampered → GCM auth fails loudly, never a silent
 * wrong-plaintext). Locked vault → null (fail-closed read).
 */
export async function decryptTokenEvidence(
  evidenceId: string
): Promise<{ bytes: Buffer; mime: string; filename: string; tokenId: string } | null> {
  const ev = await getTokenEvidence(evidenceId);
  if (!ev) return null;
  try {
    const kek = await getKek();
    const dek = gcmDecrypt(Buffer.from(ev.wrappedDek.ct, "hex"), kek, ev.wrappedDek.iv, ev.wrappedDek.tag);
    const ct = await fs.readFile(path.join(VAULT_DIR, `${ev.id}.enc`));
    const bytes = gcmDecrypt(ct, dek, ev.iv, ev.tag);
    return { bytes, mime: ev.mime, filename: ev.filename, tokenId: ev.tokenId };
  } catch {
    return null;
  }
}

// ── Public projection (what leaves the server) ──────────────────────────────────────────────────────────

/** Evidence metadata safe to send to an authorized client — NO crypto material, NO bytes. Just the facts a
 * photo card shows: id (to fetch the bytes via the read route), who/when, filename + the non-secret hash. */
export function tokenEvidenceMeta(e: TokenEvidence) {
  return { id: e.id, tokenId: e.tokenId, uploadedBy: e.uploadedBy, at: e.at, filename: e.filename, mime: e.mime, size: e.size, contentHash: e.contentHash };
}
