// GET /api/dev-keys  → { keys: { "<accountId>": "ed25519:<secret>" } }
//
// DEV-ONLY, LOCALNET-ONLY key server for the god-mode local signer. Serves the demo
// account keypairs written by scripts/provision-localnet.mjs to portal/.data/dev-keys.json so the
// browser-side dev signer can sign walletlessly against localnet :3030.
//
// ⚠️ SERVER-SIDE HALF OF THE HARD FENCE (lib/dev-signer.ts has the client half). This route returns
// 403 and serves NOTHING unless BOTH hold:
//   (1) NEXT_PUBLIC_VRX_LOCAL_SIGNER === "1"  (same opt-in flag, readable server-side too), AND
//   (2) the active RPC (NEXT_PUBLIC_NEAR_RPC) is a localnet loopback on :3030.
// Double-fenced so neither the client flag nor the server alone is the whole gate — a key file can
// never be served by a real deployment even if the file somehow exists there.

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { godModeArmed } from "@/lib/dev-signer-fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side fence verdict. Never throws — a blocked request is a plain 403.
 *
 * IMPORTANT (audit fix): this uses the SHARED `godModeArmed` predicate from the pure
 * dev-signer-fence module — the EXACT SAME flag + resolved config.RPC_URL + isLocalnetRpc that the
 * client fence (lib/dev-signer.ts isLocalGodMode) reads. The earlier version re-read the raw env var
 * `process.env.NEXT_PUBLIC_NEAR_RPC` here (no fallback) while the client checked config.RPC_URL (with
 * a testnet fallback), so the two halves could disagree. One source → "a matching server-side fence"
 * is now literally true.
 */
function fenceOpen(): boolean {
  return godModeArmed();
}

export async function GET() {
  if (!fenceOpen()) {
    return NextResponse.json(
      { ok: false, error: "dev-keys disabled (localnet god-mode fence closed)" },
      { status: 403 }
    );
  }
  const file = path.join(process.cwd(), ".data", "dev-keys.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { keys?: Record<string, string> };
    return NextResponse.json({ ok: true, keys: parsed.keys ?? {} });
  } catch {
    return NextResponse.json(
      { ok: false, error: "no dev-keys.json — run scripts/provision-localnet.mjs first", keys: {} },
      { status: 404 }
    );
  }
}
