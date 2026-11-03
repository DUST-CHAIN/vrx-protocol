"use client";

// VrxWalletPanel — the real transferable $VRX surface. REPLACES the old DemoCurrencyPanel play-money
// panel. $VRX here is a FIXED-SUPPLY (200M), TREASURY-HELD, TRANSFERABLE in-system credit: you CLAIM it from
// the VRX treasury (75,000 twice, ≥2 days apart), SEND it to any account, and SPEND it to pay inside VRX.
//
// Honest framing (boundary): $VRX is NOT fiat, NOT redeemable, NOT (yet) an on-chain token — "1 $VRX ≈ $1"
// is a display convention only. This panel says so plainly; it does NOT carry the old "NOT REAL play money"
// badge (that was the demo concept). Reads/writes /api/vrx-token.

import { useCallback, useEffect, useRef, useState } from "react";
import { card, input } from "@/lib/ui";
import { T } from "@/lib/theme";
import { useWallet } from "@/lib/wallet";

type ClaimState = {
  claimsUsed: number;
  claimsLeft: number;
  canClaimNow: boolean;
  nextClaimAt: number | null;
  claimAmount: number;
};
type HistoryRow = {
  id: string;
  ts: number;
  kind: "claim" | "transfer" | "operatorSend" | "spend";
  direction: "in" | "out";
  signedAmount: number;
  counterparty: string;
  memo?: string;
};
type Resp = { account: string; balanceVrx: number; treasuryVrx: number; claim: ClaimState; history?: HistoryRow[] };

const fmtVrx = (v: number) => `${v.toLocaleString("en-US")} $VRX`;
const fmtNear = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} Ⓝ`;

function daysUntil(ts: number, now: number): string {
  const ms = ts - now;
  if (ms <= 0) return "now";
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return `in ~${days} day${days === 1 ? "" : "s"}`;
}

const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`, background: T.panel2, color: T.text, cursor: "pointer",
  fontSize: 12, padding: "3px 14px", minHeight: 26, height: 26, lineHeight: 1, borderRadius: 999,
};
const btnPrimary: React.CSSProperties = {
  background: T.accent, border: "none", color: "#fff", cursor: "pointer", fontSize: 13.5, padding: "7px 14px", borderRadius: 8,
};

