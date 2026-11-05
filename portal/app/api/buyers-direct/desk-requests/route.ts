// GET /api/buyers-direct/desk-requests?account=<buyer>
//   → { requests: Array<{ conversationId, building, buildingName, developerName, fields, at }> }
//
// F3: the BUYER-WIDE watcher feed for pending desk REVEAL requests. The desk's "please add/share X"
// ask (conversations-direct/reveal action:"request") lands as a pending `reveal.request` on the
// conversation AND as a desk message in the thread — but the buyer's per-building chat notifier only runs when
// that building's chat is MOUNTED (view === "building"). A buyer browsing elsewhere got NO alert (the F3).
// This cheap read lets the buyer PAGE poll for pending requests across ALL their conversations regardless of
// view, so the notifier (sound + toast + field-specific deep-link) can fire wherever the buyer is.
//
// PRIVACY: names FIELD KEYS only, never values; scoped to the caller's own account (a buyer only ever sees
// requests addressed to them). Reads accounts + conversation state; signs nothing, no chain. The `at` ms-epoch
// lets the client dedupe (only chime on a request it hasn't alerted on yet) — same discipline as the chat
// lastDeskId guard, so a reload/poll doesn't replay a chime for an already-seen ask.

import { NextResponse } from "next/server";
import { directConversationsFor, getDirectReveal } from "@/lib/conversations-direct";
import { getDeveloper } from "@/lib/developers";
import { getBuilding } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  const convs = await directConversationsFor(account);
  // Only the buyer side cares about desk requests; directConversationsFor also returns a developer's own
  // conversations if they call it, so keep only rows where the caller is the BUYER (fail-closed scoping).
  const mine = convs.filter((c) => c.buyer.toLowerCase() === account.toLowerCase());

  // Cache per-building name + per-developer name lookups so repeated conversations don't re-read the registry.
  const bldNameCache = new Map<string, string>();
  const devNameCache = new Map<string, string>();
  const requests: Array<{
    conversationId: string;
    building: string;
    buildingName: string;
    developerName: string;
    fields: string[];
    at: number;
  }> = [];

  for (const c of mine) {
    const reveal = await getDirectReveal(c.id);
    const r = reveal?.request;
    // A pending request = a recorded request whose fields aren't all already granted. Once the buyer grants
    // (grantedFields covers the ask), it's no longer actionable → drop so the watcher doesn't nag.
    if (!r || !Array.isArray(r.fields) || r.fields.length === 0) continue;
    const granted = new Set(reveal?.grantedFields ?? []);
    const stillPending = r.fields.filter((f) => !granted.has(f));
    if (stillPending.length === 0) continue;

    if (!bldNameCache.has(c.building)) {
      const b = await getBuilding(c.building);
      bldNameCache.set(c.building, b?.name ?? c.building);
    }
    if (!devNameCache.has(c.developer)) {
      const d = await getDeveloper(c.developer);
      devNameCache.set(c.developer, d?.name ?? "the sales desk");
    }
    requests.push({
      conversationId: c.id,
      building: c.building,
      buildingName: bldNameCache.get(c.building)!,
      developerName: devNameCache.get(c.developer)!,
      fields: stillPending,
      at: r.at,
    });
  }

  requests.sort((a, b) => b.at - a.at); // newest ask first
  return NextResponse.json({ requests });
}
