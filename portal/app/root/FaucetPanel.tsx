"use client";

// VRX-ROOT gas-faucet panel — the operator's place to WATCH and TOP UP the gas faucet. The faucet
// (vrx-faucet-01.testnet) auto-funds vetted actors (and, when VRX_FAUCET_ALLOW_STRANGERS=1, any brand-new
// wallet on its first connect) so their first on-chain write can pay gas. It is a DRAIN-ONLY pool: it never
// refills itself (impossible on mainnet; unreliable on testnet), so when it runs low an operator sends NEAR
// to the faucet account by hand. This panel surfaces the balance + how-many-grants-left + the address to
// top up, so the operator refills BEFORE it bites (a dry faucet silently drops back to the empty-wallet wall).
//
// Reads /api/faucet/status + /api/faucet/log (operator-gated, fail-closed — same x-vrx-operator posture as the
// sibling root panels). Read-only: no funds move from the browser (the browser can't sign the faucet account);
// "top up" is a copyable address + instructions, not a button. PRIVACY: neutral account ids + balances
// only, no PII.

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";
import { card } from "@/lib/ui";
import { timeAgo } from "@/lib/catalog-client";

type Status = {
  account: string;
  availableNear: number | null;
  grantNear: number;
  reserveNear: number;
  grantsRemaining: number | null;
  low: boolean;
  allowStrangers: boolean;
  configured: boolean;
};
type Note = {
  account: string;
  balanceBefore: number | null;
  grantedNear: string;
  tx?: string;
  at: number;
  via: string;
  skipped?: string;
};

const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  background: T.panel2,
  color: T.text,
  cursor: "pointer",
  fontSize: 12,
  padding: "3px 14px",
  minHeight: 26,
  height: 26,
  lineHeight: 1,
  borderRadius: 999,
};

const copyBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  background: T.panel2,
  color: T.text,
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 6,
};

function near(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(3)} NEAR`;
}

export default function FaucetPanel({ headers }: { headers: Record<string, string> | undefined }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([
        fetch("/api/faucet/status", { headers }).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/faucet/log", { headers }).then((r) => (r.ok ? r.json() : { notes: [] })),
      ]);
      if (s && !s.error) setStatus(s as Status);
      setNotes(((l?.notes as Note[]) ?? []).slice(0, 25));
    } catch {
      /* operator will see "—" + can retry */
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const copyAddress = useCallback(async () => {
    if (!status?.account) return;
    try {
      await navigator.clipboard.writeText(status.account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — operator can select the text manually */
    }
  }, [status]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Gas faucet</h2>
        <button style={refreshBtn} onClick={() => void load()} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      <p style={{ margin: 0, color: T.dim, fontSize: 13, lineHeight: 1.5 }}>
        Auto-funds vetted actors (and, when enabled, any brand-new wallet on its first connect) so their first
        on-chain write can pay gas. It does <strong>not</strong> refill itself — top it up by hand when it runs low.
      </p>

      {!status?.configured && status !== null && (
        <div style={{ ...card, borderColor: T.danger, color: T.danger, fontSize: 13 }}>
          ⚠ The faucet isn’t configured on this deploy (VRX_FAUCET_ACCOUNT / VRX_FAUCET_SECRET unset) — it can’t
          send gas. Set them in the box env to enable auto-funding.
        </div>
      )}

      {status?.low && status.configured && (
        <div style={{ ...card, borderColor: T.danger, color: T.danger, fontSize: 13 }}>
          ⚠ The faucet is <strong>low</strong> — it can’t fund another grant without crossing its{" "}
          {status.reserveNear} NEAR reserve. Top it up now (below) so connects keep auto-funding.
        </div>
      )}

      {/* Balance + math */}
      <div style={{ ...card, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <div style={{ color: T.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Balance</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{near(status?.availableNear ?? null)}</div>
        </div>
        <div>
          <div style={{ color: T.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Grants remaining
          </div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {status?.grantsRemaining === null || status?.grantsRemaining === undefined
              ? "—"
              : `~${status.grantsRemaining}`}
          </div>
        </div>
        <div style={{ color: T.dim, fontSize: 12, gridColumn: "1 / -1" }}>
          {status ? (
            <>
              {status.grantNear} NEAR per grant · keeps a {status.reserveNear} NEAR reserve · stranger
              auto-fund on connect: <strong>{status.allowStrangers ? "ON" : "off"}</strong>
            </>
          ) : (
            "Loading…"
          )}
        </div>
      </div>

      {/* Top up */}
      {status?.account && (
        <div style={{ ...card }}>
          <div style={{ color: T.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            Top up — send NEAR to this account
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <code style={{ fontSize: 14, fontWeight: 600, wordBreak: "break-all" }}>{status.account}</code>
            <button style={copyBtn} onClick={() => void copyAddress()}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p style={{ margin: "8px 0 0", color: T.dim, fontSize: 12, lineHeight: 1.5 }}>
            Send testnet NEAR from your own wallet, or request some from the public testnet faucet, to the
            address above. There’s no self-refill — this account drains as it funds actors.
          </p>
        </div>
      )}

      {/* Recent activity */}
      <div>
        <div style={{ color: T.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
          Recent faucet activity
        </div>
        {notes.length === 0 ? (
          <div style={{ color: T.dim, fontSize: 13 }}>No faucet activity yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {notes.map((n, i) => (
              <div
                key={i}
                style={{
                  ...card,
                  padding: "8px 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  fontSize: 13,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <code style={{ fontWeight: 600 }}>{n.account}</code>{" "}
                  <span style={{ color: T.dim }}>· {n.via}</span>
                </div>
                <div style={{ whiteSpace: "nowrap", color: n.tx ? T.text : T.dim }}>
                  {n.tx ? `+${n.grantedNear} NEAR` : n.skipped ?? "skipped"} · {timeAgo(n.at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
