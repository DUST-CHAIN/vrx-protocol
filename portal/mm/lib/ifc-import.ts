// ─────────────────────────────────────────────────────────────────────────────
// lib/ifc-import.ts — the IFC thin-slice EXTRACTOR (VRX format strategy, D- lane 1).
//
// PURE + DETERMINISTIC. Takes a real CAD building (IFC) and pulls the THIN slice MM cares about —
// floors, room/unit footprints, and door/window openings — ignoring the 95% (MEP, structure,
// materials, walls-as-solids). This is lane 1 of the two import lanes: the STRUCTURED parser (not an
// LLM). It does NOT touch the store; it emits an intermediate `IfcSlice` that a later mapping step
// turns into MM's subtype model via the existing write path (review-then-accept).
//
// ── Why the IfcReader seam ──
// web-ifc is a ~1.6 MB WASM blob; we do NOT want it in unit tests. So this module depends only on a
// tiny `IfcReader` interface (the handful of web-ifc calls we use) + the IFC type codes, both injected.
// Tests mock a 5-room building in-memory (pure, instant); the browser passes the real `IfcAPI` + file.
//
// ── What the Schependomlaan probe taught us (verified the real 47 MB file) ──
//  • Length unit = MILLI·METRE → every coordinate /1000 for metres (read from IfcProject units, not assumed).
//  • Spaces carry their outline as a "FootPrint" representation = IfcGeometricCurveSet → IfcPolyline (mm).
//    (This ArchiCAD export has NO swept-area solid + web-ifc does NOT mesh IfcSpace → we read the 2D curve.)
//  • Space → storey is the IfcRelAggregates containment, NOT the space Name ("3.08" is an APARTMENT number,
//    and that apartment sits on "00 begane grond"). Always resolve the floor structurally.
//  • World position = the IfcLocalPlacement chain (summed Location points up to the root).
// ─────────────────────────────────────────────────────────────────────────────

/** A 2D point in the slice's output frame (METRES, origin at the building's min-corner, y as authored). */
export interface Pt2 {
  x: number;
  y: number;
}

/** One building storey (floor). Elevation in metres (0 = ground). */
export interface IfcStorey {
  expressID: number;
  name: string; // the IFC label, e.g. "01 eerste verdieping"
  elevationM: number; // metres (0 = ground); from IfcBuildingStorey.Elevation
}

/** One IfcSpace — a ROOM in this dataset (bathroom/bedroom/entrance), NOT necessarily a whole apartment.
 *  The mapping layer decides how to group rooms into sellable units; the extractor stays faithful. */
export interface IfcSpaceRec {
  expressID: number;
  name: string; // IfcSpace.Name — often an apartment/room number ("3.08", "A0.01")
  longName: string; // IfcSpace.LongName — the room function ("badkamer", "slaapkamer 2", "")
  storeyExpressID: number | null; // the containing storey (via IfcRelAggregates), or null if unresolved
  /** Footprint polygon in building-METRE coords (world placement applied). Closed ring, last≠first. */
  polygon: Pt2[];
  areaSqm: number; // shoelace area of the polygon, m²
}

/** A door or window — an opening on a plan. Position is the world-placement point in building metres.
 *  (We keep these flat markers for a later PlanMarker slice; the extractor does not size the leaf.) */
export interface IfcOpening {
  expressID: number;
  kind: "door" | "window";
  name: string;
  at: Pt2; // world placement, building metres
  storeyExpressID: number | null;
}

/** The thin slice — everything MM needs from an IFC, nothing it doesn't. */
export interface IfcSlice {
  schema: string; // "IFC2X3" etc.
  lengthUnitToMetre: number; // scale from the file's length unit to metres (0.001 for mm)
  storeys: IfcStorey[]; // sorted by elevation ascending
  spaces: IfcSpaceRec[];
  openings: IfcOpening[];
  warnings: string[]; // non-fatal issues (a space with no footprint, an unresolved storey, …)
}

// ── The IFC type codes we touch (IFC2X3 defaults; a caller may override for another schema). ──
export interface IfcTypeCodes {
  IFCPROJECT: number;
  IFCBUILDINGSTOREY: number;
  IFCSPACE: number;
  IFCDOOR: number;
  IFCWINDOW: number;
  IFCRELAGGREGATES: number;
}

