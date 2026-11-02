// Off-chain OFFER registry — SERVER-ONLY (file-backed). The first consumer of the "Attested
// THE PROBLEM THIS SOLVES (the crux of the whole spine): when an agent opens a booking, the plaintext
// offer — payment plan, free-text terms, buyer/ownership type — is hashed into the opaque on-chain
// `request_hash` and then THROWN AWAY. The chain holds a tamper-proof SEAL of the offer that nobody
// can READ. So the developer's inbox cannot show "what the buyer offered". We fix that here by keeping
// the plaintext off-chain, keyed by the SAME opaque `requestId` the chain already holds.
// THE ATTESTED-RECORD PATTERN: plaintext lives off-chain in the party's own store; the chain holds
// only its HASH as a seal. Anyone with the plaintext can RE-HASH it and prove it matches the on-chain
// `request_hash` → a ✓ VETTED "verified, unaltered since signing" seal (or a loud red mismatch = a fraud
// tripwire). We keep the canonical hash-input fields VERBATIM (`terms`/`plan`/`ownership`/`freehold`/
// `by`) so the re-hash reconstructs EXACTLY what the agent hashed in app/agent/page.tsx (domain
// "vrx-terms"); display extras (building/unit ids, labels) ride alongside but are NOT part of the seal.
// Same file-backed.data pattern as gates.ts / offmarket.ts. The real architecture keeps each
// party's records on their own node; this.data store is the demo stand-in. The pattern does not change
// when it distributes — the seal is the shared truth, the plaintext each party's private copy.
// PRIVACY: this store is SERVER-SIDE ONLY and holds the plaintext deliberately (it is the party's
// private copy). It must never be exposed to a party who isn't on the deal. The chain still carries only
// the opaque hash.

import { promises as fs } from "fs";
import path from "path";

/**
 * The CANONICAL hash-inputs — these five fields, in this shape, are exactly what the agent passes to
 * hashRef(payload, "vrx-terms") when building the on-chain request_hash (app/agent/page.tsx). To verify,
 * reconstruct this object and re-hash with the same domain + stableStringify. `ownership`/`freehold` are
 * OMITTED (undefined) for a non-quota building — matching the agent, where JSON.stringify drops undefined.
 */
export type OfferSeal = {
  terms: string;
  plan: unknown | null;
  ownership?: string;
  freehold?: boolean;
  /**
   * seam — the attested buyer snapshot. OPTIONAL and omitted (undefined) today, so it doesn't change
   * the digest for the current flow (JSON.stringify drops undefined). The future buyer-roster arc fills
   * this with whatever buyer detail exists at booking time (may be minimal, per the developer's stage
   * policy). When present it is part of the seal, so the developer's re-hash verifies it too.
   */
  buyer?: unknown;
  /**
   * seam — the agent's per-field MASK choice for the buyer snapshot (BuyerMask: field → show|partial|
   * hide). Folded into the seal so the mask-at-booking is tamper-evident ("what was shown when" survives a
   * dispute). OPTIONAL and omitted when no buyer/mask, so it doesn't change the digest for offers
   * without a masked buyer (JSON.stringify drops undefined). When present it is part of the on-chain seal.
   * NB: masking is enforced SERVER-SIDE (lib/offers publicSeal / app/api/offers) — this field only RECORDS
   * the choice; the developer never receives withheld plaintext regardless of what this says.
   */
  buyerMask?: unknown;
  by: string;
};

/**
 * The off-seal UNLOCK control plane — NOT part of the hash (it's post-booking state, like
 * `display`). Tracks whether the buyer's sealed detail has been REVEALED to the developer yet, and the
 * witnessed ACT that did it: a reveal is a consented, consequential act, never a silent flip).
 * While `revealed` is false the server ships only the masked public view; once true it ships full detail.
 */
export type OfferUnlock = {
  /** true once the sealed buyer detail is unlocked to the developer. Default/absent = still masked. */
  revealed: boolean;
  /** ms epoch the reveal fired. */
  at?: number;
  /** Which trigger fired: T1 dev-reveal+declaration · T2 agent-reveal · T4 buyer-ack · token/cash. */
  trigger?: "T1-dev" | "T2-agent" | "T4-buyer" | "rail-token" | "rail-cash";
  /** The account that performed the reveal act (for the audit trail / evidence bundle). */
  by?: string;
  /** Sealed hash of the non-circumvention declaration the developer accepted ( trigger T1). */
  declarationSeal?: string;
  /**
   * a PRE-DEPOSIT developer reveal is a REQUEST, not a unilateral flip — the developer
   * accepts the non-circumvention declaration (sealed as evidence immediately), but the identity only
   * unlocks once the AGENT approves. So the agent's masking protection is never force-broken, while the
   * developer's self-incriminating undertaking is already on record. Present + `revealed:false` = a pending
   * request awaiting the agent. Cleared/ignored once `revealed` is true (post-approval or a deposit rail).
   */
  revealRequest?: {
    /** The developer account that asked. */
    by: string;
    at: number;
    /** Sealed hash of the non-circumvention declaration they accepted when requesting. */
    declarationSeal: string;
  };
  /**
   *  (audit ENHANCE-1): the agent DECLINED a pending reveal request. Recorded explicitly on the offer's own
   * state so a later reader can distinguish "a decline happened" from "a request was never made" (previously the
   * decline wiped `unlock` back to undefined — the evidence survived on the buyer-events trail, but the offer's
   * state alone couldn't tell the two apart). `revealed` stays false (declined ≠ revealed; `isMasked` still true),
   * and NO stale `revealRequest` is kept — so the developer may ASK AGAIN after a decline (the decline is a soft
   * "not now", not a permanent bar). The sealed declaration the developer accepted still lives on the trail.
   */
  declined?: {
    /** When the decline was recorded. */
    at: number;
    /** The sealed declaration hash from the request that was declined (carried for the audit readout). */
    declarationSeal?: string;
  };
};

