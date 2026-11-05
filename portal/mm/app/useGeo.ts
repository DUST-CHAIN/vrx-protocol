"use client";

// Studio-face state (slice 2) — the §4d drawing board. Holds which node is FOCUSED (the "parent" whose
// children you're drawing inside) and which node is SELECTED (inspected/edited), plus immutable setters that
// write pack.geo[] through usePack's setPack. The textual spine (usePack) is untouched; geo is its own layer.

import { useCallback, useMemo, useState } from "react";
import type { GeoKind, GeoNode, Pack, SiteGeo, UnitStatus } from "@/lib/pack";
import type { Footprint } from "@/lib/pack";
import {
  CHILD_KIND,
  clampRect,
  constrainPolySqm,
  constrainToSqm,
  footprintRect,
  makeNode,
  rootNodes,
  setEdgeLengthMetres,
  toggleInSet,
  type Rect,
} from "@/lib/geo";
import { seedPackage, swapPropPatch, type PropIcon } from "@/lib/furniture";
import type { PackApi } from "./usePack";

export interface GeoApi {
  focusId?: string; // the node we're drawing INSIDE (its children show on the canvas); undefined = root level
  selectedId?: string; // the node being inspected
  focus: (id?: string) => void;
  selectNode: (id?: string) => void;
  addChild: (kind: GeoKind, parentId?: string) => string; // add a child under parentId (default: current focus)
  addRoot: () => string; // add a land/building at root level
  patchNode: (id: string, patch: Partial<GeoNode>) => void;
  moveResize: (id: string, rect: Rect) => void; // drag/resize → clamped footprint
  setStatus: (id: string, status: UnitStatus) => void;
  pinSqm: (id: string, targetSqm: number) => void; // constrain to a real m² (keeps aspect)
  duplicateNode: (id: string) => string; // clone a node (same size/status/price) offset right, under the same parent
  applyFurniturePackage: (unitId: string, packageKey: string) => void; // §6a — seed a package's props into a unit
  swapProp: (id: string, icon: PropIcon, label: string, priceUsd: number) => void; // replace a prop's icon/label/price
  // --- polygon editing (illustration-grade dimensioned footprints) ---
  toPoly: (id: string) => void; // convert a rect footprint into an editable 4-point polygon
  toRect: (id: string) => void; // flatten a poly back to its bounding rect
  setPolyPoints: (id: string, points: Array<{ x: number; y: number }>) => void; // vertex drag / add / delete
  moveVertex: (id: string, index: number, pt: { x: number; y: number }) => void;
  addVertex: (id: string, afterIndex: number) => void; // split the edge after `afterIndex` at its midpoint
  removeVertex: (id: string, index: number) => void; // keep ≥ 3
  setEdgeLength: (id: string, edgeIndex: number, metres: number) => void; // dimension-driven (linked follow)
  pinPolySqm: (id: string, targetSqm: number) => void; // uniform shoelace scale to a target m²
  toggleFreezeVert: (id: string, index: number) => void;
  toggleFreezeEdge: (id: string, edgeIndex: number) => void;
  // --- site geo (slice 2.5 — the map captures geographic truth + seeds the metre anchor) ---
  setSiteGeo: (id: string, siteGeo: SiteGeo, metreExtent?: { w: number; h: number }) => void;
  removeNode: (id: string) => void;
}

function writeGeo(api: PackApi, mutate: (geo: GeoNode[]) => GeoNode[]) {
  const pack: Pack = api.pack;
  api.setPack({ ...pack, geo: mutate([...(pack.geo || [])]) });
}

