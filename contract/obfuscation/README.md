# VRX contract obfuscation moat (V7-WISHLIST #6)

> ORDER: this doc describes the build-step as of November 2026.

**What this is.** A build-step that renames the contract's exported method symbols to opaque codes in
the **deploy WASM** — so a would-be re-hoster cannot read the method surface off the chain. It makes
the contract *not cheaply copyable*; the vetted-hosted path stays the easy one. (V7_PLAN §6.)

**What this is NOT.** It is **not** a security control. Obscurity ≠ the lock — the lock is auth + crypto
(owner-gating, predecessor checks, opaque hashes, the pepper). The renamed method runs the byte-identical
auth/body; renaming only hides *names*. Nothing here weakens the real model, and nothing here is required
for correctness. Whether it ships in V7 or waits is a product call (it's a moat refinement).

## The three parts

| file | role |
|---|---|
| `gen-name-map.mjs` | SOURCE OF TRUTH generator. Parses `../src/lib.rs` for every `pub fn` in the `#[near] impl Contract` block, emits a deterministic legible→opaque map to `name-map.json` **and** the off-chain consumer `portal/lib/onchain-name-map.ts`. |
| `apply-name-map.mjs` | The WASM patcher. Rewrites the export section (id 7) of a compiled WASM so each mapped method carries its opaque name. Dependency-free (pure Node LEB128/section surgery). **Refuses to write** if any mapped method is missing from the WASM (loud failure — never ships a dropped method). |
| `build-obfuscated.sh` | Deploy-build wrapper (WSL): regen map → `cargo near build` → apply patch → print both artifacts. The `*.obf.wasm` is what you deploy at V7. |

Tests: `apply-name-map.test.mjs` (11/0, synth-WASM round-trip + loud-fail gate) and
`portal/lib/onchain-name-map.test.ts` (9/0, TS↔JSON no-drift + identity/opaque behaviour).

## Why the map is derived from source

The map's domain is re-parsed from `lib.rs` on every `gen` run, so it can't silently fall behind a new
method. If a method is added to the contract but the map isn't regenerated, `apply-name-map.mjs` fails
loudly at build (the new export is unmapped → the patcher's completeness gate trips). Regenerate with:

```
node contract/obfuscation/gen-name-map.mjs
```

## Scheme

Opaque name = `"v" + sha256("vrxobf1|" + methodName)[:6 hex]` — deterministic, collision-checked, a
valid WASM export ident, visibly a VRX symbol. The `vrxobf1` domain-separator lets us rotate the whole
map later (bump to `vrxobf2`) without colliding with a shipped scheme.

**Kept legible (8):** `new`, `migrate`..`migrate7` — invoked by the `cargo near` deploy/init command
line, which we don't route through the map. They're owner-only lifecycle calls; their names leak nothing
about the live method surface a copier wants (register/claim/token/exclusive — all obfuscated).

## How a live call sends the opaque name (V7)

Source, `cargo test`, and the dry-run transports all stay on the **legible** names. Only the live
near-api-js transport registered at V7 deploy maps at the wire boundary:

```ts
import { onchainMethod } from "@/lib/onchain-name-map";
// inside the live transport:
await account.functionCall({ contractId, methodName: onchainMethod(call.method), args, ... });
```

`onchainMethod` is **identity unless `VRX_ONCHAIN_OBFUSCATED=1`**, so the same code path works for a
plain (non-obfuscated) deploy and the obfuscated one. The two seams that need it are flagged at their
`setTransport` swap points: `portal/lib/booking-tokens-onchain.ts` (mirror) and
`portal/lib/ai-desk/grant-exclusive-onchain.ts` (exclusive leg).

## V7 deploy checklist (the obfuscation parts)

1. `node gen-name-map.mjs` (fresh map from source).
2. Build the obfuscated artifact: run `contract/obfuscation/build-obfuscated.sh`.
   ⚠ If `cargo near build` fails on a Cargo.lock drift (rustc ≥1.88), reconcile the lockfile first — that's a deploy-gate, not this step.
3. Deploy the `*.obf.wasm` + run `migrate7` (its name is kept legible, so the deploy call is unchanged).
4. Set `VRX_ONCHAIN_OBFUSCATED=1` in the portal env **in the same cutover** as registering the live
   transports — so off-chain calls send opaque names matching the deployed exports.
5. Smoke-test one obfuscated method end-to-end (e.g. a view) before relying on it.
