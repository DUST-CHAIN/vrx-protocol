// REAL OTS PROVIDER (D-) — the live OpenTimestamps provider that drops into the ots-anchor queue's
// provider seam, replacing the deterministic stub. PORTED from the sibling project IdeaForge's chain/ots.ts
// (pure `javascript-opentimestamps` calls — no DB, no Postgres), adapted to VRX's seam:
//   - VRX stores the proof as a base64 STRING (ots-anchor.OtsAnchor.otsProof), not a Buffer. This module is the
//  ONLY place Buffer↔base64 conversion happens (Trap 2 of the adversarial pass): decode on the way IN,
//     encode on the way OUT, Buffers stay internal.
//   - VRX's upgrade seam is `upgrade(itemHash, proof)` — the itemHash is REQUIRED (Trap 1): OpenTimestamps'
//     `verify` must re-derive the original detached timestamp from the hash to confirm which Bitcoin attestation
//     the proof carries. The proof blob alone cannot prove itself.
//
// ── WHY `.server.ts` (Trap 4) ───────────────────────────────────────────────────────────────────────────────
// `javascript-opentimestamps` is a CommonJS lib pulling in node:crypto + bitcoin tooling. It must NEVER reach a
// client bundle. The `.server.ts` suffix + loading it via createRequire + importing this module ONLY through a
// server-side dynamic import (see ensureRealOtsProvider in ots-bootstrap.server.ts) keeps Next's bundler from
// ever tree-shaking or edge-bundling it. This module has no "use client" and no React — server-only by shape.
//
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────────
// Only the opaque 32-byte sha256 is ever sent to the calendar servers — never content, amounts, or PII. This is
// the whole point: a hash reveals nothing; the Bitcoin anchor proves "this hash existed at time T" to anyone,
// without VRX still existing and without exposing what was anchored.

import { createRequire } from "node:module";
import type { OtsProvider } from "./ots-anchor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ots: any;
function ots() {
  if (!_ots) {
    // createRequire so the CommonJS lib loads under both Next's server bundle and tsx smoke scripts.
    const require = createRequire(import.meta.url);
    _ots = require("javascript-opentimestamps");
  }
  return _ots;
}

/** Build a detached timestamp directly from a hex sha256 (no file I/O). Mirrors IdeaForge's detachedFromSha256. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detachedFromSha256(sha256: string): any {
  const O = ots();
  const hashBytes = Buffer.from(sha256, "hex");
  if (hashBytes.length !== 32) {
    throw new Error(`OTS expects a 32-byte sha256 (64 hex chars), got ${hashBytes.length} bytes`);
  }
  return O.DetachedTimestampFile.fromHash(new O.Ops.OpSHA256(), hashBytes);
}

/** node Buffer → the Uint8Array view the library's deserialize expects. */
function toUint8(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * The real OTS provider, conforming to the VRX queue's `OtsProvider` seam.
 *
 * ⚠ The queue stamps the `itemHash` the emitter handed it. For a REAL OTS proof to verify, that itemHash MUST be
 * a hex sha256 (OTS hashes the 32 bytes). VRX's seal hashes (lib/seal — sha256 hex) satisfy this. If an emitter
 * ever queues a non-sha256 itemHash, `submit` throws (caught by the worker → retried → marked failed past the
 * budget), which is the honest outcome: the in-system record still stands, only the OTS assurance is unavailable.
 */
export function createRealOtsProvider(): OtsProvider {
  return {
    async submit(itemHash) {
      try {
        const detached = detachedFromSha256(itemHash);
        // Submits to the default public calendar servers (a/b.pool.opentimestamps.org, …). Returns immediately
        // with an INCOMPLETE proof (calendar commitment); Bitcoin confirmation comes later, via upgrade.
        await ots().stamp(detached);
        const proofB64 = Buffer.from(detached.serializeToBytes()).toString("base64");
        return { ok: true, proof: proofB64 };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async upgrade(itemHash, proof) {
      const O = ots();
      let proofBuf: Buffer;
      try {
        proofBuf = Buffer.from(proof, "base64");
      } catch {
        return { proof, provenAt: null }; // unreadable stored proof → leave pending; a resubmit would be the fix
      }
      try {
        const detached = O.DetachedTimestampFile.deserialize(toUint8(proofBuf));
        // upgrade asks the calendars whether a Bitcoin attestation is now available to fold in. Returns true if
        // the proof grew. Either way we re-serialize (it may have grown even if not yet Bitcoin-complete).
        await O.upgrade(detached);
        const grownB64 = Buffer.from(detached.serializeToBytes()).toString("base64");
        // VERIFY against the original hash (Trap 1): this is the reliable "is it Bitcoin-complete?" check — it
        // returns the block time only when a real Bitcoin attestation exists. A grown-but-not-yet-confirmed proof
        // returns null → stays pending (the normal hours-long state).
        const provenAt = await verifyBlockTime(itemHash, grownB64);
        return { proof: grownB64, provenAt };
      } catch {
        // Calendar unreachable / transient — keep the existing proof, stay pending; the worker retries next tick.
        return { proof, provenAt: null };
      }
    },
  };
}

/**
 * Verify a stored base64 .ots proof against its original hash. Returns the Bitcoin block time (ms epoch) when the
 * proof is Bitcoin-complete, else null (still only calendar-attested). Used by `upgrade` to decide `proven`.
 * Exported for the live smoke test.
 */
export async function verifyBlockTime(itemHash: string, proofB64: string): Promise<number | null> {
  const O = ots();
  try {
    const original = detachedFromSha256(itemHash);
    const detachedOts = O.DetachedTimestampFile.deserialize(toUint8(Buffer.from(proofB64, "base64")));
    const result = await O.verify(detachedOts, original);
    // The library returns attestations keyed by chain; `bitcoin.timestamp` is seconds since epoch when present.
    const ts = result?.bitcoin?.timestamp;
    return typeof ts === "number" ? ts * 1000 : null;
  } catch {
    return null;
  }
}
