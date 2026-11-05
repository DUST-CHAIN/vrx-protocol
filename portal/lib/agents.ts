// Off-chain AGENT registry — SERVER-ONLY (file-backed, touches the filesystem).
//
// WHY this exists (the gap the gas faucet exposed): when an agency registers an agent it signs
// register_peer on-chain (app/agency), but the agent's account id was never persisted anywhere the
// SERVER can see — provisioned.ts is browser localStorage only. So the faucet's "provisioned-list"
// gate had no way to recognise a freshly-registered mobile agent (exactly the user who hits the gas
// wall). This store closes that gap: the agency's register-agent call also POSTs the {agent, agency}
// pair here, so the faucet can confirm the agent is a real, agency-onboarded actor.
//
// It's an OFF-CHAIN convenience mirror, not a source of truth — the chain (get_peer) remains
// authoritative; the faucet falls back to an on-chain check for agents registered outside this portal.
//
// PRIVACY: stores only the neutral on-chain account ids (agent + its agency) + a timestamp. No
// PII, no opaque refs. Mirrors lib/developers.ts + lib/applications.ts; under portal/.data (gitignored).

import { promises as fs } from "fs";
import path from "path";

export type AgentRecord = {
  /** The agent's neutral NEAR account (its on-chain Peer id). */
  account: string;
  /** The agency (Org) account that registered it. */
  agency: string;
  /** ms epoch when recorded from the agency dashboard. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "agents.json");

async function readAll(): Promise<AgentRecord[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AgentRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: AgentRecord[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** All recorded agents, newest first. */
export async function listAgents(): Promise<AgentRecord[]> {
  return (await readAll()).sort((a, b) => b.at - a.at);
}

/** This agency's registered agents, newest first (for the agency's roster + performance views). */
export async function listAgentsForAgency(agency: string): Promise<AgentRecord[]> {
  const org = agency.trim().toLowerCase();
  if (!org) return [];
  return (await readAll()).filter((r) => r.agency.toLowerCase() === org).sort((a, b) => b.at - a.at);
}

/** Is this account a known agent in the local mirror? */
export async function isKnownAgent(account: string): Promise<boolean> {
  const a = account.trim().toLowerCase();
  return (await readAll()).some((r) => r.account.toLowerCase() === a);
}

/** The agency an agent belongs to (write-through), or null if we haven't witnessed them. */
export async function agencyOf(account: string): Promise<string | null> {
  const a = account.trim().toLowerCase();
  return (await readAll()).find((r) => r.account.toLowerCase() === a)?.agency ?? null;
}

/** Record an agency→agent registration (idempotent on the agent account; updates agency/at). */
export async function recordAgent(account: string, agency: string): Promise<void> {
  const acc = account.trim();
  const org = agency.trim();
  if (!acc || !org) return;
  const list = await readAll();
  const idx = list.findIndex((r) => r.account.toLowerCase() === acc.toLowerCase());
  const rec: AgentRecord = { account: acc, agency: org, at: Date.now() };
  if (idx >= 0) list[idx] = rec;
  else list.push(rec);
  await writeAll(list);
}
