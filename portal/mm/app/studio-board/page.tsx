"use client";

// The authoring BOARD page — the fixed-canvas, draggable-group shell in action. This FOUNDATION
// slice proves the board + the layout file work with real-ish group content: a building stack (selects a floor),
// a live floor-plan editor (the engine+nudge), and labelled placeholders for the detail/palette/grid groups
// that get their real content wired in the next slices. designs the arrangement by dragging in design mode.

import { useMemo, useState } from "react";
import { useProject } from "../useProject";
import { projectToPack } from "@/lib/project-pack";
import { Board } from "../studio-ai/Board";
import { assembleBuildingPack } from "@/lib/ai-build";
import { newAuthoring, autoFillTypes, toSpec, toUnits } from "@/lib/authoring";
import { type Pack, type Unit } from "@/lib/pack";
import { subdivideFloor, type SubdivideResult } from "@/lib/subdivide";
import { seedsFromAi, type MixUnit } from "@/lib/floorplan-seeds";
import { floorSignature, layoutForFloor, applyLayoutToSeeds, setUnitOffset, clearFloorLayout } from "@/lib/floorplan-layout";
import { typeVocab } from "@/lib/unit-types";
import type { Pt } from "@/lib/geo";
// Palette now lives in the shared theme module (visual unification) — one look across every MM shell.
import { T } from "@/lib/theme";

const TYPE_COLOR: Record<string, string> = { shop: "#a855f7", studio: "#38bdf8", "1br": "#38d39f", "2br": "#e8b84b", "3br": "#fb923c" };
const typeColor = (k: string) => TYPE_COLOR[k] || "#64748b";

export default function StudioBoardPage() {
  // The board reads the SHARED STORE (stage 2): the active building, projected to a Pack for the engine. If
  // the building has no units yet (fresh blank project), fall back to a demo so the board still shows content
  // (flow 1 — "no real building, build a demo"). Floor-arrangement nudges write back to the store building.
  const store = useProject();
  const pack = useMemo<Pack>(() => {
    const live = projectToPack(store.project);
    return (live.buildings[0] && (live.buildingUnits[live.buildings[0].id]?.length ?? 0) > 0) ? live : demoPack();
  }, [store.project]);
  const usingStore = useMemo(() => {
    const live = projectToPack(store.project);
    return (live.buildings[0] && (live.buildingUnits[live.buildings[0].id]?.length ?? 0) > 0) || false;
  }, [store.project]);
  const [floor, setFloor] = useState(1);

  const b = pack.buildings[0];
  const units = b ? pack.buildingUnits[b.id] || [] : [];
  const floors = useMemo(() => [...new Set(units.map((u) => u.floor))].sort((a, c) => c - a), [units]);
  const floorUnits = units.filter((u) => u.floor === floor);
  const sig = floorSignature(floorUnits);
  const layout = layoutForFloor(pack.floorLayouts, floorUnits);
  const plan = planForFloor(floorUnits, layout);

  // nudges write to the store building's floorLayouts when we're on store data; demo data is in-memory only.
  function nudge(unitId: string, deltaM: number) {
    const cur = pack.floorLayouts?.[sig]?.offsets[unitId] ?? 0;
    const next = setUnitOffset(pack.floorLayouts, sig, unitId, cur + deltaM);
    if (usingStore) store.updateBuilding((bb) => ({ ...bb, floorLayouts: next }));
  }
  function resetArrangement() {
    const next = clearFloorLayout(pack.floorLayouts, sig);
    if (usingStore) store.updateBuilding((bb) => ({ ...bb, floorLayouts: next }));
  }

  function renderGroup(id: string) {
    switch (id) {
      case "stack":
        return (
          <div style={{ padding: 10 }}>
            {floors.map((f) => {
              const fus = units.filter((u) => u.floor === f);
              const on = f === floor;
              return (
                <button key={f} onClick={() => setFloor(f)}
                  style={{
                    display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "7px 10px", marginBottom: 4,
                    borderRadius: 7, cursor: "pointer", textAlign: "left",
                    background: on ? T.accent : T.bg2, color: on ? "#06121f" : T.text,
                    border: `1px solid ${on ? T.accent : T.border}`, fontSize: 12.5, fontWeight: on ? 700 : 500,
                  }}>
                  <span style={{ fontFamily: T.mono, minWidth: 34 }}>Fl {f}</span>
                  <span style={{ display: "flex", gap: 2 }}>
                    {fus.map((u, i) => <TypeIcon key={i} typeKey={u.type} size={13} color={on ? "#06121f" : typeColor(u.type)} />)}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.8 }}>{fus.length}u</span>
                </button>
              );
            })}
          </div>
        );
      case "floor":
        return (
          <div style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <div style={step}>Floor {floor} · subdivision engine</div>
              {layout && Object.keys(layout.offsets || {}).length > 0 && (
                <button onClick={resetArrangement} style={{ ...chip, marginLeft: "auto" }}>↺ reset arrangement</button>
              )}
            </div>
            {plan ? (
              <>
                <FloorPlanSvg result={plan.result} maxW={700} onNudge={nudge} />
                <PlanInvariant result={plan.result} />
                <div style={{ color: T.faint, fontSize: 11, marginTop: 6 }}>
                  Use the <span style={{ color: T.accent }}>‹ ›</span> handles to arrange units along the floor — width stays set by unit size.
                </div>
              </>
            ) : <div style={{ color: T.faint }}>No units on this floor.</div>}
          </div>
        );
      case "detail": {
        const title = b?.name || "Building";
        return (
          <div style={{ padding: 14 }}>
            <div style={step}>Selection detail</div>
            <Row k="Building" v={title} />
            <Row k="Floor" v={`${floor} · ${floorUnits.length} units`} />
            <Row k="Types" v={[...new Set(floorUnits.map((u) => u.type))].map((t) => typeVocab(t).acronym).join(" · ")} />
            <Row k="Σ area" v={`${Math.round(floorUnits.reduce((a, u) => a + u.sqm, 0))} m²`} />
            <div style={{ color: T.faint, fontSize: 11, marginTop: 8 }}>(The full detail pane wires in next slice.)</div>
          </div>
        );
      }
      case "palette":
        return <Placeholder label="Palette & actions" note="type palette + Generate/Export/Pricelist/Brochure wire in next slice" />;
      case "grid":
        return <Placeholder label="Unit grid (matrix)" note="the two-dropdown cells + icons + the ‹ translated here next slice" />;
      default:
        return <Placeholder label={id} />;
    }
  }

  return <Board renderGroup={renderGroup} />;
}

