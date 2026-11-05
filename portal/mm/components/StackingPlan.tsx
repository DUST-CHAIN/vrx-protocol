"use client";

// StackingPlan — PORTED from portal/components/StackingPlan.tsx so MM's Preview face renders a
// building EXACTLY as the real VRX developer/agent view does. This is the acceptance test.
//
// ⚠ LOCKSTEP: this is a COPY of the real VRX component (MM is a separate Next app, can't import portal/).
// The PROPORTIONAL layout (unit WIDTH ∝ m² on one shared building-wide scale; floors narrower by total m²)
// + the status colour grammar + the legend MUST stay faithful to portal/components/StackingPlan.tsx. If
// that file changes its visual model, mirror it here (same discipline as the help/docs lockstep rule).
// Trimmed vs the original: the LIVE-chain-only props (per-floor freshness/refresh, multi-select, held-
// pending) are dropped — Preview is static (no chain). The VISUAL (what the user sees) is identical.
//
// STATUS COLORS mirror the VRX grid: grey = not listed · green = available · amber = on hold · blue =
// sold/reserved · (magenta = off-market, only if present).

import type { CSSProperties } from "react";
import type { PreviewUnit as Unit } from "@/lib/preview";

// On-chain status per unit, keyed by unit id. -1 = no tile yet; 0..3 = tile status.
export type UnitStatus = Record<string, number>;

const STATUS_META: Record<number, { bg: string; border: string; fg: string; label: string; icon: string }> = {
  [-1]: { bg: "#171b26", border: "#3a4256", fg: "#8b93a8", label: "not listed", icon: "○" },
  0: { bg: "#12291b", border: "#2f6a44", fg: "#7ce0a0", label: "available", icon: "●" },
  1: { bg: "#2a2412", border: "#7a6a2a", fg: "#e0c67c", label: "on hold", icon: "◐" },
  2: { bg: "#141d2e", border: "#2f4a7a", fg: "#7aa2ff", label: "sold / reserved", icon: "✓" },
  3: { bg: "#141d2e", border: "#2f4a7a", fg: "#7aa2ff", label: "done", icon: "✓" },
};

function meta(s: number) {
  return STATUS_META[s] ?? STATUS_META[-1];
}

