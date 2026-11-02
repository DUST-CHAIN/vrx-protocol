# vettedrealty.com — public overview site

A static marketing/overview site for **VRX / Vetted Realty**. Separate from the app (`../portal`),
with its own toolchain. One long layered page that works for every audience — landowners, developers,
agencies, agents, buyers — plus an investor/reviewer-grade Vision section, a wikipedia-style glossary
(hover any underlined term), and a contact form.

## Stack
- **Astro** (static output). Brand tokens mirror `../portal/lib/theme.ts` so site + product look like one brand.
- Content is data-driven: `src/data/roles.ts` (per-role sections) and `src/data/glossary.ts` (terms + popups).
- `public/contact.php` — the contact-form handler for the Hetzner shared PHP host.

## Run / build
```powershell
cd site
npm install        # once
npm run dev        # http://localhost:4321
npm run build      # → dist/   (this is what you upload)
```

## Deploy (Hetzner shared hosting)
1. Generate the images per **`IMAGE_PROMPTS.md`** and drop them into `public/img/` (exact filenames).
2. `npm run build`.
3. Upload the **contents of `dist/`** to the vettedrealty.com web root (replacing the current site).
   `dist/` already includes `contact.php`, which the form POSTs to — PHP mail() sends to vrx@vettedrealty.com.

## Editing content
- Change a role's copy → `src/data/roles.ts`.
- Add/adjust a glossary term (and its hover-popup) → `src/data/glossary.ts`; use it inline as `<Term k="key" />`.
- Section order / hero / vision / roadmap copy → `src/pages/index.astro`.

## AI assistant (live)
A floating "Ask VRX" chat bubble is mounted site-wide (`src/components/AssistantWidget.astro`),
backed by a streaming DeepSeek PHP proxy (`public/assistant/assistant.php`). duck.ai-style mobile
keyboard handling, single conversation, token-by-token streaming. **Token-saver:** common questions
answer instantly from a local canned FAQ (`src/data/assistant-faq.ts`) with zero API calls — only
misses hit DeepSeek (cheap `deepseek-chat`, no reasoning). Setup + cost guards: see
`public/assistant/README.md`. On the server, `cp secret.php.example secret.php` and paste the key
(gitignored, never committed). The assistant needs PHP (works on the host, not in a file:// preview);
the canned answers work anywhere.

## Notes
- No PII, no deal terms, no testnet account IDs, no names of prospects anywhere — privacy by design.
- Everything deploys as a static `dist/` (relative paths) + the `assistant/` PHP folder on the host.
