"use client";

// IncomeProjection — the DEVELOPER's PROJECTED-INCOME surface on the node dashboard. One
// 3-line chart PER BUILDING (Expected vs Received vs Behind, cumulative over a monthly axis), switched by
// building TABS, with an ALWAYS-ON per-deal TABLE under the chart (clicking a month highlights the rows whose
// dated expected lines fall in that month). Hand-rolled inline SVG — the portal has NO chart dependency
// (SitePlanMap/StackingPlan are hand-rolled too; three polylines don't justify a heavier production-build add).
//
// EVERY number here is server-computed (/api/payments?developer=&projection=1 → lib/income-projection) — this
// is a pure VIEW, it never re-buckets or re-derives money on the client (browse from OUR server; no RPC).
// The four honesty guards live SERVER-SIDE (terminal excluded+counted, served-default segregated to at-risk,
// undated never forced onto a month, Expected-by-dueAt vs Received-by-paidAt). This component just renders
// what the server already made honest, with copy that keeps the line it must never cross:
//   • "behind schedule" is a SCHEDULE gap — NEVER "in default" (default eligibility is the §Default advisory).
//   • GROSS buyer receipts — NOT developer take-home (no "profit"/"net" wording; the fee/commission is ONE
//     number on the settlement console, never netted in here). Footer states it's an indicative projection.
// VOCAB: plain words only — no contract-speak, no hashes, no D-refs.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMoney } from "@/lib/currency";
import { T } from "@/lib/theme";

type DealStatus = "live" | "at_risk" | "closed";
type DealRow = {
  requestId: string;
  unitLabel: string;
  expectedTotalUsd: number;
  receivedTotalUsd: number;
  status: DealStatus;
  monthsWithExpected: string[];
};
type MonthPoint = { month: string; expectedCum: number; receivedCum: number; behindCum: number };
type BuildingProjection = {
  buildingId: string;
  buildingName: string;
  months: MonthPoint[];
  deals: DealRow[];
  undatedExpectedUsd: number;
  atRiskCount: number;
  closedCount: number;
};
type ProjectionResponse = { buildings: BuildingProjection[] };

// The three series — colours reuse the theme's semantic palette: Expected = the plan (institutional blue),
// Received = money in (the verification green), Behind = the schedule gap (danger red, but labelled "behind
// schedule", never "default"). A legend spells each out so the two time axes read honestly.
const SERIES = [
  { key: "expectedCum" as const, label: "Expected (by due date)", color: T.accent },
  { key: "receivedCum" as const, label: "Received (by date paid)", color: T.vetted },
  { key: "behindCum" as const, label: "Behind schedule", color: T.danger },
];

const STATUS_META: Record<DealStatus, { label: string; color: string }> = {
  live: { label: "Live", color: T.vetted },
  at_risk: { label: "At risk", color: T.hold },
  closed: { label: "Closed", color: T.dim },
};

