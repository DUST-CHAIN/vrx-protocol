// POST /api/ai-help { messages: [{role, content}...] }
//
// The DeepSeek-backed half of the help widget. Flow:
//   1. Resolve the caller IP (same header logic as middleware.ts — cf-connecting-ip, else last x-forwarded-for
//      hop, so a public client can't forge a local IP).
//   2. Check the per-IP daily cap + the HARD global daily token ceiling (lib/ai-help-server). If capped, return
//      ok:false {reason} with 200 — the client shows the free pre-written help instead. FAILS CLOSED: a capped
//      or mis-configured (no key) state never spends and never errors the user.
//   3. Otherwise call DeepSeek (server-only key), record the token cost against the global tally, return the
//      answer. On any upstream fault, also fall back (ok:false) so the widget degrades to free help, never a
//      broken network error.
//
// The coarse per-IP request throttle in middleware.ts still fronts this route; THIS adds the spend ceiling the
// middleware can't (it counts requests, not tokens). Key never reaches the client bundle.

import { NextResponse } from "next/server";
import { checkLimit, recordUsage, askDeepSeek, type ChatMessage } from "@/lib/ai-help-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Guardrails on the inbound conversation so a client can't push a huge/garbage payload at DeepSeek (= spend).
const MAX_MESSAGES = 12; // a short help chat, not a long session
const MAX_CHARS = 2_000; // per message

function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.headers.get("x-real-ip") || "unknown";
}

function sanitize(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const msgs = raw.slice(-MAX_MESSAGES); // keep only the most recent turns
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string" || !content.trim()) return null;
    out.push({ role, content: content.slice(0, MAX_CHARS) });
  }
  // Must end on a user turn (we're answering the latest user message).
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const messages = sanitize((body as { messages?: unknown }).messages);
  if (!messages) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  const ip = clientIp(req);

  // Spend/abuse gate — fails CLOSED into the free-help fallback (never an error to the user).
  const decision = await checkLimit(ip);
  if (!decision.allow) {
    return NextResponse.json({ ok: false, reason: decision.reason, fallback: true });
  }

  const result = await askDeepSeek(messages);
  if (!result.ok) {
    // no_key / upstream fault → fall back to free help; nothing was spent.
    return NextResponse.json({ ok: false, reason: result.error, fallback: true });
  }

  await recordUsage(ip, result.tokens);
  return NextResponse.json({ ok: true, answer: result.answer });
}
