// Off-chain GATE registry — SERVER-ONLY (file-backed). The write-through half of the access model.
// The chain is the SOURCE OF TRUTH for a gate (developer grant_gate / revoke_gate → the contract
// enforces it at booking, NO_GATE/E58 — a stale copy here can NEVER let a bad booking through). But the
// BROWSE path shouldn't depend on reading the chain: the free testnet RPC hard-throttles, and a blocked
// RPC was giving legitimately-gated agents a false "no access". So we record each gate WHEN WE WITNESS
// IT — the developer grants access in the /node UI, and right after it confirms on-chain the client
// POSTs {developer, agency} here. The picker then answers from this map instantly, RPC or not.
// This is write-through (record at grant time), the primary; the read-through access-cache is the
// fallback for gates granted outside this portal; the indexer is the eventual "keep it fresh from
// chain events forever" version. Same file-backed.data pattern as developers.ts / agents.ts.
// PRIVACY: neutral account ids + a timestamp only. A gate can carry an on-chain unit SCOPE (opaque
// hashes); we don't need it for browse scoping (the catalog already maps developer→buildings), so we
// deliberately DON'T store scope here — just the relationship.

import { promises as fs } from "fs";
import path from "path";

export type Gate = {
  /** The developer (Node) account that granted access. */
  developer: string;
  /** The agency (Org) account that was granted access. */
  agency: string;
  /** True unless the gate was revoked (developer revoke_gate). */
  active: boolean;
  /** ms epoch when recorded. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "gates.json");

async function readAll(): Promise<Gate[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Gate[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Gate[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** All gates. */
export async function listGates(): Promise<Gate[]> {
  return readAll();
}

/** The agencies with an ACTIVE gate to this developer (write-through view). */
export async function agenciesForDeveloper(developer: string): Promise<string[]> {
  const dev = developer.trim().toLowerCase();
  return (await readAll())
    .filter((g) => g.active && g.developer.toLowerCase() === dev)
    .map((g) => g.agency);
}

/** The developers this agency has an ACTIVE gate from (write-through view). */
export async function developersForAgency(agency: string): Promise<string[]> {
  const org = agency.trim().toLowerCase();
  return (await readAll())
    .filter((g) => g.active && g.agency.toLowerCase() === org)
    .map((g) => g.developer);
}

/** Record a granted gate (idempotent on developer+agency; re-grant reactivates). */
export async function recordGate(developer: string, agency: string, active = true): Promise<void> {
  const dev = developer.trim();
  const org = agency.trim();
  if (!dev || !org) return;
  const list = await readAll();
  const idx = list.findIndex(
    (g) => g.developer.toLowerCase() === dev.toLowerCase() && g.agency.toLowerCase() === org.toLowerCase()
  );
  const rec: Gate = { developer: dev, agency: org, active, at: Date.now() };
  if (idx >= 0) list[idx] = rec;
  else list.push(rec);
  await writeAll(list);
}
