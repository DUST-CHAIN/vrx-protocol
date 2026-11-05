// TERMINATION STORE — SERVER-ONLY (file-backed, append-only). Slice 2 of the cancellation arc.
//
// WHAT THIS IS: the persistence layer for the PURE termination state machine (lib/termination.ts). The machine
// decides WHICH step is lawful and seals it; this store owns the deal binding and durable history. It is an
// instance of the established status-ledger pattern ("one spine, N consumers"): an append-only `.data/`
// file, a serialized `mutate` choke-point (no interleaved read-modify-write), and — the one rule this store
// enforces above a plain log — it CATCHES `TerminationError` so a bad/unlawful step never reaches disk. That is
// the anti-fraud contract made durable: the recorded trail contains only steps that were lawful when taken.
//
// WHAT IT DOES NOT DO (deliberate, scope for slice 2): NO route, NO authz, NO money moved, NO clause
// copy. Who may serve/terminate (= "the Seller" = the developer-on-deal) and the route's fail-closed guard
// are slice 2b — built WITH the route that needs them, not ahead of it. This slice is purely: read the deal's
// current overlay → call advance → persist the sealed step + the new overlay, or refuse. Per-row seals only
// (slice 1's `sealRecord`); whether to add a cross-row HASH CHAIN (like channels) is a slice-2b decision
// made alongside the route, since the chain's value is defeating excision by a holder the route must gate.
//
// THE SHAPE: two durable facts per deal, both keyed by `requestId` (the offer/booking join key):
//   • an append-only ARRAY of TerminationStepRecord (the auditable trail — one row per lawful step), and
//   • the current TerminationOverlay (the derived state + running cure clock — so a reader needn't replay).
// Both live in one `.data/termination.json` object keyed by requestId. The overlay is NOT independent truth —
// it is always the result of replaying the steps; we persist it as a convenience + to feed advance's input.
//
// PRIVACY: inherits the machine's opacity — only the deal ref + step verbs + from/to states + timestamps
// + who + an optional free NOTE + the per-row seal. No PII, no price plaintext (retain/refund AMOUNTS
// are the payment-ledger/vault's job; this store records that a step happened, lawfully, sealed).

import { promises as fs } from "fs";
import path from "path";
import {
  advance,
  initialOverlay,
  TerminationError,
  type AdvanceInput,
  type TerminationOverlay,
  type TerminationStepRecord,
} from "./termination";

// ── Persistence shape ───────────────────────────────────────────────────────────────────────────────────
//
// One entry per deal. `overlay` is the derived current state; `steps` is the append-only trail (oldest-first,
// insertion order — the lawful sequence). A deal absent from the file has never had a default step → its
// effective overlay is `initialOverlay` (state `none`), exactly as if present with an empty trail.
type DealEntry = {
  overlay: TerminationOverlay;
  steps: TerminationStepRecord[];
};

/** The whole store: requestId → that deal's termination history. */
type StoreShape = Record<string, DealEntry>;

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "termination.json");

async function readAll(): Promise<StoreShape> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    // A corrupt/non-object file reads as "no history" rather than throwing — a missing store is the home state.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as StoreShape) : {};
  } catch {
    return {};
  }
}

async function writeAll(store: StoreShape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(store, null, 2), "utf8");
}

// Serialize writes — same discipline as status-ledger.ts / activity.ts / agreements.ts. A termination step is a
// read-modify-write (read the overlay, advance, append) and two concurrent steps must NOT both read the old
// overlay and clobber each other — that would let a second serve slip past a just-recorded first, breaking the
// one-step-at-a-time invariant the machine assumes. The chain makes every mutate see the prior one's result.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (store: StoreShape) => { next: StoreShape; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/** The current overlay for a deal — the persisted one, or the home state if the deal has no history yet. */
export async function overlayFor(requestId: string): Promise<TerminationOverlay> {
  const store = await readAll();
  return store[requestId]?.overlay ?? initialOverlay();
}

/** The full append-only step trail for a deal, oldest-first (the lawful sequence). Empty if no history. */
export async function stepsFor(requestId: string): Promise<TerminationStepRecord[]> {
  const store = await readAll();
  return store[requestId]?.steps ?? [];
}

/**
 * Take ONE lawful termination step for a deal and PERSIST it, atomically against concurrent steps.
 *
 * Reads the deal's current overlay, calls the pure `advance`, and on success appends the sealed record (with
 * the real `requestId` stamped — the machine leaves it "" because the store owns the deal binding) and updates
 * the overlay. If `advance` throws `TerminationError` (an unlawful/too-early step), the store writes NOTHING
 * and re-throws — the contract: a bad attempt leaves no trace on the trail. This is the only writer; callers
 * get back the new overlay + the record that was appended.
 *
 * Note: unlike status-ledger's best-effort `recordTransitions` (a convenience log that must never break the
 * status write that triggered it), this store DOES throw — a termination step is the primary action here, and a
 * caller must know it was refused (the future route turns a TerminationError into a 409/422). Non-Termination
 * errors (disk failure) also propagate — a step that couldn't be durably recorded must not look taken.
 */
export async function recordStep(
  requestId: string,
  input: AdvanceInput
): Promise<{ overlay: TerminationOverlay; record: TerminationStepRecord }> {
  if (!requestId) throw new TerminationError("recordStep requires a requestId (the deal binding)");

  return mutate((store) => {
    const entry: DealEntry = store[requestId] ?? { overlay: initialOverlay(input.at), steps: [] };

    // The pure machine validates + seals against the CURRENT overlay. A TerminationError here propagates out of
    // mutate's fn → the run rejects → writeAll never ran → nothing persisted. (mutate's chain.catch keeps the
    // serialization chain alive after the rejection so later steps still run.)
    const { overlay, record } = advance(entry.overlay, input);

    // The store owns the deal binding: stamp the real requestId the pure machine left blank, then append.
    const stamped: TerminationStepRecord = { ...record, requestId };
    const nextEntry: DealEntry = { overlay, steps: [...entry.steps, stamped] };

    return { next: { ...store, [requestId]: nextEntry }, ret: { overlay, record: stamped } };
  });
}
