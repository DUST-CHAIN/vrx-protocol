"use client";

// Wallet context for the VRX portal — @near-wallet-selector wiring.
// This is the SIGNER half of the portal. Reads still go through lib/vrx.ts's JsonRpcProvider
// (no signer needed); WRITES go through the wallet the user connects here. We wire the Meteor
// wallet module now (the user signs owner writes as calculating-hand.testnet in Meteor on testnet).
// Adding more wallet modules later is additive — the contract-call code never changes.
// wallet-selector touches `window`, so everything here is client-only and lazy-initialized in an
// effect. The selector instance + modal live in module scope so they survive re-renders.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { transactions } from "near-api-js";
// De-googled copy of the modal CSS (F5): the upstream styles.css @imports Inter
// fonts.googleapis.com on every page load (a semi-tracker — it leaks the user's IP/referrer to Google).
// Our vendored copy strips that one line; Inter now comes self-hosted via next/font (lib/fonts.ts).
import "./wallet-selector-modal.css";
import { CONTRACT_ID, NETWORK, networkUrls } from "./config";
import { isLocalGodMode, devCallFunction, LOCAL_SIGNER_FLAG } from "./dev-signer";
import { demoRoleUxArmed } from "./dev-signer-fence";

// The wallet's browser RPC is routed through OUR keyed proxy (api/rpc) instead of the public
// FastNEAR default, so the write path (sign/send, nonce/block reads) doesn't hit the shared-IP 429 that
// blocked book/accept/decline. We pass a full Network object and override ONLY nodeUrl; the
// other fields keep the standard preset values per network. Same-origin → no CORS; server attaches the key.
// nodeUrl must be ABSOLUTE for near-api-js's JsonRpcProvider — build it from the current origin at
// init time (this module is client-only / lazy-init in an effect, so window exists).
function walletNetwork() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // nodeUrl is the ONLY field we override (our keyed /api/rpc proxy, built from the live origin); the
  // helper/explorer/indexer hosts are the pure per-network preset (lib/config networkUrls, unit-tested).
  return {
    ...networkUrls(NETWORK),
    nodeUrl: `${origin}/api/rpc`,
  };
}

type WalletCtx = {
  /** The connected account id, or null when signed out. */
  accountId: string | null;
  /** Selector ready yet? (async init) */
  ready: boolean;
  /** Open the wallet-selector modal to connect. */
  signIn: () => void;
  /** Disconnect the active wallet. */
  signOut: () => Promise<void>;
  /**
   * Sign & send a single FunctionCall against the VRX contract.
   * gas/deposit are strings in their base units (Tgas as yocto-gas, deposit as yocto-NEAR).
   * Returns the transaction hash.
   */
  callFunction: (args: {
    method: string;
    args: Record<string, unknown>;
    gas?: string;
    deposit?: string;
  }) => Promise<string>;
  /**
   * God-mode local signer active? (DEV-ONLY, LOCALNET-ONLY — see lib/dev-signer.ts fence.)
   * When true, writes sign with a local keypair against:3030 and the account-switcher below is live.
   */
  godMode: boolean;
  /** God-mode only: become any account (sets the active signing account, no wallet popup). */
  becomeAccount: (accountId: string) => void;
  /**
   * F1: establish a VERIFIED server session by signing a server-issued challenge (NEP-413).
   * Fetches a nonce from /api/session, asks the wallet to signMessage, POSTs the proof back → the server
   * sets an httpOnly session cookie so API routes stop trusting a forgeable query param. Returns the
   * proven account on success, or null (god-mode / no wallet / user declined / verification failed).
   * Safe to call opportunistically after connect; it's a no-op in god-mode (localnet dev switcher).
   */
  establishSession: () => Promise<string | null>;
};

const Ctx = createContext<WalletCtx | null>(null);

// In god-mode, the "last account you became" survives reload so a dev session stays put.
const DEV_ACCOUNT_KEY = "vrx.devSigner.account";

