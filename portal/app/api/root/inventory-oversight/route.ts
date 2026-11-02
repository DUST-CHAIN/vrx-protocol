// /api/root/inventory-oversight — the VRX-ROOT persistent oversight screen for developer inventory changes
// The SECOND of the two change-notice views (the first is the ephemeral,
// per-agency feed that dismisses via read-markers). This one is NOT dismissible: VRX must be able to see,
// over time, what each developer is doing to their on-contract inventory — and, if uneasy, escalate.
// GET → { groups, policies }
// groups = the inventory.* change notices from the activity spine, GROUPED per developer / per day
// / per change type, newest group first. A persistent audit view — nothing is marked
// "seen" here (read-markers are the AGENT view's concern, not root's).
// policies = every developer's edit policy (allPolicies) so the operator sees each developer's trust
// matrix alongside their activity (who is light-touch vs tightly monitored).
// POST { action: "escalate", developer, buildingId?, reason? }
// → { assertion } — the ONE-CLICK ESCALATE. Writes the EXISTING dev-standing MisrepresentationTrigger
// via assertMisrepresentation (NO new enforcement machine) + logs
// standing.flagged. Identical to /api/root/misrepresentations' assert action —
// this is just the escalate button living next to the activity that prompted it.
// ── AUTH: the EXISTING /root operator-secret gate (fail-closed, verify-before-acting) ────────────────────
// Matched to the sibling /root routes (overview, misrepresentations): x-vrx-operator vs VRX_OPERATOR_SECRET,
// with the explicit local VRX_DEMO_OPEN=1 escape hatch. An unset secret DENIES (escalate is destructive to a
// developer's standing). The operator `assertedBy` is an AUDIT LABEL, never the authorization itself.
// PRIVACY: server-side only; nothing on-chain. The spine rows carry only building + count/direction — no
// unit price/terms specifics ever reached the spine (the emitting routes already stripped them). The raw
// operator escalate `reason` is a sensitive VRX-root-only fact, never surfaced to a party.

import { NextResponse } from "next/server";
import { spineEntries, logActivity, type ActivityEntry, type ActivityVerb } from "@/lib/activity";
import { allPolicies } from "@/lib/dev-edit-policy";
import { assertMisrepresentation } from "@/lib/misrepresentation-store";
import { getProfile } from "@/lib/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

const OPERATOR_LABEL = process.env.VRX_OPERATOR_LABEL?.trim() || "vrx-root";

// The inventory change-notice verbs — the only ones this oversight screen groups.
const INVENTORY_VERBS: ReadonlySet<ActivityVerb> = new Set<ActivityVerb>([
  "inventory.repriced",
  "inventory.off_market",
  "inventory.availability",
  "inventory.unit_added",
  "inventory.unit_removed",
  "inventory.unit_changed",
  "inventory.listing_updated",
]);

/** ms epoch → UTC day key (YYYY-MM-DD) for the per-day grouping. */
function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

type OversightGroup = {
  developer: string;
  day: string;
  verb: ActivityVerb;
  count: number;
  /** The newest entry's ms epoch in the group (sort key). */
  latestAt: number;
  /** The building names touched in this group (deduped) — the operator's at-a-glance "what/where". */
  buildings: string[];
  /** The raw entries (newest first) for drill-down. */
  entries: ActivityEntry[];
};

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [spine, policies] = await Promise.all([spineEntries(), allPolicies()]);
  const notices = spine.filter((e) => INVENTORY_VERBS.has(e.verb));

  // Group per developer (the actor) / per day / per change type (verb).
  const byKey = new Map<string, OversightGroup>();
  for (const e of notices) {
    const developer = e.actor || "unknown";
    const day = dayKey(e.at);
    const key = `${developer}|${day}|${e.verb}`;
    let g = byKey.get(key);
    if (!g) {
      g = { developer, day, verb: e.verb, count: 0, latestAt: 0, buildings: [], entries: [] };
      byKey.set(key, g);
    }
    g.count += 1;
    g.latestAt = Math.max(g.latestAt, e.at);
    const b = e.context?.building;
    if (typeof b === "string" && b && !g.buildings.includes(b)) g.buildings.push(b);
    g.entries.push(e);
  }

  const groups = [...byKey.values()].sort((a, b) => b.latestAt - a.latestAt);
  return NextResponse.json({ groups, policies });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action.trim() : "";

  if (action === "escalate") {
    const developer = typeof body.developer === "string" ? body.developer.trim() : "";
    if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });

    // One-click escalate = the EXISTING §3c misrepresentation assert: reuse, no new machine).
    const assertion = await assertMisrepresentation({
      developer,
      assertedBy: OPERATOR_LABEL,
      buildingId: typeof body.buildingId === "string" ? body.buildingId : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    // Standing row — developer + VRX-root only; NO raw reason. Best-effort.
    const p = await getProfile(developer).catch(() => null);
    await logActivity(
      "standing.flagged",
      OPERATOR_LABEL,
      { kind: "developer", id: developer },
      [developer, OPERATOR_LABEL],
      { subjectName: p?.legalName?.trim() || developer }
    );
    return NextResponse.json({ assertion: { id: assertion.id, developer: assertion.developer, at: assertion.at } });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
