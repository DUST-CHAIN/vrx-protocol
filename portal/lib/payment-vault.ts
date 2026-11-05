// VRX PAYMENT VAULT — the customer→developer payment RECORD store (step 2). SERVER-ONLY,
// file-backed. the design docs §5. This is the one genuinely-NEW store the payment ledger
// needs; everything else in the arc is pure computation over it + the existing seams.
//
// ── What it holds ───────────────────────────────────────────────────────────────────────────────────────
// One PaymentRecord per logged installment the customer paid the DEVELOPER for a unit: amount, date, method,
// the settlement RAIL, optional encrypted evidence (cash photo / bank slip / QR screenshot), and — for the
// offline rail (Rail B) — the buyer's two-sided confirm/dispute state. The developer logs these; the
// variance engine (§4, later) sums them into `paidToDate` and the agency-unlock gate (lib/payment-ledger,
// step 1) reads that against the sealed `unlockPct`.
//
// ── Why its OWN store (not the KYC vault) ───────────────────────────────────────────────────────────────
// Payments are DEVELOPER-owned and keyed by UNIT — not buyer-KYC docs (agent-owned, buyer-keyed). Same
// crypto, different ownership/scope. So it REUSES the exported envelope crypto (gcmEncrypt/gcmDecrypt + the
// Tier-2 locked KEK, the reuse pattern) but keeps its own store + scope guard. One AES-256-GCM
// implementation, three ownership models now (agent-KYC / buyer-KYC / developer-payments).
//
// ── The two rails (§4b) — chosen PER installment ─────────────────────────────────────────────
//   rail "offline" (Rail B, build-now core): developer logs it manually with evidence; the BUYER then SEES
//     the entry and CONFIRMS or DISPUTES it (buyerConfirm) → a two-party attested fact; a dispute flags to
//  the deal chat. Starts "pending".
//  rail "in_app" (Rail A, design-now/build-later): the on-chain transfer IS the evidence, so
//     it is self-proving → recorded "confirmed" on create, no buyer step. (The in-app settlement path that
//     writes these doesn't exist yet — the field + semantics are here so the store is ready for it.)
//
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. Amounts + slips are B2B / PII → off-chain, encrypted at rest, NEVER on the buyer's S&P copy,
// NOTHING on-chain. At most a plaintext `contentHash` of a slip could later ride in a seal (proves it
// unaltered without revealing it) — exactly as KYC does. The public projection strips the salt and
// all crypto material + bytes. A payment record is a attested record (salt + sealHash), not a new
// primitive — the Nth consumer of lib/seal.ts, no parallel seal.
//
// ── Machine note ────────────────────────────────────────────────────────────────────────────────────────
// Any SEED `.data/payment-vault.json` must be written with the Write tool (clean UTF-8/LF) — NEVER a
// PowerShell Set-Content/here-string (BOM + CRLF breaks JSON.parse).

import { promises as fs } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { gcmEncrypt, gcmDecrypt, VaultLockedError } from "./kyc-vault";
import { getKek } from "./kyc-vault-key";
import { digest, newSalt } from "./seal";

export { VaultLockedError } from "./kyc-vault";

const DATA_DIR = path.join(process.cwd(), ".data");
const VAULT_DIR = path.join(DATA_DIR, "payment-vault"); // ciphertext evidence blobs
const STORE = path.join(DATA_DIR, "payment-vault.json"); // the record index

/** The seal domain tag for payment records (PUBLIC namespace; the SECRET is the per-record salt). */
const PAYMENT_DOMAIN = "vrx-payment";

/** How the customer paid this installment. "other" catches anything the three common cases don't. */
export type PaymentMethod = "cash" | "bank_slip" | "qr_slip" | "other";

/** Which rail settled this installment (§4b) — chosen per-payment, not per-deal. */
export type PaymentRail = "in_app" | "offline";

/** WHICH party ATTESTED this record (§5b, — the two-sided reconcile). The store now holds TWO
 *  independent attestations per deal, NOT one shared record:
 *    "received" — the DEVELOPER's record "I received $X on date D" (the legacy record; the ONLY side that
 *                 feeds `paidToDate` → the unlock gate). Developer-owned + developer-scoped, as before.
 *    "sent"     — the BUYER's (or their agent-proxy's) INDEPENDENT record "I sent $X on date D". Buyer-owned
 *                 (the scope guard flips to `buyer`). It NEVER feeds `paidToDate` — VRX does not let the
 *                 buyer's own claim move the developer's cashflow figure. It exists so the reconcile engine
 *                 (lib/payment-reconcile.ts) can COMPARE the two sides and surface a STRUCTURED discrepancy
 *                 (amount/date/method), never free-text. VRX records the variance as an attested FACT; it does
 * NOT adjudicate whose number wins (VRX facilitates + seals, does not decide disputes).
 * Absent on a legacy record → treated as "received" (every record before is a developer record). This
 *  default keeps old seals byte-identical (see sealPayload) — `side` is bound into the seal ONLY for "sent". */
