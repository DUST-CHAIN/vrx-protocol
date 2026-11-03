// MM-by-AI text stage — server route. Runs ONLY the DeepSeek call (the key must stay server-side); the client
// does the rest (assembleBuildingPack + validate + toZip) so uploaded reference images never leave the browser.
//
// POST { blurb: string, area?: string, stories?: number }  ->  { ok: true, spec } | { ok: false, error }
// The returned `spec` is an AiBuildingSpec the client expands with mm/lib/ai-build.assembleBuildingPack.

import { NextResponse } from "next/server";
import { askWithSystem } from "@/lib/ai-client-server";
import { AI_BUILD_SYSTEM_PROMPT, buildSpecMessages, parseSpec } from "@/lib/ai-build";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { blurb?: string; area?: string; stories?: number; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const blurb = (body.blurb || "").trim();
  if (!blurb) return NextResponse.json({ ok: false, error: "no_blurb" }, { status: 400 });

  const hints = {
    area: typeof body.area === "string" && body.area.trim() ? body.area.trim() : undefined,
    stories: Number.isFinite(body.stories) ? Number(body.stories) : undefined,
  };

  // The user may PASTE a DeepSeek key in the UI (used transiently for this request only; never stored/logged).
  // For our testing now, the deploy env key (DEEPSEEK_API_KEY) is the fallback.
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;

  const res = await askWithSystem(AI_BUILD_SYSTEM_PROMPT, buildSpecMessages(blurb, hints), {
    temperature: 0.4,
    maxTokens: 2000,
    apiKey,
  });

  if (!res.ok) {
    // no_key -> the deploy hasn't set DEEPSEEK_API_KEY; upstream -> model fault. Both fail-soft for the client.
    const status = res.error === "no_key" ? 503 : 502;
    return NextResponse.json({ ok: false, error: res.error }, { status });
  }

  const spec = parseSpec(res.answer);
  if (!spec) return NextResponse.json({ ok: false, error: "parse_failed" }, { status: 502 });

  return NextResponse.json({ ok: true, spec, tokens: res.tokens });
}
