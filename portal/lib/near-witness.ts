// NEAR-BLOCK TIME WITNESS (the chosen time-hardening: "NTP-enforce + NEAR-block-height witness per seal").
// SERVER-ONLY. The ADVERSARIAL half of the time model (lib/clock.ts covers the ACCIDENTAL half via the plausibility
// guard; a real NTP daemon on the box is the ops side). A NEAR block carries a PUBLIC, independent timestamp no VRX
// operator can forge — so stamping a seal with "the NEAR chain was at ~block N (block time T_near) when I sealed
// this" gives every seal an IMMEDIATE trustless time-bound (minutes), complementing the Bitcoin/OTS bound (hours).
//
// ── WHY THIS + NTP TOGETHER IS STRONG (two different failure modes) ──────────────────────────────────────────
//   • NTP + the lib/clock.ts boot plausibility/drift check → fixes the COMMON, ACCIDENTAL failure: a drifted/unset
//     VM clock silently mis-stamping everything. Always-on, no external dependency at seal time.
//   • NEAR-block witness → fixes the ADVERSARIAL failure: a malicious operator who sets the box clock to BACKDATE a
//     seal. You cannot fake "this seal names NEAR block N" — block N's real timestamp is public + independent. If the
//     asserted time and the NEAR block time disagree wildly, the backdating is detectable.
//   • Bitcoin/OTS (already built, lib/ots-anchor) → the PERMANENT upper bound that lands hours later.
// Three layers, each covering what the others can't.
//
// ── POSTURE: BEST-EFFORT, NEVER BLOCKING (same as OTS) ───────────────────────────────────────────────────────
// A witness read is a cheap keyless NEAR block fetch (the exact pattern /api/chain-head uses), but if the RPC is
// down/throttled it returns null and the seal proceeds with asserted-only time. The witness is ADDED assurance, never
// a gate — a money/consent move must never wait on (or fail because of) a chain read. A short in-process cache means
// a BURST of seals shares one read instead of hammering the free tier.

import { providers } from "near-api-js";
import { serverProvidersKeyless } from "./config";
import { now as vrxNow } from "./clock";

/** One NEAR block witness: the chain height + the block's OWN timestamp (ms), both from NEAR's public header. The
 *  block timestamp is the independent clock — it is NOT our box clock. `readAtMs` is when WE read it (our asserted
 *  time), kept so a reader can see the asserted-vs-witness delta. */
export type NearWitness = {
  height: number;
  /** The NEAR block's own header timestamp in ms (NEAR reports ns; we divide). The trustless, operator-unforgeable time. */
  blockTimestampMs: number;
  /** Our asserted time at the moment we read the block (lib/clock now) — for the drift delta. */
  readAtMs: number;
};

const PROVIDERS = serverProvidersKeyless(providers);

// Short in-process cache so a burst of seals shares one chain read (a witness that's a few seconds stale is fine —
// it still bounds the seal to within a block or two). Env-tunable; 0 disables.
const CACHE_MS = Number(process.env.VRX_NEAR_WITNESS_CACHE_MS || 5_000);
let cached: { w: NearWitness; at: number } | null = null;

// A hard ceiling on how long ANY single witness read may take — so a hung/slow RPC NEVER stalls the seal path. Past
// this, the read loses the race and the seal proceeds with asserted-only time (null witness). Best-effort means
// best-effort (adversarial-pass guard: a witness must never block a money/consent move).
const WITNESS_TIMEOUT_MS = Number(process.env.VRX_NEAR_WITNESS_TIMEOUT_MS || 2_500);
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * Read the current NEAR block as a time witness — BEST-EFFORT, NEVER throws. Returns null if every pooled keyless
 * provider fails (RPC down / throttled / offline), so the caller proceeds with asserted-only time. Short-cached.
 * Uses the FREE keyless pool and never escalates to a reserve key (a witness must be free, like the heartbeat).
 */
