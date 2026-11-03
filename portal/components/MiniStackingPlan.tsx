"use client";

// MiniStackingPlan — a DENSE, read-only stacking plan for the warroom's multi-building WALL (
// "show 3–4 buildings per row, each its own card; each unit much smaller; show only the type on the
// box; put the unit number + all details into a well-formatted mouse-over; the scrubber animates all units
// day by day; no dropdown"). It's a lighter sibling of components/StackingPlan:
//   • each unit is a tiny status-coloured box showing ONLY its type ("1br") — no number on the box;
//   • a rich HOVER TOOLTIP carries the unit number + size + price + view + that-day status;
//   • no selection, no per-floor lazy overlay, no legend — it renders a FROZEN daily frame, not live state.
//
// EXTENSIBLE TOOLTIP SEAM: the tooltip is built to eventually show "all details about this unit"
// — when the warroom graduates to the per-developer CEO app, the CEO also wants payment/accounting detail
// derived from the (not-yet-built) accounting + payment-tracking modules. So the tooltip takes an optional
// `extra` slot: today it's unused; later the warroom passes a <UnitPaymentDetail/> node and it renders below
// the catalog facts with zero change here. Keep that slot — it's the attach point for the future module.
//
// PRIVACY/PERF: this draws a captured snapshot (unitId → status code) the server already holds — no chain
// reads. The whole wall can be ~1,558 boxes; each box is a plain <div> with a CSS-only hover tooltip (no JS
// per-cell state), so a full-catalog render stays cheap. Status codes: 0 open · 1 hold · 2 closed/sold ·
// 3 done · -1 not listed (mirrors StackingPlan STATUS_META + the developer off-market magenta).

import { useMemo, type ReactNode } from "react";
import type { Unit } from "@/lib/catalog-client";

const STATUS_META: Record<number, { bg: string; border: string; fg: string; label: string }> = {
  [-1]: { bg: "#171b26", border: "#3a4256", fg: "#8b93a8", label: "not listed" },
  0: { bg: "#12291b", border: "#2f6a44", fg: "#7ce0a0", label: "available" },
  1: { bg: "#2a2412", border: "#7a6a2a", fg: "#e0c67c", label: "on hold" },
  2: { bg: "#141d2e", border: "#2f4a7a", fg: "#7aa2ff", label: "sold / reserved" },
  3: { bg: "#141d2e", border: "#2f4a7a", fg: "#7aa2ff", label: "done" },
};
const meta = (s: number) => STATUS_META[s] ?? STATUS_META[-1];

// Shorten a unit type to ONE glyph so the box can be truly tiny: 1br→1, 2br→2, studio→S,
// penthouse→P, duplex→D, shop→$. Fallback: the first DIGIT in the key (bedroom count), else the first
// letter upper-cased. The full type always shows in the hover tooltip.
// NOTE (future): developers DEFINE their own unit types — so this map is only the built-in default. When
// the MM import app lands, type → name → shortcode becomes developer-configured data carried in the import
// pack; this map is the fallback for the demo catalog's known types until then.
const TYPE_GLYPH: Record<string, string> = {
  studio: "S",
  penthouse: "P",
  duplex: "D",
  shop: "$",
  "1br": "1",
  "2br": "2",
  "3br": "3",
  "4br": "4",
};
function typeGlyph(type: string): string {
  const key = type.toLowerCase();
  if (TYPE_GLYPH[key]) return TYPE_GLYPH[key];
  const digit = key.match(/\d/);
  return digit ? digit[0] : key.charAt(0).toUpperCase();
}

