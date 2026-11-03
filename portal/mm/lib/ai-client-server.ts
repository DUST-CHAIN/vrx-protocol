// MM-local DeepSeek caller — server-only (MM is a standalone Next app on :3021; it must NOT reach into the
// main portal's lib, so it carries its own minimal transport). Same shape + fail-soft discipline as the main
// portal's lib/ai-help-server.askWithSystem: OpenAI-compatible, key from env, returns ok:false on any fault.
//
// Used by app/api/ai-build/route.ts to run the MM-by-AI text stage (AI_BUILD_SYSTEM_PROMPT -> a BuildingSpec).
// Key: process.env.DEEPSEEK_API_KEY — server-only, never NEXT_PUBLIC_, never committed. Base URL + model are
// env-overridable so a deploy can retune without a code change.

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskResult =
  | { ok: true; answer: string; tokens: number }
  | { ok: false; error: "no_key" | "upstream" };

/** Call DeepSeek with a system prompt + messages. Server-only (reads the key from env). Fail-soft. */
export async function askWithSystem(
  systemPrompt: string,
  messages: ChatMessage[],
  opts?: { signal?: AbortSignal; temperature?: number; maxTokens?: number; apiKey?: string },
): Promise<AskResult> {
  // Key precedence: a per-request key the user PASTED in the UI (opts.apiKey) wins; else the deploy env key.
  // The pasted key is used transiently for THIS request only — never stored, never logged, never committed.
  const key = (opts?.apiKey || "").trim() || process.env.DEEPSEEK_API_KEY;
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