export function StackingPlan({
  units,
  status,
  selectedId,
  onSelect,
  onOpen,
  formatPrice,
}: {
  units: Unit[];
  status: UnitStatus;
  selectedId?: string | null;
  onSelect?: (u: Unit) => void;
  onOpen?: (u: Unit) => void;
  formatPrice?: (usd: number) => string;
}) {
  if (units.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: 14 }}>No units in this building&apos;s catalog yet.</p>;
  }

  // Group into rows by floor (descending — top floor at the top, like a real stacking plan).
  const floors = Array.from(new Set(units.map((u) => u.floor))).sort((a, b) => b - a);
  const byFloor = new Map<number, Unit[]>();
  for (const f of floors) {
    byFloor.set(
      f,
      units.filter((u) => u.floor === f).sort((a, b) => a.id.localeCompare(b.id))
    );
  }

  // PROPORTIONAL layout: a unit's WIDTH represents its SIZE, on ONE shared m²-scale across the
  // whole building — so a 40m² unit is the same width on every floor, and a floor with less total m² is
  // genuinely NARROWER. The floor with the greatest total m² spans 100% of the row.
  const floorTotal = (f: number) => byFloor.get(f)!.reduce((sum, u) => sum + (u.sqm || 1), 0);
  const maxFloorTotal = Math.max(...floors.map(floorTotal)) || 1;

  const maxUnitsPerFloor = Math.max(...floors.map((f) => byFloor.get(f)!.length), 1);
  const planMinWidth = 26 + maxUnitsPerFloor * 34;

  return (
    <div>
      <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, width: `max(100%, ${planMinWidth}px)` }}>
          {floors.map((f) => {
            const fUnits = byFloor.get(f)!;
            const widthPct = (floorTotal(f) / maxFloorTotal) * 100;
            return (
              <div key={f} style={{ display: "flex", alignItems: "stretch", gap: 4, width: "100%" }}>
                <span
                  style={{
                    width: 26,
                    flexShrink: 0,
                    alignSelf: "center",
                    textAlign: "right",
                    fontSize: 10,
                    opacity: 0.6,
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {f}F
                </span>
                <div style={{ width: `${widthPct}%`, minWidth: 0, position: "relative", padding: 1 }}>
                  <div style={{ display: "flex", gap: 3 }}>
                    {fUnits.map((u) => (
                      <div key={u.id} style={{ flexGrow: u.sqm || 1, flexBasis: 0, minWidth: 0 }}>
                        <UnitBox
                          unit={u}
                          s={status[u.id] ?? -1}
                          selected={selectedId === u.id}
                          onSelect={onSelect}
                          onOpen={onOpen}
                          formatPrice={formatPrice}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Legend hasOffMarket={units.some((u) => !!u.offMarket)} />
    </div>
  );
}

function UnitBox({
  unit,
  s,
  selected,
  onSelect,
  onOpen,
  formatPrice,
}: {
  unit: Unit;
  s: number;
  selected: boolean;
  onSelect?: (u: Unit) => void;
  onOpen?: (u: Unit) => void;
  formatPrice?: (usd: number) => string;
}) {
  // Colour precedence: off-market > on-chain tile status (Preview has no held/pending state).
  const om = unit.offMarket;
  const m = om
    ? om.state === "killed"
      ? { bg: "#241016", border: "#7a2b4a", fg: "#e06a9a", label: "removed", icon: "✕" }
      : { bg: "#241024", border: "#7a2b7a", fg: "#e07ce0", label: "off-market", icon: "◆" }
    : meta(s);
  const shortNum = unit.id.replace(/^unit-/, "");
  const style: CSSProperties = {
    position: "relative",
    width: "100%",
    minWidth: 0,
    height: 34,
    borderRadius: 5,
    border: `1px solid ${selected ? "#2b62ff" : m.border}`,
    background: selected ? "#1a2030" : m.bg,
    color: m.fg,
    lineHeight: 1.05,
    cursor: onSelect || onOpen ? "pointer" : "default",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "ui-monospace, monospace",
    boxShadow: selected ? "0 0 0 1px #2b62ff" : "none",
    padding: 0,
    overflow: "hidden",
  };
  return (
    <button
      type="button"
      onClick={onSelect ? () => onSelect(unit) : onOpen ? () => onOpen(unit) : undefined}
      onDoubleClick={onOpen ? () => onOpen(unit) : undefined}
      title={[
        `Unit ${unit.id.replace(/^unit-/, "")}`,
        unit.type.toUpperCase(),
        `${unit.sqm}m²`,
        unit.view,
        formatPrice ? formatPrice(unit.priceUsd) : undefined,
        m.label,
      ]
        .filter(Boolean)
        .join(" · ")}
      style={style}
    >
      <span style={{ fontWeight: 600, fontSize: "clamp(8px, 2.6vw, 11px)" }}>{shortNum}</span>
      <span style={{ opacity: 0.65, fontSize: "clamp(6px, 1.9vw, 9px)" }}>{unit.type}</span>
    </button>
  );
}

function Legend({ hasOffMarket = false }: { hasOffMarket?: boolean }) {
  const items = [-1, 0, 1, 2];
  const entries = items.map((s) => ({ key: String(s), m: meta(s) }));
  if (hasOffMarket) {
    entries.push({
      key: "off-market",
      m: { bg: "#241024", border: "#7a2b7a", fg: "#e07ce0", label: "off-market", icon: "◆" },
    });
  }
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12 }}>
      {entries.map(({ key, m }) => (
        <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.9 }}>
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              background: m.bg,
              border: `1px solid ${m.border}`,
              color: m.fg,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            {m.icon}
          </span>
          {m.label.charAt(0).toUpperCase() + m.label.slice(1)}
        </span>
      ))}
    </div>
  );
}
