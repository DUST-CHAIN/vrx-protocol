// copy-web-ifc-wasm.mjs — ensure web-ifc's WASM is in public/ for the browser (IFC import).
//
// web-ifc.wasm is a node_modules artifact (gitignored via *.wasm), so it must be COPIED into public/web-ifc/
// at dev/build time rather than committed. lib/ifc-browser.ts points IfcAPI.SetWasmPath at /web-ifc/ (base-path
// aware), and `next build` copies public/ verbatim into the static export — so this guarantees the file is there
// for both `next dev` and the hosted /vrx/mm export. Idempotent; a no-op if already up to date.

import { mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "node_modules", "web-ifc", "web-ifc.wasm");
const dstDir = join(root, "public", "web-ifc");
const dst = join(dstDir, "web-ifc.wasm");

if (!existsSync(src)) {
  console.warn(`[copy-web-ifc-wasm] source missing (${src}) — run npm install. Skipping.`);
  process.exit(0);
}

const upToDate = existsSync(dst) && statSync(dst).size === statSync(src).size;
if (upToDate) {
  console.log("[copy-web-ifc-wasm] public/web-ifc/web-ifc.wasm already current.");
} else {
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(src, dst);
  console.log(`[copy-web-ifc-wasm] copied web-ifc.wasm → public/web-ifc/ (${statSync(dst).size} bytes).`);
}
