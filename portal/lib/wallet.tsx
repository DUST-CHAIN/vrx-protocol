"use client";

// Wallet context for the VRX portal — @near-wallet-selector wiring.
//
// This is the SIGNER half of the portal. Reads still go through lib/vrx.ts's JsonRpcProvider
// (no signer needed); WRITES go through the wallet the user connects here. We wire the Meteor
// wallet module now (the user signs owner writes as calculating-hand.testnet in Meteor on testnet).
// Adding more wallet modules later is additive — the contract-call code never changes.
//
// wallet-selector touches `window`, so everything here is client-only and lazy-initialized in an
// effect. The selector instance + modal live in module scope so they survive re-renders.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

// The wallet's browser RPC is routed through OUR keyed proxy (/api/rpc) instead of the public
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
  /**
   * Open the REAL wallet-selector modal, lazy-initializing it on first call EVEN in walletless/demo
 * mode (A1). The demo role-picker and the real wallet must coexist: a visitor browsing the
   * sandbox can still click "Connect a wallet" to open the real on-chain path. This NEVER arms the
 * raw-key signer (that stays hard-fenced to localnet) — it only brings up the wallet-selector
   * UI and, once a real wallet is connected, routes writes through it instead of the demo stub.
   */
  realConnect: () => Promise<void>;
  /** A REAL wallet (not the demo picker) is connected — writes go on-chain, not stubbed. */
  realConnected: boolean;
  /**
 * F6: a human-readable reason the LAST connect attempt failed, or null. Set when the wallet
   * handshake never completes within CONNECT_TIMEOUT_MS (e.g. the extension's content-script context is
   * torn down on a flaky cloudflared-fronted origin — "Extension context invalidated"). The UI surfaces
   * this instead of an infinite spinner so a stuck wallet doesn't read as "VRX is broken". Cleared on the
   * next connect attempt or via clearConnectError.
   */
  connectError: string | null;
  /** Clear the connectError banner. */
  clearConnectError: () => void;
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
   * When true, writes sign with a local keypair against :3030 and the account-switcher below is live.
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

// F6: how long to wait for the wallet handshake before giving up and closing the modal. Meteor's
// connect can hang FOREVER on a flaky cloudflared edge (the content-script bridge dies — "Extension context
// invalidated" — and the popup never opens). Without this, the modal spins with no escape and reads as a VRX
// bug. 30s is comfortably longer than a healthy connect (~2-5s) but short enough to not strand a tester.
const CONNECT_TIMEOUT_MS = 30_000;

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;

