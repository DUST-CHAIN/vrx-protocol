"use client";

// app — large grids of small colored numbered boxes, all fitting in the given space, fast to scan
// and sort." A condo IS a stacking plan (floors × unit-lines), so this is the natural shape for the
// developer and agent, who both need to see hundreds of units at a glance.
// comfortably handles a real building (a few hundred cells) with no extra dependency. Virtualization
// (@tanstack/react-virtual) is the documented next step ONLY if a grid exceeds a few hundred VISIBLE
// cells or we build a portfolio-wide view; canvas/WebGL (Binance's live-tick path) is reserved for a
// future live-updating mode. We stay dependency-light until the data forces otherwise.
// STATUS COLORS mirror lib/ui.ts statusColor + a distinct "unstamped" grey (no tile on-chain yet):
// grey = not on chain yet (developer hasn't marked it) green = open (available)
// amber = hold (booking in progress) blue = closed/done (sold/reserved)

import type { CSSProperties } from "react";
import type { Unit } from "@/lib/catalog-client";

// On-chain status per unit, keyed by catalog unit id. -1 = no tile yet; 0..3 = tile status.
export type UnitStatus = Record<string, number>;

// icon = a glyph shown in the legend swatch so each status reads as a deliberate state — the grey
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
  isFloorReady,
  isFloorFresh,
  onLoadFloor,
  selectMode = false,
  selectedIds,
  onToggle,
  held,
}: {
  units: Unit[];
  status: UnitStatus;
  selectedId?: string | null;
  onSelect?: (u: Unit) => void;
  /** Double-click a box → open its detail view (agent side). Single click still selects. */
  onOpen?: (u: Unit) => void;
  /** Format a unit's USD price for the hover tooltip (caller supplies its currency formatter). */
  formatPrice?: (usd: number) => string;
  /** Per-floor freshness: false → the floor shows a see-through "tap to load latest" overlay. */
  isFloorReady?: (floor: number) => boolean;
  /** Floor was just refreshed live this session → draw a green edge to confirm it's current. */
  isFloorFresh?: (floor: number) => boolean;
  /** Tap a stale floor's overlay → load that floor's live status. */
  onLoadFloor?: (floor: number) => void;
  /** Multi-select mode: clicking a box toggles it into a batch instead of opening its panel. */
  selectMode?: boolean;
  selectedIds?: Set<string>;
  onToggle?: (u: Unit) => void;
  /** — units HELD pending VRX approval (a version-gated change over them is awaiting sign-off). A
   * DEVELOPER-ONLY visual (agents never receive this set): a distinct amber "pending review" tint so the
   * developer spots in-flight units at a glance. Off-market still wins (a stronger, already-decided state). */
  held?: Set<string>;
}) {
  if (units.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: 14 }}>No units in this building&apos;s catalog yet.</p>;
  }

  // Group into rows by floor (descending — top floor at the top, like a real stacking plan), each
  // floor's units ordered by id so the lines stack consistently.
  const floors = Array.from(new Set(units.map((u) => u.floor))).sort((a, b) => b - a);
  const byFloor = new Map<number, Unit[]>();
  for (const f of floors) {
    byFloor.set(
      f,
      units.filter((u) => u.floor === f).sort((a, b) => a.id.localeCompare(b.id))
    );
  }

  // whole building — so a 40m² unit is the same width on every floor, and a floor with less total m²
  // is genuinely NARROWER. The floor with the greatest total m² spans 100% of the row; every other
  // floor's units container is (thatFloorTotal / maxFloorTotal) wide. Within a floor, each unit
  // flex-grows in proportion to its m². No horizontal overflow — the max is 100% of the container.
  const floorTotal = (f: number) => byFloor.get(f)!.reduce((sum, u) => sum + (u.sqm || 1), 0);
  const maxFloorTotal = Math.max(...floors.map(floorTotal)) || 1;

  // On a phone a wide building (10–12 unit-lines) can't shrink every cell below a legible width, so the
  // units 29xx + the form edges cut off). Fix: the plan scrolls horizontally INSIDE its own container,
  // and the inner plan gets a minWidth sized so each unit-line keeps a readable ~26px — so on a narrow
  // screen the user SWIPES the grid instead of losing columns, while on desktop it still fits at 100%.
  const maxUnitsPerFloor = Math.max(...floors.map((f) => byFloor.get(f)!.length), 1);
  // Minimum legible plan width: 26px floor label + ~34px per unit-line (incl. gaps). On desktop the
  // container is wider than this so `max(100%, …)` resolves to 100% (the proportional layout fills the
  // card). On a phone the viewport is narrower than this, so it resolves to the px floor → the plan is
  // my earlier `minWidth` alone didn't work because the %-width cells just shrank to fit, never
  // overflowing; a hard `width: max(100%, Npx)` forces the overflow a phone needs to swipe the grid).
  const planMinWidth = 26 + maxUnitsPerFloor * 34;

  return (
    <div>
      <div
        style={{
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          paddingBottom: 8,
        }}
      >
      <div style={{ display: "flex", flexDirection: "column", gap: 3, width: `max(100%, ${planMinWidth}px)` }}>
        {floors.map((f) => {
          const fUnits = byFloor.get(f)!;
          const widthPct = (floorTotal(f) / maxFloorTotal) * 100;
          const ready = isFloorReady ? isFloorReady(f) : true;
          const fresh = isFloorFresh ? isFloorFresh(f) : false;
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
              {/* This floor's units container: width proportional to the floor's total m². When the
 floor's cached data may be stale, we STILL SHOW IT (: the cached availability isn't
                  a secret — show it) and just overlay a subtle, semi-transparent "tap to load latest"
                  hint the user can click to refresh. The colours read through the see-through overlay. */}
              <div
                style={{
                  width: `${widthPct}%`,
                  minWidth: 0,
                  position: "relative",
                  border: fresh ? "1px solid #2f9e6a" : "1px solid transparent",
                  borderRadius: 6,
                  boxShadow: fresh ? "0 0 0 1px rgba(47,158,106,0.35)" : "none",
                  padding: 1,
                }}
              >
                <div style={{ display: "flex", gap: 3 }}>
                  {fUnits.map((u) => (
                    <div key={u.id} style={{ flexGrow: u.sqm || 1, flexBasis: 0, minWidth: 0 }}>
                      <UnitBox
                        unit={u}
                        s={status[u.id] ?? -1}
                        selected={selectMode ? !!selectedIds?.has(u.id) : selectedId === u.id}
                        marked={selectMode && !!selectedIds?.has(u.id)}
                        held={!!held?.has(u.id)}
                        onSelect={selectMode ? onToggle : onSelect}
                        onOpen={onOpen}
                        formatPrice={formatPrice}
                      />
                    </div>
                  ))}
                </div>
                {!ready && (
                  // can tap to refresh this floor if they want, but no label clutters the grid. A faint
                  // dashed edge + a tiny ↻ corner glyph are the only hint.
                  <button
                    type="button"
                    onClick={() => onLoadFloor?.(f)}
                    title={`Cached availability shown — tap to load the latest for floor ${f}`}
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "transparent",
                      border: "1px dashed rgba(120,140,180,0.28)",
                      borderRadius: 5,
                      cursor: "pointer",
                      padding: 0,
                      minHeight: 0,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        top: 1,
                        right: 3,
                        fontSize: 9,
                        opacity: 0.5,
                        color: "#c7cde0",
                        textShadow: "0 1px 2px rgba(0,0,0,0.9)",
                      }}
                    >
                      ↻
                    </span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </div>
      <Legend hasOffMarket={units.some((u) => u.offMarket)} hasHeld={!!held && units.some((u) => held.has(u.id))} />
    </div>
  );
}

function UnitBox({
  unit,
  s,
  selected,
  marked,
  held,
  onSelect,
  onOpen,
  formatPrice,
}: {
  unit: Unit;
  s: number;
  selected: boolean;
  /** In select mode + chosen: draw a filled check corner so a batch selection reads at a glance. */
  marked?: boolean;
  /** — held pending VRX approval (developer-only visual). Amber "pending review" override. */
  held?: boolean;
  onSelect?: (u: Unit) => void;
  /** Double-click / long-press → open the unit's detail view (agent side). */
  onOpen?: (u: Unit) => void;
  formatPrice?: (usd: number) => string;
}) {
  // Colour precedence (developer view): off-market (a decided state) > held-pending-approval (an in-flight
  // distinct amber "pending review" tint so the developer spots units frozen awaiting VRX sign-off — this set
  // is NEVER sent to an agent (lib/bookable gives them the neutral not_open wording; no leak.
  const om = unit.offMarket;
  const m = om
    ? om.state === "killed"
      ? { bg: "#241016", border: "#7a2b4a", fg: "#e06a9a", label: "removed", icon: "✕" }
      : { bg: "#241024", border: "#7a2b7a", fg: "#e07ce0", label: "off-market", icon: "◆" }
    : held
      ? { bg: "#2e2110", border: "#9a6a1e", fg: "#f0b25a", label: "held — pending approval", icon: "⏳" }
      : meta(s);
  // The box shows the unit's line-number (last chars of the id) — the compact "312" a stacking plan
  // wants. Full id is in the tooltip.
  const shortNum = unit.id.replace(/^unit-/, "");
  const style: CSSProperties = {
    position: "relative",
    width: "100%",
    // Fill the (proportional-width) cell. Fixed height so units vary only in WIDTH (= their size); the
    // label scales via clamp so it stays legible even in a narrow cell.
    minWidth: 0,
    height: 34,
    borderRadius: 5,
    border: `1px solid ${selected ? "#2b62ff" : m.border}`,
    background: selected ? "#1a2030" : m.bg,
    color: m.fg,
    lineHeight: 1.05,
    cursor: onSelect ? "pointer" : "default",
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
      onClick={onSelect ? () => onSelect(unit) : undefined}
      onDoubleClick={onOpen ? () => onOpen(unit) : undefined}
      title={[
        `Unit ${unit.id.replace(/^unit-/, "")}`,
        unit.type.toUpperCase(),
        `${unit.sqm}m²`,
        unit.view,
        formatPrice ? formatPrice(unit.priceUsd) : undefined,
        m.label,
        onOpen ? "— double-click for details" : undefined,
      ]
        .filter(Boolean)
        .join(" · ")}
      style={style}
    >
      {marked && (
        <span
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            width: 13,
            height: 13,
            borderRadius: 999,
            background: "#2b62ff",
            color: "#fff",
            fontSize: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✓
        </span>
      )}
      {/* clamp scales the label down on narrow cells so it never overflows / wraps badly. */}
      <span style={{ fontWeight: 600, fontSize: "clamp(8px, 2.6vw, 11px)" }}>{shortNum}</span>
      <span style={{ opacity: 0.65, fontSize: "clamp(6px, 1.9vw, 9px)" }}>{unit.type}</span>
    </button>
  );
}

function Legend({ hasOffMarket = false, hasHeld = false }: { hasOffMarket?: boolean; hasHeld?: boolean }) {
  // The four on-chain statuses, plus — only when the grid actually contains one — the off-market swatch
  // so agents/developers can read the magenta box. Deliberately terse ("off-market", no reason): agents
  // faint distinct colour, but no story). Killed units are stripped from buyer views upstream, so on the
  // agent/agency grid this only ever labels a BLOCKED unit.
  const items = [-1, 0, 1, 2];
  const entries: { key: string; m: { bg: string; border: string; fg: string; label: string; icon: string } }[] =
    items.map((s) => ({ key: String(s), m: meta(s) }));
  if (hasHeld) {
    entries.push({
      key: "held",
      m: { bg: "#2e2110", border: "#9a6a1e", fg: "#f0b25a", label: "held — pending approval", icon: "⏳" },
    });
  }
  if (hasOffMarket) {
    entries.push({
      key: "off-market",
      m: { bg: "#241024", border: "#7a2b7a", fg: "#e07ce0", label: "off-market", icon: "◆" },
    });
  }
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12 }}>
      {entries.map(({ key, m }) => {
        // Swatch carries the same icon + colour the status uses, so each legend entry — including the
        // grey "not stamped" one — reads as a deliberate marked state, never a blank box.
        return (
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
        );
      })}
    </div>
  );
}
