// FULL-FUNNEL SEED HARNESS (→) — SERVER-ONLY, dev/test tool.
//
// WHAT THIS IS: a REUSABLE driver (not a throwaway script) that populates the demo with a BIG, realistic
// system — many buyers spread across every funnel/contract stage, across all 3 developers and multiple
// agencies/agents — by DRIVING THE REAL CODE PATHS, not by hand-writing `stage:"signed"` rows. Each synthetic
// buyer actually WALKS the transitions the product defines:
//   • direct funnel (buyer-owned, desk side): saveBuyerProfile → advanceFunnel new→in_conversation→
//     units_opened→offer_eligible, + a real directConversation thread.
//   • agent offers (agent-booked): recordOffer (the attested seal) → markContractFinal → markPaymentArrived
//     → markContractSigned, with the booking CONFIRMED (the on-chain confirm) so commission resolves.
// Each buyer STOPS at its target stage, so every UI stage shows real, code-produced data.
//
// WHY DRIVE THE REAL PATHS: this doubles as a generative test fixture AND the holes-finder (the REVIEW
// method used generatively — exercise the promises/seams, collect every contradiction). When a real function
// refuses (returns null / fails a precondition), that refusal is RECORDED as a HOLE rather than worked around.
// The output is a report whose `holes` list is the real deliverable (see the design docs).
//
// ON-CHAIN STEPS ARE STUBBED + LOGGED (ChunkSigner seam pattern, rule): the two chain
// writes a real booking makes — open_claim (agent books) and confirm_claim (developer confirms) — are
// exercised in CODE through a `ChainStub` that records the args and returns a deterministic fake tx hash, but
// NEVER broadcasts. Zero gas, zero orphan risk against a contract still planned to move. The off-chain half
// (where ~90% of the holes live) is fully real. One small REAL on-chain run is still owed, LAST, on the final
// contract — the stub proves the LOGIC, not the chain REALITY.
//
// IDEMPOTENT + ADDITIVE: synthetic buyers use fixed, realistic-looking (non-identifiable) two-word testnet
// handles tracked in SEEDED_ACCOUNTS. A re-run overwrites only its own rows (the underlying stores are
// idempotent on their keys) and never touches the hand-made demo data (existing offers, highbird.testnet, …).
//
// PRIVACY: server-only; synthetic PII only; nothing goes on-chain (the stub is the whole point).

import { saveBuyerProfile, advanceFunnel, funnelRank, type BuyerFunnelState } from "./buyers-direct";
import {
  recordOffer,
  markContractFinal,
  markPaymentArrived,
  markContractSigned,
  markConfirmed,
  getOffer,
  type Offer,
  type OfferSeal,
} from "./offers";
import { buyerSnapshot } from "./buyer-snapshot";
import { saveBuyerForAgent } from "./buyers";
import { postMessage, getThread } from "./channels";
import { resolveDirectConversation } from "./conversations-direct";
import { proposeAgreement, setAgreementStatus, liveAgreementBetween, type AgreementSeal } from "./agreements";
import { signVrxDeveloperAgreement, currentVrxDeveloperAgreement, VRX_DEVELOPER_TERMS_VERSION } from "./vrx-developer-agreement";
import { getBaseline } from "./sale-baseline";
import { buildObligationSnapshot } from "./commission";
import { goOnContract } from "./stamp-jobs";
import { getBuildingSnapshot, saveBuildingStatuses, invalidateSnapshotMemo } from "./status-store";
import { agenciesWithGateButNoAgreement } from "./gate-agreement-check";
import { resolveSaleCommission } from "./commission";
import { agencyOf, recordAgent } from "./agents";
import { setProfile, getProfile, type ProfileRole } from "./profiles";
import { getBuilding, saveBuilding, type Building, type Unit } from "./catalog";
import { applyOffMarket, OPEN, UNSTAMPED } from "./offmarket";
import { saveDeveloper, getDeveloper } from "./developers";
import { recordGate } from "./gates";
import { grantUnit } from "./unit-grants";
import { addBuyerDoc, getBuyerVault } from "./kyc-vault-buyer";
import { savePack } from "./furniture-packs";
import { digest } from "./seal";
import { operatorSend, transfer, balanceOf, TREASURY_ACCOUNT } from "./vrx-token";
import { setIssuanceConfig, issueTokens, transferToken, liveTokenCount, tokensInCustody } from "./booking-tokens";
import { seedImages } from "./seed-images";
import { logPayment, paymentsForDeal } from "./payment-vault";
import { deflateSync } from "zlib";

// ── The chain stub (seam) ────────────────────────────────────────────────────────────────────────────
// Mirrors the two on-chain function calls a real booking makes. Records every call for the report; returns a
// deterministic fake tx hash. NEVER touches the network. Swapping this for a real signer is the owed last step.
export type StubbedCall = { method: "open_claim" | "confirm_claim"; args: Record<string, unknown>; tx: string };

class ChainStub {
  calls: StubbedCall[] = [];
  private seq = 0;
  private fakeTx(method: string): string {
    this.seq += 1;
    return `stub:${method}:${this.seq.toString().padStart(4, "0")}`;
  }
  openClaim(args: { requestId: string; unitKey: string; node: string; requestHash: string }): string {
    const tx = this.fakeTx("open_claim");
    this.calls.push({ method: "open_claim", args, tx });
    return tx;
  }
  confirmClaim(args: { requestId: string; node: string }): string {
    const tx = this.fakeTx("confirm_claim");
    this.calls.push({ method: "confirm_claim", args, tx });
    return tx;
  }
}

// ── Hashing (byte-identical to the client lib/vrx.ts hashRef with salt="") ─────────────────────────────────
// The agent page derives requestId/requestHash with hashRef(payload, domain) — salt="". lib/seal.digest with an
// empty salt is the SAME scheme (`${domain}||${stableStringify}`), so server-produced ids verify client-side.
function hashRef(payload: Record<string, unknown> | string, domain: string): string {
  return digest(payload, domain, "");
}

// ── Synthetic identities (realistic, NON-identifiable — no "seed"/"agent"/"buyer" tokens) ───────
// The synthetic-identity PREDICATES + their account list now live in the zlib-free lib/seed-identity (extracted
//  so the seller auto-responder can use isSeedAccount/isSeedDeveloper without dragging seed-funnel's heavy
// Node-only graph — zlib/catalog — into the server instrumentation edge trace). Re-exported here so every
// existing caller (`import { isSeedAccount, SEEDED_ACCOUNTS } from "./seed-funnel"`) is unchanged.
import { SEED_BUYER_ACCOUNTS, isSeedAccount, isSeedDeveloper } from "./seed-identity";
export { isSeedAccount, isSeedDeveloper };

const BUYER_ACCOUNTS = SEED_BUYER_ACCOUNTS;
export const SEEDED_ACCOUNTS: readonly string[] = BUYER_ACCOUNTS;

/** True iff a row looks like throwaway TEST/PROBE debris from ad-hoc dev runs (reqIds like `test-*`, `probe-*`,
 * `seed-s123-*`, or non-domain dev handles like `d.testnet`/`dev.testnet`/`test-dev.testnet`). Belt-and-
 *  suspenders companion to isSeedDeveloper for the --fresh wipe: catches junk that isn't on a seeded developer
 *  (e.g. `probe-dev.testnet|b/u`). Deliberately narrow — only unmistakable test artifacts. */
export function isTestJunkOffer(row: { requestId?: string; developer?: string; display?: { buildingId?: string; unitId?: string } }): boolean {
  const req = String(row.requestId ?? "");
  if (/^(test-|probe-|seed-s\d+-)/i.test(req)) return true;
  const dev = String(row.developer ?? "").toLowerCase();
  if (/^(test-dev|probe-dev|d|dev)\.testnet$/.test(dev)) return true;
  // a row with no real building/unit (old smoke probes stored bld:"b"/unit:"u" or undefined)
  const bld = row.display?.buildingId, unit = row.display?.unitId;
  if (!bld || bld.length <= 1 || !unit || /^u$/.test(String(unit))) return true;
  return false;
}

const FIRST = ["Oliver", "Mei", "Dmitri", "Sofia", "Arun", "Clara", "Ivan", "Priya", "Lukas", "Nadia", "Henrik", "Yuki"];
const LAST = ["Harding", "Chen", "Volkov", "Marchetti", "Patel", "Nordstrom", "Petrov", "Rao", "Keller", "Haddad", "Larsen", "Tanaka"];
const NATIONS = ["British", "Singaporean", "Russian", "Italian", "Indian", "Swedish", "Ukrainian", "Indian", "German", "Lebanese", "Norwegian", "Japanese"];

function profileFor(i: number) {
  return {
    name: `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`,
    legalName: `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`,
    nationality: NATIONS[i % NATIONS.length],
    phone: `+66 9${(10000000 + i * 137).toString().slice(0, 7)}`,
    email: `${FIRST[i % FIRST.length].toLowerCase()}.${LAST[i % LAST.length].toLowerCase()}@examplemail.com`,
    passportNo: `P${(5000000 + i * 911).toString()}`,
    address: `${10 + i} Beach Road, Pattaya, Chonburi 20150, Thailand`,
  };
}

// A realistic minimal payment plan — only priceUsd is load-bearing (commission), the rest is shape fidelity.
function planFor(priceUsd: number) {
  const deposit = Math.round(priceUsd * 0.005);
  const onContract = Math.round(priceUsd * 0.21);
  return {
    priceUsd,
    depositUsd: deposit,
    onContractUsd: onContract,
    instalmentCount: 12,
    instalmentUsd: Math.round((priceUsd - deposit - onContract) / 12),
    frequencyDays: 60,
    bookingFeeUsd: 500,
    taxPct: 0,
    reservationUsd: 300,
    furnitureUsd: 0,
  };
}

// ── What each buyer is seeded to do ────────────────────────────────────────────────────────────────────────
// Two tracks: DIRECT funnel buyers (buyer-owned desk path) and AGENT offer buyers (agent-booked).
// ── The dated TIMELINE plan a spec carries (backfill) ───────────────────────────────────────────────
// The GENERATOR decides each deal's intended dated timeline; the harness still drives the REAL code paths at
// real-now (markConfirmed/advanceFunnel stamp Date.now); then the timestamp POST-PASS (lib/backfill-dates)
// rewrites the stamped `at`/stage-time fields to THIS schedule. Keeping the plan on the spec means the
// generator and the post-pass agree on one source of truth per deal. All offsets are DAYS-AGO from `now`
// (post-pass resolves them to ms-epoch), monotonic, all > 0 (strictly in the past). Absent ⇒ the
// behaviour (everything at real-now), so a caller that ignores dating still works.
export type DealSchedule = {
  /** Days-ago the deal ARRIVED (record `at` / funnel entry). The largest offset in the schedule. */
  arrivalDaysAgo: number;
  /** Per-stage dwell DAYS after arrival (cumulative handled by the post-pass). Only the stages the deal
   *  actually reaches are consumed. Monotonic, each ≥ 0. */
  dwell: { toPreviewFinal?: number; toPaymentArrived?: number; toSigned?: number; toConfirm?: number };
  /** Which market ARCHETYPE produced this deal (for the report + so a reviewer can eyeball the mix). */
  archetype: "trickle" | "opening_event" | "expo_lead" | "opportunistic" | "repeat_investor" | "adjacent_combine";
  /** The intended OUTCOME (drives target/confirmed + the post-pass's at-risk/lapse treatment). */
  outcome: "close" | "progress" | "lapse" | "at_risk";
};

type DirectSpec = {
  kind: "direct";
  account: string;
  building: string; // must be directSale.visible and have a desk developer
  target: BuyerFunnelState;
  schedule?: DealSchedule;
};
type OfferSpec = {
  kind: "offer";
  account: string; // the buyer wallet (display.buyerId analogue; here just the thread/account anchor)
  agent: string; // seal.by — the booking agent
  developer: string;
  building: string;
  unitId: string;
  priceUsd: number;
  // how far along the S&P contract machine this booking is driven:
  target: "booked" | "preview" | "final" | "payment_arrived" | "signed";
  // whether the booking is CONFIRMED on-chain (the sale moment commission reads). Independent of the contract
  // stage overlay: a sale can be confirmed (sold) while its paperwork is still being finalized.
  confirmed: boolean;
  schedule?: DealSchedule;
};
type BuyerSpec = DirectSpec | OfferSpec;

// ── The report ───────────────────────────────────────────────────────────────────────────────────────────
export type Hole = { where: string; promise: string; brokenBy: string };

// A dated TARGET the timestamp post-pass will re-date. One per seeded deal that carries a schedule:
// the store key (requestId for an offer, conversationId for a direct thread) + which developer/building it's
// against (for launch-era clustering) + its schedule. runSeedFunnel collects these as it drives each deal so
// the post-pass consumes an EXPLICIT map rather than re-deriving keys by re-hashing (robust to any hash change).
export type DatedTarget = {
  kind: "offer" | "direct";
  /** offers.json key (requestId) OR channels.json key (conversationId). */
  key: string;
  developer: string;
  building: string;
  schedule: DealSchedule;
};

