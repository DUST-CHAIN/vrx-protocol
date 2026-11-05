// GET /api/catalog/held?building=<id>
//   → the DEVELOPER's own view of which units of their building are HELD pending VRX approval, plus the
//  still-`open` versions driving those holds (the UI half). This backs two things on the
//     developer console: colouring the held units distinctly on the stacking plan, and the approver's
//     Approve/Reject buttons (POST /api/catalog/version/decide) + the revert/resubmit note.
//
//   { held: string[],                      // held unit ids (verbatim catalog ids) — derived from open versions
//     versions: [ { version, at, by, approver, changeClass, status, units, count } ] }
//
// ── WHY THIS IS THE DEVELOPER'S VIEW, NOT A PARTY VIEW ─────────────────────────────────────────────────────
// The hold is DERIVED (lib/inventory-version.heldUnits) from `open` versions — no stored per-unit flag, so
// this read can't drift from the version truth. A booking AGENT never calls this: on the agent side the hold
// surfaces only through lib/bookable, whose message for a held unit is byte-identical to the neutral not_open
// wording (no leak of an in-flight review). This endpoint exposes only the held unit IDS + the
// version's class/status/count — NEVER the changeset's `from`/`to` prices (the developer already sees their own
// prices in the catalog; there is no reason to re-serve them here, and keeping them out means a mis-scoped
// caller still learns nothing about the pending figures).
//
// AUTH posture matches the rest of the off-chain demo layer (the developer rides in the caller; the real
// signed-request binding is the deferred signing arc, F1). This is a read of the developer's OWN building.

import { NextResponse } from "next/server";
import { getBuilding } from "@/lib/catalog";
import { heldUnits, versionsForBuilding } from "@/lib/inventory-version";
import { callerAccount, resolveCatalogScope, scopeAllows } from "@/lib/catalog-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const building = searchParams.get("building")?.trim();
  if (!building) return NextResponse.json({ held: [], versions: [] });

  // Validate the building exists (never answer for an unknown id); absent → empty, not an error.
  const b = await getBuilding(building);
  if (!b) return NextResponse.json({ held: [], versions: [] });

  // Security Pass #3: this is the DEVELOPER's own held-view — a non-entitled caller must not read
  // another developer's pending holds. Refuse with an empty payload (not 403: callers treat it as "none").
  const scope = await resolveCatalogScope(callerAccount(req));
  if (!scopeAllows(scope, building)) return NextResponse.json({ held: [], versions: [] });

  const [held, all] = await Promise.all([heldUnits(building), versionsForBuilding(building)]);

  // Only the still-`open` versions drive a hold. Surface each one's unit-ID keys (the held units it covers)
  // + its class/status — never the `from`/`to` figures inside the changeset (see header).
  const versions = all
    .filter((v) => v.status === "open")
    .map((v) => {
      const units = Object.keys(v.changeset ?? {}).filter((k) => k !== "add" && k !== "remove");
      return {
        version: v.version,
        at: v.at,
        by: v.by,
        approver: v.approver,
        changeClass: v.changeClass,
        status: v.status,
        units,
        count: units.length,
      };
    });

  return NextResponse.json({ held: [...held], versions });
}
