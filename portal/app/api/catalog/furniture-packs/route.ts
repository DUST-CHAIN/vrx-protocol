// /api/catalog/furniture-packs — developer-GLOBAL, reusable furniture packs. A pack is authored
// ONCE by a developer and attached to one or many buildings via buildingIds ("if developer marked it so").
//
//   GET    ?developer=<account>              → { packs } this developer owns (label + items + buildingIds).
//   POST   { developer, id?, label, items, buildingIds? }  → create (no id) or update (id) a pack.
//   POST   { developer, op:"attach", id, building, attached }  → toggle a pack's attachment to a building.
//   DELETE ?developer=&id=                   → delete a pack.
//
// OFF-CHAIN, developer-scoped (lib/furniture-packs refuses cross-developer edits). AUTH posture matches the
// rest of the off-chain demo layer (the `developer` is self-named; the real signed-request binding is the
// deferred signing arc). Furniture COST is never stored — it's computed per-unit from the unit's m².

import { NextResponse } from "next/server";
import {
  listPacksForDeveloper,
  savePack,
  deletePack,
  setPackBuilding,
} from "@/lib/furniture-packs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const developer = new URL(req.url).searchParams.get("developer")?.trim() || "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
  return NextResponse.json({ packs: await listPacksForDeveloper(developer) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const developer = typeof body.developer === "string" ? body.developer.trim() : "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });

  try {
    if (body.op === "attach") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const building = typeof body.building === "string" ? body.building.trim() : "";
      if (!id || !building) return NextResponse.json({ error: "id + building required" }, { status: 400 });
      const pack = await setPackBuilding(developer, id, building, body.attached !== false);
      if (!pack) return NextResponse.json({ error: "not your pack" }, { status: 403 });
      return NextResponse.json({ ok: true, pack });
    }

    const pack = await savePack(developer, {
      id: typeof body.id === "string" ? body.id : undefined,
      label: typeof body.label === "string" ? body.label : "",
      items: body.items,
      buildingIds: body.buildingIds,
    });
    return NextResponse.json({ ok: true, pack });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const developer = url.searchParams.get("developer")?.trim() || "";
  const id = url.searchParams.get("id")?.trim() || "";
  if (!developer || !id) return NextResponse.json({ error: "developer + id required" }, { status: 400 });
  const ok = await deletePack(developer, id);
  return NextResponse.json({ ok });
}