// ── the floor-plan engine draw (ported shape from studio-ai; the shared engine + layout/nudge) ──
const EFFICIENCY = 0.82, PLATE_ASPECT = 4 / 3;
function planForFloor(units: Unit[], layout?: ReturnType<typeof layoutForFloor>): { result: SubdivideResult } | null {
  const fus = units.filter((u) => u.sqm > 0);
  if (fus.length === 0) return null;
  const mix: MixUnit[] = fus.map((u, i) => ({
    typeKey: u.type, variationKey: (u.subtype || "").trim() || undefined, targetSqm: u.sqm,
    id: String(u.unitNumber ?? `${u.type}-${i + 1}`),
  }));
  const sellableSqm = fus.reduce((a, u) => a + u.sqm, 0);
  const grossSqm = sellableSqm / EFFICIENCY;
  const h = Math.sqrt(grossSqm / PLATE_ASPECT), w = grossSqm / h;
  const plate = { x: 0, y: 0, w, h };
  const floorPoly: Pt[] = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const corridorWidthM = Math.max(1.2, ((1 - EFFICIENCY) * grossSqm) / Math.max(w, h));
  const seeds = applyLayoutToSeeds(seedsFromAi(plate, mix), layout, plate);
  return { result: subdivideFloor({ floorPoly, seeds, corridorWidthM }) };
}

function FloorPlanSvg({ result, maxW = 520, onNudge }: { result: SubdivideResult; maxW?: number; onNudge?: (id: string, d: number) => void }) {
  const { plate, units, corridor } = result;
  if (!(plate.w > 0) || !(plate.h > 0)) return null;
  const pad = 14, scale = (maxW - pad * 2) / plate.w, W = maxW, H = plate.h * scale + pad * 2;
  const toPx = (p: Pt) => `${pad + (p.x - plate.x) * scale},${pad + (p.y - plate.y) * scale}`;
  const ring = (pts: Pt[]) => pts.map(toPx).join(" ");
  const horizontal = plate.w >= plate.h;
  const stepM = Math.max(0.4, (horizontal ? plate.w : plate.h) * 0.04);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, display: "block" }}>
      <polygon points={ring([{ x: plate.x, y: plate.y }, { x: plate.x + plate.w, y: plate.y }, { x: plate.x + plate.w, y: plate.y + plate.h }, { x: plate.x, y: plate.y + plate.h }])} fill="none" stroke={T.border} strokeWidth={1.5} />
      {corridor.length >= 3 && <polygon points={ring(corridor)} fill={`${T.accent}22`} stroke={`${T.accent}66`} strokeWidth={1} />}
      {units.map((u, i) => {
        const col = typeColor(u.typeKey || "");
        const cx = u.poly.reduce((s, p) => s + p.x, 0) / u.poly.length, cy = u.poly.reduce((s, p) => s + p.y, 0) / u.poly.length;
        const cxPx = pad + (cx - plate.x) * scale, cyPx = pad + (cy - plate.y) * scale;
        return (
          <g key={i}>
            <polygon points={ring(u.poly)} fill={`${col}55`} stroke={col} strokeWidth={1.8} />
            <SvgTypeIcon typeKey={u.typeKey || ""} x={cxPx} y={cyPx - 7} size={16} color={T.text} />
            <text x={cxPx} y={cyPx + 11} fill={T.text} fontSize={9} textAnchor="middle" dominantBaseline="middle" style={{ fontFamily: T.mono, pointerEvents: "none" }}>
              {typeVocab(u.typeKey || "").acronym}{u.variationKey ? ` ${u.variationKey.toUpperCase()}` : ""}
            </text>
            {onNudge && u.id && <NudgeHandles cx={cxPx} cy={cyPx} unitId={u.id} stepM={stepM} onNudge={onNudge} />}
          </g>
        );
      })}
      {units.map((u, i) => { const [x, y] = toPx(u.doorAt).split(",").map(Number); return <circle key={`d${i}`} cx={x} cy={y} r={2.6} fill={T.vetted} stroke="#0a0e17" strokeWidth={0.8} />; })}
    </svg>
  );
}

