"use client";

// The units surface for one building: bulk CSV IMPORT (parseUnitsCsv) + editable grid + CSV export.
// Import is forgiving (per-row errors surfaced); the whole-pack validation rail re-checks on the right.

import { useMemo, useRef, useState } from "react";
import type { PackApi } from "./usePack";
import type { Unit } from "@/lib/pack";
import { type CsvRowError, parseUnitsCsv, serializeUnitsCsv } from "@/lib/units-csv";

// A big building (e.g. 1430 units from the AI generator) would render ~20k inputs if we drew every row — slow to
// mount and to type in. So the grid is VIRTUALIZED: it's one continuous scroll (no paging), but only the rows in
// (and just around) the viewport are actually mounted; off-screen rows are replaced by a single spacer <tr> top and
// bottom that reserves their height. Editing/delete use each row's ABSOLUTE index, so virtualization is invisible to
// the data. ROW_H must match the real rendered row height for the scroll math to line up.
const ROW_H = 29;       // px per unit row (input + 2px padding + border)
const OVERSCAN = 8;     // extra rows above/below the viewport so fast scrolls don't flash blank

const COLS: Array<{ key: keyof Unit; label: string; type: "text" | "number" | "bool"; w?: number }> = [
  { key: "id", label: "id", type: "text", w: 110 },
  { key: "type", label: "type", type: "text", w: 80 },
  { key: "subtype", label: "sub", type: "text", w: 50 },
  { key: "floor", label: "floor", type: "number", w: 60 },
  { key: "unitNumber", label: "unit#", type: "number", w: 70 },
  { key: "sqm", label: "sqm", type: "number", w: 70 },
  //  the three area sources over a unit's life: the drawn plan is illustration-grade, but the authoritative
  // size for price/$-per-m² is the land-office LEGAL (sqmFinal) ?? ARCHITECT (sqmBefore) ?? sqm (see pack.unitSqm).
  { key: "sqmBefore", label: "architect", type: "number", w: 80 },
  { key: "sqmFinal", label: "legal m²", type: "number", w: 80 },
  { key: "priceUsd", label: "priceUsd", type: "number", w: 100 },
  { key: "priceFreehold", label: "priceFH", type: "number", w: 90 },
  { key: "view", label: "view", type: "text", w: 80 },
  { key: "corner", label: "corner", type: "bool", w: 60 },
  { key: "baths", label: "baths", type: "number", w: 60 },
  { key: "note", label: "note", type: "text", w: 140 },
  { key: "termsRef", label: "termsRef", type: "text", w: 100 },
];