/** The full stored offer: the canonical seal inputs + display extras + provenance. */
export type Offer = {
  /** The opaque on-chain request id (the store key). */
  requestId: string;
  /** The opaque on-chain request_hash (the seal). Re-hashing OfferSeal must reproduce this. */
  requestHash: string;
  /** The developer (Node) the booking is against — lets the inbox fetch its offers in one call. */
  developer: string;
  /** The canonical hash-input object (verbatim, for exact re-hash). */
  seal: OfferSeal;
  /** Display extras — NOT part of the seal, safe to evolve. The inbox enriches names from the catalog. */
  display: {
    buildingId?: string;
    unitId?: string;
    buyerType?: string | null;
    /** pt-2 — the agent's roster buyer id this booking attached (lib/buyers.Buyer.id). Off-seal, NOT
     * hashed (display only): the join key that lets the developer's pre-sign gate find the buyer's encrypted
     * KYC vault (lib/kyc-vault) by requestId. Absent for a buyer-less booking or one made before this field. */
    buyerId?: string;
    /** — PROVENANCE marker (off-seal, display only, NOT hashed). `"seed"` = this booking was produced by
     * the demo backfill harness (lib/seed-funnel); ABSENT = a real/externally-driven booking (a human agent on
     * testnet). This is the seam for a future ALPHA / game mode: VRX funds real testnet users, who
     * drive LIVE deals that carry no `origin` marker, so demo history and real activity stay separable on one
     * surface — and real bug reports flow against real data. Default-absent keeps every previously record
     * byte-identical. The dashboards can later tint/filter by this without the seed ever masquerading as traction.
     *
     * — `"direct"` = this offer was MATERIALIZED from a direct-desk deal at the firm-hold moment
     * (lib/direct-offer.materializeDirectOffer), NOT booked on-chain via open_claim. Its `requestId` is a PORTAL
     * id bound to (conversationId, epoch), NOT an on-chain claim id — so a claim-only chain path (confirm_claim,
     * get_claim) must NEVER be reached with it (the design docs §3 guard). The entire
     * tailoring + S&P path reuses this offer unchanged; this marker is how a consumer tells the two kinds apart. */
    origin?: "seed" | "direct";
    /** (slice 3) — DIRECT offers only (origin="direct"). The source conversation id + the buyer's
     * wallet account, carried so the S&P assembler can (a) authorize the BUYER as a viewer of their OWN
     * paperwork (a direct offer has no agent-side participant — seal.by is the desk), and (b) resolve the
     * buyer line from the LIVE desk-entitled mask at read time (floor→dial→granted→force-show) rather than a
     * frozen snapshot, so a reveal granted AFTER materialization shows (design §5). Both are off-seal display
     * only (NOT hashed); the requestId is a one-way hash of (conversationId, epoch) so it can't recover these.
     * Absent on a booking offer. (`buyer` is a wallet account, distinct from the agent-path `buyerId` roster id.) */
    conversationId?: string;
    buyer?: string;
  };
  /** off-seal unlock state. Absent = never unlocked (still masked). Not part of the hash. */
  unlock?: OfferUnlock;
  /**
   * — off-seal CONFIRMED (sold) marker. Set once the developer confirms the deposit and closes the
   * unit on-chain (confirm_claim). Durable so the "✓ SOLD — closed on-chain" state survives a refresh:
   * the contract leaves claim.status at 1 after confirm, so this off-chain flag is
   * the only persistent signal that the booking is CLOSED. Not part of the hash. Absent = not yet confirmed.
   */
  confirmed?: {
    /** ms epoch the confirm tx succeeded. */
    at: number;
    /** The developer account that confirmed (for the audit trail / recent-sales attribution). */
    by: string;
    /**
     * — the on-chain RECEIPT: the confirm_claim tx hash. The wallet already returns it (callFunction →
     * state.tx) and TxProgress flashes it transiently; we PERSIST it here so the SoldBadge can carry a
     * permanent "closed on-chain" receipt with an explorer link (don't hide the magic). Optional: absent for
     * a booking confirmed outside this portal, or an older confirmation recorded before we captured the hash.
     */
    tx?: string;
  };
  /**
   * the S&P CONTRACT stage overlay (off-seal, like `unlock`/`confirmed`). The single source of
   * truth for where the sale document is: preview (default/absent) → final (ready to sign, full identity
   * disclosed) → payment_arrived (on-contract payment received = the online-signing VALIDITY gate) → signed.
   * Monotonic (never silently regresses; an undo is an explicit void in the cancellation arc). Not hashed.
   * See the design docs.
   */
  contract?: {
    stage: "preview" | "final" | "payment_arrived" | "signed";
    /** Developer marked the contract ready-to-sign (full name now renders). */
    finalAt?: number;
    finalBy?: string;
    /** Sealed hash of the "I have seen the buyer KYC and will use it only for this purpose" undertaking the
     * developer accepted at `final` ( pt-2 evidence; gate until the encrypted uploads exist). */
    kycAckSeal?: string;
    /** The validity gate: developer marked the on-contract payment received. Only from here is a signature binding. */
    paymentArrivedAt?: number;
    paymentArrivedBy?: string;
    /** Execution (signing act lands with the wallet arc, slice 5). */
    signedAt?: number;
  };
  /**
   * — the buyer's chosen FURNITURE pack for this booking (off-seal, like `confirmed`/`contract`). ONE
   * pack per booking. Stores only the pack id + who/when; the per-unit COST is never frozen here —
   * it's recomputed from the unit's m² at render time (lib/furniture), so a staged-area change or a
   * pack edit flows through. Absent = no furniture chosen (the S&P lists the offered packs as options only).
   */
  furniture?: {
    /** The chosen lib/furniture-packs.FurniturePack id. Must be a pack ATTACHED to this booking's building. */
    packId: string;
    at: number;
    by: string;
  };
  /**
   * — negotiation CONCESSIONS (off-seal). During negotiation the DEVELOPER can promise extras / changes
   * ("free covered parking", "upgraded kitchen worktops", "waive the first instalment") — these are binding
   * once the deal closes, so they MUST be recorded into the S&P. Editable only while the contract is at
   * `preview`; FROZEN once the developer marks it `final` (the stage guard enforces this, so the buyer signs
   * against a fixed list). Each has a free-text label + optional note + optional USD value (some concessions
   * are qualitative, some are worth money). Not part of the hash; the `final` ack seals the list ( pattern).
   */
  concessions?: OfferConcession[];
  /**
   * — per-deal TIMED TERMS (off-seal). The deal-specific time-bound commitments a buyer is ANXIOUS about
   * and wants IN THEIR OWN contract ( part 1) — distinct from the building-wide construction schedule
   * ( `instalmentMilestones` / the building `constructionTimeline`) and from undated concessions.
   * E.g. "Covered car-park handed over by March 2027", "Title transferred within 60 days of final payment",
   * "24-month rental guarantee from handover". Each is a free-text label + a free-text `when` (a date OR a
   * relative trigger — we don't force a calendar date, since many are event-relative) + optional note + a
   * `committed` flag (a binding contractual date vs an indicative projection, mirroring its `projected`).
   * Developer-authored during negotiation, editable only at `preview`, FROZEN at `final` (same stage guard as
   * concessions) so the buyer signs against a fixed list. Not part of the sealed hash; the `final` ack seals it.
   */
  timedTerms?: OfferTimedTerm[];
  /** — negotiable transfer-tax rate + buyer/seller split (off-seal, preview-editable, frozen at final). */
  tax?: OfferTax;
  /** — developer discount off the price (amount or %), off-seal, preview-editable, frozen at final. */
  discount?: OfferDiscount;
  /**
   * — maps this booking's plan INSTALMENTS onto the building's construction MILESTONES (off-plan buying:
   * "20% due at topping-out"). Key = 1-based instalment ordinal (matches the sealed plan's `instalmentCount`);
   * value = the milestone LABEL (from the building's `constructionTimeline`). A DISPLAY JOIN only — the
   * sealed plan and the building timeline are BOTH read-only; this is the one mutable off-seal link between
   * them, so neither can drift. Preview-editable, frozen at `final`. A referenced milestone that later
   * disappears just drops the tie (graceful) — never a crash. Absent = no instalment is tied to a milestone.
   */
  instalmentMilestones?: Record<string, string>;
  /**
   * per-instalment DUE-DATE OVERRIDE. Key = 1-based instalment ordinal (matches the sealed
   * plan's `instalmentCount`); value = ms epoch the desk/admin pinned for that instalment (the buyer wanted a
   * specific date, or a holiday/weekend roll). Sparse: only overridden ordinals appear; every other instalment
   * falls back to the auto-interval default (offer.at + n×frequencyDays), resolved by lib/sale-contract
   * `instalmentDueDate`. Off-seal, preview-editable, FROZEN at `final` — same discipline as instalmentMilestones.
   * The override wins over the auto date, and the SAME resolved date renders in the S&P §2 AND feeds the
   * payment ledger (one rule, two readers) — so a pinned date is never a hidden side-arrangement.
   */
  instalmentDueDates?: Record<string, number>;
  /**
   * — the payment option the BUYER agreed for this deal: the id of one of the seller entity's resolved
   * `paymentOptions` (the developer's accepted menu per building). Off-seal, buyer-set (the picker, slice 5),
   * FROZEN at `final` — same discipline as the other tailoring fields. When set + resolvable, the S&P §2 states
   * that destination as the binding payment term; when absent, §2 lists the accepted menu for the buyer to
   * choose from. Not part of the sealed hash; a destination is off-chain only.
   */
  paymentOptionId?: string;
  /**
   * H1 (money-integrity audit) — the OBLIGATION SNAPSHOT frozen at confirmation (off-seal, like
   * `confirmed`/`contract`). THE fix for the settlement-erasure gap: commission + the VRX protocol fee were
   * recomputed LIVE every read via `liveAgreementBetween` (lib/commission), so if the agency↔developer
   * agreement later went `revoked` (legitimate mutual revoke) or EXPIRED, every past confirmed sale under it
   * silently dropped out of the settlement rollup — erasing money genuinely owed (both the agency commission
   * AND VRX's own fee). The stated invariant ("existing deals + commission continue through removal; VRX
   * never claws back earned commission") was promised in copy but not enforced in computation.
   *
   * This freezes the obligation AT THE MOMENT THE SALE CRYSTALLISES (markConfirmed): the agreement id, the
   * agency, the commission %, the VRX fee %, and the agency UNLOCK clause + plan figures the payment-ledger
   * gate needs — so a later agreement revoke/expiry can NEVER erase a debt that already came into being. The
   * RATE was already frozen in the agreement seal; this freezes the EXISTENCE of the obligation too.
   * The attested-record spine applied to the obligation itself.
   *
   * Set ONCE, at the first confirmation, and NEVER overwritten (same idempotence as `confirmed`). Absent for a
   * prospective (unconfirmed) booking — those still resolve LIVE (correctly: a prospective figure is a preview
   * of the CURRENT relationship, and nothing is owed until the sale closes). Absent too on a confirmed
   * offer (legacy) → the resolver falls back to live resolution for those, so history never breaks; a legacy
   * confirmed deal whose agreement is still live resolves exactly as before. Additive: an absent field hashes
   * nowhere (it's off-seal) and keeps every record byte-identical.
   */
  obligation?: ObligationSnapshot;
  /** ms epoch when recorded (at booking time, right after open_claim confirmed). */
  at: number;
};

