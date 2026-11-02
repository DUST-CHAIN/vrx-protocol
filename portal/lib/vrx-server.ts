// VRX contract client — SERVER-ONLY half.
// This is the server twin of the two browser primitives the status cache needs:
// 1. a hashRef that produces a BYTE-IDENTICAL digest to lib/vrx.ts `hashRef` (so the unit_key the
// server derives is the SAME opaque key the client derives + the contract stores — otherwise the
// server would read the wrong tile), and
// 2. a tile reader that, unlike the browser's readTiles, can afford to be PATIENT: one server reads
// the chain on behalf of ALL clients, so a 429 becomes a short backoff-and-retry instead of a
// dropped read. This is the whole point of — RPC load collapses from (clients × units) to
// (~units once, shared), which is what killed the FastNEAR 429 that stalled the grid live.
// PRIVACY: still opaque hashes only. The server has the catalog (building/unit refs) but sends
// ONLY the derived hash to the chain, exactly like the browser does.
// NOTE: server-only. Do NOT import from a "use client" module — this uses node:crypto.

import { createHash } from "crypto";
import { providers } from "near-api-js";
import { CONTRACT_ID, serverProviders } from "./config";
import { countRpc } from "./rpc-usage";
import { effectiveStatus, msToNs, STATUS_HOLD } from "./effective-status";
import type { TileWire } from "./vrx";

// One provider per endpoint (primary + fallbacks), carrying the FastNEAR bearer key when set (server-only)
// so our shared server reads escape the -429 rate limit. viewWithRetry still rotates across endpoints.
const PROVIDERS = serverProviders(providers);

