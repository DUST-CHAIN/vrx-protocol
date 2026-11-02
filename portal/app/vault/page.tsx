"use client";

// Operator KYC-vault unlock console (Tier 2). A deliberately plain operator-only page: see the vault
// lock status, unseal it for this server session by pasting the OFFLINE operator key, or lock it again.
// In dev the vault auto-unlocks (non-secret dev key) so you won't normally need this; it's here for the real
// LOCKED posture and to exercise the unlock/lock flow. The pasted key is sent once to /api/kyc-vault/unlock
// and never stored anywhere (not localStorage, not a cookie) — a server restart re-locks. This page shows NO
// key material back. A production deploy should sit this behind the operator's own auth (out of scope now).

import { useCallback, useEffect, useState } from "react";

type Status = { unlocked: boolean; via?: "session" | "env" | "dev"; provisioned: boolean };

export default function VaultUnlock() {
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/kyc-vault/unlock", { cache: "no-store" });
      setStatus(await r.json());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function unlock() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/kyc-vault/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      const j = await r.json();
      if (!r.ok) {
        setMsg(j.error || "unlock failed");
      } else {
        setStatus(j);
        setKey(""); // drop the key from the field immediately
        setMsg("Vault unlocked for this server session.");
      }
    } catch {
      setMsg("network error");
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/kyc-vault/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "lock" }),
      });
      setStatus(await r.json());
      setMsg("Vault locked.");
    } catch {
      setMsg("network error");
    } finally {
      setBusy(false);
    }
  }

  const viaLabel =
    status?.via === "session"
      ? "unlocked by operator this session"
      : status?.via === "env"
        ? "auto-unlocked from VRX_KYC_OPERATOR_KEY (testing/deliberate)"
        : status?.via === "dev"
          ? "auto-unlocked with the NON-SECRET dev key (not breach-safe)"
          : "";

  return (
    <main style={{ maxWidth: 620, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>KYC vault — operator</h1>
      <p style={{ color: "#666", marginTop: 0, fontSize: 14 }}>
        The buyer-identity document vault is encrypted at rest and stays <b>locked</b> until an operator
        unseals it for the running server. The key is presented once and never stored.
      </p>

      <div
        style={{
          margin: "20px 0",
          padding: 16,
          borderRadius: 10,
          border: "1px solid #e2e2e2",
          background: status?.unlocked ? "#f1fbf3" : "#fdf3f1",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          {status == null ? "…" : status.unlocked ? "🔓 Unlocked" : "🔒 Locked"}
        </div>
        {viaLabel && <div style={{ fontSize: 13, color: "#555", marginTop: 4 }}>{viaLabel}</div>}
        {status && !status.provisioned && (
          <div style={{ fontSize: 13, color: "#8a5000", marginTop: 4 }}>
            No sealed key on disk yet — the first successful unlock will seal a fresh vault key to that operator.
          </div>
        )}
      </div>

      <label style={{ display: "block", fontSize: 13, color: "#444", marginBottom: 6 }}>
        Operator private key (base64)
      </label>
      <textarea
        value={key}
        onChange={(e) => setKey(e.target.value)}
        rows={3}
        placeholder="paste the offline operator key…"
        style={{
          width: "100%",
          fontFamily: "monospace",
          fontSize: 12,
          padding: 10,
          borderRadius: 8,
          border: "1px solid #ccc",
          boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button
          onClick={unlock}
          disabled={busy || !key.trim()}
          style={{
            padding: "9px 16px",
            borderRadius: 8,
            border: "none",
            background: busy || !key.trim() ? "#bbb" : "#1a7f3c",
            color: "#fff",
            fontWeight: 600,
            cursor: busy || !key.trim() ? "default" : "pointer",
          }}
        >
          Unlock
        </button>
        {status?.unlocked && (
          <button
            onClick={lock}
            disabled={busy}
            style={{
              padding: "9px 16px",
              borderRadius: 8,
              border: "1px solid #c33",
              background: "#fff",
              color: "#c33",
              fontWeight: 600,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Lock
          </button>
        )}
      </div>

      {msg && <p style={{ marginTop: 14, fontSize: 13, color: "#333" }}>{msg}</p>}
    </main>
  );
}