/**
 * H1 — the frozen obligation for a confirmed sale. Captured at `markConfirmed` from the live
 * `explainSaleCommission` result + the developer's fee rate, then authoritative forever after (settlement +
 * every money surface read THIS for a confirmed deal, not the mutable live agreement). All figures are the
 * exact ones that were true at close — the honest "what was owed the day this became a real sale".
 */
export type ObligationSnapshot = {
  /** The agency↔developer agreement id the commission came from (audit trail; may no longer be live later). */
  agreementId: string;
  /** The agency that earned the commission (frozen — the live roster could change later). */
  agency: string;
  /** The commission % applied, frozen from the agreement's building clause (already sealed; mirrored here). */
  commissionPct: number;
  /** The VRX protocol-fee % frozen from the developer record at close (a later fee change is a new agreement). */
  feePct: number;
  /** The agency UNLOCK clause the payment-ledger gate reads (frozen so a later agreement edit can't move the
   * payout bar on a closed deal). Mirrors commission.ts CommissionResult.clause. */
  unlockPct?: number;
  unlockOnSigning?: boolean;
  /** The sealed plan figures the unlock gate's legacy deposit%-fallback needs (price + deposit at close). */
  priceUsd: number;
  depositUsd?: number;
  /** ms epoch the snapshot was frozen (the confirmation moment). */
  at: number;
};

/**
 * — the TRANSFER TAX arrangement for a booking (off-seal, negotiable). Transfer tax/duty is OPTIONAL and
 * SHARED between buyer and seller; the developer can adjust BOTH the rate and the split during negotiation
 * . Defaults: 3.6% rate, 50/50 split. Editable while the contract is at `preview`, FROZEN at `final`
 * (same stage guard as concessions). The AMOUNT is never frozen — computed from the rate × the booked price
 * at render. Absent = fall back to the plan's `taxPct` (legacy) or the neutral default.
 */
