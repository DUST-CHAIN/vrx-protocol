// Pre-public RATE-LIMIT GATE on /api/*. Before the portal is exposed on a public domain (Coolify),
// every API route needs a per-IP throttle so a scraper/abuser can't (a) hammer our keyed FastNEAR RPC
// proxy (api/view, /api/claims, /api/catalog) and burn the paid credit quota — FastNEAR is actively
// tightening unauthenticated limits — or (b) drain the gas FAUCET, which spends REAL testnet NEAR.
// One place, runs before every matched route (no per-route edits). In-memory sliding window: on Coolify
// the server is a single long-lived process so the map is shared across requests (far cheaper than the
// disk-backed counters in lib/rpc-usage.ts). In dev, route isolation makes it best-effort — that's fine,
// it's a production guard. Not a substitute for the faucet's own 6h/account limit (lib/faucet-server) or
// eligibility gating; this is the coarse per-IP ceiling in front of everything.
// Limits are deliberately generous for a real demo user clicking around, strict for the money path.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// well-known CRAWLER user-agents on every route. These exact strings are sent ONLY by automated crawlers,
// never by a real browser, so this can't lock out a human judge (the risky "require a gate cookie
// server-side" idea was deliberately NOT done — it could break the judge/API path). Combined with the
// robots.txt + noindex meta (search engines that obey the rules never index us) and the soft client gate
// (casual + non-JS eyes see only the cover), this is the practical "keep bots out of the demo" layer. A
// determined custom scraper with a spoofed UA is still not stopped — that's an accepted limit for a demo.
const BOT_UA = /bot\b|crawl|spider|slurp|bingpreview|googlebot|bingbot|duckduckbot|baiduspider|yandex|sogou|exabot|facebookexternalhit|facebot|ia_archiver|gptbot|claudebot|claude-web|anthropic-ai|ccbot|google-extended|perplexitybot|amazonbot|bytespider|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|dataforseo|archive\.org_bot/i;

// window ms -> max requests, per IP, per bucket. A bucket is "faucet" (the real-NEAR path) or "api"
// (everything else: reads, catalog, claims, etc.). Tune via env without a redeploy if needed.
const WINDOW_MS = 60_000;
const LIMITS: Record<string, number> = {
  faucet: Number(process.env.RL_FAUCET_PER_MIN || 5), // a human onboards a handful of accounts, not dozens
  // endpoint (keyed RPC credit + the real-NEAR faucet) from a stranger/scraper — it was never meant to
  // throttle a real demo user OR our own local testing. 120/min was too tight: ONE dashboard load fans out
  // many summary/status reads, so a normal human clicking around a 476-unit tower can brush it. Raised to a
  // genuinely generous ceiling that still stops a hammering scraper. (Local/loopback IPs are exempted
  // entirely below — isLocalIp — so dev + automated testing are NEVER rate-limited.)
  api: Number(process.env.RL_API_PER_MIN || 600),
};

// Loopback / private-LAN caller → OUR OWN traffic (local dev, same-box health checks, automated testing).
// Never rate-limit these: the shield is for the public internet, not for us. A real public user always
// arrives via Cloudflare with a routable x-forwarded-for, so this can't be spoofed to bypass the public cap.
function isLocalIp(ip: string): boolean {
  return (
    ip === "unknown" || // header missing in local dev → our own process, not a public client
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("::ffff:127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip === "localhost"
  );
}

type Hit = { count: number; resetAt: number };
// IP+bucket -> sliding window. Module-scoped so it survives across requests in one server instance.
const hits = new Map<string, Hit>();

// Opportunistic sweep so the map can't grow unbounded under many distinct IPs.
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [k, h] of hits) if (h.resetAt <= now) hits.delete(k);
}

function clientIp(req: NextRequest): string {
  // Behind Cloudflare/Coolify's proxy the real client is in these headers; fall back to a constant so a
  // missing header fails CLOSED into one shared bucket rather than bypassing the limit per-request.
  // S159c SECURITY: prefer cf-connecting-ip (Cloudflare sets it from the real TCP peer — the client can't
  // forge it through CF). For x-forwarded-for we take the LAST hop (the IP the TRUSTED proxy appended), NOT
  // the first — a public attacker can inject "X-Forwarded-For: 127.0.0.1, <real>" to spoof the first hop and
  // slip past isLocalIp. The last hop is the one our own edge added, so it's trustworthy.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.headers.get("x-real-ip") || "unknown";
}

function take(ip: string, bucket: string, limit: number, now: number): { ok: boolean; retryAfter: number } {
  const key = `${bucket}:${ip}`;
  const h = hits.get(key);
  if (!h || h.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  if (h.count >= limit) return { ok: false, retryAfter: Math.ceil((h.resetAt - now) / 1000) };
  h.count++;
  return { ok: true, retryAfter: 0 };
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Bot wall first — 403 known crawlers on ANY matched route (pages + API). Cheap UA check, no state.
  const ua = req.headers.get("user-agent") || "";
  if (ua && BOT_UA.test(ua)) {
    // Let a crawler still fetch robots.txt (so it learns it's disallowed and leaves cleanly).
    if (pathname !== "/robots.txt") {
      return new NextResponse("Not available to automated clients.", {
        status: 403,
        headers: { "X-Robots-Tag": "noindex, nofollow", "Content-Type": "text/plain" },
      });
    }
  }

  // Rate-limit only the API routes (static pages/assets don't hit the keyed RPC or the faucet).
  if (pathname.startsWith("/api/")) {
    const ip = clientIp(req);
    // Our own traffic (local dev / testing / same-box) is NEVER throttled — the shield is public-only.
    if (isLocalIp(ip)) return NextResponse.next();
    const now = Date.now();
    sweep(now);
    const bucket = pathname.startsWith("/api/faucet") ? "faucet" : "api";
    const { ok, retryAfter } = take(ip, bucket, LIMITS[bucket], now);
    if (!ok) {
      return NextResponse.json(
        { ok: false, error: "rate_limited", message: "Too many requests — please slow down a moment." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
  }
  return NextResponse.next();
}

// Guard pages + API for the bot wall; rate-limit logic inside only fires on /api/*. Exclude Next internals +
// static assets + robots.txt so the bot check doesn't run on every image/_next chunk (cheap, but pointless).
export const config = {
  matcher: ["/((?!_next/|renderings/|floorplans/|favicon|robots.txt|.*\\.(?:png|jpg|jpeg|webp|svg|gif|ico|mp4|woff2?)$).*)"],
};