export type SeedReport = {
  directCreated: number;
  offersCreated: number;
  commissionsResolved: number;
  stubbedCalls: StubbedCall[];
  holes: Hole[];
  notes: string[];
  /** The dated targets for the post-pass (empty if no spec carried a schedule). */
  dated: DatedTarget[];
};

// ── Prereq wiring: make the money-half seed exist so confirmed sales can earn (: harness establishes
// baselines + agreements for dev-02/dev-03 too). All REAL calls, idempotent, off-chain. ─────────────────────
async function ensureAgreement(developer: string, agency: string, building: string, pct: number, log: (n: string) => void) {
  const existing = await liveAgreementBetween(developer, agency);
  if (existing && existing.seal.buildings.some((b) => b.buildingId === building)) return existing;
  const seal: AgreementSeal = {
    agency,
    developer,
    buildings: [{ buildingId: building, commissionPct: pct, scope: "whole" }],
    terms: "Standard exclusive-territory commission terms; monthly settlement.",
    by: "agency",
    proposedAt: Date.now(),
  };
  const proposed = await proposeAgreement(seal);
  const agreed = await setAgreementStatus(proposed.id, "agreed", developer);
  if (!agreed) {
    log(`agreement ${agency}→${developer} proposed but could not be moved to agreed`);
    return proposed;
  }
  return agreed;
}

// Establish ONE live agreement for (developer, agency) covering ALL the given buildings. The real
// model is a single agreement whose `buildings[]` lists every covered building (resolveSaleCommission reads
// one liveAgreementBetween + finds the building's clause in it). If a live agreement already covers every
// building, reuse it; otherwise propose a fresh one covering the UNION (the latest live agreement supersedes
// for commission reads). Idempotent + off-chain. 3% default rate per building.
async function ensureAgreementForBuildings(developer: string, agency: string, buildings: string[], log: (n: string) => void) {
  const want = [...new Set(buildings.filter(Boolean))];
  if (want.length === 0) return null;
  const existing = await liveAgreementBetween(developer, agency);
  if (existing && want.every((b) => existing.seal.buildings.some((eb) => eb.buildingId === b))) return existing;
  // Union of any already-covered buildings + the wanted set, so we never shrink an existing agreement.
  const covered = new Set<string>(existing?.seal.buildings.map((b) => b.buildingId) ?? []);
  for (const b of want) covered.add(b);
  const seal: AgreementSeal = {
    agency,
    developer,
    buildings: [...covered].map((buildingId) => ({ buildingId, commissionPct: 3, scope: "whole" as const })),
    terms: "Standard exclusive-territory commission terms; monthly settlement.",
    by: "agency",
    proposedAt: Date.now(),
  };
  const proposed = await proposeAgreement(seal);
  const agreed = await setAgreementStatus(proposed.id, "agreed", developer);
  if (!agreed) {
    log(`multi-building agreement ${agency}→${developer} proposed but could not be moved to agreed`);
    return proposed;
  }
  return agreed;
}

// Ensure a developer has SIGNED the current VRX↔developer agreement, signing off every building they list
// (§7 "signing precedes listing"). In development we jumped around and published buildings
// before any developer signed — so once the listing gate hides unsigned developers (lib/listing-gate), the
// seeded world would go dark. This seeds the real signed state the honest way: the SAME signVrxDeveloperAgreement
// the /node sign UI calls, with a per-building sign-off for each building this developer owns in the plan.
// Idempotent: skip if the developer already has a current signed agreement on the live terms version. (The
// correct end-state is a fresh contract + a seed that signs-then-publishes from the start — this makes TODAY's
// demo coherent without faking the invariant.)
async function ensureVrxAgreement(developer: string, buildings: string[], log: (n: string) => void) {
  const existing = await currentVrxDeveloperAgreement(developer);
  if (existing && existing.seal.termsVersion === VRX_DEVELOPER_TERMS_VERSION) return existing;
  const signOffs = [...new Set(buildings.filter(Boolean))].map((buildingId) => ({ buildingId, attested: true }));
  const signed = await signVrxDeveloperAgreement({ developer, signOffs });
  if (!signed) log(`VRX agreement for ${developer} could not be signed`);
  return signed;
}

// Establish the baseline via the REAL onboarding seam (H2 Half B) — NOT a direct establishBaseline
// shortcut. The product path is: the stamp job sets units `open` on-chain → the snapshot mirrors it →
// goOnContract reads that `open` set and dates the baseline. On-chain is stubbed here, so nothing
// updates the snapshot by itself; we first mirror the onboarding slate into the snapshot (every catalog unit
// not already sold/closed/held → `open`), exactly as a completed stamp job would leave it, THEN call the real
// goOnContract (same function the /api/stamp-jobs/go-on-contract route uses). This way the seed exercises the
// real spine end-to-end and every demoed building gets a baseline the honest way — so PROSPECTIVE commission
// (which needs a baseline to EXIST) resolves too, not just confirmed sales. Idempotent (goOnContract preserves
// the original establishedAt; the snapshot merge only ever adds `open`).
async function ensureBaseline(developer: string, building: string, log: (n: string) => void) {
  const existing = await getBaseline(developer, building);
  if (existing) return existing;

  const bld = await getBuilding(building);
  if (!bld) {
    log(`ensureBaseline: no catalog building ${building}`);
    return null;
  }

  // Mirror the onboarding slate into the snapshot: a unit stays at its existing stamped status if it's
  // already sold/closed/held (1/2/3) — those are the exceptions a developer marks in phase 2 — otherwise it
  // becomes `open` (0), the phase-1 clean slate. This is what the status snapshot looks like after a stamp
  // job completes, which is what goOnContract reads.
  const snap = await getBuildingSnapshot(building);
  const prior = snap?.units ?? {};
  const slate: Record<string, number> = {};
  for (const u of bld.inventory) {
    const cur = prior[u.id];
    slate[u.id] = cur === 1 || cur === 2 || cur === 3 ? cur : 0;
  }
  await saveBuildingStatuses(building, slate, { complete: true });
  invalidateSnapshotMemo(); // force goOnContract's read to see the slate we just wrote

  // The real go-on-contract read: available set = units currently `open` in the snapshot (same derivation as
  // the route). goOnContract → establishBaseline, preserving the original date on any re-run.
  const fresh = await getBuildingSnapshot(building);
  const availableUnits = Object.entries(fresh?.units ?? {})
    .filter(([, status]) => status === 0)
    .map(([unit]) => unit);
  if (availableUnits.length === 0) {
    log(`ensureBaseline: no open units after slate for ${developer}/${building} — baseline skipped`);
    return null;
  }
  const made = await goOnContract({ developer, building, availableUnits });
  if (!made) log(`goOnContract refused for ${developer}/${building}`);
  return made;
}

// ── Driving one direct-funnel buyer ──────────────────────────────────────────────────────────────────────
async function driveDirect(spec: DirectSpec, i: number, holes: Hole[], notes: string[]): Promise<string | null> {
  const saved = await saveBuyerProfile(spec.account, profileFor(i));
  if (!saved) {
    holes.push({ where: `direct/${spec.account}`, promise: "a valid profile creates a buyer record", brokenBy: "saveBuyerProfile returned null" });
    return null;
  }
  // Open the desk conversation (materializes the thread) + post a first message, exactly as the funnel does.
  const conv = await resolveDirectConversation(spec.account, spec.building, true);
  if (!conv) {
    holes.push({
      where: `direct/${spec.account}/${spec.building}`,
      promise: "a buyer can open a desk conversation about a direct-sale-visible building",
      brokenBy: "resolveDirectConversation returned null (building not directSale.visible OR no desk developer)",
    });
  } else {
    // Idempotent: only post the opener pair if this thread doesn't already carry it. Without this guard a
    // re-run of the seed (easy to do by reflex) APPENDS another identical buyer/desk pair every time — which
    // is exactly how a dev `.data` accumulated dozens of repeating "Interested in…/Welcome — happy to help…"
    // rows. postMessage appends; it has no natural dedup. A fresh `.data` + one seed run stays clean regardless.
    const opener = `Interested in ${spec.building}. What's available?`;
    const existing = await getThread(conv.id);
    if (!existing.some((m) => m.text === opener)) {
      await postMessage({ requestId: conv.id, from: "buyer", by: spec.account, text: opener, context: { kind: "direct", id: conv.id } });
      await postMessage({ requestId: conv.id, from: "developer", by: conv.developer, text: "Welcome — happy to help. May I ask what you're looking for and your budget?", context: { kind: "direct", id: conv.id } });
    }
  }
  // Walk the funnel to the target (monotonic; each step is a real advanceFunnel).
  const order: BuyerFunnelState[] = ["new", "in_conversation", "units_opened", "offer_eligible"];
  const targetRank = order.indexOf(spec.target);
  let reachedTarget = true;
  for (let r = 1; r <= targetRank; r++) {
    const res = await advanceFunnel(spec.account, order[r]);
    // Monotonic: advancing to a step the buyer is already AT OR PAST is a correct no-op (returns the higher
    // state). A hole is only real if the buyer ended up BELOW this step — i.e. the advance genuinely failed.
    if (!res || funnelRank(res.funnel) < r) {
      holes.push({ where: `direct/${spec.account}`, promise: `funnel can advance to ${order[r]}`, brokenBy: `advanceFunnel did not reach ${order[r]} (got ${res?.funnel ?? "null"})` });
      reachedTarget = false;
      break;
    }
  }

  // ── STEP 4 (genesis-walk): the WALK-IN LANE pays + settles too ──────────────────────────────────────
  // A direct buyer who reaches offer_eligible is ready to buy. There is no separate "direct agreement" object —
  // a direct sale is a developer↔buyer deal represented by its PAYMENTS (dir has no agency middle-party). So we
  // complete the lane the same honest way the agent lane does: pick a real unit in the desk building and seed a
  // deposit + installments through the REAL payment vault, developer-scoped to the desk developer, buyer = the
  // walk-in. computeLedgerStatus then shows the direct deal paying down. Idempotent (seedDealPayments skips a
  // deal that already has payments; the synthetic requestId is deterministic per (buyer, building)).
  if (reachedTarget && spec.target === "offer_eligible" && conv?.developer) {
    // Spread direct buyers across inventory (offset from the agent-lane cursor so they tend to differ). nthUnitId
    // clamps to the last unit if the building is small, which is fine for a demo.
    const unitId = await nthUnitId(spec.building, 100 + i);
    const bld = await getBuilding(spec.building);
    const unit = bld?.inventory?.find((u) => u.id === unitId);
    if (unitId && unit) {
      const directRequestId = hashRef({ direct: spec.account, building: spec.building, unit: unitId }, "vrx-direct-sale");
      await seedDealPayments(
        { requestId: directRequestId, developer: conv.developer, building: spec.building, unitId, buyer: spec.account, priceUsd: unit.priceUsd },
        holes,
        notes,
      );
    }
  }
  return conv?.id ?? null; // the channels.json key the post-pass re-dates this thread by
}