export type OfferTax = {
  /** Total transfer-tax rate as a % of price. */
  ratePct: number;
  /** The BUYER's share of that tax, as a % of the total tax (0..100). Seller pays the remainder. 50 = 50/50. */
  buyerSharePct: number;
  at: number;
  by: string;
};

/**
 * — a DEVELOPER DISCOUNT negotiated off the headline price (off-seal). Sibling of concessions:
 * recorded during negotiation, FROZEN at `final`, nets against the price on the S&P. Either a fixed USD
 * `amount` OR a `percent` of the booked price — the actual money is computed at render (never stored), same
 * discipline as the transfer tax. Absent = no discount. Not part of the sealed hash.
 */
export type OfferDiscount = {
  kind: "amount" | "percent";
  /** USD when kind="amount"; a 0..100 percentage of the booked price when kind="percent". */
  value: number;
  /** Optional reason / condition shown on the S&P (e.g. "launch-phase discount"). */
  note?: string;
  at: number;
  by: string;
};

/**
 * — one per-deal TIMED TERM ( part 1): a time-bound commitment the buyer wants in the S&P. The `when`
 * is deliberately FREE-TEXT, not a calendar date — many are event-relative ("within 60 days of final payment",
 * "on topping-out") and forcing a date would be wrong. `committed` distinguishes a binding contractual date
 * from an indicative projection (mirrors `projected`, inverted for clarity — default is indicative so a
 * developer never accidentally makes an estimate binding).
 */
export type OfferTimedTerm = {
  /** Opaque stable id (so edits/removes target the right line). */
  id: string;
  /** What is committed, e.g. "Covered car-park handover". */
  label: string;
  /** When — a date OR a relative trigger, free-text ("by March 2027", "within 60 days of final payment"). */
  when: string;
  /** Optional detail / condition. */
  note?: string;
  /** True = a BINDING contractual date; false/absent = an indicative projection (the safe default). */
  committed?: boolean;
  at: number;
  by: string;
};

/** One negotiation concession the developer promised on a booking. */
export type OfferConcession = {
  /** Opaque stable id (so edits/removes target the right line). */
  id: string;
  /** What is promised, e.g. "Free covered parking space". */
  label: string;
  /** Optional detail / condition. */
  note?: string;
  /** Optional monetary value (USD) where the concession has one; absent = qualitative (a change/promise). */
  valueUsd?: number;
  at: number;
  by: string;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "offers.json");

async function readAll(): Promise<Offer[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Offer[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Offer[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as activity.ts/events.ts. Without
// this, two offers recorded at once (two agents booking simultaneously) race: both readAll the old list and
// the second writeAll drops the first's offer → the developer inbox shows "offer unavailable" for a real
// on-chain booking. All mutators (recordOffer / revealBuyer / requestReveal / clearRevealRequest) go through it.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: Offer[]) => { next: Offer[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/** Every offer we hold — a source of known booking ids (+ their developer) for the event-mirror seed. */
export async function allOffers(): Promise<Offer[]> {
  return readAll();
}

/** The offer for one request id, or null if we never recorded it (e.g. booked outside this portal). */
export async function getOffer(requestId: string): Promise<Offer | null> {
  const id = requestId.trim();
  if (!id) return null;
  return (await readAll()).find((o) => o.requestId === id) ?? null;
}

/** All offers against one developer (for the inbox's bulk enrichment). Keyed match is case-insensitive. */
export async function offersForDeveloper(developer: string): Promise<Offer[]> {
  const dev = developer.trim().toLowerCase();
  return (await readAll()).filter((o) => o.developer.toLowerCase() === dev);
}

/** All offers an AGENT authored (seal.by == agent). By default only offers with a buyer attached — the agent's
 * protection surface: pending reveal requests to approve, and the reveal/mask state of each booked buyer.
 *
 * `includeBuyerless` (latent-bug fix): the My-bookings surface must NOT hide a
 * COMMISSION-BEARING booking just because no buyer object is attached. The buyer-required filter was meant for
 * the protection surface (which shows buyer detail), but My-bookings reused it and silently dropped a confirmed
 * deal that still counts toward settlement + pays commission. So a caller that lists the agent's own bookings
 * passes `includeBuyerless: true` to also keep a buyer-less offer that is CONFIRMED (a sale in flight) — a
 * buyer-less-AND-unconfirmed draft is still skipped (nothing to show). Protection keeps the default (buyer-only). */
export async function offersForAgent(agent: string, opts?: { includeBuyerless?: boolean }): Promise<Offer[]> {
  const a = agent.trim().toLowerCase();
  if (!a) return [];
  return (await readAll()).filter((o) => {
    if (o.seal.by?.toLowerCase() !== a) return false;
    const b = o.seal.buyer;
    const hasBuyer = b != null && typeof b === "object" && Object.keys(b as object).length > 0;
    if (hasBuyer) return true;
    // No buyer: keep ONLY when the caller opted in AND the deal is confirmed (commission-bearing). A buyer-less
    // unconfirmed draft has nothing worth surfacing and would just be noise.
    return !!opts?.includeBuyerless && !!o.confirmed;
  });
}

/** Record an offer (idempotent on requestId — a replay just overwrites with identical data). */
export async function recordOffer(o: Offer): Promise<void> {
  if (!o.requestId || !o.requestHash) return;
  await mutate((list) => {
    const idx = list.findIndex((x) => x.requestId === o.requestId);
    const next = list.slice();
    if (idx >= 0) next[idx] = o;
    else next.push(o);
    return { next, ret: null };
  });
}

/**
 * — VOID a DIRECT-DESK materialized offer (lib/direct-offer). The direct-deal lifecycle (design §5)
 * ties the offer to (conversationId, epoch): a call-off or hard block ENDS the current deal, so
 * its papered offer must not linger (stale tailoring would otherwise leak into a re-engaged deal — the exact
 * thing the epoch reset guards). This removes the offer record entirely.
 *
 * FAIL-CLOSED GUARD (design §3): this refuses to delete anything that is NOT a direct offer — a real on-chain
 * booking (origin absent/"seed") is NEVER deletable here, so a mis-wired lifecycle call can't erase a booked
 * deal. Checks `display.origin === "direct"` inline (not lib/direct-offer.isDirectOffer) to avoid a circular
 * import. Idempotent: returns false if the offer is unknown or not a direct offer (nothing removed).
 */
export async function voidDirectOffer(requestId: string): Promise<boolean> {
  const id = requestId.trim();
  if (!id) return false;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: false };
    if (list[idx].display?.origin !== "direct") return { next: list, ret: false }; // never void a real booking
    const next = list.slice();
    next.splice(idx, 1);
    return { next, ret: true };
  });
}