export function useGeo(api: PackApi): GeoApi {
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

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
        return [...geo, node];
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

  const moveResize = useCallback(
    (id: string, rect: Rect) => {
      const clamped = clampRect(rect);
      writeGeo(api, (geo) =>
        geo.map((n) =>
          n.id === id
            ? {
                ...n,
                footprint: { shape: "rect", rect: clamped },
                transform: { ...(n.transform || { scale: 1, rotation: 0 }), x: clamped.x, y: clamped.y, scale: 1, rotation: 0 },
              }
            : n
        )
      );
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
      moveResize(id, rect);
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

  // Replace a prop's icon/label/price (the "swap the marker for a bar stool" action, §6a) — geometry unchanged.
  const swapProp = useCallback(
    (id: string, icon: PropIcon, label: string, priceUsd: number) => patchNode(id, swapPropPatch(icon, label, priceUsd)),
    [patchNode]
  );

  // --- polygon editing --------------------------------------------------------
  // write a new poly footprint, carrying any freeze sets through unless explicitly replaced
  const patchPoly = useCallback(
    (id: string, next: Partial<Extract<Footprint, { shape: "poly" }>>) => {
      writeGeo(api, (geo) =>
        geo.map((n) => {
          if (n.id !== id) return n;
          const cur = n.footprint?.shape === "poly" ? n.footprint : undefined;
          const points = next.points ?? cur?.points ?? [];
          return {
            ...n,
            footprint: {
              shape: "poly",
              points,
              frozenVerts: next.frozenVerts !== undefined ? next.frozenVerts : cur?.frozenVerts,
              frozenEdges: next.frozenEdges !== undefined ? next.frozenEdges : cur?.frozenEdges,
            },
          };
        })
      );
    },
    [api]
  );

  const toPoly = useCallback(
    (id: string) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      const r = footprintRect(node?.footprint);
      // four corners of the current bounding rect → an editable quad (clockwise)
      const points = [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h },
      ];
      patchPoly(id, { points, frozenVerts: undefined, frozenEdges: undefined });
    },
    [api.pack.geo, patchPoly]
  );

  const toRect = useCallback(
    (id: string) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      const r = footprintRect(node?.footprint); // poly → its bbox
      moveResize(id, r);
    },
    [api.pack.geo, moveResize]
  );

  const setPolyPoints = useCallback(
    (id: string, points: Array<{ x: number; y: number }>) => patchPoly(id, { points }),
    [patchPoly]
  );

  const moveVertex = useCallback(
    (id: string, index: number, pt: { x: number; y: number }) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      if (node?.footprint?.shape !== "poly") return;
      const frozen = new Set(node.footprint.frozenVerts || []);
      if (frozen.has(index)) return; // a frozen vertex can't be dragged
      const clamped = { x: Math.max(0, Math.min(1, pt.x)), y: Math.max(0, Math.min(1, pt.y)) };
      const points = node.footprint.points.map((p, i) => (i === index ? clamped : p));
      patchPoly(id, { points });
    },
    [api.pack.geo, patchPoly]
  );

  const addVertex = useCallback(
    (id: string, afterIndex: number) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      if (node?.footprint?.shape !== "poly") return;
      const pts = node.footprint.points;
      const a = pts[afterIndex];
      const b = pts[(afterIndex + 1) % pts.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const points = [...pts.slice(0, afterIndex + 1), mid, ...pts.slice(afterIndex + 1)];
      // inserting shifts indices after the split → clearing freeze sets keeps semantics honest
      patchPoly(id, { points, frozenVerts: undefined, frozenEdges: undefined });
    },
    [api.pack.geo, patchPoly]
  );

  const removeVertex = useCallback(
    (id: string, index: number) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      if (node?.footprint?.shape !== "poly" || node.footprint.points.length <= 3) return;
      const points = node.footprint.points.filter((_, i) => i !== index);
      patchPoly(id, { points, frozenVerts: undefined, frozenEdges: undefined });
    },
    [api.pack.geo, patchPoly]
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
      const points = constrainPolySqm(api.pack, id, targetSqm);
      if (points.length) patchPoly(id, { points });
    },
    [api.pack, patchPoly]
  );

  const toggleFreezeVert = useCallback(
    (id: string, index: number) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      if (node?.footprint?.shape !== "poly") return;
      patchPoly(id, { frozenVerts: toggleInSet(node.footprint.frozenVerts, index) });
    },
    [api.pack.geo, patchPoly]
  );

  const toggleFreezeEdge = useCallback(
    (id: string, edgeIndex: number) => {
      const node = (api.pack.geo || []).find((n) => n.id === id);
      if (node?.footprint?.shape !== "poly") return;
      patchPoly(id, { frozenEdges: toggleInSet(node.footprint.frozenEdges, edgeIndex) });
    },
    [api.pack.geo, patchPoly]
  );

  // Store geographic truth on a node AND, when the parcel gives a metre extent, adopt it as the node's metre
  // ANCHOR (metreW/metreH) — this is the §4d "metres enter at an anchor" source for real projects.
  // The editor's footprint fractions and transform.rotation are left untouched (editor-space ≠ geo-space).
  const setSiteGeo = useCallback(
    (id: string, siteGeo: SiteGeo, metreExtent?: { w: number; h: number }) => {
      writeGeo(api, (geo) =>
        geo.map((n) =>
          n.id === id
            ? {
                ...n,
                siteGeo,
                ...(metreExtent ? { metreW: metreExtent.w, metreH: metreExtent.h } : {}),
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
      focusId, selectedId, focus, selectNode, addChild, addRoot, patchNode, moveResize, setStatus, pinSqm,
      duplicateNode, applyFurniturePackage, swapProp, toPoly, toRect, setPolyPoints, moveVertex, addVertex, removeVertex, setEdgeLength, pinPolySqm,
      toggleFreezeVert, toggleFreezeEdge, setSiteGeo, removeNode,
    }),
    [
      focusId, selectedId, focus, selectNode, addChild, addRoot, patchNode, moveResize, setStatus, pinSqm,
      duplicateNode, applyFurniturePackage, swapProp, toPoly, toRect, setPolyPoints, moveVertex, addVertex, removeVertex, setEdgeLength, pinPolySqm,
      toggleFreezeVert, toggleFreezeEdge, setSiteGeo, removeNode,
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
