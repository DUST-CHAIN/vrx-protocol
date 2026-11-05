"use client";

// DemoCurrencyPanel (slice 4) — the $VRX play-money surface. $VRX is EXPLICITLY FAKE, demo-only money:
// an agent can learn the system + place DEMO bookings with it, but a $VRX booking is a TIME-BOXED demo HOLD
// that AUTO-REVERTS (self-cleaning) — it never settles a real deal. To make a booking stick, the developer
// upgrades it (pays the real fee) on the real path. This surface therefore screams NOT-REAL throughout and
// shows a live revert countdown on every hold.
//
// Rendered ONLY under the demo flag (DEMO_MODE_FLAG) — the whole $VRX concept cannot exist in a real deploy.
// Reads/writes /api/demo-currency. plain words.

import { useCallback, useEffect, useRef, useState } from "react";
import { card, input } from "@/lib/ui";
import { T } from "@/lib/theme";
import { DEMO_MODE_FLAG } from "@/lib/dev-signer-fence";

type Hold = {
  id: string;
  buildingId: string;
  unitId: string;
  amountVrx: number;
  placedAt: number;
  expiresAt: number;
  active: boolean;
  expired: boolean;
  upgradedToRequestId: string | null;
};
type Resp = { enabled: boolean; balanceVrx: number; holds: Hold[] };

const fmtVrx = (v: number) => `${v.toLocaleString("en-US")} $VRX`;

// Human "mm:ss left" from an expiry; "reverted" once past. The self-cleaning countdown.
function timeLeft(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "reverted";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")} left`;
}

const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`, background: T.panel2, color: T.text, cursor: "pointer",
  fontSize: 12, padding: "3px 14px", minHeight: 26, height: 26, lineHeight: 1, borderRadius: 999,
};
const btnPrimary: React.CSSProperties = {
  background: T.accent, border: "none", color: "#fff", cursor: "pointer", fontSize: 13.5, padding: "7px 14px", borderRadius: 8,
};

// The always-visible NOT-REAL banner — $VRX must never read as real money.
const NOT_REAL_BADGE: React.CSSProperties = {
  display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase",
  color: T.hold, background: "rgba(232,184,75,0.12)", border: `1px solid ${T.hold}`, borderRadius: 6, padding: "2px 8px",
};

export default function DemoCurrencyPanel({ me }: { me: string }) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch(`/api/demo-currency?account=${encodeURIComponent(me)}`);
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => { load(); }, [load]);

  // Tick the countdown once a second; refresh from the server every 20s so an expired hold drops off.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void loadRef.current(), 20_000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, []);

  // The whole concept is demo-only — never render it in a real deploy.
  if (!DEMO_MODE_FLAG) return null;

  if (err) return <section style={card}><p style={{ color: T.danger, fontSize: 13 }}>{err}</p><button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Retry"}</button></section>;
  if (!resp) return <section style={card}><p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p></section>;
  if (!resp.enabled) return null;

  const active = resp.holds.filter((h) => h.active);
  const past = resp.holds.filter((h) => !h.active);

  return (
    <section style={{ ...card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>$VRX practice money <span style={NOT_REAL_BADGE}>not real</span></h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 14px", maxWidth: 680 }}>
        Play money for learning the system — it is <strong>not real</strong>, never redeemable, and never settles
        a real deal. A booking paid in $VRX is a short practice hold that <strong>reverts on its own</strong>; to
        make a booking stick, the developer upgrades it on the real path (paying the real fee).
      </p>

      <div style={{ display: "inline-block", padding: "8px 14px", borderRadius: 10, background: T.bg2, border: `1px solid ${T.borderSoft}`, marginBottom: 16 }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55 }}>Your practice balance</div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{fmtVrx(resp.balanceVrx)}</div>
        <div style={{ fontSize: 11, opacity: 0.55 }}>1 $VRX shows as $1 — a display convention, not real value.</div>
      </div>

      <PlaceDemoHold me={me} onDone={load} />

      {active.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SectionTitle>Active practice holds · {active.length}</SectionTitle>
          <div style={{ display: "grid", gap: 8 }}>
            {active.map((h) => (
              <div key={h.id} style={{ ...card, marginTop: 0, padding: "10px 14px", borderColor: T.hold, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13.5 }}>
                  <span style={NOT_REAL_BADGE}>demo</span>{" "}
                  Unit {h.unitId} · {fmtVrx(h.amountVrx)}
                </span>
                <span style={{ fontSize: 13, color: T.hold, fontWeight: 600 }}>{timeLeft(h.expiresAt, now)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {past.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <SectionTitle>Reverted &amp; upgraded · {past.length}</SectionTitle>
          <div style={{ display: "grid", gap: 6 }}>
            {past.map((h) => (
              <div key={h.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", fontSize: 13, padding: "4px 10px", borderRadius: 6, background: T.bg2, opacity: 0.8 }}>
                <span>Unit {h.unitId} · {fmtVrx(h.amountVrx)}</span>
                <span style={{ fontSize: 12.5, color: h.upgradedToRequestId ? T.vetted : T.dim }}>
                  {h.upgradedToRequestId ? "upgraded to a real booking" : "reverted (practice hold expired)"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55, margin: "4px 0 8px" }}>{children}</div>;
}

function PlaceDemoHold({ me, onDone }: { me: string; onDone: () => void }) {
  const [buildingId, setBuildingId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const place = async () => {
    setBusy(true); setMsg(null); setOk(false);
    try {
      const res = await fetch("/api/demo-currency", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "place", account: me, buildingId: buildingId.trim(), unitId: unitId.trim(), amountVrx: Number(amount) }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not place the practice hold."); return; }
      setOk(true); setMsg("Practice hold placed — it will revert on its own."); setUnitId(""); setAmount(""); onDone();
    } catch { setMsg("Could not place the practice hold."); } finally { setBusy(false); }
  };

  const canPlace = buildingId.trim() && unitId.trim() && Number(amount) > 0;

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", background: T.bg2 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Book with $VRX (practice)</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, maxWidth: 560 }}>
        Place a practice hold on a unit to try the flow. It reverts automatically — it is not a real booking.
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ fontSize: 12.5, flex: "1 1 130px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Building</span>
          <input value={buildingId} onChange={(e) => setBuildingId(e.target.value)} placeholder="building id" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <label style={{ fontSize: 12.5, flex: "1 1 100px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Unit</span>
          <input value={unitId} onChange={(e) => setUnitId(e.target.value)} placeholder="unit id" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <label style={{ fontSize: 12.5, flex: "1 1 110px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>$VRX</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 5000" inputMode="numeric" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <button type="button" onClick={place} disabled={busy || !canPlace} style={{ ...btnPrimary, opacity: busy || !canPlace ? 0.5 : 1 }}>
          {busy ? "Placing…" : "Place practice hold"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: ok ? T.vetted : T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}