export default function VrxWalletPanel({ me }: { me: string }) {
  const { realConnected } = useWallet();
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Live NEAR balance — ONLY for a genuinely connected real wallet (realConnected), never a demo-role session
  // (a demo "account" has no real on-chain balance; showing one would be misleading). null = unknown/loading,
  // "busy" = RPC hiccup → show "—" not a false 0. Reads the keyed, resilient /api/faucet/balance.
  const [nearBal, setNearBal] = useState<number | "busy" | null>(null);
  // Booking-token "coins" the account holds (D-: the wallet is the canonical home for the coin count).
  const [coins, setCoins] = useState<{ held: number; spendable: number } | null>(null);

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch(`/api/vrx-token?account=${encodeURIComponent(me)}&history=1&limit=50`);
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [me]);

  // Fetch the real NEAR balance when (and only when) a real wallet is connected.
  const loadNear = useCallback(async () => {
    if (!realConnected || !me) { setNearBal(null); return; }
    try {
      const r = await fetch(`/api/faucet/balance?account=${encodeURIComponent(me)}`);
      const j = await r.json();
      if (j.busy) setNearBal("busy");
      else setNearBal(typeof j.availableNear === "number" ? j.availableNear : 0);
    } catch {
      setNearBal("busy");
    }
  }, [realConnected, me]);
  useEffect(() => { void loadNear(); }, [loadNear]);

  // Booking-token holdings — role-agnostic coin count for this account (reads /api/booking-tokens/holdings).
  const loadCoins = useCallback(async () => {
    if (!me) { setCoins(null); return; }
    try {
      const r = await fetch(`/api/booking-tokens/holdings?account=${encodeURIComponent(me)}`);
      if (!r.ok) { setCoins(null); return; }
      const j = await r.json();
      setCoins({ held: Number(j.held) || 0, spendable: Number(j.spendable) || 0 });
    } catch {
      setCoins(null);
    }
  }, [me]);
  useEffect(() => { void loadCoins(); }, [loadCoins]);

  useEffect(() => { load(); }, [load]);

  // Tick for the "next claim" countdown; light background refresh so a received transfer shows up.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const poll = setInterval(() => void loadRef.current(), 30_000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, []);

  if (err) return <section style={card}><p style={{ color: T.danger, fontSize: 13 }}>{err}</p><button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Retry"}</button></section>;
  if (!resp) return <section style={card}><p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p></section>;

  const { claim } = resp;

  return (
    <section style={{ ...card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>$VRX wallet</h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 14px", maxWidth: 680 }}>
        $VRX is the credit you use inside the VRX system — claim it from the VRX treasury, send it to other
        accounts, and spend it to pay deposits and holds. The total supply is fixed at 200,000,000 $VRX.
        {" "}<strong>1 $VRX ≈ $1 is a display convention only</strong> — $VRX is not fiat, not redeemable for
        cash, and not (yet) an on-chain token.
      </p>

      {/* BALANCE HERO (: "format the wallet like other wallets so it feels known"). Mainstream
          wallets (MetaMask / Phantom / Trust) lead with ONE big balance, so the first thing a user reads is
          "how much do I have". The $VRX balance is that hero — full-width, large, centred — with its honest
          "play credit" label small above it. The secondary balances (real NEAR, booking-token coins) sit as
          compact tiles BELOW, clearly subordinate so the money number is never confused with them. */}
      <div
        style={{
          marginBottom: 14, padding: "18px 16px", borderRadius: 14, textAlign: "center",
          background: "linear-gradient(180deg, rgba(61,125,255,0.10), rgba(61,125,255,0.02))",
          border: `1px solid ${T.accentSoft}`,
        }}
      >
        <div style={{ fontSize: T.fsMeta, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.6 }}>
          $VRX balance · play credit
        </div>
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.5, margin: "4px 0 2px", lineHeight: 1.1 }}>
          {resp.balanceVrx.toLocaleString("en-US")} <span style={{ fontSize: 18, fontWeight: 600, opacity: 0.6 }}>$VRX</span>
        </div>
        <div style={{ fontSize: T.fsMeta, opacity: 0.5 }}>Treasury remaining: {fmtVrx(resp.treasuryVrx)}</div>
      </div>

      {/* Secondary balances — only the ones that apply. A real connected wallet shows its live on-chain NEAR;
          an account holding reservation capacity shows its booking-token coins. They stack full-width on a
          phone (each flex-basis 100% below ~260px) and sit side-by-side on wider screens. */}
      {(realConnected || (coins && coins.held > 0)) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          {realConnected && (
            <div style={{ flex: "1 1 160px", padding: "8px 14px", borderRadius: 10, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
              <div style={{ fontSize: T.fsMeta, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55 }}>NEAR · real on-chain</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>
                {nearBal === null ? "…" : nearBal === "busy" ? "—" : fmtNear(nearBal)}
              </div>
              <div style={{ fontSize: T.fsMeta, opacity: 0.55 }}>Live, from your connected wallet</div>
            </div>
          )}
          {/* Booking-token "coins" — reservation capacity this account holds (D-). Shown only when ≥1
              (buyers never hold any). Gold coin = capacity. */}
          {coins && coins.held > 0 && (
            <div style={{ flex: "1 1 160px", padding: "8px 14px", borderRadius: 10, background: T.bg2, border: `1px solid #d4af3755` }}
                 title={`${coins.spendable} ready to use · ${coins.held} total in your custody`}>
              <div style={{ fontSize: T.fsMeta, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55 }}>Booking tokens · capacity</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2, color: "#e8c75a" }}>
                <span aria-hidden>🪙</span> {coins.held}
              </div>
              <div style={{ fontSize: T.fsMeta, opacity: 0.55 }}>{coins.spendable} ready to use</div>
            </div>
          )}
        </div>
      )}

      {/* Claim */}
      <div style={{ ...card, marginTop: 0, padding: "12px 14px", background: T.bg2 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Claim $VRX</div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, maxWidth: 560 }}>
          The VRX treasury grants you {fmtVrx(claim.claimAmount)} per claim — up to {claim.claimsUsed + claim.claimsLeft} claims,
          at least 2 days apart. Used {claim.claimsUsed} of {claim.claimsUsed + claim.claimsLeft}.
        </div>
        <ClaimButton me={me} claim={claim} now={now} onDone={load} />
      </div>

      {/* Send */}
      <SendVrx me={me} balance={resp.balanceVrx} onDone={load} />

      {/* History (wallet #4) — deposits / holds / spending + claims + transfers, newest first. */}
      <HistoryList rows={resp.history ?? []} />
    </section>
  );
}

// ── History (wallet #4) ───────────────────────────────────────────────────────────────────────────────────
// A plain, honest ledger of every $VRX move for this account: claims in, transfers in/out, operator grants in,
// and spends (deposits/holds) out. Signed from the account's own view (+credit / −debit). No chain — this is the
// off-chain ledger (lib/vrx-token), same boundary as the balance above.

const KIND_LABEL: Record<HistoryRow["kind"], string> = {
  claim: "Claimed from treasury",
  transfer: "Transfer",
  operatorSend: "Grant from VRX",
  spend: "Spent inside VRX",
};

function fmtWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function HistoryList({ rows }: { rows: HistoryRow[] }) {
  return (
    <div style={{ ...card, marginTop: 12, padding: "12px 14px", background: T.bg2 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>History</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, maxWidth: 560 }}>
        Every $VRX move on this account — claims, transfers, grants, and what you&apos;ve spent on deposits and holds.
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12.5, opacity: 0.5, marginTop: 12 }}>No $VRX activity yet.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
          {rows.map((r) => {
            const credit = r.direction === "in";
            return (
              <li
                key={r.id}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
                  padding: "8px 0", borderTop: `1px solid ${T.borderSoft}`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {KIND_LABEL[r.kind]}
                    {r.memo && <span style={{ opacity: 0.6, fontWeight: 400 }}> — {r.memo}</span>}
                  </div>
                  <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {credit ? "from" : "to"} {r.counterparty} · {fmtWhen(r.ts)}
                  </div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", color: credit ? T.vetted : T.text }}>
                  {credit ? "+" : "−"}{Math.abs(r.signedAmount).toLocaleString("en-US")}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ClaimButton({ me, claim, now, onDone }: { me: string; claim: ClaimState; now: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const doClaim = async () => {
    setBusy(true); setMsg(null); setOk(false);
    try {
      const res = await fetch("/api/vrx-token", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "claim", account: me }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not claim $VRX."); return; }
      setOk(true); setMsg(`Claimed — ${(j.balanceVrx as number).toLocaleString("en-US")} $VRX total.`); onDone();
    } catch { setMsg("Could not claim $VRX."); } finally { setBusy(false); }
  };

  if (claim.claimsLeft === 0) {
    return <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 10 }}>You have used all your claims.</div>;
  }
  if (!claim.canClaimNow && claim.nextClaimAt) {
    return <div style={{ fontSize: 12.5, color: T.hold, marginTop: 10 }}>Your next claim is available {daysUntil(claim.nextClaimAt, now)}.</div>;
  }
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
      <button type="button" onClick={doClaim} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }}>
        {busy ? "Claiming…" : `Claim ${claim.claimAmount.toLocaleString("en-US")} $VRX`}
      </button>
      {/* set the quota expectation up-front so a claim doesn't feel like it "ran out" afterwards. */}
      {claim.claimsLeft > 0 && !msg && (
        <span style={{ fontSize: 11.5, opacity: 0.6 }}>
          {claim.claimsLeft} claim{claim.claimsLeft === 1 ? "" : "s"} left · next one unlocks ~2 days later
        </span>
      )}
      {msg && <span style={{ fontSize: 12.5, color: ok ? T.vetted : T.danger }}>{msg}</span>}
    </div>
  );
}

function SendVrx({ me, balance, onDone }: { me: string; balance: number; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const send = async () => {
    setBusy(true); setMsg(null); setOk(false);
    try {
      const res = await fetch("/api/vrx-token", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "transfer", from: me, to: to.trim(), amount: Number(amount) }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not send $VRX."); return; }
      setOk(true); setMsg(`Sent — your balance is now ${(j.fromBalance as number).toLocaleString("en-US")} $VRX.`); setTo(""); setAmount(""); onDone();
    } catch { setMsg("Could not send $VRX."); } finally { setBusy(false); }
  };

  const canSend = to.trim() && Number(amount) > 0 && Number(amount) <= balance && Number.isInteger(Number(amount));

  return (
    <div style={{ ...card, marginTop: 12, padding: "12px 14px", background: T.bg2 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Send $VRX</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, maxWidth: 560 }}>
        Send $VRX to any account. The amount is debited from your balance immediately.
      </div>
      {/* Send form: on a phone the recipient + amount + Send stack FULL-WIDTH (recipient flex-basis
          220px forces it to own its row below ~360px; the amount + button share the next row, each a
          comfortable tap target). On desktop the three sit inline. Nothing squeezes to an unreadable width. */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ fontSize: 12.5, flex: "1 1 220px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Recipient account</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="e.g. buyer-bob.testnet" style={{ ...input, marginBottom: 0, fontSize: 16 }} />
        </label>
        <label style={{ fontSize: 12.5, flex: "1 1 120px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Amount ($VRX)</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 5000" inputMode="numeric" style={{ ...input, marginBottom: 0, fontSize: 16 }} />
        </label>
        <button type="button" onClick={send} disabled={busy || !canSend} style={{ ...btnPrimary, flex: "0 0 auto", minWidth: 96, opacity: busy || !canSend ? 0.5 : 1 }}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {msg && <div style={{ fontSize: 12.5, color: ok ? T.vetted : T.danger, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}