export async function readNearWitness(): Promise<NearWitness | null> {
  const t = vrxNow();
  if (cached && t - cached.at < CACHE_MS) return cached.w;
  for (let i = 0; i < PROVIDERS.length; i++) {
    try {
      // Race the read against a hard timeout — a hung RPC must never stall the seal (best-effort contract).
      const block = await withTimeout(PROVIDERS[i].block({ finality: "optimistic" }), WITNESS_TIMEOUT_MS);
      if (!block) continue; // this provider timed out → try the next; if all time out, return null below
      // NEAR header.timestamp is NANOSECONDS (string or number). Convert to ms. Guard a bad/absent value.
      const tsNs = Number((block.header as { timestamp?: number | string }).timestamp ?? 0);
      const blockTimestampMs = Number.isFinite(tsNs) && tsNs > 0 ? Math.floor(tsNs / 1_000_000) : 0;
      const w: NearWitness = { height: block.header.height, blockTimestampMs, readAtMs: t };
      cached = { w, at: t };
      return w;
    } catch {
      /* try the next provider */
    }
  }
  return null; // whole pool failed → caller seals with asserted-only time (witness is added assurance, not a gate)
}

/** The witness fields to RECORD alongside a seal (flat, serializable, no PII) — a seal stores these so later anyone
 *  can see "created at NEAR block N, whose public timestamp was T_near". Null-safe: an absent witness records zeros. */
export type WitnessStamp = { nearHeight: number; nearBlockMs: number };
export function witnessStamp(w: NearWitness | null): WitnessStamp {
  return { nearHeight: w?.height ?? 0, nearBlockMs: w?.blockTimestampMs ?? 0 };
}

/**
 * The asserted-vs-witness DRIFT: how far our box clock (asserted) is from the NEAR block time (trustless), in ms.
 * A large |drift| means the box clock is wrong OR someone is backdating — either way, a signal worth surfacing.
 * Returns null if there's no witness (can't compare). Positive = our clock is AHEAD of NEAR; negative = behind.
 */
export function clockDriftVsNear(w: NearWitness | null): number | null {
  if (!w || w.blockTimestampMs <= 0) return null;
  return w.readAtMs - w.blockTimestampMs;
}

/** The drift threshold past which the box clock is considered SUSPECT (default 120s — NEAR optimistic head is at most
 *  a few blocks / seconds behind real time, so a 2-minute gap is well outside normal and points at a wrong clock). */
export const DRIFT_SUSPECT_MS = Number(process.env.VRX_CLOCK_DRIFT_SUSPECT_MS || 120_000);

/**
 * BOOT / HEALTH drift check against NEAR (the "NEAR as an NTP-like witness" idea). Reads the chain, compares our
 * clock, and WARNS loudly once if |drift| exceeds the threshold — catching a wrong box clock early (before it
 * mis-stamps provenance). Best-effort: if NEAR is unreachable it returns {checked:false} and says nothing (can't
 * blame the clock when we couldn't read the reference). Call at boot and/or periodically from ops.
 */
let warnedDrift = false;
export async function verifyClockAgainstNear(): Promise<{ checked: boolean; driftMs: number | null; suspect: boolean }> {
  const w = await readNearWitness();
  const drift = clockDriftVsNear(w);
  if (drift === null) return { checked: false, driftMs: null, suspect: false };
  const suspect = Math.abs(drift) > DRIFT_SUSPECT_MS;
  if (suspect && !warnedDrift) {
    warnedDrift = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[near-witness] box clock drifts ${Math.round(drift / 1000)}s from the NEAR chain time — the clock may be ` +
        `WRONG (check NTP) or a seal is being backdated. Provenance timestamps are suspect until this is resolved. ` +
        `See OPEN_ITEMS S386 (time trust model).`
    );
  }
  return { checked: true, driftMs: drift, suspect };
}

/** Test/teardown — clear the short cache so a test controls what the next read returns. */
export function __clearWitnessCache(): void {
  cached = null;
  warnedDrift = false;
}