// Lazy-create the wallet-selector + modal once (module scope — survives re-renders). Shared by the
// NORMAL init effect AND the walletless realConnect path (A1), so a demo visitor can open the
// real wallet modal without the provider having pre-initialized it.
async function ensureSelector(): Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> {
  if (!selector) {
    selector = await setupWalletSelector({
      network: walletNetwork(), // route wallet RPC through our keyed /api/rpc proxy
      modules: [setupMeteorWallet()],
    });
    modal = setupModal(selector, { contractId: CONTRACT_ID });
  }
  return { selector: selector!, modal: modal! };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // A1: true once a REAL wallet (not the demo picker) is connected — flips callFunction off the
  // demo stub and onto the live wallet even when the demo role-UX is armed.
  const [realConnected, setRealConnected] = useState(false);
  // F6: last-connect-attempt failure message (null = no error). Drives the escape-hatch banner.
  const [connectError, setConnectError] = useState<string | null>(null);
  // Live handle to the pending connect-timeout timer so a successful connection can cancel it.
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  //   • god-mode (localnet :3030) — becomeAccount ALSO signs real localnet writes (raw key), OR
  //   • the public DEMO (NEXT_PUBLIC_VRX_DEMO) — becomeAccount sets the browsing identity ONLY; there's no
  //     localnet so no raw signing happens (writes are stubbed in the snapshot demo). This is what lets the
  //  landing role-picker actually BECOME node/org/agent/buyer.test.near on the public box (the bug
  //     hit: becomeAccount was fenced to god-mode, which is off with no localnet → picker landed on Connect).
  // SAFETY: this only sets a client-side accountId for scoping reads; it NEVER arms the raw-key signer, which
  // stays hard-fenced to localnet (isLocalGodMode / dev-signer). Demo writes don't sign (intact).
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
      const { selector: sel } = await ensureSelector();
      // Seed current state, then subscribe to changes.
      const state = sel.store.getState();
      const seeded = state.accounts.find((a) => a.active)?.accountId ?? null;
      setAccountId(seeded);
      setRealConnected(!!seeded);
      const sub = sel.store.observable.subscribe((s) => {
        const id = s.accounts.find((a) => a.active)?.accountId ?? null;
        setAccountId(id);
        setRealConnected(!!id);
      });
      unsub = () => sub.unsubscribe();
      setReady(true);
    })();
    return () => unsub?.();
  }, [walletless]);

  // A1: open the REAL wallet modal, lazy-initializing the selector on first call even
  // walletless/demo mode. When a wallet connects, subscribe to its store so accountId + realConnected
  // reflect the live wallet (overriding any demo-picked identity). Idempotent: re-subscribing is guarded.
  const realSubbed = useRef(false);
  // F6: cancel any pending connect-timeout (a connection landed, or the modal was closed).
  const cancelConnectTimer = useCallback(() => {
    if (connectTimer.current) {
      clearTimeout(connectTimer.current);
      connectTimer.current = null;
    }
  }, []);
  const realConnect = useCallback(async () => {
    const { selector: sel, modal: m } = await ensureSelector();
    if (!realSubbed.current) {
      realSubbed.current = true;
      const apply = (id: string | null) => {
        if (id) {
          // A real wallet connected: it takes over as the active identity + enables on-chain writes.
          if (typeof window !== "undefined") window.localStorage.removeItem(DEV_ACCOUNT_KEY);
          cancelConnectTimer(); // F6: handshake succeeded — don't fire the timeout banner.
          setConnectError(null);
          setAccountId(id);
          setRealConnected(true);
          // Auto gas-drip on first connect: a brand-new/empty wallet has no NEAR to pay for its first write,
          // so top it up best-effort the moment it connects. `connect:true` unlocks the opt-in, testnet-only,
          // 1-ever stranger grant (server-gated + flag-off by default); once they do a write they're a known
          // actor and TxAction.ensureGas handles later top-ups. Fire-and-forget — never block the connect.
          void fetch("/api/faucet", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ account: id, connect: true }),
          }).catch(() => { /* best-effort: a dry/declined faucet must never break sign-in */ });
        } else if (realConnected) {
          // Real wallet signed out (only clear if WE were the real-connected source).
          setAccountId(null);
          setRealConnected(false);
        }
      };
      const st = sel.store.getState();
      apply(st.accounts.find((a) => a.active)?.accountId ?? null);
      sel.store.observable.subscribe((s) => apply(s.accounts.find((a) => a.active)?.accountId ?? null));
    }
    // F6: arm the escape hatch. If no wallet connects within CONNECT_TIMEOUT_MS, the handshake is
    // stuck (typically the extension content-script context dying on a flaky cloudflared edge). Close the
    // modal and surface a message instead of leaving the spinner to run forever. The `apply` subscriber
    // above cancels this timer the instant a connection lands, so a healthy connect never trips it.
    setConnectError(null);
    cancelConnectTimer();
    connectTimer.current = setTimeout(() => {
      connectTimer.current = null;
      // Only fire if STILL not connected (belt-and-suspenders against a race with `apply`).
      const active = selector?.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
      if (!active) {
        try { m.hide(); } catch { /* modal may already be gone */ }
        setConnectError(
          "Couldn't reach your wallet over this connection. Make sure the Meteor extension is unlocked, " +
            "then reload the page and try again — or use the demo role-picker to explore without a wallet."
        );
      }
    }, CONNECT_TIMEOUT_MS);
    m.show();
  }, [realConnected, cancelConnectTimer]);

  // WALLETLESS: "become" an account — set it active + persist, no wallet popup. Works in god-mode (localnet)
  // AND the public demo (picker). In the demo this sets the BROWSING identity only; raw signing stays fenced
  // to localnet (becomeAccount never touches the signer), so this can't sign a real tx off localnet.
  const becomeAccount = useCallback(
    (id: string) => {
      if (!walletless) return; // no-op on a real-wallet deploy; fences guarantee this never arms there
      if (realConnected) return; // A1: a live real wallet wins — don't let the picker override it
      if (typeof window !== "undefined") window.localStorage.setItem(DEV_ACCOUNT_KEY, id);
      setAccountId(id);
    },
    [walletless, realConnected]
  );

  const signIn = useCallback(() => {
    modal?.show();
  }, []);

  const signOut = useCallback(async () => {
    // Walletless (god-mode OR demo): drop the picked account. A1: if a REAL wallet was connected
    // inside the demo box, tear THAT down too (not just the picker identity).
    if (walletless) {
      if (realConnected && selector) {
        try {
          const wallet = await selector.wallet();
          await wallet.signOut();
        } catch {
          /* best-effort */
        }
        setRealConnected(false);
      }
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
  }, [walletless, realConnected]);

  const callFunction = useCallback<WalletCtx["callFunction"]>(
    async ({ method, args, gas = DEFAULT_GAS, deposit = "0" }) => {
      // GOD-MODE: sign+send with a local keypair against :3030 (no wallet). Fence re-checked inside.
      if (godMode) {
        if (!accountId) throw new Error("No dev account selected — use the dev account switcher first.");
        return devCallFunction({ accountId, method, args, gas, deposit });
      }
      // PUBLIC DEMO (walletless, NO localnet): there's no chain to sign against — writes are STUBBED. Return a
      // deterministic fake tx hash so the UI's TxProgress/optimistic path completes without crashing (the
      // off-chain .data write still happens via the API routes). This is the "Sandbox" honesty: a demo booking
      // shows the flow but broadcasts nothing. Real on-chain writes are the deferred (b) localnet step.
      // A1: stub ONLY when still on the demo picker. If a REAL wallet is connected (even inside
      // the demo box), fall through to the live signing path below so the write actually broadcasts.
      if (walletless && !realConnected) {
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
    [godMode, walletless, realConnected, accountId]
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
    //    issues the nonce base64-encoded, so decode it back to bytes for the signature, and send the SAME
    //    base64 back to the server (it re-derives the identical bytes when verifying).
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

  // F6: dismiss the connect-error banner (also kill any in-flight timer).
  const clearConnectError = useCallback(() => {
    cancelConnectTimer();
    setConnectError(null);
  }, [cancelConnectTimer]);

  // Tidy the connect-timeout timer if the provider unmounts mid-handshake.
  useEffect(() => () => cancelConnectTimer(), [cancelConnectTimer]);

  const value = useMemo<WalletCtx>(
    () => ({ accountId, ready, signIn, realConnect, realConnected, connectError, clearConnectError, signOut, callFunction, godMode, becomeAccount, establishSession }),
    [accountId, ready, signIn, realConnect, realConnected, connectError, clearConnectError, signOut, callFunction, godMode, becomeAccount, establishSession]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
