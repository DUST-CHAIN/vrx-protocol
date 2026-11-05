"use client";

// AgentPerformance (RELEASE_SPINE Phase 2) — the agency's per-agent production view. The agency app
// already had agent MANAGEMENT ("My agents": register/deactivate) + a deal INBOX (every deal its agents
// opened). What it lacked was the AGENT-axis rollup: who is actually producing. This panel is that view —
// pure read-side aggregation over the SAME /api/agency-claims rows the inbox reads, grouped by agent, plus
// the roster from /api/agents so an agent with zero deals still shows (a real signal, not an omission).
//
// NO new write path, NO contract touch, NO chain read from the browser (the server endpoints are keyed).
// It re-uses the inbox's own status model so the numbers can't drift from what the deal list shows:
//   • opened   = bookings this agent has opened
//   • live     = on-chain HELD (claim.s === 1) and not yet sold
//  • sold = the developer has closed it on-chain (offer.confirmed, — the SOLD signal)
//   • lapsed   = a timed-out open request (isRequestLapsed)
//  • earned = Σ commission.amountUsd on SOLD deals (realised B2B commission)
//   • pipeline = Σ commission.amountUsd on LIVE deals with a live rate (not yet realised)
//   • conv.    = sold / opened
//
// PRIVACY: an agent is shown by its neutral account id — never the sealed private profile (which the
// agency keeps its own editable copy of; it is never returned by any API). Commission is the agency's own
// B2B figure, never the buyer S&P.

import { useCallback, useEffect, useState } from "react";
import { useMoney } from "@/lib/currency";
import { isRequestLapsed, type ClaimWire } from "@/lib/vrx";
import { card, mono } from "@/lib/ui";
import { T } from "@/lib/theme";

// The subset of the agency inbox row this view needs (mirror of AgencyInboxRow — keep in sync).
type Row = {
  requestId: string;
  claim: ClaimWire | null;
  offer: { confirmed?: { at: number; by: string } | null } | null;
  agent: string | null;
  commission: { amountUsd: number } | null;
};

type AgentStat = {
  agent: string;
  opened: number;
  live: number;
  sold: number;
  lapsed: number;
  earnedUsd: number;
  pipelineUsd: number;
  joinedAt: number | null;
};

function isSold(r: Row): boolean {
  return !!r.offer?.confirmed;
}
function isLive(r: Row): boolean {
  return r.claim?.s === 1 && !isSold(r);
}