// `YYYY-MM` → "Feb 2026" for the axis + tooltip. Parsed as UTC midday so it never slips a month across zones.
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// ── The chart: a self-contained inline SVG over one building's monthly points ───────────────────────────
function Chart({
  months,
  money,
  selectedMonth,
  onSelectMonth,
}: {
  months: MonthPoint[];
  money: (usd: number) => string;
  selectedMonth: string | null;
  onSelectMonth: (m: string | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);

  // Geometry. A fixed viewBox; the parent SVG scales responsively via width:100%.
  const W = 720, H = 260;
  const padL = 64, padR = 16, padT = 16, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxY = Math.max(
    1,
    ...months.map((m) => Math.max(m.expectedCum, m.receivedCum, m.behindCum))
  );
  const n = months.length;
  // x for month index i. With one point, centre it; otherwise spread across the plot.
  const xAt = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (plotW * i) / (n - 1));
  const yAt = (v: number) => padT + plotH - (plotH * v) / maxY;

  if (n === 0) {
    return (
      <div style={{ color: T.dim, fontSize: 13, padding: "24px 4px" }}>
        No dated payments scheduled yet for this building — nothing to plot on a timeline. Any up-front or
        on-handover amounts are shown in the caption below.
      </div>
    );
  }

  // A few horizontal gridlines + y labels.
  const ticks = 4;
  const gridYs = Array.from({ length: ticks + 1 }, (_, i) => (maxY * i) / ticks);

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {/* y gridlines + labels */}
        {gridYs.map((v, i) => {
          const y = yAt(v);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={T.borderSoft} strokeWidth={1} />
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize={10} fill={T.faint}>
                {money(Math.round(v))}
              </text>
            </g>
          );
        })}

        {/* the selected month's vertical guide */}
        {selectedMonth &&
          months.map((m, i) =>
            m.month === selectedMonth ? (
              <line key="sel" x1={xAt(i)} y1={padT} x2={xAt(i)} y2={padT + plotH} stroke={T.accentSoft} strokeWidth={2} />
            ) : null
          )}

        {/* the three cumulative series */}
        {SERIES.map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={months.map((m, i) => `${xAt(i)},${yAt(m[s.key])}`).join(" ")}
          />
        ))}

        {/* point dots on the selected/hovered month */}
        {months.map((m, i) => {
          const active = m.month === selectedMonth || hover === i;
          if (!active) return null;
          return SERIES.map((s) => (
            <circle key={s.key + i} cx={xAt(i)} cy={yAt(m[s.key])} r={3.5} fill={s.color} />
          ));
        })}

        {/* x labels — thin out when crowded so they don't collide. The FIRST + LAST ticks sit on the plot
 edges, so a centred label overflows the viewBox and gets clipped (F4: "Aug 2028 Sep 202…").
            Anchor the edges inward — last=end (grows left), first=start (grows right) — so they stay inside. */}
        {months.map((m, i) => {
          const step = Math.ceil(n / 8);
          if (i % step !== 0 && i !== n - 1) return null;
          const anchor = i === n - 1 ? "end" : i === 0 ? "start" : "middle";
          return (
            <text key={m.month} x={xAt(i)} y={H - 12} textAnchor={anchor} fontSize={10} fill={T.faint}>
              {monthLabel(m.month)}
            </text>
          );
        })}

        {/* invisible hit columns: hover = tooltip, click = highlight the month's rows */}
        {months.map((m, i) => {
          const x = xAt(i);
          const half = n <= 1 ? plotW / 2 : plotW / (n - 1) / 2;
          return (
            <rect
              key={"hit" + i}
              x={x - half}
              y={padT}
              width={half * 2}
              height={plotH}
              fill="transparent"
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onClick={() => onSelectMonth(selectedMonth === m.month ? null : m.month)}
            />
          );
        })}
      </svg>

      {/* LIGHT hover tooltip — just the three month totals, nothing heavy (fixing the operator catalog's long mouseover). */}
      {hover !== null && months[hover] && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 12,
            pointerEvents: "none",
            minWidth: 150,
          }}
        >
          <div style={{ color: T.text, fontWeight: 600, marginBottom: 4 }}>{monthLabel(months[hover].month)}</div>
          {SERIES.map((s) => (
            <div key={s.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, color: T.dim }}>
              <span style={{ color: s.color }}>●</span>
              <span style={{ marginLeft: -8, marginRight: "auto" }}>{s.label.split(" (")[0]}</span>
              <span style={{ color: T.text }}>{money(months[hover][s.key])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function IncomeProjection({ developer }: { developer: string }) {
  const money = useMoney();
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeBuilding, setActiveBuilding] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  useEffect(() => {
    if (!developer) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch(`/api/payments?developer=${encodeURIComponent(developer)}&projection=1`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("could not load the income projection"))))
      .then((j: ProjectionResponse) => {
        if (!alive) return;
        setData(j);
        setActiveBuilding((prev) => prev ?? j.buildings[0]?.buildingId ?? null);
      })
      .catch((e) => alive && setErr(e.message || "load failed"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [developer]);

  const building = useMemo(
    () => data?.buildings.find((b) => b.buildingId === activeBuilding) ?? data?.buildings[0] ?? null,
    [data, activeBuilding]
  );

  // Clear the month highlight when switching buildings (a month on one building needn't exist on another).
  useEffect(() => {
    setSelectedMonth(null);
  }, [activeBuilding]);

  if (loading && !data) return <div style={{ color: T.dim, fontSize: 13 }}>Loading projected income…</div>;
  if (err) return <div style={{ color: T.danger, fontSize: 13 }}>{err}</div>;
  if (!data || data.buildings.length === 0) {
    return (
      <div style={{ color: T.dim, fontSize: 13 }}>
        No projected income yet — it appears once a deal with a signed payment plan is in motion.
      </div>
    );
  }

  const b = building!;
  const captionBits: string[] = [];
  if (b.undatedExpectedUsd > 0) captionBits.push(`On-handover / undated: ${money(b.undatedExpectedUsd)}`);
  if (b.atRiskCount > 0) captionBits.push(`${b.atRiskCount} at risk`);
  if (b.closedCount > 0) captionBits.push(`${b.closedCount} closed`);

  return (
    <div>
      {/* building tabs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {data.buildings.map((bp) => {
          const on = bp.buildingId === b.buildingId;
          return (
            <button
              key={bp.buildingId}
              onClick={() => setActiveBuilding(bp.buildingId)}
              style={{
                ...tab,
                background: on ? T.accentSoft : T.bg2,
                borderColor: on ? T.accent : T.border,
                color: on ? T.text : T.dim,
              }}
            >
              {bp.buildingName}
            </button>
          );
        })}
      </div>

      {/* legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 8, fontSize: 12, color: T.dim }}>
        {SERIES.map((s) => (
          <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: s.color, fontSize: 14 }}>●</span>
            {s.label}
          </span>
        ))}
      </div>

      <Chart months={b.months} money={money} selectedMonth={selectedMonth} onSelectMonth={setSelectedMonth} />

      {/* honesty caption — off-curve figures, kept plain + segregated */}
      {captionBits.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: T.dim }}>{captionBits.join(" · ")}</div>
      )}

      {/* always-on per-deal table (fixing the operator catalog's ephemeral mouseover) — clicked month highlights its rows */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 13 }}>
        <thead>
          <tr style={{ color: T.faint, textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>
            <th style={th}>Unit</th>
            <th style={{ ...th, textAlign: "right" }}>Expected</th>
            <th style={{ ...th, textAlign: "right" }}>Received</th>
            <th style={{ ...th, textAlign: "right" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {b.deals.map((d) => {
            const hit = selectedMonth !== null && d.monthsWithExpected.includes(selectedMonth);
            const sm = STATUS_META[d.status];
            return (
              <tr
                key={d.requestId}
                style={{
                  background: hit ? T.accentSoft : "transparent",
                  borderTop: `1px solid ${T.borderSoft}`,
                }}
              >
                <td style={td}>{d.unitLabel}</td>
                <td style={{ ...td, textAlign: "right" }}>{money(d.expectedTotalUsd)}</td>
                <td style={{ ...td, textAlign: "right" }}>{money(d.receivedTotalUsd)}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <span style={{ color: sm.color, fontWeight: 600 }}>{sm.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {selectedMonth && (
        <div style={{ marginTop: 6, fontSize: 12, color: T.dim }}>
          Highlighting units with a payment due in {monthLabel(selectedMonth)}.{" "}
          <button onClick={() => setSelectedMonth(null)} style={linkBtn}>
            clear
          </button>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 11, color: T.faint, lineHeight: 1.5 }}>
        Indicative projection, per each signed agreement. Expected is scheduled by due date; Received is the
        money actually logged, by the date it was paid. “Behind schedule” means the plan is ahead of what’s in —
        it is not a default. Figures are the buyers’ gross payments, before any commission or fee.
      </div>
    </div>
  );
}

const tab: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 999,
  border: `1px solid ${T.border}`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const th: CSSProperties = { padding: "6px 8px", fontWeight: 600 };
const td: CSSProperties = { padding: "8px 8px", color: T.text };
const linkBtn: CSSProperties = {
  background: "none",
  border: "none",
  color: T.accent,
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
  textDecoration: "underline",
};
