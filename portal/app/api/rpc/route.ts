// POST /api/rpc — a KEYED JSON-RPC proxy for the browser WALLET's write path.
//
// THE PROBLEM: @near-wallet-selector (lib/wallet.tsx) talks to the network's DEFAULT public RPC
// DIRECTLY from the browser for WRITES (signAndSendTransaction, access-key nonce/block reads). On the
// free FastNEAR tier that shared-IP path 429s under load + is CORS-fragile → book/accept/decline failed
// . Our read path is cached/keyed server-side, but the wallet bypasses all of it.
//
// THE FIX: the wallet points its `nodeUrl` at THIS route. The browser calls our own origin (no CORS
// issue), and we forward the JSON-RPC to FastNEAR server-side WITH our bearer key (hidden from the
// browser) — keyed = no shared-IP 429. We rotate across the key pool + endpoints on a rate-limit.
//
// KEYING (the call): keyed for the WALLET write path specifically — here a 429 is a hard blocker,
// not the useful dev signal the keyless-by-default policy wants on the READ path. Reads stay
// keyless; only this proxy attaches a key.
//
// Safe passthrough: we forward the raw JSON-RPC body unchanged and return the upstream response as-is.
// No method allow-listing — wallet-selector issues standard methods (query, broadcast_tx_*, block,
// status, gas_price, tx). We never sign here; the wallet already signed. We only relay bytes + a key.

import { NextResponse } from "next/server";
import { RPC_URLS } from "@/lib/config";
import { activeKeys } from "@/lib/fastnear-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A rate-limit / quota signal worth rotating the key or endpoint on.
function isRateLimited(status: number, bodyText: string): boolean {
  if (status === 429 || status === 503) return true;
  const b = bodyText.toLowerCase();
  return b.includes("rate limit") || b.includes("quota") || b.includes("too many requests");
}

export async function POST(req: Request) {
  // Read the raw JSON-RPC body once so we can replay it across endpoints/keys.
  const body = await req.text();

  // Build the (endpoint × key) attempt list: each active key against each RPC url, plus a final
  // unkeyed attempt per url as a last resort. Keys first so a keyed attempt is tried before unkeyed.
  const keys = (await activeKeys()).map((k) => k.key);
  const attempts: Array<{ url: string; key: string | null }> = [];
  for (const key of keys) for (const url of RPC_URLS) attempts.push({ url, key });
  for (const url of RPC_URLS) attempts.push({ url, key: null }); // unkeyed fallback

  let lastStatus = 502;
  let lastText = '{"error":"no upstream reachable"}';

  for (const { url, key } of attempts) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const upstream = await fetch(url, {
        method: "POST",
        headers,
        body,
        // Don't let a single slow node hang the wallet; wallet-selector will retry the call.
        signal: AbortSignal.timeout(20_000),
      });
      const text = await upstream.text();

      // On a rate-limit/quota, rotate to the next key/endpoint rather than returning the 429.
      if (isRateLimited(upstream.status, text)) {
        lastStatus = upstream.status;
        lastText = text;
        continue;
      }

      // Success (or a genuine JSON-RPC error that isn't rate-limiting) — relay verbatim.
      return new NextResponse(text, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      lastStatus = 502;
      lastText = JSON.stringify({ error: "upstream fetch failed", detail: String(e).slice(0, 200) });
      // try the next attempt
    }
  }

  // Every attempt rate-limited or failed — surface the last upstream status so the wallet can retry.
  return new NextResponse(lastText, {
    status: lastStatus,
    headers: { "Content-Type": "application/json" },
  });
}