function NudgeHandles({ cx, cy, unitId, stepM, onNudge }: { cx: number; cy: number; unitId: string; stepM: number; onNudge: (id: string, d: number) => void }) {
  const gap = 11;
  const btn = (dx: number, label: string, delta: number) => (
    <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onNudge(unitId, delta); }}>
      <circle cx={cx + dx} cy={cy + 15} r={7} fill={T.panel2} stroke={T.accent} strokeWidth={1} />
      <text x={cx + dx} y={cy + 15} fill={T.accent} fontSize={11} fontWeight={700} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none", userSelect: "none" }}>{label}</text>
    </g>
  );
  return <>{btn(-gap, "‹", -stepM)}{btn(gap, "›", stepM)}</>;
}

function PlanInvariant({ result }: { result: SubdivideResult }) {
  const pct = result.floorSqm > 0 ? Math.round((result.corridorSqm / result.floorSqm) * 100) : 0;
  const ok = Math.abs(result.residualSqm) < 0.5 && result.reachable;
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: T.dim, marginTop: 8 }}>
      <span><b style={{ color: T.text }}>{Math.round(result.floorSqm)}</b> m² plate</span>
      <span><b style={{ color: T.text }}>{Math.round(result.unitsSqm)}</b> m² units</span>
      <span><b style={{ color: T.text }}>{Math.round(result.corridorSqm)}</b> m² corridor ({pct}%)</span>
      <span style={{ color: ok ? T.vetted : T.hold }}>{ok ? "✓ tessellates · all reachable" : "△ residual"}</span>
    </div>
  );
}

// ── the SVG type icon (from lib/unit-types vocab) ──
function SvgTypeIcon({ typeKey, x, y, size, color }: { typeKey: string; x: number; y: number; size: number; color: string }) {
  const v = typeVocab(typeKey);
  return <g transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})`} color={color} dangerouslySetInnerHTML={{ __html: v.glyph }} />;
}
/** An inline HTML (non-SVG-parent) type icon — wraps the glyph in its own <svg>. */
function TypeIcon({ typeKey, size, color }: { typeKey: string; size: number; color: string }) {
  const v = typeVocab(typeKey);
  return <svg width={size} height={size} viewBox="0 0 24 24" style={{ color, display: "block" }} dangerouslySetInnerHTML={{ __html: v.glyph }} />;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", padding: "5px 0", borderBottom: `1px solid ${T.borderSoft}`, fontSize: 13 }}>
      <span style={{ color: T.dim, width: 90, flex: "0 0 90px" }}>{k}</span><span>{v}</span>
    </div>
  );
}
function Placeholder({ label, note }: { label: string; note?: string }) {
  return (
    <div style={{ padding: 14, color: T.faint }}>
      <div style={step}>{label}</div>
      <div style={{ fontSize: 12, marginTop: 6 }}>{note || "— wires in next slice —"}</div>
    </div>
  );
}

// a demo building so the board shows real content before the generate-flow moves onto it
function demoPack(): Pack {
  const a = newAuthoring({ floors: 10, unitsPerFloor: 6, floorAreaM2: 1100 });
  a.grid = autoFillTypes(a);
  const { pack } = assembleBuildingPack(toSpec(a), toUnits(a));
  return pack;
}

const step: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.accent };
const chip: React.CSSProperties = { border: `1px solid ${T.border}`, borderRadius: 999, padding: "2px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer", background: "transparent", color: T.dim };
