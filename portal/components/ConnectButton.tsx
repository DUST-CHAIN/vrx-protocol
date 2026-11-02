"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";

// Connect / account chip for the portal header. Signed out → "Connect wallet". Connected → the active
// account id + a small red × to sign out (asks to confirm, so a stray tap doesn't drop the session).
// Compact so it behaves on a phone header.
// DEMO MODE (S159a-batch): on the public walletless demo there is no NEAR wallet to connect to (writes are
// stubbed, signing is fenced —, so the real "Connect wallet" would open a modal that goes nowhere.
// it visible but label it honestly and, on click, show a one-line explainer instead of a dead modal. The real
// signing path (non-demo deploy) is UNCHANGED: `demoRoleUxArmed` is false there, so `signIn` runs as before.
export default function ConnectButton() {
  const { accountId, ready, signIn, signOut } = useWallet();
  const [confirming, setConfirming] = useState(false);
  const [demo, setDemo] = useState(false);
  const [demoNote, setDemoNote] = useState(false);
  useEffect(() => setDemo(demoRoleUxArmed()), []);

  if (!ready) {
    return <span style={{ opacity: 0.5, fontSize: 14 }}>…</span>;
  }

  if (!accountId) {
    // Demo: honest, non-dead affordance. Real deploy: the normal Connect-wallet button (unchanged).
    if (demo) {
      return (
        <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 3, minWidth: 0 }}>
          <button
            onClick={() => setDemoNote((v) => !v)}
            style={{ ...btn, background: "#1a2234", border: "1px solid #394867", color: "#9ab0ff", fontSize: 13 }}
            title="This preview runs without a wallet — use the role picker. Real wallet sign-in lands this week."
          >
            Demo mode · use the role picker
          </button>
          {demoNote && (
            <span style={{ fontSize: 11, color: "#9aa6be", maxWidth: 260, textAlign: "right", lineHeight: 1.4 }}>
              This preview is walletless — pick a role above to explore. Real wallet connect &amp; on-chain
              signing go live during the hackathon.
            </span>
          )}
        </span>
      );
    }
    return (
      <button onClick={signIn} style={btn}>
        Connect wallet
      </button>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0 }}>
      <span
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 13,
          padding: "5px 9px",
          borderRadius: 8,
          background: "#141824",
          border: "1px solid #232838",
          maxWidth: "42vw",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={`Connected account: ${accountId}`}
      >
        {accountId}
      </span>
      {confirming ? (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <button
            onClick={() => void signOut()}
            style={{ ...xBtn, background: "#3a1414", borderColor: "#7a2a2a", color: "#ff8a8a", width: "auto", padding: "0 8px" }}
            title="Confirm sign out"
          >
            Sign out?
          </button>
          <button onClick={() => setConfirming(false)} style={{ ...xBtn, width: "auto", padding: "0 8px" }} title="Cancel">
            Cancel
          </button>
        </span>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          style={xBtn}
          title="Sign out"
          aria-label="Sign out"
        >
          ×
        </button>
      )}
    </span>
  );
}

const btn: React.CSSProperties = {
  background: "#2b62ff",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "8px 14px",
  fontSize: 14,
  cursor: "pointer",
};

// Small red × — minimal footprint, clearly a "close/leave" affordance.
const xBtn: React.CSSProperties = {
  minHeight: 28,
  height: 28,
  width: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#241417",
  color: "#ff6b6b",
  border: "1px solid #522",
  borderRadius: 7,
  fontSize: 15,
  lineHeight: 1,
  cursor: "pointer",
};