// 30 Tgas is the conventional default for a simple change call.
const DEFAULT_GAS = "30000000000000";

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Evaluate the god-mode fence ONCE at mount. isLocalGodMode throws (fail-loud) when the flag is
  // set but RPC isn't localnet — surface that as a console error here rather than crashing render.
  const [godMode] = useState<boolean>(() => {
    if (!LOCAL_SIGNER_FLAG) return false;
    try {
      return isLocalGodMode();
    } catch (e) {
      console.error(e);
      return false;
    }
  });
  // WALLETLESS mode (S158b) — the "assume an account without a wallet popup" path. TWO ways to arm it:
  // • god-mode (localnet:3030) — becomeAccount ALSO signs real localnet writes (raw key), OR
  // • the public DEMO (NEXT_PUBLIC_VRX_DEMO) — becomeAccount sets the browsing identity ONLY; there's no
  // localnet so no raw signing happens (writes are stubbed in the snapshot demo). This is what lets the
  // hit: becomeAccount was fenced to god-mode, which is off with no localnet → picker landed on Connect).
  // SAFETY: this only sets a client-side accountId for scoping reads; it NEVER arms the raw-key signer, which
  // stays hard-fenced to localnet (isLocalGodMode / dev-signer). Demo writes don't sign.
  const [walletless] = useState<boolean>(() => {
    try {
      return godMode || demoRoleUxArmed();
    } catch {
      return godMode;
    }
  });

  useEffect(() => {
    // ── WALLETLESS (god-mode localnet, OR the public demo) ───────────────────────────────────────
    // Skip the wallet-selector entirely; the "account" is whoever the picker/dev switcher last became.
    if (walletless) {
      const saved =
        typeof window !== "undefined" ? window.localStorage.getItem(DEV_ACCOUNT_KEY) : null;
      setAccountId(saved);
      setReady(true);
      return;
    }

    // ── NORMAL (real wallet via Meteor) ──────────────────────────────────────────────────────────
    let unsub: (() => void) | undefined;
    (async () => {
      if (!selector) {
        selector = await setupWalletSelector({
          network: walletNetwork(), // route wallet RPC through our keyed /api/rpc proxy
          modules: [setupMeteorWallet()],
        });
        modal = setupModal(selector, { contractId: CONTRACT_ID });
      }
      // Seed current state, then subscribe to changes.
      const state = selector.store.getState();
      setAccountId(state.accounts.find((a) => a.active)?.accountId ?? null);
      const sub = selector.store.observable.subscribe((s) => {
        setAccountId(s.accounts.find((a) => a.active)?.accountId ?? null);
      });
      unsub = () => sub.unsubscribe();
      setReady(true);
    })();
    return () => unsub?.();
  }, [walletless]);

  // WALLETLESS: "become" an account — set it active + persist, no wallet popup. Works in god-mode (localnet)
  // AND the public demo (picker). In the demo this sets the BROWSING identity only; raw signing stays fenced
  // to localnet (becomeAccount never touches the signer), so this can't sign a real tx off localnet.
  const becomeAccount = useCallback(
    (id: string) => {
      if (!walletless) return; // no-op on a real-wallet deploy; fences guarantee this never arms there
      if (typeof window !== "undefined") window.localStorage.setItem(DEV_ACCOUNT_KEY, id);
      setAccountId(id);
    },
    [walletless]
  );

  const signIn = useCallback(() => {
    modal?.show();
  }, []);

  const signOut = useCallback(async () => {
    // Walletless (god-mode OR demo): just drop the picked account — no wallet/session to tear down.
    if (walletless) {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(DEV_ACCOUNT_KEY);
        window.localStorage.removeItem("vrx.devRole"); // also clear the demo role override (role.tsx)
      }
      setAccountId(null);
      return;
    }
    if (!selector) return;
    const wallet = await selector.wallet();
    await wallet.signOut();
    // F1: also drop the verified server session so a stale cookie can't outlive the wallet.
    try {
      await fetch("/api/session", { method: "DELETE" });
    } catch {
      /* best-effort; the cookie expires on its own (SESSION_TTL_MS) regardless */
    }
    setAccountId(null);
  }, [walletless]);

  const callFunction = useCallback<WalletCtx["callFunction"]>(
    async ({ method, args, gas = DEFAULT_GAS, deposit = "0" }) => {
      // GOD-MODE: sign+send with a local keypair against:3030 (no wallet). Fence re-checked inside.
      if (godMode) {
        if (!accountId) throw new Error("No dev account selected — use the dev account switcher first.");
        return devCallFunction({ accountId, method, args, gas, deposit });
      }
      // PUBLIC DEMO (walletless, NO localnet): there's no chain to sign against — writes are STUBBED. Return a
      // deterministic fake tx hash so the UI's TxProgress/optimistic path completes without crashing (the
      // off-chain.data write still happens via the API routes). This is the "Sandbox" honesty: a demo booking
      // shows the flow but broadcasts nothing. Real on-chain writes are the deferred (b) localnet step.
      if (walletless) {
        console.info("[vrx demo] stubbed on-chain call (no chain in sandbox):", method);
        return `demo-stub:${method}:${Date.now().toString(36)}`;
      }
      if (!selector) throw new Error("Wallet selector not ready");
      const wallet = await selector.wallet();
      // The Meteor wallet module runs incoming actions through its own `najActionToInternal`, which
      // reads `action.functionCall.{methodName,args,gas,deposit}` — i.e. it expects near-api-js (NAJ)
      // Action objects, NOT the wallet-selector optimistic `{type,params}` shape (passing the latter
      // throws "Unsupported NAJ action"). So we build a real NAJ FunctionCall action with near-api-js's
      // `transactions.functionCall(method, args, gas, deposit)` (gas/deposit as BigInt). This is the
      // near-api-js version the portal already depends on for reads.
      const action = transactions.functionCall(
        method,
        args,
        BigInt(gas),
        BigInt(deposit)
      );
      const outcome = await (
        wallet.signAndSendTransaction as (p: unknown) => Promise<unknown>
      )({ receiverId: CONTRACT_ID, actions: [action] });
      // outcome may be void for some wallets; guard the hash read.
      return (outcome as { transaction?: { hash?: string } } | void)?.transaction?.hash ?? "";
    },
    [godMode, walletless, accountId]
  );

  // F1: the NEP-413 sign-in handshake. One wallet signature per session proves key control; the
  // server verifies it (lib/nep413) and mints a session cookie so routes read a VERIFIED identity, not a
  // forgeable param. No-op in god-mode (the dev switcher is the identity source on localnet).
  const establishSession = useCallback<WalletCtx["establishSession"]>(async () => {
    if (walletless) return null; // god-mode dev switcher OR demo picker — no real wallet to sign a session
    if (!selector) return null;
    const wallet = await selector.wallet();
    // signMessage is optional on the Wallet interface; Meteor implements it. Bail cleanly if absent.
    const signMessage = (wallet as { signMessage?: (p: unknown) => Promise<unknown> }).signMessage;
    if (typeof signMessage !== "function") return null;

    // 1) fetch a fresh single-use challenge.
    const chRes = await fetch("/api/session", { method: "GET" });
    if (!chRes.ok) return null;
    const { nonce, recipient } = (await chRes.json()) as { nonce: string; recipient: string };

    // 2) ask the wallet to sign it. The wallet's SignMessageParams.nonce is a 32-byte Buffer; our server
    // issues the nonce base64-encoded, so decode it back to bytes for the signature, and send the SAME
    // base64 back to the server (it re-derives the identical bytes when verifying).
    const message = "Sign in to VRX";
    const nonceBytes = Buffer.from(nonce, "base64");
    const signed = (await signMessage({ message, recipient, nonce: nonceBytes })) as
      | { accountId: string; publicKey: string; signature: string }
      | void;
    if (!signed) return null; // user declined

    // 3) POST the proof; the server verifies + sets the session cookie.
    const vRes = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: signed.accountId,
        publicKey: signed.publicKey,
        signature: signed.signature,
        nonce,
        recipient,
        message,
      }),
    });
    if (!vRes.ok) return null;
    const out = (await vRes.json()) as { ok?: boolean; account?: string };
    return out.ok ? out.account ?? null : null;
  }, [walletless]);

  const value = useMemo<WalletCtx>(
    () => ({ accountId, ready, signIn, signOut, callFunction, godMode, becomeAccount, establishSession }),
    [accountId, ready, signIn, signOut, callFunction, godMode, becomeAccount, establishSession]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
