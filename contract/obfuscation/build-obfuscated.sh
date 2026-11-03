#!/usr/bin/env bash
# VRX V7-WISHLIST #6 — obfuscation moat, part 3/3: the DEPLOY-BUILD wrapper.
#
# Produces the OBFUSCATED deploy WASM = `cargo near build` + the export-rename patch. This is the
# artifact you `near deploy` at V7 — NOT the plain cargo output. Source + `cargo test` stay on the
# legible names; only this build-for-deploy path renames the on-wire method surface.
#
# Runs in WSL (cargo-near + the wasm32 target live there; Windows cargo-near can't build the sandbox
# path — see CLAUDE.md). Invoke from Windows via PowerShell:
#   wsl -d Ubuntu -- bash /mnt/c/Home/vrx-near/contract/obfuscation/build-obfuscated.sh
#
# Steps:
#   1. regenerate name-map.json from lib.rs (so it can never drift behind a new method)
#   2. cargo near build non-reproducible-wasm --no-abi   (the standard CLAUDE.md build line)
#   3. node apply-name-map.mjs <plain.wasm> <obfuscated.wasm>   (loud-fails if any method unmapped)
#   4. print both artifacts; the OBFUSCATED one is what deploys.
#
# ⚠ Build-blocker note (CLAUDE.md): `cargo near build` on pinned Rust 1.86 has had Cargo.lock
# drift (deps wanting rustc >=1.88). If step 2 fails on that, it's the pre-existing lockfile issue,
# NOT this script — reconcile the lockfile first (that's a deploy-gate task, tracked separately).
set -euo pipefail

OBF_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTRACT_DIR="$(cd "$OBF_DIR/.." && pwd)"
source "$HOME/.cargo/env" 2>/dev/null || true

echo "== 1/4 regenerate name-map =="
node "$OBF_DIR/gen-name-map.mjs"

echo "== 2/4 cargo near build =="
cd "$CONTRACT_DIR"
cargo near build non-reproducible-wasm --no-abi

# cargo-near writes to target/near/<crate>.wasm — find it.
PLAIN_WASM="$(find "$CONTRACT_DIR/target/near" -maxdepth 1 -name '*.wasm' 2>/dev/null | head -1 || true)"
if [ -z "${PLAIN_WASM:-}" ] || [ ! -f "$PLAIN_WASM" ]; then
  echo "ERROR: no wasm found under target/near after build" >&2
  exit 1
fi
OBF_WASM="${PLAIN_WASM%.wasm}.obf.wasm"

echo "== 3/4 apply name-map =="
node "$OBF_DIR/apply-name-map.mjs" "$PLAIN_WASM" "$OBF_WASM"

echo "== 4/4 done =="
echo "  plain      : $PLAIN_WASM"
echo "  OBFUSCATED : $OBF_WASM   <-- deploy THIS at V7"
