"use client";

// The right-hand validation RAIL (§3 Face 1 — "craves completeness"). Shows the live gauge
// (errors/warnings/units), the ZIP export button (always enabled — law #2: always exportable), and the
// findings list. Clicking a finding jumps the editor to the offending entity (guided, not gated).

import { useMemo, useState } from "react";
import type { PackApi, Selection } from "./usePack";
import { totalUnits } from "@/lib/pack";
import { type Finding, validatePack } from "@/lib/validate";
import { buildReadiness, type ReadinessTarget } from "@/lib/readiness";
import { toZip } from "@/lib/export";
import { SealPanel } from "./SealPanel";

export function Rail({ api }: { api: PackApi }) {
  const { pack } = api;
  const result = useMemo(() => validatePack(pack), [pack]);
  const readiness = useMemo(() => buildReadiness(pack), [pack]);
  const [busy, setBusy] = useState(false);

  async function exportZip() {
    setBusy(true);
    try {
      const blob = await toZip(pack);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${pack.developer.id || "pack"}-ingest-pack.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="mm-rail">
      <div className="mm-rail__head">
        <h2 className="mm-rail__title">Validation</h2>
        <div className="mm-rail__gauge">
          <div className={`mm-chip ${result.counts.errors === 0 ? "mm-chip--ok" : "mm-chip--err"}`}>
            {result.counts.errors}
            <small>{result.counts.errors === 0 ? "clean" : "errors"}</small>
          </div>
          <div className="mm-chip mm-chip--warn">
            {result.counts.warnings}
            <small>warnings</small>
          </div>
          <div className="mm-chip mm-chip--ok">
            {totalUnits(pack)}
            <small>units</small>
          </div>
        </div>
      </div>

      <div className="mm-rail__export">
        <button className="mm-btn mm-btn--primary" onClick={exportZip} disabled={busy}>
          {busy ? "Packing…" : "⭳ Export ingest-pack ZIP"}
        </button>
        <div className="mm-rail__note">
          {result.ok
            ? "All checks pass — this is a clean pack."
            : `${result.counts.errors} to fix for a clean pack · export still works (backfilled).`}
        </div>

        {/* NEAR sign-off: the plain export above is always on; a stamped export needs a NEAR account. */}
        <SealPanel api={api} />
      </div>

      <div className="mm-findings">
        {result.findings.length === 0 ? (
          <div className="mm-allclear">✓ No schema errors.<br />Pack is valid to export.</div>
        ) : (
          result.findings.map((f, i) => (
            <button
              key={i}
              className={`mm-finding mm-finding--${f.severity}`}
              style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderLeftWidth: 3, borderLeftStyle: "solid", cursor: "pointer" }}
              onClick={() => api.select(findingTarget(f))}
            >
              <div className="mm-finding__where">{f.where}{f.field ? ` · ${f.field}` : ""}</div>
              <div className="mm-finding__msg">{f.message}</div>
            </button>
          ))
        )}
      </div>

      {/* Completeness report — what hasn't been filled in. Advisory, never blocks export (law #2). */}
      <div className="mm-readiness">
        <div className="mm-readiness__head">
          Completeness
          <span className="mm-readiness__counts">
            {readiness.counts.attention > 0 && <b className="mm-readiness__att">{readiness.counts.attention} to review</b>}
            {readiness.counts.info > 0 && <span className="mm-readiness__info">{readiness.counts.info} notes</span>}
            {readiness.items.length === 0 && <span className="mm-readiness__done">✓ nothing outstanding</span>}
          </span>
        </div>
        {readiness.items.map((it, i) => {
          const clickable = !!it.target;
          return (
            <button
              key={i}
              className={`mm-readiness__item mm-readiness__item--${it.level}`}
              disabled={!clickable}
              onClick={() => it.target && api.select(it.target as Selection)}
              title={clickable ? "jump here to fill it in" : undefined}
            >
              <div className="mm-readiness__label">{it.label}</div>
              {it.detail && <div className="mm-readiness__detail">{it.detail}</div>}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** Map a finding's `where` back to a tree selection so clicking it jumps the editor there. */
function findingTarget(f: Finding): Selection {
  const w = f.where;
  if (w === "developer") return { kind: "developer" };
  if (w.startsWith("company:")) return { kind: "company", id: w.slice("company:".length) };
  if (w.startsWith("complex:")) return { kind: "complex", id: w.slice("complex:".length) };
  if (w.startsWith("building:")) {
    const rest = w.slice("building:".length);
    const id = rest.split(" ")[0]; // "building:<id> / unit row N" → <id>
    // a unit-row finding should open the units grid; a building-level one opens the building form
    return w.includes("unit row") ? { kind: "units", buildingId: id } : { kind: "building", id };
  }
  return { kind: "developer" };
}
