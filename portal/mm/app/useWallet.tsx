"use client";

// MM wallet context — the SIGNER half of the Model Maker (the MM↔NEAR seal).
//
// Reuses the portal's proven @near-wallet-selector wiring (portal/lib/wallet.tsx, F1 signing arc),
// but SLIMMED to exactly what the seal needs: connect a real NEAR account + signMessage. MM has no on-chain
// WRITE path and no demo/god-mode identity, so none of that machinery comes along — just "who signed off".
//
// signMessage is PURE client crypto (NEP-413 borsh → sha256 → ed25519): it never touches RPC, so the
// network preset below only matters for which wallets/accounts the modal offers. We point at the standard
// testnet preset (the VRX contract lives on testnet). wallet-selector touches `window`, so everything is
// client-only + lazy-initialized in an effect; the selector/modal live in module scope across re-renders.

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
import "./wallet-selector-modal.css"; // de-googled copy (F5): no fonts.googleapis.com leak
import type { SignMessageResult } from "@/lib/seal";

// The VRX contract id (for the modal's connect context) + network. MM is standalone — these mirror the
// portal's defaults (lib/config), env-overridable for a different deploy.
const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK as "testnet" | "mainnet") || "testnet";
const CONTRACT_ID = process.env.NEXT_PUBLIC_VRX_CONTRACT || "calculating-hand.testnet";

type WalletCtx = {
  /** The connected account id, or null when signed out. */
  accountId: string | null;
  /** Selector ready yet? (async init) */
  ready: boolean;
  /** Open the wallet-selector modal to connect a real NEAR account. */
  connect: () => Promise<void>;
  /** Disconnect the active wallet. */
  disconnect: () => Promise<void>;
  /**
   * Sign a NEP-413 message with the connected wallet. Returns {accountId, publicKey, signature} — the
   * raw material the seal is assembled from (lib/seal.assembleSeal) — or null (no wallet / declined /
   * the wallet doesn't implement signMessage).
   */
  signMessage: (args: { message: string; recipient: string; nonceB64: string }) => Promise<SignMessageResult | null>;
};

const Ctx = createContext<WalletCtx | null>(null);

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;

async function ensureSelector(): Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> {
  if (!selector) {
    selector = await setupWalletSelector({
      network: NETWORK,
      modules: [setupMeteorWallet()],
    });
    modal = setupModal(selector, { contractId: CONTRACT_ID });
  }
  return { selector: selector!, modal: modal! };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const { selector: sel } = await ensureSelector();
      const seeded = sel.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
      setAccountId(seeded);
      const sub = sel.store.observable.subscribe((s) => {
        setAccountId(s.accounts.find((a) => a.active)?.accountId ?? null);
      });
      unsub = () => sub.unsubscribe();
      setReady(true);
    })();
    return () => unsub?.();
  }, []);

  const connect = useCallback(async () => {
    const { modal: m } = await ensureSelector();
    m.show();
  }, []);

  const disconnect = useCallback(async () => {
    if (!selector) return;
    try {
      const wallet = await selector.wallet();
      await wallet.signOut();
    } catch {
      /* best-effort */
    }
    setAccountId(null);
  }, []);

  const signMessage = useCallback<WalletCtx["signMessage"]>(async ({ message, recipient, nonceB64 }) => {
    if (!selector) return null;
    const wallet = await selector.wallet();
    const sign = (wallet as { signMessage?: (p: unknown) => Promise<unknown> }).signMessage;
    if (typeof sign !== "function") return null;
    // The wallet's SignMessageParams.nonce is a 32-byte Buffer; we carry the nonce base64 (seal.nonce) and
    // decode to the identical bytes here — the verifier re-derives the same bytes from the same base64.
    const nonce = Buffer.from(nonceB64, "base64");
    const signed = (await sign({ message, recipient, nonce })) as SignMessageResult | void;
    return signed ?? null;
  }, []);

  const value = useMemo<WalletCtx>(
    () => ({ accountId, ready, connect, disconnect, signMessage }),
    [accountId, ready, connect, disconnect, signMessage]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
