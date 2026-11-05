"use client";

// The right-hand validation RAIL (§3 Face 1 — "craves completeness"). Shows the live gauge
// (errors/warnings/units), the ZIP export button (always enabled — law #2: always exportable), and the
// findings list. Clicking a finding jumps the editor to the offending entity (guided, not gated).

import { useMemo, useState } from "react";
import type { PackApi, Selection } from "./usePack";
import { totalUnits } from "@/lib/pack";
import { type Finding, validatePack } from "@/lib/validate";
import { toZip } from "@/lib/export";

export function Rail({ api }: { api: PackApi }) {
  const { pack } = api;
  const result = useMemo(() => validatePack(pack), [pack]);
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
      </div>

      <div className="mm-findings">
        {result.findings.length === 0 ? (
          <div className="mm-allclear">✓ Nothing to fix.<br />Ready to export.</div>
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
