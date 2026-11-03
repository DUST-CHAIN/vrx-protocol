"use client";

// The permanent left FRAME (MM_ENGINE_AND_FACES §2). Face switch + theme switches live here always.
// The NAV BODY is FACE-AWARE:
//   Structured — the ENTITY TREE (Dev → Co → Cplx → Bldg → Units → Terms). Selecting anything opens its
//               form/grid in the main work area to add or edit. Law #1: every node is clickable in any order.
//   Studio     — the GEOMETRY TREE (pack.geo[]: land → building → floor → unit → prop). Selecting a node
//               focuses/zooms it on the canvas (via geo.focus / geo.selectNode).
//   Preview    — a READ-ONLY building → unit navigator. No edit/Add affordances; selecting a unit jumps
//               the preview to that unit's detail.

import { useState } from "react";
import Link from "next/link";
import type { PackApi, Selection } from "./usePack";
import type { ChromeApi } from "./useChrome";
import type { GeoApi } from "./useGeo";
import { ACCENTS } from "./useChrome";
import { SettingsPanel } from "./SettingsPanel";
import { ImportIfcPanel } from "./ImportIfcPanel";
import { totalUnits } from "@/lib/pack";
import { ancestorsOf, childrenOf, KIND_LABEL, nodeById, rootNodes } from "@/lib/geo";

