// OTS BOOTSTRAP (D-) — the env-gated swap from the deterministic STUB to the REAL OpenTimestamps
// provider. Mirrors `ensureLiveTransports` (lib/onchain-transport): idempotent, flag-gated, called at the emit
// site. DEFAULT IS THE STUB (F-A): the real provider — which makes actual outbound calls to public Bitcoin
// calendar servers — loads ONLY when `VRX_OTS_LIVE=1`. So in demo/dev/test the queue runs fully (emit → pending),
// but nothing touches the network, and `proven` is only exercised by tests that inject a fake proving provider.
//
// This keeps the OTS arc Track-B-gated (D-): a real stamp is a (free, hash-only) real-world side effect, so
// it's opt-in. Flip `VRX_OTS_LIVE=1` on the box when Track B arms; until then the stub is the safe default and the
// live pay/seal paths are byte-for-byte unaffected (the queue's in-system record is already final regardless).
//
// SERVER-ONLY: dynamically imports ots-provider-real.server (which pulls in the CommonJS OTS lib) so the client
// bundle never sees it (Trap 4 of the adversarial pass).

import { setOtsProvider } from "./ots-anchor";

let armed = false;

/** Is the live OTS provider requested (env flag)? Default OFF → the stub stays active. */
export function otsLiveRequested(): boolean {
  return process.env.VRX_OTS_LIVE === "1";
}

/**
 * Idempotent: if `VRX_OTS_LIVE=1`, swap the queue's provider to the real OpenTimestamps provider ONCE. Safe to
 * call on every emit (anchor can call it). A no-op when the flag is off (stub stays) or already armed. Never
 * throws into the emit path — a bootstrap failure leaves the stub active (fail-safe: the record still seals,
 * only the real Bitcoin anchor is skipped).
 */
export async function ensureRealOtsProvider(): Promise<void> {
  if (armed || !otsLiveRequested()) return;
  try {
    const { createRealOtsProvider } = await import("./ots-provider-real.server");
    setOtsProvider(createRealOtsProvider());
    armed = true;
  } catch {
    // Lib load / dynamic-import failure → stay on the stub. The queue still tracks pending; no crash.
  }
}

/** Test/teardown: forget the armed flag so a later call can re-arm (the provider itself is reset via ots-anchor). */
export function __resetOtsBootstrapForTests(): void {
  armed = false;
}
