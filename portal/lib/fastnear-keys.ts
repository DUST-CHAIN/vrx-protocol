// metadata (email, label, dashboard url, status) and an OPS LOG of every auto-escalation (when keyless hit
// a rate limit and we fell back to a reserve key). Owner-managed from the ⚙ Settings FastNEAR card.
// WHY a store (not just env): keys are FINITE one-time grants (FastNEAR trial = 500k once, reserves never
// expire but DON'T refresh; only a paid subscription refreshes). So we must (a) track which key is spent,
// (b) add/remove key+email pairs from the UI, (c) log which key was burned when, with the email + login url
// to go check it. Secrets live in `.data` (gitignored) + are seeded from.env.local on first run; they are
// NEVER committed and the API masks the key before it leaves the server.
// STORAGE NOTE (same as rpc-usage): Next.js dev route-isolates modules, so disk is the single source of
// truth — every mutation is an immediate read-modify-write, serialized through a promise chain.

import { promises as fs } from "fs";
import path from "path";
import { FASTNEAR_API_KEYS_RAW, FASTNEAR_DASHBOARD_URL } from "./config";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "fastnear-keys.json");

export type KeyStatus = "active" | "spent" | "removed";

export type FastnearKey = {
  /** The raw API key (server-only; masked before it leaves via the API). */
  key: string;
  /** The account email this key belongs to — so the owner knows WHICH account to log into. */
  email: string;
  /** Optional short label. */
  label?: string;
  /** active = usable; spent = out of credits (kept for the record); removed = hidden from rotation. */
  status: KeyStatus;
  /** ms epoch added. */
  addedAt: number;
};

/** One auto-escalation event: keyless tripped a rate limit and we fell back to a reserve key. */
export type EscalationLog = {
  at: number;
  /** Masked key (last 6) that served. */
  keyMasked: string;
  /** The email of the account that was billed — the "go check this one" pointer. */
  email: string;
  /** Why we escalated (the rate-limit detail). */
  reason: string;
};

type Store = {
  keys: FastnearKey[];
  log: EscalationLog[];
  /** Set to true once we've seeded from env, so a later env edit doesn't re-import removed keys. */
  seeded?: boolean;
};

export const maskKey = (k: string): string => (k.length <= 6 ? k : `…${k.slice(-6)}`);

async function readStore(): Promise<Store> {
  try {
    const s = JSON.parse(await fs.readFile(STORE, "utf8")) as Store;
    return { keys: s.keys ?? [], log: s.log ?? [], seeded: s.seeded };
  } catch {
    return { keys: [], log: [], seeded: false };
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(s, null, 2), "utf8");
}

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (s: Store) => { next: Store; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await ensureSeeded(await readStore());
    const { next, ret } = fn(cur);
    await writeStore(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

// Seed the registry from the env keys ONCE (first run). Env lists raw keys with no metadata, so we import
// them as active with an "unknown" email the owner can edit. After seeding, the store is authoritative —
// editing env won't re-import (so a removed key stays removed).
async function ensureSeeded(s: Store): Promise<Store> {
  if (s.seeded) return s;
  const existing = new Set(s.keys.map((k) => k.key));
  for (const raw of FASTNEAR_API_KEYS_RAW) {
    if (!existing.has(raw)) {
      s.keys.push({ key: raw, email: "(set email)", status: "active", addedAt: Date.now() });
    }
  }
  s.seeded = true;
  return s;
}

/** The keys to rotate for auto-escalation — active only, in registry order (round-robin by the caller). */
export async function activeKeys(): Promise<FastnearKey[]> {
  const s = await ensureSeeded(await readStore());
  return s.keys.filter((k) => k.status === "active");
}

/** The full registry for the owner UI (keys MASKED — raw key never leaves the server). */
export async function listKeysForOwner(): Promise<{
  keys: Array<Omit<FastnearKey, "key"> & { keyMasked: string }>;
  log: EscalationLog[];
  dashboardUrl: string;
}> {
  const s = await ensureSeeded(await readStore());
  return {
    keys: s.keys.map(({ key, ...rest }) => ({ ...rest, keyMasked: maskKey(key) })),
    log: s.log.slice(-30).reverse(), // newest first, last 30
    dashboardUrl: FASTNEAR_DASHBOARD_URL,
  };
}

/** Add a key+email pair (owner UI). No-op if the key already exists. */
export async function addKey(key: string, email: string, label?: string): Promise<void> {
  const k = key.trim();
  if (!k) return;
  await mutate((s) => {
    if (!s.keys.some((x) => x.key === k)) {
      s.keys.push({ key: k, email: email.trim() || "(set email)", label: label?.trim() || undefined, status: "active", addedAt: Date.now() });
    }
    return { next: s, ret: null };
  });
}

/** Set a key's status by its masked suffix (the UI only knows the mask) or exact key. */
export async function setKeyStatus(keyMaskedOrRaw: string, status: KeyStatus): Promise<void> {
  const suffix = keyMaskedOrRaw.replace(/^…/, "").slice(-6);
  await mutate((s) => {
    const hit = s.keys.find((x) => x.key === keyMaskedOrRaw || x.key.slice(-6) === suffix);
    if (hit) hit.status = status;
    return { next: s, ret: null };
  });
}

/** Set a key's email by its masked suffix or exact key. */
export async function setKeyEmail(keyMaskedOrRaw: string, email: string): Promise<void> {
  const suffix = keyMaskedOrRaw.replace(/^…/, "").slice(-6);
  await mutate((s) => {
    const hit = s.keys.find((x) => x.key === keyMaskedOrRaw || x.key.slice(-6) === suffix);
    if (hit) hit.email = email.trim() || "(set email)";
    return { next: s, ret: null };
  });
}

/** Record one auto-escalation event (keyless tripped → reserve key served). Keeps the last 200. */
export async function logEscalation(rawKey: string, email: string, reason: string): Promise<void> {
  await mutate((s) => {
    s.log.push({ at: Date.now(), keyMasked: maskKey(rawKey), email, reason: reason.slice(0, 200) });
    if (s.log.length > 200) s.log = s.log.slice(-200);
    return { next: s, ret: null };
  });
}