/**
 * Stamp an offer CONFIRMED (sold) — called after the developer's confirm_claim tx succeeds on-chain.
 * Idempotent: a repeat keeps the FIRST confirmation (we never overwrite who/when closed the unit). Returns
 * the updated offer, or null if we don't hold it (booked outside this portal → nothing off-chain to stamp).
 *
 * H1 — `obligation` is the frozen money snapshot (commission + VRX fee + unlock clause) the caller
 * resolves from `explainSaleCommission` + the developer fee rate at close. Passed IN (not resolved here) to
 * keep offers.ts free of a commission.ts import (which would be circular — commission.ts imports offers.ts).
 * Frozen on the FIRST confirmation and NEVER overwritten (same rule as `confirmed`): the debt that came into
 * being when the sale closed is authoritative forever, immune to any later agreement revoke/expiry. Absent
 * (undefined) when the caller couldn't resolve one (no live agreement / no rate at close) — then the offer
 * stays snapshot-less and the resolver falls back to live resolution (honest: nothing crystallised).
 */
export async function markConfirmed(
  requestId: string,
  by: string,
  tx?: string,
  obligation?: ObligationSnapshot
): Promise<Offer | null> {
  const id = requestId.trim();
  const who = by.trim();
  const hash = tx?.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    // Keep the first confirmation — never clobber the original closer/timestamp on a replay. (One
    // exception: if the first confirm recorded no tx hash and this replay carries one, backfill the
    // receipt — the hash is just evidence of the same on-chain act, not a competing confirmation.
    // Likewise backfill a MISSING obligation snapshot: a legacy/first confirm that recorded no snapshot
    // may gain one on a later confirm — it's the same crystallised debt, not a competing one. We never
    // OVERWRITE an existing snapshot, so the first-frozen figures stay authoritative.)
    if (cur.confirmed) {
      const needsTx = hash && !cur.confirmed.tx;
      const needsObl = obligation && !cur.obligation;
      if (needsTx || needsObl) {
        const next = list.slice();
        next[idx] = {
          ...cur,
          ...(needsTx ? { confirmed: { ...cur.confirmed, tx: hash } } : {}),
          ...(needsObl ? { obligation } : {}),
        };
        return { next, ret: next[idx] };
      }
      return { next: list, ret: cur };
    }
    const next = list.slice();
    next[idx] = {
      ...cur,
      confirmed: { at: Date.now(), by: who, ...(hash ? { tx: hash } : {}) },
      ...(obligation ? { obligation } : {}),
    };
    return { next, ret: next[idx] };
  });
}

/**
 * — set (or clear) the buyer's chosen FURNITURE pack for a booking. `packId=null` clears the selection.
 * Off-seal, so the frozen hash is untouched. The API route authorizes the caller (participant-scoped) AND
 * validates packId is a pack attached to this building; this layer just records id + who/when. Returns the
 * updated offer, or null if we don't hold it.
 */
export async function markFurnitureSelection(
  requestId: string,
  by: string,
  packId: string | null
): Promise<Offer | null> {
  const id = requestId.trim();
  const who = by.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    const next = list.slice();
    const pid = packId?.trim();
    next[idx] = pid
      ? { ...cur, furniture: { packId: pid, at: Date.now(), by: who } }
      : { ...cur, furniture: undefined };
    return { next, ret: next[idx] };
  });
}

/**
 * — add or update a negotiation concession on a booking. Editable ONLY while the contract is at
 * `preview` (returns null-with-reason via the `locked` flag once final+, so the API can 409). The caller
 * (route) authorizes the developer. `id` present + found = update; absent = new line. Returns the updated
 * offer + whether it was locked.
 */
export async function upsertConcession(
  requestId: string,
  by: string,
  c: { id?: string; label: string; note?: string; valueUsd?: number }
): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  const who = by.trim();
  const label = c.label.trim();
  if (!id || !label) return { offer: null, locked: false };
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } }; // frozen at final+
    const now = Date.now();
    const line: OfferConcession = {
      id: c.id?.trim() || `conc-${now}-${Math.random().toString(16).slice(2, 8)}`,
      label,
      ...(c.note?.trim() ? { note: c.note.trim() } : {}),
      ...(typeof c.valueUsd === "number" && c.valueUsd > 0 ? { valueUsd: Math.round(c.valueUsd) } : {}),
      at: now,
      by: who,
    };
    const existing = cur.concessions ?? [];
    const ex = c.id ? existing.findIndex((x) => x.id === c.id) : -1;
    const concessions = ex >= 0 ? existing.map((x, i) => (i === ex ? { ...line, at: x.at } : x)) : [...existing, line];
    const next = list.slice();
    next[idx] = { ...cur, concessions };
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

/** — remove a concession (developer, while preview only). Returns updated offer + locked flag. */
export async function removeConcession(requestId: string, concessionId: string): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  const cid = concessionId.trim();
  if (!id || !cid) return { offer: null, locked: false };
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } };
    const concessions = (cur.concessions ?? []).filter((x) => x.id !== cid);
    const next = list.slice();
    next[idx] = { ...cur, concessions: concessions.length ? concessions : undefined };
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

/**
 * — add or update a per-deal TIMED TERM (developer, preview only). Passing an `id` edits that line
 * (preserving its original `at`); omitting it appends a new one. Returns updated offer + locked flag (frozen
 * at final+, same stage guard as concessions). Blank label/when is rejected (both are required for a term to
 * mean anything). Mirrors setConcession exactly — a timed term is a dated sibling of a concession.
 */
