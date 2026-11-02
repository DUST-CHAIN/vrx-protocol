// BUYER PROTECTION EVENT LOG — SERVER-ONLY, file-backed. The "every sensitive act on the buyer
// record is a sealed, timestamped, visible-to-all-sides event" store. The FOURTH consumer of the
// attested-record spine (offers → agreements → buyer roster → this), same shape as always: a plaintext
// event + a salted seal (lib/seal). One pattern, N consumers (the "scan for the reusable PATTERN").
// WHY A SEPARATE LOG (not more fields on the offer): the offer's `seal` is the FROZEN booking hash — it must
// not change after booking (the on-chain request_hash sealed it). But the arc needs POST-booking events —
// a revision, a reveal + the accepted declaration, a buyer acknowledgement ( T4). Each is
// its OWN sealed record pointing at the booking by requestId, kept in order. Together they are the agent's
// EVIDENCE BUNDLE ( dispute path #1): proof-of-introduction (the booking tx itself, anchored on-chain at
// `offer.at`) + the non-circumvention declaration the developer accepted + the full revision history.
// PRIVACY: server-side; holds the declaration text + revision diffs, never on-chain. The booking's
// on-chain request_hash is the only anchor; these events reference it by the opaque requestId.

import { promises as fs } from "fs";
import path from "path";
import { sealRecord, digest, type Seal } from "./seal";

const EVENT_DOMAIN = "vrx-buyer-event";

/** The kinds of sealed act that can happen to a booked buyer after booking. */
export type BuyerEventKind =
  | "introduction" // the booking itself (recorded once, mirrors the on-chain open_claim anchor)
  | "revision" // the agent amended the attached buyer — carries the field-level diff
  | "declaration" // the developer accepted the non-circumvention undertaking to reveal
  | "reveal" // the buyer identity was unlocked to the developer (any trigger)
  | "buyer-ack" // the buyer self-acknowledged the introduction
  | "confirmed" // the developer confirmed the deposit → closed the unit on-chain (the SALE anchor)
  | "contract_final" // developer marked the S&P READY TO SIGN (full identity disclosed)
  | "payment_arrived" // developer marked the on-contract payment received — the online-signing VALIDITY gate
  | "contract_signed"; // the S&P was executed (signed) — signing act lands with the wallet arc

export type BuyerEvent = {
  /** Opaque id (store key). */
  id: string;
  /** The booking this event belongs to (the opaque on-chain requestId). */
  requestId: string;
  kind: BuyerEventKind;
  /** The actor account that performed the act (agent / developer / buyer). */
  by: string;
  /** Human-readable plaintext of what happened (the declaration text, the diff summary, etc.). */
  detail: string;
  /** Optional structured payload (e.g. a revision's {field, from, to}[], or the trigger code). */
  data?: Record<string, unknown>;
  /** The salted seal of {requestId,kind,by,detail,data,at} — tamper-evident. */
  seal: Seal;
  /** ms epoch. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "buyer-events.json");

async function readAll(): Promise<BuyerEvent[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BuyerEvent[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: BuyerEvent[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as activity.ts/events.ts. Without
// this, two concurrent appends both readAll the old list and the second writeAll drops the first's event.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: BuyerEvent[]) => { next: BuyerEvent[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/** Append a sealed event to a booking's trail. Returns the stored event. */
export async function appendBuyerEvent(
  requestId: string,
  kind: BuyerEventKind,
  by: string,
  detail: string,
  data?: Record<string, unknown>
): Promise<BuyerEvent> {
  const at = Date.now();
  const id = `bev-${at}-${Math.random().toString(36).slice(2, 8)}`;
  const body: Record<string, unknown> = { requestId, kind, by, detail, at };
  if (data) body.data = data;
  const seal = sealRecord(body, EVENT_DOMAIN);
  const ev: BuyerEvent = { id, requestId, kind, by, detail, ...(data ? { data } : {}), seal, at };
  return mutate((list) => ({ next: [...list, ev], ret: ev }));
}

/** The full ordered trail for one booking (oldest first — the chronology IS the evidence). */
export async function eventsForBooking(requestId: string): Promise<BuyerEvent[]> {
  const id = requestId.trim();
  return (await readAll()).filter((e) => e.requestId === id).sort((a, b) => a.at - b.at);
}

/** Re-verify one event's seal (the ✓ check for the evidence bundle) — re-hash the body with its salt. */
export function verifyBuyerEvent(e: BuyerEvent): boolean {
  try {
    if (!e.seal?.salt || !e.seal?.hash) return false;
    const body: Record<string, unknown> = { requestId: e.requestId, kind: e.kind, by: e.by, detail: e.detail, at: e.at };
    if (e.data) body.data = e.data;
    return digest(body, EVENT_DOMAIN, e.seal.salt) === e.seal.hash;
  } catch {
    return false;
  }
}
