// GET /api/agent/developers?agent=<accountId>
//   → the developers THIS agent's agency has active access to (gated-only), each with its buildings.
//
// This is the information-gate for the agent picker (vrx-read-privacy-model): we never serve a
// developer's building list to an agency that isn't gated to that developer on-chain. Scoping is
// resolved SERVER-SIDE and enforced here (not just hidden in the UI):
//   agent account → get_peer → agency (Peer.g) → for each registry developer, get_gate(dev, agency)
//   → keep only developers with an ACTIVE gate → return {account, name, buildingIds}.
//
// The chain is the source of truth for the relationship (the gate); the registry (lib/developers.ts)
// is the off-chain account→buildings mapping the chain deliberately doesn't hold. Outsiders
// and non-gated agencies get an empty list — the buildings stay behind the gate.
//
// FAIL CLOSED: any read that can't be resolved (unknown agent, inactive peer, RPC failure) yields no
// developers rather than leaking one. Never trust the caller-supplied `agent` beyond using it as the
// lookup key — the on-chain gate is what actually authorizes; the booking write is separately enforced
// by the contract (E58 exclusive / NO_GATE) even if the API were bypassed.

import { NextResponse } from "next/server";
import { listDevelopers, type Developer } from "@/lib/developers";
import { getBuilding } from "@/lib/catalog";
import { getBaseline } from "@/lib/sale-baseline";
import { getPeerServer, isGatedServer } from "@/lib/vrx-server";
import { getFresh, getStale, put, type PickerDeveloper } from "@/lib/access-cache";
import { developersForAgency } from "@/lib/gates";
import { agencyOf } from "@/lib/agents";
import { isDeveloperHidden } from "@/lib/listing-gate";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const agent = searchParams.get("agent")?.trim();
  // An AGENCY can query directly with its own account (it IS the org); an AGENT queries with `agent`
  // and we resolve their agency via get_peer. Either way we end up with the org id to gate on.
  const agencyParam = searchParams.get("agency")?.trim();
  if (!agent && !agencyParam) return NextResponse.json({ developers: [], agency: null });
  const cacheId = agencyParam ?? agent!;

  // Serve a still-fresh cached resolution without touching the chain (access changes rarely). This is
  // what stops the picker from flaking during an RPC burst — and makes a revisit instant.
  const fresh = await getFresh(cacheId);
  if (fresh) return NextResponse.json({ ...fresh, cached: true });

  const all = await listDevelopers();

  // Shape a developer row → { account, name, buildings:[{id,name}] } from the off-chain catalog, so the
  // picker doesn't fetch each building just to label it. No chain reads.
  const shape = async (devs: Developer[]): Promise<PickerDeveloper[]> =>
    Promise.all(
      devs.map(async (d) => ({
        account: d.account,
        name: d.name,
        buildings: (
          await Promise.all(
            d.buildingIds.map(async (id) => {
              const b = await getBuilding(id);
              if (!b) return null;
              // has this building gone ON CONTRACT? A baseline for (developer, building) = the
              // developer's deliberate go-on-contract sign-off = "released". The agent pre-submit guard
              // needs this to refuse booking a not-yet-released unit. Fail-safe to NOT on any read error
              // (the server record belt + V7 NO_GATE are the belts, so a transient miss can't leak).
              const onContract = (await getBaseline(d.account, id).catch(() => null)) != null;
              return { id: b.id, name: b.name, onContract };
            })
          )
        ).filter((b): b is { id: string; name: string; onContract: boolean } => b !== null),
        // §3c: flag a PAUSED developer so the agent UI refuses a NEW booking (existing deals still
        // run). Developer-grain, resolved once here; fail-safe to NOT-paused on any resolve error (never
        // falsely block the agent — the /api/offers POST guard is the authoritative belt either way).
        listingsPaused: await isDeveloperHidden(d.account).catch(() => false),
        // the developer's buyer-detail requirements (§9), so the agent gate can PRE-EMPTIVELY
        // show what THIS developer needs on a buyer before Reserve (passport / full legal name / …). Absent
        // → the global default floor applies (checkBuyerPolicy with no `required`). Pure registry field, no
        // chain read; undefined is fine (means "use the default").
        requiredProfileFields: d.requiredProfileFields,
      }))
    );

  // ── 1) WRITE-THROUGH path (server-authored, no chain read) ────────────────────────────────
  // We record the agent→agency link (agents.json) and each developer→agency gate (gates.json) the
  // moment we WITNESS them in the portal, so browse resolves entirely from OUR server — the chain
  // (throttle-prone) is only the enforcement authority for the actual booking, never the browse. This
  // is what makes the picker work even when every free RPC is 429-blocking.
  const witnessedAgency = agencyParam ?? (agent ? await agencyOf(agent) : null);
  if (witnessedAgency) {
    const gatedAccts = new Set((await developersForAgency(witnessedAgency)).map((a) => a.toLowerCase()));
    const gated = all.filter((d) => gatedAccts.has(d.account.toLowerCase()));
    if (gated.length > 0) {
      const result = { developers: await shape(gated), agency: witnessedAgency };
      await put(cacheId, result);
      return NextResponse.json({ ...result, source: "witnessed" });
    }
  }

  // ── 2) CHAIN fallback (for access granted outside this portal, or not yet witnessed) ──────────
  // Wrapped so a transient RPC failure NEVER 500s (an uncaught throw surfaced as [object Event]). On
  // failure serve the last-known good list (stale beats a false "no access"), else fail closed + rpcError.
  try {
    let agency: string | null = agencyParam ?? null;
    if (!agency && agent) {
      const peer = await getPeerServer(agent);
      agency = peer && peer.a !== false ? peer.g : null;
    }
    if (!agency) return NextResponse.json({ developers: [], agency: null });

    const gatedFlags = await Promise.all(all.map((d) => isGatedServer(d.account, agency!)));
    const gated = all.filter((_, i) => gatedFlags[i]);
    const result = { developers: await shape(gated), agency };
    // Only cache a MEANINGFUL resolution — an empty list can be a genuine "no access" OR a partial RPC
    // failure (get_peer worked but the get_gate reads got throttled); don't poison the cache with it.
    if (result.developers.length > 0) await put(cacheId, result);
    return NextResponse.json(result);
  } catch {
    const stale = await getStale(cacheId);
    if (stale) return NextResponse.json({ ...stale, stale: true });
    return NextResponse.json({ developers: [], agency: null, rpcError: true }, { status: 200 });
  }
}
