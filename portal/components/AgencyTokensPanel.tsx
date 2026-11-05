"use client";

// AgencyTokensPanel (slice 7c) — the agency's booking-token surface. The agency holds tokens a developer
// handed/sold it, HANDS one down to one of its OWN field agents, and CONFIRMS it received the customer's cash
// from an agent (the middle hop of the three-hop reconcile: agent records → AGENCY confirms → developer confirms).
//
// Custody is chain-constrained: a token may only go to one of THIS agency's own agents (the picker offers only
// those; the lib refuses anything else). plain words throughout. Reads/writes /api/agency/tokens.

import { useCallback, useEffect, useState } from "react";
import { card, input } from "@/lib/ui";
import { T } from "@/lib/theme";

type Cash = { amountMinor: number; currency: string; takenBy: string; takenByName: string; disputed: boolean; agencyConfirmedAt: number | null } | null;
type Token = {
  id: string; state: string; stateLabel: string; economics: string;
  custody: string; custodyName: string; developer: string; developerName: string;
  unitId: string | null; buildingId: string | null; cash: Cash; issuedAt: number;
};
type Agent = { account: string; name: string };
type Resp = { tokens: Token[]; agents: Agent[] };

function fmtMinor(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`, background: T.panel2, color: T.text, cursor: "pointer",
  fontSize: 12, padding: "3px 14px", minHeight: 26, height: 26, lineHeight: 1, borderRadius: 999,
};
const btnPrimary: React.CSSProperties = {
  background: T.accent, border: "none", color: "#fff", cursor: "pointer", fontSize: 13.5, padding: "7px 14px", borderRadius: 8,
};

export default function AgencyTokensPanel({ me }: { me: string }) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch(`/api/agency/tokens?agency=${encodeURIComponent(me)}&viewer=${encodeURIComponent(me)}`);
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => { load(); }, [load]);

  if (err) return <section style={card}><p style={{ color: T.danger, fontSize: 13 }}>{err}</p><button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Retry"}</button></section>;
  if (!resp) return <section style={card}><p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p></section>;

  const { tokens, agents } = resp;
  const handable = tokens.filter((t) => t.state === "with_agency" && t.custody.toLowerCase() === me.toLowerCase());
  const toConfirm = tokens.filter((t) => t.state === "cash_taken" && t.cash && !t.cash.disputed);
  const other = tokens.filter((t) => !handable.includes(t) && !toConfirm.includes(t));

  return (
    <section style={{ ...card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>Booking tokens</h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 14px", maxWidth: 680 }}>
        Reservation capacity a developer gave you. Hand a token to one of your field agents so they can secure a
        booking and take a deposit on the ground. When an agent takes cash, confirm here that you received it —
        the developer then confirms they collected it from you.
      </p>

      {tokens.length === 0 && <p style={{ opacity: 0.6, fontSize: 14 }}>No tokens yet. A developer hands you booking tokens for units you can sell.</p>}

      {toConfirm.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SectionTitle tone={T.hold}>Cash to confirm · {toConfirm.length}</SectionTitle>
          <div style={{ display: "grid", gap: 10 }}>
            {toConfirm.map((t) => <ConfirmCashCard key={t.id} token={t} me={me} onDone={load} />)}
          </div>
        </div>
      )}

      {handable.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SectionTitle>In your hands · {handable.length}</SectionTitle>
          <div style={{ display: "grid", gap: 10 }}>
            {handable.map((t) => <HandToAgentCard key={t.id} token={t} agents={agents} me={me} onDone={load} />)}
          </div>
        </div>
      )}

      {other.length > 0 && (
        <div>
          <SectionTitle>Out in the field &amp; settled · {other.length}</SectionTitle>
          <div style={{ display: "grid", gap: 6 }}>
            {other.map((t) => (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", fontSize: 13.5, padding: "5px 10px", borderRadius: 6, background: T.bg2 }}>
                <span style={{ color: t.state === "settled" ? T.vetted : T.text }}>{t.stateLabel}</span>
                <span style={{ fontSize: 12.5, opacity: 0.7 }}>{t.developerName}{t.unitId ? ` · unit ${t.unitId}` : ""}{t.cash ? ` · ${fmtMinor(t.cash.amountMinor, t.cash.currency)}` : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SectionTitle({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6, color: tone, margin: "4px 0 8px" }}>{children}</div>;
}

function HandToAgentCard({ token, agents, me, onDone }: { token: Token; agents: Agent[]; me: string; onDone: () => void }) {
  const [toAgent, setToAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const hand = async () => {
    setBusy(true); setMsg(null); setOk(false);
    try {
      const res = await fetch("/api/agency/tokens", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agency: me, op: "hand", tokenId: token.id, toAgent }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not hand the token."); return; }
      setOk(true); setMsg("Handed to agent."); onDone();
    } catch { setMsg("Could not hand the token."); } finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", background: T.bg2 }}>
      <div style={{ fontSize: 13.5, marginBottom: 8 }}>
        A token from <strong>{token.developerName}</strong> — hand it to a field agent to use on the ground.
      </div>
      {agents.length === 0 && <div style={{ fontSize: 12.5, color: T.hold, marginBottom: 8 }}>You have no field agents yet (add one under My agents).</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, flex: "1 1 180px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Field agent</span>
          <select value={toAgent} onChange={(e) => setToAgent(e.target.value)} style={{ ...input, marginBottom: 0, fontSize: 14 }}>
            <option value="">Select…</option>
            {agents.map((a) => <option key={a.account} value={a.account}>{a.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={hand} disabled={busy || !toAgent} style={{ ...btnPrimary, opacity: busy || !toAgent ? 0.5 : 1 }}>
          {busy ? "Handing…" : "Hand to agent"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: ok ? T.vetted : T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}

function ConfirmCashCard({ token, me, onDone }: { token: Token; me: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/agency/tokens", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agency: me, op: "confirmCash", tokenId: token.id }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not confirm."); return; }
      onDone();
    } catch { setMsg("Could not confirm."); } finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", borderColor: T.hold }}>
      <div style={{ fontSize: 13.5 }}>
        <strong>{token.cash ? token.cash.takenByName : "An agent"}</strong> recorded{" "}
        <strong>{token.cash ? fmtMinor(token.cash.amountMinor, token.cash.currency) : "cash"}</strong> taken
        {token.unitId ? ` on unit ${token.unitId}` : ""}. Confirm you received this cash from them.
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <button type="button" onClick={confirm} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Confirming…" : "I received this cash"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}