export function MiniStackingPlan({
  units,
  status,
  formatPrice,
  /** Optional future seam: given a unit, return extra tooltip content (e.g. payment detail). Unused today. */
  renderExtra,
}: {
  units: Unit[];
  status: Record<string, number>;
  formatPrice?: (usd: number) => string;
  renderExtra?: (unit: Unit) => ReactNode;
}) {
  // Group by floor, top floor first (a real stacking plan), units ordered by id within a floor.
  const { floors, byFloor, maxPerFloor } = useMemo(() => {
    const floors = Array.from(new Set(units.map((u) => u.floor))).sort((a, b) => b - a);
    const byFloor = new Map<number, Unit[]>();
    for (const f of floors) {
      byFloor.set(f, units.filter((u) => u.floor === f).sort((a, b) => a.id.localeCompare(b.id)));
    }
    const maxPerFloor = Math.max(1, ...floors.map((f) => byFloor.get(f)!.length));
    return { floors, byFloor, maxPerFloor };
  }, [units]);

  if (units.length === 0) {
    return <div style={{ opacity: 0.6, fontSize: 12 }}>No units.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {floors.map((f, fi) => {
        const fUnits = byFloor.get(f)!;
        // Top ~3 rows have no room for a tooltip above them → flip it below (CSS .vrx-minirow-top).
        const topRow = fi < 3;
        return (
          <div key={f} className={topRow ? "vrx-minirow-top" : undefined} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ width: 15, flexShrink: 0, textAlign: "right", fontSize: 7.5, fontWeight: 700, color: "#6cc4ff", fontFamily: "ui-monospace, monospace" }}>
              {f}
            </span>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${maxPerFloor}, 1fr)`,
                gap: 1.5,
                flex: 1,
                minWidth: 0,
              }}
            >
              {fUnits.map((u) => (
                <MiniBox key={u.id} unit={u} s={status[u.id] ?? -1} formatPrice={formatPrice} renderExtra={renderExtra} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MiniBox({
  unit,
  s,
  formatPrice,
  renderExtra,
}: {
  unit: Unit;
  s: number;
  formatPrice?: (usd: number) => string;
  renderExtra?: (unit: Unit) => ReactNode;
}) {
  // Off-market (developer-only) overrides the on-chain colour, same as StackingPlan.
  const om = unit.offMarket;
  const m = om
    ? om.state === "killed"
      ? { bg: "#241016", border: "#7a2b4a", fg: "#e06a9a", label: "removed" }
      : { bg: "#241024", border: "#7a2b7a", fg: "#e07ce0", label: "off-market" }
    : meta(s);
  const num = unit.id.replace(/^unit-/, "");

  return (
    <div
      className="vrx-minibox"
      style={{
        position: "relative",
        height: 13,
        borderRadius: 2,
        border: `1px solid ${m.border}`,
        background: m.bg,
        color: m.fg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "ui-monospace, monospace",
        fontSize: 8,
        fontWeight: 600,
        lineHeight: 1,
        overflow: "visible",
        cursor: "default",
      }}
    >
      {/* ONE glyph on the box (: 1br→1, studio→S, …) so it stays tiny — number + detail in tooltip. */}
      <span style={{ opacity: 0.85 }}>{typeGlyph(unit.type)}</span>

      {/* Rich hover tooltip — CSS-only (shown via .vrx-minibox:hover in globals.css), so there's no
          per-cell React state for 1,558 boxes. Built to grow: catalog facts now, the `renderExtra` slot
          (future payment/accounting detail for the CEO app) below. */}
      <div className="vrx-minitip" role="tooltip">
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 3 }}>
          Unit {num}
          <span style={{ fontWeight: 400, opacity: 0.6 }}> · {unit.type.toUpperCase()}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px", fontSize: 11 }}>
          <span style={{ opacity: 0.55 }}>Floor</span><span>{unit.floor}</span>
          <span style={{ opacity: 0.55 }}>Size</span><span>{unit.sqm} m²</span>
          {formatPrice && (<><span style={{ opacity: 0.55 }}>Price</span><span>{formatPrice(unit.priceUsd)}</span></>)}
          {unit.view && (<><span style={{ opacity: 0.55 }}>View</span><span>{unit.view}</span></>)}
          <span style={{ opacity: 0.55 }}>Status</span>
          <span style={{ color: m.fg, fontWeight: 600 }}>{m.label}</span>
        </div>
        {renderExtra && <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #2a3350" }}>{renderExtra(unit)}</div>}
      </div>
    </div>
  );
}
