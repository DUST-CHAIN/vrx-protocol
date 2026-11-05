#!/usr/bin/env node
// MM mockup image generator — Gemini "Nano Banana" (image generation).
// S229 (2026-11-04). Reusable prompt→PNG tool; the same muscle MM's Studio face will use.
//
// KEY HANDLING: the Gemini key is read at runtime from the secrets vault
//   C:\xampp\htdocs\claude-maintained-secrets\CREDENTIALS.md  (the "Gemini (Google AI)" row)
// or from $env:GEMINI_API_KEY if set. It is NEVER written into this file or any committed output.
// Outputs land in tools/mm-mockups/ (gitignored).
//
// Usage (PowerShell):
//   node tools/gen-images.mjs                 # renders the 3 test prompts (faces) only
//   node tools/gen-images.mjs --all           # renders all prompts in the pack
//   node tools/gen-images.mjs --only 02,06,13 # renders a chosen subset
//   node tools/gen-images.mjs --model flash   # use the cheaper Flash image model instead of Pro
//
// Model default = gemini-3-pro-image (Nano Banana Pro): best for UI mockups where label text must
// render crisply. --model flash uses gemini-flash-latest-image (cheaper, softer on dense text).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "mm-mockups");
const VAULT = "C:\\xampp\\htdocs\\claude-maintained-secrets\\CREDENTIALS.md";

// ---- key (env first, else vault row "| Gemini (Google AI) | `AIza...` |") ---------------------
function getKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  let txt;
  try { txt = readFileSync(VAULT, "utf8"); }
  catch { throw new Error(`No GEMINI_API_KEY env var and cannot read vault at ${VAULT}`); }
  // match a row mentioning Gemini and capture the first AIza... backticked token on that line
  for (const line of txt.split(/\r?\n/)) {
    if (/gemini/i.test(line)) {
      const m = line.match(/`(AIza[0-9A-Za-z_\-]+)`/);
      if (m) return m[1];
    }
  }
  throw new Error("Could not find a Gemini (AIza…) key row in the vault.");
}

// ---- model map --------------------------------------------------------------------------------
const MODELS = {
  pro: "gemini-3-pro-image",          // Nano Banana Pro — crisp UI text (default)
  flash: "gemini-flash-latest-image", // cheaper, softer text
};

// ---- the shared global style preamble (kept in sync with docs/MM_SCREENSHOT_PROMPTS.md) -------
const GLOBAL = `High-resolution desktop web-app UI screenshot, 16:10 framing. ONE serious, production-ready software product called "MM" — a marketing-materials creation suite for real-estate developments (condos, villas, towns), also domain-agnostic (art/NFT units, event tickets). Premium enterprise-SaaS aesthetic like Linear, Stripe, Figma and high-end architectural software. NOT a chatbot — a real tool with a consistent application shell.
PALETTE: warm white #F7F6F3 backgrounds, charcoal #20242D text, soft grey #E7E8E9 borders, ONE accent: teal in light faces, muted indigo #6575A5 on a dark charcoal canvas in the Creative Studio face. Restrained shadows, rounded panels, generous spacing, refined sans-serif, realistic coherent data (never lorem ipsum). Render all UI label text crisply and legibly, spelled exactly.
PERMANENT LEFT MENU (identical every screen): narrow left rail — TOP: "MM" wordmark, a 3-way face switch "Structured · Studio · Preview", a "Domain: Real estate" dropdown, a "Theme" dropdown. MIDDLE: an entity tree "Riverside Complex > Land > Building A > Unit Types > Units (142) > Building B". BOTTOM: "Media Library", "Agreements", "Export / Preview". A small persistent "next best step" hint is visible, and an "Export pack" affordance is always reachable (guided but never gated; always exportable).`;

