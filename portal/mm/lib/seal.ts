// MM ↔ NEAR seal — a NEAR developer account SIGNS OFF on a saved building.
//
// WHAT THIS IS: anyone can USE MM freely (build/draw/trace/export) with no NEAR account. A STAMPED,
// identity-bearing export additionally carries a SEAL: a NEP-413 signature by a real NEAR account over
// the pack's content digest. The seal binds "this exact building was signed off by <account>.near" —
// developer-authenticity today, and the same primitive is authorship/provenance for an architect or
// artist (riff,: "I designed this, here's the on-chain-anchored proof").
//
// OFF-CHAIN by design (deadline-safe, no live tx): the seal is produced by the wallet's signMessage and
// verified by the SAME @near-wallet-selector/core verifier the portal's login path uses (lib/nep413.ts).
// A full end-to-end verify (is the key a FULL-ACCESS key the account owns on-chain?) reuses the portal's
// `verifyNep413Proof` server path — the Seal's shape maps 1:1 onto a Nep413Proof. This module does the
// pure crypto half (valid-vs-forged), which is what the UI gate + the unit test need.
//
// ONE WRITE PATH: the seal signs a DETERMINISTIC digest of exactly the content the export emits. The
// digest is derived from pack.json's own `checksums` map (every building.json/units.csv/media/terms file,
// already hashed by buildPackFiles for the manifest) — sorted + re-hashed, so it is order-independent and
// excludes the volatile `generatedAt` timestamp. Same building → same digest, any time, any machine. That
// re-derivability is what makes the seal a provenance proof, not just a one-export receipt.

import type { Pack } from "./pack";
import { buildPackFiles, sha256Hex } from "./export";
import { verifySignature } from "@near-wallet-selector/core";

/** Binds a seal to THIS app so a portal-login proof can't be replayed as a seal (and vice versa). Not secret. */
export const SEAL_RECIPIENT = "vrx-model-maker";

/** Current seal envelope version. Bump if the signed-message shape or digest derivation ever changes. */
export const SEAL_VERSION = 1 as const;

/** The detached sign-off attached to a sealed export (ships as seal.json in the pack ZIP). All strings are
 *  exactly as the wallet emits them (publicKey "ed25519:…", signature + nonce base64). Maps 1:1 onto the
 *  portal's Nep413Proof for a full on-chain-ownership verify. */
export type Seal = {
  v: typeof SEAL_VERSION;
  /** Deterministic sha256-hex content digest of the pack (see packDigest). The thing that was signed. */
  packDigest: string;
  /** The NEAR account that signed off (…​.near / …​.testnet). */
  nearAccountId: string;
  /** The ed25519 public key that produced the signature ("ed25519:…"). */
  publicKey: string;
  /** base64 ed25519 signature over the NEP-413 payload. */
  signatureB64: string;
  /** base64 of the 32-byte nonce that was part of the signed payload. */
  nonce: string;
  /** The app-binding recipient (SEAL_RECIPIENT). */
  recipient: string;
  /** The exact human-readable message that was signed (commits to packDigest). */
  message: string;
  /** ISO timestamp the seal was produced (informational — NOT part of the signed payload). */
  signedAt: string;
};

/**
 * The deterministic content digest of a pack — sha256-hex over the SORTED list of the pack's per-file
 * checksums (building.json/units.csv/matrix.csv/pricelist/brochure/terms/media), as computed by the export
 * itself. Excludes pack.json (it carries the volatile generatedAt) and any detached seal.json, so the same
 * building always yields the same digest. This is the subject of the signature — the "one write path".
 */
export async function packDigest(pack: Pack): Promise<string> {
  const files = await buildPackFiles(pack);
  // pack.json's `checksums` already covers every content file + every media blob (hashed by the export for
  // the manifest). Re-use it verbatim — no second serialization — then sort + hash to a stable fingerprint.
  const manifest = JSON.parse(files["pack.json"]) as { checksums?: Record<string, string> };
  const checksums = manifest.checksums ?? {};
  const entries = Object.entries(checksums)
    .filter(([path]) => path !== "pack.json" && path !== "seal.json")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(JSON.stringify(entries));
}

/** The exact message a wallet signs for a seal — human-readable + commits to the digest. */
export function sealMessage(packDigest: string): string {
  return `VRX · NEAR Model Maker — seal ${packDigest}`;
}

/** A short, display-friendly form of a 64-hex digest (first 8 · last 4) for the "Sealed by" chip. */
export function shortDigest(digest: string): string {
  if (digest.length <= 14) return digest;
  return `${digest.slice(0, 8)}…${digest.slice(-4)}`;
}

/** Fresh 32-byte nonce, base64 — the NEP-413 payload requires a nonce (replay-scoping ceremony). */
export function newNonceB64(): string {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
}

/** The shape the wallet's `signMessage` resolves to (Meteor/NEP-413). */
export type SignMessageResult = { accountId: string; publicKey: string; signature: string };

/** Assemble the Seal envelope from a signed digest + the wallet's result. Pure — no signing here. */
export function assembleSeal(args: {
  packDigest: string;
  nonceB64: string;
  signed: SignMessageResult;
}): Seal {
  return {
    v: SEAL_VERSION,
    packDigest: args.packDigest,
    nearAccountId: args.signed.accountId,
    publicKey: args.signed.publicKey,
    signatureB64: args.signed.signature,
    nonce: args.nonceB64,
    recipient: SEAL_RECIPIENT,
    message: sealMessage(args.packDigest),
    signedAt: new Date().toISOString(),
  };
}

// The verifier (verifySignature) wants the nonce as a Buffer, same as the portal's nep413 path. This offline
// crypto half runs in the unit test + a server/import verify (both Node) — not in the browser authoring path
// (SealPanel only assembles + downloads), so Buffer is always available where this is actually called.
function nonceBytes(nonceB64: string): Buffer {
  return Buffer.from(nonceB64, "base64");
}

/**
 * The OFFLINE crypto half of seal verification: (1) the message commits to the stated digest, and (2) the
 * signature is a valid ed25519 signature over the NEP-413 payload {message, nonce, recipient} for the
 * stated public key. Does NOT check that the key belongs to the account on-chain — that's the full
 * verifyNep413Proof (server) path. Mirrors the portal's nep413.test keystone: valid verifies, tampered fails.
 */
export function verifySealSignature(seal: Seal): boolean {
  if (!seal || seal.v !== SEAL_VERSION) return false;
  if (seal.recipient !== SEAL_RECIPIENT) return false;
  if (seal.message !== sealMessage(seal.packDigest)) return false;
  try {
    return (
      verifySignature({
        publicKey: seal.publicKey,
        signature: seal.signatureB64,
        message: seal.message,
        nonce: nonceBytes(seal.nonce),
        recipient: seal.recipient,
      }) === true
    );
  } catch {
    return false;
  }
}

/**
 * Verify a seal AGAINST a pack: recompute the pack's digest, confirm the seal signed that exact digest,
 * then run the offline crypto check. This is what proves "this seal belongs to this building" — a tampered
 * pack re-derives a different digest and fails.
 */
export async function verifySealForPack(seal: Seal, pack: Pack): Promise<boolean> {
  const digest = await packDigest(pack);
  if (digest !== seal.packDigest) return false;
  return verifySealSignature(seal);
}
