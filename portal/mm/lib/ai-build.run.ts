// MM-by-AI orchestrator — the HEADLESS "author a whole building by AI" pipeline (the design docs).
//
// ONE command, blurb -> a real importable ingest-pack ZIP on disk (run from the mm/ dir):
//   npx tsx lib/ai-build.run.ts --blurb "..." [--stories 25] [--area "northpoint"] [--out ./out/pack.zip]
//   npx tsx lib/ai-build.run.ts --file brief.txt --out ./out/pack.zip
//   (needs DEEPSEEK_API_KEY in the env for the text stage.)
//
// THE PROOF (the keystone): the AI drives the MM lib API — DeepSeek fills a small structured
// BuildingSpec, then the PURE assembler (assembleBuildingPack) expands it into a complete, validatePack-clean
// Pack, and export.buildPackFiles emits exactly the ZIP a developer imports. So a full generated building PROVES
// the MM data+export layer, and the emitted ZIP IS the alpha onboarding ingest (ALPHA_ONBOARDING_DESIGN slice 3).
// The web UI (app/ai) is dressing over THIS engine.
//
// Lives in mm/ (not the portal) because it uses jszip (mm dep) + the mm libs directly. Mirrors the browser
// toZip, but writes a Node Buffer to disk. Images: generateMissingImages (Gemini stubbed) -> missing slots
// placeholder-backfill at export (law #2), so a full building generates on DeepSeek text ALONE.
//
// PRIVACY/HONESTY: synthetic/mock content only (alias names); generated plans/images are demo/marketing/art.

import { promises as fs } from "fs";
import path from "path";
import { askWithSystem } from "./ai-client-server";
import {
  AI_BUILD_SYSTEM_PROMPT,
  assembleBuildingPack,
  buildSpecMessages,
  parseSpec,
  type AiBuildingSpec,
} from "./ai-build";
import { validatePack } from "./validate";
import { buildPackFiles, buildPackMedia } from "./export";
import { generateMissingImages } from "./ai-build-images";
import { fillFromRenderset } from "./ai-build-renderset";
import { totalUnits } from "./pack";

// ── tiny arg parser (no dep; --k v and --flag) ──────────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/** Stage 1+2: blurb -> AiBuildingSpec via DeepSeek. Returns null on no-key/upstream fault (fail-visible). */
async function specFromBlurb(
  blurb: string,
  hints: { area?: string; stories?: number },
): Promise<{ spec: AiBuildingSpec | null; tokens: number; error?: string }> {
  const messages = buildSpecMessages(blurb, hints);
  const res = await askWithSystem(AI_BUILD_SYSTEM_PROMPT, messages, { temperature: 0.4, maxTokens: 2000 });
  if (!res.ok) return { spec: null, tokens: 0, error: res.error };
  return { spec: parseSpec(res.answer), tokens: res.tokens };
}

/** Write the assembled Pack as a real.zip on disk (Node: JSZip nodebuffer). Mirrors toZip but to a file. */
async function writePackZip(files: Record<string, string>, media: Record<string, Uint8Array>, outPath: string): Promise<number> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const [p, text] of Object.entries(files)) zip.file(p, text);
  for (const [p, bytes] of Object.entries(media)) zip.file(p, bytes);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
  return buf.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let blurb = typeof args.blurb === "string" ? args.blurb : "";
  if (!blurb && typeof args.file === "string") blurb = await fs.readFile(args.file, "utf8");
  if (!blurb) {
    console.error(
      "usage: npx tsx lib/ai-build.run.ts --blurb \"<listing copy>\" [--stories N] [--area \"...\"] [--out ./out/pack.zip]\n" +
      "   or: npx tsx lib/ai-build.run.ts --file brief.txt [--out ./out/pack.zip]"
    );
    process.exit(2);
  }

  const hints = {
    area: typeof args.area === "string" ? args.area : undefined,
    stories: typeof args.stories === "string" ? Number(args.stories) : undefined,
  };
  const outPath = typeof args.out === "string" ? args.out : path.join(process.cwd(), "out", "ai-pack.zip");

  console.log("MM-by-AI — generating a building from the brief…");
  console.log(`  brief: ${blurb.slice(0, 80).replace(/\s+/g, " ")}${blurb.length > 80 ? "…" : ""}`);

  // 1+2. DeepSeek -> structured spec
  const { spec, tokens, error } = await specFromBlurb(blurb, hints);
  if (!spec) {
    console.error(
      error === "no_key"
        ? "✗ DEEPSEEK_API_KEY is not set — cannot run the AI text stage. (Set it in the env to generate.)"
        : `✗ DeepSeek stage failed (${error || "could not parse spec"}).`
    );
    process.exit(1);
  }
  console.log(`  ✓ spec: ${spec.buildingName} · ${spec.stories} floors · ${spec.unitTypes.length} unit type(s) · ${tokens} tokens`);

  // 3. assemble -> a complete, valid Pack
  const { pack, totalUnits: n } = assembleBuildingPack(spec);
  console.log(`  ✓ assembled: ${n} units across ${pack.buildings.length} building(s)`);

  // 4. images — DEFAULT from the bundled render-set first (real, consistent), then Gemini for any leftover
  //  slots (stubbed), then placeholder backfill at export covers the rest. (.)
  const set = await fillFromRenderset(pack);
  if (set.items.length) pack.media = [...(pack.media || []), ...set.items];
  const img = await generateMissingImages(pack);
  if (img.items.length) pack.media = [...(pack.media || []), ...img.items];
  console.log(`  · images: ${set.filled} from render-set + ${img.filled} generated / ${set.attempted} slots (rest placeholder-backfilled at export)`);

  // 5. validate (fail-visible; export still runs with backfill, so warn but don't block)
  const v = validatePack(pack);
  console.log(`  · validation: ${v.counts.errors} error(s), ${v.counts.warnings} warning(s)${v.ok ? " — clean" : ""}`);
  if (!v.ok) for (const f of v.findings.filter((x) => x.severity === "error")) console.log(`      ✗ ${f.where}${f.field ? ` · ${f.field}` : ""}: ${f.message}`);

  // 6. export -> real .zip on disk
  const files = await buildPackFiles(pack, "vrx-mm-by-ai 0.1.0");
  const mediaBins = buildPackMedia(pack);
  const bytes = await writePackZip(files, mediaBins, outPath);
  console.log(`\n✓ wrote importable ingest-pack: ${outPath} (${(bytes / 1024).toFixed(1)} KB, ${Object.keys(files).length} text files + ${Object.keys(mediaBins).length} media)`);
  console.log(`  units total: ${totalUnits(pack)} · this ZIP imports into MM's preview AND the alpha onboarding ingest.`);
}

main().catch((e) => {
  console.error("ai-build failed:", e);
  process.exit(1);
});
