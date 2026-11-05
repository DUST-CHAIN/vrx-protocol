// GET /api/warroom?developer=<account>&days=<n>
//  → the developer WARROOM payload: the executive BI surface's data in one call.
//       • kpis      — units available / on-hold / sold, pending booking requests, live agreements
//       • frames    — the captured daily availability frames for the time SCRUBBER (oldest-first)
//       • newSince  — how many activity entries are new since this developer last opened the warroom
//       • lastVisit — the PREVIOUS last-visit (ms epoch) the digest is measured against (null = first visit)
//
// SIDE EFFECTS (deliberate, idempotent): on load we (1) opportunistically CAPTURE today's availability
// frame if it's missing (captureToday — reads our own status snapshot, never the chain), and
// (2) stamp the developer's last-visit to now (so the next visit's "what's new" measures from this one).
//
// AUTH (F1 seam, fail-closed): identity via requireCaller (verified session; param-fallback honours
// ?developer=). Everything returned — and the two WRITE side-effects below (visit stamp + frame capture) —
// is scoped to that identity. This route WRITES on the claimed account, so the forged-param hole here was a
// write hole, not just a read one: an empty/absent identity now refuses (401) rather than mutating a shell.
// The sole UI caller guards on `me`, so no live path changes. In the real product this endpoint runs on the
// developer's OWN node over their own stores. (migrated off trust-the-param; §5.)

import { NextResponse } from "next/server";
import { requireCaller } from "@/lib/caller";
import { getCatalog } from "@/lib/catalog";
import { getDeveloper } from "@/lib/developers";
import { loadSnapshot } from "@/lib/status-store";
import { buildingStats } from "@/lib/building-stats";
import { getPendingClaimsServer } from "@/lib/vrx-server";
import { agreementsForParty } from "@/lib/agreements";
import { getActivityFeed } from "@/lib/activity-feed";
import { captureToday, framesFor, markVisited } from "@/lib/warroom-snapshots";
import type { Building } from "@/lib/catalog-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const caller = requireCaller(req, { param: url.searchParams.get("developer") });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });
  const developer = caller.account;

  const daysRaw = Number(url.searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 30;

  try {
    // Opportunistically capture today's frame (idempotent) + stamp the visit, returning the PREVIOUS visit
    // so "what's new since last visit" measures from before this load. Run alongside the reads we need.
    const [, prevVisit, catalog, snap, pending, myAgreements, me] = await Promise.all([
      captureToday(developer).catch(() => null),
      markVisited(developer),
      getCatalog(),
      loadSnapshot(),
      getPendingClaimsServer(developer).catch(() => [] as string[]),
      agreementsForParty(developer).catch(() => []),
      getDeveloper(developer).catch(() => null),
    ]);

    // Scope the KPI roll-up to THIS developer's OWN buildings — their warroom is their own inventory BI, not
    // a window onto the whole platform (privacy moat, vrx-read-privacy-model). The building↔developer link is
    // the developer registry's `buildingIds` (the same off-chain scope "My buildings"/the agent view use —
    // the chain has no building concept). Without this the roll-up summed the ENTIRE catalog, so a developer
    // could read competitors' live unit counts from their own warroom (walk finding F2). No registry
    // entry (or no listed buildings) = an empty slice, which is the honest "nothing to show" rather than "all".
    const ownIds = new Set(me?.buildingIds ?? []);
    const myBuildings = catalog.filter((b) => ownIds.has(b.id));

    // KPI availability roll-up across the developer's own buildings, from the availability we hold (no chain reads).
    let available = 0,
      onHold = 0,
      sold = 0,
      total = 0;
    for (const b of myBuildings) {
      const s = buildingStats(b as unknown as Building, snap[b.id]?.units ?? {});
      available += s.available;
      onHold += s.onHold;
      sold += s.sold;
      total += s.total;
    }

    const agreements = myAgreements.filter((g) => g.status === "agreed").length;

    // "What's new since last visit": count the activity entries newer than the PREVIOUS visit. A first-ever
    // visit (no prior mark) reports 0 — there's no "since" to compare against, not "everything is new".
    let newSince = 0;
    if (prevVisit != null) {
      const fresh = await getActivityFeed(developer, "developer", 500, prevVisit).catch(() => []);
      newSince = fresh.length;
    }

    const frames = await framesFor(developer, days);

    return NextResponse.json({
      kpis: { available, onHold, sold, pending: pending.length, agreements, total },
      frames,
      newSince,
      lastVisit: prevVisit,
    });
  } catch {
    return NextResponse.json({ error: "warroom_unavailable" }, { status: 503 });
  }
}
