"use client";

// DeveloperTokensPanel ( slice 7b) — the developer-facing booking-token surface. The developer SEES the
// reservation capacity VRX issued them and HANDS or SELLS a token down to one of their gated agencies,
// choosing the token's economics (the trust-dial: permission = free, stake = refundable, prepaid = credited).
// WHAT THE DEVELOPER DOES HERE (design §lifecycle, decision #3):
// • reads their token inventory + the transparent VRX issuance fee (honest, like the protocol fee);
// • hands a token to a gated agency as "permission" (free), OR sells it as "stake"/"prepaid" — a SALE is
// crypto-only + verified (design §Fairness: a verified transfer is the only receipt the system can check,
// which is what makes the no-theft-by-freeze guarantee real). The developer records the crypto receipt.
// The developer CANNOT mint tokens (that is VRX-root's power). Custody is chain-constrained — a token may only
// go to a gated agency, never peer-to-peer (the lib enforces it; the picker only offers gated agencies).
// (plain words): "capacity", "hand to an agency", "fee" — no state-machine vocabulary, no hash mechanics.
// Reads/writes /api/developer/tokens (developer-scoped). Plain-fetch + T-theme idiom (matches VrxAgreementPanel).

import { useCallback, useEffect, useMemo, useState } from "react";
import { card, input } from "@/lib/ui";
import { T } from "@/lib/theme";

type Economics = "stake" | "prepaid" | "permission";
type IssuanceFee = { amountMinor: number; currency: string; model: "per_token" | "allotment"; at: number };

type Cash = { amountMinor: number; currency: string; disputed: boolean; agencyConfirmedAt: number | null; developerConfirmedAt: number | null } | null;
type Token = {
  id: string;
  state: string;
  stateLabel: string;
  economics: Economics;
  custody: string;
  custodyName: string;
  issuanceFee: IssuanceFee | null;
  tokenPayment: { amountMinor: number; currency: string; refundedAt: number | null } | null;
  cash: Cash;
  recycleOf: string | null;
  buildingId: string | null;
  unitId: string | null;
  issuedAt: number;
};
type Agency = { account: string; name: string };
type Config = { model: "per_token" | "allotment"; feeMinor: number; currency: string; allotmentCap: number | null } | null;
type Resp = { tokens: Token[]; agencies: Agency[]; config: Config };

function fmtMinor(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

const ECON_LABEL: Record<Economics, string> = {
  permission: "Permission (free)",
  stake: "Stake (refundable)",
  prepaid: "Prepaid (credited to the sale)",
};

const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`, background: T.panel2, color: T.text, cursor: "pointer",
  fontSize: 12, padding: "3px 14px", minHeight: 26, height: 26, lineHeight: 1, borderRadius: 999,
};
const btnPrimary: React.CSSProperties = {
  background: T.accent, border: "none", color: "#fff", cursor: "pointer", fontSize: 13.5, padding: "8px 16px", borderRadius: 8,
};

export default function DeveloperTokensPanel({ me }: { me: string }) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/developer/tokens?developer=${encodeURIComponent(me)}&viewer=${encodeURIComponent(me)}`);
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <section style={card}>
        <p style={{ color: T.danger, fontSize: 13 }}>{err}</p>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Retry"}</button>
      </section>
    );
  }
  if (!resp) return <section style={card}><p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p></section>;

  const { tokens, agencies, config } = resp;
  // "In your hands" = issued or returned-recyclable held by the developer — the ones a developer can hand down.
  const handable = tokens.filter((t) => t.state === "issued" && t.custody.toLowerCase() === me.toLowerCase());
  // Tokens whose cash the agency has confirmed, now awaiting the DEVELOPER's "I collected it" confirm (final hop).
  const toCollect = tokens.filter((t) => t.state === "reconciling" && t.cash && !t.cash.disputed);
  const outWithAgencies = tokens.filter((t) => ["with_agency", "with_agent", "committed", "cash_taken"].includes(t.state));
  const done = tokens.filter((t) => ["settled", "recycled", "frozen"].includes(t.state));

  return (
    <section style={{ ...card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>Booking tokens</h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 14px", maxWidth: 680 }}>
        Reservation capacity VRX issued you. Hand a token to one of your agencies so their field agents can
        secure bookings and take deposits on your units. You can hand it free (permission), or sell it as a
        refundable stake or a prepaid credit — a sale is settled in crypto so both sides have a verifiable receipt.
      </p>

      {config && (
        <div style={{ fontSize: 12.5, opacity: 0.7, marginBottom: 14, padding: "6px 10px", background: T.bg2, borderRadius: 8, display: "inline-block" }}>
          VRX issuance fee: <strong>{fmtMinor(config.feeMinor, config.currency)}</strong>{" "}
          {config.model === "per_token" ? "per token" : "per period (allotment)"}
          {config.allotmentCap !== null && <span style={{ opacity: 0.7 }}> · capacity cap {config.allotmentCap}</span>}
        </div>
      )}

      {tokens.length === 0 && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>VRX hasn&rsquo;t issued you any tokens yet. Ask VRX for reservation capacity.</p>
      )}

      {/* Cash to collect — the developer's final reconcile hop */}
      {toCollect.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SectionTitle>Cash to confirm collected · {toCollect.length}</SectionTitle>
          <div style={{ display: "grid", gap: 10 }}>
            {toCollect.map((t) => <ConfirmCollectCard key={t.id} token={t} me={me} onDone={load} />)}
          </div>
        </div>
      )}

      {/* In your hands — handable */}
      {handable.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SectionTitle>In your hands · {handable.length}</SectionTitle>
          <div style={{ display: "grid", gap: 10 }}>
            {handable.map((t) => (
              <HandTokenCard key={t.id} token={t} agencies={agencies} me={me} onDone={load} />
            ))}
          </div>
        </div>
      )}

      {/* Out with agencies / in the field */}
      {outWithAgencies.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SectionTitle>Out in the field · {outWithAgencies.length}</SectionTitle>
          <div style={{ display: "grid", gap: 6 }}>
            {outWithAgencies.map((t) => <TokenRow key={t.id} token={t} />)}
          </div>
        </div>
      )}

      {/* Settled / returned */}
      {done.length > 0 && (
        <div>
          <SectionTitle>Settled &amp; returned · {done.length}</SectionTitle>
          <div style={{ display: "grid", gap: 6 }}>
            {done.map((t) => <TokenRow key={t.id} token={t} />)}
          </div>
        </div>
      )}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55, margin: "4px 0 8px" }}>{children}</div>;
}