export async function upsertTimedTerm(
  requestId: string,
  by: string,
  t: { id?: string; label: string; when: string; note?: string; committed?: boolean }
): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  const who = by.trim();
  const label = t.label.trim();
  const when = t.when.trim();
  if (!id || !label || !when) return { offer: null, locked: false };
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } }; // frozen at final+
    const now = Date.now();
    const line: OfferTimedTerm = {
      id: t.id?.trim() || `tt-${now}-${Math.random().toString(16).slice(2, 8)}`,
      label,
      when,
      ...(t.note?.trim() ? { note: t.note.trim() } : {}),
      ...(t.committed ? { committed: true } : {}),
      at: now,
      by: who,
    };
    const existing = cur.timedTerms ?? [];
    const ex = t.id ? existing.findIndex((x) => x.id === t.id) : -1;
    const timedTerms = ex >= 0 ? existing.map((x, i) => (i === ex ? { ...line, at: x.at } : x)) : [...existing, line];
    const next = list.slice();
    next[idx] = { ...cur, timedTerms };
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

/** — remove a timed term (developer, while preview only). Returns updated offer + locked flag. */
export async function removeTimedTerm(requestId: string, termId: string): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  const tid = termId.trim();
  if (!id || !tid) return { offer: null, locked: false };
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } };
    const timedTerms = (cur.timedTerms ?? []).filter((x) => x.id !== tid);
    const next = list.slice();
    next[idx] = { ...cur, timedTerms: timedTerms.length ? timedTerms : undefined };
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

/**
 * — set the negotiable transfer-tax rate + buyer/seller split on a booking (developer, preview only).
 * Clamps rate ≥ 0 and buyerSharePct to 0..100. Returns updated offer + locked flag (frozen at final+).
 */
export async function setTax(
  requestId: string,
  by: string,
  ratePct: number,
  buyerSharePct: number
): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  const who = by.trim();
  if (!id) return { offer: null, locked: false };
  const rate = Number.isFinite(ratePct) && ratePct >= 0 ? ratePct : 0;
  const share = Number.isFinite(buyerSharePct) ? Math.max(0, Math.min(100, buyerSharePct)) : 50;
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } };
    const next = list.slice();
    next[idx] = { ...cur, tax: { ratePct: rate, buyerSharePct: share, at: Date.now(), by: who } };
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

/**
 * — set (or clear) the developer DISCOUNT off the price (developer, preview only). `discount=null`
 * clears it. Clamps value ≥ 0; a percent is clamped to 0..100. Frozen at final+ (returns `locked`). Off-seal.
 * The discounted/net amount is computed at render, never stored (same as the transfer tax).
 */
export async function setDiscount(
  requestId: string,
  by: string,
  discount: { kind: "amount" | "percent"; value: number; note?: string } | null
): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  const who = by.trim();
  if (!id) return { offer: null, locked: false };
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } };
    const next = list.slice();
    if (!discount || !Number.isFinite(discount.value) || discount.value <= 0) {
      next[idx] = { ...cur, discount: undefined };
    } else {
      const kind = discount.kind === "percent" ? "percent" : "amount";
      const raw = kind === "percent" ? Math.max(0, Math.min(100, discount.value)) : Math.max(0, Math.round(discount.value));
      next[idx] = {
        ...cur,
        discount: { kind, value: raw, ...(discount.note?.trim() ? { note: discount.note.trim() } : {}), at: Date.now(), by: who },
      };
    }
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

/**
 * — tie an instalment (1-based ordinal) to a construction MILESTONE label, or clear it (milestone ""/
 * null). Developer, preview only (frozen at final → 409 via `locked`). Validation that the label is a real
 * building milestone is the ROUTE's job (it has the catalog); this layer records the mapping. Returns updated
 * offer + locked flag.
 */
export async function setInstalmentMilestone(
  requestId: string,
  instalment: number,
  milestoneLabel: string | null
): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  const n = Math.round(instalment);
  if (!id || !(n >= 1)) return { offer: null, locked: false };
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } };
    const map = { ...(cur.instalmentMilestones ?? {}) };
    const label = milestoneLabel?.trim();
    if (label) map[String(n)] = label;
    else delete map[String(n)];
    const next = list.slice();
    next[idx] = { ...cur, instalmentMilestones: Object.keys(map).length ? map : undefined };
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

/**
 * pin an explicit DUE DATE (ms epoch) on an instalment (1-based ordinal), or clear it (dueAt
 * null → revert to the auto-interval default). Developer/desk, preview only (frozen at final → 409 via
 * `locked`), mirroring setInstalmentMilestone exactly. Validation that the ordinal is within the sealed plan's
 * instalmentCount is the ROUTE's job (it has the plan); this layer records the sparse override map. A cleared
 * map stores `undefined` (not an empty object) so an untouched offer stays byte-identical. Returns updated
 * offer + locked flag.
 */
export async function setInstalmentDueDate(
  requestId: string,
  instalment: number,
  dueAt: number | null
): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  const n = Math.round(instalment);
  if (!id || !(n >= 1)) return { offer: null, locked: false };
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } };
    const map = { ...(cur.instalmentDueDates ?? {}) };
    if (typeof dueAt === "number" && Number.isFinite(dueAt) && dueAt > 0) map[String(n)] = Math.round(dueAt);
    else delete map[String(n)];
    const next = list.slice();
    next[idx] = { ...cur, instalmentDueDates: Object.keys(map).length ? map : undefined };
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

/**
 * — the BUYER picks one of the seller's accepted payment options for this deal (or clears it, id=null).
 * Off-seal, preview only (frozen at final → 409 via `locked`), mirroring setInstalmentDueDate. Validation that
 * the id is one of the seller's resolved options is the ROUTE's job (it has the building/seller); this layer
 * just records the chosen id. §2 then states that destination as the binding term; an id that no longer
 * resolves falls back to the menu in paymentMethodTerm (graceful — never a crash).
 */
export async function setPaymentOption(
  requestId: string,
  optionId: string | null
): Promise<{ offer: Offer | null; locked: boolean }> {
  const id = requestId.trim();
  if (!id) return { offer: null, locked: false };
  const opt = typeof optionId === "string" ? optionId.trim().slice(0, 40) : "";
  return mutate<{ offer: Offer | null; locked: boolean }>((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: { offer: null, locked: false } };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: { offer: cur, locked: true } };
    const next = list.slice();
    next[idx] = { ...cur, paymentOptionId: opt || undefined };
    return { next, ret: { offer: next[idx], locked: false } };
  });
}

// ──: the S&P CONTRACT stage machine ────────────────────────────────────────────────────────
// preview → final → payment_arrived → signed. Monotonic: each transition only advances from the exact
// prior stage (an out-of-order/replayed call is a no-op that returns the current offer, never a regression).
// All off-seal; gates are enforced by the API route (which knows the reveal-unlock + the dev ack), not here —
// this layer just records the ordered, idempotent state + stamps who/when. See SP_CONTRACT_STATE_DESIGN.md.

