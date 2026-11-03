"use client";

// The center editor — "one logical frame" that re-focuses on whatever the tree selected. Each entity is a
// form bound to usePack setters (immutable). Inheritance shown read-only (a building echoes its complex/dev).
// Units get their own grid+import surface (UnitsEditor). Law #1: never blocks; law #2: partial is fine.

import { useRef, useState } from "react";
import type { PackApi } from "./usePack";
import { Field, ListInput, NumberInput, SelectInput, TextArea, TextInput } from "./fields";
import { UnitsEditor } from "./UnitsEditor";
import { MediaCard } from "./MediaCard";
import { slugify, type UnitType } from "@/lib/pack";
import type { AiUnitSubtype } from "@/lib/ai-build";

export function Editor({ api }: { api: PackApi }) {
  const { pack, selection } = api;

  switch (selection.kind) {
    case "developer":
      return <DeveloperForm api={api} />;
    case "company": {
      const c = pack.companies.find((x) => x.id === selection.id);
      if (!c) return <Missing what="company" />;
      return <CompanyForm api={api} id={c.id} />;
    }
    case "complex": {
      const cx = pack.complexes.find((x) => x.id === selection.id);
      if (!cx) return <Missing what="complex" />;
      return <ComplexForm api={api} id={cx.id} />;
    }
    case "building": {
      const b = pack.buildings.find((x) => x.id === selection.id);
      if (!b) return <Missing what="building" />;
      return <BuildingForm api={api} id={b.id} />;
    }
    case "units":
      return <UnitsEditor api={api} buildingId={selection.buildingId} />;
    case "terms": {
      const t = pack.terms.find((x) => x.id === selection.id);
      if (!t) return <Missing what="terms" />;
      return <TermsForm api={api} id={t.id} />;
    }
    case "texts":
      return <TextsForm api={api} />;
  }
}

// Shown when a selection's id isn't (yet) resolvable in the projected pack. In the store-backed shell this is a
// TRANSIENT state: a just-added entity is selected in the same tick it's created, one render before the store's
// re-projection includes it — so the entity is about to appear, not gone. (A genuinely-deleted entity never stays
// selected: every delete handler re-selects the developer.) So render a quiet "loading" placeholder, not an
// alarming "no longer exists" — the latter flashed for one frame on every Add-company/Add-building (S264b nit).
function Missing({ what }: { what: string }) {
  return <div className="mm-empty" style={{ opacity: 0.6 }}>Loading {what}…</div>;
}

// Themed style for the raw unit-type grid inputs (fix: they had no color/background → black-on-dark /
// inconsistent styling in screenshot 2). Matches the themed TextInput look via the CSS vars.
function typeInput(width: number, mono = false): React.CSSProperties {
  return {
    width, color: "var(--ink)", background: "var(--bg)", border: "1px solid var(--line)",
    borderRadius: 6, padding: "4px 7px", fontSize: 13,
    fontFamily: mono ? "var(--mono)" : "inherit",
  };
}

// Each TYPE gets a distinct FLAG: a two-colour GEOMETRY (an outer shape + a different inner shape, e.g.
// ONE shape only: a BORDERED BOX. A type = a border colour + an inner fill colour (the two cycle by type index so
// every type reads distinct); the subtype carries its letter (A/B/C) inside the box. Shown on the layout-row paint
// selector AND the grid cells, so palette and grid read as one. (: simplified from the old multi-shape flags.)
interface TypeFlagSpec { border: string; fill: string; borderStyle: "solid" | "double" | "dashed" | "dotted"; radiusStep: number; }
// Categorical flag palette. A hand-picked set of 14 full flag specs (chose these from a 100-combo
// preview). Each spec is a complete look — border colour + fill colour + border texture + stepped corner — so every
// type is distinct on multiple axes at once, not just hue. Types index into this list in order; it wraps past 14.
const FLAG_SPECS: TypeFlagSpec[] = [
  { border: "royalblue",   fill: "yellow",      borderStyle: "dashed", radiusStep: 0 },
  { border: "chocolate",   fill: "lime",        borderStyle: "dashed", radiusStep: 2 },
  { border: "yellow",      fill: "plum",        borderStyle: "dotted", radiusStep: 1 },
  { border: "purple",      fill: "fuchsia",     borderStyle: "dotted", radiusStep: 2 },
  { border: "seagreen",    fill: "chartreuse",  borderStyle: "dotted", radiusStep: 2 },
  { border: "seagreen",    fill: "aqua",        borderStyle: "dashed", radiusStep: 2 },
  { border: "orangered",   fill: "deepskyblue", borderStyle: "solid",  radiusStep: 1 },
  { border: "indigo",      fill: "deepskyblue", borderStyle: "dotted", radiusStep: 1 },
  { border: "darkviolet",  fill: "khaki",       borderStyle: "solid",  radiusStep: 1 },
  { border: "black",       fill: "hotpink",     borderStyle: "dashed", radiusStep: 0 },
  { border: "saddlebrown", fill: "lime",        borderStyle: "dotted", radiusStep: 0 },
  { border: "crimson",     fill: "yellow",      borderStyle: "double", radiusStep: 0 },
  { border: "orangered",   fill: "limegreen",   borderStyle: "solid",  radiusStep: 0 },
  { border: "white",       fill: "blueviolet",  borderStyle: "solid",  radiusStep: 0 },
];
/** A type is CORE (public space — elevator/lobby/gym…) if flagged kind:"core", or the legacy "elevator"/"public" key. */
const isCoreType = (t?: { key: string; kind?: string }) => !!t && (t.kind === "core" || t.key === "elevator" || t.key === "public");
/** The stable flag spec for a TYPE, by its index in the palette. Cores (public space) get a neutral grey box. */
function flagForType(types: UnitType[], typeKey: string): TypeFlagSpec {
  const self = types.find((t) => t.key === typeKey);
  if (isCoreType(self)) return { border: "#475569", fill: "#94a3b8", borderStyle: "solid", radiusStep: 1 };
  const i = Math.max(0, types.filter((t) => !isCoreType(t)).findIndex((t) => t.key === typeKey));
  return FLAG_SPECS[i % FLAG_SPECS.length];
}
const paintKey = (typeKey: string, subKey: string) => `${typeKey}/${subKey || "a"}`;

