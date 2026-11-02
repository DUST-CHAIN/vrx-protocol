"use client";

// a remaining estimate if the operator entered the dashboard balance; (2) a LINK to the real dashboard, the
// source of truth. Deliberately labelled "estimate" so it's never mistaken for the live number.

import { useCallback, useEffect, useState } from "react";

type Usage = {
  calls: number;
  since: number;
  baselineCredits?: number;
  usedSinceBaseline: number | null;
  remainingEstimate: number | null;
  dashboardUrl: string;
};

export default function CreditsCard() {
  const [u, setU] = useState<Usage | null>(null);
  const [entering, setEntering] = useState(false);
  const [val, setVal] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/usage");
      if (r.ok) setU((await r.json()) as Usage);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveBaseline() {
    const n = Number(val.replace(/[, ]/g, ""));
    if (!isFinite(n) || n < 0) return;
    try {
      const r = await fetch("/api/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baselineCredits: n }),
      });
      if (r.ok) {
        setU((await r.json()) as Usage);
        setEntering(false);
        setVal("");
      }
    } catch {
      /* ignore */
    }
  }

  const fmt = (n: number) => n.toLocaleString();

  return (
    <div style={{ borderTop: "1px solid #1c2130", paddingTop: 12 }}>
      <div style={sectionLabel}>FastNEAR credits (RPC)</div>

      {u ? (
        <>
          {u.remainingEstimate != null ? (
            <div style={{ fontSize: 13 }}>
              <span style={{ fontFamily: "ui-monospace, monospace", color: "#8fc4ff", fontWeight: 600 }}>
                ~{fmt(u.remainingEstimate)}
              </span>{" "}
              <span style={{ opacity: 0.6 }}>left (est.)</span>
            </div>
          ) : (
            <div style={{ fontSize: 12.5, opacity: 0.7 }}>Enter your dashboard balance for a remaining estimate.</div>
          )}
          <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 3 }}>
            {fmt(u.calls)} RPC calls counted{u.usedSinceBaseline != null ? ` · ${fmt(u.usedSinceBaseline)} since baseline` : ""}
          </div>

          {entering ? (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 485847"
                value={val}
                onChange={(e) => setVal(e.target.value)}
                style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.06)", color: "inherit", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "4px 7px", fontSize: 13 }}
              />
              <button onClick={saveBaseline} style={miniBtn}>Save</button>
              <button onClick={() => setEntering(false)} style={miniBtn}>×</button>
            </div>
          ) : (
            <button onClick={() => setEntering(true)} style={{ ...miniBtn, marginTop: 8 }}>
              {u.baselineCredits != null ? "Update balance" : "Enter dashboard balance"}
            </button>
          )}

          <a
            href={u.dashboardUrl}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-block", marginTop: 8, fontSize: 12.5, color: "#a9c0ff", textDecoration: "none" }}
          >
            Open FastNEAR dashboard ↗
          </a>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
            Estimate only — the dashboard has the exact live balance.
          </div>

          {/* The reserve-key registry + auto-escalation log. We run keyless by default; a rate limit
              auto-falls-back to a reserve key for a cooldown window and records it here. */}
          <KeyRegistry />
        </>
      ) : (
        <div style={{ fontSize: 12.5, opacity: 0.5 }}>Loading…</div>
      )}
    </div>
  );
}

// ── Reserve-key registry + escalation log ─────────────────────────────────────────────────────────
type RegKey = { keyMasked: string; email: string; label?: string; status: "active" | "spent" | "removed"; addedAt: number };
type EscLog = { at: number; keyMasked: string; email: string; reason: string };
type Reg = { keys: RegKey[]; log: EscLog[]; dashboardUrl: string; escalation: { active: boolean; remainingMs: number } };

