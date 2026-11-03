// ─────────────────────────────────────────────────────────────────────────────
// lib/ifc-browser.ts — IFC-import arc Slice 3: the BROWSER glue (the WASM coupling).
//
// Slices 1+2 are PURE (lib/ifc-import.ts extractor + lib/ifc-to-project.ts mapping), unit-tested with no
// WASM via the injected `IfcReader` seam. This module is the ONE place that actually loads web-ifc's WASM,
// opens a real IFC byte buffer, and runs the whole chain:
//
//     bytes → IfcAPI.OpenModel → readerFromIfcApi → extractIfcSlice → ifcSliceToProject
//
// It is browser-only (dynamic `import("web-ifc")` + a WASM blob) and deliberately thin — no test coverage
// here; the logic it wires is all tested upstream. Keeping it isolated means the Studio panel never imports
// web-ifc directly, and a future adapter (a server parse, a worker) swaps only this file.
//
// ── The WASM-locate (the thing Slice 3 had to resolve) ──
// web-ifc needs its ~1.6 MB `web-ifc.wasm` at runtime. We copy it to `public/web-ifc/web-ifc.wasm` and point
// IfcAPI at it with SetWasmPath. Under the static-export subpath (basePath "/mm" or "/vrx/mm") a bare
// "/web-ifc/" would 404, so we prefix with NEXT_PUBLIC_MM_BASE_PATH (="" in dev). forceSingleThread=true
// avoids the cross-origin-isolation (SharedArrayBuffer) requirement of the MT wasm.
// ─────────────────────────────────────────────────────────────────────────────

import { extractIfcSlice, readerFromIfcApi, type IfcSlice } from "./ifc-import";
import { ifcSliceToProject, type IfcToProjectOpts, type MapReport } from "./ifc-to-project";
import type { AuthoredProject } from "./project";

export interface IfcImportResult {
  project: AuthoredProject;
  report: MapReport;
  slice: IfcSlice; // the raw extracted slice (for debugging / a future deeper review)
}

/** The public-asset prefix for the web-ifc WASM — basePath-aware ("" in dev, "/mm" or "/vrx/mm" on export). */
function wasmPrefix(): string {
  const base = process.env.NEXT_PUBLIC_MM_BASE_PATH || "";
  return `${base}/web-ifc/`;
}

/**
 * Parse a real IFC file (its bytes) all the way to an AuthoredProject + a MapReport.
 * Browser-only: it dynamically loads web-ifc's WASM. Throws on a WASM-load / open failure (the panel catches).
 */
export async function parseIfcBytes(
  bytes: Uint8Array,
  opts: IfcToProjectOpts = {}
): Promise<IfcImportResult> {
  // Dynamic import so web-ifc's WASM is only pulled in when the user actually imports (keeps it out of the
  // initial bundle + off the server). web-ifc ships CJS; the default export carries IfcAPI.
  const webifc: any = await import("web-ifc");
  const IfcAPICtor = webifc.IfcAPI ?? webifc.default?.IfcAPI;
  if (!IfcAPICtor) throw new Error("web-ifc: IfcAPI not found on the module");

  const api = new IfcAPICtor();
  // absolute=true → web-ifc uses the path from the site root (e.g. "/web-ifc/"), NOT relative to the JS chunk
  // URL. With absolute=false it resolved to /_next/static/chunks/web-ifc/web-ifc.wasm and 404'd (live fix).
  api.SetWasmPath(wasmPrefix(), /* absolute */ true);
  await api.Init(undefined, /* forceSingleThread */ true);

  let modelID = -1;
  try {
    modelID = api.OpenModel(bytes);
    const reader = readerFromIfcApi(api, modelID);
    const slice = extractIfcSlice(reader);
    const { project, report } = ifcSliceToProject(slice, opts);
    return { project, report, slice };
  } finally {
    try {
      if (modelID >= 0) api.CloseModel(modelID);
    } catch {
      /* best-effort cleanup */
    }
  }
}