export function UnitsEditor({ api, buildingId }: { api: PackApi; buildingId: string }) {
  const b = api.pack.buildings.find((x) => x.id === buildingId);
  const units = api.pack.buildingUnits[buildingId] || [];
  const [importErrors, setImportErrors] = useState<CsvRowError[]>([]);
  const [paste, setPaste] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // virtualization: track the scroll container's scrollTop + height, derive the visible row window.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  const total = units.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  // the rows we actually render this paint (keep the absolute index so edits/deletes hit the right unit)
  const visible = useMemo(
    () => units.slice(first, last).map((u, k) => ({ u, i: first + k })),
    [units, first, last]
  );
  const padTop = first * ROW_H;
  const padBottom = Math.max(0, (total - last) * ROW_H);

  if (!b) return <div className="mm-empty">That building no longer exists.</div>;

  function doImport(text: string, mode: "replace" | "append") {
    const res = parseUnitsCsv(text);
    setImportErrors(res.errors);
    const next = mode === "append" ? [...units, ...res.units] : res.units;
    api.setUnits(buildingId, next);
  }

  function onFile(file: File) {
    file.text().then((t) => doImport(t, "replace"));
  }

  function editCell(i: number, col: (typeof COLS)[number], raw: string) {
    const patch: Partial<Unit> = {};
    if (col.type === "number") (patch as Record<string, unknown>)[col.key] = raw === "" ? undefined : Number(raw);
    else if (col.type === "bool") (patch as Record<string, unknown>)[col.key] = raw === "true";
    else (patch as Record<string, unknown>)[col.key] = raw || undefined;
    api.setUnits(buildingId, units.map((u, j) => (j === i ? { ...u, ...patch } : u)));
  }

  function addRow() {
    const n = units.length + 1;
    api.setUnits(buildingId, [...units, { id: `unit-${String(n).padStart(4, "0")}`, type: "studio", floor: 1, sqm: 0, priceUsd: 0 }]);
  }

  function download() {
    const blob = new Blob([serializeUnitsCsv(units)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${buildingId}-units.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const rowIsBad = (u: Unit) => !u.id || !u.type || !(u.sqm > 0) || !Number.isFinite(u.floor);

  return (
    <>
      {/* back to the building form (the spreadsheet is a drill-in; the tree selection stays on this building). */}
      <button
        className="mm-btn"
        style={{ marginBottom: 10 }}
        onClick={() => api.select({ kind: "building", id: buildingId })}
      >
        ← Back to building
      </button>
      <div className="mm-main__crumbs">Building › {b.name || b.id}</div>
      <h1 className="mm-main__title">Units — {units.length}</h1>

      <div className="mm-card">
        <h3>Import units.csv</h3>
        <div
          className={`mm-dropzone${drag ? " drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) onFile(f);
          }}
          onClick={() => fileRef.current?.click()}
        >
          Drop a <b>units.csv</b> here, or click to choose · columns map by name (order doesn&apos;t matter)
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
          />
        </div>
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", color: "var(--accent-ink)" }}>…or paste CSV text</summary>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="id,type,floor,sqm,priceUsd&#10;unit-0801,studio,8,30,95000"
            style={{ width: "100%", minHeight: 100, fontFamily: "var(--mono)", marginTop: 8, border: "1px solid var(--line-strong)", borderRadius: 6, padding: 8 }}
          />
          <div className="mm-btn-row" style={{ marginTop: 8 }}>
            <button className="mm-btn mm-btn--primary" onClick={() => doImport(paste, "replace")} disabled={!paste.trim()}>Replace from paste</button>
            <button className="mm-btn" onClick={() => doImport(paste, "append")} disabled={!paste.trim()}>Append from paste</button>
          </div>
        </details>

        {importErrors.length > 0 && (
          <div style={{ marginTop: 12, background: "var(--err-weak)", color: "var(--err)", padding: 10, borderRadius: 6, fontSize: 12 }}>
            <b>{importErrors.length} row problem(s) on import</b> — imported anyway (fix below or re-import):
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {importErrors.slice(0, 8).map((e, i) => (
                <li key={i}>row {e.row}{e.column ? ` · ${e.column}` : ""}: {e.message}</li>
              ))}
              {importErrors.length > 8 && <li>…and {importErrors.length - 8} more</li>}
            </ul>
          </div>
        )}
      </div>

      <div className="mm-card">
        <h3>Units grid ({units.length})</h3>
        {/* ONE continuous scroll; only the rows near the viewport are mounted (virtualized), so a 1430-unit grid
            scrolls and types smoothly. Top/bottom spacer rows reserve the off-screen height so the scrollbar is
            correct. */}
        <div
          className="mm-units"
          ref={scrollRef}
          style={{ maxHeight: "60vh" }}
          onScroll={(e) => {
            const el = e.currentTarget;
            setScrollTop(el.scrollTop);
            setViewH(el.clientHeight);
          }}
        >
          <table>
            <thead>
              <tr>
                {COLS.map((c) => <th key={String(c.key)}>{c.label}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {padTop > 0 && <tr style={{ height: padTop }} aria-hidden><td colSpan={COLS.length + 1} style={{ padding: 0, border: 0 }} /></tr>}
              {visible.map(({ u, i }) => (
                <tr key={i} className={rowIsBad(u) ? "bad" : undefined}>
                  {COLS.map((c) => (
                    <td key={String(c.key)}>
                      {c.type === "bool" ? (
                        <input type="checkbox" checked={!!u[c.key]} onChange={(e) => editCell(i, c, e.target.checked ? "true" : "false")} />
                      ) : (
                        <input
                          type={c.type === "number" ? "number" : "text"}
                          value={(u[c.key] as string | number | undefined) ?? ""}
                          // color:inherit so the cell text follows the theme (was defaulting to black → invisible on dark)
                          style={{ width: c.w, border: "1px solid transparent", background: "transparent", color: "inherit", padding: "2px 4px" }}
                          onChange={(e) => editCell(i, c, e.target.value)}
                        />
                      )}
                    </td>
                  ))}
                  <td>
                    <button className="mm-btn mm-btn--danger" style={{ padding: "2px 7px" }} onClick={() => api.setUnits(buildingId, units.filter((_, j) => j !== i))}>✕</button>
                  </td>
                </tr>
              ))}
              {padBottom > 0 && <tr style={{ height: padBottom }} aria-hidden><td colSpan={COLS.length + 1} style={{ padding: 0, border: 0 }} /></tr>}
              {units.length === 0 && (
                <tr><td colSpan={COLS.length + 1} style={{ textAlign: "center", color: "var(--ink-dim)", padding: 20 }}>No units yet — add a row or import a CSV.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mm-btn-row" style={{ marginTop: 10 }}>
          <button className="mm-btn" onClick={addRow}>+ Add row</button>
          <button className="mm-btn" onClick={download} disabled={units.length === 0}>⭳ Export units.csv</button>
        </div>
      </div>
    </>
  );
}
