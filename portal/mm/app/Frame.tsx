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
import type { PackApi, Selection } from "./usePack";
import type { ChromeApi } from "./useChrome";
import type { GeoApi } from "./useGeo";
import { ACCENTS } from "./useChrome";
import { totalUnits } from "@/lib/pack";
import { childrenOf, KIND_LABEL, rootNodes } from "@/lib/geo";

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

  return (
    <aside className="mm-frame">
      <div className="mm-frame__head">
        <div className="mm-brand">
          <span className="mm-brand__dot" />
          MM
        </div>

        <div className="mm-faceswitch" role="group" aria-label="Face">
          <button aria-pressed={chrome.face === "structured"} onClick={() => chrome.setFace("structured")}>
            Structured
          </button>
          <button
            aria-pressed={chrome.face === "studio"}
            onClick={() => chrome.setFace("studio")}
            title="Studio — the §4d nested drawing board"
          >
            Studio
          </button>
          <button
            aria-pressed={chrome.face === "preview"}
            onClick={() => chrome.setFace("preview")}
            title="Preview / Output — the real VRX developer view of the pack"
          >
            Preview
          </button>
        </div>

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
            title="Load the real Miracle Tower building (476 units) from the VRX catalog — see Preview"
            onClick={() => {
              const id = api.loadMiracleTower();
              if (chrome.face === "structured") api.select({ kind: "building", id });
              else chrome.setFace("preview");
            }}
          >
            ⬇ Load demo building
          </button>
        )}
        <div className="mm-frame__summary">
          {pack.buildings.length} building{pack.buildings.length === 1 ? "" : "s"} · {totalUnits(pack)} units total
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// STRUCTURED nav — entity tree (unchanged from before)
// ---------------------------------------------------------------------------
function StructuredNav({ api }: { api: PackApi }) {
  const { pack, selection, select } = api;
  const sel = (s: Selection) => selectedKey(selection) === selectedKey(s);

  return (
    <nav className="mm-tree">
      <div className="mm-tree__section">Entity tree</div>

      <div className="mm-node" aria-selected={sel({ kind: "developer" })} onClick={() => select({ kind: "developer" })}>
        <span className="mm-node__twist">▾</span>
        <span className="mm-tag mm-tag--dev">Dev</span>
        <span className="mm-node__name">{pack.developer.name || "Developer"}</span>
      </div>

      {pack.companies.map((c) => (
        <div
          key={c.id}
          className="mm-node mm-node--child"
          aria-selected={sel({ kind: "company", id: c.id })}
          onClick={() => select({ kind: "company", id: c.id })}
        >
          <span className="mm-tag mm-tag--co">Co</span>
          <span className="mm-node__name">{c.name || c.id}</span>
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
            <span className="mm-tag mm-tag--cx">Cplx</span>
            <span className="mm-node__name">{cx.name || cx.id}</span>
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
                  <span className="mm-tag mm-tag--bl">Bldg</span>
                  <span className="mm-node__name">{b.name || b.id}</span>
                  <span className="mm-node__count">{(pack.buildingUnits[b.id] || []).length}</span>
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
      <button className="mm-tree__add mm-tree__add--indent" onClick={() => select({ kind: "complex", id: api.addComplex() })}>
        Add complex
      </button>

      <div className="mm-tree__section">Payment terms</div>
      {pack.terms.map((t) => (
        <div
          key={t.id}
          className="mm-node mm-node--child"
          aria-selected={sel({ kind: "terms", id: t.id })}
          onClick={() => select({ kind: "terms", id: t.id })}
        >
          <span className="mm-tag mm-tag--tm">Terms</span>
          <span className="mm-node__name">{t.id}</span>
        </div>
      ))}
      <button className="mm-tree__add mm-tree__add--indent" onClick={() => select({ kind: "terms", id: api.addTerms() })}>
        Add terms
      </button>

      <div className="mm-node" aria-selected={sel({ kind: "texts" })} onClick={() => select({ kind: "texts" })}>
        <span className="mm-node__name">Texts</span>
        <span className="mm-node__count">{Object.keys(api.pack.texts || {}).length}</span>
      </div>
    </nav>
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
          geo.selectNode(nodeId);
          if (node.kind === "building" || node.kind === "floor") geo.focus(nodeId);
        }}
        onDoubleClick={() => geo.focus(nodeId)}
        title={`Double-click to zoom into this ${KIND_LABEL[node.kind].toLowerCase()}`}
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