// ── Server hashRef — must match lib/vrx.ts hashRef EXACTLY ────────────────────────────────
// Client scheme: input = `${domain}|${salt}|${text}`, text = stableStringify(payload) | string;
// digest = SHA-256, lowercase hex. Reproduce it here with node:crypto (Web Crypto is also available
// on the server, but createHash is synchronous and simplest; the bytes are identical either way).
export function serverHashRef(
  payload: Record<string, unknown> | string,
  domain = "vrx",
  salt = ""
): string {
  const text = typeof payload === "string" ? payload : stableStringify(payload);
  const input = `${domain}|${salt}|${text}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}

/** The canonical on-chain reference for a unit (mirrors catalog-client.unitRef). */
export function unitRef(buildingId: string, unitId: string): string {
  return `${buildingId}/${unitId}`;
}

/** unit ref → opaque unit_key (mirrors the client: hashRef(ref, "vrx-unit")). */
export function unitKeyOf(buildingId: string, unitId: string): string {
  return serverHashRef(unitRef(buildingId, unitId), "vrx-unit");
}

// ── Patient tile read (server-side) ───────────────────────────────────────────────────────
// One get_tile with a bounded retry on transient/rate-limit failures. The server is the single
// reader for every client, so a brief backoff here is cheap and keeps the whole grid complete —
// far better than the browser's "drop to -1 after 6s" band-aid (which is right for the browser,
// wrong for the shared cache). Returns the EFFECTIVE status (0..3) or -1 if the tile isn't on-chain.
// EFFECTIVE-AVAILABILITY DERIVE (indexer Slice 1, / lib/effective-status). A timed hold expires by
// the CLOCK, not a tx — the contract leaves the tile stored as status:1 (hold) until release/open_claim
// fires, so a raw get_tile.s shows a lapsed hold as still-held (wrong for a race-to-reserve product). So
// when — and ONLY when — a tile reads HOLD, we take the one extra get_hold_expiry read and serve
// `now >= expiry ? open: hold`. Open/closed/done/not-stamped are write-driven and already truthful, so
// they pay NO extra read (calls are expensive). Display-only: open_claim re-enforces on-chain.
async function readTileStatus(unitKey: string): Promise<number> {
  // startAt=1 → lead with the FALLBACK RPC so bulk grid fills don't congest the primary that the
  // latency-critical picker reads (get_peer/get_gate) depend on.
  const tile = await viewWithRetry<TileWire | null>("get_tile", { unit_key: unitKey }, 4, 1);
  if (!tile) return -1;
  if (tile.s !== STATUS_HOLD) return tile.s; // only a hold can be silently stale — no extra read otherwise
  // The one extra read, for holds only. A failure here must NOT drop the whole tile to -1 — fall back to
  // the stored HOLD (the honest raw truth; worst case we show a lapsed hold as held for one more cycle,
  // which the on-chain booking re-check still guards). Lazily release elsewhere reconciles the chain.
  try {
    const expiry = await viewWithRetry<number | null>("get_hold_expiry", { unit_key: unitKey }, 4, 1);
    return effectiveStatus(tile.s, expiry, msToNs(Date.now()));
  } catch {
    return tile.s;
  }
}

// ── Server-side gate / peer reads (agent picker scoping) ──────────────────────────────────
// The picker's API runs on the server and must resolve, for a connected agent: their agency
// (Peer.g) and, for each registry developer, whether a gate exists + is active (Gate.a). These
// reuse the same patient retry as the tile reads — one shared server reader, gentle on the RPC.
// PRIVACY: still opaque; these read neutral account ids + booleans only, no plaintext.

/** Peer wire (subset): `g` = the agent's agency (Org) id, `a` = active. */
export type PeerWire = { g: string; a: boolean };
/** Gate wire (subset): `a` = active. */
export type GateWire = { a: boolean };

/**
 * The agent's peer record, or null if there is CONFIRMED no such peer. An RPC failure (all endpoints
 * 429'd/unreachable) THROWS — the caller must not confuse "couldn't reach the chain" with "no peer",
 * or a rate-limit blip tells a real agent it has no access (the false-negative hit). The picker
 * route catches this → soft rpcError + Retry, not the misleading "no access" state.
 */
export async function getPeerServer(id: string): Promise<PeerWire | null> {
  return await viewWithRetry<PeerWire | null>("get_peer", { id });
}

/**
 * True only if node→org has a gate AND it's active. A CONFIRMED absent/inactive gate → false (fail
 * closed). But an RPC FAILURE (all endpoints 429'd / unreachable) THROWS — the caller must treat
 * "couldn't verify" differently from "confirmed no access", so a rate-limit blip doesn't tell a
 * legitimately-gated agency it has no access. The picker route catches this → soft rpcError + retry.
 */
export async function isGatedServer(nodeId: string, orgId: string): Promise<boolean> {
  const g = await viewWithRetry<GateWire | null>("get_gate", { node_id: nodeId, org_id: orgId });
  return !!g && g.a !== false;
}

// ── Server-side claim reads (the developer's Incoming-bookings queue) ──────────────────────
// The queue read (get_pending_claims + get_claim) was the last piece still hitting the chain from the
// BROWSER on the shared/unkeyed endpoint → it threw rpc_timeout under the -429 throttle. Route it through
// the server's keyed, patient reader instead (same pattern as status/picker). PRIVACY: request ids +
// opaque wire only. An RPC failure THROWS (caller shows a soft "network busy", not a false empty).
export type ClaimWireServer = { s: number; [k: string]: unknown };

export async function getPendingClaimsServer(nodeId: string): Promise<string[]> {
  return (await viewWithRetry<string[] | null>("get_pending_claims", { node_id: nodeId })) ?? [];
}

export async function getClaimServer(requestId: string): Promise<ClaimWireServer | null> {
  return await viewWithRetry<ClaimWireServer | null>("get_claim", { request_id: requestId });
}

async function viewWithRetry<T>(
  method: string,
  args: Record<string, unknown>,
  tries = 4,
  // startAt shifts which endpoint the FIRST attempt uses. Bulk status reads pass 1 so they lead with
  // the FALLBACK RPC, leaving the primary (FastNEAR) uncongested for the tiny, latency-critical picker
  // reads (get_peer/get_gate) — that separation is what stops a big building's fill from starving them.
  startAt = 0
): Promise<T> {
  const args_base64 = Buffer.from(JSON.stringify(args)).toString("base64");
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    const provider = PROVIDERS[(attempt + startAt) % PROVIDERS.length];
    try {
      const res = await provider.query<{ result: number[]; block_height: number; block_hash: string }>({
        request_type: "call_function",
        account_id: CONTRACT_ID,
        method_name: method,
        args_base64,
        finality: "optimistic",
      });
      countRpc(); // one keyed FastNEAR call succeeded (usage estimate)
      const raw = Buffer.from(res.result).toString("utf8");
      return JSON.parse(raw) as T;
    } catch (e) {
      lastErr = e;
      // Exponential backoff on any failure (429 / transient RPC wobble). 200ms, 400ms, 800ms.
      if (attempt < tries - 1) await sleep(200 * 2 ** attempt);
    }
  }
  throw lastErr;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Bounded worker-pool core (pure scheduling/aggregation — extracted for testability) ────────
// Both readBuildingStatus and readUnitsStatus are the SAME shape: run an injected per-unit async read
// across a low, fixed number of concurrent workers, with two knobs that differ per caller:
// - a time budget (DEADLINE): workers stop STARTING new reads once past it (in-flight reads finish).
// Pass Infinity for "no budget" (the small-chunk caller). This is the A1 fix — a huge building on a
// slow/rate-limited RPC must never hang the request past the route timeout; whatever was read is
// returned, un-read units stay ABSENT from the map (the client treats absent as "not yet known").
// - an onError policy: readBuildingStatus records -1 (report "unknown/not stamped", keep going);
// readUnitsStatus leaves the unit ABSENT (don't persist a bogus -1 during an outage).
// The core returns { map, ok, failed } so a caller can decide what an all-failed run means (the small
// chunk throws rpc_unavailable; the big bake tolerates partials). `now` is injectable so the deadline
// branch is deterministically testable without real time. The pool is drift-sensitive production logic
// (concurrency cap, deadline cutoff, failure accounting) — pinning it here guards those invariants.
export type PoolResult = { map: Record<string, number>; ok: number; failed: number };

export async function runBoundedStatusPool(
  unitIds: string[],
  read: (unitId: string) => Promise<number>,
  opts: {
    concurrency: number;
    deadlineAt?: number; // absolute ms timestamp; omit/Infinity = no budget
    onError: "record-neg1" | "absent"; // how a failed read lands in the map
    now?: () => number; // injectable clock (deadline check) — defaults to Date.now
  }
): Promise<PoolResult> {
  const { concurrency, onError } = opts;
  const deadlineAt = opts.deadlineAt ?? Infinity;
  const now = opts.now ?? Date.now;
  const map: Record<string, number> = {};
  let ok = 0;
  let failed = 0;
  let i = 0;
  async function worker() {
    // Stop STARTING new reads once past the budget — in-flight reads still resolve. Un-read units
    // stay absent (client refreshes). Infinity deadline makes this a plain "drain the queue".
    while (i < unitIds.length && now() < deadlineAt) {
      const idx = i++;
      const unitId = unitIds[idx];
      try {
        map[unitId] = await read(unitId);
        ok++;
      } catch {
        failed++;
        if (onError === "record-neg1") map[unitId] = -1; // else leave absent (no bogus -1 in an outage)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unitIds.length) }, worker));
  return { map, ok, failed };
}

/**
 * Read the on-chain status of MANY units on the server, gently. Because this is the single shared
 * reader (not per-client), we cap concurrency low and let each read retry — the goal is COMPLETE +
 * correct, not fast-at-all-costs. Returns a { unitId → status } map (-1 = not stamped).
 *
 * concurrency=6 with per-read retry keeps us comfortably under the FastNEAR limiter while still
 * clearing 216 units in a couple of seconds; the result is cached so clients pay this cost ~never.
 */
export async function readBuildingStatus(
  buildingId: string,
  unitIds: string[],
  concurrency = 6,
  deadlineMs = 12000
): Promise<Record<string, number>> {
  const { map } = await runBoundedStatusPool(
    unitIds,
    (unitId) => readTileStatus(unitKeyOf(buildingId, unitId)),
    { concurrency, deadlineAt: Date.now() + deadlineMs, onError: "record-neg1" }
  );
  return map;
}

/**
 * Read status for a SPECIFIC set of units (a progressive chunk or a single clicked unit, A1). Small by
 * design, so no time budget — just a low concurrency to stay gentle on the RPC. Returns { unitId →
 * status }; a read that exhausts retries leaves that unit ABSENT (never fails the whole chunk).
 */
export async function readUnitsStatus(
  buildingId: string,
  unitIds: string[],
  concurrency = 5
): Promise<Record<string, number>> {
  const { map, ok, failed } = await runBoundedStatusPool(
    unitIds,
    (unitId) => readTileStatus(unitKeyOf(buildingId, unitId)),
    { concurrency, onError: "absent" } // no deadline; don't persist a bogus -1 during an outage
  );
  // If EVERYTHING failed (RPC down / IP-throttled), throw so the caller serves the snapshot + flags
  // busy, rather than persisting a map of false "not stamped" (-1) values that would hide real units.
  if (ok === 0 && failed > 0) throw new Error("rpc_unavailable");
  return map;
}
