"use client";

// side of the halt lever: a developer who asks us first (a REGULAR halt) records it `pending` — it does NOT
// hide the building until VRX ACKNOWLEDGES it here. Urgent halts are already active and never appear in this
// queue (they're shown as context only, not actionable).
// halt — a developer may always pause their own building. It's VRX being in the loop before a non-urgent
// pause takes effect, exactly as the developer asked. The developer's NOTE is visible here (VRX is a party).
// Reads/writes /api/root/halts (operator-gated, fail-closed — same x-vrx-operator posture as the sibling root
// panels). Plain fetch + useState idiom, mirroring BookingTokensPanel / PaymentsPanel. `headers` carries the
// operator secret.

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";
import { card } from "@/lib/ui";
import { timeAgo } from "@/lib/catalog-client";

type HaltTier = "regular" | "urgent";
type PublicHalt = {
  id: string;
  building: string;
  developer: string;
  tier: HaltTier;
  note: string;
  status: "pending" | "active" | "lifted";
  assertedAt: number;
  at: number;
  updatedAt: number;
};
type Resp = { pending: PublicHalt[] };

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

const ackBtn: React.CSSProperties = {
  background: T.accent,
  border: "none",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
  padding: "7px 14px",
  borderRadius: 8,
};

export default function HaltQueuePanel({ headers }: { headers: Record<string, string> | undefined }) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [acking, setAcking] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/root/halts", { headers });
      if (res.status === 401) {
        setErr("Operator secret required (set it in ⚙ Settings).");
        setResp(null);
        return;
      }
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    load();
  }, [load]);

  const acknowledge = useCallback(
    async (id: string) => {
      setAcking(id);
      setActionMsg(null);
      try {
        const res = await fetch("/api/root/halts", {
          method: "POST",
          headers: { ...(headers ?? {}), "content-type": "application/json" },
          body: JSON.stringify({ action: "acknowledge", id }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setActionMsg(j?.error || "Could not acknowledge.");
          return;
        }
        setActionMsg("Pause acknowledged — the building is now hidden from new bookings & browsing.");
        await load();
      } catch {
        setActionMsg("Could not acknowledge.");
      } finally {
        setAcking(null);
      }
    },
    [headers, load]
  );

  if (err) {
    return (
      <section style={card}>
        <p style={{ color: T.danger, fontSize: 13 }}>{err}</p>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>
          {loading ? "…" : "Retry"}
        </button>
      </section>
    );
  }
  if (!resp) {
    return (
      <section style={card}>
        <p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p>
      </section>
    );
  }

  const pending = resp.pending;

  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>Building pauses</h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 16px", maxWidth: 680 }}>
        A developer who asks us first (a <strong>regular</strong> pause) records it here — the building stays
        visible until you acknowledge it, which is when the pause takes effect. Urgent pauses take effect at
        once and don&rsquo;t need acknowledging. Acknowledging isn&rsquo;t granting permission — a developer may
        always pause their own building; this just keeps VRX in the loop before a non-urgent pause lands.
      </p>

      {actionMsg && (
        <p style={{ fontSize: 12.5, marginBottom: 12, color: actionMsg.startsWith("Could not") ? T.danger : T.vetted }}>
          {actionMsg}
        </p>
      )}

      {pending.length === 0 ? (
        <p style={{ fontSize: 13.5, opacity: 0.55 }}>No pauses awaiting acknowledgement.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {pending.map((h) => (
            <div key={h.id} style={{ ...card, marginTop: 0, padding: "12px 14px", borderColor: T.hold + "55" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 15 }}>{h.building}</strong>
                <span style={{ fontSize: 11.5, color: T.hold }}>Regular · requested {timeAgo(h.assertedAt)}</span>
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 2 }}>by {h.developer}</div>
              <p style={{ fontSize: 13.5, margin: "8px 0 0", lineHeight: 1.5 }}>
                <span style={{ opacity: 0.6 }}>Their note:</span> “{h.note}”
              </p>
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => acknowledge(h.id)}
                  disabled={acking === h.id}
                  style={{ ...ackBtn, opacity: acking === h.id ? 0.6 : 1 }}
                >
                  {acking === h.id ? "…" : "Acknowledge pause"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
