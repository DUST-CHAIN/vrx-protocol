// ── Building documents store (title-deed stub) ──────────────────────────────────────────────
// A building's legal/physical documents (today: the TITLE DEED) stored ENCRYPTED AT REST — breach-safe —
// but, per §3, deliberately MORE OPEN than the buyer KYC vault: a title deed is a land-registry
// document MEANT to be seen by the deal parties (developer + agent + buyer) + VRX root. So it is NOT
// reveal-gated like buyer PII; it is building-scoped (public building context, family), and uses a
// simple server-env KEK rather than the locked-operator KYC Tier-2.
// Envelope encryption (same primitive as lib/kyc-vault.ts): each file gets a random 256-bit DEK; the file
// is AES-256-GCM'd under the DEK; the DEK is wrapped under the root KEK and stored in the record. A.data
// breach yields ciphertext + wrapped DEKs but no KEK → useless.
// The DOCUMENT itself stays off-chain; only its HASH is sealed on-chain at "this is final" ( §2) — that
// on-chain seal is the DEFERRED part (frozen contract + wallet arc). This module is the off-chain step 1 of
// the build order: upload + encrypted storage + party-scoped viewer.
// SERVER-ONLY. Plaintext bytes never leave the server except through the view route.

import { promises as fs } from "fs";
import path from "path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "building-docs.json");
const BLOB_DIR = path.join(DATA_DIR, "building-docs");

/** Document kinds a building can carry. `title_deed` is the first; more attach here later. */
export type BuildingDocKind = "title_deed";
export const BUILDING_DOC_KINDS: BuildingDocKind[] = ["title_deed"];

export const MAX_DOC_BYTES = 12 * 1024 * 1024; // 12 MB — deeds are PDFs/scans
/** PDF + common image scans. */
export const OK_DOC_MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif|tiff))$/i;

/** One encrypted building document. Holds NO plaintext and NO bare DEK — only wrapped crypto + metadata. */
export type BuildingDoc = {
  id: string;
  building: string;
  kind: BuildingDocKind;
  filename: string;
  mime: string;
  size: number; // plaintext byte length (ciphertext is slightly larger)
  uploadedAt: number;
  /** SHA-256 of the PLAINTEXT bytes (hex) — the integrity hash that gets sealed on-chain at "final". */
  sha256: string;
  /** AES-GCM IV + tag for the FILE encryption (hex). The ciphertext lives in BLOB_DIR/<id>.bin. */
  fileIv: string;
  fileTag: string;
  /** The DEK, wrapped under the root KEK: { iv, tag, ct } all hex. Unwrap needs the KEK (never on disk). */
  wrappedDek: { iv: string; tag: string; ct: string };
};

/** Public-safe metadata (no crypto material) — what the client gets back. */
export type BuildingDocMeta = Pick<
  BuildingDoc,
  "id" | "building" | "kind" | "filename" | "mime" | "size" | "uploadedAt" | "sha256"
>;
export function docMeta(d: BuildingDoc): BuildingDocMeta {
  const { id, building, kind, filename, mime, size, uploadedAt, sha256 } = d;
  return { id, building, kind, filename, mime, size, uploadedAt, sha256 };
}

// ── The root KEK (Tier-1: server env secret). Party-open docs don't need the locked-operator Tier-2. ──
function getKek(): Buffer {
  const raw = process.env.VRX_BUILDING_DOCS_KEY;
  if (raw && raw.length >= 16) return createHash("sha256").update(raw).digest();
  // Dev fallback — NOT breach-safe. A real deploy MUST set VRX_BUILDING_DOCS_KEY.
  if (!warned) {
    warned = true;
    console.warn("[building-docs] VRX_BUILDING_DOCS_KEY not set — using a non-secret dev fallback (NOT breach-safe).");
  }
  return createHash("sha256").update("vrx-building-docs-dev-fallback").digest();
}
let warned = false;

// ── AES-256-GCM helpers (same shape as kyc-vault) ──
function gcmEncrypt(plain: Buffer, key: Buffer): { iv: string; tag: string; ct: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct };
}
function gcmDecrypt(ct: Buffer, key: Buffer, ivHex: string, tagHex: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([d.update(ct), d.final()]);
}