export type PaymentSide = "received" | "sent";

/** Rail-B two-sided confirmation state. Rail A (in_app) is self-proving → "confirmed" on create. */
export type BuyerConfirm = "pending" | "confirmed" | "disputed";

/** Which side of the deal supplied a piece of evidence (both sides can attach their own proof). The
 *  DEVELOPER attaches the slip they hold for the funds they RECEIVED; the BUYER (or their agent as proxy)
 *  attaches the slip they hold for the funds they SENT. One payment record, up to one slip per side. */
export type EvidenceSide = "developer" | "buyer";

/** Encrypted evidence blob metadata — the exact envelope shape as KycDoc (reused crypto, own store). Holds
 *  NO plaintext and NO bare DEK: only the file IV/tag + the DEK wrapped under the root KEK. A record carries a
 * LIST of these, one per side that uploaded; each blob is its own `{recordId}-{evId}.enc` file. */
export type PaymentEvidence = {
  /** Per-evidence id — the ciphertext blob is `{recordId}-{id}.enc` (a record now holds multiple blobs). */
  id: string;
  /** Which side supplied this slip. */
  side: EvidenceSide;
  /** The account that actually uploaded it (developer, buyer, or the agent acting for the buyer). */
  uploadedBy: string;
  /** ms epoch this slip was attached. */
  at: number;
  filename: string;
  mime: string;
  /** Plaintext byte length (ciphertext is slightly larger). */
  size: number;
  /** SHA-256 of the PLAINTEXT bytes (hex) — proves this slip unaltered (bound into the record seal). */
  contentHash: string;
  /** AES-GCM IV + auth tag for the FILE (hex). */
  iv: string;
  tag: string;
  /** The DEK wrapped under the root KEK: { iv, tag, ct } all hex. Unwrap needs the KEK (never on disk). */
  wrappedDek: { iv: string; tag: string; ct: string };
};

/** A single logged payment the customer made to the developer for a unit. */
export type PaymentRecord = {
  /** Opaque record id (also the evidence ciphertext filename stem). */
  id: string;
  /** Owning developer account — the scope guard. Only this developer may read/write (except VRX-root). */
  developer: string;
  buildingId: string;
  unitId: string;
  /** Join to the offer/deal when known — ties the payment to the commission unlock (step 1). */
  requestId?: string;
  /** The buyer account, when known — lets the buyer surface (Rail B) scope to their own payments. */
  buyer?: string;
  amountUsd: number;
  /** ms epoch the payment was RECEIVED (not logged). */
  paidAt: number;
  method: PaymentMethod;
  note?: string;
  /** §4b — which rail settled this installment. */
  rail: PaymentRail;
  /** §5b — WHICH party attested this record. Absent on legacy records → "received" (the developer's
   *  record). A "sent" record is the buyer's independent attestation; only "received" feeds `paidToDate`. */
  side?: PaymentSide;
  /** §4b Rail B — the BUYER-SIDE confirmation. undefined for in_app (self-proving). "pending" on offline
 * create. The ACTOR may be the buyer OR the buyer's agent acting as proxy (: "if a customer is
   *  handled by an agent, the agent must do all things for them"). `confirmBy` records WHICH account actually
   *  acted + whether it was the buyer in person or the agent on their behalf — the audit trail of agency. */
  buyerConfirm?: BuyerConfirm;
  buyerConfirmAt?: number;
  /** WHO performed the last confirm/dispute, for the audit trail. `as` distinguishes the buyer acting for
   *  themselves from the agent/agency acting as the buyer's proxy. Absent until the first buyer-side action. */
  confirmBy?: { account: string; as: "buyer" | "agent_for_buyer"; at: number };
  /** The dispute reason when "disputed" → surfaced to the deal chat. */
  disputeNote?: string;
  /** DISPUTE SHARE (generalised from the first VRX-only grant): when a record is disputed, a party
   *  (developer or the buyer-side) may SHARE this record's evidence slip INTO the dispute and choose WHO sees
   *  it — "as the buyer wishes". Default (no share) keeps slips B2B developer↔buyer PII; a share widens the
   *  evidence-decrypt authorisation to exactly the named audiences, nothing more. `to` is the set of role
   *  audiences the sharer opened the slip to. A share is only meaningful while disputed. */
  disputeShare?: { by: string; to: Array<"vrx" | "agent" | "developer" | "buyer">; at: number };
  /** BAD-EVIDENCE / BAD-ACTOR FLAG (DESIGN-NOW, BUILD-LATER, deferred). The dog-photo case: a
   *  slip that passed upload (we can't auto-detect a dog photo vs a receipt) but is later NOTICED to be bogus.
   *  Any authorised deal party may raise it; it marks the record untrusted (drops it from the unlock %),
 * escalates to the deal chat, and is a REASON TO STOP THE DEAL — the S&P/contract should note it
   *  where relevant. The FIELD lands now so the shape is fixed; the escalation + stop-deal machinery is built
 * with the deal-lifecycle pass (see the design docs §4c +). */
  flag?: { kind: "bad_evidence" | "bad_actor"; by: string; reason?: string; at: number };
  /** BUYER'S VOLUNTARY per-record SHARE-TO-AGENT: outside a dispute, the buyer may choose to keep
   *  their agent in the loop on a specific payment — "if he feels good to". Distinct from `disputeShare` (that
   *  is dispute-escalation to several audiences). This one is the buyer electing standing agent visibility on
   *  THIS record. Combined with the stage rule below, it lets the agent see a slip even AFTER the S&P signs. */
  buyerShareToAgent?: { at: number };
  /** Encrypted evidence slips — a LIST, up to one per side (developer-side / buyer-side). Empty for a
   *  self-proving in_app transfer, or an offline payment logged without a slip yet. */
  evidence: PaymentEvidence[];
  /** spine: per-record secret salt — NEVER served, NEVER on-chain. */
  salt: string;
  /** SHA-256 over domain|salt|stableStringify(the sealed payload) — the tamper-evident shared truth. */
  sealHash: string;
  /** ms epoch created / last mutated. */
  at: number;
  updatedAt: number;
};

