"use client";

// The Studio-face inspector (slice 2) — edits the SELECTED §4d node. Shows the authored-truth m² derived
// from the metre anchor × nested fractions (lib/geo.deriveSqm), lets you set a metre anchor (on a building/
// floor), PIN a node to a real m² (constrainToSqm), set status (units) + price. Add-child / delete here too.

import type { Pack, UnitStatus } from "@/lib/pack";
import {
  ancestorsOf,
  childrenOf,
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN,
  cameraViewPhrase,
  CHILD_KIND,
  compass16,
  DEFAULT_CAMERA,
  deriveSqm,
  detectEdgeLinks,
  edgeLengthsMetres,
  KIND_LABEL,
  canMatchParentShape,
  metreAnchor,
  nodeById,
  normDeg,
  realMetres,
  renderFootprint,
  resolvePlan,
  STATUS_LABEL,
  subtypeLockedSqm,
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
  // A BUILDING shows the SAME map (inheriting the land's location) with a draggable FRONT-vector arrow, so you
  // orient it against the real streets. The parcel is the land's, shown read-only as context.
  const landAncestor = node.kind === "building" ? ancestorsOf(pack, node.id).find((a) => a.kind === "land") : undefined;
  const buildingSiteGeo = landAncestor?.siteGeo;
  const canBuildingMap = node.kind === "building" && !!buildingSiteGeo?.landPolygon?.length;
  const isPoly = node.footprint?.shape === "poly";
  // (slice 4) a unit bound to a SUBTYPE authors ITS shared plan — editing this one polygon reshapes every
  // unit of the subtype, and the size is pinned to the subtype's declared area.
  const subtypeBound = node.kind === "unit" && !!node.subtypeRef;
  const lockedSqm = subtypeBound ? subtypeLockedSqm(pack, node.id) : undefined;
  // (D-) a unit has a REAL shape (own poly or a resolved subtype plan) iff renderFootprint gives a poly —
  // only such a unit can be approved into the level plan / toggled marker⇄shape (a shapeless pin has nothing to show).
  const unitHasShape = node.kind === "unit" && renderFootprint(pack, node)?.shape === "poly";
  // (→) a node can take its PARENT's shape in one click — a BUILDING matches the land parcel (setback), a
  // FLOOR matches the building plate (full, no shrink — constant-plate model). Units are EXCLUDED (they tile the
  // floor, they don't inherit its shape). Offered only when the parent resolves to a real polygon.
  const canMatchParent = canMatchParentShape(pack, node.id);
  // kind-aware label for the match button: a building takes the LAND PARCEL outline, a floor takes the BUILDING plate.
  const matchParentLabel = node.kind === "building" ? "Match the land parcel outline" : node.kind === "floor" ? "Match the building plate" : "Match the parent shape";
  //  kind-aware wording — "unit plan" was shown even on a building/floor, which read wrong. The shape section
  // names the thing you're editing: a building OUTLINE, a floor SHAPE, a unit PLAN.
  const shapeNoun = node.kind === "building" ? "building outline" : node.kind === "floor" ? "floor shape" : node.kind === "land" ? "land parcel" : "unit plan";
  // (slice 3) a FLOOR is best set + LOCKED before you fit units inside it (then it can only be enlarged).
  // Warn-but-allow: a non-blocking nudge when the floor carries units but isn't locked yet.
  const floorUnitCount = node.kind === "floor" ? childrenOf(pack, node.id).filter((n) => n.kind === "unit").length : 0;
  const floorNeedsLock = node.kind === "floor" && !node.locked && floorUnitCount > 0;
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
        {/* lock the shape — "lock when it's correct". Locked: no drag/resize/vertex edits; name/price
            stay editable. The deeper levels you draw see a locked parent as a reference they can't disturb. */}
        <section className="mm-ins-sec">
          <button
            className={`mm-btn mm-lock-btn ${node.locked ? "is-locked" : ""}`}
            onClick={() => geo.setLocked(node.id, !node.locked)}
            title={node.locked ? "Shape locked — click to unlock and edit the geometry" : "Lock the shape so it can't be moved or reshaped"}
          >
            {node.locked ? "🔒 Shape locked — click to unlock" : "🔓 Lock this shape"}
          </button>
        </section>

        {/* facing — the node's FRONT / which way it "looks". POSE metadata (editable even when the shape
 is locked), SEPARATE from the editor rotation. North comes from the map automatically, so this
            is the real orientation to author. Drag the arrow on the canvas, or set it here. Feeds the camera arc.
            Props (furniture) don't carry a facing. */}
        {node.kind !== "prop" && (
          <FacingControl
            facingDeg={node.facingDeg}
            onSet={(d) => geo.setFacing(node.id, d)}
            onClear={() => geo.setFacing(node.id, undefined)}
          />
        )}

        {/* camera / viewpoint — a placeable interior camera on a ROOM node (unit/floor). Add it, then
            drag the pin + aim on the canvas or tune the field of view here. The phrase preview is exactly what
            the AI room-image generator receives: a placed camera makes slotImagePrompt render the room FROM this
 viewpoint as an interior perspective, not a top-down plan (AI half, lib/ai-build-images.ts). */}
        {(node.kind === "unit" || node.kind === "floor") && (
          <CameraControl
            camera={node.camera}
            onAdd={() => geo.setCamera(node.id, DEFAULT_CAMERA)}
            onFov={(fov) => geo.patchCamera(node.id, { fovDeg: fov })}
            onClear={() => geo.setCamera(node.id, undefined)}
          />
        )}

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

        {/* (slice B) LAND-SIZE HUD — the authoritative title/deed area (baked on the land node) vs what's
            currently drawn, so you can align BY AREA even without the number at hand. The authority is the title
 deed, NOT the map — this is how you tell the drawn parcel is the right SIZE. Snap-to-size
            (slice D) will scale the drawn shape to equal the target in one click. */}
        {node.kind === "land" && (
          <LandSizeHud
            drawnSqm={sqm}
            target={node.targetAreaSqm}
            isPoly={isPoly}
            onSetTarget={(t) => geo.patchNode(node.id, { targetAreaSqm: t })}
            onSnap={(t) => (isPoly ? geo.pinPolySqm(node.id, t) : geo.pinSqm(node.id, t))}
          />
        )}

        {/* (slice C) TITLE-DEED reference image — upload the surveyed plot drawing to trace the parcel over
 (the authority is the deed, not the map). Mirrors the unit-plan trace backdrop, but on the
            LAND. Drawn dim behind the land in its own focus view; reference only, never exported. */}
        {node.kind === "land" && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Title deed (trace reference)</div>
            <BackdropControl
              hasBackdrop={!!node.deedImage}
              onSet={(img) => geo.setDeedImage(node.id, img)}
              onClear={() => geo.setDeedImage(node.id, undefined)}
            />
            <div className="mm-ins-hint">
              Upload the title-deed / survey drawing of the plot. It shows dim behind the land (in the land&apos;s own
              view) so you can trace the real parcel over it, then snap it to the deed area above. Reference only — never
              exported.
            </div>
          </section>
        )}

        {/* site & location MAP — the geographic source of truth (land/site node). Tracing the parcel seeds the
            metre anchor below; north is kept SEPARATE from the editor rotation (they compose at render). */}
        {canSite && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Site &amp; location</div>
            <SiteMap
              value={node.siteGeo}
              onChange={({ siteGeo, metreExtent, preserveFootprint }) => geo.setSiteGeo(node.id, siteGeo, metreExtent, preserveFootprint)}
              //  hand the land's drawn footprint + real metre size to the map so "⬇ Place my drawn shape"
              // can project it onto the parcel at the pin — the user never re-traces a shape they already drew.
              footprint={node.footprint}
              metreW={node.metreW}
              metreH={node.metreH}
            />
            <div className="mm-ins-hint">
              Drop the pin at the real location — the shape you drew is placed onto the map there (no re-tracing);
              drag its corners to fine-tune, or trace a fresh parcel. North is taken from the map automatically.
              Set each building&apos;s FRONT with its Facing control.
            </div>
          </section>
        )}

        {/* BUILDING on the map — the land's parcel as read-only context + a draggable front-vector
            arrow, so you orient the building against the real streets. onFacingChange writes the building's facingDeg. */}
        {canBuildingMap && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Orient on the map</div>
            <SiteMap
              value={buildingSiteGeo}
              onChange={() => {}}
              facingDeg={node.facingDeg}
              onFacingChange={(d) => geo.setFacing(node.id, d)}
            />
            <div className="mm-ins-hint">
              The land parcel is shown for context. Drag the yellow arrow to point this building&apos;s front
              (its entrance / street side) the right way against the real streets.
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

        {/* (slice 3) lock-first NUDGE — warn but allow: fitting units is easiest once the floor shape is set
            and locked (after that it can only be enlarged, never shrunk below its units). Non-blocking. */}
        {floorNeedsLock && (
          <section className="mm-ins-sec">
            <div className="mm-ins-nudge">
              <span>
                This floor has <b>{floorUnitCount}</b> unit{floorUnitCount === 1 ? "" : "s"} but its shape isn&apos;t
                locked yet. Set the floor shape, then <b>lock it</b> — units fit inside a fixed plate, and a locked
                floor can only be enlarged (never shrunk below its units).
              </span>
              <button className="mm-btn mm-btn--primary" onClick={() => geo.setLocked(node.id, true)}>🔒 Lock the floor shape</button>
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

        {/* (parked item 2) APPROVE-FLOOR checkpoint — a SOFT ✓ (Law #1: never gates clicking ahead). Approving
            marks this floor "good" and SEEDS the next floor up from this one (once, if it's still an unshaped rect),
            so you perfect floor 1 → approve → floor 2 starts as a copy. Unconfirmed floors carry the badge below. */}
        {node.kind === "floor" && (
          <section className="mm-ins-sec">
            {node.confirmed ? (
              <div className="mm-floor-approved">✓ Floor approved — its shape seeded the next floor.</div>
            ) : (
              <>
                <button
                  className="mm-btn mm-btn--primary"
                  style={{ width: "100%" }}
                  onClick={() => geo.approveFloor(node.id)}
                  title="Mark this floor's shape good and start the next floor up as a copy of it. You can still edit any floor freely."
                >
                  ✓ Approve this floor
                </button>
                <div className="mm-ins-hint">
                  Seeds the <b>next floor up</b> from this shape (once — later edits never ripple back). Optional: you can
                  always jump to any floor and edit it directly.
                </div>
              </>
            )}
          </section>
        )}

        {/*  LAY UNITS TO SCALE — replace the dumb even grid with real-sized, tessellating cells + a corridor,
 inside a plate SIZED FROM THE UNITS (not the oversized traced land).: units at their real m² by
            default, user fixes manually after; the corridor width sits right here. Only on a floor that has units. */}
        {node.kind === "floor" && floorUnitCount > 0 && (
          <LayToScale onLay={(corridorM) => geo.layUnitsToScale(node.id, corridorM)} />
        )}

        {/* shape: rectangle ↔ polygon (the dimensioned footprint editor) */}
        <section className="mm-ins-sec">
          <div className="mm-ins-label">{subtypeBound ? "Subtype plan (shape)" : "Footprint shape"}</div>
          {/* (→) a node can match its PARENT's shape in one click — a building takes the land parcel outline
              (setback), a FLOOR takes the building plate (full, constant-plate). Units never see this (they tile). */}
          {canMatchParent && (
            <button
              className="mm-btn mm-btn--primary"
              style={{ width: "100%", marginBottom: 6 }}
              onClick={() => geo.matchParentShape(node.id)}
              title={node.kind === "floor"
                ? "Take the building's plate shape as this floor's outline (every floor shares the plate)"
                : "Take the land parcel's traced outline (inset a little) as this building's footprint"}
            >
              ⤢ {matchParentLabel}
            </button>
          )}
          {isPoly ? (
            <button className="mm-btn" onClick={() => geo.toRect(node.id)}>↩ Back to rectangle</button>
          ) : (
            <button className="mm-btn" onClick={() => geo.toPoly(node.id)}>✏ Edit the {shapeNoun}</button>
          )}
          {canMatchParent && (
            <div className="mm-ins-hint">
              {node.kind === "floor"
                ? "Takes the building's plate shape (every floor is the same plate). Then drag the corners to adjust this floor."
                : "Matches the real land shape you traced on the map. Then drag the corners to refine the exact building outline."}
            </div>
          )}
          {subtypeBound && (
            <div className="mm-ins-hint">
              This is the <b>shared plan</b> of this subtype — the shape you draw here applies to <b>every</b> unit
              of this type on every floor (you&apos;re editing the <b>source</b>, not this one unit). Enter each
              edge&apos;s real dimension below; the area stays pinned to the subtype&apos;s declared size. Manage every
              subtype&apos;s plan from the <b>Subtype plans</b> panel in the Structured face.
            </div>
          )}
          {isPoly && (
            <div className="mm-ins-hint">
              Drag corners on the canvas. Click an edge-dot to add a vertex; double-click a corner to delete it.
              Right-click a corner or edge-dot to <b>freeze</b> it (held while you adjust the rest).
            </div>
          )}
        </section>

        {/* (slice 5) TRACE-OVER backdrop — import the architect's floor-plan image to trace over. Only on a
            subtype-bound unit that already has a plan shape. Reference only; never exported. Doors/windows/walls
            are placed on the canvas after you go INSIDE this unit (double-click it). */}
        {subtypeBound && isPoly && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Floor-plan trace & detailing</div>
            <BackdropControl
              hasBackdrop={!!resolvePlan(pack, node)?.backdrop}
              onSet={(backdrop) => geo.setBackdrop(node.id, backdrop)}
              onClear={() => geo.setBackdrop(node.id, undefined)}
            />
            <div className="mm-ins-hint">
              Import the architect&apos;s plan image to trace over (shown dim behind the shape). To add
              <b> doors, windows & walls</b>, double-click this unit on the canvas to go inside its plan, then use the
              <b> Add to plan</b> tools. Markers are shared by every unit of this subtype.
            </div>
          </section>
        )}

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
            {/* (slice 4) a subtype-bound unit snaps to its DECLARED legal size in one click — the binding
                area every unit of this subtype shares. The free input stays below for the rare manual tweak. */}
            {subtypeBound && lockedSqm != null && isPoly && (
              <button
                className="mm-btn mm-btn--primary"
                style={{ width: "100%", marginBottom: 6 }}
                onClick={() => geo.pinPolySqm(node.id, lockedSqm)}
                title="Scale the drawn plan so its area equals the subtype's declared size"
              >
                ⤢ Fit to subtype size — {Math.round(lockedSqm).toLocaleString()} m²
              </button>
            )}
            <PinSqm current={sqm} onPin={(t) => (isPoly ? geo.pinPolySqm(node.id, t) : geo.pinSqm(node.id, t))} />
            <div className="mm-ins-hint">
              {isPoly
                ? "Scales the whole polygon so its real area matches — shape (and every angle) kept."
                : "Scales the box so its real area matches, keeping its shape."}
            </div>
          </section>
        )}

        {/* (D-) ON THE LEVEL PLAN — a unit with a real shape draws as a MARKER on the level overview until
            it's approved into the plan (so an imported building reads as clean pins, not a wall of overlapping room
            fills). Approve brings its shape into the level view; the view toggle forces marker/shape independently.
            Soft/Law#1: never gates navigation. Shown once the unit has a shape to show. */}
        {node.kind === "unit" && unitHasShape && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">On the level plan</div>
            {node.approved ? (
              <div className="mm-floor-approved">✓ Approved — its shape is in the level plan.</div>
            ) : (
              <button
                className="mm-btn mm-btn--primary"
                style={{ width: "100%" }}
                onClick={() => geo.setApproved(node.id, true)}
                title="Mark this unit's room shape good and bring it into the level plan (it draws as its real shape instead of a marker)."
              >
                ✓ Approve into level plan
              </button>
            )}
            {node.approved && (
              <button
                className="mm-btn"
                style={{ width: "100%", marginTop: 6 }}
                onClick={() => geo.setApproved(node.id, false)}
                title="Return this unit to a draft marker on the level overview."
              >
                ↩ Unapprove (back to draft)
              </button>
            )}
            {/* (D- pt3) toggle marker⇄shape on the overview, independent of approval. undefined = AUTO. */}
            <div className="mm-ins-row" style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button
                className={`mm-btn ${node.representation === "marker" ? "is-active" : ""}`}
                style={{ flex: 1 }}
                onClick={() => geo.setRepresentation(node.id, node.representation === "marker" ? undefined : "marker")}
                title="Show this unit as a marker (pin) on the level overview."
              >
                📍 Marker
              </button>
              <button
                className={`mm-btn ${node.representation === "shape" ? "is-active" : ""}`}
                style={{ flex: 1 }}
                onClick={() => geo.setRepresentation(node.id, node.representation === "shape" ? undefined : "shape")}
                title="Show this unit as its real shape on the level overview."
              >
                ⬡ Shape
              </button>
            </div>
            <div className="mm-ins-hint">
              On the level overview a unit shows as a marker until approved. Override here to force a marker or shape;
              clear the override (click an active one again) to go back to auto. Drilling into the unit always shows its shape.
            </div>
          </section>
        )}

        {/*  PLACE ON FLOOR — once a unit plan is sized, it behaves as a RIGID whole on its floor: rotate it
            and pin its position. Distinct from the shape lock above (which locks vertex-editing of the shared plan);
            these pin this unit's PER-INSTANCE pose. Shown for a subtype-bound unit that has a real shape to place. */}
        {node.kind === "unit" && subtypeBound && isPoly && (
          <section className="mm-ins-sec">
            <div className="mm-ins-label">Place on floor</div>
            <div className="mm-ins-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ minWidth: 56 }}>Rotation</span>
              <input
                type="range" min={0} max={359} step={1}
                value={Math.round(node.rotationDeg ?? 0)}
                disabled={!!node.posLocked}
                onChange={(e) => geo.setRotation(node.id, Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ minWidth: 40, textAlign: "right" }}>{Math.round(node.rotationDeg ?? 0)}°</span>
            </div>
            <button
              className={`mm-btn mm-lock-btn ${node.posLocked ? "is-locked" : ""}`}
              style={{ width: "100%", marginTop: 6 }}
              onClick={() => geo.setPosLocked(node.id, !node.posLocked)}
              title={node.posLocked ? "Position pinned — click to allow moving/rotating on the floor" : "Pin this unit's position + rotation on the floor"}
            >
              {node.posLocked ? "📌 Position locked — click to unpin" : "📍 Lock position on level"}
            </button>
            <div className="mm-ins-hint">
              Moves + rotates as a locked whole on the floor — the shape stays the subtype's shared plan. Editing the
              plan still reshapes every unit of this type; this only pins where THIS one sits.
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
            {/* (Slice E) add ONE piece — the per-prop affordance (vs the whole-package seed above). */}
            <div className="mm-ins-label" style={{ marginTop: 8 }}>Add a piece</div>
            <PropAdd onAdd={(icon, label, priceUsd) => geo.addProp(node.id, icon, label, priceUsd)} />
            <div className="mm-ins-hint">Drops a single piece at a default spot — then drag, resize or swap it.</div>
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

        {/* price — priced INVENTORY carries this (a unit, a floor sold whole, a furniture prop). A land parcel
 or the project root isn't sellable inventory, so the field is hidden there (it was just
            confusing on the land node). The model still allows a price on any node (pack rule 2); this is only
            which kinds SURFACE the input. */}
        {node.kind !== "land" && node.kind !== "project" && (
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
        )}

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

import { useEffect, useRef, useState } from "react";

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

/**
 * FACING control — set which way a node looks, 0..359 in editor space (0 = up/top-of-frame, clockwise).
 * Quick N/E/S/W buttons + a slider + a numeric box + a compass read-out; clear removes it. Mirrors the map's
 * north-bearing control but lives on the NODE (pose), not the site. Editable regardless of the shape lock.
 */
function FacingControl({
  facingDeg, onSet, onClear,
}: {
  facingDeg?: number;
  onSet: (deg: number) => void;
  onClear: () => void;
}) {
  const set = facingDeg != null;
  const deg = set ? normDeg(facingDeg!) : 0;
  const quick: Array<[string, number]> = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
  return (
    <section className="mm-ins-sec">
      <div className="mm-ins-label">Facing</div>
      <div className="mm-facing-quick">
        {quick.map(([lbl, d]) => (
          <button
            key={lbl}
            type="button"
            className={`mm-btn mm-facing-q ${set && deg === d ? "is-on" : ""}`}
            onClick={() => onSet(d)}
            title={`Face ${lbl} (${d}°)`}
          >
            {lbl}
          </button>
        ))}
      </div>
      <input
        type="range"
        min={0}
        max={359}
        value={deg}
        onChange={(e) => onSet(Number(e.target.value))}
        aria-label="Facing degrees"
      />
      <div className="mm-ins-row">
        <span>{set ? `${compass16(deg)} · ${Math.round(deg)}°` : "not set"}</span>
        {set && (
          <button type="button" className="mm-btn mm-btn--mini" onClick={onClear}>clear</button>
        )}
      </div>
      <div className="mm-ins-hint">
        The building&apos;s FRONT — which way it faces (e.g. the entrance / the street side). Drag the arrow on the
        canvas or set it here. North comes from the map automatically; this is the orientation you author. Feeds
        accurate-angle room views later.
      </div>
    </section>
  );
}

/**
 * CAMERA control — place / tune / clear an interior viewpoint on a room node. When none is placed, a
 * single "add camera" button. When placed: an FOV slider + a compass+phrase read-out (exactly what the AI
 * image generator will get next slice) + clear. Position & facing are set by dragging the pin/aim on the canvas.
 */
function CameraControl({
  camera, onAdd, onFov, onClear,
}: {
  camera?: import("@/lib/pack").Camera;
  onAdd: () => void;
  onFov: (fovDeg: number) => void;
  onClear: () => void;
}) {
  if (!camera) {
    return (
      <section className="mm-ins-sec">
        <div className="mm-ins-label">Camera (room view)</div>
        <button type="button" className="mm-btn" onClick={onAdd}>📷 Add a camera</button>
        <div className="mm-ins-hint">
          Place a viewpoint in the room — then drag the pin to move it and the aim handle to turn it. It becomes
          an accurate-angle instruction for the AI room image.
        </div>
      </section>
    );
  }
  return (
    <section className="mm-ins-sec">
      <div className="mm-ins-label">Camera (room view)</div>
      <label className="mm-ins-single">
        Field of view {Math.round(camera.fovDeg)}°
        <input
          type="range"
          min={CAMERA_FOV_MIN}
          max={CAMERA_FOV_MAX}
          value={Math.round(camera.fovDeg)}
          onChange={(e) => onFov(Number(e.target.value))}
          aria-label="Field of view degrees"
        />
      </label>
      <div className="mm-ins-row mm-ins-row--dim">
        <span>Looking</span>
        <span>{compass16(camera.facingDeg)} · {Math.round(camera.facingDeg)}°</span>
      </div>
      <div className="mm-ins-hint" style={{ fontStyle: "italic" }}>
        “{cameraViewPhrase(camera)}”
      </div>
      <div className="mm-ins-row">
        <span>Drag the pin &amp; aim on the canvas</span>
        <button type="button" className="mm-btn mm-btn--mini" onClick={onClear}>remove</button>
      </div>
    </section>
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

/** (Slice E) Add-a-single-piece picker — pick one piece from the palette, Add drops it into the unit. */
function PropAdd({ onAdd }: { onAdd: (icon: import("@/lib/furniture").PropIcon, label: string, priceUsd: number) => void }) {
  const [idx, setIdx] = useState<number>(0);
  const sel = PROP_PALETTE[idx];
  return (
    <div className="mm-ins-pair">
      <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} aria-label="Piece to add">
        {PROP_PALETTE.map((p, i) => (
          <option key={`${p.icon}-${i}`} value={i}>{p.label} · ${p.priceUsd.toLocaleString()}</option>
        ))}
      </select>
      <button className="mm-btn mm-btn--primary" disabled={!sel} onClick={() => sel && onAdd(sel.icon, sel.label, sel.priceUsd)}>
        Add
      </button>
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

/**  Lay a floor's units to scale — a corridor-width control + the action button, right on the floor (:
 *  "let user set it there nearby"). Replaces the even grid with real-sized, tessellating cells inside a sized plate. */
function LayToScale({ onLay }: { onLay: (corridorM: number) => void }) {
  const [corridor, setCorridor] = useState<string>("1.8");
  const c = Number(corridor);
  return (
    <section className="mm-ins-sec">
      <div className="mm-ins-label">Lay units to scale</div>
      <div className="mm-ins-pair">
        <label style={{ flex: 1 }}>
          Corridor m
          <input
            type="number"
            value={corridor}
            step="0.1"
            min="0.5"
            onChange={(e) => setCorridor(e.target.value)}
          />
        </label>
        <button
          className="mm-btn mm-btn--primary"
          disabled={!(c > 0)}
          onClick={() => c > 0 && onLay(c)}
          title="Size the plate from the units and lay them at their real m², with a corridor"
        >
          ⌁ Lay to scale
        </button>
      </div>
      <div className="mm-ins-hint">
        Replaces the even grid: each unit is drawn at its <b>real m²</b> (a 40 m² shop small, a 180 m² penthouse
        large), tessellated inside a plate sized from the units, with a corridor. Then fix any unit by hand.
      </div>
    </section>
  );
}

function PinSqm({ current, onPin }: { current: number; onPin: (t: number) => void }) {
  const [val, setVal] = useState<string>("");
  // Confirm the pin took effect — without feedback, pinning to the CURRENT size looks like "nothing happened"
  // (it's idempotent, so there's no visible change). Shows "✓ set to N m²" briefly and clears the input so the
  // placeholder reflects the new size ("Pin m² not happen" when it was already at that size).
  const [done, setDone] = useState<string>("");
  function pin() {
    const t = Number(val);
    if (!(t > 0)) return;
    onPin(t);
    setDone(`✓ set to ${Math.round(t).toLocaleString()} m²`);
    setVal("");
    window.setTimeout(() => setDone(""), 2500);
  }
  return (
    <div>
      <div className="mm-ins-pair">
        <input
          type="number"
          value={val}
          placeholder={`${Math.round(current).toLocaleString()}`}
          onChange={(e) => { setVal(e.target.value); if (done) setDone(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") pin(); }}
        />
        <button className="mm-btn" disabled={!val || !(Number(val) > 0)} onClick={pin}>
          Pin m²
        </button>
      </div>
      {done && <div className="mm-ins-hint" style={{ color: "#4ade80", marginTop: 4 }}>{done}</div>}
    </div>
  );
}

/**
 * (slice B) LAND-SIZE HUD — shows the authoritative title area the land SHOULD be vs what's drawn, with a
 * ±delta and a colour cue (green within 1%, amber within 5%, red beyond). When no target is set, a compact input
 * to bake one onto the land node (travels with export/import). The authority is the title deed, not the map.
 */
function LandSizeHud({
  drawnSqm, target, isPoly, onSetTarget, onSnap,
}: {
  drawnSqm: number | null | undefined;
  target?: number;
  isPoly: boolean;
  onSetTarget: (t: number | undefined) => void;
  onSnap: (t: number) => void;
}) {
  const [editing, setEditing] = useState<boolean>(false);
  const [snapped, setSnapped] = useState<boolean>(false);
  const [val, setVal] = useState<string>(target != null ? String(target) : "");
  useEffect(() => { setVal(target != null ? String(target) : ""); }, [target]);

  function commit() {
    const t = Number(val);
    onSetTarget(val === "" || !(t > 0) ? undefined : t);
    setEditing(false);
  }

  // No target yet → an invitation to bake the deed area.
  if (target == null || editing) {
    return (
      <section className="mm-ins-sec">
        <div className="mm-ins-label">Title / deed area</div>
        <div className="mm-ins-pair">
          <input
            type="number"
            value={val}
            placeholder="e.g. 1808"
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            autoFocus={editing}
          />
          <button className="mm-btn mm-btn--primary" onClick={commit}>
            {target == null ? "Set target" : "Save"}
          </button>
        </div>
        <div className="mm-ins-hint">
          The authoritative plot size from the title deed (m²). The authority is the deed, not the map — set it
          here and the readout tells you how close the drawn parcel is.
        </div>
      </section>
    );
  }

  const drawn = drawnSqm ?? null;
  const delta = drawn != null ? drawn - target : null;
  const pct = drawn != null && target > 0 ? Math.abs(delta!) / target : null;
  const tone = pct == null ? "none" : pct <= 0.01 ? "ok" : pct <= 0.05 ? "warn" : "off";
  const deltaStr =
    delta == null ? "—"
    : `${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta)).toLocaleString()} m² (${delta >= 0 ? "+" : "−"}${(pct! * 100).toFixed(1)}%)`;

  return (
    <section className="mm-ins-sec">
      <div className={`mm-land-hud is-${tone}`}>
        <div className="mm-land-hud__title">
          <span>Land size vs title deed</span>
          <button className="mm-btn mm-btn--mini" onClick={() => setEditing(true)} title="Edit the target area">edit</button>
        </div>
        <div className="mm-land-hud__rows">
          <div className="mm-land-hud__row">
            <span>Target (deed)</span>
            <strong>{target.toLocaleString()} m²</strong>
          </div>
          <div className="mm-land-hud__row">
            <span>Drawn</span>
            <strong>{drawn != null ? `${drawn.toLocaleString()} m²` : "— set a metre anchor"}</strong>
          </div>
          <div className="mm-land-hud__row mm-land-hud__row--delta">
            <span>Difference</span>
            <strong>{deltaStr}</strong>
          </div>
        </div>
        <div className="mm-land-hud__bar">
          {tone === "ok" && <span>✓ within 1% of the deed</span>}
          {tone === "warn" && <span>▲ off by up to 5% — nudge or snap-to-size</span>}
          {tone === "off" && <span>✕ off by more than 5% — snap-to-size to fix</span>}
          {tone === "none" && <span>Set a metre anchor to compare</span>}
        </div>
        {/* (slice D) SNAP-TO-SIZE — one click scales the drawn parcel so its area equals the deed target. For
            a land anchor holding a building, pinPolySqm resizes the PLOT and keeps the building's real size (the
 D- independent-anchor path). Offered only when there's a drawn area that's off by more than ~0.1%. */}
        {drawn != null && pct != null && pct > 0.001 && (
          <button
            className="mm-btn mm-btn--primary"
            style={{ width: "100%", marginTop: 8 }}
            onClick={() => { onSnap(target); setSnapped(true); window.setTimeout(() => setSnapped(false), 2500); }}
            title={isPoly
              ? "Scale the drawn parcel so its area equals the title-deed size (keeps the shape and every angle; a building inside keeps its real size)"
              : "Scale the plot so its area equals the title-deed size (keeps the shape)"}
          >
            ⤢ Snap to the deed size — {target.toLocaleString()} m²
          </button>
        )}
        {snapped && (
          <div className="mm-land-hud__bar" style={{ color: "#4ade80", marginTop: 6 }}>✓ snapped to {target.toLocaleString()} m²</div>
        )}
      </div>
    </section>
  );
}

/** (slice 5) Import / clear the trace-over backdrop image. Reads a File → base64 data URL stored INLINE on
 *  the plan (reference only, never exported). Kept small — it's a convenience over the real drawing. */
function BackdropControl({
  hasBackdrop, onSet, onClear,
}: {
  hasBackdrop: boolean;
  onSet: (b: { dataUrl: string; mime: string }) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      if (dataUrl) onSet({ dataUrl, mime: file.type || "image/png" });
    };
    reader.readAsDataURL(file);
  }
  return (
    <div className="mm-ins-pair">
      <button className="mm-btn" onClick={() => ref.current?.click()}>
        {hasBackdrop ? "⤢ Replace trace image" : "⬆ Import trace image"}
      </button>
      {hasBackdrop && <button className="mm-btn mm-btn--danger" onClick={onClear}>Clear</button>}
      <input
        ref={ref}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
      />
    </div>
  );
}
