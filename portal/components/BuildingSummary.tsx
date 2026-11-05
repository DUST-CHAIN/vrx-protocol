"use client";

// BuildingSummary — the totals + per-type size/price table for a building, echoing the the operator catalog
// reference (Total / Sold / Available + a TYPE · FROM–TO · PRICE table). Plus a per-floor availability
// list. Pure presentation over lib/building-stats; shared by the developer and agency/agent views.

import { buildingStats } from "@/lib/building-stats";
import type { Building } from "@/lib/catalog-client";

export function BuildingSummaryBlock({
  building,
  status,
  money,
}: {
  building: Building;
  status: Record<string, number>;
  money: (usd: number) => string;
}) {
  const s = buildingStats(building, status);
  const known = s.total - s.unknown;

  return (
    <div style={{ margin: "4px 0 16px" }}>
      {/* Totals band */}
      <div
        style={{
          display: "flex",
          gap: 0,
          flexWrap: "wrap",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid #232838",
        }}
      >
        <Stat label="Total units" value={String(s.total)} />
        <Stat label="Available" value={String(s.available)} color="#7ce0a0" />
        <Stat label="On hold" value={String(s.onHold)} color="#e0c67c" />
        <Stat label="Sold" value={String(s.sold)} color="#7aa2ff" />
        {s.offMarket > 0 && <Stat label="Off-market" value={String(s.offMarket)} color="#c678c6" />}
        {s.notListed > 0 && <Stat label="Not listed" value={String(s.notListed)} color="#8b93a8" />}
        {s.unknown > 0 && <Stat label="Not yet loaded" value={String(s.unknown)} color="#8b93a8" />}
      </div>

      {/* Type · size · price table */}
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 340 }}>
          <thead>
            <tr style={{ opacity: 0.6, textAlign: "left" }}>
              <th style={th}>Type</th>
              <th style={th}>Units</th>
              <th style={th}>Size (m²)</th>
              <th style={th}>Price range</th>
            </tr>
          </thead>
          <tbody>
            {s.types.map((t) => (
              <tr key={t.key} style={{ borderTop: "1px solid #1c2130" }}>
                <td style={td}>{t.label}</td>
                <td style={td}>{t.count}</td>
                <td style={td}>{t.sqmMin === t.sqmMax ? t.sqmMin : `${t.sqmMin}–${t.sqmMax}`}</td>
                <td style={td}>
                  {money(t.priceMinUsd)} <span style={{ opacity: 0.4 }}>–</span> {money(t.priceMaxUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {known < s.total && (
        <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>
          Availability counts reflect the {known} of {s.total} units loaded so far.
        </div>
      )}
    </div>
  );
}

/** Per-floor availability list (e.g. "Floor 7 — available: 4×1BR, 1×2BR"). Echoes the the operator catalog reference. */
export function FloorAvailabilityList({
  building,
  status,
}: {
  building: Building;
  status: Record<string, number>;
}) {
  const s = buildingStats(building, status);
  // c: this long per-floor list is noise most of the time — FOLD it (collapsed by default).
  // It's pure presentation (no chain reads; consumes the status prop the parent already has), so folding it
  // costs nothing and the rows only render when the user expands. <details> = native, zero-JS, accessible.
  const floorCount = s.floors.length;
  return (
    <details style={{ marginTop: 16 }}>
      <summary style={{ fontSize: 14, opacity: 0.85, cursor: "pointer", listStyle: "revert", userSelect: "none" }}>
        Availability by floor
        <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 6 }}>({floorCount} floor{floorCount === 1 ? "" : "s"})</span>
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
        {s.floors.map((f) => (
          <div
            key={f.floor}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              padding: "6px 10px",
              borderRadius: 6,
              background: f.available > 0 ? "#101a13" : "#0e1119",
              border: `1px solid ${f.available > 0 ? "#1f3a29" : "#1c2130"}`,
              fontSize: 13,
            }}
          >
            <span style={{ opacity: 0.75 }}>Floor {f.floor}</span>
            <span style={{ opacity: 0.9, textAlign: "right" }}>
              {f.available > 0 ? (
                <span style={{ color: "#7ce0a0" }}>
                  {f.byType.map((t) => `${t.count}×${t.label}`).join(", ")}
                </span>
              ) : (
                <span style={{ opacity: 0.6 }}>none available</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 90, padding: "8px 12px", background: "#0e1119" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: color ?? "#e8ecf4" }}>{value}</div>
      <div style={{ fontSize: 11, opacity: 0.55 }}>{label}</div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "4px 8px", fontWeight: 500 };
const td: React.CSSProperties = { padding: "6px 8px" };