// ── Driving one agent offer ──────────────────────────────────────────────────────────────────────────────
async function driveOffer(spec: OfferSpec, i: number, chain: ChainStub, holes: Hole[], notes: string[]): Promise<Offer | null> {
  const bld = await getBuilding(spec.building);
  if (!bld) {
    holes.push({ where: `offer/${spec.building}`, promise: "an offer targets a real catalog building", brokenBy: "getBuilding returned null" });
    return null;
  }
  // STUB the on-chain open_claim exactly as the agent page would call it (same arg derivation).
  const unitKey = hashRef({ building: spec.building, unit: spec.unitId }, "vrx-unit");
  const requestId = hashRef({ node: spec.developer, unit: unitKey, by: spec.agent, at: 1_792_200_000_000 + i }, "vrx-req");
  // ATTACH A BUYER (fix) — a real agent booking seals the attested buyer snapshot into `seal.buyer`
  // (the agent page does this via buyerSnapshot(selectedBuyer.fields)). Without it, the booking was INVISIBLE
  // in the agent's own "My bookings" (offersForAgent requires a non-empty seal.buyer) even though settlement
  // counted it + paid commission — a seam contradiction. Seeding a buyer the SAME way the UI does makes the
  // offer authentic (folded into the request_hash → the developer's ✓-verify reproduces it) and lights up
  // My-bookings for every seeded agent. Synthetic, non-identifiable PII only (profileFor), nothing on-chain.
  const buyer = buyerSnapshot(profileFor(i));
  // ROSTER COHERENCE (fix) — the fix sealed the buyer into the offer (→ lights up the agent's "My
  // bookings"), but never put that buyer on the agent's reusable ROSTER (lib/buyers → "My buyers"). So every
  // seeded sale produced an agent with a booking but an EMPTY "My buyers" — an impossible state in the real
  // product (an agent books FROM their roster). Mirror reality: write the SAME buyer onto spec.agent's roster
  // via the real saveBuyerForAgent seam (the /api/buyers path the roster UI uses). Deterministic id keyed off
  // the offer so a re-run OVERWRITES rather than piling up (idempotent, like the rest of this harness).
  // Synthetic PII only (profileFor) — nothing on-chain, unaffected. Best-effort: a roster-write refusal is
  // recorded as a hole, never aborts the booking (the sale itself is still valid).
  const rosterId = `seed-roster-${hashRef({ agent: spec.agent, building: spec.building, unit: spec.unitId }, "vrx-roster").slice(0, 16)}`;
  const rostered = await saveBuyerForAgent(spec.agent, profileFor(i), rosterId);
  if (!rostered) {
    holes.push({ where: `offer-roster/${spec.agent}`, promise: "a seeded sale's buyer appears on the booking agent's My-buyers roster", brokenBy: "saveBuyerForAgent returned null" });
  }
  const seal: OfferSeal = { terms: `Booking for ${buyer.name} on ${spec.building} ${spec.unitId}.`, plan: planFor(spec.priceUsd), buyer, by: spec.agent };
  const requestHash = hashRef(seal as unknown as Record<string, unknown>, "vrx-terms");
  chain.openClaim({ requestId, unitKey, node: spec.developer, requestHash });

  // The REAL off-chain attested record (what the developer inbox reads + verifies).
  await recordOffer({
    requestId,
    requestHash,
    developer: spec.developer,
    seal,
    display: { buildingId: spec.building, unitId: spec.unitId, buyerType: null, buyerId: spec.account, origin: "seed" },
    at: Date.now(),
  });

  // Confirm (on-chain confirm_claim, stubbed) — the sale moment commission reads.
  if (spec.confirmed) {
    const tx = chain.confirmClaim({ requestId, node: spec.developer });
    // H1 — freeze the obligation snapshot at close, exactly as the real confirm route does, so the
    // demo world carries crystallised debts (undefined when nothing was facilitated; the resolver then falls
    // back to live). Resolved from the pre-confirmation offer while the agreement is live (set up in step 2-3).
    const preConfirm = await getOffer(requestId);
    const obligation = preConfirm ? await buildObligationSnapshot(preConfirm) : undefined;
    const marked = await markConfirmed(requestId, spec.developer, tx, obligation);
    if (!marked?.confirmed) holes.push({ where: `offer/${requestId.slice(0, 8)}`, promise: "a confirmed booking is stamped sold", brokenBy: "markConfirmed did not set confirmed" });
    // FINDING #1 FIX: a real confirm_claim writes BOTH the off-chain `confirmed` flag AND
    // the on-chain unit-status transition. The old stub set only `confirmed`, so the status snapshot never
    // saw the unit leave `open` → the status ledger never recorded the transition → `leftAvailableAt` (the
    // VRX "time held available" clock) stayed null → the clock honestly read "unit still available" while
    // commission counted it SOLD. That contradiction is EXACTLY what an invariant reviewer catches at the
    //  seam. Here we mirror the real path: flip the unit to `closed` (2) through saveBuildingStatuses
    // — the ONE choke-point that feeds recordTransitions → the ledger (status-store.ts:74). The date is
    // real-now here; the timestamp post-pass re-dates this transition to the deal's confirm date (§5). One
    // call makes the whole clock consistent because the ledger feed is automatic off that choke-point.
    await saveBuildingStatuses(spec.building, { [spec.unitId]: 2 /* closed */ });
  }

  // Walk the S&P contract machine to the target (each a real, monotonic transition).
  const stages = ["preview", "final", "payment_arrived", "signed"] as const;
  const targetIdx = spec.target === "booked" ? -1 : stages.indexOf(spec.target as (typeof stages)[number]);
  if (targetIdx >= 1) {
    const f = await markContractFinal(requestId, spec.developer, hashRef({ ack: "kyc-seen", requestId }, "vrx-kyc-ack"));
    if (f?.contract?.stage !== "final") holes.push({ where: `offer/${requestId.slice(0, 8)}`, promise: "preview→final advances", brokenBy: `markContractFinal left stage ${f?.contract?.stage ?? "preview"}` });
  }
  if (targetIdx >= 2) {
    const p = await markPaymentArrived(requestId, spec.developer);
    if (p?.contract?.stage !== "payment_arrived") holes.push({ where: `offer/${requestId.slice(0, 8)}`, promise: "final→payment_arrived advances", brokenBy: `markPaymentArrived left stage ${p?.contract?.stage ?? "final"}` });
  }
  if (targetIdx >= 3) {
    const s = await markContractSigned(requestId);
    if (s?.contract?.stage !== "signed") holes.push({ where: `offer/${requestId.slice(0, 8)}`, promise: "payment_arrived→signed advances", brokenBy: `markContractSigned left stage ${s?.contract?.stage ?? "payment_arrived"}` });
    // STEP 3 (genesis-walk): a SIGNED deal pays down — deposit + ~6 installments through the real payment
    // vault, so Settlement shows a real paid plan (not an empty one). Dated along the deal timeline.
    else await seedDealPayments({ requestId, developer: spec.developer, building: spec.building, unitId: spec.unitId!, buyer: spec.account, priceUsd: spec.priceUsd }, holes, notes);
  }

  return getOffer(requestId);
}

