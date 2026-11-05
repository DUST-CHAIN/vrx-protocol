// /api/kyc-vault/unlock — the OPERATOR unlock session for the KYC vault (Tier 2).
//
//   GET                       → { unlocked, via?, provisioned } vault status (NO key material, ever).
//   POST { key }              → unseal the KEK into server memory for this process using the operator
//                               X25519 PRIVATE key (base64 PKCS8 DER). Bootstraps the sealed KEK against
//                               this operator on first run. Wrong/garbled key → does NOT unlock.
//   POST { op: "lock" }       → wipe the in-memory KEK (operator sign-out / panic) → back to locked at rest.
//
// SECURITY: the operator private key is NEVER persisted by this route — it lives only long enough to open
// the sealed KEK into memory, then is dropped. A restart re-locks the server. In production the server stays
// LOCKED until this route is called; in dev / with VRX_KYC_OPERATOR_KEY the vault auto-unlocks on first use
// (see lib/kyc-vault-key.ts). This route is intentionally minimal — a real deploy should put it behind the
// operator's own auth boundary (out of scope for the current no-wallet/ phase).

import { NextResponse } from "next/server";
import { vaultStatus, unlockWithKey, lockVault } from "@/lib/kyc-vault-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await vaultStatus());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  if (body.op === "lock") {
    lockVault();
    return NextResponse.json(await vaultStatus());
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) return NextResponse.json({ error: "operator key required (base64 X25519 PKCS8)" }, { status: 400 });

  try {
    const status = await unlockWithKey(key);
    return NextResponse.json(status);
  } catch {
    // Malformed key OR a valid key that doesn't open the existing seal (wrong operator) → stay locked.
    return NextResponse.json({ error: "could not unlock — key invalid or not this vault's operator" }, { status: 401 });
  }
}
