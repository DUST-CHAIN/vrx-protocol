"use client";

// The Studio-face inspector (slice 2) — edits the SELECTED §4d node. Shows the authored-truth m² derived
// from the metre anchor × nested fractions (lib/geo.deriveSqm), lets you set a metre anchor (on a building/
// floor), PIN a node to a real m² (constrainToSqm), set status (units) + price. Add-child / delete here too.

import type { Pack, UnitStatus } from "@/lib/pack";
import {
  CHILD_KIND,
  deriveSqm,
  detectEdgeLinks,
  edgeLengthsMetres,
  KIND_LABEL,
  metreAnchor,
  nodeById,
  realMetres,
  STATUS_LABEL,
  UNIT_STATUSES,
} from "@/lib/geo";
import type { GeoApi } from "./useGeo";
import SiteMap from "@/components/SiteMap";
import { FURNITURE_PACKAGES, PROP_PALETTE, packageByKey, propIcon } from "@/lib/furniture";

export function GeoInspector({ pack, geo }: { pack: Pack; geo: GeoApi }) {
  const node = nodeById(pack, geo.selectedId);

  if (!node) {
    return (
      <aside className="mm-rail">
        <div className="mm-rail__head">
          <h2 className="mm-rail__title">Node</h2>
        </div>
        <div className="mm-empty" style={{ padding: "40px 16px" }}>
          Select a box on the canvas, or draw one, to edit its geometry, size and price.
        </div>
      </aside>
    );
  }

  const sqm = deriveSqm(pack, node.id);
  const rm = realMetres(pack, node.id);
  const anchor = metreAnchor(pack, node.id);
  const childKind = CHILD_KIND[node.kind];
  const canAnchor = node.kind === "building" || node.kind === "floor" || node.kind === "land";
  // The map (geographic truth) belongs on the land/site node — that's the real-world anchor for the whole tree.
  const canSite = node.kind === "land" || node.kind === "project";
  const isPoly = node.footprint?.shape === "poly";
  const frozenV = new Set(isPoly ? (node.footprint as any).frozenVerts || [] : []);
  const frozenE = new Set(isPoly ? (node.footprint as any).frozenEdges || [] : []);
  // which link group each edge belongs to (for the 🔗 badge) + the derived per-edge lengths
  const edgeLens = isPoly ? edgeLengthsMetres(pack, node.id) : [];
  const linkGroups = isPoly ? detectEdgeLinks(pack, node.id) : [];
  const linkOf = (i: number) => linkGroups.findIndex((g) => g.includes(i));

  return (
    <aside className="mm-rail">
      <div className="mm-rail__head">
        <h2 className="mm-rail__title">{KIND_LABEL[node.kind]}</h2>
        <input
          className="mm-geo-name"
          value={node.name}
          onChange={(e) => geo.patchNode(node.id, { name: e.target.value })}
        />
      </div>

      <div className="mm-geo-inspect">
        {/* derived size */}
        <section className="mm-ins-sec">
          <div className="mm-ins-row">
            <span>Area (derived)</span>
            <strong>{sqm != null ? `${sqm.toLocaleString()} m²` : "— set a metre anchor"}</strong>
          </div>
          {rm && (
            <div className="mm-ins-row mm-ins-row--dim">
              <span>Real size</span>
              <span>{rm.w.toFixed(1)} × {rm.h.toFixed(1)} m</span>
            </div>
          )}
          {anchor && (
            <div className="mm-ins-row mm-ins-row--dim">
              <span>Scale from</span>
              <span>{anchor.anchor.name} ({anchor.metreW}×{anchor.metreH} m)</span>
            </div>
          )}
        </section>

        {/* site & location MAP — the geographic source of truth (land/site node). Tracing the parcel seeds the
            metre anchor below; north is kept SEPARATE from the editor rotation (they compose at render). */}
        {canSite && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Site &amp; location</div>
            <SiteMap
              value={node.siteGeo}
              onChange={({ siteGeo, metreExtent }) => geo.setSiteGeo(node.id, siteGeo, metreExtent)}
            />
            <div className="mm-ins-hint">
              Place the pin, trace the land parcel (its size sets the real metre scale below), and set
              geographic north. The building footprint you draw on the canvas is independent — real-world
              bearing comes from the map, not the editor rotation.
            </div>
          </section>
        )}

        {/* metre anchor — only sensible on land/building/floor (the real-world scale source) */}
        {canAnchor && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Real-world size (metre anchor)</div>
            <div className="mm-ins-pair">
              <label>
                Width m
                <input
                  type="number"
                  value={node.metreW ?? ""}
                  placeholder="e.g. 40"
                  onChange={(e) => geo.patchNode(node.id, { metreW: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </label>
              <label>
                Depth m
                <input
                  type="number"
                  value={node.metreH ?? ""}
                  placeholder="e.g. 25"
                  onChange={(e) => geo.patchNode(node.id, { metreH: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="mm-ins-hint">
              Children inherit this scale; set it once on the land, building or floor.
              {node.siteGeo?.landPolygon && node.siteGeo.landPolygon.length >= 2
                ? " Seeded from the map parcel above — edit to override."
                : ""}
            </div>
          </section>
        )}

        {/* floor height → 3D extrusion input */}
        {node.kind === "floor" && (
          <section className="mm-ins-sec">
            <label className="mm-ins-single">
              Floor height m
              <input
                type="number"
                value={node.heightM ?? ""}
                placeholder="3"
                onChange={(e) => geo.patchNode(node.id, { heightM: e.target.value === "" ? undefined : Number(e.target.value) })}
              />
            </label>
            <div className="mm-ins-hint">Carried for the 3D x-ray extrusion (later projection).</div>
          </section>
        )}

        {/* shape: rectangle ↔ polygon (the dimensioned footprint editor) */}
        <section className="mm-ins-sec">
          <div className="mm-ins-label">Footprint shape</div>
          {isPoly ? (
            <button className="mm-btn" onClick={() => geo.toRect(node.id)}>↩ Back to rectangle</button>
          ) : (
            <button className="mm-btn" onClick={() => geo.toPoly(node.id)}>✏ Edit as polygon</button>
          )}
          {isPoly && (
            <div className="mm-ins-hint">
              Drag corners on the canvas. Click an edge-dot to add a vertex; double-click a corner to delete it.
              Right-click a corner or edge-dot to <b>freeze</b> it (held while you adjust the rest).
            </div>
          )}
        </section>

        {/* per-edge length list — the dimension-driven editor */}
        {isPoly && edgeLens.length > 0 && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Edge lengths (m)</div>
            {sqm == null && (
              <div className="mm-ins-hint">Set a metre anchor on the land/building to dimension edges.</div>
            )}
            {sqm != null && (
              <div className="mm-edge-list">
                {edgeLens.map((len, i) => {
                  const g = linkOf(i);
                  return (
                    <EdgeRow
                      key={i}
                      index={i}
                      length={len}
                      linkGroup={g}
                      frozen={frozenE.has(i)}
                      onSet={(m) => geo.setEdgeLength(node.id, i, m)}
                      onFreeze={() => geo.toggleFreezeEdge(node.id, i)}
                    />
                  );
                })}
                <div className="mm-ins-hint">
                  🔗 linked edges (parallel + equal) scale together · ❄ frozen holds its length
                </div>
              </div>
            )}
          </section>
        )}

        {/* frozen-vertices summary (right-click a corner to freeze it) */}
        {isPoly && frozenV.size > 0 && (
          <section className="mm-ins-sec">
            <div className="mm-ins-row mm-ins-row--dim">
              <span>❄ Frozen corners</span>
              <span>{Array.from(frozenV).map((i) => `#${(i as number) + 1}`).join(", ")}</span>
            </div>
          </section>
        )}

        {/* pin to a target m² — rect uses constrainToSqm, poly uses the shoelace scale */}
        {sqm != null && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Constrain to a size</div>
            <PinSqm current={sqm} onPin={(t) => (isPoly ? geo.pinPolySqm(node.id, t) : geo.pinSqm(node.id, t))} />
            <div className="mm-ins-hint">
              {isPoly
                ? "Scales the whole polygon so its real area matches — shape (and every angle) kept."
                : "Scales the box so its real area matches, keeping its shape."}
            </div>
          </section>
        )}

        {/* status (units) */}
        {node.kind === "unit" && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Status</div>
            <select value={node.status ?? "available"} onChange={(e) => geo.setStatus(node.id, e.target.value as UnitStatus)}>
              {UNIT_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </section>
        )}

        {/* §6a furniture package — one action seeds all a package's props into the unit (scaled + relative) */}
        {node.kind === "unit" && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Furniture package</div>
            <FurniturePicker onApply={(key) => geo.applyFurniturePackage(node.id, key)} />
            <div className="mm-ins-hint">
              Seeds the whole layout at once, scaled to the unit — then drag, resize or swap each piece. Props
              are priced inventory (a sofa is a row + a price), not a 3D model.
            </div>
          </section>
        )}

        {/* prop swap — "replace the marker with a bar stool" (§6a). Geometry stays; icon/label/price change. */}
        {node.kind === "prop" && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Swap this piece</div>
            <PropSwap
              current={propIcon(node)}
              onSwap={(icon, label, priceUsd) => geo.swapProp(node.id, icon, label, priceUsd)}
            />
            <div className="mm-ins-hint">Changes the piece type, name and price. Position and size are kept.</div>
          </section>
        )}

        {/* price — any node may carry one (rule 2) */}
        <section className="mm-ins-sec">
          <label className="mm-ins-single">
            Price USD
            <input
              type="number"
              value={node.price?.amountUsd ?? ""}
              placeholder="0"
              onChange={(e) =>
                geo.patchNode(node.id, {
                  price: e.target.value === "" ? undefined : { amountUsd: Number(e.target.value), label: node.price?.label },
                })
              }
            />
          </label>
        </section>

        {/* actions */}
        <section className="mm-ins-sec mm-ins-actions">
          {childKind && (
            <button className="mm-btn mm-btn--primary" onClick={() => { geo.focus(node.id); geo.addChild(childKind, node.id); }}>
              + Add {KIND_LABEL[childKind].toLowerCase()} inside
            </button>
          )}
          {node.kind === "unit" && (
            <button className="mm-btn" onClick={() => geo.duplicateNode(node.id)}>
              ⧉ Duplicate unit
            </button>
          )}
          <button className="mm-btn mm-btn--danger" onClick={() => geo.removeNode(node.id)}>
            Delete {KIND_LABEL[node.kind].toLowerCase()}
          </button>
        </section>
      </div>
    </aside>
  );
}