export type ContractStage = NonNullable<Offer["contract"]>["stage"];

/** The current stage of an offer's S&P contract. Absent `contract` = "preview" (the default read-only view). */
export function contractStage(o: Offer): ContractStage {
  return o.contract?.stage ?? "preview";
}

/**
 * (S168c) — the ONE date anchor for a deal's auto-interval instalment schedule: the STABLE booking moment
 * `offer.at`. Every reader that dates instalments (the S&P §2 renderer, the payment ledger, the income projection,
 * the desk date-override editor) MUST anchor here so a deal's dates — and the late-flags derived from them — are
 * identical before and after close. The previous `confirmed?.at ?? offer.at` shifted the anchor booking→close on
 * close, silently re-dating a SIGNED contract's §2 ("frozen at final" freezes the override INPUTS, not the rendered
 * OUTPUT). Deliberately IGNORES `confirmed.at`: when the deal closes is not when the schedule is anchored. A pure,
 * trivial accessor, but named + shared so the one-rule invariant can't regress (locked by payment-ledger.test).
 */
export function offerDateAnchor(o: Pick<Offer, "at">): number {
  return o.at;
}

/**
 * preview → final: the developer marks the S&P ready-to-sign (full identity now renders). `kycAckSeal` is the
 * sealed "seen the buyer KYC, this purpose only" undertaking the developer accepted (the gate until encrypted
 * uploads exist). No-op (returns current) unless the offer is exactly at "preview". Idempotent on replay.
 */
export async function markContractFinal(requestId: string, by: string, kycAckSeal?: string): Promise<Offer | null> {
  const id = requestId.trim();
  const who = by.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (contractStage(cur) !== "preview") return { next: list, ret: cur }; // only advance from preview
    const next = list.slice();
    next[idx] = {
      ...cur,
      contract: { ...(cur.contract ?? {}), stage: "final", finalAt: Date.now(), finalBy: who, ...(kycAckSeal ? { kycAckSeal } : {}) },
    };
    return { next, ret: next[idx] };
  });
}

/**
 * final → payment_arrived: the developer marks the on-contract payment received — the VALIDITY gate (only
 * from here is an online signature binding). No-op unless the offer is exactly at "final". Idempotent.
 */
export async function markPaymentArrived(requestId: string, by: string): Promise<Offer | null> {
  const id = requestId.trim();
  const who = by.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (contractStage(cur) !== "final") return { next: list, ret: cur }; // only advance from final
    const next = list.slice();
    next[idx] = {
      ...cur,
      contract: { ...cur.contract!, stage: "payment_arrived", paymentArrivedAt: Date.now(), paymentArrivedBy: who },
    };
    return { next, ret: next[idx] };
  });
}

/**
 * payment_arrived → signed: the S&P is executed. (The actual signing ACT rides the later wallet/signing arc;
 * this records the stage.) No-op unless the offer is exactly at "payment_arrived". Idempotent.
 */
export async function markContractSigned(requestId: string): Promise<Offer | null> {
  const id = requestId.trim();
  if (!id) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => x.requestId === id);
    if (idx < 0) return { next: list, ret: null };
    const cur = list[idx];
    if (contractStage(cur) !== "payment_arrived") return { next: list, ret: cur }; // only from payment_arrived
    const next = list.slice();
    next[idx] = { ...cur, contract: { ...cur.contract!, stage: "signed", signedAt: Date.now() } };
    return { next, ret: next[idx] };
  });
}

// ── Verification (the re-hash that produces the ✓ VETTED seal) ──────────────────────────────────────
// Deterministic JSON with sorted keys — MUST match stableStringify in lib/vrx.ts exactly, so the digest
// equals what the browser produced at booking time. (Kept local so this module has no client import.)
// ⚠ SEAL MECHANICS (documented — "how numbers are handled"): the second arg to JSON.stringify is the
// sorted TOP-LEVEL key array, which JSON.stringify treats as a RECURSIVE property allowlist. So NESTED fields
// are DROPPED from the digest — e.g. `plan: { priceUsd, depositUsd... }` serializes to `{}` (verified
// empirically). The digest therefore attests only the TOP-LEVEL seal fields (terms / by / ownership / freehold
// / buyer / buyerMask), NOT the plan's inner numbers. This is NOT a defect on the booking path: the plan has a
// SECOND anchor — the on-chain contract stores it — so the price still can't be forged. But do NOT assume a
// nested field is tamper-evident just because it lives under a sealed key. (A direct-deal offer, which lacks the
// on-chain plan anchor, folds its price into `terms` to make it genuinely sealed — see lib/direct-offer.)
// Changing this to seal nested fields would re-break EVERY existing offer's verify (they were hashed this way)
// and desync from the browser's hashRef + the on-chain seal — so it stays as-is, documented not "fixed".
function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}

/**
 * Re-hash the stored canonical seal inputs with the same domain the agent used ("vrx-terms") and return
 * the hex digest. Node's crypto is used here (server side); the algorithm (SHA-256 over
 * `${domain}|${salt}|${stableStringify(payload)}`) is identical to lib/vrx.ts hashRef. Rebuild the exact
 * object the agent hashed: undefined ownership/freehold fields are omitted so JSON.stringify drops them
 * the same way.
 */
