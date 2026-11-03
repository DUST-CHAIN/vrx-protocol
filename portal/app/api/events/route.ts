// GET /api/events — SHARED read over the event MIRROR. The developer inbox AND the coming
// agency app read THIS, not a bespoke per-feature derivation. Query by shape:
//
//   ?node=<dev>                → the node's reconstructed bookings (ClaimView[]), newest-first. Includes
//                                HELD ones (status 1) that vanished from the on-chain pending queue
//                                (lib.rs:1191) — the indexer's first concrete win.
//   ?node=<dev>&held=1         → only the held bookings (status 1).
//   ?node=<dev>&units=1        → { unit_key → latest status } the node has stamped (TileStamped/HoldReleased).
//  ?node=<dev>&attestations=1 → the node's vetting attestations (AttestationView[]), newest-first.
//
//  ── Booking-token lifecycle (V7, #5): the on-chain-event twin of lib/booking-tokens ──
//   ?token=<id>                → one token's full provenance { view, events } (newest-first trail). 404 if
//                                the mirror holds no event naming it. ?token=<id>&custody=1 → just the view.
//   ?developer=<acct>          → every token whose capacity belongs to that developer (TokenView[]),
//                                newest-first; &live=1 → just { count } (the scarcity numerator, non-recycled).
//   ?committed=1               → every currently-committed token + its opaque unit key (what's firmly held).
//  ?building=<hash> → every node's attestation over ONE opaque building scope hash.
//
//   (none of the above)        → the cursor/meta + the raw feed (newest-first, capped) for debugging/agency.
//
// Reads are cheap (file-backed mirror, no RPC). Freshness is owned by /api/events/sync (the poller/cron);
// pass ?sync=1 to opportunistically trigger one incremental sync before reading (demo convenience).
//
// PRIVACY: the mirror holds only what's already public on-chain (opaque ids/keys/building hashes,
// account ids, status/version codes). The token + attestation views carry NO money/economics/seal_hash/
// terms/PII (the events structurally never emit them). Enrichment (offer plaintext, catalog names) stays
// in the party-private stores — this route returns the opaque truth; /api/claims joins it to names for
// the developer's own eyes.

import { NextResponse } from "next/server";
import {
  claimsForNode,
  heldClaimsForNode,
  unitStatusForNode,
  attestationsForNode,
  attestationsForBuilding,
  tokenHistory,
  custodyOf,
  tokensForDeveloperFromEvents,
  liveTokenCountFromEvents,
  committedTokensFromEvents,
  allEvents,
  getCursor,
} from "@/lib/events";
import { syncEvents } from "@/lib/event-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const node = p.get("node")?.trim();
  const token = p.get("token")?.trim();
  const developer = p.get("developer")?.trim();
  const building = p.get("building")?.trim();

  if (p.get("sync") === "1") {
    await syncEvents().catch(() => {}); // best-effort; never block the read on a sync failure
  }

  try {
    // ── Booking-token provenance (one token) ──────────────────────────────────────────────────────
    if (token) {
      if (p.get("custody") === "1") {
        const view = await custodyOf(token);
        if (!view) return NextResponse.json({ error: "token_not_found" }, { status: 404 });
        return NextResponse.json({ token, view });
      }
      const hist = await tokenHistory(token);
      if (!hist) return NextResponse.json({ error: "token_not_found" }, { status: 404 });
      return NextResponse.json({ token, ...hist });
    }

    // ── A developer's token capacity (from events — the scarcity/custody twin of the store) ─────────
    if (developer) {
      if (p.get("live") === "1") {
        return NextResponse.json({ developer, count: await liveTokenCountFromEvents(developer) });
      }
      return NextResponse.json({ developer, tokens: await tokensForDeveloperFromEvents(developer) });
    }

    // ── Everything committed right now (the firm-hold scarcity view) ───────────────────────────────
    if (p.get("committed") === "1") {
      return NextResponse.json({ tokens: await committedTokensFromEvents() });
    }

    // ── Attestations over one opaque building scope hash ───────────────────────────────────────────
    if (building) {
      return NextResponse.json({ building, attestations: await attestationsForBuilding(building) });
    }

    // ── Per-node views (bookings · held · stamped units · attestations) ────────────────────────────
    if (node) {
      if (p.get("attestations") === "1") {
        return NextResponse.json({ node, attestations: await attestationsForNode(node) });
      }
      if (p.get("units") === "1") {
        return NextResponse.json({ node, units: await unitStatusForNode(node) });
      }
      if (p.get("held") === "1") {
        return NextResponse.json({ node, claims: await heldClaimsForNode(node) });
      }
      return NextResponse.json({ node, claims: await claimsForNode(node) });
    }
    // No selector → meta + a capped raw feed (agency app derives its own; debugging).
    const [meta, events] = await Promise.all([getCursor(), allEvents()]);
    return NextResponse.json({ ...meta, events: events.slice(0, 200) });
  } catch {
    return NextResponse.json({ error: "mirror_error" }, { status: 500 });
  }
}
