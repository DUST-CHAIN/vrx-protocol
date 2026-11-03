// /api/root/ingest — the VRX-ROOT developer-pack INGEST console (MM → catalog, step 3; design:
// the design docs + ingest-pack/README.md §"How VRX imports it"). OPERATOR-GATED,
// the same fail-closed posture as /api/root/overview + /api/root/booking-tokens.
//
// WHY ROOT OWNS THIS: an ingest pack is a PROPOSAL, not a live edit — onboarding is owner-gated. Root
// uploads a developer's pack ZIP, VRX parses it (the PURE lib/ingest-pack.ts reader) into catalog entities
// that SIT STAGED (lib/catalog-staging.ts), and root VETS + ACTIVATES each building selectively. Nothing
// reaches the live catalog (.data/catalog.json) until root clicks activate. Activation merges one building
// in via the pure stageIntoCatalog (supersede-by-id) — the SAME path the fixture tests freeze.
//
//   GET  → { packs, liveIds }
//          packs   = every staged pack (developer + complex tree + each building's vetting state + errors).
//          liveIds = the current live-catalog building ids (so the console can flag "activating will REPLACE
//                    skyline-tower" — the finding-1 remap target picture at a glance).
//   POST { op: "stage", zipB64 }                       → { pack }   — parse an uploaded ZIP into a staged pack.
//   POST { op: "remap", packId, buildingPackId, asId } → { pack }   — set a building's activation target id.
//   POST { op: "activate", packId, buildingPackId, asId? } → { result } — merge one building into the catalog.
//   POST { op: "discard", packId }                     → { ok }     — drop a staged pack (catalog untouched).
//
// PRIVACY: a pack carries PUBLIC developer/building context (names, specs, images) — no customer PII and
// no plaintext deal terms (the trace-over backdrop + metre drawing-board state are stripped at MM export).
// The staged store lives under portal/.data (gitignored), never on a public path.

import { NextResponse } from "next/server";
import { parsePackZip } from "@/lib/ingest-pack";
import {
  listStagedPacks,
  stagePack,
  setActivationTarget,
  activatePackBuilding,
  discardStagedPack,
} from "@/lib/catalog-staging";
import { getCatalog } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical to the sibling root consoles (fix #3). Activation touches the
// live catalog, so an unset secret must DENY. VRX_DEMO_OPEN=1 is the deliberate local escape.
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [packs, live] = await Promise.all([listStagedPacks(), getCatalog()]);
  return NextResponse.json({ packs, liveIds: live.map((b) => b.id) });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const op = typeof body.op === "string" ? body.op : "";

  try {
    if (op === "stage") {
      const zipB64 = typeof body.zipB64 === "string" ? body.zipB64 : "";
      if (!zipB64) return NextResponse.json({ error: "zipB64 required" }, { status: 400 });
      // decode base64 -> bytes -> the pure reader (unzip + parse). A hard-malformed pack throws (fatal);
      // per-row/per-building problems are COLLECTED into the result's errors (forgiving, law #2).
      const bytes = Buffer.from(zipB64, "base64");
      const res = await parsePackZip(bytes);
      const pack = await stagePack(res);
      return NextResponse.json({ pack });
    }

    if (op === "remap") {
      const packId = typeof body.packId === "string" ? body.packId : "";
      const buildingPackId = typeof body.buildingPackId === "string" ? body.buildingPackId : "";
      const asId = typeof body.asId === "string" ? body.asId : "";
      if (!packId || !buildingPackId) return NextResponse.json({ error: "packId + buildingPackId required" }, { status: 400 });
      const pack = await setActivationTarget(packId, buildingPackId, asId);
      if (!pack) return NextResponse.json({ error: "staged pack not found" }, { status: 404 });
      return NextResponse.json({ pack });
    }

    if (op === "activate") {
      const packId = typeof body.packId === "string" ? body.packId : "";
      const buildingPackId = typeof body.buildingPackId === "string" ? body.buildingPackId : "";
      const asId = typeof body.asId === "string" && body.asId.trim() ? body.asId : undefined;
      if (!packId || !buildingPackId) return NextResponse.json({ error: "packId + buildingPackId required" }, { status: 400 });
      const result = await activatePackBuilding(packId, buildingPackId, asId);
      if (!result) return NextResponse.json({ error: "staged pack/building not found" }, { status: 404 });
      return NextResponse.json({ result });
    }

    if (op === "discard") {
      const packId = typeof body.packId === "string" ? body.packId : "";
      if (!packId) return NextResponse.json({ error: "packId required" }, { status: 400 });
      const ok = await discardStagedPack(packId);
      return NextResponse.json({ ok });
    }

    return NextResponse.json({ error: "unknown op (stage | remap | activate | discard)" }, { status: 400 });
  } catch (e) {
    // parsePackZip throws on a structurally-fatal pack (no pack.json / bad JSON / no tree). That's a client
    // error on the uploaded artifact, not a server fault → 400 with the reader's own message.
    const msg = e instanceof Error ? e.message : "request failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
