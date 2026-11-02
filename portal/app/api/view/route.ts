// POST /api/view { method, args }
// → a generic contract-VIEW proxy. The BROWSER calls this same-origin (no CORS, no preflight) and the
// SERVER does the actual RPC read. This replaces the browser calling test.rpc.fastnear.com directly —
// which failed two ways: unkeyed = 429 flood, and keyed `?apiKey=` = CORS-preflight blocked. Routing
// through our origin sidesteps both. Reads only; opaque args. Writes still go via the wallet.
// keyless read trips a rate limit (429/quota), we AUTO-fall-back to a reserve key for a cooldown window
// (lib/fastnear-escalation), log it (which key+email+why), and revert to keyless when calm. So the demo/dev
// rides through a burst without babysitting, spends the minimum, and the owner sees — after — that a reserve
// was touched (⚙ Settings FastNEAR card). If there are NO reserve keys, we stay keyless and surface the
// failure loudly — the signal to attend to it (more caching / the self-hosted indexer).

import { NextResponse } from "next/server";
import { providers } from "near-api-js";
import { CONTRACT_ID, serverProviders, FASTNEAR_KEYLESS, RPC_URLS } from "@/lib/config";
import { countRpc } from "@/lib/rpc-usage";
import { armEscalation, currentEscalationKey } from "@/lib/fastnear-escalation";
import { getCachedView, setCachedView, isCacheable } from "@/lib/view-cache";

// The default providers honor the keyless/pool config (serverProviders → unkeyed when FASTNEAR_KEYLESS).
const PROVIDERS = serverProviders(providers);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const looksRateLimited = (s: string) => /429|rate.?limit|too many|quota/i.test(s);

// Build keyed providers on demand for an escalation key (one per RPC url). Cached per-key so we don't
// reconstruct on every call during a window.
const keyedCache = new Map<string, InstanceType<typeof providers.JsonRpcProvider>[]>();
function keyedProviders(key: string): InstanceType<typeof providers.JsonRpcProvider>[] {
  const hit = keyedCache.get(key);
  if (hit) return hit;
  const headers = { Authorization: `Bearer ${key}` };
  const built = RPC_URLS.map((url) => new providers.JsonRpcProvider({ url, headers }));
  keyedCache.set(key, built);
  return built;
}

async function queryVia(provider: InstanceType<typeof providers.JsonRpcProvider>, method: string, args_base64: string) {
  const res = await provider.query<{ result: number[]; block_height: number; block_hash: string }>({
    request_type: "call_function",
    account_id: CONTRACT_ID,
    method_name: method,
    args_base64,
    finality: "optimistic",
  });
  return Buffer.from(res.result).toString("utf8");
}

export async function POST(req: Request) {
  let body: { method?: string; args?: Record<string, unknown>; fresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const method = body.method?.trim();
  if (!method) return NextResponse.json({ error: "missing_method" }, { status: 400 });
  const args = body.args ?? {};
  const args_base64 = Buffer.from(JSON.stringify(args)).toString("base64");

  // SLICE-2 CACHE (lib/view-cache): serve STABLE reads (roles + config) from our server cache so the
  // role fan-out (get_owner/node/org/peer) stops burning FastNEAR per account × session (the measured
  // key-burn — see view-cache.ts header). A cache hit (including a cached NULL = "unregistered") skips
  // the chain entirely. Only allowlisted methods are cached; everything else falls straight through to
  // the live read below. No RPC is counted on a hit — that's the whole point.
  // FRESH bypass (`{ fresh: true }`, mirrors status-cache's ?fresh): a caller that JUST changed this
  // state (e.g. the owner onboarded an account, then wants it to resolve immediately) passes fresh:true
  // to skip the cache read; the live result below still REWARMS the cache, so the next reader is fast and
  // correct. Without this a freshly-onboarded account could show stale up to the TTL.
  if (body.fresh !== true) {
    const cached = getCachedView(method, args);
    if (cached) return NextResponse.json({ result: cached.value });
  }

  // If an escalation window is already armed, prefer the keyed provider for this call (ride the window).
  const armedKey = await currentEscalationKey();
  const primary = armedKey ? keyedProviders(armedKey) : PROVIDERS;

  // Patient rotate+backoff across the chosen providers.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const provider = primary[attempt % primary.length];
    try {
      const raw = await queryVia(provider, method, args_base64);
      countRpc();
      const result = JSON.parse(raw);
      if (isCacheable(method)) setCachedView(method, args, result); // warm the Slice-2 cache
      return NextResponse.json({ result });
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(200 * 2 ** attempt);
    }
  }

  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);

  // Rate-limited while keyless (and not already riding a keyed window) → AUTO-ESCALATE: arm a reserve key
  // and retry ONCE keyed. If it succeeds, the window stays armed so subsequent calls ride it too.
  if (FASTNEAR_KEYLESS && !armedKey && looksRateLimited(detail)) {
    const key = await armEscalation(`/api/view "${method}": ${detail}`);
    if (key) {
      console.warn(`[vrx][auto-escalate] keyless rate-limited on "${method}" → using a reserve key for the cooldown window. (see ⚙ Settings FastNEAR log)`);
      for (const provider of keyedProviders(key)) {
        try {
          const raw = await queryVia(provider, method, args_base64);
          countRpc();
          const result = JSON.parse(raw);
          if (isCacheable(method)) setCachedView(method, args, result); // warm the Slice-2 cache
          return NextResponse.json({ result });
        } catch {
          /* try next url on the keyed provider */
        }
      }
    } else {
      // No reserve keys to escalate to — stay keyless, make the pain LOUD (the deliberate dev signal).
      console.warn(`[vrx][keyless-ratelimit] "${method}" rate-limited UNKEYED and NO reserve keys configured — attend to it (add a key in ⚙ Settings, more caching, or the self-hosted indexer). detail: ${detail}`);
    }
  }

  return NextResponse.json({ error: "rpc_failed", detail }, { status: 503 });
}