export async function sealDigest(seal: OfferSeal): Promise<string> {
  const payload: Record<string, unknown> = {
    terms: seal.terms,
    plan: seal.plan ?? null,
    by: seal.by,
  };
  // Only present for a quota building — must match the agent's `quotaOn ? …: undefined`.
  if (seal.ownership !== undefined) payload.ownership = seal.ownership;
  if (seal.freehold !== undefined) payload.freehold = seal.freehold;
  // seam — present only once the roster arc attaches a buyer; omitted today (matches the agent's
  // `buyer: undefined`, which JSON.stringify drops, keeping the current digest unchanged).
  if (seal.buyer !== undefined) payload.buyer = seal.buyer;
  // seam — the per-field mask choice is sealed too (so "what was shown when" is tamper-evident).
  // Omitted when absent, matching the agent's `buyerMask: undefined` (JSON.stringify drops it).
  if (seal.buyerMask !== undefined) payload.buyerMask = seal.buyerMask;

  const input = `vrx-terms||${stableStringify(payload)}`;
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** True iff the stored plaintext re-hashes to the on-chain seal — the ✓ VETTED check. */
export async function verifyOffer(o: Offer): Promise<boolean> {
  try {
    return (await sealDigest(o.seal)) === o.requestHash;
  } catch {
    return false;
  }
}

// ── masking server gate ──────────────────────────────────────────────────────────────────────────
// The ACCESS-CONTROL TRUTH: the developer must NEVER receive the withheld buyer plaintext over the
// wire until the unlock event fires — a UI blur would be theatre. So before shipping a developer-scoped
// offer we run it through `developerView`, which replaces the full seal.buyer with its masked public view
// while the offer is still locked. Verification still works after unlock because seal.buyer (the FULL map)
// is what the on-chain hash sealed; the mask only governs what leaves the server, never what's hashed.

import { publicBuyerView, type BuyerMask } from "./buyer-mask";

/** Is this offer's buyer still masked to the developer? (absent/false unlock = masked). */
export function isMasked(o: Offer): boolean {
  return !o.unlock?.revealed;
}

/**
 * The DEVELOPER-SAFE projection of an offer: identical to the stored offer EXCEPT that, while still locked,
 * `seal.buyer` is replaced by its masked public view (hidden fields dropped, partial fields reduced to a
 * hint) and the raw mask map is stripped. Once unlocked the full buyer passes through untouched. This is
 * the ONLY shape that may be sent to a developer. (The agent/owner get the full offer via their own scopes.)
 */
export function developerView(o: Offer): Offer {
  if (!isMasked(o)) {
    // Unlocked: ship full detail, but still strip the internal mask map (it's an agent concern).
    const { buyerMask: _m, ...seal } = o.seal as OfferSeal & { buyerMask?: unknown };
    return { ...o, seal };
  }
  const buyer = o.seal.buyer as Record<string, string> | undefined;
  const mask = o.seal.buyerMask as BuyerMask | undefined;
  const { buyerMask: _m, ...rest } = o.seal as OfferSeal & { buyerMask?: unknown };
  return {
    ...o,
    seal: { ...rest, buyer: publicBuyerView(buyer, mask) },
  };
}

/**
 * Record a REVEAL act — flip the offer's unlock state. A consented, witnessed, logged act, never a
 * silent change: the trigger + actor (+ optional accepted-declaration seal) are stored for the audit trail
 * and the agent's evidence bundle. Idempotent-ish: a second reveal keeps the FIRST reveal's provenance.
 * Returns the updated offer, or null if the requestId is unknown.
 */
export async function revealBuyer(
  requestId: string,
  trigger: NonNullable<OfferUnlock["trigger"]>,
  by: string,
  declarationSeal?: string
): Promise<Offer | null> {
  return mutate((list) => {
    const idx = list.findIndex((o) => o.requestId === requestId.trim());
    if (idx < 0) return { next: list, ret: null };
    if (list[idx].unlock?.revealed) return { next: list, ret: list[idx] }; // already revealed — don't rewrite
    const next = list.slice();
    next[idx] = {
      ...next[idx],
      unlock: {
        // preserve a prior revealRequest's provenance on the final unlock (part of the evidence trail)
        ...(next[idx].unlock?.revealRequest ? { revealRequest: next[idx].unlock!.revealRequest } : {}),
        revealed: true,
        at: Date.now(),
        trigger,
        by: by.trim(),
        ...(declarationSeal ? { declarationSeal } : {}),
      },
    };
    return { next, ret: next[idx] };
  });
}

/**
 * Record a PRE-DEPOSIT developer reveal REQUEST — the developer has accepted the
 * non-circumvention declaration (sealed as `declarationSeal`), but the buyer stays masked until the AGENT
 * approves (then call revealBuyer with trigger "T1-dev"). Idempotent-ish: a repeat request keeps the first
 * request's provenance. Returns the updated offer, or null if unknown / already revealed.
 */
export async function requestReveal(
  requestId: string,
  by: string,
  declarationSeal: string
): Promise<Offer | null> {
  return mutate((list) => {
    const idx = list.findIndex((o) => o.requestId === requestId.trim());
    if (idx < 0) return { next: list, ret: null };
    if (list[idx].unlock?.revealed) return { next: list, ret: list[idx] }; // already open
    if (list[idx].unlock?.revealRequest) return { next: list, ret: list[idx] }; // already requested
    // A fresh request SUPERSEDES any prior `declined` marker — drop it so the unlock state reflects the
    // live ask, not a stale "was declined once". We don't spread the old unlock (it only ever held revealed:false
    // + optionally `declined`), we write the request cleanly.
    const next = list.slice();
    next[idx] = {
      ...next[idx],
      unlock: {
        revealed: false,
        revealRequest: { by: by.trim(), at: Date.now(), declarationSeal },
      },
    };
    return { next, ret: next[idx] };
  });
}

/**
 * Agent DECLINES a pending developer reveal request — keep the buyer masked, and record an EXPLICIT decline on
 * the offer's own state (audit ENHANCE-1). The pending `revealRequest` is dropped (so the developer may ASK
 * AGAIN — a decline is "not now", not a permanent bar) and replaced by a clean `declined: { at, declarationSeal }`
 * marker. We deliberately do NOT keep any stale trigger/by/at (the lesson) — only the explicit decline marker.
 * `revealed` stays false, so `isMasked` is still true and the developer view stays masked. The sealed declaration
 * the developer accepted also lives on the buyer-events trail, so evidence doesn't evaporate either way. Returns
 * the updated offer, or null if unknown. No-op if there was no pending request / already revealed.
 */
export async function clearRevealRequest(requestId: string): Promise<Offer | null> {
  return mutate((list) => {
    const idx = list.findIndex((o) => o.requestId === requestId.trim());
    if (idx < 0) return { next: list, ret: null };
    if (!list[idx].unlock || list[idx].unlock.revealed) return { next: list, ret: list[idx] };
    // Carry the declined request's declaration hash onto the decline marker for the audit readout.
    const declarationSeal = list[idx].unlock?.revealRequest?.declarationSeal;
    const next = list.slice();
    next[idx] = {
      ...next[idx],
      unlock: { revealed: false, declined: { at: Date.now(), ...(declarationSeal ? { declarationSeal } : {}) } },
    };
    return { next, ret: next[idx] };
  });
}
