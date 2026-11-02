"use client";

// Dev god-mode account switcher — DEV-ONLY, LOCALNET-ONLY.
// A tiny fixed control that only renders when the wallet context reports godMode === true (the
// lib/dev-signer.ts fence: localnet:3030 + NEXT_PUBLIC_VRX_LOCAL_SIGNER=1). It lists the demo
// wallet popup — so the whole app can be walked as dev / agency / agent / buyer walletlessly.
// In a real/prod build godMode is always false (fence), so this component renders nothing — it can
// never leak a walletless signer into a deployment.

import { useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet";

export default function DevAccountSwitcher() {
  const { godMode, accountId, becomeAccount, signOut } = useWallet();
  const [accounts, setAccounts] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!godMode) return;
    fetch("/api/dev-keys")
      .then((r) => (r.ok ? r.json() : { keys: {} }))
      .then((d: { keys?: Record<string, string> }) => setAccounts(Object.keys(d.keys ?? {}).sort()))
      .catch(() => setAccounts([]));
  }, [godMode]);

  if (!godMode) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        zIndex: 99999,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "#3a1f00",
          color: "#ffcf80",
          border: "1px solid #a86a00",
          borderRadius: 6,
          padding: "6px 10px",
          cursor: "pointer",
          boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        }}
        title="God-mode local signer (localnet :3030) — click to switch account"
      >
        ⚡ DEV: {accountId ?? "— pick account —"}
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            background: "#141922",
            border: "1px solid #a86a00",
            borderRadius: 6,
            padding: 6,
            minWidth: 200,
            maxHeight: 320,
            overflowY: "auto",
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ color: "#ffcf80", padding: "2px 6px 6px", borderBottom: "1px solid #2a3140" }}>
            become (no wallet) — :3030
          </div>
          {accounts.length === 0 && (
            <div style={{ color: "#9aa4b2", padding: 6 }}>
              no accounts — run scripts/provision-localnet.mjs
            </div>
          )}
          {accounts.map((id) => (
            <button
              key={id}
              onClick={() => {
                becomeAccount(id);
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: id === accountId ? "#223" : "transparent",
                color: id === accountId ? "#9fe8ff" : "#e8ecf4",
                border: "none",
                borderRadius: 4,
                padding: "5px 6px",
                cursor: "pointer",
              }}
            >
              {id === accountId ? "● " : "○ "}
              {id}
            </button>
          ))}
          {accountId && (
            <button
              onClick={() => {
                void signOut();
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                color: "#9aa4b2",
                background: "transparent",
                border: "none",
                padding: "5px 6px",
                marginTop: 4,
                borderTop: "1px solid #2a3140",
                cursor: "pointer",
              }}
            >
              sign out (become nobody)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
