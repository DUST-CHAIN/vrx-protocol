"use client";

// The new AI-first MM shell (the design docs step 4). A SIMPLE new front-end over the
// proven MM libs — NOT the heavy Studio tag-chip tree. Dark (VRX theme), flat folder/file-explorer tree,
// AI-first: a small form generates the whole Developer→Complex→Building→Floor→{type-group}→{variation} hierarchy
// (assembleBuildingPack), then the tree reviews/drills it and the detail pane shows the selected node. The
// generation form shows the Σ(units)+walkway=floor invariant LIVE as you type (walkway is DERIVED, never typed).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../useProject";
import { toAuthoring, fromAuthoring, activeBuilding, updateActiveBuilding, activeComplex, patchComplex } from "@/lib/project";
import { assembleBuildingPack } from "@/lib/ai-build";
import { fillFromRendersetClient } from "@/lib/ai-build-renderset-client";
import { floorInvariant } from "@/lib/floorplan-invariant";
import {
  type BuildingAuthoring, type AuthoringType, newAuthoring, resizeGrid, autoFillTypes, toSpec, toUnits, authoringSummary,
  addSubtype, removeSubtype, patchSubtype, fillColumn, floorWidths, MAX_SUBTYPES,
  addType, removeType, MAX_TYPES,
} from "@/lib/authoring";
import { pricelistHtml } from "@/lib/pricelist";
import { brochureHtml } from "@/lib/brochure";
import { toZip } from "@/lib/export";
import { totalUnits, type Pack, type Unit } from "@/lib/pack";
import { subdivideFloor, type SubdivideResult } from "@/lib/subdivide";
import { seedsFromAi, type MixUnit } from "@/lib/floorplan-seeds";
import {
  floorSignature, layoutForFloor, applyLayoutToSeeds, setUnitOffset, clearFloorLayout, type FloorLayout,
} from "@/lib/floorplan-layout";
import type { Pt } from "@/lib/geo";

// Palette now lives in the shared theme module (visual unification) so every MM shell renders one look.
import { T } from "@/lib/theme";
// Reuse ops on the canvas (IA pass): the empty-state "Template/Import" and the header "Reuse ▾" menu share
// these — the reuse surface is DEMOTED off a wall of buttons into context.
import {
  type EntityLevel, type TemplateMeta,
  saveTemplate, listTemplates, loadTemplate, deleteTemplate,
} from "@/lib/project-reuse";
import { downloadEntity, readEntityFile } from "@/lib/entity-file";

// how an import reads back to the user (mirrors /manage's phrasing — one place to keep it consistent)
function importNote(level: EntityLevel): string {
  return level === "developer" ? "Imported developer (identity replaced)."
    : level === "complex" ? "Imported complex (replaced wholesale)."
    : "Imported building (copy added & selected).";
}

type Sel =
  | { kind: "developer" }
  | { kind: "complex"; id: string }
  | { kind: "building"; id: string }
  | { kind: "floor"; buildingId: string; floor: number }
  | { kind: "group"; buildingId: string; typeKey: string }
  | { kind: "variation"; buildingId: string; typeKey: string; variationKey: string };

