// GET /api/chain-head
//   → the current NEAR block height VRX is reading, as the honest signal behind the "on-chain · live"
//  heartbeat. The LiveHeartbeat component polls this slowly and beats whenever the height
//     ADVANCES — so the pulse proves the chain is actually moving and VRX is actually reading it, rather than
//     being a blind timer. A height that stops advancing (or a read that fails) is a real "syncing / stalled"
//     signal the UI can show honestly.
//
// Cheapest possible read: a plain `provider.block({ finality: "optimistic" })` — NO contract call, no args,
// no decode — just the chain head. Rides the same keyless/pooled provider set as /api/view (rotates across
// the pool on failure), but deliberately does NOT arm the escalation machinery: a heartbeat must never burn a
// reserve key. If every provider in the pool fails, we return `live:false` (a 200 with a soft signal, not a
// 503) so the heartbeat shows "syncing" instead of erroring — liveness UI should degrade, not break.

import { NextResponse } from "next/server";
import { providers } from "near-api-js";
import { serverProvidersKeyless } from "@/lib/config";

export const dynamic = "force-dynamic"; // never cache a liveness answer

// the heartbeat is BACKGROUND liveness (every open browser polls it continuously, no human waiting
// on the number). Its own contract said "a heartbeat must never burn a reserve key" — but it used the
// KEYED pool + counted. Switch it to the FREE keyless providers + stop counting: a liveness ping must be
// free. On the free tier failing, we still degrade to live:false (never a reserve-key spend).
const PROVIDERS = serverProvidersKeyless(providers);

export async function GET() {
  // Try each pooled provider in turn; the first that answers wins. Short-circuit — one good read is all we need.
  for (let i = 0; i < PROVIDERS.length; i++) {
    const provider = PROVIDERS[i];
    try {
      const block = await provider.block({ finality: "optimistic" });
      const height = block.header.height;
      return NextResponse.json({ live: true, height, ts: Date.now() });
    } catch {
      /* try the next provider in the pool */
    }
  }
  // Whole pool failed (rate-limited keyless, RPC down, offline). Soft signal — the heartbeat shows "syncing",
  // never an error toast. No escalation: a background liveness ping must not spend a reserve key.
  return NextResponse.json({ live: false, height: null, ts: Date.now() });
}