export default function AgentPerformance({ me }: { me: string }) {
  const money = useMoney();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [roster, setRoster] = useState<{ account: string; at: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [cr, ar] = await Promise.all([
        fetch(`/api/agency-claims?agency=${encodeURIComponent(me)}`),
        fetch(`/api/agents?agency=${encodeURIComponent(me)}`),
      ]);
      if (!cr.ok) throw new Error(cr.status === 503 ? "network busy" : `claims ${cr.status}`);
      const cj = (await cr.json()) as { rows?: Row[] };
      setRows(cj.rows ?? []);
      if (ar.ok) {
        const aj = (await ar.json()) as { agents?: { account: string; at: number }[] };
        setRoster(aj.agents ?? []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not load");
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    void load();
  }, [load]);

  // Aggregate rows by agent, then fold in roster agents with no deals (zero-row is a real signal).
  const stats: AgentStat[] = (() => {
    const byAgent = new Map<string, AgentStat>();
    const ensure = (agent: string): AgentStat => {
      let s = byAgent.get(agent);
      if (!s) {
        s = { agent, opened: 0, live: 0, sold: 0, lapsed: 0, earnedUsd: 0, pipelineUsd: 0, joinedAt: null };
        byAgent.set(agent, s);
      }
      return s;
    };
    for (const r of rows ?? []) {
      if (!r.agent) continue;
      const s = ensure(r.agent.toLowerCase());
      s.opened += 1;
      if (isSold(r)) {
        s.sold += 1;
        s.earnedUsd += r.commission?.amountUsd ?? 0;
      } else if (isLive(r)) {
        s.live += 1;
        s.pipelineUsd += r.commission?.amountUsd ?? 0;
      } else if (isRequestLapsed(r.claim)) {
        s.lapsed += 1;
      }
    }
    for (const a of roster) {
      const s = ensure(a.account.toLowerCase());
      s.joinedAt = a.at;
      if (!byAgent.get(a.account.toLowerCase())?.agent) s.agent = a.account;
    }
    // Keep the readable account casing from the roster where we have it.
    for (const a of roster) {
      const s = byAgent.get(a.account.toLowerCase());
      if (s) s.agent = a.account;
    }
    return [...byAgent.values()].sort(
      (a, b) => b.earnedUsd - a.earnedUsd || b.sold - a.sold || b.opened - a.opened || a.agent.localeCompare(b.agent)
    );
  })();

  const totals = stats.reduce(
    (t, s) => ({
      opened: t.opened + s.opened,
      sold: t.sold + s.sold,
      live: t.live + s.live,
      earnedUsd: t.earnedUsd + s.earnedUsd,
      pipelineUsd: t.pipelineUsd + s.pipelineUsd,
    }),
    { opened: 0, sold: 0, live: 0, earnedUsd: 0, pipelineUsd: 0 }
  );

  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Agent performance</h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{ background: T.panel2, color: T.dim, border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 11px", fontSize: 13, cursor: "pointer" }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
        How each of your agents is producing — bookings opened, how many closed, and the commission your
        agency has earned (and has in the pipeline). Read-only; the same deals your inbox shows, by agent.
      </p>

      {err && (
        <p style={{ color: "#e8b84b", fontSize: 13 }}>
          {err}. <button type="button" onClick={() => void load()} style={{ color: "#a9c0ff", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>Retry</button>
        </p>
      )}

      {rows !== null && !err && stats.length === 0 && (
        <p style={{ opacity: 0.6, fontSize: 14, marginTop: 12 }}>
          No agents yet. Register your salespeople under <b>My agents</b> — their bookings will show here.
        </p>
      )}

      {stats.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: T.dim, borderBottom: `1px solid ${T.border}` }}>
                <th style={thLeft}>Agent</th>
                <th style={th}>Opened</th>
                <th style={th}>Live</th>
                <th style={th}>Sold</th>
                <th style={th}>Lapsed</th>
                <th style={th}>Conv.</th>
                <th style={thRight}>Earned</th>
                <th style={thRight}>Pipeline</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => {
                const conv = s.opened > 0 ? Math.round((s.sold / s.opened) * 100) : 0;
                return (
                  <tr key={s.agent} style={{ borderBottom: `1px solid ${T.borderSoft}` }}>
                    <td style={tdLeft}>
                      <span style={{ ...mono, fontSize: 12.5 }}>{s.agent}</span>
                      {s.opened === 0 && <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.55 }}>no deals yet</span>}
                    </td>
                    <td style={td}>{s.opened}</td>
                    <td style={td}>{s.live || "—"}</td>
                    <td style={{ ...td, color: s.sold > 0 ? T.vetted : undefined }}>{s.sold || "—"}</td>
                    <td style={{ ...td, opacity: s.lapsed > 0 ? 1 : 0.5 }}>{s.lapsed || "—"}</td>
                    <td style={td}>{s.opened > 0 ? `${conv}%` : "—"}</td>
                    <td style={{ ...tdRight, color: s.earnedUsd > 0 ? T.vetted : undefined, fontWeight: s.earnedUsd > 0 ? 600 : 400 }}>
                      {s.earnedUsd > 0 ? money(s.earnedUsd) : "—"}
                    </td>
                    <td style={{ ...tdRight, opacity: s.pipelineUsd > 0 ? 0.85 : 0.5 }}>
                      {s.pipelineUsd > 0 ? money(s.pipelineUsd) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `1px solid ${T.border}`, fontWeight: 600 }}>
                <td style={tdLeft}>Total ({stats.length} {stats.length === 1 ? "agent" : "agents"})</td>
                <td style={td}>{totals.opened}</td>
                <td style={td}>{totals.live || "—"}</td>
                <td style={{ ...td, color: totals.sold > 0 ? T.vetted : undefined }}>{totals.sold || "—"}</td>
                <td style={td}>—</td>
                <td style={td}>{totals.opened > 0 ? `${Math.round((totals.sold / totals.opened) * 100)}%` : "—"}</td>
                <td style={{ ...tdRight, color: totals.earnedUsd > 0 ? T.vetted : undefined }}>{totals.earnedUsd > 0 ? money(totals.earnedUsd) : "—"}</td>
                <td style={{ ...tdRight, opacity: 0.85 }}>{totals.pipelineUsd > 0 ? money(totals.pipelineUsd) : "—"}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

const th: React.CSSProperties = { padding: "6px 10px", fontWeight: 500, textAlign: "center", whiteSpace: "nowrap" };
const thLeft: React.CSSProperties = { ...th, textAlign: "left" };
const thRight: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "7px 10px", textAlign: "center", whiteSpace: "nowrap" };
const tdLeft: React.CSSProperties = { ...td, textAlign: "left" };
const tdRight: React.CSSProperties = { ...td, textAlign: "right" };
