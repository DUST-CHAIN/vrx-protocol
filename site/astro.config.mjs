import { defineConfig } from "astro/config";

// Static site. Output goes to dist/ — upload to the Hetzner shared host (vettedrealty.com).
// contact.php ships alongside in public/ so the form works on PHP shared hosting.
export default defineConfig({
  site: "https://vettedrealty.com",
  // Served under /vrx/ on the shared host. We DON'T set `base` — instead scripts/relativize.mjs
  // rewrites every root-absolute ref (/_astro/…, /img/…) to RELATIVE (./_astro/…./img/…) post-build,
  // so dist drops into the `vrx/` folder (or any folder, or file://) and all assets resolve. `base:"/vrx"`
  // was WRONG here: it emitted /vrx/img/… which the relativizer turned into ./vrx/img/… → resolved to
  // /vrx/vrx/img/… inside the vrx/ folder → 404. The ${BASE}/img refs in source collapse to /img (BASE
  // empty) → relativized to./img. (Corrected.)
  output: "static",
  compressHTML: true,
  // Flat output: /ask -> ask.html (NOT ask/index.html). Keeps every page at the dist root so
  // relative asset paths (./_astro/…) and the relative API path (./assistant/assistant.php) resolve
  // correctly from any page — the "copy dist/ anywhere" rule holds for sub-pages too.
  build: { format: "file" },
});