export default function StudioAiPage() {
  // ── authoring state is now BACKED BY THE SHARED STORE (stage 1) — the grid form edits the active building
  //    in the tree, so navigating between shells / refreshing no longer loses it. `a` is the active building
  //    projected to the BuildingAuthoring shape the form was written against; setA folds edits back (grid → the
  //    building; developer/complex names → the tree). Same call signatures the rest of the file already uses. ──
  const store = useProject();
  const active = store.activeBuilding;
  const a: BuildingAuthoring = useMemo(
    () => (active ? toAuthoring(store.project, active) : newAuthoring()),
    [store.project, active]
  );
  const setA = useCallback((next: BuildingAuthoring | ((cur: BuildingAuthoring) => BuildingAuthoring)) => {
    store.setProject((() => {
      const p = store.project;
      const b = activeBuilding(p);
      if (!b) return p;
      const cur = toAuthoring(p, b);
      const na = typeof next === "function" ? (next as (c: BuildingAuthoring) => BuildingAuthoring)(cur) : next;
      // names are tree-level — fold them onto developer + the ACTIVE complex (the one holding this building);
      // the rest onto the building node.
      let np = { ...p, developer: { ...p.developer, name: na.developerName } };
      const cx = activeComplex(np);
      if (cx) np = patchComplex(np, cx.id, { name: na.complexName });
      np = updateActiveBuilding(np, (bb) => fromAuthoring(bb, na));
      return np;
    })());
  }, [store]);
  const patch = (next: Partial<BuildingAuthoring>) => setA((cur) => ({ ...cur, ...next }));
  // keep the grid sized to floors × unitsPerFloor whenever the shape changes (preserving overlap)
  function setShape(next: Partial<Pick<BuildingAuthoring, "floors" | "unitsPerFloor">>) {
    setA((cur) => { const merged = { ...cur, ...next }; return { ...merged, grid: resizeGrid(merged) }; });
  }

  const [pack, setPack] = useState<Pack | null>(null);
  const [sel, setSel] = useState<Sel>({ kind: "developer" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // ── Reuse ops — shared by the empty-state cards + the header "Reuse ▾" menu. Reuse is an ADVANCED,
  //    in-context action now, not a wall of buttons. The full tree-level manager still lives at /manage. ──
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [flash, setFlash] = useState("");
  const say = useCallback((m: string) => { setFlash(m); }, []);
  const doExport = useCallback((level: EntityLevel) => {
    const env = store.exportEntity(level);
    if (env) { downloadEntity(env); say(`Exported ${level}.`); }
  }, [store, say]);
  const pickImport = useCallback(() => fileRef.current?.click(), []);
  const onImportFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const env = await readEntityFile(file);
    if (!env) { say("That file isn't a valid MM entity export."); return; }
    const res = store.importEntity(env);
    say(importNote(res.level));
  }, [store, say]);
  const loadTpl = useCallback((key: string) => {
    const env = loadTemplate(key);
    if (!env) { say("Template not found."); return; }
    const res = store.importEntity(env);
    say(`Loaded template (${res.level}).`);
  }, [store, say]);
  const saveTpl = useCallback((level: EntityLevel, name: string) => {
    const env = store.exportEntity(level);
    if (!env) { say("Nothing to save at that level."); return; }
    const key = saveTemplate(name, env);
    say(key ? `Saved ${level} template "${name}".` : "Couldn't save the template.");
  }, [store, say]);
  const delTpl = useCallback((meta: TemplateMeta) => {
    deleteTemplate(meta.key);
    say(`Deleted template "${meta.name}".`);
  }, [say]);
  const duplicate = useCallback(() => {
    const res = store.duplicateBuilding();
    say(res.addedId ? "Duplicated — new building added & selected." : "Nothing to duplicate yet.");
  }, [store, say]);

  async function generate() {
    setErr(""); setBusy(true); setPack(null);
    try {
      const summary = authoringSummary(a);
      if (summary.total === 0) { setErr("Assign some unit types first (use Auto-fill or click cells)."); setBusy(false); return; }
      const spec = toSpec(a);
      const units = toUnits(a);
      const { pack: p } = assembleBuildingPack(spec, units); // authored units VERBATIM — full fidelity
      const withImgs = await fillFromRendersetClient(p);
      if (withImgs.length) p.media = [...(p.media || []), ...withImgs];
      setPack(p);
      setSel({ kind: "developer" });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  function openDoc(kind: "pricelist" | "brochure") {
    if (!pack) return;
    const bId = pack.buildings[0]?.id;
    if (!bId) return;
    const html = kind === "pricelist" ? pricelistHtml(pack, bId) : brochureHtml(pack, bId);
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
  }
  async function download() {
    if (!pack) return;
    const blob = await toZip(pack, "vrx-mm-studio-ai 0.1.0");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${pack.developer.id || "pack"}-ingest-pack.zip`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ background: T.bg, color: T.text, minHeight: "100vh", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: `1px solid ${T.border}` }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: T.accent, display: "inline-block" }} />
        <b style={{ fontSize: 15 }}>VRX Model Maker</b>
        <span style={{ color: T.faint, fontSize: 12 }}>AI-first · author a development</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {pack && (
            <>
              <button style={btn()} onClick={() => setPack(null)} title="back to the authoring grid (it's preserved)">← Edit grid</button>
              <button style={btn(T.accent)} onClick={download}>⭳ Export ZIP</button>
              <button style={btn()} onClick={() => openDoc("pricelist")}>Pricelist</button>
              <button style={btn()} onClick={() => openDoc("brochure")}>Brochure</button>
            </>
          )}
          {/* Reuse is an advanced in-context action — one tidy menu, not a button wall. The menu carries
 the WHOLE reuse surface (the old /manage route was retired into it). */}
          <ReuseMenu onExport={doExport} onImport={pickImport} onSaveTemplate={saveTpl}
            onLoadTemplate={loadTpl} onDeleteTemplate={delTpl} onDuplicate={duplicate} />
        </div>
      </div>
      {/* hidden file input backing both the empty-state Import card and the Reuse ▾ › Import entity… item */}
      <input
        ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
        onChange={(e) => { onImportFile(e.target.files?.[0]); e.target.value = ""; }}
      />
      {flash && (
        <div role="status" onClick={() => setFlash("")}
          style={{ position: "fixed", bottom: 60, left: "50%", transform: "translateX(-50%)", zIndex: 1100,
            background: T.panel2, border: `1px solid ${T.accent}`, color: T.text, borderRadius: 8,
            padding: "8px 14px", fontSize: 13, cursor: "pointer", boxShadow: "0 2px 12px rgba(0,0,0,.4)" }}>
          {flash} <span style={{ opacity: 0.6, marginLeft: 6 }}>✕</span>
        </div>
      )}

      {!pack ? (
        <AuthoringForm a={a} patch={patch} setShape={setShape} setA={setA} busy={busy} err={err} generate={generate}
          onImport={pickImport} onLoadTemplate={loadTpl} />
      ) : (
        <div style={{ display: "flex", height: "calc(100vh - 46px)" }}>
          <Tree pack={pack} sel={sel} setSel={setSel} />
          <Detail pack={pack} sel={sel} setPack={setPack} />
        </div>
      )}
    </div>
  );
}

// ── the AUTHORING form: define the building (shape) → assign TYPES per floor (grid + auto-fill) → SUBTYPES ──
// A per-color per type so the grid reads at a glance.
const TYPE_COLOR: Record<string, string> = { shop: "#a855f7", studio: "#38bdf8", "1br": "#38d39f", "2br": "#e8b84b", "3br": "#fb923c" };
const typeColor = (k: string) => TYPE_COLOR[k] || "#64748b";

function AuthoringForm({ a, patch, setShape, setA, busy, err, generate, onImport, onLoadTemplate }: {
  a: BuildingAuthoring;
  patch: (n: Partial<BuildingAuthoring>) => void;
  setShape: (n: Partial<Pick<BuildingAuthoring, "floors" | "unitsPerFloor">>) => void;
  setA: (fn: (cur: BuildingAuthoring) => BuildingAuthoring) => void;
  busy: boolean; err: string; generate: () => void;
  onImport: () => void; onLoadTemplate: (key: string) => void;
}) {
  const [shopFloors, setShopFloors] = useState(0);
  const summary = authoringSummary(a);
  // a fresh canvas shows an inline empty-state (New / Template / Import) instead of a bare grid — the
  //       "if no data, ask what the user wants to do". Dismissed by starting to author (New) or by Template/Import.
  const [started, setStarted] = useState(false);
  const isEmpty = summary.total === 0 && !started;
  // the live Σ+walkway=floor invariant from the AVERAGE authored unit size × units-per-floor
  const avgSqm = a.types.length ? Math.round(a.types.reduce((s, t) => s + t.sqm, 0) / a.types.length) : 50;
  const inv = floorInvariant(a.floorAreaM2, Array(Math.max(0, a.unitsPerFloor)).fill(avgSqm));
  const invColor = inv.over ? T.danger : inv.fits ? T.vetted : T.hold;

  // set a cell's type (cycles subtype to the type's first) or its subtype
  function setCellType(f: number, u: number, typeKey: string) {
    setA((cur) => {
      const grid = cur.grid.map((r) => r.slice());
      const firstSub = cur.types.find((t) => t.key === typeKey)?.subtypes[0]?.key ?? "a";
      grid[f][u] = { typeKey, subtypeKey: typeKey ? firstSub : "" };
      return { ...cur, grid };
    });
  }
  function setCellSub(f: number, u: number, subtypeKey: string) {
    setA((cur) => { const grid = cur.grid.map((r) => r.slice()); grid[f][u] = { ...grid[f][u], subtypeKey }; return { ...cur, grid }; });
  }
  // fill a WHOLE floor with one type (quick per-floor assignment)
  function fillFloor(f: number, typeKey: string) {
    setA((cur) => {
      const grid = cur.grid.map((r) => r.slice());
      const firstSub = cur.types.find((t) => t.key === typeKey)?.subtypes[0]?.key ?? "a";
      grid[f] = grid[f].map(() => ({ typeKey, subtypeKey: typeKey ? firstSub : "" }));
      return { ...cur, grid };
    });
  }
  // fill a WHOLE COLUMN with the painted type — columns are the real unit of layout
  function doFillColumn(col: number, typeKey: string) {
    setA((cur) => ({ ...cur, grid: fillColumn(cur, col, typeKey) }));
  }
  // subtype SIZES (the right pane,: "sizes only") — all read live by the grid + toUnits
  const typesPatch = (next: AuthoringType[]) => setA((cur) => ({ ...cur, types: next }));

  const [painting, setPainting] = useState<string>("1br"); // the type a cell-click/column-fill assigns

  return (
    // Three-pane layout: config LEFT · the per-floor grid MAIN · subtype SIZES RIGHT.
    <div style={{ display: "flex", height: "calc(100vh - 46px)" }}>
      {/* LEFT PANE — the building details (config) + palette + Generate */}
      <aside style={{ width: 340, flex: "0 0 340px", borderRight: `1px solid ${T.border}`, overflowY: "auto", background: T.panel, padding: "16px 16px 24px" }}>
        <div style={step}>1 · Building</div>
        <Field label="Developer"><input value={a.developerName} onChange={(e) => patch({ developerName: e.target.value })} style={inp()} /></Field>
        <Field label="Building name"><input value={a.buildingName} onChange={(e) => patch({ buildingName: e.target.value })} style={inp()} /></Field>
        <Field label="Project / development"><input value={a.complexName} onChange={(e) => patch({ complexName: e.target.value })} style={inp()} /></Field>
        <Field label="Area / district" hint="public info"><input value={a.area ?? ""} onChange={(e) => patch({ area: e.target.value })} placeholder="northpoint" style={inp()} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Floors"><input type="number" min={1} value={a.floors} onChange={(e) => setShape({ floors: Math.max(1, +e.target.value || 1) })} style={inp()} /></Field>
          <Field label="Units / floor"><input type="number" min={1} value={a.unitsPerFloor} onChange={(e) => setShape({ unitsPerFloor: Math.max(1, +e.target.value || 1) })} style={inp()} /></Field>
        </div>
        <Field label="m² per floor" hint="walkway derived"><input type="number" min={1} value={a.floorAreaM2} onChange={(e) => patch({ floorAreaM2: Math.max(1, +e.target.value || 1) })} style={inp()} /></Field>

        <div style={{ marginTop: 4, padding: "8px 11px", borderRadius: 8, background: T.bg2, border: `1px solid ${invColor}44`, fontSize: 12 }}>
          <div style={{ color: invColor, fontWeight: 600 }}>{inv.over ? "✗ units overflow the floor" : inv.fits ? "✓ fits" : "△ corridor tight"}</div>
          <div style={{ color: T.dim, marginTop: 2 }}>{a.unitsPerFloor} units ≈ {inv.unitsAreaM2} m² + {inv.walkwayM2} m² walkway ({inv.walkwayPct}%)</div>
        </div>

        <div style={{ borderTop: `1px solid ${T.borderSoft}`, margin: "16px 0 12px" }} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={step}>Palette</div>
          <span style={{ color: T.faint, fontSize: 11.5, marginLeft: "auto" }}>paint = the type a click/fill assigns</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {a.types.map((t) => (
            <button key={t.key} onClick={() => setPainting(t.key)}
              style={{ ...chipBtn, background: painting === t.key ? typeColor(t.key) : "transparent", color: painting === t.key ? "#06121f" : T.text, borderColor: typeColor(t.key) }}>
              {t.label}
            </button>
          ))}
        </div>

        <div style={step}>Auto-fill</div>
        <label style={{ fontSize: 12.5, color: T.dim, display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
          Shop floors (low)
          <input type="number" min={0} max={a.floors} value={shopFloors} onChange={(e) => setShopFloors(Math.max(0, +e.target.value || 0))} style={{ ...inp(), width: 60, padding: "4px 7px", marginTop: 0 }} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...btn(T.accent), flex: 1 }} onClick={() => patch({ grid: autoFillTypes(a, { shopFloors }) })}>⚡ Auto-fill</button>
          <button style={btn()} onClick={() => patch({ grid: a.grid.map((r) => r.map(() => ({ typeKey: "", subtypeKey: "" }))) })}>Clear</button>
        </div>

        <div style={{ borderTop: `1px solid ${T.borderSoft}`, margin: "16px 0 12px" }} />
        <div style={{ fontSize: 12.5, color: T.dim, marginBottom: 10 }}>
          <b style={{ color: T.text }}>{summary.total}</b> units · {Object.entries(summary.byType).map(([k, n]) => `${n} ${k}`).join(" · ") || "none yet"}
        </div>
        <button onClick={generate} disabled={busy || summary.total === 0}
          style={{ ...btn(T.accent), width: "100%", padding: "10px 18px", fontSize: 14, opacity: busy || summary.total === 0 ? 0.55 : 1 }}>
          {busy ? "Generating…" : "✦ Generate development"}
        </button>
        {err && <div style={{ color: T.danger, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      </aside>

      {/* MAIN — the per-floor grid (the work surface), or the inline empty-state on a fresh canvas */}
      <main style={{ flex: 1, overflow: "auto", padding: "22px 26px" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 2px" }}>Author a development</h1>
        {isEmpty ? (
          <EmptyState onNew={() => setStarted(true)} onImport={onImport} onLoadTemplate={onLoadTemplate} />
        ) : (
        <>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <div style={step}>2 · Unit grid</div>
          <span style={{ color: T.faint, fontSize: 12 }}>click a cell = paint it (again = clear) · ↓fill a column · ⟵fill a floor · cell width ∝ size · corner no. = floor×100+position · arrange units on the floor plan after Generate</span>
        </div>

        <table style={{ borderCollapse: "separate", borderSpacing: 4 }}>
          <tbody>
            {/* COLUMN HEADER ROW — fill a whole column (one unit position up every floor) with the painted type */}
            <tr>
              <td style={{ color: T.faint, fontSize: 10, fontFamily: T.mono, paddingRight: 8, textAlign: "right", verticalAlign: "bottom", paddingBottom: 2 }}>col</td>
              {Array.from({ length: a.unitsPerFloor }, (_, c) => (
                <td key={c} style={{ padding: 0, textAlign: "center" }}>
                  <button title={`fill column ${c + 1} with ${painting}`} onClick={() => doFillColumn(c, painting)}
                    style={{ ...chipBtn, padding: "1px 0", fontSize: 10, width: 72, borderColor: T.border, color: T.dim }}>↓fill {c + 1}</button>
                </td>
              ))}
            </tr>
            {a.grid.map((row, fIdx) => {
              const floor = fIdx + 1;
              const widths = floorWidths(a, fIdx); // fraction per cell (∝ size); empty = 0
              return (
                <tr key={floor}>
                  <td style={{ color: T.faint, fontSize: 11.5, fontFamily: T.mono, paddingRight: 8, whiteSpace: "nowrap", textAlign: "right" }}>
                    Fl {floor}
                    <button title="fill floor with the painted type" onClick={() => fillFloor(fIdx, painting)}
                      style={{ ...chipBtn, marginLeft: 6, padding: "1px 6px", fontSize: 10, borderColor: T.border, color: T.dim }}>⟵fill</button>
                  </td>
                  {(() => {
                    // unit numbers follow the horizontal order (floor×100 + running sellable position), matching toUnits
                    let pos = 0;
                    return row.map((cell, uIdx) => {
                      const t = a.types.find((x) => x.key === cell.typeKey);
                      const isCore = t?.kind === "core";
                      const sellable = !!cell.typeKey && !isCore;
                      if (sellable) pos++;
                      const unitNo = sellable ? floor * 100 + pos : null;
                      const col = cell.typeKey ? typeColor(cell.typeKey) : T.border;
                      // width ∝ size: base 72px scaled by this cell's share vs the average share (keeps the grid readable)
                      const share = widths[uIdx] || 0;
                      const avgShare = a.unitsPerFloor ? 1 / a.unitsPerFloor : 1;
                      const w = cell.typeKey ? Math.round(Math.min(132, Math.max(52, 72 * (share / (avgShare || 1))))) : 72;
                      return (
                        <td key={uIdx} style={{ padding: 0 }}>
                          <div style={{ display: "flex", flexDirection: "column", width: w, transition: "width .12s" }}>
                            <button
                              onClick={() => setCellType(fIdx, uIdx, cell.typeKey === painting ? "" : painting)}
                              title={cell.typeKey ? `${t?.label}${unitNo ? ` · unit ${unitNo}` : " · structural (core)"}` : "empty — click to assign"}
                              style={{
                                position: "relative", height: 30, borderRadius: "5px 5px 0 0", cursor: "pointer", fontSize: 11, fontWeight: 600,
                                // spell out the sides (not `border` + `borderBottom:none`) — React warns on mixing
                                // a shorthand with a longhand for the same property on re-render.
                                borderTop: `1px solid ${col}`, borderLeft: `1px solid ${col}`, borderRight: `1px solid ${col}`, borderBottom: "none",
                                background: cell.typeKey ? col : T.bg2, color: cell.typeKey ? "#06121f" : T.faint,
                              }}>
                              {cell.typeKey ? (t?.label.split(" ")[0] || cell.typeKey) : "—"}
                              {unitNo != null && (
                                <span style={{ position: "absolute", top: 1, right: 3, fontSize: 8.5, fontWeight: 700, fontFamily: T.mono, color: "#06121f", opacity: 0.72 }}>{unitNo}</span>
                              )}
                            </button>
                            {cell.typeKey && (t?.subtypes.length ?? 0) > 0 ? (
                              <select value={cell.subtypeKey} onChange={(e) => setCellSub(fIdx, uIdx, e.target.value)}
                                style={{ fontSize: 10, border: `1px solid ${col}`, borderRadius: "0 0 5px 5px", background: T.bg2, color: T.text, padding: "1px 2px" }}>
                                {t!.subtypes.map((s) => <option key={s.key} value={s.key}>{s.key.toUpperCase()}{s.sqm ? ` · ${s.sqm}m²` : ""}</option>)}
                              </select>
                            ) : <div style={{ height: 16, borderBottom: `1px solid ${T.borderSoft}`, borderLeft: `1px solid ${T.borderSoft}`, borderRight: `1px solid ${T.borderSoft}`, borderRadius: "0 0 5px 5px" }} />}
                          </div>
                        </td>
                      );
                    });
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
        </>
        )}
      </main>

      {/* RIGHT PANE — the TYPE VOCABULARY: add/remove whole TYPES here (the palette just picks what to
          paint), each type's add/remove SUBTYPES (≤20) + their m². Removing a type also clears its painted cells. */}
      <SubtypeSizesPane
        types={a.types}
        typesPatch={typesPatch}
        onAddType={() => patch({ types: addType(a.types) })}
        onRemoveType={(k) => patch(removeType(a.types, a.grid, k))}
      />
    </div>
  );
}

// ── EMPTY STATE — a fresh canvas asks "what do you want to do?" inline (not a modal): author
//    scratch, start from a saved template, or import a project file. The template picker reads building-level
//    localStorage templates (the common "clone a layout" case); the manager at /manage covers every level. ──
function EmptyState({ onNew, onImport, onLoadTemplate }: {
  onNew: () => void; onImport: () => void; onLoadTemplate: (key: string) => void;
}) {
  const [tpls, setTpls] = useState<TemplateMeta[]>([]);
  useEffect(() => { setTpls(listTemplates()); }, []);
  const card: React.CSSProperties = {
    flex: "1 1 220px", minWidth: 220, textAlign: "left", background: T.panel, color: T.text,
    border: `1px solid ${T.border}`, borderRadius: 12, padding: "18px 20px", cursor: "pointer",
  };
  const kicker: React.CSSProperties = { fontSize: 22, marginBottom: 10 };
  const h: React.CSSProperties = { fontSize: 15, fontWeight: 700, margin: "0 0 4px" };
  const sub: React.CSSProperties = { fontSize: 12.5, color: T.dim, lineHeight: 1.5 };
  return (
    <div style={{ maxWidth: 780, margin: "36px auto 0" }}>
      <div style={{ fontSize: 13, color: T.dim, marginBottom: 16 }}>Start a development — pick how:</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <button style={card} onClick={onNew}>
          <div style={kicker}>✎</div>
          <div style={h}>Start a new building</div>
          <div style={sub}>Author from scratch — set the shape, paint unit types, define sizes.</div>
        </button>
        <button style={card} onClick={onImport}>
          <div style={kicker}>⭱</div>
          <div style={h}>Import a project file</div>
          <div style={sub}>Load a developer, complex, or building you exported as JSON.</div>
        </button>
        <div style={{ ...card, cursor: "default" }}>
          <div style={kicker}>▦</div>
          <div style={h}>Start from a template</div>
          {tpls.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {tpls.map((t) => (
                <button key={t.key} onClick={() => onLoadTemplate(t.key)}
                  style={{ ...btn(), justifyContent: "flex-start", textAlign: "left", width: "100%" }}>
                  {t.name} <span style={{ color: T.faint, fontSize: 11, marginLeft: 6 }}>· {t.level}</span>
                </button>
              ))}
            </div>
          ) : (
            <div style={sub}>No saved templates yet. Save one from the Reuse ▾ menu after you build.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── REUSE ▾ menu — THE reuse surface (: not a wall of buttons; the /manage route was
//    retired INTO this menu). Duplicate the active building · export any level as a file · import a file · save a
//    template at any level · load / delete saved templates. The old standalone project-manager page is gone. ──
function ReuseMenu({ onExport, onImport, onSaveTemplate, onLoadTemplate, onDeleteTemplate, onDuplicate }: {
  onExport: (level: EntityLevel) => void;
  onImport: () => void;
  onSaveTemplate: (level: EntityLevel, name: string) => void;
  onLoadTemplate: (key: string) => void;
  onDeleteTemplate: (meta: TemplateMeta) => void;
  onDuplicate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tpls, setTpls] = useState<TemplateMeta[]>([]);
  const refresh = useCallback(() => setTpls(listTemplates()), []);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);
  const item: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent",
    border: 0, color: T.text, padding: "7px 12px", fontSize: 13, cursor: "pointer", borderRadius: 6,
  };
  const label: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em",
    color: T.faint, padding: "8px 12px 3px",
  };
  // Save at a chosen level — one tiny prompt chain keeps the menu flat (no nested submenu to build).
  function doSave() {
    const lvl = (window.prompt("Save a template of which level — type: building · complex · developer", "building") || "").trim().toLowerCase();
    if (lvl !== "building" && lvl !== "complex" && lvl !== "developer") return;
    const name = window.prompt(`Name this ${lvl} template:`);
    if (name) onSaveTemplate(lvl as EntityLevel, name);
  }
  return (
    <div style={{ position: "relative" }}>
      <button style={btn()} onClick={() => setOpen((o) => !o)} aria-expanded={open}>Reuse ▾</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1090 }} />
          <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 1091, minWidth: 240,
            background: T.panel2, border: `1px solid ${T.border}`, borderRadius: 10, padding: "4px 0",
            boxShadow: "0 8px 24px rgba(0,0,0,.45)" }}>
            <button style={item} onClick={() => { setOpen(false); onDuplicate(); }}>⧉ Duplicate active building</button>
            <div style={{ borderTop: `1px solid ${T.borderSoft}`, margin: "4px 0" }} />
            <div style={label}>Export as file</div>
            <button style={item} onClick={() => { setOpen(false); onExport("developer"); }}>Developer…</button>
            <button style={item} onClick={() => { setOpen(false); onExport("complex"); }}>Complex…</button>
            <button style={item} onClick={() => { setOpen(false); onExport("building"); }}>Active building…</button>
            <div style={{ borderTop: `1px solid ${T.borderSoft}`, margin: "4px 0" }} />
            <button style={item} onClick={() => { setOpen(false); onImport(); }}>⭱ Import entity…</button>
            <button style={item} onClick={() => { setOpen(false); doSave(); }}>▦ Save as template…</button>
            {tpls.length > 0 && <div style={label}>Templates</div>}
            {tpls.map((t) => (
              <div key={t.key} style={{ ...item, cursor: "default" }}>
                <button style={{ ...item, padding: "2px 4px", flex: 1 }} onClick={() => { setOpen(false); onLoadTemplate(t.key); }}>
                  {t.name} <span style={{ color: T.faint, fontSize: 11 }}>· {t.level}</span>
                </button>
                <button title="delete this template" style={{ ...btn(), padding: "2px 8px", color: T.danger, borderColor: T.border }}
                  onClick={() => { onDeleteTemplate(t); refresh(); }}>✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── RIGHT PANE: subtype sizes (: "right pane, sizes only") ──────────────────────────────────────
function SubtypeSizesPane({ types, typesPatch, onAddType, onRemoveType }: {
  types: AuthoringType[];
  typesPatch: (next: AuthoringType[]) => void;
  onAddType: () => void;
  onRemoveType: (typeKey: string) => void;
}) {
  const canRemoveType = types.length > 1;
  return (
    <aside style={{ width: 300, flex: "0 0 300px", borderLeft: `1px solid ${T.border}`, overflowY: "auto", background: T.panel, padding: "16px 14px 24px" }}>
      <div style={step}>3 · Unit types &amp; sizes</div>
      <div style={{ color: T.faint, fontSize: 11.5, marginBottom: 14 }}>the TYPE vocabulary (what you paint) + each type's layouts (A/B/C…) sized in m². The palette, grid &amp; pricing read these live. Max {MAX_SUBTYPES} subtypes per type.</div>
      {types.map((t) => {
        const isCore = t.kind === "core";
        return (
          <div key={t.key} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: typeColor(t.key), display: "inline-block" }} />
              <input value={t.label} aria-label={`${t.label} type name`}
                onChange={(e) => typesPatch(types.map((x) => (x.key === t.key ? { ...x, label: e.target.value } : x)))}
                style={{ ...inp(), marginTop: 0, padding: "2px 6px", fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0 }} />
              {isCore && <span style={{ color: T.faint, fontSize: 10.5 }}>core</span>}
              <button title={canRemoveType ? `remove the "${t.label}" type (clears its painted cells)` : "a building keeps at least one type"}
                disabled={!canRemoveType}
                onClick={() => onRemoveType(t.key)}
                style={{ ...chipBtn, padding: "1px 7px", fontSize: 12, borderColor: T.border, color: canRemoveType ? T.danger : T.faint, opacity: canRemoveType ? 1 : 0.4 }}>✕ type</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
              <span style={{ color: T.faint, fontSize: 11 }}>layouts</span>
              <button title={t.subtypes.length >= MAX_SUBTYPES ? `max ${MAX_SUBTYPES}` : "add a subtype"}
                disabled={t.subtypes.length >= MAX_SUBTYPES}
                onClick={() => typesPatch(addSubtype(types, t.key))}
                style={{ ...chipBtn, marginLeft: "auto", padding: "1px 8px", fontSize: 12, borderColor: T.border, color: t.subtypes.length >= MAX_SUBTYPES ? T.faint : T.text, opacity: t.subtypes.length >= MAX_SUBTYPES ? 0.5 : 1 }}>+ subtype</button>
            </div>
            {t.subtypes.map((s) => (
              <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.dim, width: 18, textAlign: "center", border: `1px solid ${T.borderSoft}`, borderRadius: 4, padding: "2px 0" }}>{s.key.toUpperCase()}</span>
                <input value={s.label ?? ""} placeholder={`Type ${s.key.toUpperCase()}`}
                  onChange={(e) => typesPatch(patchSubtype(types, t.key, s.key, { label: e.target.value }))}
                  style={{ ...inp(), flex: 1, marginTop: 0, padding: "4px 7px", fontSize: 12 }} />
                <div style={{ position: "relative", width: 68 }}>
                  <input type="number" min={0} value={s.sqm ?? ""} placeholder={String(t.sqm)}
                    onChange={(e) => typesPatch(patchSubtype(types, t.key, s.key, { sqm: e.target.value === "" ? undefined : Math.max(0, +e.target.value || 0) }))}
                    style={{ ...inp(), width: "100%", marginTop: 0, padding: "4px 18px 4px 7px", fontSize: 12 }} />
                  <span style={{ position: "absolute", right: 6, top: 6, color: T.faint, fontSize: 10 }}>m²</span>
                </div>
                <button title={t.subtypes.length <= 1 ? "a type keeps at least one layout" : "remove"}
                  disabled={t.subtypes.length <= 1}
                  onClick={() => typesPatch(removeSubtype(types, t.key, s.key))}
                  style={{ ...chipBtn, padding: "1px 7px", fontSize: 12, borderColor: T.border, color: t.subtypes.length <= 1 ? T.faint : T.danger, opacity: t.subtypes.length <= 1 ? 0.4 : 1 }}>×</button>
              </div>
            ))}
          </div>
        );
      })}
      <button title={types.length >= MAX_TYPES ? `max ${MAX_TYPES} types` : "add a new unit type to the palette"}
        disabled={types.length >= MAX_TYPES}
        onClick={onAddType}
        style={{ ...chipBtn, width: "100%", marginTop: 4, padding: "6px 8px", fontSize: 12.5, borderColor: T.border, borderStyle: "dashed", color: types.length >= MAX_TYPES ? T.faint : T.text, opacity: types.length >= MAX_TYPES ? 0.5 : 1 }}>
        + add type
      </button>
    </aside>
  );
}

// ── the flat folder tree ──
function Tree({ pack, sel, setSel }: { pack: Pack; sel: Sel; setSel: (s: Sel) => void }) {
  const b = pack.buildings[0];
  const units = b ? pack.buildingUnits[b.id] || [] : [];
  const floors = [...new Set(units.map((u) => u.floor))].sort((a, b) => b - a);
  const groups = groupByType(units);

  const row = (depth: number, label: string, active: boolean, onClick: () => void, meta?: string, glyph = "▸", key?: string) => (
    <div key={key} onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", paddingLeft: 10 + depth * 14,
      cursor: "pointer", fontSize: 13, borderRadius: 6, margin: "1px 6px",
      background: active ? T.accent : "transparent", color: active ? "#fff" : T.text,
    }}>
      <span style={{ color: active ? "#fff" : T.faint, fontSize: 10, width: 10 }}>{glyph}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {meta && <span style={{ marginLeft: "auto", color: active ? "#ffffffcc" : T.faint, fontSize: 11, fontFamily: T.mono }}>{meta}</span>}
    </div>
  );

  return (
    <nav style={{ width: 320, flex: "0 0 320px", borderRight: `1px solid ${T.border}`, overflowY: "auto", background: T.panel, paddingBottom: 20 }}>
      <div style={sectionHdr}>Entity tree</div>
      {row(0, `🏢 ${pack.developer.name}`, sel.kind === "developer", () => setSel({ kind: "developer" }), "DEV", "▾")}
      {pack.complexes.map((cx) => (
        <div key={cx.id}>
          {row(1, `📁 ${cx.name}`, sel.kind === "complex" && sel.id === cx.id, () => setSel({ kind: "complex", id: cx.id }), undefined, "▾")}
          {b && (
            <>
              {row(2, `🏗 ${b.name}`, sel.kind === "building" && sel.id === b.id, () => setSel({ kind: "building", id: b.id }), String(units.length), "▾")}
              {floors.map((f) => (
                <div key={f}>
                  {row(3, `Floor ${f}`, sel.kind === "floor" && sel.floor === f, () => setSel({ kind: "floor", buildingId: b.id, floor: f }), `${units.filter((u) => u.floor === f).length}u`)}
                </div>
              ))}
              <div style={{ ...sectionHdr, paddingLeft: 24 }}>Unit types</div>
              {groups.map((g) => (
                <div key={g.typeKey}>
                  {row(3, `${g.label}`, sel.kind === "group" && sel.typeKey === g.typeKey, () => setSel({ kind: "group", buildingId: b.id, typeKey: g.typeKey }), `(${g.variations.map((v) => v.key).join("·")})`, "▾")}
                  {g.variations.map((v) => (
                    row(4, `${g.label} ${v.key}`, sel.kind === "variation" && sel.typeKey === g.typeKey && sel.variationKey === v.key,
                      () => setSel({ kind: "variation", buildingId: b.id, typeKey: g.typeKey, variationKey: v.key }), `${v.count}u · ${v.sqm}m²`, "·", `${g.typeKey}-${v.key}`)
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      ))}
      <div style={{ color: T.faint, fontSize: 11.5, padding: "12px 16px" }}>{pack.buildings.length} building · {totalUnits(pack)} units</div>
    </nav>
  );
}

// ── the floor-plan ENGINE wired into the detail pane (the design docs step 5) ──
// The engine (subdivide.ts) is METRES in → tessellating cells + corridor + door pins out. It wants a floor
// POLYGON in metres; the generated pack stores only a schematic even grid, so we synthesize an illustration
// plate from the floor's REAL unit mix: area = Σ(unit sqm) ÷ an efficiency allowance (the rest is corridor),
// aspect ~4:3 like the building footprint. Then seedsFromAi(mix) → subdivideFloor draws the real plan. This is
// DEMO/MARKETING-grade (same honest posture as the engine) — not surveyed architecture.

const EFFICIENCY = 0.82;            // sellable fraction of the plate; the residual is the corridor
const PLATE_ASPECT = 4 / 3;         // plate width:height (matches the ~0.7 building footprint look)

/**
 * A pure floor plan for one floor: run the real unit mix through the subdivision engine, HONORING the user's
 * saved LAYOUT (per-unit along-axis nudges) if one exists for this floor. The unit `id` used for the mix
 * is the same one the layout offsets key on (unitNumber), so a nudge saved in the layout shifts that unit's pin.
 */
function planForFloor(units: Unit[], layout?: FloorLayout): { result: SubdivideResult; mix: MixUnit[] } | null {
  const fus = units.filter((u) => u.sqm > 0);
  if (fus.length === 0) return null;
  const mix: MixUnit[] = fus.map((u, i) => ({
    typeKey: u.type,
    variationKey: (u.subtype || "").trim() || undefined,
    targetSqm: u.sqm,
    id: unitPlanId(u, i),
  }));
  // synthesize a plate: gross = sellable ÷ efficiency; a 4:3 bbox around that area.
  const sellableSqm = fus.reduce((a, u) => a + u.sqm, 0);
  const grossSqm = sellableSqm / EFFICIENCY;
  const h = Math.sqrt(grossSqm / PLATE_ASPECT);
  const w = grossSqm / h;
  const plate = { x: 0, y: 0, w, h };
  const floorPoly: Pt[] = [
    { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
  ];
  // corridor width from the residual: band area ≈ (1−eff)·gross over the long axis.
  const longAxis = Math.max(w, h);
  const corridorWidthM = Math.max(1.2, ((1 - EFFICIENCY) * grossSqm) / longAxis);
  // auto pins from the mix, then apply the user's saved along-axis nudges (if any) before subdividing.
  const seeds = applyLayoutToSeeds(seedsFromAi(plate, mix), layout, plate);
  const result = subdivideFloor({ floorPoly, seeds, corridorWidthM });
  return { result, mix };
}

/** The stable per-unit id the plan + the layout share (so a saved offset finds its unit). PURE. */
function unitPlanId(u: Unit, i: number): string {
  return String(u.unitNumber ?? `${u.type}-${i + 1}`);
}

/** Draw a SubdivideResult as an SVG: unit polys (coloured by type), the corridor band, door pins. A unit is
 *  HIGHLIGHTED when its variationKey matches `highlightVar` (+ typeKey) — used in the variation detail.
 * When `onNudge` is set, each cell carries ◀ ▶ handles that shift that unit ALONG the floor axis: the
 *  handle calls onNudge(unitId, ±stepM) and the parent persists the offset into the floor LAYOUT. Width is NOT
 *  touched — the user moves WHERE a unit sits, its size still sets its width. */
function FloorPlanSvg({ result, highlightType, highlightVar, maxW = 520, onNudge }: {
  result: SubdivideResult; highlightType?: string; highlightVar?: string; maxW?: number;
  onNudge?: (unitId: string, deltaM: number) => void;
}) {
  const { plate, units, corridor } = result;
  if (!(plate.w > 0) || !(plate.h > 0)) return null;
  const pad = 14;
  const scale = (maxW - pad * 2) / plate.w;          // metres → px off the plate width
  const W = maxW;
  const H = plate.h * scale + pad * 2;
  const toPx = (p: Pt) => `${pad + (p.x - plate.x) * scale},${pad + (p.y - plate.y) * scale}`;
  const ring = (pts: Pt[]) => pts.map(toPx).join(" ");
  const hv = (highlightVar || "").toLowerCase();
  // the corridor runs along the plate's LONG axis (same rule as the engine); nudges move units along it.
  const horizontal = plate.w >= plate.h;
  // one nudge step ≈ 4% of the axis length (min 0.4 m) — fine enough to arrange, coarse enough to click.
  const stepM = Math.max(0.4, (horizontal ? plate.w : plate.h) * 0.04);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, display: "block" }}>
      {/* plate outline */}
      <polygon points={ring([{ x: plate.x, y: plate.y }, { x: plate.x + plate.w, y: plate.y }, { x: plate.x + plate.w, y: plate.y + plate.h }, { x: plate.x, y: plate.y + plate.h }])}
        fill="none" stroke={T.border} strokeWidth={1.5} />
      {/* corridor band */}
      {corridor.length >= 3 && <polygon points={ring(corridor)} fill={`${T.accent}22`} stroke={`${T.accent}66`} strokeWidth={1} />}
      {/* unit cells */}
      {units.map((u, i) => {
        const col = typeColor(u.typeKey || "");
        const on = !highlightType
          ? true
          : u.typeKey === highlightType && (!hv || (u.variationKey || "").toLowerCase() === hv);
        const cx = u.poly.reduce((s, p) => s + p.x, 0) / u.poly.length;
        const cy = u.poly.reduce((s, p) => s + p.y, 0) / u.poly.length;
        const cxPx = pad + (cx - plate.x) * scale;
        const cyPx = pad + (cy - plate.y) * scale;
        return (
          <g key={i} opacity={on ? 1 : 0.28}>
            <polygon points={ring(u.poly)} fill={`${col}${on ? "55" : "33"}`} stroke={col} strokeWidth={on ? 1.8 : 1} />
            <text x={cxPx} y={cyPx} fill={T.text} fontSize={10}
              textAnchor="middle" dominantBaseline="middle" style={{ fontFamily: T.mono, pointerEvents: "none" }}>
              {(u.typeKey || "").toUpperCase()}{u.variationKey ? ` ${u.variationKey}` : ""}
            </text>
            {/* along-axis NUDGE handles — only when editable + the unit has an id to key the offset on */}
            {onNudge && on && u.id && (
              <NudgeHandles cx={cxPx} cy={cyPx} unitId={u.id} stepM={stepM} onNudge={onNudge} />
            )}
          </g>
        );
      })}
      {/* door pins (on the corridor edge) */}
      {units.map((u, i) => {
        const [x, y] = toPx(u.doorAt).split(",").map(Number);
        return <circle key={`d${i}`} cx={x} cy={y} r={2.6} fill={T.vetted} stroke={T.bg} strokeWidth={0.8} />;
      })}
    </svg>
  );
}

/** The ◀ ▶ along-axis nudge handles for one unit cell. ◀ = toward the near end, ▶ = toward the far end.
 *  Rendered just under the cell's label; clicking shifts the unit's pin by ±stepM metres on the next subdivide. */
function NudgeHandles({ cx, cy, unitId, stepM, onNudge }: {
  cx: number; cy: number; unitId: string; stepM: number; onNudge: (unitId: string, deltaM: number) => void;
}) {
  const gap = 11;
  const btn = (dx: number, label: string, delta: number) => (
    <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onNudge(unitId, delta); }}>
      <circle cx={cx + dx} cy={cy + 13} r={7} fill={T.panel2} stroke={T.accent} strokeWidth={1} />
      <text x={cx + dx} y={cy + 13} fill={T.accent} fontSize={11} fontWeight={700}
        textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none", userSelect: "none" }}>{label}</text>
    </g>
  );
  return (<>{btn(-gap, "‹", -stepM)}{btn(gap, "›", stepM)}</>);
}

/** A compact invariant readout under the plan (Σ units + walkway = floor). */
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

// ── the detail pane ──
function Detail({ pack, sel, setPack }: { pack: Pack; sel: Sel; setPack: (p: Pack) => void }) {
  const b = pack.buildings[0];
  const units = b ? pack.buildingUnits[b.id] || [] : [];
  let title = "", lines: [string, string][] = [];
  // the floor-plan to draw + what to highlight (set in the floor/variation cases below)
  let planFloor: number | null = null;
  let planHl: { type?: string; variation?: string } = {};

  if (sel.kind === "developer") {
    title = pack.developer.name;
    lines = [
      ["Role", "Developer (root — all VRX developer detail)"],
      ["NEAR account", pack.developer.nearAccount || "—"],
      ["Holding company", pack.developer.holdingCompany || "—"],
      ["Companies", pack.companies.map((c) => c.name).join(", ") || "—"],
      ["Projects", pack.complexes.map((c) => c.name).join(", ") || "—"],
    ];
  } else if (sel.kind === "complex") {
    const cx = pack.complexes.find((c) => c.id === sel.id);
    title = cx?.name || "Project";
    lines = [["Area", cx?.area || "—"], ["Amenities", (cx?.amenities || []).join(", ") || "—"], ["Buildings", (cx?.buildings || []).join(", ")]];
  } else if (sel.kind === "building" && b) {
    title = b.name;
    lines = [["Type", b.type], ["Floors", String(b.stories)], ["Units", String(units.length)], ["Area", b.area || "—"], ["Tagline", b.tagline || "—"]];
  } else if (sel.kind === "floor" && b) {
    const fus = units.filter((u) => u.floor === sel.floor);
    title = `Floor ${sel.floor}`;
    lines = [["Units on floor", String(fus.length)], ["Types", [...new Set(fus.map((u) => u.type))].join(", ")], ["Σ area", `${Math.round(fus.reduce((a, u) => a + u.sqm, 0))} m²`]];
    planFloor = sel.floor; // draw the whole floor's subdivision
  } else if (sel.kind === "group" && b) {
    const gu = units.filter((u) => u.type === sel.typeKey);
    title = (b.unitTypes || []).find((t) => t.key === sel.typeKey)?.label || sel.typeKey.toUpperCase();
    lines = [["Units", String(gu.length)], ["Variations", [...new Set(gu.map((u) => u.subtype || "Standard"))].join(", ")],
      ["Size range", `${Math.min(...gu.map((u) => u.sqm))}–${Math.max(...gu.map((u) => u.sqm))} m²`]];
  } else if (sel.kind === "variation" && b) {
    const vu = units.filter((u) => u.type === sel.typeKey && (u.subtype || "").toLowerCase().includes(sel.variationKey.toLowerCase()));
    const sample = vu[0];
    title = `${(b.unitTypes || []).find((t) => t.key === sel.typeKey)?.label || sel.typeKey.toUpperCase()} · ${sel.variationKey}`;
    lines = [["Units", String(vu.length)], ["Layout area", sample ? `${sample.sqm} m²` : "—"], ["View", sample?.view || "—"],
      ["Note", "Highlighted in the floor plan below · furniture pack attaches to this variation (next slice)."]];
    // draw the lowest floor that carries this variation, highlighting its cells
    if (vu.length) {
      planFloor = Math.min(...vu.map((u) => u.floor));
      planHl = { type: sel.typeKey, variation: sel.variationKey };
    }
  }

  // the chosen floor's units + its saved LAYOUT — keyed by the floor's signature so identical floors
  // share one arrangement. The plan HONORS the layout; the nudge handles write new offsets back into the pack.
  const floorUnits = planFloor != null ? units.filter((u) => u.floor === planFloor) : [];
  const sig = planFloor != null ? floorSignature(floorUnits) : "";
  const layout = planFloor != null ? layoutForFloor(pack.floorLayouts, floorUnits) : undefined;
  const nudged = !!layout && Object.keys(layout.offsets || {}).length > 0;
  const plan = planFloor != null ? planForFloor(floorUnits, layout) : null;

  // persist a nudge: add the delta to the unit's saved along-axis offset under this floor's signature.
  function nudge(unitId: string, deltaM: number) {
    const cur = pack.floorLayouts?.[sig]?.offsets[unitId] ?? 0;
    setPack({ ...pack, floorLayouts: setUnitOffset(pack.floorLayouts, sig, unitId, cur + deltaM) });
  }
  function resetArrangement() {
    setPack({ ...pack, floorLayouts: clearFloorLayout(pack.floorLayouts, sig) });
  }

  return (
    <main style={{ flex: 1, overflowY: "auto", padding: "26px 32px" }}>
      <div style={{ color: T.faint, fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".06em" }}>{sel.kind}</div>
      <h1 style={{ fontSize: 22, margin: "2px 0 18px" }}>{title}</h1>
      <div style={{ ...card(), maxWidth: 560 }}>
        {lines.map(([k, v], i) => (
          <div key={i} style={{ display: "flex", padding: "7px 0", borderBottom: i < lines.length - 1 ? `1px solid ${T.borderSoft}` : "none", fontSize: 13.5 }}>
            <span style={{ color: T.dim, width: 150, flex: "0 0 150px" }}>{k}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>

      {/* FLOOR PLAN — the subdivision engine drawn as an SVG (floor / variation selections) */}
      {plan && (
        <div style={{ marginTop: 22, maxWidth: 560 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
            <div style={step}>Floor plan</div>
            <span style={{ color: T.faint, fontSize: 11.5 }}>
              Floor {planFloor} · subdivision engine · {planHl.variation ? `${(planHl.type || "").toUpperCase()} ${planHl.variation} highlighted` : "all units"}
            </span>
            {nudged && (
              <button onClick={resetArrangement} title="clear the saved arrangement for this floor shape"
                style={{ ...chipBtn, marginLeft: "auto", padding: "2px 8px", fontSize: 11, borderColor: T.border, color: T.dim }}>↺ reset arrangement</button>
            )}
          </div>
          <FloorPlanSvg result={plan.result} highlightType={planHl.type} highlightVar={planHl.variation} maxW={560} onNudge={nudge} />
          <PlanInvariant result={plan.result} />
          <div style={{ color: T.faint, fontSize: 11, marginTop: 6 }}>
            Illustration-grade (slab-and-slice, door-pin seeded) — demo/marketing, not surveyed. Door pins in <span style={{ color: T.vetted }}>●</span> sit on the corridor.
            <br />Use the <span style={{ color: T.accent }}>‹ ›</span> handles to arrange units left/right along the floor — saved with the pack{nudged ? " ✓ arranged" : ""} (width stays set by unit size).
          </div>
        </div>
      )}
    </main>
  );
}

// ── helpers ──
function groupByType(units: Unit[]): { typeKey: string; label: string; variations: { key: string; count: number; sqm: number }[] }[] {
  const byType = new Map<string, Unit[]>();
  for (const u of units) {
    const k = u.type;
    (byType.get(k) ?? byType.set(k, []).get(k)!).push(u);
  }
  return [...byType.entries()].map(([typeKey, us]) => {
    const byVar = new Map<string, Unit[]>();
    for (const u of us) {
      const v = (u.subtype || "Standard").trim();
      (byVar.get(v) ?? byVar.set(v, []).get(v)!).push(u);
    }
    return {
      typeKey,
      label: typeKey.toUpperCase(),
      variations: [...byVar.entries()].map(([key, vu]) => ({ key, count: vu.length, sqm: vu[0]?.sqm ?? 0 })).sort((a, b) => a.key.localeCompare(b.key)),
    };
  }).sort((a, b) => a.typeKey.localeCompare(b.typeKey));
}

function errText(code: string): string {
  if (code === "parse_failed") return "Couldn't parse the AI reply — add more detail or use the form only.";
  if (code === "upstream") return "AI service unavailable — using the form only works too.";
  return "Generation issue — the form-only build still works.";
}

// ── styles ──
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };
const sectionHdr: React.CSSProperties = { color: T.faint, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".1em", padding: "14px 16px 5px" };
const step: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.accent, marginBottom: 12 };
const chipBtn: React.CSSProperties = { border: "1px solid", borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "transparent" };
function card(): React.CSSProperties { return { background: T.panel, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }; }
function inp(): React.CSSProperties { return { width: "100%", boxSizing: "border-box", background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 7, color: T.text, padding: "7px 10px", fontSize: 13.5, marginTop: 3 }; }
function btn(bg?: string): React.CSSProperties {
  return { background: bg || T.panel2, color: bg ? "#fff" : T.text, border: `1px solid ${bg || T.border}`, borderRadius: 7, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontWeight: 500 };
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12.5, color: T.text, fontWeight: 500 }}>
        {label} {hint && <span style={{ color: T.faint, fontWeight: 400 }}>· {hint}</span>}
      </label>
      {children}
    </div>
  );
}
