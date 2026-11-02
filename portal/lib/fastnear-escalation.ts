// but if a keyless read trips a rate limit (429/quota), we AUTO-fall-back to a reserve key for a short
// COOLDOWN window, then revert to keyless when calm. This keeps the demo/dev alive through a burst without
// us babysitting it, spends the minimum (only during the window), and LOGS every use (which key + email +
// why) so the owner can see — after the fact — that a reserve was touched and go check that account.
// balance tracking needed. State is in-memory (a burst is transient; losing the window on a restart just
// means the next trip re-arms it) but the LOG is persisted to the registry store so it survives.

import { activeKeys, logEscalation } from "./fastnear-keys";

/** How long one escalation stays armed before reverting to keyless. A burst is short; 10 min rides it out. */
const COOLDOWN_MS = Number(process.env.VRX_FASTNEAR_ESCALATION_MS || 10 * 60 * 1000);

let armedUntil = 0; // ms epoch; escalation is active while Date.now() < armedUntil
let cursor = 0; // round-robin position across the active keys

/** True iff we're currently in an escalation window (should attach a key to reads). */
export function escalationActive(): boolean {
  return Date.now() < armedUntil;
}

/** ms remaining in the current window (0 if not armed) — for the owner UI. */
export function escalationRemainingMs(): number {
  return Math.max(0, armedUntil - Date.now());
}

/**
 * Arm (or re-arm) the escalation window because a keyless read just tripped a rate limit. Picks the next
 * active reserve key (round-robin), logs the event (key masked + email + reason), and returns the RAW key to
 * use for this call. Returns null if there are no active keys (nothing to escalate to → stays keyless, the
 * caller surfaces the failure). Safe to call repeatedly — it just refreshes the window + rotates the key.
 */
export async function armEscalation(reason: string): Promise<string | null> {
  const keys = await activeKeys();
  if (keys.length === 0) return null; // no reserves to fall back to
  armedUntil = Date.now() + COOLDOWN_MS;
  const chosen = keys[cursor % keys.length];
  cursor++;
  await logEscalation(chosen.key, chosen.email, reason).catch(() => {});
  return chosen.key;
}

/** The current key to attach while armed (round-robin), or null if not armed / no active keys. */
export async function currentEscalationKey(): Promise<string | null> {
  if (!escalationActive()) return null;
  const keys = await activeKeys();
  if (keys.length === 0) return null;
  return keys[cursor % keys.length].key;
}