import { useEffect, useState } from "react";

/** One editable edge-length row: "edge N  [ 50.0 ] m  🔗A  ❄". Typing a length moves the vertex (linked edges follow). */
function EdgeRow({
  index, length, linkGroup, frozen, onSet, onFreeze,
}: {
  index: number;
  length: number;
  linkGroup: number; // -1 = not linked; else a group index → a letter badge
  frozen: boolean;
  onSet: (metres: number) => void;
  onFreeze: () => void;
}) {
  const [val, setVal] = useState<string>(length.toFixed(1));
  // keep the input in sync when the geometry changes elsewhere (a linked edge, a pin, a drag)
  useEffect(() => setVal(length.toFixed(1)), [length]);
  const commit = () => {
    const m = Number(val);
    if (m > 0 && Math.abs(m - length) > 1e-3) onSet(m);
    else setVal(length.toFixed(1));
  };
  const badge = linkGroup >= 0 ? String.fromCharCode(65 + linkGroup) : "";
  return (
    <div className="mm-edge-row">
      <span className="mm-edge-row__n">edge {index + 1}</span>
      <input
        className="mm-edge-row__len"
        type="number"
        value={val}
        disabled={frozen}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
      <span className="mm-edge-row__unit">m</span>
      {badge && <span className="mm-edge-row__link" title={`Linked group ${badge} — scales together`}>🔗{badge}</span>}
      <button
        className={`mm-edge-row__freeze ${frozen ? "is-frozen" : ""}`}
        title={frozen ? "Frozen — click to unfreeze" : "Freeze this edge's length"}
        onClick={onFreeze}
      >
        {frozen ? "❄" : "·"}
      </button>
    </div>
  );
}

