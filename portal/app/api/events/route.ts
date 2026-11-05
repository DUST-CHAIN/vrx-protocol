// GET /api/events — SHARED read over the event MIRROR. The developer inbox AND the coming
// agency app read THIS, not a bespoke per-feature derivation. Query by shape:
//
//   ?node=<dev>                → the node's reconstructed bookings (ClaimView[]), newest-first. Includes
//                                HELD ones (status 1) that vanished from the on-chain pending queue
//                                (lib.rs:1191) — the indexer's first concrete win.
//   ?node=<dev>&held=1         → only the held bookings (status 1).
//   ?node=<dev>&units=1        → { unit_key → latest status } the node has stamped (TileStamped/HoldReleased).
//   (no node)                  → the cursor/meta + the raw feed (newest-first, capped) for debugging/agency.
//
// Reads are cheap (file-backed mirror, no RPC). Freshness is owned by /api/events/sync (the poller/cron);
// pass ?sync=1 to opportunistically trigger one incremental sync before reading (demo convenience).
//
// PRIVACY: the mirror holds only what's already public on-chain (opaque ids/keys, account ids,
// status codes). Enrichment (offer plaintext, catalog names) stays in the party-private stores — this
// route returns the opaque truth; /api/claims joins it to names for the developer's own eyes.

import { NextResponse } from "next/server";
import {
  claimsForNode,
  heldClaimsForNode,
  unitStatusForNode,
  allEvents,
  getCursor,
} from "@/lib/events";
import { syncEvents } from "@/lib/event-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const node = p.get("node")?.trim();

  if (p.get("sync") === "1") {
    await syncEvents().catch(() => {}); // best-effort; never block the read on a sync failure
  }

  try {
    if (node) {
      if (p.get("units") === "1") {
        return NextResponse.json({ node, units: await unitStatusForNode(node) });
      }
      if (p.get("held") === "1") {
        return NextResponse.json({ node, claims: await heldClaimsForNode(node) });
      }
      return NextResponse.json({ node, claims: await claimsForNode(node) });
    }
    // No node → meta + a capped raw feed (agency app derives its own; debugging).
    const [meta, events] = await Promise.all([getCursor(), allEvents()]);
    return NextResponse.json({ ...meta, events: events.slice(0, 200) });
  } catch {
    return NextResponse.json({ error: "mirror_error" }, { status: 500 });
  }
}
