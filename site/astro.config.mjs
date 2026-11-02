import { defineConfig } from "astro/config";

// Static site. Output goes to dist/ — upload to the Hetzner shared host (vettedrealty.com).
// contact.php ships alongside in public/ so the form works on PHP shared hosting.
export default defineConfig({
  site: "https://vettedrealty.com",
  output: "static",
  compressHTML: true,
  // Flat output: /ask -> ask.html (NOT ask/index.html). Keeps every page at the dist root so
  // relative asset paths (./_astro/…) and the relative API path (./assistant/assistant.php) resolve
  // correctly from any page — the "copy dist/ anywhere" rule holds for sub-pages too.
  build: { format: "file" },
});