/** IFC2X3 type codes (from web-ifc's ifc-schema). Stable across the 2x3/4 codes we use here. */
export const IFC2X3_CODES: IfcTypeCodes = {
  IFCPROJECT: 103090709,
  IFCBUILDINGSTOREY: 3124254112,
  IFCSPACE: 3856911033,
  IFCDOOR: 395920057,
  IFCWINDOW: 3304561284,
  IFCRELAGGREGATES: 160246688,
};

/** The minimal subset of web-ifc's IfcAPI (bound to one open model) that the extractor uses.
 *  Mocked wholesale in tests; in the browser, wrap a real `IfcAPI` + modelID (see `readerFromIfcApi`). */
export interface IfcReader {
  /** All express IDs of a given type code. */
  idsOfType(typeCode: number): number[];
  /** The decoded line for an express ID — a plain object of its attributes (web-ifc GetLine shape). */
  line(expressID: number): IfcLine | null;
  /** Human type name for a code (web-ifc GetNameFromTypeCode), used for the schema label + warnings. */
  schema(): string;
}

/** web-ifc's GetLine returns attributes where references are `{ value: expressID }` and primitives are
 *  `{ value: x }`. We model just what we read; everything is optional + defensively accessed. */
export interface IfcLine {
  expressID: number;
  type: number;
  Name?: { value: string } | null;
  LongName?: { value: string } | null;
  Elevation?: { value: number } | null;
  Representation?: { value: number } | null;
  ObjectPlacement?: { value: number } | null;
  Representations?: Array<{ value: number }> | null;
  RepresentationIdentifier?: { value: string } | null;
  Items?: Array<{ value: number }> | null;
  Elements?: Array<{ value: number }> | null;
  Points?: Array<{ value: number }> | null;
  Coordinates?: Array<{ value: number }> | null;
  RelatingObject?: { value: number } | null;
  RelatedObjects?: Array<{ value: number }> | null;
  RelativePlacement?: { value: number } | null;
  Location?: { value: number } | null;
  PlacementRelTo?: { value: number } | null;
  SweptArea?: { value: number } | null; // IfcExtrudedAreaSolid → the 2D profile swept to a solid
  OuterCurve?: { value: number } | null; // IfcArbitraryClosedProfileDef → the boundary polyline
  Position?: { value: number } | null; // IfcExtrudedAreaSolid.Position (IfcAxis2Placement3D) — solid-local offset
  UnitsInContext?: { value: number } | null;
  Units?: Array<{ value: number }> | null;
  UnitType?: { value: string } | null;
  Prefix?: { value: string } | null;
  // SI unit prefix multipliers we recognise (others → warning + treated as metres).
}

// ── small geometry helpers (pure) ──

/** Shoelace area of a ring (absolute), in the ring's own units². */
export function polyAreaAbs(pts: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

/** Drop a trailing point equal to the first (IFC polylines are often explicitly closed). */
function dropClosingDup(pts: Pt2[]): Pt2[] {
  if (pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) return pts.slice(0, -1);
  }
  return pts;
}

// SI length prefix → metre scale. We only need the ones that appear on LENGTHUNIT.
const PREFIX_SCALE: Record<string, number> = {
  MILLI: 0.001,
  CENTI: 0.01,
  DECI: 0.1,
  METRE: 1,
  "": 1,
};

/** Read the project length-unit → metre scale (0.001 for mm). Defaults to 1 (metre) with a warning. */
function lengthUnitToMetre(reader: IfcReader, codes: IfcTypeCodes, warnings: string[]): number {
  const projIds = reader.idsOfType(codes.IFCPROJECT);
  if (projIds.length === 0) {
    warnings.push("no IfcProject → assuming metres");
    return 1;
  }
  const proj = reader.line(projIds[0]);
  const uaRef = proj?.UnitsInContext?.value;
  if (uaRef == null) {
    warnings.push("IfcProject has no UnitsInContext → assuming metres");
    return 1;
  }
  const ua = reader.line(uaRef);
  for (const uRef of ua?.Units ?? []) {
    const u = reader.line(uRef.value);
    if (u?.UnitType?.value === "LENGTHUNIT") {
      const prefix = u.Prefix?.value ?? "";
      const scale = PREFIX_SCALE[prefix];
      if (scale == null) {
        warnings.push(`unknown length prefix "${prefix}" → assuming metres`);
        return 1;
      }
      return scale;
    }
  }
  warnings.push("no LENGTHUNIT in UnitAssignment → assuming metres");
  return 1;
}

