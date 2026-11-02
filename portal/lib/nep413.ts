// NEP-413 signature verifier — SERVER-ONLY (F1 signing arc).
// WHY THIS EXISTS: today every off-chain API route trusts a CLIENT-SUPPLIED identity param
//  audit; the known demo-layer caveat documented in lib/participant.ts). F1 makes identity PROVABLE:
// the client signs a server-issued challenge with its wallet key off-chain (NEP-413 signMessage), and
// this module verifies (a) the signature is valid over the exact payload, and (b) the signing key is a
// FULL-ACCESS key actually belonging to the claimed account on-chain. Only then is the caller trusted.
// Nothing on-chain changes — the contract already enforces the REAL booking authority. This is the
// OFF-CHAIN auth layer: it turns Security Pass #3's scoping GUARD into a hard guarantee.
// CRYPTO REUSE (deliberate): the Borsh payload + ed25519 check are done by @near-wallet-selector/core's
// own `verifySignature` — the SAME code the client uses to produce the signature — so the two halves are
// provably byte-compatible (tag 2147484061, payloadSchema, sha256, PublicKey.verify). We do NOT re-derive
// the serialization here; a drift between client-sign and server-verify would be a silent auth hole. We
// DO our own full-access-key lookup (not the library's) so it goes through the repo's keyed providers
// (serverProviders — dodges the shared-IP 429) and respects localnet in god-mode.

import { providers } from "near-api-js";
import { verifySignature } from "@near-wallet-selector/core";
import { serverProviders, RPC_URL } from "./config";
import { godModeArmed } from "./dev-signer-fence";

/** What the client returns from wallet.signMessage + the challenge it signed. All strings are as the
 * wallet emits them (publicKey "ed25519:…", signature base64). nonce is the 32-byte challenge, base64. */
export type Nep413Proof = {
  accountId: string;
  publicKey: string;
  signature: string;
  /** The challenge the client signed, exactly as issued by /api/session (base64 of 32 random bytes). */
  nonce: string;
  /** Must equal the recipient the server issued (binds the proof to THIS app). */
  recipient: string;
  message: string;
  callbackUrl?: string;
};

export type VerifyResult =
  | { ok: true; account: string }
  | { ok: false; reason: "bad_signature" | "key_not_owned" | "rpc_error" };

/** The recipient string the challenge is bound to — a constant identifying this app (NOT secret). A proof
 * signed for a different recipient (another dApp) won't verify here, preventing cross-app replay. */
export const SESSION_RECIPIENT = "vrx-portal";

// Confirm `publicKey` is a FULL-ACCESS key on `accountId` on-chain. A valid signature from a key that
// doesn't belong to the account (or a function-call-only key) must NOT authenticate the account. Tried
// across the keyed provider pool so a single-endpoint 429 doesn't wrongly fail-closed. Throws → rpc_error
// (fail closed), distinct from a definitive "key is not full-access" (returns false).
async function keyBelongsToAccount(accountId: string, publicKey: string): Promise<boolean> {
  const pool = serverProviders(providers);
  let lastErr: unknown;
  for (let attempt = 0; attempt < Math.max(pool.length, 3); attempt++) {
    const provider = pool[attempt % pool.length];
    try {
      const res = await provider.query<{ permission: unknown; block_height: number; block_hash: string }>({
        request_type: "view_access_key",
        account_id: accountId,
        public_key: publicKey,
        finality: "optimistic",
      });
      // Full-access keys report permission === "FullAccess" (a string); function-call keys report an
      // object { FunctionCall: {...} }. Only a full-access key may authenticate the whole account.
      return res?.permission === "FullAccess";
    } catch (e) {
      // A genuinely-absent key throws an UnknownAccessKey error — that's a definitive "no", not an outage.
      const msg = String((e as { type?: string })?.type ?? e);
      if (/UnknownAccessKey|does not exist|access key .* not found/i.test(msg)) return false;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("view_access_key: all providers failed");
}

/**
 * Verify a NEP-413 proof end to end. Returns the proven account on success. The caller (the /api/session
 * handshake) must ALSO confirm the nonce/recipient it issued match this proof — this function checks the
 * cryptography + key ownership, not nonce freshness (that's session state, handled in lib/session.ts).
 *
 * GOD-MODE: on localnet with the dev signer armed there is no real wallet, so there's no signature to
 * verify — god-mode callers never reach here (the handshake short-circuits). This function stays strict:
 * it ALWAYS requires a real, owned signature, so it can never be the weak link even if called directly.
 */
export async function verifyNep413Proof(proof: Nep413Proof): Promise<VerifyResult> {
  const account = proof.accountId.trim().toLowerCase();
  if (!account || !proof.publicKey || !proof.signature || !proof.nonce) {
    return { ok: false, reason: "bad_signature" };
  }

  // 1) Signature valid over the exact payload? (reuse the client's own serializer — byte-identical)
  let sigOk = false;
  try {
    sigOk = verifySignature({
      publicKey: proof.publicKey,
      signature: proof.signature,
      message: proof.message,
      nonce: Buffer.from(proof.nonce, "base64"),
      recipient: proof.recipient,
      callbackUrl: proof.callbackUrl,
    });
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "bad_signature" };

  // 2) Does that key actually belong to the claimed account, full-access, on-chain?
  try {
    const owned = await keyBelongsToAccount(account, proof.publicKey);
    if (!owned) return { ok: false, reason: "key_not_owned" };
  } catch {
    return { ok: false, reason: "rpc_error" }; // fail closed on an RPC outage
  }

  return { ok: true, account };
}

/** Which network the verifier is pointed at (surfaced for the handshake's logging / god-mode note). */
export function verifierNetwork(): { rpc: string; godMode: boolean } {
  return { rpc: RPC_URL, godMode: godModeArmed() };
}
