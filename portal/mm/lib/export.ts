// Pack export — assemble a Pack into the ingest-pack ZIP layout (../ingest-pack/README.md §"Pack layout").
//
// LAW #2 (always exportable -> always valid): export runs at ANY stage. Missing values are BACKFILLED
// from schema defaults so the emitted pack always parses. buildPackFiles is PURE (Pack -> {path:text})
// so it's unit-testable with no zip/browser; toZip is the thin jszip wrapper for the browser download.
//
// Follows pack.schema.json (the authoritative manifest shape — the README's separate complex.json drifted;
// the schema embeds complexes in pack.json tree.complexes[], so we emit per the SCHEMA). See the note in
// docs/.md on that README-vs-schema drift.

import type { Pack } from "./pack";
import { serializeUnitsCsv } from "./units-csv";
import { matrixableBuildingNodes, serializeMatrixCsv } from "./matrix";
import { itemForSlot, mediaPath, PLACEHOLDER_MIME, placeholderSvg, requiredSlots } from "./media";

export interface PackFiles {
  [path: string]: string; // relative path within the ZIP -> file text
}

/** Binary ZIP entries (images). Kept separate from PackFiles so the pure text path + its tests are untouched. */
export interface PackBinaries {
  [path: string]: Uint8Array; // relative path within the ZIP -> raw bytes
}

/** SHA-256 hex of bytes (Web Crypto; browser + Node 18+ test runner). */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // copy into a plain ArrayBuffer-backed view (TS 5.7 wants ArrayBufferView<ArrayBuffer>, not a SharedArrayBuffer)
  const view = new Uint8Array(bytes.length);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hex of a string (Web Crypto; available in the browser + Node 18+ test runner). */
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

/** base64 -> bytes (export reads the stored MediaItem.dataB64). Works in the browser + Node test runner. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build the per-building building.json (schema-shaped; omit undefined so the JSON stays clean). */
function buildingJson(pack: Pack, buildingId: string): string {
  const b = pack.buildings.find((x) => x.id === buildingId);
  if (!b) return "{}";
  // BACKFILL required fields that the schema insists on (law #2).
  const out: Record<string, unknown> = {
    id: b.id,
    name: b.name || b.id, // backfill display name from id
    complexId: b.complexId,
    companyId: b.companyId,
    tagline: b.tagline,
    developer: b.developer || pack.developer.name,
    area: b.area,
    address: b.address,
    type: b.type || "High Rise", // schema requires; sensible default
    stories: b.stories && b.stories >= 1 ? b.stories : 1, // schema minimum 1
    units: b.units ?? (pack.buildingUnits[b.id]?.length || 0),
    completion: b.completion,
    constructionEnd: b.constructionEnd,
    reservationFeeUsd: b.reservationFeeUsd,
    bookingDepositUsd: b.bookingDepositUsd,
    maintenancePerSqmUsd: b.maintenancePerSqmUsd,
    sinkingFundPerSqmUsd: b.sinkingFundPerSqmUsd,
    transferFeePct: b.transferFeePct,
    amenities: b.amenities,
    unitTypes: b.unitTypes,
    termsRef: b.termsRef,
    quota: b.quota,
  };
  // strip undefined
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return JSON.stringify(out, null, 2);
}

/**
 * Assemble all MEDIA bytes (PURE). For EVERY required slot (lib/media.requiredSlots) emit either the stored
 * upload/generated image OR a static placeholder — so the export is ALWAYS complete (law #2 for images,
 *). Returns {zipPath -> bytes}. Shared by buildPackFiles (for checksums) + toZip (for the blobs).
 */
export function buildPackMedia(pack: Pack): PackBinaries {
  const bins: PackBinaries = {};
  for (const slot of requiredSlots(pack)) {
    const item = itemForSlot(pack, slot.buildingId, slot.key);
    if (item) {
      bins[mediaPath(slot.buildingId, slot.key, item.mime)] = b64ToBytes(item.dataB64);
    } else {
      // backfill: a static tinted placeholder in the exact required aspect ratio (SVG bytes, deterministic)
      const svg = placeholderSvg(slot);
      bins[mediaPath(slot.buildingId, slot.key, PLACEHOLDER_MIME)] = new TextEncoder().encode(svg);
    }
  }
  return bins;
}

/**
 * Assemble all pack files (PURE). Produces building.json + units.csv + matrix.csv per building, terms/<id>.json,
 * and a pack.json manifest WITH checksums (text files AND media). Async only because checksums use Web Crypto.
 */
export async function buildPackFiles(pack: Pack, generatedBy = "vrx-mm 0.1.0"): Promise<PackFiles> {
  const files: PackFiles = {};

  // per-building building.json + units.csv
  for (const b of pack.buildings) {
    files[`buildings/${b.id}/building.json`] = buildingJson(pack, b.id);
    files[`buildings/${b.id}/units.csv`] = serializeUnitsCsv(pack.buildingUnits[b.id] || []);
  }

  // per-building matrix.csv — the §4a stacking-plan PROJECTION of the §4d geo tree (lib/matrix.ts). Emitted
  // keyed by the building GEO-NODE id (a self-standing projection; the Structured↔Studio link is a separate,
  // deferred integration slice). Only buildings whose geo subtree actually has floors+units get a matrix.csv.
  for (const node of matrixableBuildingNodes(pack)) {
    const csv = serializeMatrixCsv(pack, node.id);
    if (csv) files[`buildings/${node.id}/matrix.csv`] = csv;
  }

  // terms/<id>.json
  for (const t of pack.terms) {
    files[`terms/${t.id}.json`] = JSON.stringify(t.data, null, 2);
  }

  // checksums over every file emitted so far (relative path -> sha256 hex)
  const checksums: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    checksums[path] = await sha256Hex(text);
  }
  // + media checksums (over the actual bytes — upload/generated blobs AND placeholder backfills)
  const media = buildPackMedia(pack);
  for (const [path, bytes] of Object.entries(media)) {
    checksums[path] = await sha256HexBytes(bytes);
  }

  // pack.json manifest (schema-shaped; tree.complexes[] embedded here)
  const manifest: Record<string, unknown> = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    generatedBy,
    developer: {
      id: pack.developer.id,
      name: pack.developer.name || pack.developer.id,
      holdingCompany: pack.developer.holdingCompany,
      nearAccount: pack.developer.nearAccount,
      logo: pack.developer.logo,
    },
    companies: pack.companies.length ? pack.companies : undefined,
    tree: {
      complexes: pack.complexes.map((cx) => ({
        id: cx.id,
        name: cx.name || cx.id,
        companyId: cx.companyId,
        area: cx.area,
        amenities: cx.amenities,
        buildings: cx.buildings,
      })),
    },
    checksums,
  };
  // strip undefined in developer + top level
  const dev = manifest.developer as Record<string, unknown>;
  for (const k of Object.keys(dev)) if (dev[k] === undefined) delete dev[k];
  for (const k of Object.keys(manifest)) if (manifest[k] === undefined) delete manifest[k];

  files["pack.json"] = JSON.stringify(manifest, null, 2);
  return files;
}

/**
 * Build a ZIP Blob from the assembled files (browser). jszip is a dependency; imported lazily so the
 * pure buildPackFiles path (and its test) never needs it.
 */
export async function toZip(pack: Pack, generatedBy?: string): Promise<Blob> {
  const files = await buildPackFiles(pack, generatedBy);
  const media = buildPackMedia(pack); // upload/generated blobs + placeholder backfills (always complete)
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  for (const [path, bytes] of Object.entries(media)) zip.file(path, bytes);
  return zip.generateAsync({ type: "blob" });
}
