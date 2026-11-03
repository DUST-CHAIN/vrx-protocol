"use client";

// Studio-face state (slice 2) — the §4d drawing board. Holds which node is FOCUSED (the "parent" whose
// children you're drawing inside) and which node is SELECTED (inspected/edited), plus immutable setters that
// write pack.geo[] through usePack's setPack. The textual spine (usePack) is untouched; geo is its own layer.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Camera, GeoKind, GeoNode, Pack, SiteGeo, UnitStatus } from "@/lib/pack";
import type { Footprint } from "@/lib/pack";
import {
  bboxFromLatLngPolygon,
  CHILD_KIND,
  clampCamera,
  clampRect,
  constrainPolySqm,
  constrainRectSqmAtOrigin,
  constrainToSqm,
  DEFAULT_CAMERA,
  footprintRect,
  footprintToLatLngPolygon,
  footprintToLatLngParcel,
  isLocked,
  subtypeLockedSqm,
  latLngPolygonToSquareFootprint,
  makeNode,
  normDeg,
  parentShapeInChildFrame,
  FLOOR_SEED_INSET,
  realMetres,
  footprintWithStoredMetres,
  planFootprintWithStoredMetres,
  derivePosM,
  seedRectFloorsUnderPolyBuilding,
  seedNextFloorFromApproved,
  effectiveFootprint,
  editsSharedPlanOnly,
  resolvePlan,
  rootNodes,
  scaleFootprintAboutOrigin,
  setEdgeLengthMetres,
  subtypePlanTarget,
  unitsFitInFloorShape,
  toggleInSet,
  type Rect,
} from "@/lib/geo";
import { seedPackage, seedSingleProp, swapPropPatch, type PropIcon } from "@/lib/furniture";
import { layUnitsToScale as layUnitsToScalePure, DEFAULT_CORRIDOR_M } from "@/lib/unit-layout";
import type { PackApi } from "./usePack";
import type { PlanMarker } from "@/lib/pack";

export interface GeoApi {
  focusId?: string; // the node we're drawing INSIDE (its children show on the canvas); undefined = root level
  selectedId?: string; // the node being inspected
  focus: (id?: string) => void;
  selectNode: (id?: string) => void;
  addChild: (kind: GeoKind, parentId?: string) => string; // add a child under parentId (default: current focus)
  addRoot: () => string; // add a land/building at root level
  patchNode: (id: string, patch: Partial<GeoNode>) => void;
  setLocked: (id: string, locked: boolean) => void; // lock/unlock a node's GEOMETRY (shape held fixed)
  approveFloor: (id: string) => void; // approve a floor's shape → confirm it + seed the next floor up (once)
  setFacing: (id: string, facingDeg?: number) => void; // set/clear a node's FACING (pose, not geometry)
  setRotation: (id: string, rotationDeg: number) => void; // a placed unit's on-floor rotation (pose, no-op if pos-locked)
  setPosLocked: (id: string, posLocked: boolean) => void; // "Lock position on level" (pins translate+rotate)
  setApproved: (id: string, approved: boolean) => void; // bring a unit's shape into the level plan (D-)
  setRepresentation: (id: string, representation?: "marker" | "shape") => void; // toggle unit marker⇄shape (D-)
  setCamera: (id: string, camera?: Camera) => void; // place/clear a camera viewpoint (pose, not geometry)
  patchCamera: (id: string, patch: Partial<Camera>) => void; // nudge one camera field (drag/slider)
  moveResize: (id: string, rect: Rect) => void; // drag/resize → clamped footprint (no-op when locked)
  setStatus: (id: string, status: UnitStatus) => void;
  pinSqm: (id: string, targetSqm: number) => void; // constrain to a real m² (keeps aspect)
  duplicateNode: (id: string) => string; // clone a node (same size/status/price) offset right, under the same parent
  applyFurniturePackage: (unitId: string, packageKey: string) => void; // §6a — seed a package's props into a unit
  addProp: (unitId: string, icon: PropIcon, label: string, priceUsd: number) => void; //  Slice E — drop ONE piece into a unit
  swapProp: (id: string, icon: PropIcon, label: string, priceUsd: number) => void; // replace a prop's icon/label/price
  // --- polygon editing (illustration-grade dimensioned footprints) ---
  toPoly: (id: string) => void; // convert a rect footprint into an editable 4-point polygon
  toRect: (id: string) => void; // flatten a poly back to its bounding rect
  matchParentShape: (id: string) => void; // → — node takes its PARENT's shape (level-aware inset) as its footprint
  layUnitsToScale: (floorId: string, corridorWidthM?: number) => void; // lay a floor's units at real m² inside a sized plate
  setPolyPoints: (id: string, points: Array<{ x: number; y: number }>) => void; // vertex drag / add / delete
  moveVertex: (id: string, index: number, pt: { x: number; y: number }) => void;
  addVertex: (id: string, afterIndex: number) => void; // split the edge after `afterIndex` at its midpoint
  removeVertex: (id: string, index: number) => void; // keep ≥ 3
  setEdgeLength: (id: string, edgeIndex: number, metres: number) => void; // dimension-driven (linked follow)
  pinPolySqm: (id: string, targetSqm: number) => void; // uniform shoelace scale to a target m²
  toggleFreezeVert: (id: string, index: number) => void;
  toggleFreezeEdge: (id: string, edgeIndex: number) => void;
  // --- plan detailing (slice 5): doors/windows/walls + a trace-over backdrop, on the unit's SUBTYPE plan ---
  planMarkers: (id: string) => PlanMarker[];
  addMarker: (id: string, marker: PlanMarker) => void;
  moveMarker: (id: string, index: number, patch: Partial<PlanMarker>) => void;
  removeMarker: (id: string, index: number) => void;
  setBackdrop: (id: string, backdrop: { dataUrl: string; mime: string } | undefined) => void;
  setDeedImage: (id: string, deedImage: { dataUrl: string; mime: string } | undefined) => void;
  // --- site geo (slice 2.5 — the map captures geographic truth + seeds the metre anchor) ---
  setSiteGeo: (id: string, siteGeo: SiteGeo, metreExtent?: { w: number; h: number }, preserveFootprint?: boolean) => void;
  removeNode: (id: string) => void;
}

