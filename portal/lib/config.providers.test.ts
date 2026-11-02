// Pin serverProviders' interleaving (lib/config) — the ONE piece of config.ts with real logic + a real
// past bug. Everything else in config.ts is env-bound module constants (bind-once at import, low test
// value). serverProviders takes the near-api-js `providers` namespace as a PARAM, so we inject a stub and
// assert the ORDER it builds providers in — no network, no real near-api-js.
// WHY IT MATTERS (bug this guards): before the fix, serverProviders pinned the single FASTNEAR_API_KEY,
// so when that key's account ran out of credits EVERY /api/view 503'd even though a second pooled key still
// had credits. The fix interleaves by KEY FIRST — consecutive attempts try the same url with a DIFFERENT
// key, so a quota_exceeded on key 1 immediately retries on key 2 instead of exhausting every url on the
// dead key. This test freezes that ordering (and the keyless fallback) so a refactor can't silently regress
// it. Run via tsx.
// SCOPE (honest): FASTNEAR_API_KEYS is keyless-by-default ([] unless VRX_FASTNEAR_KEYLESS=0), and config
// constants bind once at import, so this test covers only the DEFAULT (keyless) path + the RPC_URLS
// invariant. The keyed key-first INTERLEAVING (the actual fix) is NOT exercised here — reaching it
// needs a re-import under VRX_FASTNEAR_KEYLESS=0, which bare tsx makes awkward; faking it would test a
// reconstruction, not the real function, so I don't. If the keyed path ever regresses, add a small
// harness that sets the env before a dynamic import. What IS pinned: keyless → unkeyed provider per url,
// in order, no Authorization header.

import { serverProviders, RPC_URLS } from "./config";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// A stub `providers` namespace: JsonRpcProvider just records the connection object it was built with, so
// we can read back the exact order + headers serverProviders constructed.
function stubNs() {
  const built: Array<{ url: string; auth?: string }> = [];
  const ns = {
    JsonRpcProvider: class {
      constructor(conn: { url: string; headers?: { Authorization?: string } }) {
        built.push({ url: conn.url, auth: conn.headers?.Authorization });
      }
    },
  } as unknown as typeof import("near-api-js")["providers"];
  return { ns, built };
}

function main() {
  // ── Keyless default: one UNKEYED provider per RPC url, no Authorization header ───────────────────────
  const { ns, built } = stubNs();
  serverProviders(ns);
  ok(built.length === RPC_URLS.length, `keyless builds one provider per url (${RPC_URLS.length})`);
  ok(built.every((b) => b.auth === undefined), "keyless providers carry NO Authorization header");
  ok(
    built.map((b) => b.url).join(",") === RPC_URLS.join(","),
    "keyless providers are in RPC_URLS order"
  );

  // ── RPC_URLS invariant: primary first, no duplicate of the primary in the fallbacks ─────────────────
  ok(RPC_URLS.length >= 1, "RPC_URLS has at least the primary");
  ok(new Set(RPC_URLS).size === RPC_URLS.length, "RPC_URLS has no duplicate endpoints (primary not re-listed)");

  console.log(fail === 0 ? `config.providers: ${pass}/${pass} PASS` : `config.providers: ${fail} FAILED, ${pass} passed`);
  if (fail > 0) process.exit(1);
}

main();
