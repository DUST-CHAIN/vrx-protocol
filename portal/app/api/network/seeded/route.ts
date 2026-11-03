// GET /api/network/seeded — the DEMO network view.
//
// WHY: /network's default path discovers on-chain registrations via the public NearBlocks indexer and
// confirms each live via FastNEAR (get_node/get_org). In the wallet-less DEMO that is the wrong world:
// the testnet contract has only malformed smoke-test registrations (no usable id) → the page showed
// "No nodes", and the point — a demo page must NOT reach for FastNEAR/NearBlocks at all, only our own
// seeded data. This route serves the SEEDED network straight from our off-chain stores (server-side, no
// RPC, no external indexer): developers (+ their building counts), agencies (+ agent counts), agents.
//
// PRIVACY (network-map-geodata-rules): only neutral account ids + public display fields + counts.
// No PII, no terms, no per-unit data, no buyer accounts.

import { NextResponse } from "next/server";
import { listDevelopers } from "@/lib/developers";
import { listAgents } from "@/lib/agents";
import { listProfiles, publicProfile, verifyProfile } from "@/lib/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type SeededNode = {
  account: string;
  kind: "developer" | "agency" | "agent";
  name: string;
  region?: string;
  verified: boolean;
  /** developer→buildings · agency→agents · agent→0 (no cheap registry count). */
  count: number;
};

export async function GET() {
  const [devs, agents, profiles] = await Promise.all([
    listDevelopers().catch(() => []),
    listAgents().catch(() => []),
    listProfiles().catch(() => []),
  ]);

  const buildingsByDev = new Map(devs.map((d) => [d.account, d.buildingIds?.length ?? 0]));
  const agentsByAgency = new Map<string, number>();
  for (const a of agents) agentsByAgency.set(a.agency, (agentsByAgency.get(a.agency) ?? 0) + 1);

  const nodes: SeededNode[] = profiles
    .map((p) => {
      const pub = publicProfile(p);
      const count =
        pub.role === "developer" ? buildingsByDev.get(pub.account) ?? 0
        : pub.role === "agency" ? agentsByAgency.get(pub.account) ?? 0
        : 0;
      return {
        account: pub.account,
        kind: pub.role as SeededNode["kind"],
        name: pub.legalName || pub.account,
        region: pub.region,
        verified: verifyProfile(p),
        count,
      };
    })
    // busiest-first within the flat list; the page re-groups by kind.
    .sort((a, b) => b.count - a.count || Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name));

  return NextResponse.json({ nodes });
}