function writeGeo(api: PackApi, mutate: (geo: GeoNode[]) => GeoNode[]) {
  const pack: Pack = api.pack;
  api.setPack({ ...pack, geo: mutate([...(pack.geo || [])]) });
}

/** The 0..1 footprint of a node as a point list (a rect becomes its 4 corners). undefined for no footprint. */
function footprintPoints(fp: Footprint | undefined): Array<{ x: number; y: number }> | undefined {
  if (!fp) return undefined;
  if (fp.shape === "poly") return fp.points;
  if (fp.shape === "rect") {
    const r = fp.rect;
    return [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ];
  }
  return undefined; // a bare point has no area → nothing to sync back to the parcel
}

/**
 * EDITOR → MAP write-back (draw-on-ref-then-align, D-; chose "the map is the source of truth"). When
 * the user reshapes a MAP-ANCHORED land node's footprint in the §4d editor, project that new shape BACK onto the
 * map parcel so the two never drift (the asymmetry hit: map→editor synced, editor→map didn't). A no-op
 * unless the node is a land node that already carries a ≥3-corner map parcel (nothing to anchor to otherwise). PURE.
 *
 * (D- metre-native step 3c) TWO anchor modes, so a ROTATED parcel never distorts:
 *   • northBearingDeg set (a PLACE-DRAWN / rotated parcel) → re-derive the ring RIGIDLY via footprintToLatLngParcel
 *     (the same isometry that placed it), honoring the bearing + the node's metre anchor + the parcel centroid.
 *     The axis-aligned-bbox path below would read the ROTATED ring's bbox (wrong aspect) and re-normalize the shape
 * per-axis → the shear. Keeping it rigid makes editor→map→editor lossless at any bearing.
 *   • no bearing (a freshly TRACED, north-up parcel) → the original bbox path: anchor on the parcel's geographic
 *     bbox (the SAME frame latLngPolygonToFootprint normalized against), so forward∘reverse is identity. Reshaping
 *     moves corners within that frame; dragging every vertex inward legitimately shrinks the plot (the sync fires
 *     only on a real footprint edit, never a no-op, so an unchanged shape never shrinks).
 */
function syncParcelFromFootprint(node: GeoNode): GeoNode {
  if (node.kind !== "land") return node;
  const sg = node.siteGeo;
  const parcel = sg?.landPolygon;
  if (!parcel || parcel.length < 3) return node; // not map-anchored → nothing to write back to
  const bearing = sg?.northBearingDeg ?? 0;
  if (bearing !== 0 && (node.metreW ?? 0) > 0 && (node.metreH ?? 0) > 0) {
    // ROTATED parcel — re-derive rigidly about the parcel centroid so the bearing survives (no bbox re-normalize).
    const cLat = parcel.reduce((s, p) => s + p[0], 0) / parcel.length;
    const cLng = parcel.reduce((s, p) => s + p[1], 0) / parcel.length;
    const ring = footprintToLatLngParcel(node.footprint, node.metreW, node.metreH, [cLat, cLng], bearing);
    if (!ring) return node;
    return { ...node, siteGeo: { ...sg, landPolygon: ring } };
  }
  const bbox = bboxFromLatLngPolygon(parcel);
  const pts = footprintPoints(node.footprint);
  if (!bbox || !pts || pts.length < 3) return node;
  const newParcel = footprintToLatLngPolygon({ shape: "poly", points: pts }, bbox);
  if (!newParcel) return node;
  return { ...node, siteGeo: { ...sg, landPolygon: newParcel } };
}