// ---- the prompts (id → face + body). Mirrors docs/MM_SCREENSHOT_PROMPTS.md. -------------------
const PROMPTS = {
  "01": `STRUCTURED FACE (light, teal) — the unified shell introducing "one engine, three faces". ${GLOBAL} "Structured" face active. Center: a selected condominium development "Riverside Complex" with a large architectural hero render, a completion progress bar, and key indicator cards (buildings, total units, units with media, pack validity). Make the face switch "Structured · Studio · Preview" and the "Domain: Real estate" switch prominent at top. Below the hero, a split overview: left = structured project data + completion meters; right = AI-generated creative asset thumbnails + production progress. A small "Preview in sync" badge. The screen must say instantly: structured data and AI creation are two faces of ONE project.`,
  "02": `STRUCTURED FACE (light, teal). ${GLOBAL} The pragmatic data face, "Structured" active. Tree expanded to Building A > Units. Center: a dense editable data table of condo units — columns "Unit", "Type", "Floor", "Internal m²", "Balcony m²", "Beds", "Baths", "Orientation", "View", "Price", "Status". The ENTIRE table including the "Status" column must be fully visible with no horizontal clipping at the right edge. Realistic rows (studios, 1-bed, 2-bed; views "Sea view"/"Pool view"/"Garden"; statuses "Available"/"Reserved"/"Sold"/"Block"). Toolbar: "Add row", "Paste", "Import Excel/CSV", "Validate", "AI assist". Right panel "Validation" with green checks and one amber "1 row needs fix". Bottom hint "Next: add media".`,
  "05": `STRUCTURED FACE (light, teal) — building anatomy: the unit grid IS the stacking plan. ${GLOBAL} "Building A" selected. Center-left (two-thirds): a stacking-plan grid — floors as rows, units as cells, each cell color-coded by status with a legend "Available / Reserved / Sold / Block / Resale". Center-right (one-third): the matching unit inventory table; one cell and its table row are both highlighted to show they are the same unit. Filters above: floor, type, view, status. A small "spatial ↔ inventory in sync" badge. One integrated tool — floor-plan and inventory are the same units, never two apps.`,
  "07": `CREATIVE STUDIO FACE (dark charcoal canvas, indigo accent) — "one line → everything". ${GLOBAL} Dark Studio theme, same left menu. Top: a single natural-language input reading "Create a complete coastal condominium: sea views, natural materials, relaxed-luxury interiors." Below, the AI expands it into a structured production plan as cards grouped: "Building identity", "Exterior visuals", "Interior visuals", "Unit-type imagery", "Facilities", "Texts & descriptions", "Price defaults", "Contract defaults". Each card: a thumbnail, a one-line description, linked building/unit data, a status chip. Right: an AI panel — "what's available", "needs clarification", "can generate now". A subtle connector line ties the brief to real building data. Shows one sentence becoming texts + images + params + price/contract defaults.`,
  "14": `PREVIEW / OUTPUT FACE (light) — "Parity / gaps": the DRT ↔ MM ↔ VRX schema audit. ${GLOBAL} "Preview" face, with a "Parity / gaps" toggle switched ON in the header "Schema parity: DRT · MM · VRX". A side panel lists findings in two groups: "Source fields with nowhere to land in VRX" (e.g. a DRT field MM has that the VRX schema lacks) and "VRX fields never filled by any source" (persistent tints). Each finding is a row with a small location link. The main preview area dims matched fields and highlights the mismatched ones in a colored tint. Communicates that Preview doubles as a drift detector — it reveals a parameter VRX forgot that DRT/MM already had.`,
  "06": `CREATIVE STUDIO FACE (dark charcoal canvas, indigo accent). ${GLOBAL} The shell is in dark Studio theme; same left menu but the tree collapsed to "Creating for: Building A · 2-Bed type". Three columns. LEFT: project context (development, building, unit types, approved references). CENTER: a large grid of AI-generated candidate images of the same condo — exterior, sea-facing living room, bedroom, bathroom, pool, lobby. RIGHT: an AI creative-director conversation + controls "Generate variations", "Refine", "Compare", "Approve", "Send to production", showing a user instruction "Warm contemporary coastal identity. Use the references for materials and furniture. Keep building geometry and unit layouts unchanged. Explore three directions." A command center, not a chat.`,
  "13": `PREVIEW / OUTPUT FACE (light, rigid, renders real templates). ${GLOBAL} Left menu shows device toggles (Desktop/Tablet/Mobile) and role toggles (Developer/Agent/Buyer). Center: the internal shell surrounds a large embedded preview of a FINISHED premium condo marketing page (hero render, development name, unit-type selector, available units + pricing, galleries, facilities) — BUT with gaps deliberately shown: a missing hero image replaced by a RED-TINTED placeholder block in the correct aspect ratio labeled "image missing — add"; a missing building name shown as a tinted schema default "[Building name]"; a missing price tinted. A toggle "Show injected placeholders (tint)" is ON. A persistent "Export pack" button is ENABLED with a note "exports valid — blanks filled from template".`,
};
const TEST_SET = ["02", "06", "13"];

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const modelKey = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "pro";
const model = MODELS[modelKey] || MODELS.pro;
let ids = TEST_SET;
if (argv.includes("--all")) ids = Object.keys(PROMPTS);
else if (argv.includes("--only")) ids = (argv[argv.indexOf("--only") + 1] || "").split(",").map(s => s.trim()).filter(Boolean);

// ---- generate ---------------------------------------------------------------------------------
async function genOne(key, id) {
  const prompt = PROMPTS[id];
  if (!prompt) { console.error(`  [${id}] no such prompt id — skipped`); return false; }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`  [${id}] HTTP ${res.status}: ${t.slice(0, 400)}`);
    return false;
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData?.data);
  if (!img) {
    console.error(`  [${id}] no image in response: ${JSON.stringify(json).slice(0, 400)}`);
    return false;
  }
  const ext = (img.inlineData.mimeType || "image/png").split("/")[1].replace("jpeg", "jpg");
  const file = resolve(OUT_DIR, `mm-${id}.${ext}`);
  writeFileSync(file, Buffer.from(img.inlineData.data, "base64"));
  console.log(`  [${id}] ✓ ${file}`);
  return true;
}

async function main() {
  const key = getKey();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  console.log(`MM mockups → model=${model}, ids=[${ids.join(", ")}], out=${OUT_DIR}`);
  let ok = 0;
  for (const id of ids) {
    try { if (await genOne(key, id)) ok++; }
    catch (e) { console.error(`  [${id}] error: ${e.message}`); }
  }
  console.log(`Done: ${ok}/${ids.length} generated.`);
  if (ok < ids.length) process.exit(1);
}
main();