/** The subset of a record that is SEALED. Deliberately EXCLUDES: salt + sealHash (the seal itself),
 *  the mutable buyer-confirmation fields (a confirm/dispute happens AFTER the developer's attestation and
 *  must not invalidate it), the crypto IV/tag/wrappedDek (rotatable without re-sealing), and the volatile
 *  `updatedAt`. It INCLUDES the evidence `contentHash` (so the sealed fact binds the slip's bytes) — exactly
 *  the KYC discipline: seal the content hash, never the cipher material. This is the developer's attestation:
 *  "I received $X on date D for unit U, by method M, on rail R (with this evidence)." */
export type PaymentSealInput = {
  developer: string;
  buildingId: string;
  unitId: string;
  requestId?: string;
  buyer?: string;
  amountUsd: number;
  paidAt: number;
  method: PaymentMethod;
  note?: string;
  rail: PaymentRail;
  /** The DEVELOPER-SIDE slip's contentHash only. The seal is the DEVELOPER's attestation ("I received $X with
   *  THIS slip"); binding only their own slip means a BUYER later attaching their side's proof does NOT
   *  invalidate the developer's seal (verifyPayment stays stable). Each buyer-side slip is independently
   *  tamper-proofed by its own contentHash + the GCM auth tag at decrypt — it doesn't need the record seal. */
  evidenceHash?: string;
  /** §5b — bound into the seal ONLY for a "sent" record, so a buyer's attestation can't be silently
   *  reclassified as a developer "received" record (which would move `paidToDate`). Omitted for "received" so
   *  every legacy seal re-verifies byte-identically (a received record's sealed payload is unchanged). */
  side?: PaymentSide;
  at: number;
};

/** Build the canonical seal payload from a record (stable across reads — same fields, same order via the
 *  sorted-key stableStringify inside digest). Optional fields are OMITTED when absent so a record without,
 *  say, a requestId hashes stably (never `undefined` vs missing divergence). */
function sealPayload(r: PaymentRecord): PaymentSealInput {
  const p: PaymentSealInput = {
    developer: r.developer,
    buildingId: r.buildingId,
    unitId: r.unitId,
    amountUsd: r.amountUsd,
    paidAt: r.paidAt,
    method: r.method,
    rail: r.rail,
    at: r.at,
  };
  if (r.requestId) p.requestId = r.requestId;
  if (r.buyer) p.buyer = r.buyer;
  if (r.note) p.note = r.note;
  // Bind `side` into the seal ONLY for a "sent" (buyer) record — see PaymentSealInput.side. A "received"
  // record omits it so legacy seals re-verify byte-identically; a "sent" record commits to its own side.
  if (r.side === "sent") p.side = "sent";
  // Bind ONLY the developer-side slip into the seal (the developer's attestation). Buyer-side slips are
  // independently hash-proofed and must not change the developer's seal when added later.
  const devEv = r.evidence.find((e) => e.side === "developer");
  if (devEv?.contentHash) p.evidenceHash = devEv.contentHash;
  return p;
}

/** Hash a record's canonical payload with the payment domain + the record's salt → hex digest. */
export function paymentDigest(r: PaymentRecord): string {
  return digest(sealPayload(r) as unknown as Record<string, unknown>, PAYMENT_DOMAIN, r.salt);
}

/** The ✓ Vetted check: the stored plaintext + salt re-hash to the stored sealHash. false = tampered/lost-salt. */
export function verifyPayment(r: PaymentRecord): boolean {
  if (!r.salt || !r.sealHash) return false;
  return paymentDigest(r) === r.sealHash;
}

