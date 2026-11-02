// Shared god-mode fence predicate (extracted after the subagent audit found the
// client/server fences were reading RPC from DIFFERENT sources). Pure, no "use client", no near-api-js:
// safe to import from BOTH the client signer (lib/dev-signer.ts) and the server route
// (app/api/dev-keys/route.ts), so the two halves of the fence are provably identical.

import { RPC_URL } from "./config";

export const LOCAL_SIGNER_FLAG = process.env.NEXT_PUBLIC_VRX_LOCAL_SIGNER === "1";

// PUBLIC DEMO (sandbox) flag — DISTINCT from the localnet god-mode fence above. The public demo runs
// a SNAPSHOT-browse world with NO localnet, so the hard localnet fence (godModeArmed) is deliberately OFF
// there. This flag arms ONLY the wallet-less "assume a role" demo UX (the landing role-picker + the
// RoleProvider demo-role override) — it NEVER arms the raw-key signer (that stays fenced to localnet:3030,
//). So: on a public snapshot demo set NEXT_PUBLIC_VRX_DEMO=1 (writes are simulated/stubbed, no chain);
// on a real wallet deploy leave it unset. The two flags are independent on purpose — demo-UX ≠ raw signing.
export const DEMO_MODE_FLAG = process.env.NEXT_PUBLIC_VRX_DEMO === "1";

/** Is the given RPC url a localnet loopback on :3030? (the ONLY place god-mode may run) */
export function isLocalnetRpc(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    return loopback && u.port === "3030";
  } catch {
    return false;
  }
}

/**
 * The fence verdict WITHOUT the fail-loud throw — a pure boolean both halves share.
 * True only when god-mode is opted-in AND pointed at localnet:3030. The client wraps this with a
 * fail-loud throw (see dev-signer.ts isLocalGodMode); the server uses it directly for a plain 403.
 */
export function godModeArmed(): boolean {
  return LOCAL_SIGNER_FLAG && isLocalnetRpc(RPC_URL);
}

/**
 * Is the wallet-less DEMO role-assume UX armed? True when EITHER the public-demo flag is set (snapshot
 * sandbox, no localnet) OR real localnet god-mode is armed (local dev). This is what the landing picker +
 * the RoleProvider demo-role override gate on — NOT raw signing (that remains godModeArmed-only).
 */
export function demoRoleUxArmed(): boolean {
  return DEMO_MODE_FLAG || godModeArmed();
}