function KeyRegistry() {
  const [reg, setReg] = useState<Reg | null>(null);
  const [adding, setAdding] = useState(false);
  const [nk, setNk] = useState("");
  const [ne, setNe] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/fastnear-keys");
      if (r.ok) setReg((await r.json()) as Reg);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function post(body: unknown) {
    try {
      const r = await fetch("/api/fastnear-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) setReg((await r.json()) as Reg);
    } catch { /* ignore */ }
  }

  if (!reg) return null;
  const visible = reg.keys.filter((k) => k.status !== "removed");
  const dim = (s: string): React.CSSProperties => ({ color: s === "spent" ? "#c98" : "#9fe0b8" });
  const when = (ms: number) => new Date(ms).toLocaleString();

  return (
    <div style={{ borderTop: "1px solid #1c2130", marginTop: 12, paddingTop: 10 }}>
      <div style={{ ...sectionLabel, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Reserve keys</span>
        {reg.escalation.active && (
          <span title="A rate limit tripped keyless mode — a reserve key is serving for the cooldown window." style={{ color: "#e8b84b", fontSize: 10 }}>
            ● using reserve ({Math.ceil(reg.escalation.remainingMs / 60000)}m left)
          </span>
        )}
      </div>

      {visible.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>No reserve keys — keyless only.</div>}
      {visible.map((k) => (
        <div key={k.keyMasked} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
          <span style={{ fontFamily: "ui-monospace, monospace", opacity: 0.7 }}>{k.keyMasked}</span>
          <span style={{ opacity: 0.85 }}>{k.email}</span>
          <span style={{ fontSize: 10.5, ...dim(k.status) }}>{k.status}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {k.status === "active" && <button title="Mark as out of credits" onClick={() => post({ setStatus: { keyMasked: k.keyMasked, status: "spent" } })} style={tinyBtn}>spent</button>}
            {k.status === "spent" && <button title="Mark usable again" onClick={() => post({ setStatus: { keyMasked: k.keyMasked, status: "active" } })} style={tinyBtn}>re-activate</button>}
            <button title="Remove from rotation" onClick={() => post({ setStatus: { keyMasked: k.keyMasked, status: "removed" } })} style={tinyBtn}>×</button>
          </span>
        </div>
      ))}

      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 7 }}>
          <input placeholder="API key" value={nk} onChange={(e) => setNk(e.target.value)} style={regInput} />
          <input placeholder="account email (e.g. you@example.com)" value={ne} onChange={(e) => setNe(e.target.value)} style={regInput} />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={async () => { if (nk.trim()) { await post({ add: { key: nk.trim(), email: ne.trim() } }); setNk(""); setNe(""); setAdding(false); } }} style={miniBtn}>Add key</button>
            <button onClick={() => setAdding(false)} style={miniBtn}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...miniBtn, marginTop: 7 }}>Add reserve key</button>
      )}

      {reg.log.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...sectionLabel, marginBottom: 4 }}>Reserve-use log</div>
          <div style={{ maxHeight: 120, overflowY: "auto" }}>
            {reg.log.map((l, i) => (
              <div key={i} style={{ fontSize: 11, opacity: 0.7, padding: "2px 0", lineHeight: 1.35 }}>
                <span style={{ opacity: 0.6 }}>{when(l.at)}</span>{" · "}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{l.keyMasked}</span>{" "}
                <span>{l.email}</span>
                <a href={reg.dashboardUrl} target="_blank" rel="noreferrer" style={{ color: "#a9c0ff", textDecoration: "none", marginLeft: 6 }}>check ↗</a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const regInput: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)", color: "inherit", border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6, padding: "4px 7px", fontSize: 12.5,
};

const tinyBtn: React.CSSProperties = {
  padding: "1px 6px", background: "#152238", color: "#9fb4d8", border: "1px solid #2a3a5e",
  borderRadius: 5, fontSize: 10.5, cursor: "pointer",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  opacity: 0.6,
  marginBottom: 6,
};

const miniBtn: React.CSSProperties = {
  minHeight: 28,
  padding: "4px 10px",
  background: "#152238",
  color: "#a9c0ff",
  border: "1px solid #2a3a5e",
  borderRadius: 7,
  fontSize: 12.5,
  cursor: "pointer",
};
