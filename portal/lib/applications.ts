// Off-chain application store — the Lane 2 (agency) invite → apply → approve backend.
// SERVER-ONLY. This is imported by the /api/applications routes, never by client components (it
// touches the filesystem). Per ONBOARDING_ACCOUNTS open-Q #1 the backend shape is a decision; for the
// demo-laptop Root dashboard we use a **file-backed JSON store** (no external DB): zero infra, easy to
// inspect, and it matches the "clients carry their own weight" philosophy — this state lives with
// the Root client, not on a central server. Swap to SQLite/KV later without changing the API surface.
// PRIVACY: this store DOES hold the raw off-chain agency profile (name/contact/region) — that's the
// point of an off-chain store, and it deliberately never goes on-chain. Only the HASH of the profile is
// sent to register_org on approval. Keep this file off any public path (it's under portal/.data, gitignored).
// The whole invite/approval workflow is off-chain (ONBOARDING_ACCOUNTS): only the final approved
// register_org (opaque ref) touches the chain, signed by the owner from the Root dashboard.

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export type AppStatus = "invited" | "applied" | "approved" | "rejected";

export type Application = {
  /** Unguessable invite token (in the link). Also the record id. */
  token: string;
  status: AppStatus;
  /** ms epoch. */
  createdAt: number;
  updatedAt: number;
  /** Invite expiry (ms epoch); applies while status === "invited". */
  expiresAt: number;
  /** Optional human label for the invite (who it's for) — operator's note, not sent on-chain. */
  label?: string;
  // ── filled when the agency applies ──
  /** The agency's self-custodied NEAR account (the future Org id). */
  account?: string;
  /** Raw off-chain profile — name/contact/region. NEVER sent on-chain; only its hash is. */
  profile?: string;
  // ── filled on decision ──
  /** Opaque org_ref (hash of profile) actually sent on-chain, set when approved. */
  orgRef?: string;
  /** register_org tx hash, when approved + signed. */
  tx?: string;
  /** Operator note on a rejection. */
  rejectReason?: string;
};

// Store under portal/.data (gitignored). Kept out of app/ and public/ so it's never served.
const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "applications.json");

async function readAll(): Promise<Application[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Application[]) : [];
  } catch {
    return []; // no file yet
  }
}

async function writeAll(list: Application[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** All applications, newest first. (Server-side; the API route decides what to expose.) */
export async function listApplications(): Promise<Application[]> {
  return (await readAll()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getApplication(token: string): Promise<Application | null> {
  return (await readAll()).find((a) => a.token === token) ?? null;
}

/** Create a fresh invite. `ttlMs` defaults to 7 days. Returns the new record. */
export async function createInvite(label?: string, ttlMs = 7 * 24 * 60 * 60 * 1000): Promise<Application> {
  const now = Date.now();
  const rec: Application = {
    token: crypto.randomBytes(24).toString("base64url"),
    status: "invited",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttlMs,
    label: label?.trim() || undefined,
  };
  const list = await readAll();
  list.push(rec);
  await writeAll(list);
  return rec;
}

/** Agency submits its application against an invite token. Guards expiry + single-use. */
export async function submitApplication(
  token: string,
  account: string,
  profile: string
): Promise<Application> {
  const list = await readAll();
  const idx = list.findIndex((a) => a.token === token);
  if (idx < 0) throw new Error("Unknown or invalid invite.");
  const rec = list[idx];
  if (rec.status !== "invited") throw new Error("This invite has already been used.");
  if (Date.now() > rec.expiresAt) throw new Error("This invite has expired.");
  if (!account.trim()) throw new Error("A NEAR account is required.");
  list[idx] = {
    ...rec,
    status: "applied",
    account: account.trim(),
    profile: profile.trim(),
    updatedAt: Date.now(),
  };
  await writeAll(list);
  return list[idx];
}

/** Operator marks an application approved after the owner signed register_org on-chain. */
export async function markApproved(token: string, orgRef: string, tx?: string): Promise<Application> {
  return mutate(token, (rec) => {
    if (rec.status !== "applied") throw new Error("Only an applied application can be approved.");
    return { ...rec, status: "approved", orgRef, tx, updatedAt: Date.now() };
  });
}

export async function markRejected(token: string, reason?: string): Promise<Application> {
  return mutate(token, (rec) => {
    if (rec.status !== "applied") throw new Error("Only an applied application can be rejected.");
    return { ...rec, status: "rejected", rejectReason: reason?.trim() || undefined, updatedAt: Date.now() };
  });
}

/** Revoke an unused invite (only while still "invited"). */
export async function revokeInvite(token: string): Promise<void> {
  const list = await readAll();
  const rec = list.find((a) => a.token === token);
  if (rec && rec.status === "invited") {
    await writeAll(list.filter((a) => a.token !== token));
  }
}

async function mutate(token: string, fn: (rec: Application) => Application): Promise<Application> {
  const list = await readAll();
  const idx = list.findIndex((a) => a.token === token);
  if (idx < 0) throw new Error("Unknown application.");
  list[idx] = fn(list[idx]);
  await writeAll(list);
  return list[idx];
}

/** Public-safe projection for the applicant page — never leak other applications or internal notes. */
export function publicView(rec: Application) {
  return {
    token: rec.token,
    status: rec.status,
    label: rec.label,
    expiresAt: rec.expiresAt,
    expired: rec.status === "invited" && Date.now() > rec.expiresAt,
    account: rec.account,
  };
}
