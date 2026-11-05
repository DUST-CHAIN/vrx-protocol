"use client";

// Gas balance + "Top up gas" for the connected account. Two jobs:
//  1. Show the REAL wallet balance (fixes the old placeholder that read $0.00) — resilient: on an RPC
//     outage it shows "—", never a false zero.
//  2. Let a vetted actor request gas from the VRX faucet so their first on-chain write can pay for
//     itself (a brand-new account has no NEAR → can't even begin, the mobile-onboarding blocker).
//
// Vocab: user-facing copy stays plain — "gas", "top up", "balance". No contract/error jargon.

import { useCallback, useEffect, useState } from "react";

type BalResp = { availableNear?: number; exists?: boolean; busy?: boolean };
type FundResp =
  | { ok: true; funded: true; grantedNear: string; balanceAfter: number | null }
  | { ok: true; funded: false; reason: string; balance: number | null }
  | { ok: false; error: string };

export default function GasBalance({ account }: { account: string }) {
  const [bal, setBal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false); // RPC busy (balance unknown)
  const [loading, setLoading] = useState(true);
  const [funding, setFunding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadBalance = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/faucet/balance?account=${encodeURIComponent(account)}`);
      const j = (await r.json()) as BalResp;
      if (j.busy) {
        setBusy(true);
        setBal(null);
      } else {
        setBusy(false);
        setBal(j.availableNear ?? 0);
      }
    } catch {
      setBusy(true);
      setBal(null);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  async function requestGas() {
    setFunding(true);
    setMsg(null);
    try {
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account }),
      });
      const j = (await r.json()) as FundResp;
      if (j.ok && j.funded) {
        setMsg(`Added ${j.grantedNear} gas ✓`);
        await loadBalance();
      } else if (j.ok && !j.funded) {
        setMsg(FRIENDLY[j.reason] ?? "No top-up needed right now.");
        if (j.balance != null) setBal(j.balance);
      } else {
        setMsg(FRIENDLY[j.error] ?? "Couldn’t add gas right now. Please try again.");
      }
    } catch {
      setMsg("Couldn’t add gas right now. Please try again.");
    } finally {
      setFunding(false);
    }
  }

  const low = bal !== null && bal < 0.02;

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.6 }}>Gas balance</span>
        <span style={{ fontSize: 13, fontFamily: "ui-monospace, monospace", color: low ? "#ffb454" : "#c7cde0" }}>
          {loading ? "…" : busy ? "—" : `${(bal ?? 0).toFixed(3)} Ⓝ`}
        </span>
      </div>
      <button onClick={requestGas} disabled={funding} style={btn}>
        {funding ? "Adding gas…" : "Request VRX gas"}
      </button>
      {msg && <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{msg}</div>}
      {busy && !msg && (
        <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>Network busy — balance will refresh.</div>
      )}
    </div>
  );
}

// Reason/error code → plain user copy (no jargon).
const FRIENDLY: Record<string, string> = {
  already_funded: "You already have enough gas.",
  rate_limited: "Gas was topped up recently — try again later.",
  not_eligible: "This account isn’t set up for VRX gas yet.",
  faucet_empty: "The gas pool is low — we’ve been notified.",
  faucet_unconfigured: "Gas top-ups aren’t available right now.",
  send_failed: "Couldn’t add gas right now. Please try again.",
};

const btn: React.CSSProperties = {
  marginTop: 8,
  width: "100%",
  minHeight: 30,
  padding: "6px 10px",
  background: "#152238",
  color: "#a9c0ff",
  border: "1px solid #2a3a5e",
  borderRadius: 7,
  fontSize: 13,
  cursor: "pointer",
};