//  Unit TYPE key → the portal's floor-plan filename PREFIX. MUST stay in sync with portal/lib/floorplans.ts
// TYPE_PREFIX (MM can't import it — the @/ alias is scoped to portal/mm, so the portal's lib/ is out of reach).
// MM's typeKey vocabulary matches the portal's (studio|1br|2br|… — see ai-build.ts), so the same map applies.
const TRACER_TYPE_PREFIX: Record<string, string> = {
  studio: "STD", "1br": "1BR", "2br": "2BR", "3br": "3BR", "4br": "4BR", shop: "SHP", duplex: "DPX", penthouse: "PTH",
};
const slugifyBuilding = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The expected portal floor-plan SLOT for MM's selected unit: floorplans/<building-slug>/units/<PREFIX>_<SUB>.ext
 *  (always .jpg — the portal's unit plans are .jpg). Returns the relPath (no leading slash) or null when the
 *  selection isn't a unit with a resolvable type (then we open the plain review grid instead). The file need NOT
 * exist — a missing slot is an INVITATION to draw it (the tracer opens blank, Lock creates the plan). */
function selectedUnitSlot(pack: import("@/lib/pack").Pack, selectedId?: string): string | null {
  const node = nodeById(pack, selectedId);
  if (!node || node.kind !== "unit" || !node.subtypeRef) return null;
  const prefix = TRACER_TYPE_PREFIX[node.subtypeRef.typeKey];
  if (!prefix) return null; // type has no plan family (or an unknown key) → fall back to the grid
  const building = ancestorsOf(pack, selectedId).find((a) => a.kind === "building");
  if (!building?.name) return null;
  const sub = (node.subtypeRef.subtypeKey || "A").toUpperCase();
  return `floorplans/${slugifyBuilding(building.name)}/units/${prefix}_${sub}.jpg`;
}

/** URL of the portal's floor-plan tracer, from MM. When `slot` is given, DEEP-LINKS the tracer straight to
 *  that unit's plan image (?img=…); else opens the plain /admin/images review grid.
 *  Topology-aware (computed at click time, browser only):
 *   • LOCAL DEV — MM runs on :3021, the portal (/admin/images lives there) on :3011, two SEPARATE dev servers; a
 *     relative link would 404 on :3021, so we hop to the portal dev port.
 *   • IN-PORTAL DEPLOY — MM static export is co-served with the portal on ONE origin under /vrx/mm; the portal's
 *     admin route is at the origin root → strip the trailing /mm from the MM base path. */
function tracerHref(slot: string | null): string {
  const path = slot ? `/admin/images/tracer?img=/${slot}` : "/admin/images";
  if (typeof window !== "undefined" && window.location.port === "3021") {
    return `${window.location.protocol}//${window.location.hostname}:3011${path}`; // dev: portal server
  }
  const base = (process.env.NEXT_PUBLIC_MM_BASE_PATH || "").replace(/\/mm$/, "");
  return `${base}${path}`;
}

export function Frame({
  api,
  chrome,
  geo,
}: {
  api: PackApi;
  chrome: ChromeApi;
  geo: GeoApi;
}) {
  const { pack } = api;

  // "New project" is two-step (it wipes the current project) — the first click ARMS ("Discard & start new?"),
  // a second within the armed window runs it; clicking elsewhere disarms. Same guard idiom as the tree's delete-X.
  const [newArmed, setNewArmed] = useState(false);
  //  IFC import modal — dev-only; drives parse → review → load.
  const [ifcOpen, setIfcOpen] = useState(false);
  // (D-) status line for the "import traced plan" action (the tracer→MM data-merge READ side).
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // IMPORT the traced plan the tracer saved for the selected unit (D-). The tracer POSTs a TracedUnitPlan
  // sidecar keyed by the unit's plan path; here we fetch it and apply it to the SUBTYPE plan via setSubtypePlan —
  // the one write path (so this lands exactly like authoring the shape in Studio, shared by every unit of the
  // subtype). Structural shape: the sidecar carries a 0..1 poly footprint + door/window/wall markers (MM's
  // UnitPlan subset); rooms/furniture aren't carried yet (the planned full-fidelity upgrade).
  async function importTracedPlan() {
    const node = nodeById(pack, geo.selectedId);
    const slot = selectedUnitSlot(pack, geo.selectedId);
    if (!node || node.kind !== "unit" || !node.subtypeRef || !slot) {
      setImportMsg("Select a unit with a type first.");
      return;
    }
    const building = ancestorsOf(pack, node.id).find((a) => a.kind === "building");
    if (!building?.name) { setImportMsg("No building for this unit."); return; }
    setImportMsg("Looking for a traced plan…");
    try {
      // The tracer and MM are co-served under one origin in deploy; hop to :3011 only in local dev (:3021).
      const base = typeof window !== "undefined" && window.location.port === "3021"
        ? `${window.location.protocol}//${window.location.hostname}:3011`
        : (process.env.NEXT_PUBLIC_MM_BASE_PATH || "").replace(/\/mm$/, "");
      const j = await fetch(`${base}/api/admin/images/plan?relPath=${encodeURIComponent(slot)}`).then((r) => r.json());
      if (!j.ok || !j.plan) { setImportMsg("No traced plan saved for this unit yet — trace it and use 🧩 Send plan to MM first."); return; }
      const p = j.plan as { footprint?: { shape?: string; points?: { x: number; y: number }[] }; markers?: unknown[]; backdrop?: { dataUrl: string; mime: string } };
      if (p.footprint?.shape !== "poly" || !Array.isArray(p.footprint.points) || p.footprint.points.length < 3) {
        setImportMsg("The saved plan is malformed (no poly footprint)."); return;
      }
      // Build the UnitPlan subset MM stores (drop the adapter's provenance/targetSqm extras; UnitPlan is the shape).
      const plan: import("@/lib/pack").UnitPlan = {
        footprint: { shape: "poly", points: p.footprint.points },
        ...(Array.isArray(p.markers) && p.markers.length ? { markers: p.markers as import("@/lib/pack").UnitPlan["markers"] } : {}),
        ...(p.backdrop?.dataUrl ? { backdrop: { dataUrl: p.backdrop.dataUrl, mime: p.backdrop.mime } } : {}),
      };
      const buildingId = building.id.replace(/-bld$/, "");
      api.setSubtypePlan(buildingId, node.subtypeRef.typeKey, node.subtypeRef.subtypeKey, plan);
      const nMarkers = plan.markers?.length ?? 0;
      setImportMsg(`✅ Imported. This subtype now uses the traced outline${nMarkers ? ` + ${nMarkers} marker${nMarkers === 1 ? "" : "s"}` : ""} — every unit of this type renders it. Open Studio to see/edit it.`);
    } catch (e) {
      setImportMsg(`Error: ${e instanceof Error ? e.message : "import failed"}`);
    }
  }

  return (
    <aside className="mm-frame" onClick={() => newArmed && setNewArmed(false)}>
      <div className="mm-frame__head">
        <div className="mm-brand" title="VRX · NEAR Model Maker">
          <span className="mm-brand__dot" />
          VRX · NEAR Model Maker
        </div>

        {/* The three FACES — one workspace, three ways to work on the same project (label pass: each carries a
            plain-language sub-label so a first-timer knows what it's for). Structured = the facts; Studio = draw the
            plan; Preview = what the buyer sees. */}
        <div className="mm-faceswitch" role="group" aria-label="View">
          <button
            aria-pressed={chrome.face === "structured"}
            onClick={() => chrome.setFace("structured")}
            title="Structured — enter the facts: the developer, buildings, unit types, sizes, prices and payment plans, in a clear tree."
          >
            Structured<span className="mm-faceswitch__sub">the facts</span>
          </button>
          <button
            aria-pressed={chrome.face === "studio"}
            onClick={() => chrome.setFace("studio")}
            title="Studio — draw the plan: lay out the land and each building's floor plans on the drawing board; sizes and prices roll up."
          >
            Studio<span className="mm-faceswitch__sub">draw the plan</span>
          </button>
          <button
            aria-pressed={chrome.face === "preview"}
            onClick={() => chrome.setFace("preview")}
            title="Preview — what the buyer sees: exactly the VRX developer/buyer view of this pack, ready to export."
          >
            Preview<span className="mm-faceswitch__sub">what buyers see</span>
          </button>
        </div>

        {/* The from-scratch AI generator is a SEPARATE part (: "structure by code first; the full AI
            generator is separate"). A small SECONDARY link — structure leads, this is the side entrance. */}
        <Link
          href="/ai"
          className="mm-frame__aidoor"
          title="Generate a whole building from one line of text (a separate AI generator) — then refine it here"
        >
          ✦ New from AI →
        </Link>

        <details className="mm-theme">
          <summary className="mm-theme__summary">
            <span className="mm-theme__label">Theme</span>
            <span className="mm-theme__current">
              {chrome.mode === "light" ? "☀ Light" : "☾ Dark"}
              <span className="mm-theme__dot" style={{ background: chrome.accent }} />
            </span>
          </summary>
          <div className="mm-theme__body">
            <button
              className="mm-mode-toggle"
              onClick={chrome.toggleMode}
              title={`Switch to ${chrome.mode === "light" ? "dark" : "light"} mode`}
            >
              <span className={chrome.mode === "light" ? "on" : ""}>☀ Light</span>
              <span className={chrome.mode === "dark" ? "on" : ""}>☾ Dark</span>
            </button>
            <div className="mm-swatches" role="group" aria-label="Accent colour">
              {ACCENTS.map((a) => (
                <button
                  key={a.key}
                  className="mm-swatch"
                  aria-pressed={chrome.accent === a.value}
                  title={a.label}
                  style={{ background: a.value }}
                  onClick={() => chrome.setAccent(a.value)}
                />
              ))}
            </div>
          </div>
        </details>

        <SettingsPanel />
      </div>

      {/* Face-aware nav body */}
      {chrome.face === "studio" ? (
        <GeoTreeNav api={api} geo={geo} />
      ) : chrome.face === "preview" ? (
        <PreviewNav api={api} geo={geo} />
      ) : (
        <StructuredNav api={api} />
      )}

      <div className="mm-frame__foot">
        {chrome.face !== "preview" && (
          <button
            className="mm-tree__add"
            title="Load Aurora Tower — a large 34-storey sample (shops → penthouses + sky duplexes) to explore in every face"
            onClick={() => {
              const id = api.loadMiracleTower();
              if (chrome.face === "structured") api.select({ kind: "building", id });
              else chrome.setFace("preview");
            }}
          >
            ⬇ Load sample building
          </button>
        )}
        {chrome.face !== "preview" && (
          <button
            className={newArmed ? "mm-newproj mm-newproj--armed" : "mm-newproj"}
            title="Start a fresh, blank project (one empty building to grow) — discards the current project"
            onClick={(e) => {
              e.stopPropagation(); // don't let the frame's disarm handler eat this click
              if (newArmed) {
                api.loadEmpty();
                if (chrome.face !== "structured") chrome.setFace("structured");
                setNewArmed(false);
              } else {
                setNewArmed(true);
              }
            }}
          >
            {newArmed ? "✓? Discard & start new" : "✎ New project"}
          </button>
        )}
        {/*  DEV-ONLY test-data faucet — a fresh metre-native building on a TILTED plot, so the rotation
            work (Slice 4 building-hugs-plot) is verifiable on demand instead of nursing the Skyline fixture.
            Gated to dev builds (process.env.NODE_ENV) → invisible in the hosted /vrx/mm export. */}
        {process.env.NODE_ENV !== "production" && chrome.face !== "preview" && (
          <button
            className="mm-newproj"
            title="DEV: generate a fresh metre-native test building on a 20° tilted plot (replaces the current project)"
            onClick={(e) => {
              e.stopPropagation();
              const id = api.loadGenerated({ plotRotationDeg: 20 });
              if (chrome.face === "structured") api.select({ kind: "building", id });
              else if (chrome.face !== "studio") chrome.setFace("studio");
            }}
          >
            ⚡ Generate test building
          </button>
        )}
        {/*  DEV-ONLY IFC import — load a real CAD building (floors + room footprints) via web-ifc.
            Gated to dev builds (process.env.NODE_ENV) like the faucet → invisible in the hosted /vrx/mm export. */}
        {process.env.NODE_ENV !== "production" && chrome.face !== "preview" && (
          <button
            className="mm-newproj"
            title="DEV: import a real CAD building from an IFC file (floors + room footprints, to scale)"
            onClick={(e) => {
              e.stopPropagation();
              setIfcOpen(true);
            }}
          >
            📐 Import IFC
          </button>
        )}
        {/*  Floor-plan tracer — the review-and-replace tool. Opens the portal's /admin/images grid in a new
            tab: review all floorplans/renderings, redraw the poor ones in the tracer, lock→replace in place.
            ALWAYS SHOWN (unlike the dev-only faucet/IFC): it is a real operator tool, and the hosted MM export runs
            in NODE_ENV=production — so a NODE_ENV gate would hide it in exactly the in-portal deploy where it works.
            The href is base-path aware (NEXT_PUBLIC_MM_BASE_PATH minus the trailing /mm → the portal base), so it
            resolves to the co-served portal's /admin/images. DESTROY-SAFE by design: the replace API itself 403s any
            non-operator (VRX_OPERATOR_SECRET), so a non-root viewer can browse + trace but never overwrite a server
            image. Hidden only in the read-only Preview face (the buyer view). */}
        {chrome.face !== "preview" && (() => {
          const slot = selectedUnitSlot(pack, geo.selectedId);
          return (
            <a
              className="mm-newproj"
              href={tracerHref(slot)}
              target="_blank"
              rel="noopener noreferrer"
              title={
                slot
                  ? `Floor-plan tracer → this unit's plan (${slot.split("/").pop()}). Opens in a new tab; if the unit has no plan yet you can draw one and save it. Saving is operator-only.`
                  : "Floor-plan tracer: review all plans/images and replace poor ones with freshly drawn plans (opens in a new tab; saving is operator-only). Select a unit first to jump straight to its plan."
              }
              onClick={(e) => e.stopPropagation()}
            >
              {slot ? "🖊 Trace this unit's plan" : "🖊 Floor-plan tracer"}
            </a>
          );
        })()}
        {/* (D-) IMPORT a traced plan the tracer saved for this unit — the data-merge READ side. Shown only
            when a unit with a resolvable plan slot is selected (same gate as the Trace link). */}
        {chrome.face !== "preview" && selectedUnitSlot(pack, geo.selectedId) && (
          <button
            className="mm-newproj"
            onClick={(e) => { e.stopPropagation(); void importTracedPlan(); }}
            title="Import the shape + door/window/wall markers you traced for this unit into its subtype plan (shared by every unit of this type). Trace + 🧩 Send plan to MM first."
          >
            🧩 Import traced plan
          </button>
        )}
        {importMsg && (
          <div className="mm-frame__summary" style={{ color: importMsg.startsWith("Error") || importMsg.startsWith("No ") || importMsg.startsWith("Select") || importMsg.startsWith("The saved") ? "#e06b6b" : "#6bd6a0" }}>
            {importMsg} <button onClick={(e) => { e.stopPropagation(); setImportMsg(null); }} style={{ marginLeft: 6, background: "none", border: "none", color: "inherit", cursor: "pointer", textDecoration: "underline", font: "inherit" }}>dismiss</button>
          </div>
        )}
        <div className="mm-frame__summary">
          {pack.buildings.length} building{pack.buildings.length === 1 ? "" : "s"} · {totalUnits(pack)} units total
        </div>
      </div>

      {ifcOpen && (
        <ImportIfcPanel
          api={api}
          onClose={() => setIfcOpen(false)}
          onLoaded={(sel) => {
            // Land the user where they can see the imported geometry: Studio for the plan, select the building.
            if (chrome.face === "preview") chrome.setFace("studio");
            if (chrome.face === "structured") api.select(sel);
          }}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// STRUCTURED nav — entity tree (unchanged from before)
// ---------------------------------------------------------------------------
function StructuredNav({ api }: { api: PackApi }) {
  const { pack, selection, select } = api;
  const sel = (s: Selection) => selectedKey(selection) === selectedKey(s);

  // Two-step, in-place delete (the choice): the first ✕ ARMS a node (shows "✓?"); a second click within
  // the armed window deletes; clicking anything else disarms. No modal — the row guards itself against a stray
  // single click. Keyed by "kind:id" so only one node is armed at a time. After a delete we select the developer
  // (always present) so the Editor never dangles on a just-removed node.
  const [armed, setArmed] = useState<string | null>(null);

  // A delete is safe to OFFER when removing won't leave the project in an invalid state: the last complex can't be
  // removed (a project needs ≥1 development), so hide the ✕ on a lone complex.
  const canDeleteComplex = pack.complexes.length > 1;

  const del = (key: string, run: () => void) => {
    if (armed === key) { run(); setArmed(null); select({ kind: "developer" }); }
    else setArmed(key);
  };

  return (
    <nav className="mm-tree" onClick={() => armed && setArmed(null)}>
      <div className="mm-tree__section">Your development</div>

      <div className="mm-node" aria-selected={sel({ kind: "developer" })} onClick={() => select({ kind: "developer" })}>
        <span className="mm-node__twist">▾</span>
        <span className="mm-tag mm-tag--dev">Developer</span>
        <span className="mm-node__name">{pack.developer.name || "Developer"}</span>
      </div>

      {pack.companies.map((c) => (
        <div
          key={c.id}
          className="mm-node mm-node--child"
          aria-selected={sel({ kind: "company", id: c.id })}
          onClick={() => select({ kind: "company", id: c.id })}
        >
          <span className="mm-tag mm-tag--co">Company</span>
          <span className="mm-node__name">{c.name || c.id}</span>
          <DeleteX armedKey={`company:${c.id}`} armed={armed} setArmed={setArmed}
            onDelete={() => del(`company:${c.id}`, () => api.removeCompany(c.id))} label={c.name || c.id} />
        </div>
      ))}
      <button className="mm-tree__add mm-tree__add--indent" onClick={() => select({ kind: "company", id: api.addCompany() })}>
        Add company
      </button>

      {pack.complexes.map((cx) => (
        <div className="mm-tree__group" key={cx.id}>
          <div
            className="mm-node mm-node--child"
            aria-selected={sel({ kind: "complex", id: cx.id })}
            onClick={() => select({ kind: "complex", id: cx.id })}
          >
            <span className="mm-node__twist">▾</span>
            <span className="mm-tag mm-tag--cx">Development</span>
            <span className="mm-node__name">{cx.name || cx.id}</span>
            {canDeleteComplex && (
              <DeleteX armedKey={`complex:${cx.id}`} armed={armed} setArmed={setArmed}
                onDelete={() => del(`complex:${cx.id}`, () => api.removeComplex(cx.id))}
                label={`${cx.name || cx.id} and its buildings`} />
            )}
          </div>
          {pack.buildings
            .filter((b) => b.complexId === cx.id)
            .map((b) => (
              <div key={b.id}>
                <div
                  className="mm-node mm-node--gchild"
                  aria-selected={sel({ kind: "building", id: b.id })}
                  onClick={() => select({ kind: "building", id: b.id })}
                >
                  <span className="mm-tag mm-tag--bl">Building</span>
                  <span className="mm-node__name">{b.name || b.id}</span>
                  <span className="mm-node__count">{(pack.buildingUnits[b.id] || []).length}</span>
                  <DeleteX armedKey={`building:${b.id}`} armed={armed} setArmed={setArmed}
                    onDelete={() => del(`building:${b.id}`, () => api.removeBuilding(b.id))}
                    label={`${b.name || b.id} and its units`} />
                </div>
                <div
                  className="mm-node mm-node--gchild mm-node--leaf"
                  style={{ marginLeft: 42, width: "auto" }}
                  aria-selected={sel({ kind: "units", buildingId: b.id })}
                  onClick={() => select({ kind: "units", buildingId: b.id })}
                >
                  <span className="mm-tag mm-tag--un">Units</span>
                  <span className="mm-node__name">{(pack.buildingUnits[b.id] || []).length} units</span>
                </div>
              </div>
            ))}
          <button
            className="mm-tree__add mm-tree__add--indent"
            style={{ marginLeft: 42, width: "calc(100% - 42px)" }}
            onClick={() => select({ kind: "building", id: api.addBuilding(cx.id) })}
          >
            Add building
          </button>
        </div>
      ))}
      {/* N complexes (3c-iii): a project holds multiple developments, each with its own buildings. */}
      <button
        className="mm-tree__add mm-tree__add--indent"
        title="Add another development (a plot of land holding its own buildings) to this project."
        onClick={() => select({ kind: "complex", id: api.addComplex() })}
      >
        Add development
      </button>

      <div className="mm-tree__section">Payment plans</div>
      {pack.terms.map((t) => (
        <div
          key={t.id}
          className="mm-node mm-node--child"
          aria-selected={sel({ kind: "terms", id: t.id })}
          onClick={() => select({ kind: "terms", id: t.id })}
        >
          <span className="mm-tag mm-tag--tm">Payment plan</span>
          <span className="mm-node__name">{t.id}</span>
          <DeleteX armedKey={`terms:${t.id}`} armed={armed} setArmed={setArmed}
            onDelete={() => del(`terms:${t.id}`, () => api.removeTerms(t.id))} label={t.id} />
        </div>
      ))}
      <button className="mm-tree__add mm-tree__add--indent" onClick={() => select({ kind: "terms", id: api.addTerms() })}>
        Add payment plan
      </button>

      <div className="mm-node" aria-selected={sel({ kind: "texts" })} onClick={() => select({ kind: "texts" })}>
        <span className="mm-node__name">Texts</span>
        <span className="mm-node__count">{Object.keys(api.pack.texts || {}).length}</span>
      </div>
    </nav>
  );
}

/** A two-step, in-place delete control for a tree row. Idle = a faint ✕; armed = a red "✓?" the user clicks again
 *  to confirm. stopPropagation on every click so arming/deleting never also SELECTS the row. The parent owns the
 *  armed key (so only one row is armed at a time; clicking the tree background disarms). */
function DeleteX({
  armedKey, armed, setArmed, onDelete, label,
}: {
  armedKey: string;
  armed: string | null;
  setArmed: (k: string | null) => void;
  onDelete: () => void;
  label: string;
}) {
  const isArmed = armed === armedKey;
  return (
    <button
      className="mm-node__del"
      title={isArmed ? `Click again to delete "${label}"` : `Delete "${label}"`}
      aria-label={isArmed ? `Confirm delete ${label}` : `Delete ${label}`}
      onClick={(e) => { e.stopPropagation(); onDelete(); }}
      style={{
        marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer",
        font: "inherit", fontSize: 11, lineHeight: 1, padding: "2px 6px", borderRadius: 4,
        color: isArmed ? "#ff5c6c" : "var(--faint, #6b7a90)",
        fontWeight: isArmed ? 700 : 400,
      }}
    >
      {isArmed ? "✓ sure?" : "✕"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// STUDIO nav — geometry tree (pack.geo[]) mirroring the canvas focus/selection
// ---------------------------------------------------------------------------
function GeoTreeNav({ api, geo }: { api: PackApi; geo: GeoApi }) {
  const nodes = api.pack.geo || [];
  const roots = rootNodes(api.pack);
  const hasNodes = nodes.length > 0;

  return (
    <nav className="mm-tree">
      <div className="mm-tree__section">Geometry tree</div>
      {!hasNodes && (
        <div className="mm-empty" style={{ padding: "12px 16px", fontSize: 12 }}>
          No geometry yet. Use "+ Add land parcel" on the canvas to begin.
        </div>
      )}
      {roots.map((root) => (
        <GeoSubtree key={root.id} pack={api.pack} geo={geo} nodeId={root.id} depth={0} />
      ))}
      {hasNodes && (
        <button className="mm-tree__add mm-tree__add--indent" onClick={() => geo.addRoot()}>
          + Add {rootNodes(api.pack).some((n) => n.kind === "land") ? "building" : "land parcel"}
        </button>
      )}
    </nav>
  );
}

function GeoSubtree({
  pack,
  geo,
  nodeId,
  depth,
}: {
  pack: import("@/lib/pack").Pack;
  geo: GeoApi;
  nodeId: string;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const node = (pack.geo || []).find((n) => n.id === nodeId);
  if (!node) return null;
  const children = childrenOf(pack, nodeId).filter((c) => c.kind !== "prop"); // props are leaf furniture, don't clutter
  const isFocused = geo.focusId === nodeId;
  const isSelected = geo.selectedId === nodeId;

  const GEO_TAG: Record<string, string> = {
    land: "Land", building: "Bldg", floor: "Flr", unit: "Unit", prop: "Prop", project: "Proj",
  };
  const GEO_TAG_CLASS: Record<string, string> = {
    land: "mm-tag--cx", building: "mm-tag--bl", floor: "mm-tag--un", unit: "mm-tag--co", prop: "mm-tag--tm", project: "mm-tag--dev",
  };

  const indentPx = 10 + depth * 14;

  return (
    <>
      <div
        className={`mm-node${isFocused ? " mm-node--focused" : ""}${isSelected ? " mm-node--selected" : ""}`}
        aria-selected={isSelected}
        style={{ paddingLeft: indentPx }}
        onClick={() => {
          // Make the MAIN canvas reflect the clicked node AND keep it selected (before, the canvas
          // only updated for building/floor, and focus CLEARS the selection, so the inspector went blank).
          // A container (land/building/floor) → focus it (draw its children inside); a leaf (unit/prop) → focus
          // its PARENT so it's visible among siblings. focus runs FIRST (it clears selection), then we select.
          const isContainer = node.kind === "land" || node.kind === "building" || node.kind === "floor";
          geo.focus(isContainer ? nodeId : node.parentId);
          geo.selectNode(nodeId);
        }}
        onDoubleClick={() => geo.focus(nodeId)}
        title={`Click to view + select · double-click to zoom into this ${KIND_LABEL[node.kind].toLowerCase()}`}
      >
        {children.length > 0 ? (
          <span
            className="mm-node__twist"
            onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }}
            style={{ cursor: "pointer" }}
          >
            {expanded ? "▾" : "▸"}
          </span>
        ) : (
          <span className="mm-node__twist" style={{ opacity: 0.3 }}>·</span>
        )}
        <span className={`mm-tag ${GEO_TAG_CLASS[node.kind] || ""}`}>{GEO_TAG[node.kind] || node.kind}</span>
        <span className="mm-node__name">{node.name || node.id}</span>
        {node.kind === "floor" && childrenOf(pack, nodeId).filter((c) => c.kind === "unit").length > 0 && (
          <span className="mm-node__count">{childrenOf(pack, nodeId).filter((c) => c.kind === "unit").length}u</span>
        )}
        {/* (parked item 2) approved-floor ✓ — a SPARSE positive mark (only confirmed floors carry it, so
            walking bottom-up it fills in as you approve; unconfirmed = simply no check, not 34 warning badges). */}
        {node.kind === "floor" && node.confirmed && (
          <span className="mm-node__ok" title="Approved">✓</span>
        )}
      </div>
      {expanded && children.map((child) => (
        <GeoSubtree key={child.id} pack={pack} geo={geo} nodeId={child.id} depth={depth + 1} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// PREVIEW nav — read-only building → unit list; selecting a unit opens its detail
// ---------------------------------------------------------------------------
function PreviewNav({ api, geo: _geo }: { api: PackApi; geo: GeoApi }) {
  const { pack, selection, select } = api;
  const [openBuildingId, setOpenBuildingId] = useState<string | null>(
    // default-open whichever building is currently in the selection
    selection.kind === "building" ? selection.id :
    selection.kind === "units" ? selection.buildingId :
    pack.buildings[0]?.id || null
  );

  return (
    <nav className="mm-tree">
      <div className="mm-tree__section">Buildings</div>
      {pack.buildings.length === 0 && (
        <div className="mm-empty" style={{ padding: "12px 16px", fontSize: 12 }}>
          No buildings yet. Add one in Structured.
        </div>
      )}
      {pack.buildings.map((b) => {
        const units = pack.buildingUnits[b.id] || [];
        const isOpen = openBuildingId === b.id;
        return (
          <div key={b.id}>
            <div
              className="mm-node mm-node--child"
              onClick={() => setOpenBuildingId(isOpen ? null : b.id)}
            >
              <span className="mm-node__twist" style={{ cursor: "pointer" }}>{isOpen ? "▾" : "▸"}</span>
              <span className="mm-tag mm-tag--bl">Bldg</span>
              <span className="mm-node__name">{b.name || b.id}</span>
              <span className="mm-node__count">{units.length}</span>
            </div>
            {isOpen && (
              <div className="mm-preview-nav__units">
                {/* Group units by floor */}
                {Array.from(new Set(units.map((u) => u.floor))).sort((a, b) => b - a).map((floor) => (
                  <div key={floor}>
                    <div className="mm-preview-nav__floor">Floor {floor}</div>
                    {units.filter((u) => u.floor === floor).map((u) => {
                      const isSelected = selection.kind === "building" &&
                        selection.id === b.id; // best proxy until Preview has per-unit selection
                      return (
                        <div
                          key={u.id}
                          className="mm-node mm-node--leaf"
                          style={{ paddingLeft: 32, fontSize: 12 }}
                          onClick={() => {
                            // Switch to building view in preview — the Preview face will show the stacking plan
                            select({ kind: "building", id: b.id });
                          }}
                          title={`${u.id.replace(/^unit-/, "Unit ")} · ${u.type.toUpperCase()} · ${u.sqm}m² · $${Math.round(u.priceUsd / 1000)}k`}
                        >
                          <span className="mm-node__name" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                            {u.id.replace(/^unit-/, "")}
                          </span>
                          <span style={{ marginLeft: 6, opacity: 0.55, fontSize: 11 }}>{u.type}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** Stable key so selection comparison treats {kind,id} as identity. */
function selectedKey(s: Selection): string {
  switch (s.kind) {
    case "company":
    case "complex":
    case "building":
    case "terms":
      return `${s.kind}:${s.id}`;
    case "units":
      return `units:${s.buildingId}`;
    default:
      return s.kind;
  }
}
