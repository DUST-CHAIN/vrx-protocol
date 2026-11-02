"use client";

// DeveloperDemoHoldsPanel (slice 4 — the developer's upgrade handoff). $VRX is EXPLICITLY FAKE
// play money: an agent places a time-boxed DEMO hold that auto-reverts. To make a booking STICK, the developer
// UPGRADES the demo hold to a real booking — the forcing function (they pay the real fee on the real /
// direct-deposit path). This surface shows the practice holds sitting on the DEVELOPER'S OWN inventory and lets
// them retire an active one by naming the REAL booking's reference it became.
// HONEST BY CONSTRUCTION: the upgrade is a HANDOFF MARKER, not a booking-maker — $VRX never mints real value.
// The developer must ALREADY have placed the real booking (via the booking-tokens / direct-deposit path); this
// just records "this practice hold became real booking <requestId>", after which the demo hold leaves the demo
// world and the real booking parks the unit honestly. The copy never pretends this surface places the booking.
// Rendered ONLY under the demo flag (DEMO_MODE_FLAG) — the whole $VRX concept cannot exist in a real deploy.
// Reads/writes /api/demo-currency (?developer / op:upgrade). plain words.

import { useCallback, useEffect, useState } from "react";
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
type Resp = { enabled: boolean; holds: Hold[] };

const fmtVrx = (v: number) => `${v.toLocaleString("en-US")} $VRX`;

const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`, background: T.panel2, color: T.text, cursor: "pointer",
  fontSize: 12, padding: "3px 14px", minHeight: 26, height: 26, lineHeight: 1, borderRadius: 999,
};
const btnPrimary: React.CSSProperties = {
  background: T.accent, border: "none", color: "#fff", cursor: "pointer", fontSize: 13.5, padding: "7px 14px", borderRadius: 8,
};
const NOT_REAL_BADGE: React.CSSProperties = {
  display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase",
  color: T.hold, background: "rgba(232,184,75,0.12)", border: `1px solid ${T.hold}`, borderRadius: 6, padding: "2px 8px",
};

export default function DeveloperDemoHoldsPanel({ me }: { me: string }) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch(`/api/demo-currency?developer=${encodeURIComponent(me)}`);
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => { load(); }, [load]);

  // The whole concept is demo-only — never render it in a real deploy.
  if (!DEMO_MODE_FLAG) return null;

  if (err) return <section style={card}><p style={{ color: T.danger, fontSize: 13 }}>{err}</p><button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Retry"}</button></section>;
  if (!resp) return <section style={card}><p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p></section>;
  if (!resp.enabled) return null;

  const active = resp.holds.filter((h) => h.active);
  const upgraded = resp.holds.filter((h) => h.upgradedToRequestId);

  return (
    <section style={{ ...card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>Practice holds <span style={NOT_REAL_BADGE}>not real</span></h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 14px", maxWidth: 680 }}>
        Practice ($VRX) holds an agent placed on your units. They are <strong>not real</strong> and revert on their
        own. If one is a genuine booking, place the real booking the normal way (a booking token or a direct
        booking), then <strong>upgrade</strong> the practice hold here by entering that real booking&rsquo;s
        reference — it retires the practice hold and the real booking takes over.
      </p>

      {active.length === 0 && <p style={{ opacity: 0.6, fontSize: 14 }}>No active practice holds on your units right now.</p>}

      {active.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          {active.map((h) => <UpgradeCard key={h.id} hold={h} me={me} onDone={load} />)}
        </div>
      )}

      {upgraded.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55, margin: "4px 0 8px" }}>Upgraded to real bookings · {upgraded.length}</div>
          <div style={{ display: "grid", gap: 6 }}>
            {upgraded.map((h) => (
              <div key={h.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", fontSize: 13, padding: "4px 10px", borderRadius: 6, background: T.bg2, opacity: 0.85 }}>
                <span>Unit {h.unitId} · {fmtVrx(h.amountVrx)}</span>
                <span style={{ fontSize: 12.5, color: T.vetted }}>→ {h.upgradedToRequestId}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function UpgradeCard({ hold, me, onDone }: { hold: Hold; me: string; onDone: () => void }) {
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const upgrade = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/demo-currency", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "upgrade", developer: me, holdId: hold.id, requestId: requestId.trim() }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not upgrade the practice hold."); return; }
      onDone();
    } catch { setMsg("Could not upgrade the practice hold."); } finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", background: T.bg2, borderColor: T.hold }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>
          <span style={NOT_REAL_BADGE}>demo</span> Unit {hold.unitId}
        </strong>
        <span style={{ fontSize: 12, opacity: 0.6 }}>{hold.buildingId} · {fmtVrx(hold.amountVrx)}</span>
      </div>
      <div style={{ fontSize: 12, opacity: 0.6, margin: "8px 0" }}>
        Already placed the real booking? Enter its reference to retire this practice hold.
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, flex: "1 1 220px" }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Real booking reference</span>
          <input value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="the real booking's id" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <button type="button" onClick={upgrade} disabled={busy || !requestId.trim()} style={{ ...btnPrimary, opacity: busy || !requestId.trim() ? 0.5 : 1 }}>
          {busy ? "Upgrading…" : "Upgrade to real booking"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}