/** Sum the IfcLocalPlacement chain to a world offset (in the file's native units, pre-scale). */
function worldOffset(reader: IfcReader, placementRef: number | null | undefined): Pt2 {
  let x = 0;
  let y = 0;
  let ref: number | null | undefined = placementRef;
  let guard = 0;
  while (ref != null && guard++ < 64) {
    const plc = reader.line(ref);
    if (!plc) break;
    const axRef = plc.RelativePlacement?.value;
    if (axRef != null) {
      const ax = reader.line(axRef);
      const locRef = ax?.Location?.value;
      if (locRef != null) {
        const loc = reader.line(locRef);
        const c = loc?.Coordinates;
        if (c && c.length >= 2) {
          x += c[0].value ?? 0;
          y += c[1].value ?? 0;
        }
      }
    }
    ref = plc.PlacementRelTo?.value ?? null;
  }
  return { x, y };
}

/** Pull the "FootPrint" polyline (IfcGeometricCurveSet → IfcPolyline) from a space's representation,
 *  in the file's native units (pre-scale, pre-placement). Returns null if none found. */
function footprintPolyline(reader: IfcReader, repRef: number | null | undefined): Pt2[] | null {
  if (repRef == null) return null;
  const prod = reader.line(repRef);
  for (const rRef of prod?.Representations ?? []) {
    const rep = reader.line(rRef.value);
    if (rep?.RepresentationIdentifier?.value !== "FootPrint") continue;
    for (const itRef of rep.Items ?? []) {
      const it = reader.line(itRef.value);
      // IfcGeometricCurveSet.Elements → curves; take the first IfcPolyline (has .Points).
      for (const elRef of it?.Elements ?? []) {
        const el = reader.line(elRef.value);
        if (el?.Points && el.Points.length >= 3) {
          const pts: Pt2[] = [];
          for (const pRef of el.Points) {
            const p = reader.line(pRef.value);
            const c = p?.Coordinates;
            if (c && c.length >= 2) pts.push({ x: c[0].value ?? 0, y: c[1].value ?? 0 });
          }
          if (pts.length >= 3) return pts;
        }
      }
    }
  }
  return null;
}

/** Fallback: pull the outline from a "Body" IfcExtrudedAreaSolid whose SweptArea is an
 *  IfcArbitraryClosedProfileDef (OuterCurve = IfcPolyline). Some spaces (circulation/technical in this
 *  dataset) are authored as solids, not flat FootPrints. Returns native-unit points incl. the solid's
 *  own Position offset, or null. (Rectangle/other profile defs are not handled — rare for spaces.) */
function bodyProfilePolyline(reader: IfcReader, repRef: number | null | undefined): Pt2[] | null {
  if (repRef == null) return null;
  const prod = reader.line(repRef);
  for (const rRef of prod?.Representations ?? []) {
    const rep = reader.line(rRef.value);
    if (rep?.RepresentationIdentifier?.value !== "Body") continue;
    for (const itRef of rep.Items ?? []) {
      const solid = reader.line(itRef.value);
      const profRef = solid?.SweptArea?.value;
      if (profRef == null) continue;
      const prof = reader.line(profRef);
      const curveRef = prof?.OuterCurve?.value;
      if (curveRef == null) continue;
      const curve = reader.line(curveRef);
      if (!curve?.Points || curve.Points.length < 3) continue;
      // the solid's own Position offset (IfcAxis2Placement3D.Location) — usually (0,0,0), applied anyway.
      let ox = 0;
      let oy = 0;
      const posRef = solid?.Position?.value;
      if (posRef != null) {
        const pos = reader.line(posRef);
        const locRef = pos?.Location?.value;
        if (locRef != null) {
          const loc = reader.line(locRef);
          const c = loc?.Coordinates;
          if (c && c.length >= 2) {
            ox = c[0].value ?? 0;
            oy = c[1].value ?? 0;
          }
        }
      }
      const pts: Pt2[] = [];
      for (const pRef of curve.Points) {
        const p = reader.line(pRef.value);
        const c = p?.Coordinates;
        if (c && c.length >= 2) pts.push({ x: (c[0].value ?? 0) + ox, y: (c[1].value ?? 0) + oy });
      }
      if (pts.length >= 3) return pts;
    }
  }
  return null;
}