export function useGeo(api: PackApi): GeoApi {
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  //  SELF-HEAL stale focus/selection across a PACK SWAP. focusId/selectedId are local state; loading a sample,
  // generating the test building, or "New project" replaces the whole pack but leaves these pointing at node ids from
  // the OLD building. A stale focusId → an empty canvas ("Deepest level (prop)") AND — because Canvas freezes the
  // frame's metre extent per focusId — a stale metre scale, so the next building renders at the wrong size (a unit as
  // big as the land, a child bigger than its parent). Clearing them whenever they no longer resolve in the current
  // pack resets the view to the site level on every load, with zero per-loader wiring. caught this live.
  const geoIds = api.pack.geo;
  useEffect(() => {
    const ids = new Set((geoIds || []).map((n) => n.id));
    if (focusId !== undefined && !ids.has(focusId)) setFocusId(undefined);
    if (selectedId !== undefined && !ids.has(selectedId)) setSelectedId(undefined);
  }, [geoIds, focusId, selectedId]);

  const focus = useCallback((id?: string) => {
    setFocusId(id);
    setSelectedId(undefined);
  }, []);
  const selectNode = useCallback((id?: string) => setSelectedId(id), []);

  const addChild = useCallback(
    (kind: GeoKind, parentId?: string) => {
      const pid = parentId !== undefined ? parentId : focusId;
      let id = "";
      writeGeo(api, (geo) => {
        const node = makeNode(kind, pid, {}, new Set(geo.map((n) => n.id)));
        id = node.id;
        const next = [...geo, node];
        // (#3 → corrected) if the parent is a POLYGON and this is its FIRST child, seed the child AS the
        // parent's plate (level-aware: a FLOOR takes the FULL building plate — no shrink — a building a setback; a
        // unit is EXCLUDED because it TILES the floor, it doesn't inherit the floor shape). This gives real, dragga-
        // ble plate corners so "how the inside level fits" is obvious. ⚠ Fixes two bugs: (a) it used the parent's
        // RAW points (land-frame), not self-normalized to the child's frame → a floor under an inset building would
        // shrink to the building's position; (b) a blind ×0.8 made a floor 20% too small. parentShapeInChildFrame
        // does both correctly (footprintSelfNorm + insetForParentShape). Only the first child; later keep the default.
        if (pid && !geo.some((n) => n.parentId === pid)) {
          const seeded = parentShapeInChildFrame({ ...api.pack, geo: next } as Pack, node.id);
          if (seeded) node.footprint = seeded;
        }
        return next;
      });
      setSelectedId(id);
      return id;
    },
    [api, focusId]
  );

  const addRoot = useCallback(() => {
    let id = "";
    writeGeo(api, (geo) => {
      // root level = land if the project has none yet, else a building (the common entry)
      const hasLand = geo.some((n) => n.kind === "land" && !n.parentId);
      const node = makeNode(hasLand ? "building" : "land", undefined, {}, new Set(geo.map((n) => n.id)));
      id = node.id;
      return [...geo, node];
    });
    setSelectedId(id);
    return id;
  }, [api]);

  const patchNode = useCallback(
    (id: string, patch: Partial<GeoNode>) => {
      writeGeo(api, (geo) => geo.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    },
    [api]
  );

  // lock/unlock a node's GEOMETRY. Routes through patchNode (name/price/status stay editable).
  //  unlocking a RECT FLOOR auto-converts it to an EDITABLE POLYGON seeded at building ×0.8 (a visible
  // setback that prompts shaping) — so every floor becomes vertex-editable like Floor 1, not a dead rectangle. A poly
  // floor (already shaped) just unlocks. Locking is always a plain flag flip.
  const setLocked = useCallback((id: string, locked: boolean) => {
    const node = (api.pack.geo || []).find((n) => n.id === id);
    // unlocking a rect floor → become an editable polygon seeded at building ×0.8, in ONE store write (writeGeo is
    // the module-level primitive, so no forward-ref to patchPoly). A poly floor / any other node just flips the flag.
    if (!locked && node?.kind === "floor" && node.footprint?.shape !== "poly") {
      const seeded = parentShapeInChildFrame(api.pack, id, FLOOR_SEED_INSET);
      if (seeded) {
        writeGeo(api, (geo) => {
          const next = geo.map((n) => (n.id === id ? { ...n, footprint: { shape: "poly" as const, points: seeded.points }, locked: false } : n));
          // (D- step 5b) store the seeded floor metre-native — derive pointsM from the fresh points × anchor.
          const edited = next.find((n) => n.id === id);
          const fpM = edited && footprintWithStoredMetres({ ...api.pack, geo: next }, id, edited.footprint);
          let out = fpM && edited && fpM !== edited.footprint ? next.map((n) => (n.id === id ? { ...n, footprint: fpM } : n)) : next;
          // (Slice 2) also stamp the explicit metre POSITION of the newly-seeded floor shape.
          const posM = derivePosM({ ...api.pack, geo: out }, id);
          if (posM) out = out.map((n) => (n.id === id ? { ...n, posM } : n));
          return out;
        });
        return;
      }
    }
    patchNode(id, { locked });
  }, [api, patchNode]);

  // (parked item 2) APPROVE a floor's shape → mark it confirmed + SEED the next floor up from this one (once,
  // if that floor is still an unshaped rect). Soft checkpoint (Law #1): purely additive, never gates navigation,
  // never ripples lower edits upward. Pure core = seedNextFloorFromApproved.
  const approveFloor = useCallback((id: string) => {
    writeGeo(api, (geo) => seedNextFloorFromApproved(geo, id));
  }, [api]);

  // set/clear a node's FACING (pose metadata, NOT footprint geometry → editable even when the shape is
  // LOCKED; normalized to 0..359; undefined clears it). Routes through patchNode like name/price.
  const setFacing = useCallback(
    (id: string, facingDeg?: number) => patchNode(id, { facingDeg: facingDeg === undefined ? undefined : normDeg(facingDeg) }),
    [patchNode]
  );

  //  set a placed unit's ON-FLOOR rotation (0..359 clockwise about its own centre). PER-INSTANCE pose —
  // each unit of a subtype rotates independently (shared shape, own pose, D-). No-op when pos-locked. Routes
  // through patchNode. renderFootprint applies it, so the stored footprint rect is untouched (rotation ≠ reshape).
  const setRotation = useCallback(
    (id: string, rotationDeg: number) => {
      if ((api.pack.geo || []).find((n) => n.id === id)?.posLocked) return;
      patchNode(id, { rotationDeg: normDeg(rotationDeg) });
    },
    [api.pack.geo, patchNode]
  );

  //  toggle "Lock position on level" — pins a unit's placed pose (translate + rotate disabled). Distinct
  // from setLocked (shape/vertex lock); routes through patchNode so name/price/status stay editable either way.
  const setPosLocked = useCallback(
    (id: string, posLocked: boolean) => patchNode(id, { posLocked: posLocked || undefined }),
    [patchNode]
  );

  // (D-) APPROVE a unit's room shape → bring it INTO the level plan (it renders as its real shape in the
  // level overview instead of a marker). Soft/Law#1 — purely additive, never gates navigation. Mirrors approveFloor
  // but there's no seeding: it's just the draft→plan flag. Routes through patchNode (name/status stay editable).
  const setApproved = useCallback(
    (id: string, approved: boolean) => patchNode(id, { approved: approved || undefined }),
    [patchNode]
  );

  // (D-) OVERRIDE how a unit draws on the level overview: force "marker" or "shape", or clear to AUTO
  // (undefined = shape iff approved, else marker). Lets the user toggle one unit marker⇄shape independent of approval.
  const setRepresentation = useCallback(
    (id: string, representation?: "marker" | "shape") => patchNode(id, { representation }),
    [patchNode]
  );

  // place/clear a camera viewpoint (pose metadata, NOT geometry → editable when locked; clamped;
  // undefined clears it). Routes through patchNode like facing.
  const setCamera = useCallback(
    (id: string, camera?: Camera) => patchNode(id, { camera: camera === undefined ? undefined : clampCamera(camera) }),
    [patchNode]
  );

  // nudge ONE camera field (a drag writes x/y, a slider writes fovDeg, the aim handle writes facingDeg).
  // Merges onto the existing camera (seeding DEFAULT_CAMERA if none yet), re-clamped. A no-op if the node is gone.
  const patchCamera = useCallback(
    (id: string, patch: Partial<Camera>) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      if (!node) return;
      patchNode(id, { camera: clampCamera({ ...DEFAULT_CAMERA, ...(node.camera || {}), ...patch }) });
    },
    [api.pack.geo, patchNode]
  );

  // `syncParcel` (default true): a direct shape edit (canvas drag / vertex drag) writes back to the map parcel
  // (editor→map, D-). SIZE operations (Pin m² / constrain, and shape CONVERSIONS) pass false — they change the
  // footprint's scale, not the geographic plot, and routing them through the parcel's 0..1 clamp corrupted the
  // constrain (: Pin m² "stopped working" — the sync re-clamped the scaled polygon back into the frame).
  const moveResize = useCallback(
    (id: string, rect: Rect, syncParcel = true) => {
      if (isLocked(api.pack, id)) return; // a locked shape can't be dragged/resized
      //  a POSITION-locked unit can't be translated/resized on its floor (its placed pose is pinned). Distinct
      // from the shape lock above — a pos-locked unit's shared plan can still be re-shaped (authors the subtype).
      if ((api.pack.geo || []).find((n) => n.id === id)?.posLocked) return;
      //  a unit bound to a subtype with a DECLARED size can be MOVED but not re-SIZED — its area is the
      // subtype's binding legal size. Snap the dragged box back to that area, keeping the new
      // position + aspect. Position-only moves (w/h unchanged) already hit the target, so this is a no-op then.
      const lockSqm = subtypeLockedSqm(api.pack, id);
      const sized = lockSqm != null ? constrainRectSqmAtOrigin(api.pack, id, rect, lockSqm) : rect;
      const clamped = clampRect(sized);
      // (slice 3) a FLOOR can only be enlarged — a reshape that would push any child UNIT outside the new
      // floor is REJECTED (: "the floor must still hold every unit", reject-the-shrink). Enlarging always
      // passes. Only floors are gated; other kinds resize freely.
      const node0 = (api.pack.geo || []).find((n) => n.id === id);
      if (node0?.kind === "floor" && !unitsFitInFloorShape(api.pack, id, { shape: "rect", rect: clamped })) return;
      let geo = (api.pack.geo || []).map((n) => {
        if (n.id !== id) return n;
        const next: GeoNode = {
          ...n,
          footprint: { shape: "rect", rect: clamped },
          transform: { ...(n.transform || { scale: 1, rotation: 0 }), x: clamped.x, y: clamped.y, scale: 1, rotation: 0 },
        };
        return syncParcel ? syncParcelFromFootprint(next) : next;
      });
      // (Slice 2) STAMP the explicit metre POSITION after a drag/resize — the new rect min-corner in parent
      // metres. Same compute-from-the-new-geometry discipline as patchPoly (derivePosM ignores any stored posM).
      const posM = derivePosM({ ...api.pack, geo }, id);
      if (posM) geo = geo.map((n) => (n.id === id ? { ...n, posM } : n));
      api.setPack({ ...api.pack, geo });
    },
    [api]
  );

  const setStatus = useCallback(
    (id: string, status: UnitStatus) => patchNode(id, { status }),
    [patchNode]
  );

  const pinSqm = useCallback(
    (id: string, targetSqm: number) => {
      const rect = constrainToSqm(api.pack, id, targetSqm);
      moveResize(id, rect, false); // size-constrain: don't reshape the map parcel
    },
    [api.pack, moveResize]
  );

  // Duplicate a node under the SAME parent, offset one width to the right (clamped). Copies footprint (rect
  // or poly, incl. freeze sets), status, price, metre anchor, height — fast authoring of N similar units (§4b).
  const duplicateNode = useCallback(
    (id: string) => {
      let newIdOut = "";
      writeGeo(api, (geo) => {
        const src = geo.find((n) => n.id === id);
        if (!src) return geo;
        const r = footprintRect(src.footprint);
        const dx = Math.min(r.w, 1 - (r.x + r.w)); // shift right by its width, but don't push past the edge
        const shift = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y });
        const footprint: Footprint =
          src.footprint?.shape === "poly"
            ? { shape: "poly", points: src.footprint.points.map(shift), frozenVerts: src.footprint.frozenVerts, frozenEdges: src.footprint.frozenEdges }
            : { shape: "rect", rect: clampRect({ x: r.x + dx, y: r.y, w: r.w, h: r.h }) };
        const clone = makeNode(src.kind, src.parentId, {}, new Set(geo.map((n) => n.id)));
        newIdOut = clone.id;
        const next: GeoNode = {
          ...clone,
          name: src.name,
          footprint,
          transform: { x: r.x + dx, y: r.y, scale: 1, rotation: 0 },
          metreW: src.metreW,
          metreH: src.metreH,
          heightM: src.heightM,
          status: src.status,
          price: src.price ? { ...src.price } : undefined,
        };
        return [...geo, next];
      });
      if (newIdOut) setSelectedId(newIdOut);
      return newIdOut;
    },
    [api]
  );

  // §6a — seed a furniture package's props into a unit in ONE action (all at once, each relative+scaled to
  // the unit). Pure seedPackage builds the prop nodes; we append them and focus the unit so they're visible.
  const applyFurniturePackage = useCallback(
    (unitId: string, packageKey: string) => {
      writeGeo(api, (geo) => {
        const props = seedPackage(unitId, packageKey, new Set(geo.map((n) => n.id)));
        return props.length ? [...geo, ...props] : geo;
      });
      setFocusId(unitId); // zoom into the unit so the seeded props render
      setSelectedId(undefined);
    },
    [api]
  );

  // (Slice E) Drop a SINGLE piece into a unit — the per-prop add affordance (vs applyFurniturePackage's whole
  // layout). seedSingleProp builds one prop node at the icon's default footprint; we append it + focus the unit so
  // it renders. Mirrors applyFurniturePackage so one-piece and package pieces are identical nodes.
  const addProp = useCallback(
    (unitId: string, icon: PropIcon, label: string, priceUsd: number) => {
      writeGeo(api, (geo) => {
        const prop = seedSingleProp(unitId, icon, label, priceUsd, new Set(geo.map((n) => n.id)));
        return [...geo, prop];
      });
      setFocusId(unitId); // zoom into the unit so the new piece renders
      setSelectedId(undefined);
    },
    [api]
  );

  // Replace a prop's icon/label/price (the "swap the marker for a bar stool" action, §6a) — geometry unchanged.
  const swapProp = useCallback(
    (id: string, icon: PropIcon, label: string, priceUsd: number) => patchNode(id, swapPropPatch(icon, label, priceUsd)),
    [patchNode]
  );

  // --- polygon editing --------------------------------------------------------
  // write a new poly footprint, carrying any freeze sets through unless explicitly replaced. `syncParcel`
  // (default true): a direct vertex/outline edit writes back to the map parcel (D-); size-constrain, shape
  // conversion and freeze-toggles pass false (they must not reshape the geographic plot — see moveResize note).
  const patchPoly = useCallback(
    (id: string, next: Partial<Extract<Footprint, { shape: "poly" }>>, syncParcel = true) => {
      if (isLocked(api.pack, id)) return; // a locked shape can't be vertex/edge/poly-edited
      // (slice 3) reject a FLOOR reshape that would push any child UNIT outside the new shape (reject-the-
      // shrink; enlarging always passes). Only when the node is a floor and the edit actually changes the points.
      const target = (api.pack.geo || []).find((n) => n.id === id);
      if (target?.kind === "floor" && next.points) {
        const cur = target.footprint?.shape === "poly" ? target.footprint : undefined;
        const proposed: Footprint = {
          shape: "poly",
          points: next.points,
          frozenVerts: next.frozenVerts !== undefined ? next.frozenVerts : cur?.frozenVerts,
          frozenEdges: next.frozenEdges !== undefined ? next.frozenEdges : cur?.frozenEdges,
        };
        if (!unitsFitInFloorShape(api.pack, id, proposed)) return;
      }
      // (D-) a unit that ALREADY resolves a SHARED PLAN edits the PLAN DIRECTLY — never its own footprint.
      // The vertex op fed us `next.points` in the PLAN's frame (editSource → effectiveFootprint → the plan), so
      // writing them onto the node's own footprint would CLOBBER this unit's on-floor placement (its position rect)
      // with plan coordinates → the unit teleports, and siblings of the subtype diverge from "shape shared / position
      // own" (D-). So write ONLY the shared plan; the own footprint stays the placement, and renderFootprint
      // re-places the updated shared shape into it. (A subtype with NO plan yet falls through to seed both below —
      // that first author legitimately establishes the plan FROM the own footprint.)
      if (target && editsSharedPlanOnly(api.pack, target)) {
        const cur = target.footprint?.shape === "poly" ? target.footprint : undefined;
        const planFootprint: Extract<Footprint, { shape: "poly" }> = {
          shape: "poly",
          // (D- step 5b) build without pointsM, then stamp from the editing unit's realMetres — the plan's
          // shared OUTLINE stored metre-native, never carrying a stale pointsM from `cur`.
          points: next.points ?? cur?.points ?? [],
          frozenVerts: next.frozenVerts !== undefined ? next.frozenVerts : cur?.frozenVerts,
          frozenEdges: next.frozenEdges !== undefined ? next.frozenEdges : cur?.frozenEdges,
        };
        const withM = planFootprintWithStoredMetres(planFootprint, realMetres(api.pack, target.id));
        const tgt = subtypePlanTarget(api.pack, target, { footprint: withM });
        if (tgt) api.setSubtypePlan(tgt.buildingId, tgt.typeKey, tgt.subtypeKey, tgt.plan);
        return;
      }
      let edited: GeoNode | undefined;
      let geo = (api.pack.geo || []).map((n) => {
        if (n.id !== id) return n;
        const cur = n.footprint?.shape === "poly" ? n.footprint : undefined;
        const points = next.points ?? cur?.points ?? [];
        const updated: GeoNode = {
          ...n,
          footprint: {
            shape: "poly",
            points,
            // (D- step 5b) build WITHOUT pointsM — the fresh 0..1 points are the live edit; the metre-native
            // pointsM is re-stamped below from the resolved pack so it never carries a STALE value from `cur`.
            frozenVerts: next.frozenVerts !== undefined ? next.frozenVerts : cur?.frozenVerts,
            frozenEdges: next.frozenEdges !== undefined ? next.frozenEdges : cur?.frozenEdges,
          },
        };
        edited = syncParcel ? syncParcelFromFootprint(updated) : updated;
        return edited;
      });
      //  if the edited node is a BUILDING that just became a polygon, BORN-seed its rect floors at building
      // ×0.8 (a visible setback that prompts shaping) — once, pure, never over an already-shaped poly floor.
      if (edited?.kind === "building") geo = seedRectFloorsUnderPolyBuilding(geo, id);
      // (D- step 5b) STAMP stored metres: toMetrePoly derives from the fresh 0..1 points (pointsM absent) ×
      // the anchor, and we persist the result as footprint.pointsM so the edit is stored metre-native. Done on the
      // assembled geo (so the anchor resolves) and ONLY for the edited node. A node with no metre anchor yet stays
      // 0..1 (footprintWithStoredMetres returns it unchanged) until an anchor exists. This is the write that makes
      // storage the source of truth; the stale-pointsM hazard is avoided because we never spread an old pointsM.
      if (edited?.footprint?.shape === "poly") {
        const packForMetres: Pack = { ...api.pack, geo };
        const fpM = footprintWithStoredMetres(packForMetres, id, edited.footprint);
        if (fpM && fpM !== edited.footprint) {
          edited = { ...edited, footprint: fpM };
          geo = geo.map((n) => (n.id === id ? edited! : n));
        }
      }
      // (kill-the-bbox arc Slice 2) STAMP the explicit metre POSITION. The edit's fresh 0..1 points determine
      // where the node's min-corner sits in parent metres; persist that as `posM` so POSITION is stored metre-native,
      // not re-derived from a bbox fraction that shifts under a later shape edit. Derive from the assembled geo with
      // the OLD posM cleared (derivePosM ignores stored posM → never re-reads a stale value, same discipline as the
      // pointsM stamp). No parent / no parent-metres → stays position-fraction-derived (derivePosM returns undefined).
      if (edited && edited.parentId) {
        const posM = derivePosM({ ...api.pack, geo }, id);
        if (posM) {
          edited = { ...edited, posM };
          geo = geo.map((n) => (n.id === id ? edited! : n));
        }
      }
      // the geo write (the node's own footprint — the live editing surface) goes through setPack (persists geo).
      api.setPack({ ...api.pack, geo });
      // (slice 4 + persistence fix) if the edited node is bound to a SUBTYPE, mirror the new SHAPE onto the
      // subtype's shared plan in the DURABLE authored model (setSubtypePlan) — NOT via setPack, which only carries
      // geo and silently drops the buildings change (the bug). So editing one unit authors the whole subtype
      // AND it survives reload; every unit of the subtype renders it (effectiveFootprint).
      if (edited?.footprint?.shape === "poly") {
        const tgt = subtypePlanTarget(api.pack, edited, { footprint: edited.footprint });
        if (tgt) api.setSubtypePlan(tgt.buildingId, tgt.typeKey, tgt.subtypeKey, tgt.plan);
      }
    },
    [api]
  );

  const toPoly = useCallback(
    (id: string) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      // (slice 4) if this unit's SUBTYPE already has a shared plan, start editing FROM it (so re-editing any
      // unit of the subtype refines the one authored shape, never resets it).
      const plan = resolvePlan(api.pack, node);
      if (plan) {
        patchPoly(id, { points: plan.footprint.points, frozenVerts: plan.footprint.frozenVerts, frozenEdges: plan.footprint.frozenEdges }, false);
        return;
      }
      //  "Edit the floor/building shape" is the HONEST rect→quad conversion: four draggable corners from the
      // current bounding rect, so you can reshape it as you need. It deliberately does NOT auto-adopt the parent plate
      // — that is the dedicated "Match the building plate" button (geo.matchParentShape), which is the explicit, lock-
      // and-guard-aware adoption. Keeping the two actions single-purpose avoids toPoly silently fighting the floor
      // reject-the-shrink guard (a plate smaller than the unit grid would be rejected → "nothing happens").
      const r = footprintRect(node?.footprint);
      const points = [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h },
      ];
      patchPoly(id, { points, frozenVerts: undefined, frozenEdges: undefined }, false); // shape conversion, not a parcel reshape
    },
    [api.pack, patchPoly]
  );

  const toRect = useCallback(
    (id: string) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      const r = footprintRect(node?.footprint); // poly → its bbox
      moveResize(id, r, false); // shape conversion, not a parcel reshape
    },
    [api.pack.geo, moveResize]
  );

  // → — a node takes its PARENT's shape (level-aware inset) as its own footprint in one click:
  // a building matches the land parcel (setback), a FLOOR matches the building plate (full, no shrink — the
  // constant-plate model). Units are excluded upstream (canMatchParentShape is false — they TILE the floor). Writes
  // the unlock AND the new poly in ONE atomic setPack: we must NOT lean on an unlock landing before a second
  // patchPoly call (both read the same stale api.pack that tick → patchPoly's lock-guard sees locked:true and drops
  // the reshape — the batching trap). A no-op if the parent has no polygon to inherit.
  const matchParentShape = useCallback(
    (id: string) => {
      const fp = parentShapeInChildFrame(api.pack, id);
      if (!fp) return;
      let geo = (api.pack.geo || []).map((n) =>
        n.id === id ? { ...n, locked: false, footprint: { shape: "poly" as const, points: fp.points } } : n
      );
      //  a building that just matched its parcel became a poly → born-seed its rect floors at building ×0.8.
      const target = (api.pack.geo || []).find((n) => n.id === id);
      if (target?.kind === "building") geo = seedRectFloorsUnderPolyBuilding(geo, id);
      // (D- step 5b) store the matched shape metre-native (fresh points, no stale pointsM → derive + stamp).
      const matched = geo.find((n) => n.id === id);
      const fpM = matched && footprintWithStoredMetres({ ...api.pack, geo }, id, matched.footprint);
      if (fpM && matched && fpM !== matched.footprint) geo = geo.map((n) => (n.id === id ? { ...n, footprint: fpM } : n));
      // (Slice 2) re-stamp the explicit metre POSITION — matching the parent plate moved the min-corner, so a
      // previously-stored posM would be STALE. Derive from the new points (derivePosM ignores stored posM).
      const posM = derivePosM({ ...api.pack, geo }, id);
      if (posM) geo = geo.map((n) => (n.id === id ? { ...n, posM } : n));
      api.setPack({ ...api.pack, geo });
    },
    [api]
  );

  //  — lay a FLOOR's units at their REAL m² size inside a sensibly-sized plate (replacing the dumb even
  // grid that made every unit fill a third of the frame). Sizes the plate from the units, subdivides it into cells
  // proportional to each unit's declared size with a corridor, and PRESERVES each unit's identity (name/status/
  // price/subtypeRef). The whole thing is one pure pack rewrite → one setPack. "User fixes units manually after."
  const layUnitsToScale = useCallback(
    (floorId: string, corridorWidthM = DEFAULT_CORRIDOR_M) => {
      const next = layUnitsToScalePure(api.pack, floorId, corridorWidthM);
      if (next !== api.pack) api.setPack(next);
    },
    [api]
  );

  const setPolyPoints = useCallback(
    (id: string, points: Array<{ x: number; y: number }>) => patchPoly(id, { points }),
    [patchPoly]
  );

  //  the EDIT SOURCE for a poly vertex op is the EFFECTIVE footprint — the subtype's SHARED plan when the
  // node is bound (else the node's own). So editing a subtype-bound unit's shape operates on the shared plan (which
  // patchPoly also WRITES), not the node's own footprint — killing the own-vs-plan drift (D-). PURE read.
  const editSource = useCallback(
    (id: string) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      const fp = effectiveFootprint(api.pack, node);
      return fp?.shape === "poly" ? fp : undefined;
    },
    [api.pack]
  );

  const moveVertex = useCallback(
    (id: string, index: number, pt: { x: number; y: number }) => {
      const fp = editSource(id);
      if (!fp) return;
      const frozen = new Set(fp.frozenVerts || []);
      if (frozen.has(index)) return; // a frozen vertex can't be dragged
      const clamped = { x: Math.max(0, Math.min(1, pt.x)), y: Math.max(0, Math.min(1, pt.y)) };
      const points = fp.points.map((p, i) => (i === index ? clamped : p));
      patchPoly(id, { points });
    },
    [editSource, patchPoly]
  );

  const addVertex = useCallback(
    (id: string, afterIndex: number) => {
      const fp = editSource(id);
      if (!fp) return;
      const pts = fp.points;
      const a = pts[afterIndex];
      const b = pts[(afterIndex + 1) % pts.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const points = [...pts.slice(0, afterIndex + 1), mid, ...pts.slice(afterIndex + 1)];
      // inserting shifts indices after the split → clearing freeze sets keeps semantics honest
      patchPoly(id, { points, frozenVerts: undefined, frozenEdges: undefined });
    },
    [editSource, patchPoly]
  );

  const removeVertex = useCallback(
    (id: string, index: number) => {
      const fp = editSource(id);
      if (!fp || fp.points.length <= 3) return;
      const points = fp.points.filter((_, i) => i !== index);
      patchPoly(id, { points, frozenVerts: undefined, frozenEdges: undefined });
    },
    [editSource, patchPoly]
  );

  const setEdgeLength = useCallback(
    (id: string, edgeIndex: number, metres: number) => {
      const points = setEdgeLengthMetres(api.pack, id, edgeIndex, metres);
      if (points.length) patchPoly(id, { points });
    },
    [api.pack, patchPoly]
  );

  const pinPolySqm = useCallback(
    (id: string, targetSqm: number) => {
      const r = constrainPolySqm(api.pack, id, targetSqm);
      if (r.kind === "points") {
        if (r.points.length) patchPoly(id, { points: r.points }, false); // don't reshape the map parcel
        return;
      }
      // (D- step 6) ANCHOR node: the scale lives in metreW/metreH, not the points. (D- INDEPENDENT ANCHORS,
      // ) A NON-leaf anchor (e.g. the Skyline land holding a building) sets r.scaleChildren — resizing the
      // land is a PLOT-boundary op ("resize the plot, not the tower"), so every direct child is ALSO scaled by 1/k
      // about the anchor's fixed origin → its real size (fraction × land metres) stays invariant. A LEAF anchor has no
      // children to compensate and scales cleanly: apply k to metreW/H, aspect kept.
      const node = (api.pack.geo || []).find((n) => n.id === id);
      if (!node) return;
      const nextW = node.metreW != null ? node.metreW * r.k : undefined;
      const nextH = node.metreH != null ? node.metreH * r.k : undefined;
      if (nextW == null || nextH == null) return;
      const fp = node.footprint?.shape === "poly" ? { ...node.footprint } : node.footprint;
      if (fp && fp.shape === "poly" && "pointsM" in fp) delete (fp as { pointsM?: unknown }).pointsM;
      // Scale the anchor by k (and CLEAR its stored pointsM so it re-stamps from the NEW anchor on the next projection
      // — 5c lazy-hydrate; a stale pointsM would re-assert the OLD metres, the quirk's cousin). For a non-leaf anchor,
      // compensate every DIRECT child in the SAME write so the tree stays consistent.
      writeGeo(api, (geo) =>
        geo.map((n) => {
          if (n.id === id) return { ...n, metreW: nextW, metreH: nextH, footprint: fp };
          if (r.scaleChildren && n.parentId === id) {
            const scaled = scaleFootprintAboutOrigin(n.footprint, 1 / r.k);
            return scaled ? { ...n, footprint: scaled } : n;
          }
          return n;
        })
      );
    },
    [api, patchPoly]
  );

  // (D-) freeze a VERTEX/EDGE on the EFFECTIVE shape — the shared plan for a subtype-bound unit (its own
  // footprint is now the placement rect), else the own poly. patchPoly's plan-only write lands the flag on the plan.
  const toggleFreezeVert = useCallback(
    (id: string, index: number) => {
      const fp = editSource(id);
      if (!fp) return;
      patchPoly(id, { frozenVerts: toggleInSet(fp.frozenVerts, index) }, false); // freeze flag only
    },
    [editSource, patchPoly]
  );

  const toggleFreezeEdge = useCallback(
    (id: string, edgeIndex: number) => {
      const fp = editSource(id);
      if (!fp) return;
      patchPoly(id, { frozenEdges: toggleInSet(fp.frozenEdges, edgeIndex) }, false); // freeze flag only
    },
    [editSource, patchPoly]
  );

  // --- plan DETAILING (slice 5): doors/windows/walls + a trace-over backdrop. All live on the unit's SUBTYPE
  // plan (shared by every unit of the subtype, like the footprint) via writeSubtypePlanPatch. The plan must already
  // have a footprint — author the shape first (markers key off a drawn plan). A no-op on a plan-less / unbound node.
  const planMarkers = useCallback(
    (id: string): PlanMarker[] => resolvePlan(api.pack, (api.pack.geo || []).find((n) => n.id === id))?.markers ?? [],
    [api.pack]
  );
  const writeMarkers = useCallback(
    (id: string, markers: PlanMarker[]) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      // durable write (setSubtypePlan), NOT setPack — so markers persist + are shared across the subtype (fix).
      const tgt = subtypePlanTarget(api.pack, node, { markers });
      if (tgt) api.setSubtypePlan(tgt.buildingId, tgt.typeKey, tgt.subtypeKey, tgt.plan);
    },
    [api]
  );
  const addMarker = useCallback(
    (id: string, marker: PlanMarker) => writeMarkers(id, [...planMarkers(id), marker]),
    [planMarkers, writeMarkers]
  );
  const moveMarker = useCallback(
    (id: string, index: number, patch: Partial<PlanMarker>) => {
      const next = planMarkers(id).map((m, i) => (i === index ? ({ ...m, ...patch } as PlanMarker) : m));
      writeMarkers(id, next);
    },
    [planMarkers, writeMarkers]
  );
  const removeMarker = useCallback(
    (id: string, index: number) => writeMarkers(id, planMarkers(id).filter((_, i) => i !== index)),
    [planMarkers, writeMarkers]
  );
  const setBackdrop = useCallback(
    (id: string, backdrop: { dataUrl: string; mime: string } | undefined) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      // durable write (setSubtypePlan), NOT setPack — so the trace backdrop persists + is shared (fix).
      const tgt = subtypePlanTarget(api.pack, node, { backdrop });
      if (tgt) api.setSubtypePlan(tgt.buildingId, tgt.typeKey, tgt.subtypeKey, tgt.plan);
    },
    [api]
  );

  // (slice C) a LAND node's TITLE-DEED reference image — plain node field (not a shared subtype plan), so it
  // routes through patchNode. Drawn dim behind the land in its own focus view to trace the parcel over. undefined clears.
  const setDeedImage = useCallback(
    (id: string, deedImage: { dataUrl: string; mime: string } | undefined) => patchNode(id, { deedImage }),
    [patchNode]
  );

  // Store geographic truth on a node AND, when the parcel gives a metre extent, adopt it as the node's metre
  // ANCHOR (metreW/metreH) — this is the §4d "metres enter at an anchor" source for real projects.
  // MAP→EDITOR bridge (D- draw-on-map-first): a ≥3-corner parcel ALSO becomes the node's base FOOTPRINT
  // (bbox-normalized poly) so children lay out inside the true parcel plate, not a lying rect — UNLESS the shape
  // is LOCKED (a locked footprint is held). transform.rotation stays untouched (editor-space ≠ geo-space).
  const setSiteGeo = useCallback(
    (id: string, siteGeo: SiteGeo, metreExtent?: { w: number; h: number }, preserveFootprint?: boolean) => {
      const locked = isLocked(api.pack, id);
      // (D- metre-native step 3c) `preserveFootprint` = a PLACE-DRAWN write: the editor already holds the true
      // un-rotated metre footprint and `siteGeo.northBearingDeg` IS the placement rotation. The ring is a derived
      // VIEW — re-importing it here would re-normalize the ROTATED ring and distort the shape (the drift). So
      // when preserving, we store ONLY the geography (center + ring + bearing) and leave the editor footprint + metre
      // anchor untouched — the metre shape stays the one source of truth.
      //
      // (D- square-grid redesign) TRACE-then-refine (no preserveFootprint): DE-TILT the traced parcel into
      // a SQUARE authoring footprint + its de-tilted metre extent + the plot bearing. The OLD latLngPolygonToFootprint
      // handed back a TILTED bbox-normalized shape born skewed (the root warp); latLngPolygonToSquareFootprint instead
      // straightens the deed shape to the front-down square frame and stores the plot's real-world rotation in
      // `northBearingDeg`, applied MAP-SIDE ONLY. The de-tilt supplies its own extent + bearing, so we IGNORE the
      // caller's metreExtent (the rotated bbox) when it fires.
      const detilt = locked || preserveFootprint ? undefined : latLngPolygonToSquareFootprint(siteGeo.landPolygon);
      const siteGeoOut: SiteGeo = detilt ? { ...siteGeo, northBearingDeg: detilt.bearingDeg } : siteGeo;
      const adoptExtent = detilt
        ? { metreW: detilt.metreW, metreH: detilt.metreH }
        : metreExtent && !preserveFootprint
        ? { metreW: metreExtent.w, metreH: metreExtent.h }
        : undefined;
      writeGeo(api, (geo) =>
        geo.map((n) =>
          n.id === id
            ? {
                ...n,
                siteGeo: siteGeoOut,
                ...(adoptExtent ? adoptExtent : {}),
                ...(detilt ? { footprint: detilt.footprint } : {}),
              }
            : n
        )
      );
    },
    [api]
  );

  const removeNode = useCallback(
    (id: string) => {
      writeGeo(api, (geo) => {
        // cascade-remove descendants (a flat array with parentId — collect the subtree first)
        const doomed = new Set<string>([id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const n of geo) {
            if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
              doomed.add(n.id);
              grew = true;
            }
          }
        }
        return geo.filter((n) => !doomed.has(n.id));
      });
      setSelectedId((cur) => (cur === id ? undefined : cur));
      setFocusId((cur) => (cur === id ? undefined : cur));
    },
    [api]
  );

  return useMemo<GeoApi>(
    () => ({
      focusId, selectedId, focus, selectNode, addChild, addRoot, patchNode, setLocked, approveFloor, setFacing, setRotation, setPosLocked, setApproved, setRepresentation, setCamera, patchCamera, moveResize, setStatus, pinSqm,
      duplicateNode, applyFurniturePackage, addProp, swapProp, toPoly, toRect, matchParentShape, layUnitsToScale, setPolyPoints, moveVertex, addVertex, removeVertex, setEdgeLength, pinPolySqm,
      toggleFreezeVert, toggleFreezeEdge, planMarkers, addMarker, moveMarker, removeMarker, setBackdrop, setDeedImage, setSiteGeo, removeNode,
    }),
    [
      focusId, selectedId, focus, selectNode, addChild, addRoot, patchNode, setLocked, approveFloor, setFacing, setRotation, setPosLocked, setApproved, setRepresentation, setCamera, patchCamera, moveResize, setStatus, pinSqm,
      duplicateNode, applyFurniturePackage, addProp, swapProp, toPoly, toRect, matchParentShape, layUnitsToScale, setPolyPoints, moveVertex, addVertex, removeVertex, setEdgeLength, pinPolySqm,
      toggleFreezeVert, toggleFreezeEdge, planMarkers, addMarker, moveMarker, removeMarker, setBackdrop, setDeedImage, setSiteGeo, removeNode,
    ]
  );
}

/** Convenience: the kind a new child of the focused node would be (null at max depth / prop). */
export function nextChildKind(pack: Pack, focusId?: string): GeoKind | null {
  if (!focusId) return rootNodes(pack).some((n) => n.kind === "land") ? "building" : "land";
  const parent = (pack.geo || []).find((n) => n.id === focusId);
  if (!parent) return null;
  return CHILD_KIND[parent.kind];
}