// ── Store IO (mirrors kyc-vault.ts: serialized via a promise chain so concurrent writes can't clobber) ──

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: PaymentRecord[]) => Promise<{ next: PaymentRecord[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<PaymentRecord[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // §5b — backfill `side` so every record downstream has a defined side. A legacy record (written
    // before) has no `side` and is the DEVELOPER's record → "received". This never re-seals (the seal
    // omits `side` for "received", so the backfilled default matches the sealed payload exactly).
    return (parsed as PaymentRecord[]).map((r) => (r.side ? r : { ...r, side: "received" as const }));
  } catch {
    return [];
  }
}

async function writeAll(list: PaymentRecord[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const lc = (s: string) => s.trim().toLowerCase();

// ── Evidence envelope helper (shared by logPayment + addEvidence) ───────────────────────────────────────

/** A slip file to attach, plus which side supplied it + who uploaded it. */
export type EvidenceUpload = { bytes: Buffer; filename: string; mime: string; side: EvidenceSide; uploadedBy: string };

/** Encrypt one slip into the vault: random DEK → AES-GCM the bytes → wrap the DEK under the KEK → write the
 *  ciphertext blob `{recordId}-{evId}.enc` → return the metadata. Throws VaultLockedError if the vault is
 *  locked (no KEK). The caller attaches the returned metadata to the record's evidence list. */
async function encryptEvidence(recordId: string, up: EvidenceUpload): Promise<PaymentEvidence> {
  const evId = `ev-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const dek = randomBytes(32);
  const kek = await getKek(); // VaultLockedError → route 503
  const fileEnc = gcmEncrypt(up.bytes, dek);
  const dekWrap = gcmEncrypt(dek, kek);
  const contentHash = createHash("sha256").update(up.bytes).digest("hex");
  await fs.mkdir(VAULT_DIR, { recursive: true });
  await fs.writeFile(path.join(VAULT_DIR, `${recordId}-${evId}.enc`), fileEnc.ct);
  return {
    id: evId,
    side: up.side,
    uploadedBy: up.uploadedBy.trim(),
    at: Date.now(),
    filename: up.filename.slice(0, 200),
    mime: up.mime,
    size: up.bytes.length,
    contentHash,
    iv: fileEnc.iv,
    tag: fileEnc.tag,
    wrappedDek: { iv: dekWrap.iv, tag: dekWrap.tag, ct: dekWrap.ct.toString("hex") },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────────

/** Input to log a payment. `developer` is the authenticated owner; the route supplies it (not the client). */
export type LogPaymentInput = {
  developer: string;
  buildingId: string;
  unitId: string;
  requestId?: string;
  buyer?: string;
  amountUsd: number;
  paidAt: number;
  method: PaymentMethod;
  note?: string;
  rail: PaymentRail;
  /** Optional DEVELOPER-SIDE evidence file to encrypt + attach at log time (the developer's own slip). */
  evidence?: { bytes: Buffer; filename: string; mime: string };
};

/** Valid USD amount for a logged payment: a finite number > 0. Rejects 0/NaN/negative (never seal a nonsense). */
export function isValidAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Log a customer→developer payment (developer-scoped). Does the full evidence envelope when a file is
 * given: random DEK → AES-GCM the bytes → wrap the DEK under the KEK → write the ciphertext blob + the
 * record. Seals the record (salt + sealHash) so it's a ✓ Vetted attested fact. Offline rail → buyerConfirm
 * "pending" (the buyer confirms/disputes later); in_app → "confirmed" (self-proving).
 *
 * Throws VaultLockedError (→ route 503) if evidence is supplied while the vault is locked. A payment with NO
 * evidence does not need the KEK, so it can be logged even when locked (the amount/date are not encrypted —
 * only the slip image is; the record is still sealed for tamper-evidence).
 */
export async function logPayment(inp: LogPaymentInput): Promise<PaymentRecord> {
  if (!lc(inp.developer)) throw new Error("developer required");
  if (!inp.buildingId?.trim() || !inp.unitId?.trim()) throw new Error("buildingId + unitId required");
  if (!isValidAmount(inp.amountUsd)) throw new Error("amountUsd must be a positive number");

  const id = `pay-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const evidence: PaymentEvidence[] = [];

  // The developer's own slip (developer-side) attached at log time, if any. Buyer-side slips arrive later via
  // addEvidence. A payment with no slip still logs (and needs no KEK → works even when the vault is locked).
  if (inp.evidence) {
    evidence.push(await encryptEvidence(id, { ...inp.evidence, side: "developer", uploadedBy: inp.developer.trim() }));
  }

  const now = Date.now();
  // Build the record WITHOUT the seal first, then seal it (the seal is over the plaintext + salt).
  const rec: PaymentRecord = {
    id,
    developer: inp.developer.trim(),
    buildingId: inp.buildingId.trim(),
    unitId: inp.unitId.trim(),
    requestId: inp.requestId?.trim() || undefined,
    buyer: inp.buyer?.trim() || undefined,
    amountUsd: inp.amountUsd,
    paidAt: inp.paidAt,
    method: inp.method,
    note: inp.note?.trim() || undefined,
    rail: inp.rail,
    side: "received", // §5b — the developer's "received" record (the legacy default, made explicit)
    // Rail A is self-proving → confirmed on create; Rail B awaits the buyer.
    buyerConfirm: inp.rail === "in_app" ? "confirmed" : "pending",
    buyerConfirmAt: inp.rail === "in_app" ? now : undefined,
    evidence,
    salt: newSalt(),
    sealHash: "", // filled next
    at: now,
    updatedAt: now,
  };
  rec.sealHash = paymentDigest(rec);

  return mutate(async (list) => ({ next: [...list, rec], ret: rec }));
}


/** Input for a BUYER-side "payment-sent" attestation (§5b). Owned by the BUYER; the actor may be the
 *  buyer in person or their agent acting as proxy (`attestedBy.as`). It carries the developer/building/unit so
 *  the reconcile engine can pair it to the developer's "received" record for the same unit+deal. No `rail`
 *  (a buyer attestation is inherently the offline rail — in-app transfers are self-proving and need none) and
 *  no `buyerConfirm` (a party does not "confirm" its own claim). */
export type LogSentPaymentInput = {
  /** The developer the buyer says they paid — the counterparty, NOT the owner. Used for reconcile pairing. */
  developer: string;
  buildingId: string;
  unitId: string;
  requestId?: string;
  /** The buyer account — the OWNER + scope guard of a "sent" record. Required. */
  buyer: string;
  amountUsd: number;
  /** ms epoch the buyer says the payment was SENT. */
  paidAt: number;
  method: PaymentMethod;
  note?: string;
  /** WHO attested — the buyer themselves or their agent as proxy (audit trail of agency, mirrors confirmBy). */
  attestedBy: { account: string; as: "buyer" | "agent_for_buyer" };
  /** Optional BUYER-SIDE evidence (the buyer's own slip for funds SENT) to encrypt + attach at log time. */
  evidence?: { bytes: Buffer; filename: string; mime: string };
};

/**
 * Log a BUYER-side "payment-sent" attestation (§5b, — the two-sided reconcile). This is the second
 * ownership model the design parked: the buyer (or their agent proxy) records, INDEPENDENTLY of the developer,
 * "I sent $X on date D". It is a attested record on the SAME spine/store (no parallel store — §6) with
 * `side: "sent"`, owned + scope-guarded by the BUYER. It NEVER feeds `paidToDate` (the developer's "received"
 * figure stays the unlock basis — VRX doesn't let a buyer's own claim move the developer's cashflow). The
 * reconcile engine (lib/payment-reconcile.ts) pairs it to the developer's received record and surfaces a
 * STRUCTURED discrepancy; VRX records the variance as a fact, it does not adjudicate.
 */
export async function logSentPayment(inp: LogSentPaymentInput): Promise<PaymentRecord> {
  if (!lc(inp.buyer)) throw new Error("buyer required");
  if (!lc(inp.developer)) throw new Error("developer required");
  if (!inp.buildingId?.trim() || !inp.unitId?.trim()) throw new Error("buildingId + unitId required");
  if (!isValidAmount(inp.amountUsd)) throw new Error("amountUsd must be a positive number");

  const id = `pay-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const evidence: PaymentEvidence[] = [];
  // The buyer's own slip (buyer-side) attached at log time, if any. Encrypts under the same envelope; needs
  // the KEK only when a slip is present (a slip-less attestation logs even when the vault is locked).
  if (inp.evidence) {
    evidence.push(
      await encryptEvidence(id, { ...inp.evidence, side: "buyer", uploadedBy: inp.attestedBy.account.trim() })
    );
  }

  const now = Date.now();
  const rec: PaymentRecord = {
    id,
    developer: inp.developer.trim(),
    buildingId: inp.buildingId.trim(),
    unitId: inp.unitId.trim(),
    requestId: inp.requestId?.trim() || undefined,
    buyer: inp.buyer.trim(),
    amountUsd: inp.amountUsd,
    paidAt: inp.paidAt,
    method: inp.method,
    note: inp.note?.trim() || undefined,
    // A buyer attestation is inherently the offline rail (in-app is self-proving). `buyerConfirm` is left
    // undefined — a party does not confirm its own claim; confirmation is a DEVELOPER-record (received) concept.
    rail: "offline",
    side: "sent",
    confirmBy: { account: inp.attestedBy.account.trim(), as: inp.attestedBy.as, at: now },
    evidence,
    salt: newSalt(),
    sealHash: "", // filled next
    at: now,
    updatedAt: now,
  };
  rec.sealHash = paymentDigest(rec);

  return mutate(async (list) => ({ next: [...list, rec], ret: rec }));
}

/** Every payment the given developer logged, newest-paid first. Developer-scoped (the owner only). */
export async function paymentsForDeveloper(developer: string): Promise<PaymentRecord[]> {
  const d = lc(developer);
  // §5b — the developer owns only "received" records; a buyer "sent" record names this developer as
  // the counterparty but must never surface in the developer's own list (that's reconcile territory).
  return (await readAll())
    .filter((r) => lc(r.developer) === d && (r.side ?? "received") === "received")
    .sort((a, b) => b.paidAt - a.paidAt);
}

/** Every payment logged against one unit, for this developer. The variance engine (§4) sums these. */
export async function paymentsForUnit(developer: string, buildingId: string, unitId: string): Promise<PaymentRecord[]> {
  const d = lc(developer);
  const b = buildingId.trim();
  const u = unitId.trim();
  // §5b — developer-scoped → "received" only (a buyer "sent" record names this developer but isn't
  // the developer's own payment; it belongs to the reconcile view, not the developer's logged-payments list).
  return (await readAll())
    .filter((r) => lc(r.developer) === d && r.buildingId === b && r.unitId === u && (r.side ?? "received") === "received")
    .sort((a, b2) => b2.paidAt - a.paidAt);
}

/** Every payment tied to one deal (requestId), for this developer. Ties payments → the commission unlock. */
export async function paymentsForRequest(developer: string, requestId: string): Promise<PaymentRecord[]> {
  const d = lc(developer);
  const q = requestId.trim();
  return (await readAll())
    // §5b — developer-scoped view = the developer's OWN "received" records only. A buyer "sent" record
    // also names this developer (as the counterparty), so it would leak in without the side guard. The
    // developer reads the two-sided picture via the reconcile engine over paymentsForDeal, not here.
    .filter((r) => lc(r.developer) === d && r.requestId === q && (r.side ?? "received") === "received")
    .sort((a, b) => b.paidAt - a.paidAt);
}


/**
 * §5b — ALL records (BOTH sides) for a deal, for the reconcile engine. Unlike `paymentsForRequest`
 * (developer-scoped, received only), this returns the developer's "received" records AND the buyer's "sent"
 * attestations for the same `requestId`, so lib/payment-reconcile can pair them. It is NOT a role-scoped read
 * — the authorizing route decides who may see the reconciliation (developer, buyer, VRX-root); this is the
 * raw material. Sorted newest-first by paidAt.
 */
export async function paymentsForDeal(requestId: string): Promise<PaymentRecord[]> {
  const q = requestId.trim();
  if (!q) return [];
  return (await readAll()).filter((r) => r.requestId === q).sort((a, b) => b.paidAt - a.paidAt);
}

/** Payments the given BUYER can see — their OWN, across developers. For the Rail-B confirm/dispute surface
 *  (§7). Only offline-rail entries are the buyer's to act on; in_app are self-proving (surfaced, read-only).
 *  Scoped to the buyer account — never leaks another buyer's payments. */
export async function paymentsForBuyer(
  buyer: string,
  // §5b — which side's records to return for this buyer. Default "received" = the DEVELOPER's records
  // recorded AGAINST this buyer (the existing confirm/dispute surface — unchanged behaviour). "sent" = the
  // buyer's OWN attestations; "all" = both (for a combined reconcile view).
  side: PaymentSide | "all" = "received"
): Promise<PaymentRecord[]> {
  const b = lc(buyer);
  return (await readAll())
    .filter((r) => r.buyer && lc(r.buyer) === b && (side === "all" || (r.side ?? "received") === side))
    .sort((a, b2) => b2.paidAt - a.paidAt);
}

/**
 * Apply a BUYER-SIDE confirm/dispute to an offline payment (Rail B two-sided fact, §4b). The actor may be the
 * BUYER in person OR the buyer's AGENT acting as proxy (the agent does everything for a customer
 * they handle). **Authorization is the CALLER's job** (the route resolves deal role via lib/participant +
 * matches the named buyer) — exactly the posture of logPayment trusting `developer`. This records WHO acted
 * (`confirmBy`) + whether as buyer or agent-for-buyer. in_app records are self-proving → no-op (nothing to
 * confirm). Does NOT re-seal: the seal is the DEVELOPER's attestation of amount/date/method; the buyer-side
 * confirmation is a separate mutable layer, so verifyPayment keeps passing after a confirm or dispute.
 */
export async function setBuyerConfirm(
  recordId: string,
  decision: "confirmed" | "disputed",
  actor: { account: string; as: "buyer" | "agent_for_buyer" },
  disputeNote?: string
): Promise<PaymentRecord | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === recordId);
    if (idx < 0) return { next: list, ret: null };
    const r = list[idx];
    if (r.rail === "in_app") return { next: list, ret: r }; // self-proving — nothing to confirm; no-op
    const now = Date.now();
    const next = list.slice();
    next[idx] = {
      ...r,
      buyerConfirm: decision,
      buyerConfirmAt: now,
      confirmBy: { account: actor.account.trim(), as: actor.as, at: now },
      disputeNote: decision === "disputed" ? disputeNote?.trim() || undefined : undefined,
      updatedAt: now,
    };
    return { next, ret: next[idx] };
  });
}

/**
 * SHARE a disputed record's evidence INTO the dispute (generalises the first VRX-only grant). A
 * party (the owning developer or the buyer-side) opens the slip to a chosen set of role AUDIENCES — "as the
 * buyer wishes". Only meaningful while the record is disputed; authorization (is the sharer a party?) is the
 * CALLER's job via lib/participant. Does NOT re-seal (mutable layer). Idempotent — re-sharing refreshes it.
 */
export async function setDisputeShare(
  recordId: string,
  by: string,
  to: Array<"vrx" | "agent" | "developer" | "buyer">
): Promise<PaymentRecord | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === recordId);
    if (idx < 0) return { next: list, ret: null };
    const r = list[idx];
    const next = list.slice();
    next[idx] = { ...r, disputeShare: { by: by.trim(), to, at: Date.now() }, updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/**
 * RAISE a bad-evidence / bad-actor FLAG on a record (the dog-photo case). DESIGN-NOW: the field
 * + this setter land so the shape is fixed and a flag is persistable; the escalation + stop-deal machinery is
 * built with the deal-lifecycle pass. Authorization (is the flagger a deal party?) is the CALLER's job. A
 * flagged record is marked untrusted — `paidToDate(confirmedOnly)` below drops it from the unlock %. Does NOT
 * re-seal (the developer's attestation of the facts is unchanged; the flag is an allegation layered on top).
 */
export async function flagPayment(
  recordId: string,
  kind: "bad_evidence" | "bad_actor",
  by: string,
  reason?: string
): Promise<PaymentRecord | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === recordId);
    if (idx < 0) return { next: list, ret: null };
    const r = list[idx];
    const next = list.slice();
    next[idx] = { ...r, flag: { kind, by: by.trim(), reason: reason?.trim() || undefined, at: Date.now() }, updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/**
 * ATTACH a slip to an existing payment record (both sides can upload their own proof). The
 * developer attaches their received-funds slip (side "developer"); the buyer or their agent-proxy attaches
 * the sent-funds slip (side "buyer"). Authorization (is the uploader the right side?) is the CALLER's job via
 * lib/participant. At most ONE slip per side — a re-upload REPLACES that side's slip (old blob unlinked). Only
 * the developer-side slip is bound into the record seal; a buyer-side add therefore does NOT re-seal (the
 * developer's attestation is untouched). Throws VaultLockedError (→ 503) if the vault is locked.
 */
export async function addEvidence(recordId: string, up: EvidenceUpload): Promise<PaymentRecord | null> {
  const rec = await getPayment(recordId);
  if (!rec) return null;
  const ev = await encryptEvidence(recordId, up); // may throw VaultLockedError — before we mutate
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === recordId);
    if (idx < 0) return { next: list, ret: null };
    const r = list[idx];
    // Replace any existing slip on the same side (unlink its blob), then append the new one.
    const prior = r.evidence.find((e) => e.side === up.side);
    if (prior) {
      try { await fs.unlink(path.join(VAULT_DIR, `${recordId}-${prior.id}.enc`)); } catch { /* gone — fine */ }
    }
    const evidence = [...r.evidence.filter((e) => e.side !== up.side), ev];
    const next = list.slice();
    // Re-seal ONLY if the developer-side slip changed (it's part of the developer's attestation). A buyer-side
    // add leaves the seal as-is (verifyPayment stays stable). We recompute the seal from the new evidence list.
    const updated: PaymentRecord = { ...r, evidence, updatedAt: Date.now() };
    if (up.side === "developer") updated.sealHash = paymentDigest(updated);
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/**
 * The BUYER elects to keep their AGENT in the loop on THIS payment — a voluntary, standing
 * per-record share, distinct from the dispute share. Combined with the stage rule (the agent's standing view
 * expires when the S&P signs), this lets the buyer re-open a specific slip to their agent even after signing.
 * Authorization (is the caller the named buyer / their agent?) is the CALLER's job. Does NOT re-seal.
 */
export async function setBuyerShareToAgent(recordId: string, on: boolean): Promise<PaymentRecord | null> {
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === recordId);
    if (idx < 0) return { next: list, ret: null };
    const r = list[idx];
    const next = list.slice();
    next[idx] = { ...r, buyerShareToAgent: on ? { at: Date.now() } : undefined, updatedAt: Date.now() };
    return { next, ret: next[idx] };
  });
}

/**
 * May the given ROLE audience decrypt this record's slip? Standing viewers are the OWNING DEVELOPER and the
 * NAMED BUYER (+ the buyer's agent as their proxy — resolved by the route, not here). Any OTHER audience
 * (vrx / agent / agency) sees the slip ONLY when the record is DISPUTED and a party has SHARED it to that
 * audience. This is the per-record condition; the route still applies its own role resolution +
 * (for vrx) the operator gate ON TOP. Amounts/slips are otherwise B2B developer↔buyer PII.
 */
export function sharedTo(r: PaymentRecord, audience: "vrx" | "agent" | "developer" | "buyer"): boolean {
  return r.buyerConfirm === "disputed" && !!r.disputeShare && r.disputeShare.to.includes(audience);
}

/** Load one record by id (SERVER-ONLY) — the route uses it to run the per-reader authorization checks
 *  (owning developer / named buyer / buyer's agent / dispute-shared audience) before decryptEvidence. */
export async function getPayment(recordId: string): Promise<PaymentRecord | null> {
  return (await readAll()).find((r) => r.id === recordId) ?? null;
}

/** Delete a payment the developer logged (developer-scoped) — removes the record + ALL its evidence blobs. */
export async function deletePayment(recordId: string, developer: string): Promise<boolean> {
  const d = lc(developer);
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.id === recordId);
    if (idx < 0) return { next: list, ret: false };
    if (lc(list[idx].developer) !== d) return { next: list, ret: false }; // not this developer's — no-op
    for (const ev of list[idx].evidence) {
      try {
        await fs.unlink(path.join(VAULT_DIR, `${recordId}-${ev.id}.enc`));
      } catch {
        /* blob already gone — fine */
      }
    }
    return { next: list.filter((r) => r.id !== recordId), ret: true };
  });
}

/**
 * DECRYPT ONE evidence slip's plaintext bytes (by its evidence id). SERVER-ONLY; the route authorizes the
 * reader. Unwraps the DEK with the KEK, then decrypts the blob. null if the record/slip/blob is missing or the
 * KEK can't unwrap (wrong KEK / tampered → GCM auth fails loudly, never a silent wrong-plaintext). Locked vault
 * → null (fail-closed read). `evidenceId` omitted → the FIRST slip (back-compat convenience for single-slip reads).
 */
export async function decryptEvidence(
  recordId: string,
  evidenceId?: string
): Promise<{ bytes: Buffer; mime: string; filename: string } | null> {
  const rec = (await readAll()).find((r) => r.id === recordId);
  if (!rec || rec.evidence.length === 0) return null;
  const ev = evidenceId ? rec.evidence.find((e) => e.id === evidenceId) : rec.evidence[0];
  if (!ev) return null;
  try {
    const kek = await getKek();
    const dek = gcmDecrypt(Buffer.from(ev.wrappedDek.ct, "hex"), kek, ev.wrappedDek.iv, ev.wrappedDek.tag);
    const ct = await fs.readFile(path.join(VAULT_DIR, `${recordId}-${ev.id}.enc`));
    const bytes = gcmDecrypt(ct, dek, ev.iv, ev.tag);
    return { bytes, mime: ev.mime, filename: ev.filename };
  } catch {
    return null;
  }
}

// ── Public projections (what leaves the server) ─────────────────────────────────────────────────────────

/** Evidence metadata safe to send to an authorized client — NO crypto material, NO bytes. Just the facts a
 *  slip card shows: id (to fetch the bytes), which side, who/when, filename + the non-secret contentHash. */
export function evidenceMeta(e: PaymentEvidence) {
  return { id: e.id, side: e.side, uploadedBy: e.uploadedBy, at: e.at, filename: e.filename, mime: e.mime, size: e.size, contentHash: e.contentHash };
}

/** The public shape of a payment record: full record MINUS the secret salt and the evidence crypto
 *  material, PLUS the ✓ Vetted re-hash result + the per-slip metadata LIST. The ONLY shape a route returns. */
export type PublicPayment = Omit<PaymentRecord, "salt" | "evidence"> & {
  verified: boolean;
  evidence: ReturnType<typeof evidenceMeta>[];
};

export function publicPayment(r: PaymentRecord): PublicPayment {
  const { salt: _salt, evidence, ...rest } = r;
  void _salt;
  return {
    ...rest,
    verified: verifyPayment(r),
    evidence: evidence.map(evidenceMeta),
  };
}

/** Σ of paid USD for a set of records. The variance engine's `paidToDate` input (step 3). `confirmedOnly`
 *  (default false) counts a payment toward the total regardless of buyer confirmation (the developer's own
 *  view); pass true for the agency-unlock gate's safe default (count only buyer-confirmed + self-proving). */
export function paidToDate(records: PaymentRecord[], confirmedOnly = false): number {
  return records
    .filter((r) => {
      // §5b — a buyer's "sent" attestation is its OWN claim; it NEVER feeds the developer's paidToDate
      // (which drives the unlock gate + cashflow). Only the developer's "received" records count here. Legacy
      // records (no `side`) are developer records (readAll backfills "received"), so an un-backfilled list is
      // still safe: we only EXCLUDE an explicit "sent".
      if (r.side === "sent") return false;
      // A flagged record (bad_evidence / bad_actor) is untrusted — it NEVER counts toward the
      // confirmed sum that unlocks the agency commission, even if it was buyer-confirmed before the flag.
      if (confirmedOnly && r.flag) return false;
      return !confirmedOnly || r.rail === "in_app" || r.buyerConfirm === "confirmed";
    })
    .reduce((s, r) => s + r.amountUsd, 0);
}
