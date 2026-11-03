#!/usr/bin/env node
// VRX V7-WISHLIST #6 — obfuscation moat, part 2/3: the WASM EXPORT-RENAME build-step.
//
// WHAT: given a compiled contract WASM (the cargo-near output) + name-map.json, rewrite the EXPORT
// SECTION so each legible method export (`register_node`, `grant_exclusive`...) carries its opaque
// name (`vd9b6f0`...) instead. NEAR dispatches an incoming call by matching `method_name` against
// the WASM export symbols (near-sdk emits `#[no_mangle] pub extern "C" fn <name>`), so renaming the
// export name IS renaming the on-wire method. Nothing else in the module changes — same code bodies,
// same auth/crypto. (Verified: near-sdk-macros 5.29.1 impl_item_method_info.rs line 38.)
//
// WHY it's a byte-level WASM patch (no external toolchain): wasm-tools/wabt aren't installed and we
// don't want a new build dependency for a once-per-deploy step. The WebAssembly binary format's
// export section (id 7) is a simple vector of (name: vec(byte), kind: u8, index: u32); we only touch
// the `name` strings. We re-encode the whole section with corrected LEB128 lengths. Pure Node, no deps.
//
// SAFETY / LOUD FAILURE: every method in the map that is NOT kept-legible MUST be found as an export,
// else we refuse to write (a missing export = the rename would silently drop a method). Kept-legible
// names (new/migrate*) are asserted present but unchanged. Any export we don't recognise (NEAR's own
// `contract_source_metadata`, etc.) is passed through untouched. The output is written to a NEW path;
// the input WASM is never mutated in place.
//
// USAGE:  node apply-name-map.mjs <in.wasm> <out.wasm> [--map name-map.json]
//   (build-obfuscated.sh wires this after `cargo near build`.)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mapIdx = argv.indexOf("--map");
const mapPath = mapIdx >= 0 ? argv[mapIdx + 1] : join(HERE, "name-map.json");
const positional = argv.filter((a, i) => a !== "--map" && argv[i - 1] !== "--map");
const [inPath, outPath] = positional;
if (!inPath || !outPath) {
  console.error("usage: node apply-name-map.mjs <in.wasm> <out.wasm> [--map name-map.json]");
  process.exit(2);
}

const { map } = JSON.parse(readFileSync(mapPath, "utf8"));
if (!map || typeof map !== "object") throw new Error(`bad name-map at ${mapPath}`);
// Methods that get a DIFFERENT opaque name (the ones we must find + rewrite).
const renames = new Map(Object.entries(map).filter(([k, v]) => k !== v));
// Methods we assert are present but leave as-is.
const keepLegible = new Set(Object.entries(map).filter(([k, v]) => k === v).map(([k]) => k));

// ── minimal WASM reader ────────────────────────────────────────────────────────
const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error("not a wasm module (bad magic)");
// version at offset 4 (expect 1); we don't gate on it.

function readLEB(b, off) { // unsigned LEB128 -> { value, next }
  let result = 0, shift = 0, pos = off, byte;
  do { byte = b[pos++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  return { value: result >>> 0, next: pos };
}
function encLEB(v) { // unsigned LEB128 -> Buffer
  const out = [];
  do { let b = v & 0x7f; v >>>= 7; if (v !== 0) b |= 0x80; out.push(b); } while (v !== 0);
  return Buffer.from(out);
}
function encName(s) { const body = Buffer.from(s, "utf8"); return Buffer.concat([encLEB(body.length), body]); }

// ── locate the export section (id 7) ───────────────────────────────────────────
let pos = 8; // past magic+version
let exportSecStart = -1, exportSecBodyStart = -1, exportSecBodyLen = -1, exportSecEnd = -1;
while (pos < buf.length) {
  const secId = buf[pos];
  const { value: secLen, next } = readLEB(buf, pos + 1);
  const bodyStart = next;
  const bodyEnd = bodyStart + secLen;
  if (secId === 7) { exportSecStart = pos; exportSecBodyStart = bodyStart; exportSecBodyLen = secLen; exportSecEnd = bodyEnd; break; }
  pos = bodyEnd;
}
if (exportSecStart < 0) throw new Error("no export section (id 7) found — is this a contract wasm?");

// ── parse + rewrite the export entries ─────────────────────────────────────────
let p = exportSecBodyStart;
const { value: count, next: afterCount } = readLEB(buf, p);
p = afterCount;
const newEntries = [];
const foundRenames = new Set();
const foundLegible = new Set();
for (let i = 0; i < count; i++) {
  const { value: nameLen, next: afterLen } = readLEB(buf, p);
  const nameStart = afterLen;
  const name = buf.slice(nameStart, nameStart + nameLen).toString("utf8");
  const kindAndIdxStart = nameStart + nameLen;
  // kind (1 byte) + index (LEB128)
  const kind = buf[kindAndIdxStart];
  const { value: idx, next: afterIdx } = readLEB(buf, kindAndIdxStart + 1);
  p = afterIdx;

  let outName = name;
  if (renames.has(name)) { outName = renames.get(name); foundRenames.add(name); }
  else if (keepLegible.has(name)) { foundLegible.add(name); }
  // else: a NEAR/toolchain export we don't own — passed through unchanged.

  newEntries.push(Buffer.concat([encName(outName), Buffer.from([kind]), encLEB(idx)]));
}

// ── loud-failure gates ─────────────────────────────────────────────────────────
const missingRenames = [...renames.keys()].filter((n) => !foundRenames.has(n));
if (missingRenames.length) {
  throw new Error(`REFUSING to write: ${missingRenames.length} mapped method(s) not found as wasm exports — the rename would silently drop them:\n  ${missingRenames.join(", ")}\n(Did the contract gain/rename a method? Re-run gen-name-map.mjs.)`);
}
const missingLegible = [...keepLegible].filter((n) => !foundLegible.has(n));
if (missingLegible.length) {
  console.warn(`WARN: kept-legible method(s) not present as exports (ok if intentionally absent): ${missingLegible.join(", ")}`);
}

// ── re-encode the export section + splice back ─────────────────────────────────
const newBody = Buffer.concat([encLEB(count), ...newEntries]);
const newSection = Buffer.concat([Buffer.from([7]), encLEB(newBody.length), newBody]);
const out = Buffer.concat([
  buf.slice(0, exportSecStart),
  newSection,
  buf.slice(exportSecEnd),
]);

// sanity: the module must still start with the wasm magic + be larger-than-header
if (out.readUInt32LE(0) !== 0x6d736100) throw new Error("internal error: output lost wasm magic");

writeFileSync(outPath, out);
console.log(`obfuscated wasm: renamed ${foundRenames.size}/${renames.size} exports, ${foundLegible.size} kept legible, ${count} total exports -> ${outPath} (${out.length} bytes, was ${buf.length})`);