/** Furniture-package picker — choose a package, Apply seeds all its props. */
function FurniturePicker({ onApply }: { onApply: (key: string) => void }) {
  const [key, setKey] = useState<string>(FURNITURE_PACKAGES[0]?.key ?? "");
  const pkg = packageByKey(key);
  return (
    <div>
      <div className="mm-ins-pair">
        <select value={key} onChange={(e) => setKey(e.target.value)} aria-label="Furniture package">
          {FURNITURE_PACKAGES.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
        <button className="mm-btn mm-btn--primary" disabled={!pkg} onClick={() => key && onApply(key)}>
          Apply
        </button>
      </div>
      {pkg && <div className="mm-ins-hint" style={{ marginTop: 4 }}>{pkg.description} ({pkg.props.length} pieces)</div>}
    </div>
  );
}

/** Prop-swap picker — pick a replacement piece type from the palette. */
function PropSwap({
  current, onSwap,
}: {
  current?: string;
  onSwap: (icon: import("@/lib/furniture").PropIcon, label: string, priceUsd: number) => void;
}) {
  const start = PROP_PALETTE.findIndex((p) => p.icon === current);
  const [idx, setIdx] = useState<number>(start >= 0 ? start : 0);
  const sel = PROP_PALETTE[idx];
  return (
    <div className="mm-ins-pair">
      <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} aria-label="Replacement piece">
        {PROP_PALETTE.map((p, i) => (
          <option key={`${p.icon}-${i}`} value={i}>{p.label}</option>
        ))}
      </select>
      <button className="mm-btn" disabled={!sel} onClick={() => sel && onSwap(sel.icon, sel.label, sel.priceUsd)}>
        Swap
      </button>
    </div>
  );
}

function PinSqm({ current, onPin }: { current: number; onPin: (t: number) => void }) {
  const [val, setVal] = useState<string>("");
  return (
    <div className="mm-ins-pair">
      <input
        type="number"
        value={val}
        placeholder={`${Math.round(current)}`}
        onChange={(e) => setVal(e.target.value)}
      />
      <button className="mm-btn" disabled={!val || !(Number(val) > 0)} onClick={() => onPin(Number(val))}>
        Pin m²
      </button>
    </div>
  );
}
