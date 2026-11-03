# VRX site assistant (`assistant.php`)

The floating "Ask VRX" chat on the site. A static page can't hold an API key, so the browser POSTs
to this tiny PHP proxy, which calls **DeepSeek** server-side and **streams** the reply back. The key
never reaches the browser. Ported from the mature `smart-flow-chat/ask/ask.php` proxy.

## Deploy (PHP shared hosting — e.g. vettedrealty.com)
1. Upload the whole `assistant/` folder with the rest of `dist/` to the web root.
2. On the server: `cp secret.php.example secret.php`, then paste your DeepSeek key and lock
   `ALLOWED_ORIGINS` to the real site origin(s). **`secret.php` is gitignored — never commit it.**
3. Done. The widget calls `./assistant/assistant.php` (relative), so it works wherever `dist/` lands.

## Cost / token discipline (built in)
- **Canned FAQ first (biggest saver):** common questions are answered INSTANTLY in the browser from
  `src/data/assistant-faq.ts` with **zero** API call. Only genuine misses reach DeepSeek. The 4
  suggestion chips are canned questions → free.
- **Cheap model, no reasoning:** `deepseek-chat` (not `deepseek-reasoner`) — no thinking tokens.
- **Bounded per call:** input capped (600 chars), reply capped (`max_tokens` 500), short rolling
  history window (last 8 turns) so context never balloons.
- **Per-IP rate limits:** cooldown (2s) + hourly (20) + daily (80), file-based in the system temp dir.
- **Describe-only prompt:** refuses off-topic/general-chatbot use, won't invent features/prices/dates,
  ignores prompt-injection, and declines pricing/acquisition/founder questions (points to a human).
- **CORS allow-list:** only your site origin may call the proxy.

## Tuning
Edit the caps at the top of `assistant.php` (`$MAX_INPUT`, `$MAX_TOKENS`, `$RATE_HOUR`, …).
Add/adjust canned answers in `src/data/assistant-faq.ts` (then rebuild) — the more good canned
answers, the fewer paid calls.

## Local note
PHP/DeepSeek only runs on the server. In a `file://` or `npm run dev` preview the widget UI works,
but a live question will show a friendly "couldn't reach the assistant" message — expected.
Canned-FAQ answers DO work locally (no server needed).