// ── STEP 3 helper: seed a signed deal's deposit + installments via the REAL payment vault ───────
// Logs a deposit, the on-contract tranche, and ~6 installments as self-proving in-app payments (rail "in_app" →
// buyerConfirm "confirmed", so computeLedgerStatus counts them toward the plan). Amounts come from the SAME
// planFor the offer seal carries, so the paid-down plan matches the contract. Idempotent: if the deal already
// has logged payments, skip (a re-seed must not double-log — logPayment has no natural dedup). Chain-free.
async function seedDealPayments(
  deal: { requestId: string; developer: string; building: string; unitId: string; buyer: string; priceUsd: number },
  holes: Hole[],
  notes: string[],
): Promise<void> {
  const existing = await paymentsForDeal(deal.requestId);
  if (existing.length > 0) return; // already seeded — idempotent
  const plan = planFor(deal.priceUsd);
  // deposit + on-contract + 6 installments (not the full 12 — a deal mid-plan reads more realistically than a
  // fully-paid one, and still exercises the installment UI). Dated backward from now at the plan's frequency.
  const INSTALMENTS_PAID = 6;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const tranches: Array<{ amountUsd: number; note: string; ago: number }> = [
    { amountUsd: plan.depositUsd, note: "Reservation deposit", ago: (INSTALMENTS_PAID + 2) * plan.frequencyDays },
    { amountUsd: plan.onContractUsd, note: "On-contract payment", ago: (INSTALMENTS_PAID + 1) * plan.frequencyDays },
  ];
  for (let k = 0; k < INSTALMENTS_PAID; k++) {
    tranches.push({ amountUsd: plan.instalmentUsd, note: `Instalment ${k + 1} of ${plan.instalmentCount}`, ago: (INSTALMENTS_PAID - k) * plan.frequencyDays });
  }
  for (const t of tranches) {
    if (!(t.amountUsd > 0)) continue; // skip a zero tranche (tiny-price edge) rather than throw
    try {
      await logPayment({
        developer: deal.developer,
        buildingId: deal.building,
        unitId: deal.unitId,
        requestId: deal.requestId,
        buyer: deal.buyer,
        amountUsd: t.amountUsd,
        paidAt: now - t.ago * day,
        method: "bank_slip",
        rail: "in_app", // self-proving → counted immediately (no buyer-confirm dance for the seed)
        note: t.note,
      });
    } catch (e) {
      holes.push({ where: `payment/${deal.requestId.slice(0, 8)}`, promise: "a signed deal can log its deposit + installments", brokenBy: `logPayment threw: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
  }
  notes.push(`seeded ${tranches.length} payment(s) for ${deal.requestId.slice(0, 8)} (deposit + on-contract + ${INSTALMENTS_PAID} instalments)`);
}

// ── Seeded deterministic RNG (mulberry32) ───────────────────────────────────────────────────────────────
// A tiny, well-known 32-bit PRNG. Seeded from a FIXED constant so a re-run is byte-identical — which is what
// makes "wipe-then-seed" (--fresh) reproducible: the same count always regenerates the same world. NOT for
// crypto (privacy is unaffected — this only chooses demo shapes, never touches a seal/hash).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED_RNG_CONSTANT = 0x56525831; // "VRX1" — fixed so the backfill is reproducible.

// ── DISTRIBUTIONS — all tunable in ONE block so can tweak the world without touching logic.
// Grounded in the real Thailand off-plan patterns (memory: thai-offplan-market-patterns): a 2–3yr pre-sale
// window with explosive opening events, expo lead-clusters, opportunistic singles, and repeat multi-unit
// investors. Dates here are DAYS-AGO from now (the post-pass resolves to epoch); every offset > 0 (past).
const DISTRIBUTIONS = {
  /** The pre-sale arrival window (the operator catalog fact: projects sell out over 2–3 yr). Deals arrive within the last
   *  ~2.5 yr, weighted slightly toward recent (a growing operation). */
  arrivalWindowDays: 900, // ~2.5 years
  /** Opening-event bursts: a big batch of bookings landing on ONE day at a discount (the real-time system's
   *  showcase). `count` events; each clusters `sharePerEvent` of the plan onto a single arrival date. At
   *  count=48 this reads as a visible same-day cluster (~12–18 deals), not a literal building sell-out. */
  openingEvents: { count: 2, sharePerEvent: 0.18, windowDays: [120, 700] as [number, number] },
  /** Share of deals entering via an expo lead-cluster (several funnel entries on one date, trailing follow-up). */
  expoLeadShare: 0.12,
  /** Share that are opportunistic one-offs (short new→view→book gap). The remainder is the baseline trickle. */
  opportunisticShare: 0.1,
  /** How many distinct buyer accounts are REPEAT multi-unit investors (reuse the same account across deals). */
  repeatInvestorAccounts: 4,
  /** Outcome mix across the whole plan (design §4). Sums to 1. */
  outcomes: { close: 0.5, progress: 0.15, lapse: 0.25, at_risk: 0.1 },
  /** Stage dwell DAYS (ranges [min,max]); the post-pass samples within, keeping each deal monotonic + past. */
  dwell: {
    toPreviewFinal: [3, 21] as [number, number],
    toPaymentArrived: [2, 10] as [number, number],
    toSigned: [1, 7] as [number, number],
    toConfirm: [0, 4] as [number, number],
  },
  /** Price range (USD) for sampled offers — realistic Pattaya off-plan studio/1-bed band. */
  priceUsd: [68000, 240000] as [number, number],
  /** CATALOG TEXTURE. Share of each building's OPEN-eligible inventory a developer withholds
 * off-market (the operator catalog fact: ~30% held for family/friends/phase-2 pricing —
 * #3). Deterministic pick; only touches units left OPEN/UNSTAMPED after the deal pass (anti-fraud —
   *  never withholds a held/sold unit). 0 disables. */
  offMarketShare: 0.3,
} as const;

// Developer → the buildings that developer owns (account handles, matching buildPlan's original comments).
// Used by the generator to spread deals across every developer/building. Agencies/agents resolve dynamically
// (agencyOf) so we only list agent handles; each agent's agency must have a gate+agreement for commission.
const DEV_BUILDINGS: Record<string, string[]> = {
  "vvv-dev-01.testnet": ["miracle-tower", "oceanview", "skyline-tower"],
  "vvv-dev-02.testnet": ["parkgate", "palmgate", "gardengate"],
  "vvv-dev-03.testnet": ["garden-court", "northpoint", "southbay"],
};
const DIRECT_VISIBLE = ["miracle-tower", "parkgate", "garden-court"]; // directSale.visible (probed)
// Display brand + house-org for each demo developer — so a fresh reseed registers them off-chain completely
// . Legal "Ltd." names live in DEV_LEGAL_NAMES; these are the short display names shown in the UI.
const DEV_DISPLAY_NAMES: Record<string, string> = {
  "vvv-dev-01.testnet": "Summit Estates",
  "vvv-dev-02.testnet": "Meridian Developments",
  "vvv-dev-03.testnet": "Vetta Group",
};
const DEV_HOUSE_ORGS: Record<string, string> = {
  "vvv-dev-01.testnet": "summit-house.testnet",
};
const AGENTS = [
  "sav-agent-1.testnet", "sav-agent-2.testnet", "bm-agent-1.testnet", "bm-agent-2.testnet",
  "ns-agent-1.testnet", "pr-agent-1.testnet", "jump-agent-1.testnet",
];

// Deterministic synthetic buyer-account handles beyond the fixed BUYER_ACCOUNTS list, so a 48-deal plan has
// enough distinct wallets (and repeat investors can reuse a few). Two-word, non-identifiable (same spirit as
// BUYER_ACCOUNTS). Generated from a fixed word list so a re-run is byte-identical.
const ACC_A = ["quiet", "amber", "slate", "copper", "harbor", "violet", "cedar", "ivory", "umber", "pale", "russet", "glass", "jade", "coral", "onyx", "linen", "ember", "frost", "sable", "dune"];
const ACC_B = ["harbor", "finch", "meadow", "wren", "lantern", "ridge", "moth", "kestrel", "solstice", "atlas", "anchor", "sparrow", "willow", "cove", "spire", "heron", "cipher", "lark", "vale", "reef"];
function synthAccount(n: number): string {
  return `${ACC_A[n % ACC_A.length]}-${ACC_B[(n * 7 + 3) % ACC_B.length]}.testnet`;
}

const rngInt = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const rngPick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
function pickOutcome(rng: () => number): DealSchedule["outcome"] {
  const r = rng();
  const o = DISTRIBUTIONS.outcomes;
  if (r < o.close) return "close";
  if (r < o.close + o.progress) return "progress";
  if (r < o.close + o.progress + o.lapse) return "lapse";
  return "at_risk";
}
// Map an outcome → how far the S&P machine is driven + whether it's confirmed.
function outcomeToStage(outcome: DealSchedule["outcome"]): { target: OfferSpec["target"]; confirmed: boolean } {
  switch (outcome) {
    case "close": return { target: "signed", confirmed: true };
    case "at_risk": return { target: "signed", confirmed: true }; // confirmed, but a default is served later (termination arc)
    case "progress": return { target: "final", confirmed: false }; // prospective: advancing, not yet closed
    case "lapse": return { target: "preview", confirmed: false }; // stalled early, never confirmed
  }
}

// ── The count-parametric run plan ────────────────────────────────────────────────────────────────
// Grows the old fixed-12 plan into a generator over DISTRIBUTIONS. `count` deals (default 48) are spread
// across all 3 developers / their buildings / the agent roster, sampling archetype + outcome + arrival +
// dwell deterministically from the seeded RNG. A handful are DIRECT-funnel buyers (desk path); the rest are
// agent offers. Repeat investors reuse a few accounts across buildings (multi-unit buyers). Unit assignment
// (distinct per building) + agency/baseline wiring happen later in runSeedFunnel, unchanged.
function buildPlan(count: number = 48): BuyerSpec[] {
  const rng = mulberry32(SEED_RNG_CONSTANT);
  const specs: BuyerSpec[] = [];
  const devs = Object.keys(DEV_BUILDINGS);

  // Pre-choose the opening-event arrival dates (shared by the deals assigned to each event).
  const [evLo, evHi] = DISTRIBUTIONS.openingEvents.windowDays;
  const eventDates: number[] = [];
  for (let e = 0; e < DISTRIBUTIONS.openingEvents.count; e++) eventDates.push(rngInt(rng, evLo, evHi));
  const perEvent = Math.round(count * DISTRIBUTIONS.openingEvents.sharePerEvent);

  // Repeat-investor accounts: a small pool that gets reused across several deals (multi-unit buyers).
  const investorPool = Array.from({ length: DISTRIBUTIONS.repeatInvestorAccounts }, (_, k) => synthAccount(1000 + k));

  // ~4 direct-funnel buyers resting across the funnel stages (desk path), on directSale-visible buildings.
  const funnelStages: BuyerFunnelState[] = ["new", "in_conversation", "units_opened", "offer_eligible"];
  for (let d = 0; d < 4 && d < count; d++) {
    const arrival = rngInt(rng, 10, DISTRIBUTIONS.arrivalWindowDays);
    specs.push({
      kind: "direct",
      account: synthAccount(500 + d),
      building: DIRECT_VISIBLE[d % DIRECT_VISIBLE.length],
      target: funnelStages[d],
      schedule: { arrivalDaysAgo: arrival, dwell: {}, archetype: "expo_lead", outcome: "progress" },
    });
  }

  // The rest are agent offers.
  const offerCount = count - specs.length;
  for (let i = 0; i < offerCount; i++) {
    const developer = devs[i % devs.length];
    const building = rngPick(rng, DEV_BUILDINGS[developer]);
    const agent = rngPick(rng, AGENTS);
    const outcome = pickOutcome(rng);
    const { target, confirmed } = outcomeToStage(outcome);

    // Archetype + arrival: some deals cluster on an opening-event date; some are expo leads / opportunistic;
    // the rest trickle. Opening-event deals share a date and skew to lapse (refundable small deposit).
    let archetype: DealSchedule["archetype"];
    let arrivalDaysAgo: number;
    if (i < perEvent * eventDates.length) {
      archetype = "opening_event";
      arrivalDaysAgo = eventDates[i % eventDates.length];
    } else {
      const r = rng();
      if (r < DISTRIBUTIONS.expoLeadShare) archetype = "expo_lead";
      else if (r < DISTRIBUTIONS.expoLeadShare + DISTRIBUTIONS.opportunisticShare) archetype = "opportunistic";
      else archetype = i % 5 === 0 && investorPool.length ? "repeat_investor" : "trickle";
      // Weight arrivals slightly toward recent (a growing operation): square-bias toward smaller days-ago.
      const u = rng() * rng(); // product of two uniforms skews small
      arrivalDaysAgo = Math.max(5, Math.round(u * DISTRIBUTIONS.arrivalWindowDays));
    }

    const account =
      archetype === "repeat_investor"
        ? investorPool[i % investorPool.length]
        : synthAccount(i);

    const dwell: DealSchedule["dwell"] = {
      toConfirm: rngInt(rng, DISTRIBUTIONS.dwell.toConfirm[0], DISTRIBUTIONS.dwell.toConfirm[1]),
      toPreviewFinal: rngInt(rng, DISTRIBUTIONS.dwell.toPreviewFinal[0], DISTRIBUTIONS.dwell.toPreviewFinal[1]),
      toPaymentArrived: rngInt(rng, DISTRIBUTIONS.dwell.toPaymentArrived[0], DISTRIBUTIONS.dwell.toPaymentArrived[1]),
      toSigned: rngInt(rng, DISTRIBUTIONS.dwell.toSigned[0], DISTRIBUTIONS.dwell.toSigned[1]),
    };
    const priceUsd = rngInt(rng, DISTRIBUTIONS.priceUsd[0], DISTRIBUTIONS.priceUsd[1]);

    specs.push({
      kind: "offer",
      account,
      agent,
      developer,
      building,
      unitId: "", // resolved per-building (distinct) in runSeedFunnel
      priceUsd,
      target,
      confirmed,
      schedule: { arrivalDaysAgo, dwell, archetype, outcome },
    });
  }

  return specs;
}

// Legacy fixed plan kept for reference/fallback (the original hand-authored 12). Not called by
// default; buildPlan(count) above supersedes it. Preserved so a reviewer can diff the generator's output
// shape against the known-good hand plan if a distribution ever looks wrong.
function buildPlanFixed(): BuyerSpec[] {
  const B = BUYER_ACCOUNTS;
  return [
    // ── DIRECT funnel track: one buyer resting at each stage, across developers ──
    { kind: "direct", account: B[0], building: "miracle-tower", target: "new" },
    { kind: "direct", account: B[1], building: "miracle-tower", target: "in_conversation" },
    { kind: "direct", account: B[2], building: "parkgate", target: "units_opened" },
    { kind: "direct", account: B[3], building: "garden-court", target: "offer_eligible" },

    // ── AGENT offer track: spread stages × developers × agencies ──
    // Summit / Seaview (miracle-tower @3%): a fully signed + confirmed sale.
    { kind: "offer", account: B[4], agent: "sav-agent-1.testnet", developer: "vvv-dev-01.testnet", building: "miracle-tower", unitId: "", priceUsd: 142000, target: "signed", confirmed: true },
    // Summit / Big Mango (miracle-tower @4%): confirmed, paperwork at payment_arrived.
    { kind: "offer", account: B[5], agent: "bm-agent-1.testnet", developer: "vvv-dev-01.testnet", building: "miracle-tower", unitId: "", priceUsd: 168000, target: "payment_arrived", confirmed: true },
    // Summit / North Shore (oceanview @3%): final, not yet confirmed (prospective commission).
    { kind: "offer", account: B[6], agent: "ns-agent-1.testnet", developer: "vvv-dev-01.testnet", building: "oceanview", unitId: "", priceUsd: 99000, target: "final", confirmed: false },
    // Summit / Seaview (oceanview @3.5%): just booked, preview.
    { kind: "offer", account: B[7], agent: "sav-agent-2.testnet", developer: "vvv-dev-01.testnet", building: "oceanview", unitId: "", priceUsd: 121000, target: "preview", confirmed: false },
    // Parkgate City / Big Mango (parkgate): harness establishes the agreement+baseline; signed + confirmed.
    { kind: "offer", account: B[8], agent: "bm-agent-2.testnet", developer: "vvv-dev-02.testnet", building: "parkgate", unitId: "", priceUsd: 205000, target: "signed", confirmed: true },
    // Parkgate City / Metro Realty (palmgate): confirmed, payment_arrived.
    { kind: "offer", account: B[9], agent: "sav-agent-1.testnet", developer: "vvv-dev-02.testnet", building: "palmgate", unitId: "", priceUsd: 178000, target: "payment_arrived", confirmed: true },
    // Vetta / Pattaya Realty (garden-court): signed + confirmed.
    { kind: "offer", account: B[10], agent: "pr-agent-1.testnet", developer: "vvv-dev-03.testnet", building: "garden-court", unitId: "", priceUsd: 88000, target: "signed", confirmed: true },
    // Vetta / Jump Estate (northpoint): final, not confirmed.
    { kind: "offer", account: B[11], agent: "jump-agent-1.testnet", developer: "vvv-dev-03.testnet", building: "northpoint", unitId: "", priceUsd: 74000, target: "final", confirmed: false },
  ];
}

// Pick a real unit id from a building's inventory by INDEX — the on-chain status is stubbed, so any real
// unit id is fine; we just need it to exist so display/joins resolve. The index lets two offers in the SAME
// building land on DISTINCT units (n=0,1,2,…) instead of both defaulting to inventory[0] — without which
// every booking in a building collided on unit-101 (finding #2). Clamps to the last unit if a building
// somehow has fewer units than offers (keeps the seed resilient rather than returning null).
async function nthUnitId(building: string, n: number): Promise<string | null> {
  const bld = await getBuilding(building);
  const inv = bld?.inventory ?? [];
  if (inv.length === 0) return null;
  return inv[Math.min(n, inv.length - 1)]?.id ?? null;
}

// ── CATALOG TEXTURE — populate the two EXISTING off-chain subsystems the seed never fed ────────
// The off-market machinery (lib/offmarket) and the build-state fork (resolveBuildState reads
// Building.project.status → S&P clause set) both already exist and are CONSUMED; the seed just left
// every building default off_plan and every unit on-market. This pass fills that gap so the demo world reads
// like the real the operator catalog market (thai-offplan-market-patterns #3/#7). It is IDEMPOTENT (pure overwrite of
// project.status; skips units already off-market) and MUST run AFTER the deal loop so withholding only ever
// touches units left OPEN/UNSTAMPED — honouring the anti-fraud guard (never hide a held/sold unit).
//
// "Oldest launch-era = ready": the oldest developer's launch era is `complete` (the Paradise
// analogue), mid era `building`, newest `planning`. DEV_BUILDINGS is ordered oldest→newest (dev-01 first),
// matching the by-developer launch-era clustering the date post-pass applies (backfill-dates launchDates).
// Exactly ONE building is the ready analogue: the oldest developer's FIRST building.
const DEV_ORDER = Object.keys(DEV_BUILDINGS); // oldest → newest launch era (dev-01, dev-02, dev-03)
export function projectStatusFor(building: string): "planning" | "building" | "complete" {
  const devIdx = DEV_ORDER.findIndex((d) => DEV_BUILDINGS[d].includes(building));
  if (devIdx < 0) return "building"; // not a seed building — leave a neutral off-plan stage
  // Oldest developer's FIRST building = the single ready analogue; its siblings are late-stage "building".
  if (devIdx === 0) return DEV_BUILDINGS[DEV_ORDER[0]][0] === building ? "complete" : "building";
  return devIdx === 1 ? "building" : "planning"; // mid era still building; newest era just planning
}

/** Deterministic Fisher-Yates pick of ~`share` of `items` using the seeded `rng`. Pure (no I/O) so the
 *  withholding selection can be unit-tested without touching the catalog store. */
export function pickWithheld<T>(items: readonly T[], share: number, rng: () => number): T[] {
  const target = Math.round(items.length * share);
  const shuffled = [...items];
  for (let k = shuffled.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
  }
  return shuffled.slice(0, target);
}

/** The seeded RNG stream the catalog-texture withholding uses (exported so a test is byte-identical). */
export const textureRng = () => mulberry32(SEED_RNG_CONSTANT ^ 0x7e);

async function applyCatalogTexture(log: (n: string) => void): Promise<void> {
  const rng = textureRng(); // own stream so it can't perturb the deal RNG
  let statuses = 0;
  let withheld = 0;
  for (const dev of DEV_ORDER) {
    for (const building of DEV_BUILDINGS[dev]) {
      const bld = await getBuilding(building);
      if (!bld) continue;

      // SELF-RESET first (true idempotency): --fresh deliberately never wipes the catalog (backfill-dates
      // freshWipeSeedRows leaves it untouched), so without this a re-run would compound texture onto an
      // already-textured catalog. We clear ONLY what THIS pass writes: our executive-hold off-market state
      // applied `by` a seed developer. A hand-made block (any other `by`/category) is left intact.
      for (const u of bld.inventory) {
        if (u.offMarket && u.offMarket.by === dev && u.offMarket.category === "executive-hold") {
          u.offMarket = undefined;
        }
      }

      // 1) project.status — pure overwrite (idempotent). Keep the rest of the project record intact.
      const status = projectStatusFor(building);
      bld.project = { ...(bld.project ?? {}), status };
      statuses++;

      // 2) off-market withholding — only units currently OPEN/UNSTAMPED on-chain. Deterministic ~share.
      const snap = await getBuildingSnapshot(building);
      const liveStatus = (uid: string) => snap?.units?.[uid] ?? UNSTAMPED;
      const eligible = bld.inventory.filter(
        (u) => !u.offMarket && (liveStatus(u.id) === OPEN || liveStatus(u.id) === UNSTAMPED)
      );
      // Deterministic selection (shared pure helper, unit-tested): ~share of the OPEN-eligible units.
      for (const u of pickWithheld(eligible, DISTRIBUTIONS.offMarketShare, rng)) {
        u.offMarket = applyOffMarket(u.offMarket, "blocked", {
          reason: "Held off-market by the developer (phase-2 release / reserved).",
          category: "executive-hold",
          by: dev,
          at: Date.now(),
        });
        withheld++;
      }
      await saveBuilding(bld);
    }
  }
  log(`catalog texture: set project.status on ${statuses} buildings, withheld ${withheld} units off-market (${Math.round(DISTRIBUTIONS.offMarketShare * 100)}% of open inventory).`);
}

// ── DEV-KEY OWNER SLICE (Finding B fix) ─────────────────────────────────────────────────────
// The problem (Finding B): the god-mode LOCAL SIGNER can only BECOME the four provisioned localnet
// accounts — node / org / agent / buyer `.test.near` — but ALL seeded `.data` is owned by `vvv-dev-*.testnet`
// + synthetic two-word handles. So walking the real UI as a dev-key account landed on an EMPTY dashboard: a
// dev-harness namespace mismatch, not a product bug. the fix (close): ADD the `.test.near` accounts as
// OWNERS of a small, self-contained seeded slice (its OWN new catalog building — add, never reassign a vvv-
// building) + the org/agent/agreement wiring so commission resolves + a few buyers — while KEEPING the rich
// vvv- world intact for the judge demo.
//
// WHY A SEPARATE PASS (not folded into DEV_BUILDINGS/AGENTS): running AFTER runSeedFunnel's generator keeps the
// vvv- world's seeded RNG + deal distribution BYTE-IDENTICAL (the slice can't perturb the judge world), and the
// slice is self-contained + idempotent (own building id, own agreement, fixed buyer handles). It drives the
// SAME real code paths as the main seed (ensureVrxAgreement / ensureBaseline / ensureAgreement / recordOffer /
// driveOffer helpers), so the dev-key dashboards light up the honest way — not hand-written stage rows.
//
// NAMESPACE: the four accounts match scripts/provision-localnet.mjs (node/org/agent/buyer.test.near). This runs
// on localnet AND testnet seeds alike (it only writes .data + stubs the chain); the accounts just happen to be
// the ones god-mode can impersonate. PRIVACY: synthetic PII only, nothing broadcast (ChainStub).

export const DEV_KEY_DEVELOPER = "node.test.near";
export const DEV_KEY_AGENCY = "org.test.near";
export const DEV_KEY_AGENT = "agent.test.near";
export const DEV_KEY_BUYER = "buyer.test.near";
export const DEV_KEY_BUILDING = "dev-tower";
// The dev-key developer's house org (for a direct buyer's firm-hold). Distinct from the agency.
const DEV_KEY_HOUSE_ORG = "node-house.test.near";

// Build the dev-key developer's OWN catalog building — small (~10 units) but schema-complete, so every
// dashboard the dev-walk visits (developer inventory/pricing, agent browse, buyer funnel) reads real data.
// Shape mirrors a real imported building (oceanview) so all consumers (terms editor, S&P, quota, directSale)
// resolve; identity + inventory are fresh. Idempotent: a re-run overwrites this one building by id, untouched
// elsewhere. Units carry distinct ids/prices/specs so two bookings never collide on one unit (finding #2).
function buildDevTower(): Building {
  const unitTypes = [
    { key: "studio", label: "Studio", sqmMin: 28, sqmMax: 34 },
    { key: "1br", label: "1 Bedroom", sqmMin: 38, sqmMax: 52 },
  ];
  const terms = {
    bookingFee: [500, 1000],
    depositPct: [0.5, 1],
    onContract: [{ installments: 1, amountPct: 25 }, { installments: 1, amountPct: 30 }],
    ongoing: [{ installments: 24, amountPct: 1 }, { installments: 12, amountPct: 2 }],
    frequencyDays: [30, 60],
    onKeyPct: [50, 45],
    taxPct: [0],
    contractDays: 7,
    caps: {
      depositPctMin: 0.5, depositPctMax: 5, onContractPctMin: 10, onContractPctMax: 40,
      onKeyPctMin: 30, onKeyPctMax: 60, instalmentsMin: 1, instalmentsMax: 48,
    },
  };
  // 10 units: floors 1–5, two per floor; alternating studio/1br; clean demo prices.
  const inventory: Unit[] = [];
  for (let f = 1; f <= 5; f++) {
    for (let s = 0; s < 2; s++) {
      const num = f * 100 + 1 + s;
      const isStudio = (f + s) % 2 === 0;
      const sqm = isStudio ? 30 + s : 44 + s * 2;
      const priceUsd = isStudio ? 72000 + f * 1500 : 96000 + f * 2000;
      inventory.push({
        id: `unit-${num}`,
        type: isStudio ? "studio" : "1br",
        floor: f,
        sqm,
        priceUsd,
        pricing: { freeholdUsd: priceUsd, companyUsd: Math.round(priceUsd * 0.94) },
        unitNumber: num,
        subtype: s === 0 ? "A" : "B",
        view: s === 0 ? "City view" : "Pool view",
        corner: s === 0,
        baths: 1,
        note: s === 0 ? "City view, Corner" : "Pool view",
        sqmStages: { beforeBuilding: sqm, afterBuilding: sqm },
      });
    }
  }
  return {
    id: DEV_KEY_BUILDING,
    name: "Dev Tower",
    tagline: "The dev-signer demo building",
    developer: "Dev Signer Developments",
    area: "southbay",
    address: "southbay Beach Road Soi 7",
    type: "High Rise",
    stories: 5,
    units: inventory.length,
    reservationFeeUsd: 300,
    maintenancePerSqmUsd: 1.4,
    bookingDepositUsd: 300,
    sinkingFundPerSqmUsd: 15,
    transferFeePct: "6.30%",
    constructionEnd: "2027-06-30",
    amenities: ["Rooftop Pool", "Fitness Center", "Co-working Lounge", "Car Parking", "24-hour Security", "CCTV"],
    completion: "Under construction",
    unitTypes,
    inventory,
    terms,
    sellableSqm: 900,
    foreignQuotaPct: 49,
    stage: "presale",
    foreignSoldSqm: 0,
    foreignCommittedSqm: 0,
    localSoldSqm: 0,
    quotaLabels: { freehold: "Freehold", company: "Company", private: "Private" },
    project: { status: "building" },
    directSale: {
      visible: true,
      funnelCopy:
        "Dev Tower is the god-mode demo building: a compact southbay high-rise of studios and one-bedrooms used to " +
        "exercise the full VRX funnel as the dev-signer developer. Finished off-plan pricing, real units, real flow.",
    },
    geo: { lat: 12.8902, lng: 100.8712, label: "Dev Tower" },
  };
}

// Build a tiny VALID PNG (solid RGB canvas) with no external deps — used as a NON-identifiable placeholder
// for the dev-key buyer's KYC vault docs (selfie + passport). Deliberately NOT a real person's photo (the
// privacy moat): a synthetic coloured tile is enough to exercise the vault's encrypt/store/read path + the
// dev-walk's "already uploaded" view, without introducing any real PII image. CRC via the standard PNG table.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = truecolour RGB
  // rows: each prefixed by filter byte 0, then w*3 RGB bytes.
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0];
    row[1 + x * 3 + 1] = rgb[1];
    row[1 + x * 3 + 2] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Seed the DEV-KEY owner slice: make node/org/agent/buyer.test.near own a real, self-contained
 * corner of the world so the god-mode LOCAL SIGNER can walk populated dashboards as each of them. Idempotent +
 * additive; drives the SAME real code paths + ChainStub as runSeedFunnel. Returns a compact report folded into
 * the parent SeedReport's notes. ALWAYS runs after the vvv- generator so it can't perturb that world's RNG.
 */
async function seedDevKeySlice(chain: ChainStub, holes: Hole[], notes: string[]): Promise<{
  offersCreated: number;
  directCreated: number;
  commissionsResolved: number;
  dated: DatedTarget[];
}> {
  const note = (n: string) => notes.push(`dev-key slice: ${n}`);
  const dated: DatedTarget[] = [];
  let offersCreated = 0;
  let directCreated = 0;
  let commissionsResolved = 0;

  // 0) VET the dev-key actors (STEP 1) before any agreement is signed below — same reason as the main
  //    seed: proposeAgreement folds identity at propose-time. node/org/agent.test.near each get a vetted
  //    profile so the dev-key agreements seal with real legal names, not "(identity not yet vetted)".
  await vetActors([DEV_KEY_DEVELOPER], "developer", devLegalName, note);
  await vetActors([DEV_KEY_AGENCY], "agency", agencyLegalName, note);
  await vetActors([DEV_KEY_AGENT], "agent", agentLegalName, note);

  // 1) The developer owns its own building (add to catalog) + is registered off-chain with a house org so a
  //  direct buyer's firm-hold has somewhere to grant. directSaleThresholdUsd low so buyer.test.near
  //    (modest demo balance) clears the eligibility bar.
  await saveBuilding(buildDevTower());
  const existingDev = await getDeveloper(DEV_KEY_DEVELOPER);
  await saveDeveloper({
    account: DEV_KEY_DEVELOPER,
    name: "Dev Signer Developments",
    buildingIds: [DEV_KEY_BUILDING],
    houseOrgAccount: DEV_KEY_HOUSE_ORG,
    directSaleThresholdUsd: 1, // $1 bar — any funded dev buyer clears it (localnet throwaway balances)
    ...(existingDev ? {} : {}),
  });
  note(`developer ${DEV_KEY_DEVELOPER} owns ${DEV_KEY_BUILDING} (${buildDevTower().inventory.length} units)`);

  // 1b) OPEN the slate on-chain-mirror: mark every dev-tower unit `open` (0) in the status snapshot so the
  //     building shows real AVAILABILITY (the developer card's "N available", the agent browse, the buyer's
  //     price-unlock). ensureBaseline writes this slate only when it FIRST creates the baseline (a one-time
  //     side effect); on a re-seed it short-circuits on the existing baseline, so without this explicit write
  //  a re-run left every unit UNSTAMPED (-1) → "0 available" (live-walk finding). We only open units
  //     NOT already sold/held/closed (1/2/3) so a re-run never un-sells a confirmed booking — idempotent and
  //     order-safe (the confirmed offers below flip their units to closed AFTER this).
  {
    const bld = buildDevTower();
    const prior = (await getBuildingSnapshot(DEV_KEY_BUILDING))?.units ?? {};
    const slate: Record<string, number> = {};
    for (const u of bld.inventory) {
      const cur = prior[u.id];
      slate[u.id] = cur === 1 || cur === 2 || cur === 3 ? cur : 0; // keep sold/held/closed; open the rest
    }
    await saveBuildingStatuses(DEV_KEY_BUILDING, slate, { complete: true });
    invalidateSnapshotMemo();
  }

  // 2) The developer SIGNS the VRX agreement (signing precedes listing, §7) + establishes the baseline
  //    (so prospective + confirmed commission can resolve). Same real seams the main seed uses.
  await ensureVrxAgreement(DEV_KEY_DEVELOPER, [DEV_KEY_BUILDING], note);
  await ensureBaseline(DEV_KEY_DEVELOPER, DEV_KEY_BUILDING, note);

  // 3) Wire the agency: org.test.near gets an ACTIVE gate to the developer + a live commission agreement on the
  //    building, and agent.test.near is recorded as its agent (so agencyOf resolves → commission can earn).
  await recordGate(DEV_KEY_DEVELOPER, DEV_KEY_AGENCY, true);
  await ensureAgreement(DEV_KEY_DEVELOPER, DEV_KEY_AGENCY, DEV_KEY_BUILDING, 3, note);
  await recordAgent(DEV_KEY_AGENT, DEV_KEY_AGENCY);
  note(`agency ${DEV_KEY_AGENCY} gated+agreed on ${DEV_KEY_BUILDING}; agent ${DEV_KEY_AGENT} registered`);

  // 4) A few AGENT offers by agent.test.near at a spread of stages, so the agent's "My bookings" + the
  //    developer's inbox + commission all populate. Distinct units (unit cursor). Two confirmed (earn), one
  //    prospective (not yet confirmed). Driven through the real driveOffer helper (same as the main seed).
  const devUnits = buildDevTower().inventory.map((u) => u.id);
  const offerSpecs: OfferSpec[] = [
    { kind: "offer", account: DEV_KEY_BUYER, agent: DEV_KEY_AGENT, developer: DEV_KEY_DEVELOPER, building: DEV_KEY_BUILDING, unitId: devUnits[0], priceUsd: 118000, target: "signed", confirmed: true,
      schedule: { arrivalDaysAgo: 120, dwell: { toPreviewFinal: 7, toPaymentArrived: 5, toSigned: 3, toConfirm: 2 }, archetype: "opening_event", outcome: "close" } },
    { kind: "offer", account: "jade-willow.testnet", agent: DEV_KEY_AGENT, developer: DEV_KEY_DEVELOPER, building: DEV_KEY_BUILDING, unitId: devUnits[1], priceUsd: 86000, target: "payment_arrived", confirmed: true,
      schedule: { arrivalDaysAgo: 60, dwell: { toPreviewFinal: 5, toPaymentArrived: 4, toConfirm: 1 }, archetype: "expo_lead", outcome: "progress" } },
    { kind: "offer", account: "onyx-heron.testnet", agent: DEV_KEY_AGENT, developer: DEV_KEY_DEVELOPER, building: DEV_KEY_BUILDING, unitId: devUnits[2], priceUsd: 99000, target: "final", confirmed: false,
      schedule: { arrivalDaysAgo: 20, dwell: { toPreviewFinal: 4 }, archetype: "opportunistic", outcome: "lapse" } },
  ];
  for (let k = 0; k < offerSpecs.length; k++) {
    const spec = offerSpecs[k];
    const offer = await driveOffer(spec, 9000 + k, chain, holes, notes);
    if (offer) {
      offersCreated++;
      if (spec.schedule) dated.push({ kind: "offer", key: offer.requestId, developer: spec.developer, building: spec.building, schedule: spec.schedule });
      const c = await resolveSaleCommission(offer);
      if (c) commissionsResolved++;
      else if (spec.confirmed) {
        holes.push({ where: `dev-key commission/${offer.requestId.slice(0, 8)}`, promise: "a CONFIRMED dev-key sale earns commission", brokenBy: "resolveSaleCommission returned null" });
      }
    }
  }

  // 5) A DIRECT-funnel buyer on the dev building so the developer's desk + direct-buyer views populate, and so
  //    walking the UI as buyer.test.near has a live desk conversation to see. Driven through driveDirect (real
  //    funnel), then granted one unit so the buyer's "opened units" view is non-empty.
  const directSpec: DirectSpec = {
    kind: "direct", account: DEV_KEY_BUYER, building: DEV_KEY_BUILDING, target: "offer_eligible",
    schedule: { arrivalDaysAgo: 30, dwell: {}, archetype: "expo_lead", outcome: "progress" },
  };
  const convId = await driveDirect(directSpec, 9100, holes, notes);
  if (convId) {
    directCreated++;
    dated.push({ kind: "direct", key: convId, developer: "", building: DEV_KEY_BUILDING, schedule: directSpec.schedule! });
    // Open one specific unit to the buyer (anti-browsing funnel) so "opened units" is populated.
    const openUnit = devUnits[devUnits.length - 1]; // a unit distinct from the agent-booked ones
    const grant = await grantUnit(DEV_KEY_BUYER, DEV_KEY_BUILDING, openUnit, DEV_KEY_DEVELOPER);
    if (!grant) note(`grantUnit refused for ${DEV_KEY_BUYER} on ${openUnit}`);
  }

  // 6) KYC VAULT docs (: "buyer should have own selfie and passport photo"). Seed a SELFIE (headshot)
  //    + a PASSPORT into buyer.test.near's own vault through the REAL addBuyerDoc encrypt path — so the dev-walk
  //    sees the "already uploaded" view, and the encrypt→store→read-back seam is exercised. The images are
  //  synthetic solid-colour PNGs, NOT a real person's photo (privacy moat — never seed real PII imagery).
  //    Idempotent: addBuyerDoc replaces one-per-kind, so a re-run overwrites rather than piling up. The vault
  //    auto-unlocks in dev (kyc-vault-key dev deterministic operator key); if somehow locked, we record a hole.
  try {
    const existing = await getBuyerVault(DEV_KEY_BUYER);
    const haveSelfie = existing?.docs.some((d) => d.kind === "headshot");
    const havePassport = existing?.docs.some((d) => d.kind === "passport");
    if (!haveSelfie) {
      await addBuyerDoc(DEV_KEY_BUYER, "headshot", { bytes: solidPng(64, 64, [60, 110, 180]), filename: "selfie.png", mime: "image/png" });
    }
    if (!havePassport) {
      await addBuyerDoc(DEV_KEY_BUYER, "passport", { bytes: solidPng(96, 64, [150, 120, 70]), filename: "passport.png", mime: "image/png" });
    }
    note(`vault: ${DEV_KEY_BUYER} has selfie (headshot) + passport doc (synthetic placeholder PNGs, encrypted)`);
  } catch (e) {
    holes.push({ where: `dev-key vault/${DEV_KEY_BUYER}`, promise: "a buyer can store a selfie + passport in their own encrypted vault", brokenBy: `addBuyerDoc threw: ${(e as Error).message}` });
  }

  note(`${offersCreated} offer(s), ${directCreated} direct buyer, ${commissionsResolved} commission(s) resolved.`);
  return { offersCreated, directCreated, commissionsResolved, dated };
}

// ── FURNITURE PACKS — the one rich-world subsystem the main seed never fed ────────────────────
// Furniture packs are developer-GLOBAL, reusable assets (lib/furniture-packs) attached to any number of
// buildings; the S&P generator resolves a building's packs and prices each per-unit from m² (lib/furniture).
// The seed used to leave furniture-packs.json empty (planFor hardcodes furnitureUsd:0), so the demo's "furnished
// package" line never populated. This pass authors a realistic set via the REAL savePack path — same seam the
// /node furniture UI calls — so the packages show up authentically. IDEMPOTENT: each pack carries a FIXED id
// (`seed-fp-*`) so a re-run OVERWRITES rather than piling up. Off-chain, commercial (not PII). Grounded
// the real Thai off-plan market: developers offer tiered fitted/furnished packages, priced per m² (the bigger
// the unit, the more furniture), with a few flat add-ons (appliance bundle, curtains/blinds).
//
// Attached by developer so each dev's buildings get a coherent menu (dev-01 = premium brand, dev-02 = mid,
// dev-03 = value) + the dev-key "Dev Tower" gets its own pair so the god-mode walk sees furniture too.
type SeedPack = { id: string; label: string; items: Array<{ label: string; basis: "per_sqm"; ratePerSqmUsd: number } | { label: string; basis: "flat"; priceUsd: number }>; buildings: string[] };

function furniturePlanFor(developer: string): SeedPack[] {
  const d = developer.trim().toLowerCase();
  if (d === "vvv-dev-01.testnet") {
    const all = DEV_BUILDINGS["vvv-dev-01.testnet"];
    return [
      { id: "seed-fp-01-essential", label: "Essential Fitted Package", buildings: all, items: [
        { label: "Built-in wardrobe + kitchen cabinetry", basis: "per_sqm", ratePerSqmUsd: 210 },
        { label: "Appliance bundle (hob, hood, fridge, washer)", basis: "flat", priceUsd: 3200 },
        { label: "Curtains & blinds throughout", basis: "flat", priceUsd: 1100 },
      ] },
      { id: "seed-fp-01-premium", label: "Premium Furnished Package", buildings: all, items: [
        { label: "Designer furniture, soft furnishings & lighting", basis: "per_sqm", ratePerSqmUsd: 520 },
        { label: "Full appliance & smart-home bundle", basis: "flat", priceUsd: 6800 },
        { label: "Art, rugs & styling", basis: "flat", priceUsd: 2400 },
      ] },
    ];
  }
  if (d === "vvv-dev-02.testnet") {
    const all = DEV_BUILDINGS["vvv-dev-02.testnet"];
    return [
      { id: "seed-fp-02-comfort", label: "Comfort Furnished Package", buildings: all, items: [
        { label: "Furniture set (bed, sofa, dining, storage)", basis: "per_sqm", ratePerSqmUsd: 330 },
        { label: "Kitchen appliance bundle", basis: "flat", priceUsd: 2600 },
      ] },
    ];
  }
  if (d === "vvv-dev-03.testnet") {
    const all = DEV_BUILDINGS["vvv-dev-03.testnet"];
    return [
      { id: "seed-fp-03-starter", label: "Starter Furnished Package", buildings: all, items: [
        { label: "Essential furniture & white goods", basis: "per_sqm", ratePerSqmUsd: 185 },
        { label: "Curtains & lighting", basis: "flat", priceUsd: 800 },
      ] },
    ];
  }
  if (d === DEV_KEY_DEVELOPER) {
    return [
      { id: "seed-fp-dev-fitted", label: "Dev Tower Fitted Package", buildings: [DEV_KEY_BUILDING], items: [
        { label: "Built-in wardrobe & kitchen fit-out", basis: "per_sqm", ratePerSqmUsd: 200 },
        { label: "Appliance bundle", basis: "flat", priceUsd: 2800 },
      ] },
      { id: "seed-fp-dev-furnished", label: "Dev Tower Furnished Package", buildings: [DEV_KEY_BUILDING], items: [
        { label: "Full furniture, soft furnishings & styling", basis: "per_sqm", ratePerSqmUsd: 460 },
        { label: "Smart-home & appliance bundle", basis: "flat", priceUsd: 5200 },
      ] },
    ];
  }
  return [];
}

/** Seed furniture packs for the developers this run touched (+ the dev-key developer). Real savePack path,
 *  idempotent (fixed ids overwrite). Returns the count created/updated for the report. */
async function seedFurniturePacks(developers: string[], notes: string[]): Promise<number> {
  let n = 0;
  for (const developer of developers) {
    for (const p of furniturePlanFor(developer)) {
      try {
        await savePack(developer, { id: p.id, label: p.label, items: p.items, buildingIds: p.buildings });
        n++;
      } catch (e) {
        notes.push(`furniture pack ${p.id} for ${developer} failed: ${(e as Error).message}`);
      }
    }
  }
  if (n) notes.push(`furniture: authored/updated ${n} developer furniture pack(s) across the demo buildings.`);
  return n;
}

// ── STEP 1 of the GENESIS-WALK RESEED: VET EVERY ACTOR'S IDENTITY ────────────────────────────────────
// Root cause of "(identity not yet vetted)" on sealed agreements (verified): `proposeAgreement` folds each
// party's KYC identity at PROPOSE time via `profiles.identityForSeal`, which returns null when the account has no
// profile — and the seed never created one. So every seeded agreement labelled both parties unvetted. The fix is
// to walk the real vetting seam (`profiles.setProfile`, the root-only write path the vetting API uses) for every
// developer / agency / agent BEFORE any agreement is proposed, exactly as the real product vets an actor before
// they can sign. Invented, generic names — clearly fictional, same synthetic-PII posture as the
// buyer generator. Idempotent: setProfile is upsert-on-account; a re-run re-seals with a fresh salt (harmless).
//
// NAMES — deterministic, generic, non-identifiable (never a real firm). Developers get a known map where one
// exists (dev-01 = "Summit Estates", matching lib/developers.ts) + an invented "<Word> Developments" otherwise;
// agencies get "<Word> Realty" / "<Word> Property"; agents get an invented person name from the FIRST/LAST pools.
// All keyed off the account slug so the same actor always gets the same name (stable across re-seeds).
const DEV_LEGAL_NAMES: Record<string, string> = {
  "vvv-dev-01.testnet": "Summit Estates Ltd.",
  "vvv-dev-02.testnet": "Meridian Developments Ltd.",
  "vvv-dev-03.testnet": "Vetta Group Ltd.",
  "node.test.near": "Dev Signer Developments Ltd.",
};
const AGENCY_LEGAL_NAMES: Record<string, string> = {
  "a global agency-th.testnet": "Seaview Realty Co.",
  "big-mango.testnet": "Big Harbour Realty Co.",
  "north-shore.testnet": "North Shore Property Co.",
  "pattaya-realty.testnet": "Baytown Realty Co.",
  "jump-estate.testnet": "Leap Estate Co.",
  "org.test.near": "Signer Realty Co.",
};
// Coarse, invented operating regions (verified-at-vetting granularity — city/country, no street). Deterministic
// per account so the sealed identity is stable. Not tied to any real address in the demo.
const VET_REGIONS = ["Pattaya, Thailand", "Bangkok, Thailand", "Phuket, Thailand", "Singapore", "Dubai, UAE", "London, UK"];
function regionFor(account: string): string {
  let h = 0;
  for (let i = 0; i < account.length; i++) h = (h * 31 + account.charCodeAt(i)) >>> 0;
  return VET_REGIONS[h % VET_REGIONS.length];
}
// A stable invented person name for an agent, from the same FIRST/LAST pools the buyer generator uses, indexed by
// a hash of the account so it never collides with (or depends on) buyer ordering.
function agentLegalName(account: string): string {
  let h = 0;
  for (let i = 0; i < account.length; i++) h = (h * 131 + account.charCodeAt(i)) >>> 0;
  // Use TWO independent unsigned hashes so first/last are picked independently; `>>>` keeps it unsigned (a
  // signed `>>` on a large hash yields a negative index → undefined, the "Sofia undefined" bug).
  const h2 = (h * 2654435761) >>> 0;
  return `${FIRST[h % FIRST.length]} ${LAST[h2 % LAST.length]}`;
}
// Title-case a slug fragment (e.g. "jump-estate" → "Jump Estate") for a fallback company name.
function titleCaseSlug(account: string): string {
  return account
    .replace(/\.testnet$|\.near$|\.test$/g, "")
    .split(/[-.]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
function devLegalName(account: string): string {
  return DEV_LEGAL_NAMES[account.toLowerCase()] ?? `${titleCaseSlug(account)} Developments Ltd.`;
}
function agencyLegalName(account: string): string {
  return AGENCY_LEGAL_NAMES[account.toLowerCase()] ?? `${titleCaseSlug(account)} Realty Co.`;
}

// Vet a batch of actors (idempotent). `legalNameFor` maps the account → its invented legal/registered name.
async function vetActors(
  accounts: Iterable<string>,
  role: ProfileRole,
  legalNameFor: (account: string) => string,
  log: (n: string) => void
): Promise<number> {
  const seen = new Set<string>();
  let n = 0;
  for (const raw of accounts) {
    const account = raw.trim().toLowerCase();
    if (!account || seen.has(account)) continue;
    seen.add(account);
    // Skip if already vetted (keeps the seal/salt stable across re-seeds — a re-vet would re-salt harmlessly,
    // but leaving a prior seal untouched is cleaner and lets a partial re-run be a true no-op).
    if (await getProfile(account)) continue;
    await setProfile(
      { account, role, legalName: legalNameFor(account), region: regionFor(account) },
      { setBy: "vrx-root (seed)" }
    );
    n++;
  }
  if (n) log(`vetted ${n} ${role}(s)`);
  return n;
}

// ── STEP 2 helper: distribute $VRX treasury → developers → agencies → agents (C1/) ────────────────
// Honest off-chain credit. Grants cascade so an agent ends up funded to cover a deposit. Idempotent
// a floor check: `fundTo(account, floor, send)` tops an account UP to `floor` only if it currently holds less —
// so a re-run is a true no-op and total supply never drifts. The developer/agency pass-downs are plain holder
// transfers (dev must hold enough first, which the treasury grant guarantees).
const VRX_GRANT = {
  developer: 2_000_000, // each developer is granted 2M from the treasury
  agency: 300_000,      // each developer tops each of its agencies up to 300k
  agent: 75_000,        // each agency tops each of its agents up to 75k (enough for a deposit)
};
async function distributeVrx(
  developers: Iterable<string>,
  devAgencies: Map<string, Set<string>>,
  agencyAgents: Map<string, Set<string>>,
  log: (n: string) => void,
): Promise<void> {
  let grants = 0;
  // Top `account` UP to `floor` from `from`. operatorSend when sourced from the treasury, transfer otherwise.
  const fundTo = async (account: string, floor: number, from: string): Promise<boolean> => {
    const have = await balanceOf(account);
    if (have >= floor) return false; // already funded — idempotent no-op
    const need = floor - have;
    if (from === TREASURY_ACCOUNT) await operatorSend(account, need);
    else await transfer(from, account, need);
    grants++;
    return true;
  };
  // Treasury → each developer.
  for (const raw of developers) {
    const dev = raw.trim().toLowerCase();
    if (!dev) continue;
    await fundTo(dev, VRX_GRANT.developer, TREASURY_ACCOUNT);
    // Developer → each of its agencies.
    for (const agency of devAgencies.get(dev) ?? []) {
      await fundTo(agency.toLowerCase(), VRX_GRANT.agency, dev);
    }
  }
  // Agency → each of its agents. An agency can have agents in the plan WITHOUT a developer relationship
  // feeding it (e.g. jump-estate — an agency with a seeded agent but no dev↔agency pair), or have MORE than
  // ~4 agents (300k floor ÷ 75k = 4) so its agency grant can't cover them all. Either way the agency would
  // hold too little to transfer to its agents → "insufficient $VRX balance". Before distributing, TOP THE
  // AGENCY UP FROM THE TREASURY to at least what it must pass down (its own floor, or enough for all its
  // agents, whichever is larger). Treasury-sourced + idempotent (floor check) → conservation holds, re-run
  // is a no-op. (fix — the "--fresh is broken" crash was THIS topology gap, not the ledger reset.)
  for (const [agency, agents] of agencyAgents) {
    const agencyFloor = Math.max(VRX_GRANT.agency, agents.size * VRX_GRANT.agent);
    await fundTo(agency.toLowerCase(), agencyFloor, TREASURY_ACCOUNT);
    for (const agent of agents) {
      await fundTo(agent.toLowerCase(), VRX_GRANT.agent, agency.toLowerCase());
    }
  }
  if (grants) log(`distributed $VRX to ${grants} account(s) down the chain`);
}

// ── STEP 2b: DISTRIBUTE BOOKING TOKENS down the chain (slice) ─────────────────────────────────
// Booking tokens are VRX-root-issued reservation capacity (lib/booking-tokens); the seed never created any, so
// the whole dev→agency→agent custody flow + every token panel showed EMPTY. This mirrors distributeVrx: VRX
// issues each developer an allotment, the developer HANDS some to each gated agency, each agency HANDS some to
// its agents — all through the REAL issueTokens/transferToken paths (chain-constrained, sealed custody log), so
// the demo is populated AND the live "hand a token" action still has tokens in-hand at every level to act on.
// Economics = "permission" (a free hand — no crypto receipt needed, keeps the seed clean). Idempotent: a
// developer that already has live tokens is skipped, so a re-seed never double-issues.
//
// Per: fully cascade so developer, agency AND agent panels all populate, but leave a few in hand
// each level (even a stocked holder can still demo handing another one). The house issuance config sets an
// allotment cap generous enough for the cascade; per-token fee is 0 under the allotment model.
// Quantities (: "agency needs like 20 and each agent 3-5"). A developer issues enough to hand every
// gated agency its allotment AND keep a healthy in-hand reserve (so the live "hand another" action always has
// stock). A dev gated to up to ~3 agencies × 20 = 60 + reserve → issue 70; cap 100 clears it with headroom.
const BT_ISSUE_PER_DEV = 90;   // tokens VRX issues each developer (covers up to ~4 agencies × 20 + reserve)
const BT_HAND_TO_AGENCY = 20;  // tokens the developer hands to EACH of its agencies
const BT_HAND_TO_AGENT = 4;    // tokens each agency hands to EACH of its agents (mid of the 3–5)
const BT_ALLOTMENT_CAP = 100;  // generous house cap so the cascade never trips the scarcity guard

async function distributeBookingTokens(
  developers: Iterable<string>,
  devAgencies: Map<string, Set<string>>,
  agencyAgents: Map<string, Set<string>>,
  log: (n: string) => void,
): Promise<void> {
  // House-default issuance config (developer "*") — allotment model so issued tokens carry a 0 per-token fee and
  // the cap governs scarcity. setIssuanceConfig is idempotent (replaces the "*" row), so re-seeds are safe.
  await setIssuanceConfig({ developer: "*", model: "allotment", feeMinor: 0, currency: "USDC", allotmentCap: BT_ALLOTMENT_CAP });

  let issued = 0, handedToAgencies = 0, handedToAgents = 0;
  // Hand `count` tokens the `by` account currently HOLDS (state "issued") to `to`, as a free "permission" hand.
  const handSome = async (by: string, to: string, count: number): Promise<number> => {
    const held = (await tokensInCustody(by)).filter((t) => t.state === "issued" && t.custody.toLowerCase() === by.toLowerCase());
    let n = 0;
    for (let i = 0; i < count && i < held.length; i++) {
      try {
        await transferToken({ tokenId: held[i].id, by, to, economics: "permission" });
        n++;
      } catch {
        // illegitimate move (no gate/agency link) — skip silently; the H3-style checks elsewhere surface drift.
      }
    }
    return n;
  };

  for (const raw of developers) {
    const dev = raw.trim().toLowerCase();
    if (!dev) continue;
    // Idempotent: skip a developer that already holds live capacity (a re-seed is a no-op).
    const live = await liveTokenCount(dev);
    if (live === 0) {
      try {
        const fresh = await issueTokens(dev, BT_ISSUE_PER_DEV, { economics: "permission" });
        issued += fresh.length;
      } catch {
        /* cap/config error — skip this developer, leave others unaffected */
      }
    }
    // Developer → each of its agencies (leaves the rest in the developer's hand). transferToken's chain-
    // constraint reads the GATES store, so ensure the gate exists first (a developer handing capacity to an
    // agency has gated them anyway) — idempotent, and makes the cascade self-sufficient regardless of whether
    // the main seed recorded the gate yet.
    for (const agency of devAgencies.get(dev) ?? []) {
      const org = agency.toLowerCase();
      await recordGate(dev, org, true);
      handedToAgencies += await handSome(dev, org, BT_HAND_TO_AGENCY);
    }
  }
  // Agency → each of its agents (leaves the rest in the agency's hand). The agent↔agency link is read via
  // agencyOf (the agents store); the agencyAgents map was built from exactly that, so it's already consistent.
  for (const [agency, agents] of agencyAgents) {
    for (const agent of agents) {
      handedToAgents += await handSome(agency.toLowerCase(), agent.toLowerCase(), BT_HAND_TO_AGENT);
    }
  }
  if (issued || handedToAgencies || handedToAgents) {
    log(`booking tokens: issued ${issued} to developers, handed ${handedToAgencies} to agencies, ${handedToAgents} to agents`);
  }
}

/**
 * Run the full-funnel seed. Idempotent + additive. Returns the report (its `holes` list is the deliverable).
 * `opts.dryRun` logs the plan + would-be stub calls WITHOUT writing any .data (for a safe preview).
 * `opts.count` sizes the count-parametric backfill (default 48; a busy variant can pass 200+).
 * `opts.plan` injects a fixed plan (tests/the legacy buildPlanFixed); default = buildPlan(count).
 * `opts.devKeySlice` (default true) also seeds the dev-key owner slice so the god-mode
 *   LOCAL SIGNER's node/org/agent/buyer.test.near accounts own real, populated dashboards.
 */
export async function runSeedFunnel(opts?: { dryRun?: boolean; count?: number; plan?: BuyerSpec[]; devKeySlice?: boolean }): Promise<SeedReport> {
  const holes: Hole[] = [];
  const notes: string[] = [];
  const chain = new ChainStub();
  const plan = opts?.plan ?? buildPlan(opts?.count ?? 48);

  if (opts?.dryRun) {
    const byArch = plan.reduce<Record<string, number>>((m, s) => {
      const a = s.schedule?.archetype ?? "unscheduled";
      m[a] = (m[a] ?? 0) + 1;
      return m;
    }, {});
    notes.push(`DRY RUN — ${plan.length} buyers planned (${JSON.stringify(byArch)}); no .data written.`);
    return { directCreated: 0, offersCreated: 0, commissionsResolved: 0, stubbedCalls: [], holes, notes, dated: [] };
  }

  // Resolve real unit ids + pre-wire the money half (agreements + baselines) for each offer's (dev, building).
  // Collect every (developer → buildings) the plan touches, so each developer signs the VRX agreement with a
  // sign-off for each of their buildings before any listing is live ("signing precedes listing").
  const devBuildings = new Map<string, Set<string>>();
  const noteDevBuilding = (developer: string, building: string) => {
    const key = developer.trim().toLowerCase();
    if (!key || !building) return;
    (devBuildings.get(key) ?? devBuildings.set(key, new Set()).get(key)!).add(building);
  };
  for (const spec of plan) {
    const dev = spec.kind === "offer" ? spec.developer : undefined;
    if (dev) noteDevBuilding(dev, spec.building);
  }
  // Per-building cursor so two offers in the same building get DISTINCT units (finding #2): the first
  // offer in a building takes inventory[0], the second inventory[1], etc. — never both unit-101. Keyed by
  // building; advanced only on a successful assignment so a no-inventory hole doesn't waste an index.
  const unitCursor: Record<string, number> = {};
  // First pass: resolve units + collect every (developer, agency) → set of buildings. We establish ONE
  // agreement per pair covering ALL its buildings: the count-parametric generator spreads a single
  // agency across several of a developer's buildings, and the real model is one agency↔developer agreement
  // whose `buildings[]` lists every covered building — `resolveSaleCommission` reads liveAgreementBetween
  // (ONE agreement) then finds the building's clause in it. The old per-building ensureAgreement created a
  // SEPARATE agreement per building, so the clause for a 2nd building lived in an agreement liveAgreementBetween
  // didn't return → "no_rate" holes. Aggregating fixes that at the source (the hand plan avoided it by never
  // reusing an agency across buildings; the generator can't make that assumption).
  const pairBuildings = new Map<string, Set<string>>(); // `${developer}|${agency}` → buildings
  for (const spec of plan) {
    if (spec.kind !== "offer") continue;
    const n = unitCursor[spec.building] ?? 0;
    const uid = await nthUnitId(spec.building, n);
    if (!uid) {
      holes.push({ where: `offer/${spec.building}`, promise: "building has inventory to book", brokenBy: "no unit in catalog inventory" });
      continue;
    }
    unitCursor[spec.building] = n + 1;
    spec.unitId = uid;
    const agency = await agencyOf(spec.agent);
    if (!agency) {
      holes.push({ where: `offer/${spec.agent}`, promise: "a booking agent belongs to a known agency", brokenBy: "agencyOf returned null" });
      continue;
    }
    const pk = `${spec.developer}|${agency}`;
    (pairBuildings.get(pk) ?? pairBuildings.set(pk, new Set()).get(pk)!).add(spec.building);
    // Establish the baseline for EVERY offer building (H2 Half B), not just confirmed-sale ones: a
    // PROSPECTIVE (not-yet-confirmed) booking also needs a baseline to EXIST for its commission to preview.
    await ensureBaseline(spec.developer, spec.building, (n) => notes.push(n));
  }
  // ── STEP 1: VET IDENTITIES before any agreement is proposed (genesis-walk) ────────────────────────
  // proposeAgreement folds each party's identity at propose-time, so every actor must have a vetted profile
  // FIRST or the sealed agreement prints "(identity not yet vetted)". Enumerate every developer / agency /
  // agent the plan touches, from the maps already built above + the plan itself, and vet each via the real
  // profiles.setProfile seam. Must precede ensureAgreementForBuildings / ensureVrxAgreement (below). The
  // driftFix agencies (pattaya-realty, north-shore) are included so their drift-repair agreements seal vetted
  // too. Idempotent; see vetActors.
  {
    const devAccounts = new Set<string>(devBuildings.keys());
    const agencyAccounts = new Set<string>();
    for (const pk of pairBuildings.keys()) {
      const [developer, agency] = pk.split("|");
      devAccounts.add(developer.toLowerCase());
      agencyAccounts.add(agency.toLowerCase());
    }
    // driftFix developers/agencies (constants below) — vet them here so their later agreements seal vetted.
    for (const a of ["vvv-dev-02.testnet", "vvv-dev-03.testnet"]) devAccounts.add(a);
    for (const a of ["pattaya-realty.testnet", "north-shore.testnet"]) agencyAccounts.add(a);
    const agentAccounts = new Set<string>();
    for (const spec of plan) if (spec.kind === "offer") agentAccounts.add(spec.agent.toLowerCase());
    await vetActors(devAccounts, "developer", devLegalName, (n) => notes.push(n));
    await vetActors(agencyAccounts, "agency", agencyLegalName, (n) => notes.push(n));
    await vetActors(agentAccounts, "agent", agentLegalName, (n) => notes.push(n));

    // ── REGISTER the demo developers off-chain with their FULL aliased building set. Previously only
    // vvv-dev-01 existed (via developers.ts buildSeed → miracle-tower/oceanview) and vvv-dev-02/03's
    // buildingIds lived ONLY in a hand-maintained .data/developers.json — so a fresh clone's reseed produced
    // no desk developer for parkgate/garden-court (deskDeveloperFor → null → the direct desk + AI couldn't
    // open, and `npm run demo` failed its spotlight precondition on garden-court). Register all three from
    // DEV_BUILDINGS here so the complete world is reproducible from source alone. Idempotent (saveDeveloper
    // upserts by account); preserves each dev's existing houseOrg/terms if already present.
    for (const dev of Object.keys(DEV_BUILDINGS)) {
      const existing = await getDeveloper(dev);
      await saveDeveloper({
        account: dev,
        name: DEV_DISPLAY_NAMES[dev] ?? existing?.name ?? dev,
        buildingIds: DEV_BUILDINGS[dev],
        ...(DEV_HOUSE_ORGS[dev] ? { houseOrgAccount: DEV_HOUSE_ORGS[dev] } : existing?.houseOrgAccount ? { houseOrgAccount: existing.houseOrgAccount } : {}),
        ...(existing?.terminationTerms ? { terminationTerms: existing.terminationTerms } : {}),
      });
    }
    notes.push(`registered ${Object.keys(DEV_BUILDINGS).length} demo developers with full aliased building sets`);

    // ── STEP 2: DISTRIBUTE $VRX down the chain (genesis-walk, C1/) ──────────────────────────────
    // Honest off-chain credit: the treasury GRANTS each developer, each developer passes some to the
    // agencies it works with, each agency passes some to its agents — so an agent can fund a deposit WITHOUT
    // their own $NEAR. Every move is a real vrx-token op (operatorSend treasury→dev, transfer dev→agency and
    // agency→agent) and logs a history row (wallet #4). Idempotent: skip an account already funded at/above
    // its grant, so a re-seed is a no-op (no double-distribution, no supply drift). Relationship maps reuse
    // the SAME data the vetting + agreement passes use (pairBuildings for dev↔agency; agencyOf for agent↔agency).
    const devAgencies = new Map<string, Set<string>>(); // developer → agencies it has an agreement with
    for (const pk of pairBuildings.keys()) {
      const [developer, agency] = pk.split("|");
      (devAgencies.get(developer) ?? devAgencies.set(developer, new Set()).get(developer)!).add(agency);
    }
    // driftFix pairs (same as the agreements below) so those agencies get funded too.
    (devAgencies.get("vvv-dev-02.testnet") ?? devAgencies.set("vvv-dev-02.testnet", new Set()).get("vvv-dev-02.testnet")!).add("pattaya-realty.testnet");
    (devAgencies.get("vvv-dev-03.testnet") ?? devAgencies.set("vvv-dev-03.testnet", new Set()).get("vvv-dev-03.testnet")!).add("north-shore.testnet");
    const agencyAgents = new Map<string, Set<string>>(); // agency → its agents (from the plan)
    for (const a of agentAccounts) {
      const agency = (await agencyOf(a))?.toLowerCase();
      if (!agency) continue;
      (agencyAgents.get(agency) ?? agencyAgents.set(agency, new Set()).get(agency)!).add(a);
    }
    await distributeVrx(devAccounts, devAgencies, agencyAgents, (n) => notes.push(n));

    // ── STEP 2b: DISTRIBUTE BOOKING TOKENS down the chain ────────────────────────────────────
    // Reuses the SAME relationship maps STEP 2 built (devAgencies / agencyAgents) so capacity flows along the
    // exact gated trust graph. Runs AFTER the gates + agents exist (vetActors above) so transferToken's
    // chain-constraint check passes. Idempotent (skips developers that already hold live capacity).
    await distributeBookingTokens(devAccounts, devAgencies, agencyAgents, (n) => notes.push(n));
  }

  // Establish one multi-building agreement per (developer, agency) pair.
  for (const [pk, buildings] of pairBuildings) {
    const [developer, agency] = pk.split("|");
    await ensureAgreementForBuildings(developer, agency, [...buildings], (n) => notes.push(n));
  }

  // ── Resolve the real access-graph drift ───────────────────────────────────────────────
  // The gate-widening granted some agencies access to a developer without a matching agreement, so the
  // H3 cross-check (below) flagged them as "can book, can't earn". For a COHERENT big system every agency
  // that can sell can also earn, so we establish those missing agreements via the SAME real ensureAgreement
  // path (idempotent, off-chain). Buildings chosen are unused-by-another-agency ones owned by the developer,
  // for variety. (summit-house→dev-01 is NOT fixed here — a house org correctly sells via its own Peer, not
  // an agency agreement; it stays a deliberate, expected gap.)
  const driftFixes: Array<{ developer: string; agency: string; building: string; pct: number }> = [
    { developer: "vvv-dev-02.testnet", agency: "pattaya-realty.testnet", building: "gardengate", pct: 3 },
    { developer: "vvv-dev-03.testnet", agency: "north-shore.testnet", building: "southbay", pct: 3 },
  ];
  for (const f of driftFixes) {
    await ensureAgreement(f.developer, f.agency, f.building, f.pct, (n) => notes.push(n));
    await ensureBaseline(f.developer, f.building, (n) => notes.push(n));
    noteDevBuilding(f.developer, f.building);
  }

  // SIGN the VRX↔developer agreement for every developer the plan touches, signing off each of their buildings
  // ("signing precedes listing" — the listing gate hides unsigned developers, so without this the seeded world
  // would go dark once that gate is live). Real, idempotent; the SAME seam the /node sign UI uses (§7).
  for (const [developer, buildings] of devBuildings) {
    await ensureVrxAgreement(developer, [...buildings], (n) => notes.push(n));
  }

  // ── H3 cross-check: gate ↔ agreement consistency. For every developer an offer touches, any agency
  // with an active access gate but NO live agreement is a real drift (can book, can't earn) — record it as a
  // hole so the harness surfaces it rather than papering over it. (Pure read; no fix applied.)
  const checkedDevs = new Set<string>();
  for (const spec of plan) {
    if (spec.kind !== "offer") continue;
    const dev = spec.developer.toLowerCase();
    if (checkedDevs.has(dev)) continue;
    checkedDevs.add(dev);
    const gaps = await agenciesWithGateButNoAgreement(dev);
    for (const gap of gaps) {
      holes.push({
        where: `gate-agreement/${dev}`,
        promise: "an agency with access to a developer also has commission terms (so its sales can earn)",
        brokenBy: `${gap.agency} holds an active gate to ${dev} but no live agreement (access without terms)`,
      });
    }
  }

  let directCreated = 0;
  let offersCreated = 0;
  let commissionsResolved = 0;
  const dated: DatedTarget[] = []; // collected per deal for the timestamp post-pass

  for (let i = 0; i < plan.length; i++) {
    const spec = plan[i];
    if (spec.kind === "direct") {
      const convId = await driveDirect(spec, i, holes, notes);
      if (convId) {
        directCreated++;
        if (spec.schedule) dated.push({ kind: "direct", key: convId, developer: "", building: spec.building, schedule: spec.schedule });
      }
    } else {
      if (!spec.unitId) continue; // skipped above (no inventory) — already a hole
      const offer = await driveOffer(spec, i, chain, holes, notes);
      if (offer) {
        offersCreated++;
        if (spec.schedule) dated.push({ kind: "offer", key: offer.requestId, developer: spec.developer, building: spec.building, schedule: spec.schedule });
        // Check the commission promise at the exact state we left the booking in.
        const c = await resolveSaleCommission(offer);
        if (c) commissionsResolved++;
        else if (spec.confirmed) {
          holes.push({
            where: `commission/${offer.requestId.slice(0, 8)}`,
            promise: "a CONFIRMED sale by a gated+agreed agency earns commission",
            brokenBy: "resolveSaleCommission returned null (missing baseline, agreement clause, or agency link)",
          });
        }
      }
    }
  }

  // Catalog texture — AFTER the deal loop so withholding only touches units left open.
  await applyCatalogTexture((n) => notes.push(n));

  // DEV-KEY owner slice — AFTER everything else so it can't perturb the vvv- world's RNG or be
  // touched by catalog texture (its own building/units are added fresh here). Makes the god-mode local signer's
  // node/org/agent/buyer.test.near accounts own populated dashboards (Finding B fix). Default on; opt out for
  // a vvv-only world. Its dated targets join the post-pass so the dev-key deals get the same timeline treatment.
  if (opts?.devKeySlice !== false) {
    const slice = await seedDevKeySlice(chain, holes, notes);
    directCreated += slice.directCreated;
    offersCreated += slice.offersCreated;
    commissionsResolved += slice.commissionsResolved;
    for (const d of slice.dated) dated.push(d);
  }

  // FURNITURE PACKS — author a realistic furnished-package menu for every developer the plan
  // touched (the vvv devs) plus the dev-key developer, via the real savePack path. Idempotent (fixed ids).
  // Runs last; writes only furniture-packs.json, perturbs nothing above.
  {
    const furnitureDevs = new Set<string>([...devBuildings.keys()]);
    if (opts?.devKeySlice !== false) furnitureDevs.add(DEV_KEY_DEVELOPER);
    await seedFurniturePacks([...furnitureDevs], notes);
  }

  // ── STEP 5 (photo subsystem): seed portraits + passports so the world is PHOTO-COMPLETE ────────────
  // Every vetted actor (developer/agency/agent) gets a public portrait (avatar + ID-card photo); every buyer
  // gets a public portrait + a sensitive passport (1px-tweaked per account so hashes differ). Runs the REAL
  // image pipeline via lib/seed-images, idempotent per account/slot. Actor accounts come from the plan +
  // their resolved agencies; buyer accounts are every plan spec's account. Source images are LOCAL (the
  // Downloads) read only at reseed time — the stored .data/images blobs are what ship with the seeded world.
  {
    const actorAccounts = new Set<string>();
    const buyerAccts = new Set<string>();
    for (const spec of plan) {
      buyerAccts.add(spec.account.toLowerCase());
      if (spec.kind === "offer") {
        actorAccounts.add(spec.developer.toLowerCase());
        actorAccounts.add(spec.agent.toLowerCase());
        const agency = (await agencyOf(spec.agent))?.toLowerCase();
        if (agency) actorAccounts.add(agency);
      }
    }
    // Fold in the driftFix + dev-key actors so their ID cards have photos too.
    for (const a of ["vvv-dev-02.testnet", "vvv-dev-03.testnet", "pattaya-realty.testnet", "north-shore.testnet"]) {
      actorAccounts.add(a);
    }
    await seedImages(actorAccounts, buyerAccts, (n) => notes.push(n));
  }

  notes.push(`${chain.calls.length} on-chain calls STUBBED (never broadcast): ${chain.calls.filter((c) => c.method === "open_claim").length} open_claim, ${chain.calls.filter((c) => c.method === "confirm_claim").length} confirm_claim.`);
  return { directCreated, offersCreated, commissionsResolved, stubbedCalls: chain.calls, holes, notes, dated };
}