// Compact read row for a token no longer actionable by the developer (out in the field / done).
function TokenRow({ token }: { token: Token }) {
  const tone = token.state === "settled" ? T.vetted : token.state === "frozen" ? T.hold : token.state === "recycled" ? T.dim : T.text;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", fontSize: 13.5, padding: "5px 10px", borderRadius: 6, background: T.bg2 }}>
      <span style={{ color: tone }}>{token.stateLabel}</span>
      <span style={{ fontSize: 12.5, opacity: 0.7 }}>
        {token.custodyName !== token.custody ? token.custodyName : "—"}
        {token.unitId ? ` · unit ${token.unitId}` : ""}
        {token.recycleOf ? " · re-issued" : ""}
      </span>
    </div>
  );
}

// The developer's final reconcile hop: the agency confirmed it received the cash; the developer confirms it
// collected it from the agency (reconciling → settled). After this the token's deal is closed.
function ConfirmCollectCard({ token, me, onDone }: { token: Token; me: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/developer/tokens", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ developer: me, op: "confirmCash", tokenId: token.id }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not confirm."); return; }
      onDone();
    } catch { setMsg("Could not confirm."); } finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", borderColor: T.hold }}>
      <div style={{ fontSize: 13.5 }}>
        An agency confirmed it received{" "}
        <strong>{token.cash ? fmtMinor(token.cash.amountMinor, token.cash.currency) : "the cash"}</strong>
        {token.unitId ? ` on unit ${token.unitId}` : ""}. Confirm you collected it from them to settle this token.
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <button type="button" onClick={confirm} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Confirming…" : "I collected this cash"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}

// An actionable "in your hands" token — pick economics + agency, optionally record the crypto sale receipt, hand it.
function HandTokenCard({
  token, agencies, me, onDone,
}: { token: Token; agencies: Agency[]; me: string; onDone: () => void }) {
  const [economics, setEconomics] = useState<Economics>(token.economics);
  const [toAgency, setToAgency] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USDC");
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const isSale = economics === "stake" || economics === "prepaid";

  const hand = async () => {
    setBusy(true); setMsg(null); setOk(false);
    try {
      const payment = isSale
        ? { rail: "crypto", amountMinor: Math.round(Number(amount) * 100), currency: currency.trim(), txHash: txHash.trim() }
        : undefined;
      const res = await fetch("/api/developer/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ developer: me, op: "hand", tokenId: token.id, toAgency, economics, payment }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not hand the token."); return; }
      setOk(true);
      setMsg("Handed.");
      onDone();
    } catch {
      setMsg("Could not hand the token.");
    } finally {
      setBusy(false);
    }
  };

  const canHand = !!toAgency && (!isSale || (Number(amount) > 0 && txHash.trim().length > 0));

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", background: T.bg2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>Hand a token to an agency</strong>
        {token.issuanceFee && token.issuanceFee.amountMinor > 0 && (
          <span style={{ fontSize: 11.5, opacity: 0.6 }}>issued at {fmtMinor(token.issuanceFee.amountMinor, token.issuanceFee.currency)}</span>
        )}
      </div>

      {agencies.length === 0 && (
        <div style={{ fontSize: 12.5, color: T.hold, marginTop: 8 }}>
          You have no agencies with access yet. Grant an agency access first (Agency access).
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginTop: 10 }}>
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Agency</span>
          <select value={toAgency} onChange={(e) => setToAgency(e.target.value)} style={{ ...input, marginBottom: 0, fontSize: 14 }}>
            <option value="">Select…</option>
            {agencies.map((a) => <option key={a.account} value={a.account}>{a.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>How it&rsquo;s given</span>
          <select value={economics} onChange={(e) => setEconomics(e.target.value as Economics)} style={{ ...input, marginBottom: 0, fontSize: 14 }}>
            <option value="permission">{ECON_LABEL.permission}</option>
            <option value="stake">{ECON_LABEL.stake}</option>
            <option value="prepaid">{ECON_LABEL.prepaid}</option>
          </select>
        </label>
      </div>

      {isSale && (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.accentSoft}` }}>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
            A sale is crypto-only — record the verified transfer so both sides have a receipt. The agency&rsquo;s
            stake is refundable if the token is ever recalled.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
            <label style={{ fontSize: 12.5 }}>
              <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Amount</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
            </label>
            <label style={{ fontSize: 12.5 }}>
              <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Currency</span>
              <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="USDC" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
            </label>
            <label style={{ fontSize: 12.5 }}>
              <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Transfer reference</span>
              <input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="tx hash" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
            </label>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button type="button" onClick={hand} disabled={busy || !canHand} style={{ ...btnPrimary, opacity: busy || !canHand ? 0.5 : 1 }}>
          {busy ? "Handing…" : "Hand to agency"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: ok ? T.vetted : T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}
