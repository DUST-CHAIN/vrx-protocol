"use client";

// AgentTokensPanel ( slice 7c) — the field AGENT's booking-token surface. The agent holds a token its
// agency handed down, uses it to SECURE A BOOKING on a unit (one booking per token), and RECORDS the
// customer's CASH it took on the spot. A booking that falls through before cash can be RELEASED.
// THE FIELD FLOW (design §lifecycle): with_agent → [secure booking] → committed → [record cash] → cash_taken,
// then the trust travels up: the agency confirms it received the cash, then the developer confirms collection.
// CASH PHOTO (seam #2): the agent attaches a PHOTO of the receipt when recording the cash. It is
// encrypted at rest in a token-scoped vault (lib/token-evidence, reusing the AES-GCM pipeline) — the bytes
// never leave the server unencrypted. The form POSTs multipart; the recorded photo is shown back through
// the authorized read route /api/agent/tokens/evidence (the agent is the current holder → a standing viewer).
// plain words throughout. Reads/writes /api/agent/tokens (+ /api/agent/tokens/evidence for the photo).

import { useCallback, useEffect, useState } from "react";
import { card, input } from "@/lib/ui";
import { T } from "@/lib/theme";

type Cash = { amountMinor: number; currency: string; disputed: boolean; evidenceId: string | null; agencyConfirmedAt: number | null; developerConfirmedAt: number | null } | null;
type Token = {
  id: string; state: string; stateLabel: string; economics: string;
  developer: string; developerName: string;
  buildingId: string | null; unitId: string | null; requestId: string | null; cash: Cash; issuedAt: number;
};
type Resp = { tokens: Token[] };

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
const btnGhost: React.CSSProperties = {
  background: "transparent", border: `1px solid ${T.border}`, color: T.dim, cursor: "pointer", fontSize: 12.5, padding: "6px 12px", borderRadius: 8,
};

export default function AgentTokensPanel({ me }: { me: string }) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch(`/api/agent/tokens?agent=${encodeURIComponent(me)}&viewer=${encodeURIComponent(me)}`);
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

  const { tokens } = resp;

  return (
    <section style={{ ...card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>Booking tokens</h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 14px", maxWidth: 680 }}>
        Tokens your agency gave you. Use one to secure a booking on a unit while you&rsquo;re with a customer,
        and record the cash you took on the spot. Your agency then confirms it received the money.
      </p>

      {tokens.length === 0 && <p style={{ opacity: 0.6, fontSize: 14 }}>No tokens yet. Your agency hands you a booking token to secure a unit in the field.</p>}

      <div style={{ display: "grid", gap: 10 }}>
        {tokens.map((t) => <AgentTokenCard key={t.id} token={t} me={me} onDone={load} />)}
      </div>
    </section>
  );
}

function AgentTokenCard({ token, me, onDone }: { token: Token; me: string; onDone: () => void }) {
  const tone =
    token.state === "with_agent" ? T.accent :
    token.state === "committed" ? T.hold :
    token.state === "settled" ? T.vetted : T.text;

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", background: T.bg2, borderColor: tone }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14, color: tone }}>{token.stateLabel}</strong>
        <span style={{ fontSize: 12, opacity: 0.6 }}>{token.developerName}{token.unitId ? ` · unit ${token.unitId}` : ""}</span>
      </div>

      {token.state === "with_agent" && <CommitForm token={token} me={me} onDone={onDone} />}
      {token.state === "committed" && <RecordCashForm token={token} me={me} onDone={onDone} />}
      {token.cash && token.state !== "committed" && (
        <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 8 }}>
          Cash recorded: <strong>{fmtMinor(token.cash.amountMinor, token.cash.currency)}</strong>
          {token.cash.disputed ? <span style={{ color: T.danger }}> · disputed</span> :
            token.cash.developerConfirmedAt ? <span style={{ color: T.vetted }}> · settled</span> :
            token.cash.agencyConfirmedAt ? " · your agency confirmed, awaiting the developer" : " · awaiting your agency"}
          {token.cash.evidenceId && (
            <>
              {" · "}
              <a
                href={`/api/agent/tokens/evidence?id=${encodeURIComponent(token.cash.evidenceId)}&viewer=${encodeURIComponent(me)}`}
                target="_blank" rel="noopener noreferrer"
                style={{ color: T.accent, textDecoration: "underline" }}
              >
                receipt photo
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CommitForm({ token, me, onDone }: { token: Token; me: string; onDone: () => void }) {
  const [buildingId, setBuildingId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const commit = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/agent/tokens", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: me, op: "commit", tokenId: token.id, buildingId: buildingId.trim(), unitId: unitId.trim() }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not secure the booking."); return; }
      onDone();
    } catch { setMsg("Could not secure the booking."); } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>Secure a booking — enter the building and unit this token reserves. One booking per token.</div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, flex: "1 1 140px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Building</span>
          <input value={buildingId} onChange={(e) => setBuildingId(e.target.value)} placeholder="building id" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <label style={{ fontSize: 12.5, flex: "1 1 120px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Unit</span>
          <input value={unitId} onChange={(e) => setUnitId(e.target.value)} placeholder="unit id" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <button type="button" onClick={commit} disabled={busy || !buildingId.trim() || !unitId.trim()} style={{ ...btnPrimary, opacity: busy || !buildingId.trim() || !unitId.trim() ? 0.5 : 1 }}>
          {busy ? "Securing…" : "Secure booking"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}

function RecordCashForm({ token, me, onDone }: { token: Token; me: string; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("THB");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const record = async () => {
    setBusy(true); setMsg(null);
    try {
      // Multipart — carries the optional receipt photo, which the route encrypts into the token-scoped vault
      // before recording the cash with its reference. Amount/currency ride as form fields alongside.
      const fd = new FormData();
      fd.set("agent", me);
      fd.set("op", "recordCash");
      fd.set("tokenId", token.id);
      fd.set("amountMinor", String(Math.round(Number(amount) * 100)));
      fd.set("currency", currency.trim());
      if (photo) fd.set("photo", photo);
      const res = await fetch("/api/agent/tokens", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not record the cash."); return; }
      onDone();
    } catch { setMsg("Could not record the cash."); } finally { setBusy(false); }
  };

  const release = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/agent/tokens", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: me, op: "release", tokenId: token.id }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not release the booking."); return; }
      onDone();
    } catch { setMsg("Could not release the booking."); } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>
        Booking secured{token.buildingId ? ` on ${token.buildingId}${token.unitId ? ` · unit ${token.unitId}` : ""}` : ""}.
        Record the cash you took from the customer. Attach a photo of the receipt — it&rsquo;s encrypted and only
        you, your agency and the developer can ever see it.
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, flex: "1 1 110px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Amount</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <label style={{ fontSize: 12.5, flex: "0 1 90px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Currency</span>
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="THB" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <label style={{ fontSize: 12.5, flex: "1 1 160px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Receipt photo (optional)</span>
          <input
            type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            style={{ fontSize: 12.5, marginBottom: 0 }}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <button type="button" onClick={record} disabled={busy || !(Number(amount) > 0)} style={{ ...btnPrimary, opacity: busy || !(Number(amount) > 0) ? 0.5 : 1 }}>
          {busy ? "Recording…" : "Record cash taken"}
        </button>
        <button type="button" onClick={release} disabled={busy} style={btnGhost}>Booking fell through — release</button>
        {msg && <span style={{ fontSize: 12.5, color: T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}
