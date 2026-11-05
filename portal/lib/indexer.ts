// Shared-indexer global discovery (layer #2) — the network-wide "what's provisioned" view.
//
//  defines three enumeration layers: (1) per-client local store (lib/provisioned.ts — only
// what THIS client provisioned), (2) a SHARED INDEXER for the global list, (3) on-chain list_* views
// (a fallback we chose NOT to build, as it centralizes load on us). This is layer #2, done the light
// way: instead of self-hosting an indexer process, we read the PUBLIC NearBlocks indexer, which already
// indexes our contract's register_node/register_org transactions. No infra to run, no contract change.
//
// This gives the global view WITHOUT the local store's blind spot (provisions made from other clients).
// Each discovered id is still confirmed live via get_node/get_org (the indexer can lag / be eventually
// consistent — the chain is truth). When we outgrow the public indexer (rate limits, richer queries),
// this is the seam to swap for a self-hosted indexer that ingests the NEP-297 EVENT_JSON logs
// (NodeRegistered / OrgRegistered) — same shape, same callers.
//
// PRIVACY: registration args carry only the opaque instance_hash / org_ref (already on-chain,
// public). We surface the neutral account id + that opaque ref — no PII (there is none on-chain).

import { CONTRACT_ID, NETWORK } from "./config";

const NEARBLOCKS_BASE =
  NETWORK === "mainnet" ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io";

export type DiscoveredKind = "node" | "org";

export type Discovered = {
  id: string; // the provisioned account id (from register_* args)
  kind: DiscoveredKind;
  tx: string; // the registration tx hash
  at: number; // ms epoch (from block_timestamp ns)
};

type NbAction = { action?: string; method?: string; args?: string };
type NbTxn = {
  transaction_hash: string;
  block_timestamp: string | number;
  actions?: NbAction[];
};

// Pull the provisioned account id out of a register_* call's args. register_node(node_id, instance_hash)
// / register_org(org_id, org_ref). Args come back as a JSON STRING from NearBlocks. Some early smoke-test
// txns used partial args (no node_id) — we skip those (nothing usable to show).
function idFromArgs(argsJson: string | undefined, kind: DiscoveredKind): string | null {
  if (!argsJson) return null;
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    const key = kind === "node" ? "node_id" : "org_id";
    const v = a[key];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

async function fetchRegistrations(
  method: "register_node" | "register_org",
  kind: DiscoveredKind,
  perPage: number
): Promise<Discovered[]> {
  const url = `${NEARBLOCKS_BASE}/v1/account/${CONTRACT_ID}/txns?method=${method}&per_page=${perPage}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  const data = (await res.json()) as { txns?: NbTxn[] };
  const out: Discovered[] = [];
  for (const t of data.txns ?? []) {
    const call = (t.actions ?? []).find((x) => x.method === method);
    const id = idFromArgs(call?.args, kind);
    if (!id) continue;
    out.push({
      id,
      kind,
      tx: t.transaction_hash,
      at: Math.floor(Number(t.block_timestamp) / 1e6),
    });
  }
  return out;
}

/**
 * Discover all nodes + orgs ever provisioned on the contract, newest first, de-duplicated by id
 * (an id re-registered keeps the most recent tx). Confirm each live with get_node/get_org at the call
 * site — the indexer can lag. Throws if the indexer is unreachable (the caller shows a fallback note).
 */
export async function discoverProvisioned(perPage = 25): Promise<Discovered[]> {
  const [nodes, orgs] = await Promise.all([
    fetchRegistrations("register_node", "node", perPage),
    fetchRegistrations("register_org", "org", perPage),
  ]);
  const byId = new Map<string, Discovered>();
  for (const d of [...nodes, ...orgs].sort((a, b) => a.at - b.at)) {
    byId.set(`${d.kind}:${d.id}`, d); // later (newer) wins
  }
  return Array.from(byId.values()).sort((a, b) => b.at - a.at);
}
