// Local record of what THIS client has provisioned — the Root-dashboard v0 read view.
//
// WHY local (not a contract enumeration): 's "clients carry their own weight" principle, we do NOT
// make the contract enumerate nodes/orgs (that would centralize load on us / require a redeploy). Each
// client simply remembers the ids IT provisioned; the read view then confirms each against the live
// contract via get_node/get_org. The global network-wide view is a later SHARED-INDEXER layer, not
// this. So: this list is intentionally "what I provisioned from this browser," not "everything on-chain."
//
// PRIVACY: we store ONLY the neutral on-chain account id + kind + the opaque ref we already sent
// on-chain + a timestamp. No off-chain profile / PII is persisted here — that never left the form.

import { NETWORK, CONTRACT_ID } from "./config";

export type ProvisionedKind = "node" | "org";

export type ProvisionedRecord = {
  id: string; // neutral NEAR account id (on-chain handle)
  kind: ProvisionedKind;
  ref: string; // opaque hash we sent on-chain — NOT the pre-image
  at: number; // ms epoch when provisioned from this client
  tx?: string; // tx hash, if the wallet returned one
};

// Scope the key by network + contract so switching testnet↔mainnet or contract doesn't mix lists.
const STORAGE_KEY = `vrx.provisioned.${NETWORK}.${CONTRACT_ID}`;

function read(): ProvisionedRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProvisionedRecord[]) : [];
  } catch {
    return [];
  }
}

function write(list: ProvisionedRecord[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** All ids this client has provisioned, newest first. */
export function listProvisioned(): ProvisionedRecord[] {
  return read().sort((a, b) => b.at - a.at);
}

/** Record a successful provision (idempotent on id+kind — a re-provision just updates ref/tx/at). */
export function recordProvisioned(rec: Omit<ProvisionedRecord, "at"> & { at?: number }): void {
  const list = read();
  const at = rec.at ?? Date.now();
  const idx = list.findIndex((r) => r.id === rec.id && r.kind === rec.kind);
  const next: ProvisionedRecord = { id: rec.id, kind: rec.kind, ref: rec.ref, tx: rec.tx, at };
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  write(list);
}

/** Forget a locally-tracked id (does NOT touch the chain — this is client bookkeeping only). */
export function forgetProvisioned(id: string, kind: ProvisionedKind): void {
  write(read().filter((r) => !(r.id === id && r.kind === kind)));
}