/** A type's bordered-box FLAG (border colour + inner fill) with the subtype letter. `size` px square. */
function TypeFlag({ spec, letter, size = 20 }: { spec: TypeFlagSpec; letter: string; size?: number }) {
  // double/dashed/dotted need a thicker border to read; solid stays slim.
  const bw = Math.max(spec.borderStyle === "solid" ? 2 : 3, Math.round(size * (spec.borderStyle === "solid" ? 0.14 : 0.2)));
  return (
    <div aria-hidden style={{
      width: size, height: size, flex: "0 0 auto", boxSizing: "border-box",
      border: `${bw}px ${spec.borderStyle} ${spec.border}`, background: spec.fill,
      borderRadius: [1, Math.round(size * 0.18), Math.round(size * 0.38)][spec.radiusStep] ?? 2,
      display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
      fontSize: size * 0.5, fontWeight: 800, color: "#fff",
      // white letter with a dark outline so it reads on any bright named fill.
      textShadow: "0 0 1px #000, 0 1px 1px #000", WebkitTextStroke: `${Math.max(0.5, size * 0.03)}px #000`,
    }}>{letter}</div>
  );
}

// UNIFIED: unit types & layouts + the paint grid in ONE section. The layouts you define ARE the paint
// palette — pick any layout (each has its own colour/flag) and place it in the grid below. Sizes derive the type
// range; painted cells become the building's real units (store matrix → projection).
function UnitTypesAndGrid({ api, buildingId, types, editType }: {
  api: PackApi; buildingId: string; types: UnitType[];
  editType: (i: number, patch: Partial<UnitType>) => void;
}) {
  const matrix = api.unitMatrix(buildingId);
  const floors = matrix.length;
  const perFloor = matrix[0]?.length ?? 0;
  const flagOf = (typeKey: string) => flagForType(types, typeKey);

  // the active paint target (a type+layout). Default to the first non-core layout.
  const firstPaint = (() => {
    for (const t of types) { if (isCoreType(t)) continue; const s = (t.subtypes?.[0]?.key) || "a"; return { typeKey: t.key, subtypeKey: s }; }
    return { typeKey: "", subtypeKey: "a" };
  })();
  const [paint, setPaint] = useState<{ typeKey: string; subtypeKey: string }>(firstPaint);
  const painted = matrix.reduce((n, row) => n + row.filter((c) => c && c.typeKey).length, 0);

  // a type's vertical SPAN (floors it occupies). span 2 = a DUPLEX: one atomic unit over two floors.
  const spanOf = (typeKey: string) => Math.max(1, types.find((t) => t.key === typeKey)?.span ?? 1);
  const paintSpan = spanOf(paint.typeKey);

  // click-DRAG painting: mousedown on a cell decides the action (place vs clear) from that first cell, then dragging
  // over more cells applies the SAME action. A ref holds the drag mode so mouseenter handlers don't re-render-thrash.
  const dragRef = useRef<null | "place" | "clear">(null);
  // Clear a cell AND, if it's part of a duplex (span>1), its linked continuation/lower cell — a duplex is atomic.
  const clearCellAndLink = (grid: typeof matrix, f: number, u: number) => {
    const c = grid[f]?.[u];
    if (!c || !c.typeKey) { if (grid[f]) grid[f][u] = { typeKey: "", subtypeKey: "" }; return; }
    const span = spanOf(c.typeKey);
    // find the LOWER (anchor) floor: a continuation cell sits above its anchor.
    const base = c.cont ? f - 1 : f;
    for (let d = 0; d < Math.max(1, span); d++) { if (grid[base + d]) grid[base + d][u] = { typeKey: "", subtypeKey: "" }; }
  };
  const applyCell = (f: number, u: number, mode: "place" | "clear") => {
    const next = matrix.map((row) => row.slice());
    if (mode === "clear") {
      clearCellAndLink(next, f, u);
    } else if (paintSpan >= 2) {
      // DUPLEX: place the lower cell + a continuation on the floor above. Block on the top floor (no floor above).
      if (f + paintSpan - 1 >= floors) return; // can't fit — ignore (top-floor duplex blocked)
      next[f][u] = { ...paint };
      for (let d = 1; d < paintSpan; d++) next[f + d][u] = { ...paint, cont: true };
    } else {
      next[f][u] = { ...paint };
    }
    api.setUnitMatrix(buildingId, next);
  };
  const startPaint = (f: number, u: number) => {
    const cur = matrix[f]?.[u];
    // first cell toggles: if it already holds the paint target → we're CLEARing; else PLACEing.
    const mode: "place" | "clear" = cur && cur.typeKey === paint.typeKey && cur.subtypeKey === paint.subtypeKey ? "clear" : "place";
    dragRef.current = mode;
    applyCell(f, u, mode);
  };
  const dragOver = (f: number, u: number) => { if (dragRef.current) applyCell(f, u, dragRef.current); };
  const endPaint = () => { dragRef.current = null; };
  // fill helpers: a DUPLEX can't tile a whole floor/column cleanly, so these place single cells (span-1 only).
  const fillFloor = (f: number) => {
    if (paintSpan >= 2) return; // a duplex isn't a floor-fill shape
    const next = matrix.map((r) => r.slice()); next[f] = next[f].map(() => ({ ...paint })); api.setUnitMatrix(buildingId, next);
  };
  const fillColumn = (u: number) => {
    if (paintSpan >= 2) return;
    const next = matrix.map((r) => r.slice()); for (let f = 0; f < next.length; f++) next[f][u] = { ...paint }; api.setUnitMatrix(buildingId, next);
  };

  // Shape change (floors / units-per-floor). GROW is free. A SHRINK that would delete PAINTED cells asks first —
  // confirm = drop them, cancel = leave the shape as-is (no silent loss). (: warn+confirm, never silent).
  const requestShape = (shape: { floors?: number; unitsPerFloor?: number }) => {
    const nextFloors = shape.floors ?? floors;
    const nextPerFloor = shape.unitsPerFloor ?? perFloor;
    // count PAINTED cells that fall outside the new bounds (these are what resizeGrid would discard)
    let lost = 0;
    for (let f = 0; f < matrix.length; f++) {
      for (let u = 0; u < (matrix[f]?.length ?? 0); u++) {
        if (matrix[f][u]?.typeKey && (f >= nextFloors || u >= nextPerFloor)) lost++;
      }
    }
    if (lost > 0) {
      const ok = window.confirm(`This smaller layout removes ${lost} painted cell${lost > 1 ? "s" : ""} (the units outside the new size). This can't be undone.\n\nShrink and remove them?`);
      if (!ok) return; // cancel → leave the shape unchanged (the input re-reads the store value on next render)
    }
    api.setGridShape(buildingId, shape);
  };

  return (
    <div className="mm-card">
      <h3>Unit types &amp; layouts <span style={{ color: "var(--ink-dim)", fontWeight: 400, fontSize: 12 }}>({types.length} types · {painted} of {floors * perFloor} cells placed)</span></h3>
      <p style={{ color: "var(--ink-dim)", fontSize: 12, marginTop: -6 }}>
        A <b>type</b> is a category; its <b>layouts</b> (A/B/C) are the real units — each its own size &amp; colour.
        Click a layout to select it, then paint it into the grid (floor × position). Click a placed cell to clear it.
      </p>

      {/* 3-column type editors; each layout row is a PAINT selector with its colour flag */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
        {types.map((t, i) => (
          <UnitTypeEditor
            key={i}
            type={t}
            flagOf={flagOf}
            paint={paint}
            setPaint={setPaint}
            onRename={(label) => editType(i, { label })}
            onRekey={(key) => editType(i, { key })}
            onRemoveType={() => api.setUnitTypes(buildingId, types.filter((_, j) => j !== i))}
            onSubtypes={(subs) => api.setUnitSubtypes(buildingId, t.key, subs)}
            canRemoveType={types.length > 1}
          />
        ))}
      </div>
      <div className="mm-btn-row" style={{ marginTop: 10, marginBottom: 14 }}>
        <button className="mm-btn" onClick={() => api.setUnitTypes(buildingId, [...types, { key: uniqueTypeKey(types), label: "New type", sqmMin: 40, sqmMax: 40 }])}>+ Unit type</button>
        <button className="mm-btn" onClick={() => api.select({ kind: "units", buildingId })}>Edit units (spreadsheet) →</button>
      </div>

      {/* shape controls + the grid */}
      <div style={{ display: "flex", gap: 14, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Floors<br />
          <input type="number" min={1} value={floors} style={typeInput(80)} onChange={(e) => requestShape({ floors: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Units / floor<br />
          <input type="number" min={1} value={perFloor} style={typeInput(80)} onChange={(e) => requestShape({ unitsPerFloor: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <span style={{ fontSize: 12, color: "var(--ink-dim)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          painting:
          {paint.typeKey
            ? <><TypeFlag spec={flagOf(paint.typeKey)} letter={paint.subtypeKey.toUpperCase()} size={27} /><b style={{ color: "var(--ink)" }}>{types.find((t) => t.key === paint.typeKey)?.label || paint.typeKey} · {paint.subtypeKey.toUpperCase()}</b></>
            : <b style={{ color: "var(--ink)" }}>— pick a layout above</b>}
        </span>
      </div>

      {floors > 0 && perFloor > 0 && (
        <div className="mm-paintgrid" style={{ border: "1px solid var(--line)", borderRadius: 8, userSelect: "none" }}
          onMouseUp={endPaint} onMouseLeave={endPaint}>
          <table style={{ borderCollapse: "separate", borderSpacing: 3, padding: 6 }}>
            <tbody>
              <tr>
                <td />
                {Array.from({ length: perFloor }, (_, u) => (
                  <td key={u} style={{ textAlign: "center" }}>
                    <button title={`fill position ${u + 1} on every floor`} onClick={() => fillColumn(u)}
                      style={{ fontSize: 9, color: "var(--ink-dim)", background: "transparent", border: "1px solid var(--line)", borderRadius: 4, cursor: "pointer", padding: "1px 4px" }}>↓{u + 1}</button>
                  </td>
                ))}
              </tr>
              {Array.from({ length: floors }, (_, fi) => floors - 1 - fi).map((f) => (
                <tr key={f}>
                  <td style={{ whiteSpace: "nowrap", paddingRight: 6, textAlign: "right" }}>
                    <button title="fill this floor" onClick={() => fillFloor(f)}
                      style={{ fontSize: 10, color: "var(--ink-dim)", background: "transparent", border: "1px solid var(--line)", borderRadius: 4, cursor: "pointer", padding: "1px 5px" }}>F{f + 1}</button>
                  </td>
                  {Array.from({ length: perFloor }, (_, u) => {
                    const cell = matrix[f]?.[u];
                    const has = !!cell?.typeKey;
                    const cont = !!cell?.cont; // the upper half of a duplex below
                    return (
                      <td key={u} style={{ padding: 0 }}>
                        <button
                          onMouseDown={(e) => { e.preventDefault(); startPaint(f, u); }}
                          onMouseEnter={() => dragOver(f, u)}
                          title={has ? (cont ? `${cell!.typeKey} (upper floor of the duplex below)` : `${cell!.typeKey}, ${cell!.subtypeKey?.toUpperCase()}`) : "empty — click or drag to place"}
                          style={{ width: 40, height: 38, borderRadius: 4, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            border: `1px solid ${has ? "var(--line-strong, var(--line))" : "var(--line)"}`, background: "var(--bg)" }}>
                          {has && (cont
                            ? <div style={{ opacity: 0.5, display: "flex", alignItems: "center", justifyContent: "center" }}><TypeFlag spec={flagOf(cell!.typeKey)} letter={"↑"} size={30} /></div>
                            : <TypeFlag spec={flagOf(cell!.typeKey)} letter={(cell!.subtypeKey || "").toUpperCase()} size={30} />)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// A unit TYPE and its LAYOUTS (subtypes = the real units). Each layout row is a PAINT selector: a colour swatch +
// click-to-select-for-painting (highlighted when active), inline name + size, add/remove. The type's size range is
// DERIVED from the layouts (read-only). (: "fold the grid palette into this section; each subtype a colour").
function UnitTypeEditor({ type, flagOf, paint, setPaint, onRename, onRekey, onRemoveType, onSubtypes, canRemoveType }: {
  type: UnitType;
  flagOf: (typeKey: string) => TypeFlagSpec;
  paint: { typeKey: string; subtypeKey: string };
  setPaint: (p: { typeKey: string; subtypeKey: string }) => void;
  onRename: (label: string) => void;
  onRekey: (key: string) => void;
  onRemoveType: () => void;
  onSubtypes: (subs: AiUnitSubtype[]) => void;
  canRemoveType: boolean;
}) {
  const subs: AiUnitSubtype[] = type.subtypes && type.subtypes.length ? type.subtypes : [{ key: "a", label: "Standard" }];
  const sizes = subs.map((s) => s.sqm).filter((n): n is number => typeof n === "number" && n > 0);
  const range = sizes.length ? (Math.min(...sizes) === Math.max(...sizes) ? `${Math.min(...sizes)} m²` : `${Math.min(...sizes)}–${Math.max(...sizes)} m²`) : "— set a size";
  // Key editing uses a local DRAFT: you type freely, we only normalise to a slug on blur. (Slugifying every
  // keystroke ate trailing dashes / uppercase and fought the cursor.) Resync the draft if the key
  // changes from outside (e.g. a rekey elsewhere); otherwise the draft owns the field while focused.
  const [keyDraft, setKeyDraft] = useState(type.key);
  const keyRef = useRef(type.key);
  if (keyRef.current !== type.key) { keyRef.current = type.key; if (type.key !== keyDraft) setKeyDraft(type.key); }
  const commitKey = () => { const slug = slugify(keyDraft); setKeyDraft(slug); if (slug !== type.key) onRekey(slug); };
  const patchSub = (i: number, p: Partial<AiUnitSubtype>) => onSubtypes(subs.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const addSub = () => onSubtypes([...subs, { key: nextSubKey(subs), label: `Type ${nextSubKey(subs).toUpperCase()}` }]);
  const removeSub = (i: number) => onSubtypes(subs.filter((_, j) => j !== i));
  const isCore = isCoreType(type);

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginBottom: 0, background: "var(--bg)" }}>
      {/* type header — ONE row that never wraps the delete button off: flag + name + key grow/shrink, ✕ type stays pinned right */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap" }}>
        {/* the type's flag (geometry only; the layout letter is per-row below) */}
        <TypeFlag spec={flagOf(type.key)} letter="" size={33} />
        <input value={type.label} onChange={(e) => onRename(e.target.value)} style={{ ...typeInput(140), fontWeight: 700, flex: "1 1 80px", minWidth: 0 }} placeholder="Type name" />
        <input value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} onBlur={commitKey}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          style={{ ...typeInput(76, true), flex: "0 1 76px", minWidth: 40 }} placeholder="key" />
        <button className="mm-btn mm-btn--danger" disabled={!canRemoveType} title={canRemoveType ? "remove this type" : "keep at least one type"}
          style={{ flex: "0 0 auto", opacity: canRemoveType ? 1 : 0.4 }} onClick={onRemoveType}>✕ type</button>
      </div>
      <div style={{ color: "var(--ink-dim)", fontSize: 12, marginTop: 4 }}>range: {range}</div>
      <div style={{ marginTop: 8, paddingLeft: 2 }}>
        <div style={{ fontSize: 11, color: "var(--ink-dim)", marginBottom: 4 }}>Layouts — click the flag to paint{isCore ? " (structural — placed in the grid, but not a sellable unit)" : ""}</div>
        {subs.map((s, i) => {
          const sk = s.key || "a";
          const active = paint.typeKey === type.key && paint.subtypeKey === sk;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5,
              border: active ? "1px solid var(--accent)" : "1px solid transparent", borderRadius: 6, padding: "2px 3px", background: active ? "var(--accent-weak, rgba(61,125,255,.12))" : "transparent" }}>
              {/* the layout FLAG = type geometry + this layout's letter; clicking it selects this layout to paint.
                  Core (elevator/stairs) IS selectable — you place its column in the grid; it just isn't sold. */}
              <button title={isCore ? "select the core to place its column (structural — not sold)" : "select this layout to paint"}
                onClick={() => setPaint({ typeKey: type.key, subtypeKey: sk })}
                style={{ flex: "0 0 auto", padding: 2, borderRadius: 6, cursor: "pointer",
                  border: active ? "1px solid var(--accent)" : "1px solid var(--line)", background: "var(--bg)", lineHeight: 0 }}>
                <TypeFlag spec={flagOf(type.key)} letter={sk.toUpperCase()} size={30} />
              </button>
              <input value={s.label ?? ""} placeholder={`Layout ${sk.toUpperCase()}`} onChange={(e) => patchSub(i, { label: e.target.value })} style={typeInput(132)} />
              <div style={{ position: "relative" }}>
                <input type="number" min={0} step="any" value={s.sqm ?? ""} placeholder="size" onChange={(e) => patchSub(i, { sqm: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value) || 0) })} style={{ ...typeInput(72), paddingRight: 20 }} />
                <span style={{ position: "absolute", right: 6, top: 6, color: "var(--ink-dim)", fontSize: 10 }}>m²</span>
              </div>
              <button className="mm-btn mm-btn--danger" disabled={subs.length <= 1} title={subs.length <= 1 ? "keep at least one layout" : "remove layout"}
                style={{ padding: "2px 7px", opacity: subs.length <= 1 ? 0.4 : 1 }} onClick={() => removeSub(i)}>×</button>
            </div>
          );
        })}
        <button className="mm-btn" style={{ marginTop: 2 }} onClick={addSub}>+ Layout</button>
      </div>
    </div>
  );
}

/** next free subtype key a..z for a type's layouts. */
function nextSubKey(subs: AiUnitSubtype[]): string {
  const used = new Set(subs.map((s) => (s.key || "").toLowerCase()));
  for (let c = 97; c < 123; c++) { const k = String.fromCharCode(c); if (!used.has(k)) return k; }
  return `s${subs.length + 1}`;
}

/** a unique type key against the existing types (new, new-2, …). */
function uniqueTypeKey(types: UnitType[]): string {
  const used = new Set(types.map((t) => t.key));
  if (!used.has("new")) return "new";
  let n = 2; while (used.has(`new-${n}`)) n++; return `new-${n}`;
}

function Head({ crumbs, title }: { crumbs: string; title: string }) {
  return (
    <>
      <div className="mm-main__crumbs">{crumbs}</div>
      <h1 className="mm-main__title">{title}</h1>
    </>
  );
}

// ---------------------------------------------------------------------------

function DeveloperForm({ api }: { api: PackApi }) {
  const d = api.pack.developer;
  return (
    <>
      <Head crumbs="Developer" title={d.name || "Developer"} />
      <div className="mm-card">
        <h3>Project settings</h3>
        <div className="mm-grid">
          <Field label="Domain" hint="re-skins labels, templates & image archetypes for this project">
            <SelectInput
              value={api.pack.domain || "realestate"}
              onChange={(v) => api.setDomain(v as "realestate" | "art" | "tickets")}
              options={[
                { value: "realestate", label: "Real estate" },
                { value: "art", label: "Art / NFT" },
                { value: "tickets", label: "Tickets / event slots" },
              ]}
            />
          </Field>
        </div>
      </div>
      <div className="mm-card">
        <h3>Identity</h3>
        <div className="mm-grid">
          <Field label="Name" hint="required">
            <TextInput value={d.name} onChange={(v) => api.patchDeveloper({ name: v, id: slugify(v) })} />
          </Field>
          <Field label="ID" hint="url-safe, derived from name">
            <TextInput value={d.id} onChange={(v) => api.patchDeveloper({ id: slugify(v) })} mono />
          </Field>
          <Field label="Holding company">
            <TextInput value={d.holdingCompany} onChange={(v) => api.patchDeveloper({ holdingCompany: v })} />
          </Field>
          <Field label="NEAR account" hint="optional — your VRX blockchain account (leave blank if unsure)">
            <TextInput value={d.nearAccount} onChange={(v) => api.patchDeveloper({ nearAccount: v })} mono />
          </Field>
          <Field label="Logo path" hint="relative to pack">
            <TextInput value={d.logo} onChange={(v) => api.patchDeveloper({ logo: v })} mono />
          </Field>
        </div>
      </div>
    </>
  );
}

function CompanyForm({ api, id }: { api: PackApi; id: string }) {
  const c = api.pack.companies.find((x) => x.id === id)!;
  return (
    <>
      <Head crumbs={`Developer › ${api.pack.developer.name}`} title={c.name || c.id} />
      <div className="mm-card">
        <h3>Company</h3>
        <div className="mm-grid">
          <Field label="Name" hint="required">
            <TextInput value={c.name} onChange={(v) => api.patchCompany(id, { name: v })} />
          </Field>
          <Field label="ID" hint="url-safe">
            <TextInput value={c.id} onChange={(v) => api.patchCompany(id, { id: slugify(v) })} mono />
          </Field>
          <Field label="Registration" hint="e.g. TH-0105..." full>
            <TextInput value={c.registration} onChange={(v) => api.patchCompany(id, { registration: v })} mono />
          </Field>
        </div>
        <div className="mm-btn-row" style={{ marginTop: 14 }}>
          <button className="mm-btn mm-btn--danger" onClick={() => { api.removeCompany(id); api.select({ kind: "developer" }); }}>
            Delete company
          </button>
        </div>
      </div>
    </>
  );
}

function ComplexForm({ api, id }: { api: PackApi; id: string }) {
  const cx = api.pack.complexes.find((x) => x.id === id)!;
  const companyOpts = [{ value: "", label: "— none —" }, ...api.pack.companies.map((c) => ({ value: c.id, label: c.name || c.id }))];
  return (
    <>
      <Head crumbs={`Developer › ${api.pack.developer.name}`} title={cx.name || cx.id} />
      <div className="mm-card">
        <h3>Complex</h3>
        <div className="mm-grid">
          <Field label="Name" hint="required">
            <TextInput value={cx.name} onChange={(v) => api.patchComplex(id, { name: v })} />
          </Field>
          <Field label="ID" hint="url-safe">
            <TextInput value={cx.id} onChange={(v) => api.patchComplex(id, { id: slugify(v) })} mono />
          </Field>
          <Field label="Owning company">
            <SelectInput value={cx.companyId} onChange={(v) => api.patchComplex(id, { companyId: v || undefined })} options={companyOpts} />
          </Field>
          <Field label="Area / district">
            <TextInput value={cx.area} onChange={(v) => api.patchComplex(id, { area: v })} />
          </Field>
          <Field label="Amenities" hint="comma-separated" full>
            <ListInput value={cx.amenities} onChange={(v) => api.patchComplex(id, { amenities: v })} />
          </Field>
        </div>
        <div className="mm-card" style={{ marginTop: 14, background: "var(--bg)" }}>
          <h3>Buildings in this complex ({cx.buildings.length})</h3>
          <div className="mm-btn-row">
            {api.pack.buildings.filter((b) => b.complexId === id).map((b) => (
              <button key={b.id} className="mm-btn" onClick={() => api.select({ kind: "building", id: b.id })}>
                🏗 {b.name || b.id}
              </button>
            ))}
            <button className="mm-btn mm-btn--primary" onClick={() => api.select({ kind: "building", id: api.addBuilding(id) })}>
              + Add building
            </button>
          </div>
        </div>
        <div className="mm-btn-row" style={{ marginTop: 14 }}>
          <button className="mm-btn mm-btn--danger" onClick={() => { api.removeComplex(id); api.select({ kind: "developer" }); }}>
            Delete complex
          </button>
        </div>
      </div>
    </>
  );
}

function BuildingForm({ api, id }: { api: PackApi; id: string }) {
  const b = api.pack.buildings.find((x) => x.id === id)!;
  const cx = api.pack.complexes.find((c) => c.id === b.complexId);
  const complexOpts = api.pack.complexes.map((c) => ({ value: c.id, label: c.name || c.id }));
  const termOpts = [{ value: "", label: "— none —" }, ...api.pack.terms.map((t) => ({ value: t.id, label: t.id }))];
  const types = b.unitTypes || [];

  return (
    <>
      <Head crumbs={`Complex › ${cx?.name || b.complexId}`} title={b.name || b.id} />

      <div className="mm-card">
        <h3>Building</h3>
        <div className="mm-grid">
          <Field label="Name" hint="required">
            <TextInput value={b.name} onChange={(v) => api.patchBuilding(id, { name: v })} />
          </Field>
          <Field label="ID" hint="url-safe">
            <TextInput value={b.id} onChange={(v) => api.patchBuilding(id, { id: slugify(v) })} mono />
          </Field>
          <Field label="Development" hint="which development this building belongs to">
            <SelectInput value={b.complexId} onChange={(v) => api.patchBuilding(id, { complexId: v })} options={complexOpts} />
          </Field>
          <Field label="Type">
            <SelectInput
              value={b.type}
              onChange={(v) => api.patchBuilding(id, { type: v })}
              options={[{ value: "High Rise", label: "High Rise" }, { value: "Low Rise", label: "Low Rise" }]}
            />
          </Field>
          <Field label="Stories" hint="required, ≥1">
            <NumberInput value={b.stories} onChange={(v) => api.patchBuilding(id, { stories: v ?? 1 })} />
          </Field>
          <Field label="Declared unit count">
            <NumberInput value={b.units} onChange={(v) => api.patchBuilding(id, { units: v })} />
          </Field>
          <Field label="Tagline" full>
            <TextInput value={b.tagline} onChange={(v) => api.patchBuilding(id, { tagline: v })} />
          </Field>
          <Field label="Area / district">
            <TextInput value={b.area} onChange={(v) => api.patchBuilding(id, { area: v })} />
          </Field>
          <Field label="Address">
            <TextInput value={b.address} onChange={(v) => api.patchBuilding(id, { address: v })} />
          </Field>
          <Field label="Completion blurb">
            <TextInput value={b.completion} onChange={(v) => api.patchBuilding(id, { completion: v })} />
          </Field>
          <Field label="Construction end" hint="YYYY-MM-DD">
            <TextInput value={b.constructionEnd} onChange={(v) => api.patchBuilding(id, { constructionEnd: v })} mono />
          </Field>
          <Field label="Amenities" hint="comma-separated" full>
            <ListInput value={b.amenities} onChange={(v) => api.patchBuilding(id, { amenities: v })} />
          </Field>
        </div>
      </div>

      <UnitTypesAndGrid api={api} buildingId={id} types={types} editType={editType} />

      <MediaCard api={api} buildingId={id} />

      <div className="mm-card">
        <h3>Fees &amp; charges (USD)</h3>
        <div className="mm-grid">
          <Field label="Reservation fee"><NumberInput value={b.reservationFeeUsd} onChange={(v) => api.patchBuilding(id, { reservationFeeUsd: v })} /></Field>
          <Field label="Booking deposit"><NumberInput value={b.bookingDepositUsd} onChange={(v) => api.patchBuilding(id, { bookingDepositUsd: v })} /></Field>
          <Field label="Maintenance /m²"><NumberInput value={b.maintenancePerSqmUsd} step={0.1} onChange={(v) => api.patchBuilding(id, { maintenancePerSqmUsd: v })} /></Field>
          <Field label="Sinking fund /m²"><NumberInput value={b.sinkingFundPerSqmUsd} step={0.1} onChange={(v) => api.patchBuilding(id, { sinkingFundPerSqmUsd: v })} /></Field>
          <Field label="Transfer fee %" hint="e.g. 6.30%"><TextInput value={b.transferFeePct} onChange={(v) => api.patchBuilding(id, { transferFeePct: v })} mono /></Field>
          <Field label="Payment terms"><SelectInput value={b.termsRef} onChange={(v) => api.patchBuilding(id, { termsRef: v || undefined })} options={termOpts} /></Field>
        </div>
      </div>

      <div className="mm-btn-row">
        <button className="mm-btn mm-btn--danger" onClick={() => { api.removeBuilding(id); api.select({ kind: "developer" }); }}>Delete building</button>
      </div>
    </>
  );

  function editType(i: number, patch: Partial<(typeof types)[number]>) {
    api.setUnitTypes(id, types.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }
}

// A single installment stage (a row in on-contract / ongoing plans). Kept loose — VRX interprets the plan.
interface Installment { installments?: number; amountPct?: number }

function TermsForm({ api, id }: { api: PackApi; id: string }) {
  const t = api.pack.terms.find((x) => x.id === id)!;
  const data = (t.data || {}) as Record<string, unknown>;
  const [showJson, setShowJson] = useState(false);

  // merge a patch into the terms data, PRESERVING any keys the UI doesn't surface (VRX may use extra fields).
  const patch = (p: Record<string, unknown>) => api.patchTerms(id, { ...data, ...p });
  // number-list fields are stored as arrays (the options a buyer can pick); edited as a friendly comma list.
  const numList = (key: string): string => (Array.isArray(data[key]) ? (data[key] as unknown[]).join(", ") : "");
  const setNumList = (key: string, v: string) =>
    patch({ [key]: v.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) });
  const num = (key: string): number | undefined => (typeof data[key] === "number" ? (data[key] as number) : undefined);
  const stages = (key: string): Installment[] => (Array.isArray(data[key]) ? (data[key] as Installment[]) : []);
  const setStages = (key: string, v: Installment[]) => patch({ [key]: v });

  const StageTable = ({ dataKey, label }: { dataKey: string; label: string }) => {
    const rows = stages(dataKey);
    const setRow = (i: number, p: Partial<Installment>) => setStages(dataKey, rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
    return (
      <div className="mm-field mm-field--full">
        <label>{label}</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.length === 0 && <span style={{ fontSize: 12, color: "var(--ink-dim)" }}>no stages — add one below</span>}
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="number" min={1} value={r.installments ?? ""} placeholder="# payments" style={typeInput(100)} onChange={(e) => setRow(i, { installments: e.target.value === "" ? undefined : Math.max(1, Number(e.target.value) || 1) })} />
              <span style={{ fontSize: 12, color: "var(--ink-dim)" }}>× of</span>
              <div style={{ position: "relative" }}>
                <input type="number" min={0} step="any" value={r.amountPct ?? ""} placeholder="amount" style={{ ...typeInput(90), paddingRight: 18 }} onChange={(e) => setRow(i, { amountPct: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value) || 0) })} />
                <span style={{ position: "absolute", right: 6, top: 6, color: "var(--ink-dim)", fontSize: 10 }}>%</span>
              </div>
              <button className="mm-btn mm-btn--danger" style={{ padding: "2px 7px" }} onClick={() => setStages(dataKey, rows.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button className="mm-btn" style={{ alignSelf: "flex-start" }} onClick={() => setStages(dataKey, [...rows, { installments: 1, amountPct: 0 }])}>+ Stage</button>
        </div>
      </div>
    );
  };

  return (
    <>
      <Head crumbs="Payment plan" title={id} />
      <div className="mm-card">
        <h3>Payment plan</h3>
        <p style={{ color: "var(--ink-dim)", fontSize: 12, marginTop: -6 }}>
          How a buyer pays — booking fee, deposit, the stages on contract &amp; over time. Carried into <code>terms/{id}.json</code>; VRX interprets it. Percentages are of the unit price unless noted.
        </p>
        <div className="mm-grid">
          <Field label="Booking fee (USD)" hint="the options a buyer can pick, comma-separated">
            <TextInput value={numList("bookingFee")} onChange={(v) => setNumList("bookingFee", v)} placeholder="e.g. 1000, 1500" mono />
          </Field>
          <Field label="Deposit %" hint="options, comma-separated">
            <TextInput value={numList("depositPct")} onChange={(v) => setNumList("depositPct", v)} placeholder="e.g. 10, 20, 30" mono />
          </Field>
          <Field label="On-key %" hint="paid at handover, options">
            <TextInput value={numList("onKeyPct")} onChange={(v) => setNumList("onKeyPct", v)} placeholder="e.g. 30" mono />
          </Field>
          <Field label="Tax %" hint="options">
            <TextInput value={numList("taxPct")} onChange={(v) => setNumList("taxPct", v)} placeholder="e.g. 0, 7" mono />
          </Field>
          <Field label="Installment frequency (days)" hint="options">
            <TextInput value={numList("frequencyDays")} onChange={(v) => setNumList("frequencyDays", v)} placeholder="e.g. 30, 60" mono />
          </Field>
          <Field label="Contract window (days)" hint="days to sign after reserving">
            <NumberInput value={num("contractDays")} onChange={(v) => patch({ contractDays: v })} />
          </Field>
        </div>
        <StageTable dataKey="onContract" label="On-contract stages (paid during construction)" />
        <StageTable dataKey="ongoing" label="Ongoing stages (recurring installments)" />

        <div style={{ marginTop: 10 }}>
          <button className="mm-btn" onClick={() => setShowJson((s) => !s)}>{showJson ? "▾ Hide" : "▸ Show"} advanced (raw JSON)</button>
          {showJson && (
            <Field label="Raw data (JSON) — edits any field above or extra VRX keys" full>
              <textarea
                defaultValue={JSON.stringify(data, null, 2)}
                style={{ fontFamily: "var(--mono)", minHeight: 200, marginTop: 6 }}
                onBlur={(e) => { try { api.patchTerms(id, JSON.parse(e.target.value || "{}")); } catch { /* keep text; export never blocks (law #2) */ } }}
              />
            </Field>
          )}
        </div>

        <div className="mm-btn-row" style={{ marginTop: 10 }}>
          <button className="mm-btn mm-btn--danger" onClick={() => { api.removeTerms(id); api.select({ kind: "developer" }); }}>Delete payment plan</button>
        </div>
      </div>
    </>
  );
}

function TextsForm({ api }: { api: PackApi }) {
  const texts = api.pack.texts || {};
  const entries = Object.entries(texts);
  return (
    <>
      <Head crumbs="Marketing & contract texts" title="Texts" />
      <div className="mm-card">
        <h3>Free texts</h3>
        <p style={{ color: "var(--ink-dim)", fontSize: 12, marginTop: -6 }}>
          Keyed blurbs (overview, contract clauses, disclaimers). Always valid — carried into the pack as-is.
        </p>
        {entries.length === 0 && <div className="mm-empty">No texts yet. Add one below.</div>}
        {entries.map(([k, v]) => (
          <div key={k} style={{ marginBottom: 16 }}>
            <Field label={k} full>
              <TextArea value={v} onChange={(val) => api.setText(k, val)} />
            </Field>
            <button className="mm-btn mm-btn--danger" style={{ marginTop: 6 }} onClick={() => api.removeText(k)}>Remove</button>
          </div>
        ))}
        <AddText onAdd={(k) => api.setText(k, "")} />
      </div>
    </>
  );
}

function AddText({ onAdd }: { onAdd: (key: string) => void }) {
  return (
    <form
      className="mm-btn-row"
      style={{ marginTop: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        const input = (e.currentTarget.elements.namedItem("k") as HTMLInputElement);
        const key = input.value.trim();
        if (key) { onAdd(key); input.value = ""; }
      }}
    >
      <input name="k" placeholder="new text key (e.g. contract.clause.1)" style={{ flex: 1, fontFamily: "var(--mono)", border: "1px solid var(--line-strong)", borderRadius: 6, padding: "7px 9px" }} />
      <button className="mm-btn mm-btn--primary" type="submit">+ Add text</button>
    </form>
  );
}
