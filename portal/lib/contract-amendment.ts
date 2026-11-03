// CONTRACT AMENDMENT — SERVER-ONLY (file-backed). The sealed record that a MAJOR material change to an
// on-contract building produced an AMENDMENT to a specific buyer's LIVE contract, carrying that buyer's explicit
// DISPUTE RIGHT (Slice 3, the design docs §Slice 3; arc design the design docs
// §3 TIER-2 + §4 the S&P change clause).
//
// ── WHERE IT SITS (builds on Slice 2) ───────────────────────────────────────────────────────────────────
// Slice 2 already seals a before/after EVIDENCE record for EVERY change and notifies the affected parties. This
// slice adds the layer the taxonomy reserves for a MAJOR material change (TIER-2): for each buyer with a LIVE
// contract on the building, file an amendment that (a) references the sealed evidence (by id — the "what
// changed" proof) and the buyer's live deal (by requestId), and (b) raises an explicit `disputeRight` the buyer
// may exercise. A MINOR change still notifies + seals (Slice 2) but files NO amendment. TIER-1 governance events
// (seller-entity / director change) are NOT amendment triggers by themselves (§3 — sealed events, Slice 4).
//
// VRX anchors the amendment + the dispute RIGHT; VRX does NOT adjudicate the dispute (pt5). We record that
// the right exists and the evidence behind it; whether it is ever raised, and any OUTCOME, is never stored here.
//
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. Opaque refs only — the buyer is carried as the off-seal buyer REFERENCE + the deal requestId, the
// same reference shape lib/halt-affected uses; NO resolved identity, no PII, nothing on-chain. The per-record
// salt lives next to the record and never leaves the server. Serialized writes (lost-write guard).

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";
import type { ChangeClass } from "./dev-edit-policy";

const AMENDMENT_DOMAIN = "vrx-contract-amendment";

/** One sealed amendment to a buyer's live contract, raised by a MAJOR material change to the building. */
export type ContractAmendment = {
  /** Stable unique id (store key). */
  id: string;
  /** The buyer's live-deal request id — the join key to their offer/contract (lib/offers). */
  requestId: string;
  /** The building whose change triggered the amendment (opaque catalog id). */
  building: string;
  /** The change class that triggered it (the material tier — physical | fees | land). */
  changeClass: ChangeClass;
  /** The sealed before/after evidence this amendment rests on (lib/change-evidence id) — the "what changed"
   *  proof. Empty only if evidence sealing failed (recorded as a best-effort link, never a blocker). */
  evidenceId: string;
  /** The buyer REFERENCE the live deal attached (off-seal display id/account), or "" if the deal names none.
 * NOT a resolved identity — a consumer that may show the buyer applies the mask. */
  buyerRef: string;
  /** The developer whose change it was, lowercased (audit/attribution; "" on the no-`by` path). */
  developer: string;
  /** The buyer's explicit dispute RIGHT raised by this amendment. Always true for a filed amendment (a MAJOR
   *  change entitles the buyer to dispute, §4); stored as a field so the record is self-describing and a future
   *  rule that files a no-dispute amendment stays expressible. VRX records the right, never a dispute outcome. */
  disputeRight: boolean;
  /** Per-record secret salt (hex) for the seal. NEVER on-chain, never surfaced to the client. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify(sealed payload)) — the tamper-evident digest. */
  sealHash: string;
  /** ms epoch the amendment was filed. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "contract-amendments.json");

// Serialized writes (lost-write guard) — a change can file several amendments; guard the read-modify-write.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: ContractAmendment[]) => { next: ContractAmendment[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<ContractAmendment[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return Array.isArray(parsed) ? (parsed as ContractAmendment[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: ContractAmendment[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const lc = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** The stable sealed payload — who/what/which-deal/which-evidence/what-right/when. salt/sealHash/id are not
 *  sealed (machinery + surrogate key). Canonical via stableStringify (order-independent). */
function amendmentPayload(
  p: Pick<ContractAmendment, "requestId" | "building" | "changeClass" | "evidenceId" | "buyerRef" | "developer" | "disputeRight" | "at">
) {
  return {
    requestId: p.requestId,
    building: p.building,
    changeClass: p.changeClass,
    evidenceId: p.evidenceId,
    buyerRef: p.buyerRef,
    developer: p.developer,
    disputeRight: p.disputeRight ? 1 : 0, // a primitive the stable stringify sees unambiguously
    at: p.at,
  };
}

function seal(p: Parameters<typeof amendmentPayload>[0] & { salt: string }): string {
  return digest(amendmentPayload(p), AMENDMENT_DOMAIN, p.salt);
}

/**
 * File a sealed amendment against ONE buyer's live contract. Generates the salt + seal, persists, returns the
 * record. `disputeRight` defaults true (a MAJOR change entitles the buyer to dispute, §4). Best-effort at the
 * call site (a sealing failure must not break the developer's save), but the record itself is a governance
 * promise so the route awaits it. Refs are trimmed; accounts lowercased.
 */
export async function fileAmendment(input: {
  requestId: string;
  building: string;
  changeClass: ChangeClass;
  evidenceId: string;
  buyerRef: string;
  developer: string;
  disputeRight?: boolean;
}): Promise<ContractAmendment> {
  const at = Date.now();
  const salt = newSalt();
  const base = {
    requestId: input.requestId.trim(),
    building: input.building.trim(),
    changeClass: input.changeClass,
    evidenceId: input.evidenceId.trim(),
    buyerRef: typeof input.buyerRef === "string" ? input.buyerRef.trim() : "",
    developer: lc(input.developer),
    disputeRight: input.disputeRight !== false, // default true
    at,
  };
  const sealHash = seal({ ...base, salt });
  const rec: ContractAmendment = {
    id: `am-${at.toString(36)}-${salt.slice(0, 8)}`,
    ...base,
    salt,
    sealHash,
  };
  return mutate((list) => ({ next: [...list, rec], ret: rec }));
}

/** All amendments filed against a building, newest-first. Pure read. */
export async function amendmentsForBuilding(building: string): Promise<ContractAmendment[]> {
  const bid = building.trim();
  if (!bid) return [];
  return (await readAll()).filter((a) => a.building === bid).sort((a, b) => b.at - a.at);
}

/** All amendments on a specific buyer's live contract (by requestId), newest-first. The read a buyer's
 *  deep-view / dispute surface consumes. Pure read. */
export async function amendmentsForContract(requestId: string): Promise<ContractAmendment[]> {
  const rid = requestId.trim();
  if (!rid) return [];
  return (await readAll()).filter((a) => a.requestId === rid).sort((a, b) => b.at - a.at);
}

/** The ✓-verifiable check: re-hash the record's sealed fields with its salt and compare to its seal. */
export function verifyAmendment(a: ContractAmendment): boolean {
  try {
    if (!a?.salt || !a?.sealHash) return false;
    return seal(a) === a.sealHash;
  } catch {
    return false;
  }
}
