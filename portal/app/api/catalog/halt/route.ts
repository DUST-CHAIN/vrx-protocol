// /api/catalog/halt — the developer BUILDING-HALT lever (Part A, the design docs).
//
//   GET  ?building=<id>                → { halt, history }
//         halt    = the ONE live (pending|active) halt for the building, or null (salt-stripped).
//         history = every halt record for the building, newest first (salt-stripped, for the developer audit).
//   POST { action: "halt", building, tier: "regular"|"urgent", note }
//         → { halt }  — asserts a halt. REGULAR → status `pending` (hides on VRX ack); URGENT → `active` now.
//                       The NOTE is MANDATORY (the mandatory-remark rule) — 400 if empty.
//   POST { action: "lift", building, id? }
//         → { halt }  — the developer releases the halt (pending|active → lifted). `id` optional (defaults to
//                       the building's live halt).
//
// ── AUTH: F1 requireCaller (identity) + developer OWNERSHIP check (authorisation) ───────────────────────────
// A halt is a DEVELOPER action on their OWN building. requireCaller (F1) resolves the PROVEN caller (session
// in strict mode; the legacy ?account= param as fallback today — same posture the relationship-channel route
// adopted). F1 proves WHO, not WHAT they own — so we ALSO verify the caller OWNS the building (its
// developer-registry buildingIds include it). A developer who is merely GATED to a building (an agency) can
// NOT halt it — only the owner. Fail-closed: no caller → 401; not the owner → 403; unknown building → 404.
//
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY; nothing on-chain. The halt + its note is a B2B fact shared with VRX + signed-up partners; the
// response strips the per-record salt. The activity notice carries only the building + that it was
// halted — never the note text in the feed CONTEXT (the note surfaces on the dedicated halt/notice surfaces,
// A2/B, verbatim). The gate read (lib/buyer-catalog) already drops an ACTIVE-halt building from buyer
// discovery; a `pending` (regular, unacked) halt does NOT hide yet.

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import { getDeveloper } from "@/lib/developers";
import { requireCaller } from "@/lib/caller";
import {
  assertHalt,
  liftHalt,
  haltsForBuilding,
  liveHaltForBuilding,
  publicHalt,
  type HaltTier,
} from "@/lib/building-halt";
import { resolveNoticeParties } from "@/lib/catalog-edit-gate";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** True iff `caller` is the DEVELOPER that owns `buildingId` (its registry buildingIds include it). The halt
 *  authorisation: only the building's owner may halt/lift it (F1 proves identity; this proves ownership). */
async function ownsBuilding(caller: string, buildingId: string): Promise<boolean> {
  const dev = await getDeveloper(caller).catch(() => null);
  if (!dev) return false;
  const bid = buildingId.trim().toLowerCase();
  return dev.buildingIds.some((id) => id.trim().toLowerCase() === bid);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const building = (searchParams.get("building") ?? "").trim();
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });

  // Identity + ownership: a building's halt history is a developer/VRX B2B fact — only the owner reads it here.
  const caller = requireCaller(req, { param: searchParams.get("account") });
  if (!caller.ok) return NextResponse.json({ error: caller.reason }, { status: caller.status });
  if (!(await ownsBuilding(caller.account, building))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [live, history] = await Promise.all([liveHaltForBuilding(building), haltsForBuilding(building)]);
  return NextResponse.json({
    halt: live ? publicHalt(live) : null,
    history: history.map(publicHalt),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });

  // Identity (F1) — the proven caller, with the legacy param as the fallback identity source today.
  const caller = requireCaller(req, { param: typeof body.by === "string" ? body.by : body.account });
  if (!caller.ok) return NextResponse.json({ error: caller.reason }, { status: caller.status });

  // The building must exist AND be owned by the caller (F1 proves who; this proves what they may halt).
  const b = await getBuilding(building);
  if (!b) return NextResponse.json({ error: "building not found" }, { status: 404 });
  if (!(await ownsBuilding(caller.account, building))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (action === "halt") {
    const tier = body.tier === "urgent" || body.tier === "regular" ? (body.tier as HaltTier) : null;
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!tier) return NextResponse.json({ error: "tier must be regular|urgent" }, { status: 400 });
    if (!note) return NextResponse.json({ error: "a note is required" }, { status: 400 });

    // Guard a duplicate: a building already has a live (pending|active) halt — don't stack a second (the store
    // keeps every record, but two live halts on one building is a UI/operator ambiguity). Lift the first.
    const existing = await liveHaltForBuilding(building);
    if (existing) {
      return NextResponse.json(
        { error: "this building already has a live halt — lift it first", halt: publicHalt(existing) },
        { status: 409 }
      );
    }

    const halt = await assertHalt({ building, developer: caller.account, tier, note });

    // Availability change notice (family) — building-level; parties = the developer + subscribed agencies
    // (resolveNoticeParties). Carries only the building + that it was halted; the NOTE is NOT in the feed context
    // (it surfaces verbatim on the dedicated halt/notice surfaces A2/B). A2's escalated notice to
    // existing-deal parties is a SEPARATE fan-out (built next) — this is the baseline feed line.
    await logActivity(
      "inventory.halted",
      caller.account.toLowerCase(),
      { kind: "unit", id: building },
      await resolveNoticeParties(caller.account, building),
      { building: b.name, direction: "halted", tier }
    );

    return NextResponse.json({ halt: publicHalt(halt) });
  }

  if (action === "lift") {
    // Lift by explicit id, or default to the building's live halt.
    const id =
      typeof body.id === "string" && body.id.trim()
        ? body.id.trim()
        : (await liveHaltForBuilding(building))?.id;
    if (!id) return NextResponse.json({ error: "no live halt to lift" }, { status: 404 });

    const lifted = await liftHalt(id, caller.account);
    if (!lifted) return NextResponse.json({ error: "not found or already lifted" }, { status: 404 });

    await logActivity(
      "inventory.resumed",
      caller.account.toLowerCase(),
      { kind: "unit", id: building },
      await resolveNoticeParties(caller.account, building),
      { building: b.name, direction: "resumed" }
    );

    return NextResponse.json({ halt: publicHalt(lifted) });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
