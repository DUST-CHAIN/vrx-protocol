"use client";

// ImportIfcPanel — IFC-import arc Slice 3: the import UI.
//
// A dev-only affordance (the "📐 Import IFC" button in the frame foot) opens this modal. It drives the whole
// chain the pure slices 1+2 already built:
//
//     pick an .ifc file → parseIfcBytes (web-ifc WASM) → extractIfcSlice → ifcSliceToProject → REVIEW → Accept
//
// It is a REVIEW-THEN-ACCEPT surface: parsing shows a MapReport (how many units were created, which spaces were
// dropped and why, which storeys were skipped) BEFORE anything touches the store. On Accept it loads the mapped
// AuthoredProject via api.loadProject (the generic seam) and selects the building. Nothing is invented about the
// deal — geometry only; the land is a generated envelope the user swaps for the real deed later.
//
// web-ifc is browser-only (WASM); the dynamic import + WASM-locate live in lib/ifc-browser, not here.

import { useRef, useState } from "react";
import type { PackApi, Selection } from "./usePack";
import { parseIfcBytes, type IfcImportResult } from "@/lib/ifc-browser";

type Phase = "pick" | "parsing" | "review" | "error";

export function ImportIfcPanel({
  api,
  onClose,
  onLoaded,
}: {
  api: PackApi;
  onClose: () => void;
  onLoaded: (sel: Selection) => void;
}) {
  const [phase, setPhase] = useState<Phase>("pick");
  const [fileName, setFileName] = useState<string>("");
  const [result, setResult] = useState<IfcImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setFileName(file.name);
    setPhase("parsing");
    setErr(null);
    setResult(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await parseIfcBytes(bytes, { name: file.name.replace(/\.ifc$/i, "") });
      setResult(res);
      setPhase("review");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function accept() {
    if (!result) return;
    const id = api.loadProject(result.project);
    onLoaded({ kind: "building", id });
    onClose();
  }

  const report = result?.report;

  return (
    <div
      className="mm-ifc-overlay"
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(6,9,16,0.72)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
      onClick={onClose}
    >
      <div
        className="mm-ifc-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)", maxHeight: "86vh", overflow: "auto",
          background: "var(--mm-panel, #0e1119)", border: "1px solid rgba(128,128,128,0.3)",
          borderRadius: 10, padding: "18px 20px", boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <strong style={{ fontSize: 15 }}>📐 Import a CAD building (IFC)</strong>
          <button className="mm-btn" style={{ padding: "2px 9px", fontSize: 12 }} onClick={onClose}>✕</button>
        </div>
        <div className="mm-rail__note" style={{ marginBottom: 14 }}>
          Loads a real BIM model’s floors &amp; room footprints (to scale). One IfcSpace → one unit; circulation and
          slivers are filtered. Geometry only — names, prices and the land parcel are yours to set after.
        </div>

        {phase === "pick" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              ref={inputRef}
              type="file"
              accept=".ifc"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
            <button className="mm-btn mm-btn--primary" onClick={() => inputRef.current?.click()}>
              Choose an .ifc file…
            </button>
          </div>
        )}

        {phase === "parsing" && (
          <div style={{ fontSize: 13, opacity: 0.8, padding: "12px 2px" }}>
            Parsing <b>{fileName}</b> — loading the WASM reader and extracting floors &amp; spaces…
          </div>
        )}

        {phase === "error" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ color: "var(--mm-err, #e06666)", fontSize: 13 }}>
              Couldn’t read <b>{fileName}</b>: {err}
            </div>
            <button className="mm-btn" onClick={() => setPhase("pick")}>Try another file</button>
          </div>
        )}

        {phase === "review" && report && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div
              style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8,
                fontSize: 12, textAlign: "center",
              }}
            >
              <Stat label="Units created" value={report.unitsCreated} tone="good" />
              <Stat label="Floors kept" value={report.storeysKept} tone="good" />
              <Stat label="Spaces dropped" value={report.dropped.length} tone={report.dropped.length ? "warn" : "mut"} />
            </div>

            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Source: <b>{result?.slice.schema}</b> · {result?.slice.spaces.length} spaces · {result?.slice.storeys.length} storeys
              {result?.slice.openings.length ? ` · ${result.slice.openings.length} openings (doors/windows, kept for a later pass)` : ""}
            </div>

            {report.storeysSkipped.length > 0 && (
              <Section title={`Skipped storeys (${report.storeysSkipped.length}) — no sellable spaces`}>
                {report.storeysSkipped.map((s) => (
                  <li key={s.expressID}>{s.name || `#${s.expressID}`}</li>
                ))}
              </Section>
            )}

            {report.dropped.length > 0 && (
              <Section title={`Dropped spaces (${report.dropped.length})`}>
                {report.dropped.slice(0, 40).map((d) => (
                  <li key={d.expressID}>
                    <span style={{ fontFamily: "ui-monospace, monospace" }}>{d.name || `#${d.expressID}`}</span>{" "}
                    <span style={{ opacity: 0.65 }}>— {reasonLabel(d.reason)} ({d.areaSqm.toFixed(1)} m²)</span>
                  </li>
                ))}
                {report.dropped.length > 40 && <li style={{ opacity: 0.6 }}>…and {report.dropped.length - 40} more</li>}
              </Section>
            )}

            {report.warnings.length > 0 && (
              <Section title={`Warnings (${report.warnings.length})`} tone="warn">
                {report.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
              </Section>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
              <button className="mm-btn" onClick={() => setPhase("pick")}>Pick another</button>
              <button className="mm-btn mm-btn--primary" onClick={accept} disabled={report.unitsCreated === 0}>
                Accept &amp; load ({report.unitsCreated} units)
              </button>
            </div>
            {report.unitsCreated === 0 && (
              <div style={{ color: "var(--mm-err, #e06666)", fontSize: 12 }}>
                No sellable spaces survived filtering — check the file or loosen the filters.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "good" | "warn" | "mut" }) {
  const color = tone === "good" ? "#58d08a" : tone === "warn" ? "#e0b84d" : "#8a93a8";
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "10px 6px" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, opacity: 0.7 }}>{label}</div>
    </div>
  );
}

function Section({ title, tone, children }: { title: string; tone?: "warn"; children: React.ReactNode }) {
  return (
    <details style={{ fontSize: 12 }}>
      <summary style={{ cursor: "pointer", color: tone === "warn" ? "#e0b84d" : "inherit" }}>{title}</summary>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18, maxHeight: 180, overflow: "auto", lineHeight: 1.5 }}>
        {children}
      </ul>
    </details>
  );
}

function reasonLabel(r: "circulation" | "too-small" | "no-storey" | "degenerate"): string {
  switch (r) {
    case "circulation": return "circulation / stairwell";
    case "too-small": return "below the minimum area";
    case "no-storey": return "no containing floor";
    case "degenerate": return "no valid footprint";
  }
}
