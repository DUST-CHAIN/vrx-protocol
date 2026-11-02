// Pin networkUrls (lib/config) — the pure network→{helper,explorer,indexer} URL map that lib/wallet.tsx
// feeds to @near-wallet-selector. Extracted as a pure function of `network` precisely so BOTH branches are
// testable without a DOM (walletNetwork itself reads the build-time NETWORK constant + window.origin, so
// it binds once and can't be exercised both ways in bare tsx).
// WHY IT MATTERS: the one real bug-class here is a branch pointing at the WRONG network's host — a mainnet
// field holding a testnet URL (or vice-versa) silently routes a wallet-signed write to the wrong network.
// This freezes each exact host per branch, that the branches never share a host, and that networkId echoes
// the input. Run via tsx.

import { networkUrls } from "./config";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

function main() {
  const t = networkUrls("testnet");
  const m = networkUrls("mainnet");

  // ── networkId echoes the input ───────────────────────────────────────────────────────────────────────
  ok(t.networkId === "testnet", "testnet: networkId is 'testnet'");
  ok(m.networkId === "mainnet", "mainnet: networkId is 'mainnet'");

  // ── testnet hosts are the exact testnet endpoints ──────────────────────────────────────────────────────
  ok(t.helperUrl === "https://helper.testnet.near.org", "testnet helperUrl");
  ok(t.explorerUrl === "https://explorer.testnet.near.org", "testnet explorerUrl");
  ok(t.indexerUrl === "https://testnet-api.kitwallet.app", "testnet indexerUrl");

  // ── mainnet hosts are the exact mainnet endpoints ────────────────────────────────────────────────────
  ok(m.helperUrl === "https://helper.mainnet.near.org", "mainnet helperUrl");
  ok(m.explorerUrl === "https://explorer.near.org", "mainnet explorerUrl");
  ok(m.indexerUrl === "https://api.kitwallet.app", "mainnet indexerUrl");

  // ── the anti-typo invariant: no host is shared across the two networks ─────────────────────────────────
  ok(t.helperUrl !== m.helperUrl, "helperUrl differs testnet vs mainnet (no wrong-network leak)");
  ok(t.explorerUrl !== m.explorerUrl, "explorerUrl differs testnet vs mainnet");
  ok(t.indexerUrl !== m.indexerUrl, "indexerUrl differs testnet vs mainnet");

  // ── every testnet host names 'testnet'; no mainnet host does (guards a branch mislabel) ────────────────
  ok(
    [t.helperUrl, t.explorerUrl, t.indexerUrl].every((u) => u.includes("testnet")),
    "every testnet host contains 'testnet'"
  );
  ok(
    [m.helperUrl, m.explorerUrl, m.indexerUrl].every((u) => !u.includes("testnet")),
    "no mainnet host contains 'testnet'"
  );

  console.log(fail === 0 ? `config.network-urls: ${pass}/${pass} PASS` : `config.network-urls: ${fail} FAILED, ${pass} passed`);
  if (fail > 0) process.exit(1);
}

main();