/**
 * Extract the thin slice from an open IFC model.
 *
 * Output coordinates are METRES in a single building frame (each space's footprint has its world
 * placement applied, so all rooms on a floor share one coordinate system). Polygons keep their native
 * winding; areas are shoelace-absolute. Storeys are sorted by elevation.
 *
 * PURE given the reader (no I/O, no store). The reader is the only seam to web-ifc / the file.
 */
export function extractIfcSlice(reader: IfcReader, codes: IfcTypeCodes = IFC2X3_CODES): IfcSlice {
  const warnings: string[] = [];
  const schema = reader.schema();
  const scale = lengthUnitToMetre(reader, codes, warnings);

  // ── storeys ──
  const storeys: IfcStorey[] = reader
    .idsOfType(codes.IFCBUILDINGSTOREY)
    .map((id) => {
      const l = reader.line(id);
      return {
        expressID: id,
        name: l?.Name?.value ?? `storey#${id}`,
        elevationM: (l?.Elevation?.value ?? 0) * scale,
      };
    })
    .sort((a, b) => a.elevationM - b.elevationM);
  const storeyIds = new Set(storeys.map((s) => s.expressID));

  // ── space → storey via IfcRelAggregates (storey aggregates its spaces) ──
  const spaceToStorey = new Map<number, number>();
  for (const relId of reader.idsOfType(codes.IFCRELAGGREGATES)) {
    const rel = reader.line(relId);
    const parent = rel?.RelatingObject?.value;
    if (parent == null || !storeyIds.has(parent)) continue;
    for (const ch of rel?.RelatedObjects ?? []) spaceToStorey.set(ch.value, parent);
  }

  // ── spaces ──
  const spaces: IfcSpaceRec[] = [];
  for (const id of reader.idsOfType(codes.IFCSPACE)) {
    const l = reader.line(id);
    if (!l) continue;
    const native =
      footprintPolyline(reader, l.Representation?.value) ??
      bodyProfilePolyline(reader, l.Representation?.value);
    const name = l.Name?.value ?? "";
    if (!native) {
      warnings.push(`space "${name}" (#${id}) has no FootPrint/Body polyline → skipped`);
      continue;
    }
    const off = worldOffset(reader, l.ObjectPlacement?.value);
    const polygon = dropClosingDup(
      native.map((p) => ({ x: (p.x + off.x) * scale, y: (p.y + off.y) * scale })),
    );
    const storeyExpressID = spaceToStorey.get(id) ?? null;
    if (storeyExpressID == null) warnings.push(`space "${name}" (#${id}) has no containing storey`);
    spaces.push({
      expressID: id,
      name,
      longName: l.LongName?.value ?? "",
      storeyExpressID,
      polygon,
      areaSqm: polyAreaAbs(polygon),
    });
  }

  // ── openings (doors + windows) — flat markers, world-placement point ──
  const openings: IfcOpening[] = [];
  for (const [typeCode, kind] of [
    [codes.IFCDOOR, "door"],
    [codes.IFCWINDOW, "window"],
  ] as const) {
    for (const id of reader.idsOfType(typeCode)) {
      const l = reader.line(id);
      if (!l) continue;
      const off = worldOffset(reader, l.ObjectPlacement?.value);
      openings.push({
        expressID: id,
        kind,
        name: l.Name?.value ?? "",
        at: { x: off.x * scale, y: off.y * scale },
        storeyExpressID: null, // containment for openings = IfcRelContainedInSpatialStructure; a later slice
      });
    }
  }

  return { schema, lengthUnitToMetre: scale, storeys, spaces, openings, warnings };
}

/**
 * Wrap a live web-ifc `IfcAPI` + open modelID into the `IfcReader` seam. Kept here (not in the pure
 * core's test path) so the browser/Node caller has a one-liner. `api` is typed `any` to avoid pulling
 * web-ifc's types into the pure module — the only coupling point to the WASM lib.
 */
export function readerFromIfcApi(api: any, modelID: number): IfcReader {
  return {
    idsOfType(typeCode: number): number[] {
      const vec = api.GetLineIDsWithType(modelID, typeCode);
      const out: number[] = [];
      for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
      return out;
    },
    line(expressID: number): IfcLine | null {
      try {
        return api.GetLine(modelID, expressID) as IfcLine;
      } catch {
        return null;
      }
    },
    schema(): string {
      try {
        return api.GetModelSchema ? api.GetModelSchema(modelID) : "IFC";
      } catch {
        return "IFC";
      }
    },
  };
}