// ── Store IO (serialized via a promise chain to avoid lost writes, same guard as the other.data stores) ──
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: BuildingDoc[]) => Promise<{ next: BuildingDoc[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}
async function readAll(): Promise<BuildingDoc[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return Array.isArray(parsed) ? (parsed as BuildingDoc[]) : [];
  } catch {
    return [];
  }
}
async function writeAll(list: BuildingDoc[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

// ── Public API ──

/** List a building's documents (metadata only). */
export async function listDocs(building: string): Promise<BuildingDocMeta[]> {
  const b = building.trim();
  return (await readAll()).filter((d) => d.building === b).map(docMeta);
}

/** The one current document of a kind for a building (latest wins), metadata only. */
export async function getDoc(building: string, kind: BuildingDocKind): Promise<BuildingDocMeta | null> {
  const b = building.trim();
  const hits = (await readAll()).filter((d) => d.building === b && d.kind === kind);
  const latest = hits.sort((a, z) => z.uploadedAt - a.uploadedAt)[0];
  return latest ? docMeta(latest) : null;
}

/**
 * Encrypt + store an uploaded building document. Envelope: random DEK → encrypt file under DEK → wrap DEK
 * under the KEK. The plaintext SHA-256 is recorded (the integrity hash). A building keeps ONE document
 * per kind — a new upload REPLACES the old one (and deletes its blob).
 */
export async function addDoc(
  building: string,
  kind: BuildingDocKind,
  file: { bytes: Buffer; filename: string; mime: string }
): Promise<BuildingDocMeta> {
  const b = building.trim();
  const kek = getKek();
  const dek = randomBytes(32);
  const enc = gcmEncrypt(file.bytes, dek);
  const wrapped = gcmEncrypt(dek, kek);
  const id = randomBytes(9).toString("hex");
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");

  await fs.mkdir(BLOB_DIR, { recursive: true });
  await fs.writeFile(path.join(BLOB_DIR, `${id}.bin`), enc.ct);

  const doc: BuildingDoc = {
    id,
    building: b,
    kind,
    filename: file.filename,
    mime: file.mime,
    size: file.bytes.length,
    uploadedAt: Date.now(),
    sha256,
    fileIv: enc.iv,
    fileTag: enc.tag,
    wrappedDek: { iv: wrapped.iv, tag: wrapped.tag, ct: wrapped.ct.toString("hex") },
  };

  return mutate(async (list) => {
    // Replace any existing doc of this kind for this building (one current per kind).
    const stale = list.filter((d) => d.building === b && d.kind === kind);
    for (const s of stale) {
      await fs.rm(path.join(BLOB_DIR, `${s.id}.bin`), { force: true }).catch(() => {});
    }
    const next = list.filter((d) => !(d.building === b && d.kind === kind)).concat(doc);
    return { next, ret: docMeta(doc) };
  });
}

/** Decrypt a document for viewing (party-open per §3 — no PII scoping). Returns plaintext bytes + mime. */
export async function decryptDoc(id: string): Promise<{ bytes: Buffer; mime: string; filename: string } | null> {
  const doc = (await readAll()).find((d) => d.id === id.trim());
  if (!doc) return null;
  const kek = getKek();
  const dek = gcmDecrypt(Buffer.from(doc.wrappedDek.ct, "hex"), kek, doc.wrappedDek.iv, doc.wrappedDek.tag);
  const ct = await fs.readFile(path.join(BLOB_DIR, `${doc.id}.bin`));
  const bytes = gcmDecrypt(ct, dek, doc.fileIv, doc.fileTag);
  return { bytes, mime: doc.mime, filename: doc.filename };
}

/** Remove a building's document of a kind (+ its blob). Developer-only action at the route layer. */
export async function removeDoc(building: string, kind: BuildingDocKind): Promise<void> {
  const b = building.trim();
  await mutate(async (list) => {
    const stale = list.filter((d) => d.building === b && d.kind === kind);
    for (const s of stale) {
      await fs.rm(path.join(BLOB_DIR, `${s.id}.bin`), { force: true }).catch(() => {});
    }
    return { next: list.filter((d) => !(d.building === b && d.kind === kind)), ret: undefined };
  });
}
