"use client";

// /wallet (F12) — the universal $VRX balance home. $VRX is an OFF-CHAIN VRX-native ledger (NOT an
// on-chain token), so a user's $VRX balance can ONLY be shown inside VRX's own UI — a connected Meteor wallet
// would show their NEAR balance, never their $VRX. Before this route the only $VRX wallet surface lived on
// /agent; the topbar balance chip and the onboarding airdrop/credits toasts had nowhere universal to send a
// user who wanted to "see my balance". This thin page gives every role (demo OR real) that home by reusing the
// existing VrxWalletPanel (balance + claim + send + spend + history). No new ledger code.
//
// Account source: the wallet context's accountId — the demo-picked identity in sandbox mode, or the connected
// real wallet otherwise. If there's no account yet we send the visitor back to the landing role-picker.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useWallet } from "@/lib/wallet";
import VrxWalletPanel from "@/components/VrxWalletPanel";
import { T } from "@/lib/theme";

export default function WalletPage() {
  const { accountId, ready } = useWallet();
  const router = useRouter();

  // No account (not connected / no demo role picked yet) → back to the landing picker to choose one.
  useEffect(() => {
    if (ready && !accountId) router.replace("/");
  }, [ready, accountId, router]);

  if (!ready) {
    return <main style={shell}><p style={{ opacity: 0.6 }}>Loading your wallet…</p></main>;
  }
  if (!accountId) {
    return <main style={shell}><p style={{ opacity: 0.6 }}>Redirecting…</p></main>;
  }

  return (
    <main style={shell}>
      <Link href="/" style={{ color: T.dim, fontSize: 13, textDecoration: "none" }}>← Back</Link>
      <h1 style={{ fontSize: 24, margin: "12px 0 4px", color: T.text }}>Your $VRX wallet</h1>
      <p style={{ fontSize: 13.5, color: T.dim, lineHeight: 1.55, marginTop: 0 }}>
        Your in-system $VRX balance, claims and history for <strong style={{ color: T.text }}>{accountId}</strong>.
        $VRX is a VRX-native platform credit (not an on-chain token) — it lives here, in your VRX wallet.
      </p>
      <VrxWalletPanel me={accountId} />
    </main>
  );
}

const shell: React.CSSProperties = { maxWidth: 720, margin: "0 auto", padding: "40px 20px" };
