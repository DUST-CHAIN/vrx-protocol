// MM-local DeepSeek caller — CLIENT twin of ai-client-server.ts (the carried owed-item (a)). The
// browser calls DeepSeek DIRECTLY with the user's OWN key (localStorage mm.key.deepseek), the same posture as
// the Gemini image stage: the hosted static export (/vrx/mm) has NO server API route, so the text stage must
// run client-side or it 404s. DeepSeek's API is OpenAI-compatible and CORS-enabled for browser clients (same
// as the OpenAI endpoint), so a plain fetch from the page works.
//
// Key: the user's pasted/saved DeepSeek key ONLY — there is no server env fallback here (there's no server).
// The key is read transiently per call, never logged. Same AskResult shape + fail-soft discipline as the
// server twin, so the /ai page can swap `fetch("/api/ai-build")` → askWithSystemClient with no other change.

import type { ChatMessage, AskResult } from "./ai-client-server";

const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-chat";

/** Call DeepSeek from the BROWSER with the user's own key. Fail-soft (no_key / upstream), never throws. */
export async function askWithSystemClient(
  systemPrompt: string,
  messages: ChatMessage[],
  opts?: { signal?: AbortSignal; temperature?: number; maxTokens?: number; apiKey?: string },
): Promise<AskResult> {
  const key = (opts?.apiKey || "").trim();
  if (!key) return { ok: false, error: "no_key" };
  try {
    const r = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        max_tokens: opts?.maxTokens ?? 2000,
        temperature: opts?.temperature ?? 0.4,
        stream: false,
      }),
      signal: opts?.signal,
    });
    if (!r.ok) return { ok: false, error: "upstream" };
    const j = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const answer = j.choices?.[0]?.message?.content?.trim();
    if (!answer) return { ok: false, error: "upstream" };
    return { ok: true, answer, tokens: j.usage?.total_tokens ?? 0 };
  } catch {
    return { ok: false, error: "upstream" };
  }
}
