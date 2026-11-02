// WHAT THIS IS: a REUSABLE driver (not a throwaway script) that populates the demo with a BIG, realistic
// system — many buyers spread across every funnel/contract stage, across all 3 developers and multiple
// agencies/agents — by DRIVING THE REAL CODE PATHS, not by hand-writing `stage:"signed"` rows. Each synthetic
// buyer actually WALKS the transitions the product defines:
// • direct funnel (buyer-owned, desk side): saveBuyerProfile → advanceFunnel new→in_conversation→
// units_opened→offer_eligible, + a real directConversation thread.
// • agent offers (agent-booked): recordOffer (the attested seal) → markContractFinal → markPaymentArrived
// → markContractSigned, with the booking CONFIRMED (the on-chain confirm) so commission resolves.
// Each buyer STOPS at its target stage, so every UI stage shows real, code-produced data.
// method used generatively — exercise the promises/seams, collect every contradiction). When a real function
// refuses (returns null / fails a precondition), that refusal is RECORDED as a HOLE rather than worked around.
// writes a real booking makes — open_claim (agent books) and confirm_claim (developer confirms) — are
// exercised in CODE through a `ChainStub` that records the args and returns a deterministic fake tx hash, but
// NEVER broadcasts. Zero gas, zero orphan risk against a contract still planned to move. The off-chain half
// (where ~90% of the holes live) is fully real. One small REAL on-chain run is still owed, LAST, on the final
// contract — the stub proves the LOGIC, not the chain REALITY.
// IDEMPOTENT + ADDITIVE: synthetic buyers use fixed, realistic-looking (non-identifiable) two-word testnet
// handles tracked in SEEDED_ACCOUNTS. A re-run overwrites only its own rows (the underlying stores are
// idempotent on their keys) and never touches the hand-made demo data (existing offers, highbird.testnet, …).
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
import { getBuilding, saveBuilding, type Building, type Unit } from "./catalog";
import { applyOffMarket, OPEN, UNSTAMPED } from "./offmarket";
import { saveDeveloper, getDeveloper } from "./developers";
import { recordGate } from "./gates";
import { grantUnit } from "./unit-grants";
import { addBuyerDoc, getBuyerVault } from "./kyc-vault-buyer";
import { savePack } from "./furniture-packs";
import { digest } from "./seal";
import { deflateSync } from "zlib";

// ── The chain stub ( seam) ────────────────────────────────────────────────────────────────────────────
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

// Two-word handles that read like ordinary testnet wallets. Tracked here so re-runs are idempotent and so a
// cleanup pass (if ever wanted) can target exactly these and nothing hand-made.
const BUYER_ACCOUNTS = [
  "quiet-harbor.testnet",
  "amber-finch.testnet",
  "slate-meadow.testnet",
  "copper-wren.testnet",
  "harbor-lantern.testnet",
  "violet-ridge.testnet",
  "cedar-moth.testnet",
  "ivory-kestrel.testnet",
  "umber-solstice.testnet",
  "pale-cartographer.testnet",
  "russet-anchor.testnet",
  "glass-sparrow.testnet",
] as const;

export const SEEDED_ACCOUNTS: readonly string[] = BUYER_ACCOUNTS;

// All word tokens the synthetic-account generators (synthAccount) + the legacy BUYER_ACCOUNTS draw from.
// A `--fresh` wipe uses isSeedAccount to recognise EVERY account this seed could have created — the new
// synthAccount space AND the legacy two-word handles — so old direct-conversation walls (seed
// runs on accounts like amber-finch/quiet-harbor) are cleared too, not just the current plan's accounts.
const SEED_WORD_TOKENS = new Set<string>([
  // legacy BUYER_ACCOUNTS first words + the synthAccount ACC_A/ACC_B pools (kept in sync with those arrays).
  ...["quiet", "amber", "slate", "copper", "harbor", "violet", "cedar", "ivory", "umber", "pale", "russet", "glass", "jade", "coral", "onyx", "linen", "ember", "frost", "sable", "dune"],
  ...["harbor", "finch", "meadow", "wren", "lantern", "ridge", "moth", "kestrel", "solstice", "atlas", "anchor", "sparrow", "willow", "cove", "spire", "heron", "cipher", "lark", "vale", "reef", "cartographer"],
]);

/** True iff `account` looks like a SEED-created synthetic buyer handle (two word-tokens from the seed pools +
 * ".testnet"), OR is one of the explicit legacy SEEDED_ACCOUNTS. Used only by the --fresh wipe to scope which
 * direct buyers/conversations to clear — conservative: a non-matching (hand-made/real) account is NEVER
 * wiped. Hand-made demo accounts (highbird.testnet, the spotlight account) don't match and are preserved. */
export function isSeedAccount(account: string): boolean {
  const a = account.trim().toLowerCase();
  if (!a) return false;
  if ((SEEDED_ACCOUNTS as readonly string[]).includes(a)) return true;
  const m = /^([a-z]+)-([a-z]+)\.testnet$/.exec(a);
  if (!m) return false;
  return SEED_WORD_TOKENS.has(m[1]) && SEED_WORD_TOKENS.has(m[2]);
}

// The developer accounts THIS seed owns. Single source of truth for both the generator (DEV_BUILDINGS below
// is derived from this) and the --fresh wiper. A real hand-made demo offer would never target one of these
// (they're the seed's own fictional developers); so any non-`origin:seed` offer on a seeded developer is a
// STALE row from a pre-provenance-marker seed run (finding) and must be wiped on --fresh. The list is
// INLINED inside the function (not a module-level const) so isSeedDeveloper stays TDZ-safe when imported by
// backfill-dates during module init — a plain const was read before initialization under tsx's eval order.
/** True iff `developer` is one of the seed's own fictional developer accounts. Used by the --fresh wipe to
 * recognise stale pre-marker offer rows (which lack display.origin:"seed" yet sit on a seeded developer's
 * real building — the exact rows that collided with the clean reseed). Hand-made demo offers never
 * target a seeded developer, so this is conservative: it can only ever match the seed's own territory. */
export function isSeedDeveloper(developer: string | undefined | null): boolean {
  if (!developer) return false;
  return ["vvv-dev-01.testnet", "vvv-dev-02.testnet", "vvv-dev-03.testnet"].includes(developer.trim().toLowerCase());
}

/** True iff a row looks like throwaway TEST/PROBE debris from ad-hoc dev runs (reqIds like `test-*`, `probe-*`,
 * `seed-s123-*`, or non-domain dev handles like `d.testnet`/`dev.testnet`/`test-dev.testnet`). Belt-and-
 * suspenders companion to isSeedDeveloper for the --fresh wipe: catches junk that isn't on a seeded developer
 * (e.g. `probe-dev.testnet|b/u`). Deliberately narrow — only unmistakable test artifacts. */
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
   * actually reaches are consumed. Monotonic, each ≥ 0. */
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
  for (let r = 1; r <= targetRank; r++) {
    const res = await advanceFunnel(spec.account, order[r]);
    // Monotonic: advancing to a step the buyer is already AT OR PAST is a correct no-op (returns the higher
    // state). A hole is only real if the buyer ended up BELOW this step — i.e. the advance genuinely failed.
    if (!res || funnelRank(res.funnel) < r) {
      holes.push({ where: `direct/${spec.account}`, promise: `funnel can advance to ${order[r]}`, brokenBy: `advanceFunnel did not reach ${order[r]} (got ${res?.funnel ?? "null"})` });
      break;
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
  }

  return getOffer(requestId);
}

// ── Seeded deterministic RNG (mulberry32) ───────────────────────────────────────────────────────────────
// A tiny, well-known 32-bit PRNG. Seeded from a FIXED constant so a re-run is byte-identical — which is what
// makes "wipe-then-seed" (--fresh) reproducible: the same count always regenerates the same world. NOT for
// crypto ( privacy is unaffected — this only chooses demo shapes, never touches a seal/hash).
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

// Grounded in the real Thailand off-plan patterns (memory: thai-offplan-market-patterns): a 2–3yr pre-sale
// window with explosive opening events, expo lead-clusters, opportunistic singles, and repeat multi-unit
// investors. Dates here are DAYS-AGO from now (the post-pass resolves to epoch); every offset > 0 (past).
const DISTRIBUTIONS = {
  /** The pre-sale arrival window (the operator catalog fact: projects sell out over 2–3 yr). Deals arrive within the last
   * ~2.5 yr, weighted slightly toward recent (a growing operation). */
  arrivalWindowDays: 900, // ~2.5 years
  /** Opening-event bursts: a big batch of bookings landing on ONE day at a discount (the real-time system's
   * showcase). `count` events; each clusters `sharePerEvent` of the plan onto a single arrival date. At
   * count=48 this reads as a visible same-day cluster (~12–18 deals), not a literal building sell-out. */
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
   * #3). Deterministic pick; only touches units left OPEN/UNSTAMPED after the deal pass ( anti-fraud —
   * never withholds a held/sold unit). 0 disables. */
  offMarketShare: 0.3,
} as const;

// Developer → the buildings that developer owns (account handles, matching buildPlan's original comments).
// Used by the generator to spread deals across every developer/building. Agencies/agents resolve dynamically
// (agencyOf) so we only list agent handles; each agent's agency must have a gate+agreement for commission.
const DEV_BUILDINGS: Record<string, string[]> = {
  "vvv-dev-01.testnet": ["miracle-tower", "pearls-view", "skyline-tower"],
  "vvv-dev-02.testnet": ["parkgate", "palmgate", "gardengate"],
  "vvv-dev-03.testnet": ["garden-court", "northpoint", "southbay"],
};
const DIRECT_VISIBLE = ["miracle-tower", "parkgate", "garden-court"]; // directSale.visible
// Developer profile seed (display name + house org per dev account). Registered as Developer records
// by runSeedFunnel so a COLD .data/ seeds a complete world (the spotlight needs getDeveloper to resolve).
// Names/orgs are fictional demo labels. directSaleThresholdUsd low so a modest demo balance clears the bar.
const DEV_PROFILES: Record<string, { name: string; houseOrg: string }> = {
  "vvv-dev-01.testnet": { name: "Summit Estates", houseOrg: "summit-house.testnet" },
  "vvv-dev-02.testnet": { name: "Parkside Developments", houseOrg: "parkside-house.testnet" },
  "vvv-dev-03.testnet": { name: "Coastal Group", houseOrg: "coastal-house.testnet" },
};
const AGENTS = [
  "sav-agent-1.testnet", "sav-agent-2.testnet", "bm-agent-1.testnet", "bm-agent-2.testnet",
  "ns-agent-1.testnet", "pr-agent-1.testnet", "jump-agent-1.testnet",
];
// Agent → agency account map (the handle prefix names the agency). Seeded by runSeedFunnel via recordAgent
// so a COLD .data/ resolves agencyOf for every generated agent (previously only the dev-key agent was
// recorded, so a fresh clone produced "agencyOf returned null" holes). Agency accounts are fictional.
const AGENT_AGENCY: Record<string, string> = {
  "sav-agent-1.testnet": "crestview.testnet",
  "sav-agent-2.testnet": "crestview.testnet",
  "bm-agent-1.testnet": "big-mango.testnet",
  "bm-agent-2.testnet": "big-mango.testnet",
  "ns-agent-1.testnet": "north-shore.testnet",
  "pr-agent-1.testnet": "pattaya-realty.testnet",
  "jump-agent-1.testnet": "jump-estate.testnet",
};

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
    // Summit / Crestview (miracle-tower @3%): a fully signed + confirmed sale.
    { kind: "offer", account: B[4], agent: "sav-agent-1.testnet", developer: "vvv-dev-01.testnet", building: "miracle-tower", unitId: "", priceUsd: 142000, target: "signed", confirmed: true },
    // Summit / Big Mango (miracle-tower @4%): confirmed, paperwork at payment_arrived.
    { kind: "offer", account: B[5], agent: "bm-agent-1.testnet", developer: "vvv-dev-01.testnet", building: "miracle-tower", unitId: "", priceUsd: 168000, target: "payment_arrived", confirmed: true },
    // Summit / North Shore (pearls-view @3%): final, not yet confirmed (prospective commission).
    { kind: "offer", account: B[6], agent: "ns-agent-1.testnet", developer: "vvv-dev-01.testnet", building: "pearls-view", unitId: "", priceUsd: 99000, target: "final", confirmed: false },
    // Summit / Crestview (pearls-view @3.5%): just booked, preview.
    { kind: "offer", account: B[7], agent: "sav-agent-2.testnet", developer: "vvv-dev-01.testnet", building: "pearls-view", unitId: "", priceUsd: 121000, target: "preview", confirmed: false },
    // Parkside / Big Mango (parkgate): harness establishes the agreement+baseline; signed + confirmed.
    { kind: "offer", account: B[8], agent: "bm-agent-2.testnet", developer: "vvv-dev-02.testnet", building: "parkgate", unitId: "", priceUsd: 205000, target: "signed", confirmed: true },
    // Parkside / Crestview (palmgate): confirmed, payment_arrived.
    { kind: "offer", account: B[9], agent: "sav-agent-1.testnet", developer: "vvv-dev-02.testnet", building: "palmgate", unitId: "", priceUsd: 178000, target: "payment_arrived", confirmed: true },
    // Coastal Group / Pattaya Realty (garden-court): signed + confirmed.
    { kind: "offer", account: B[10], agent: "pr-agent-1.testnet", developer: "vvv-dev-03.testnet", building: "garden-court", unitId: "", priceUsd: 88000, target: "signed", confirmed: true },
    // Coastal Group / Jump Estate (northpoint): final, not confirmed.
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
// The off-market machinery (lib/offmarket, and the build-state fork (resolveBuildState reads
// Building.project.status → S&P clause set) both already exist and are CONSUMED; the seed just left
// every building default off_plan and every unit on-market. This pass fills that gap so the demo world reads
// project.status; skips units already off-market) and MUST run AFTER the deal loop so withholding only ever
// touches units left OPEN/UNSTAMPED — honouring the anti-fraud guard (never hide a held/sold unit).
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
 * withholding selection can be unit-tested without touching the catalog store. */
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
// OWNERS of a small, self-contained seeded slice (its OWN new catalog building — add, never reassign a vvv-
// building) + the org/agent/agreement wiring so commission resolves + a few buyers — while KEEPING the rich
// vvv- world intact for the judge demo.
// WHY A SEPARATE PASS (not folded into DEV_BUILDINGS/AGENTS): running AFTER runSeedFunnel's generator keeps the
// vvv- world's seeded RNG + deal distribution BYTE-IDENTICAL (the slice can't perturb the judge world), and the
// slice is self-contained + idempotent (own building id, own agreement, fixed buyer handles). It drives the
// SAME real code paths as the main seed (ensureVrxAgreement / ensureBaseline / ensureAgreement / recordOffer /
// driveOffer helpers), so the dev-key dashboards light up the honest way — not hand-written stage rows.
// NAMESPACE: the four accounts match scripts/provision-localnet.mjs (node/org/agent/buyer.test.near). This runs
// on localnet AND testnet seeds alike (it only writes.data + stubs the chain); the accounts just happen to be
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
// Shape mirrors a real imported building (pearls-view) so all consumers (terms editor, S&P, quota, directSale)
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
    area: "Bayview",
    address: "Bayview Beach Road Soi 7",
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
        "Dev Tower is the god-mode demo building: a compact Bayview high-rise of studios and one-bedrooms used to " +
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

  // 1) The developer owns its own building (add to catalog) + is registered off-chain with a house org so a
  // direct buyer's firm-hold has somewhere to grant. directSaleThresholdUsd low so buyer.test.near
  // (modest demo balance) clears the eligibility bar.
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
  // building shows real AVAILABILITY (the developer card's "N available", the agent browse, the buyer's
  // price-unlock). ensureBaseline writes this slate only when it FIRST creates the baseline (a one-time
  // side effect); on a re-seed it short-circuits on the existing baseline, so without this explicit write
  // a re-run left every unit UNSTAMPED (-1) → "0 available" (live-walk finding). We only open units
  // NOT already sold/held/closed (1/2/3) so a re-run never un-sells a confirmed booking — idempotent and
  // order-safe (the confirmed offers below flip their units to closed AFTER this).
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
  // (so prospective + confirmed commission can resolve). Same real seams the main seed uses.
  await ensureVrxAgreement(DEV_KEY_DEVELOPER, [DEV_KEY_BUILDING], note);
  await ensureBaseline(DEV_KEY_DEVELOPER, DEV_KEY_BUILDING, note);

  // 3) Wire the agency: org.test.near gets an ACTIVE gate to the developer + a live commission agreement on the
  // building, and agent.test.near is recorded as its agent (so agencyOf resolves → commission can earn).
  await recordGate(DEV_KEY_DEVELOPER, DEV_KEY_AGENCY, true);
  await ensureAgreement(DEV_KEY_DEVELOPER, DEV_KEY_AGENCY, DEV_KEY_BUILDING, 3, note);
  await recordAgent(DEV_KEY_AGENT, DEV_KEY_AGENCY);
  note(`agency ${DEV_KEY_AGENCY} gated+agreed on ${DEV_KEY_BUILDING}; agent ${DEV_KEY_AGENT} registered`);

  // 4) A few AGENT offers by agent.test.near at a spread of stages, so the agent's "My bookings" + the
  // developer's inbox + commission all populate. Distinct units (unit cursor). Two confirmed (earn), one
  // prospective (not yet confirmed). Driven through the real driveOffer helper (same as the main seed).
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
  // walking the UI as buyer.test.near has a live desk conversation to see. Driven through driveDirect (real
  // funnel), then granted one unit so the buyer's "opened units" view is non-empty.
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

  // + a PASSPORT into buyer.test.near's own vault through the REAL addBuyerDoc encrypt path — so the dev-walk
  // sees the "already uploaded" view, and the encrypt→store→read-back seam is exercised. The images are
  // synthetic solid-colour PNGs, NOT a real person's photo ( privacy moat — never seed real PII imagery).
  // Idempotent: addBuyerDoc replaces one-per-kind, so a re-run overwrites rather than piling up. The vault
  // auto-unlocks in dev (kyc-vault-key dev deterministic operator key); if somehow locked, we record a hole.
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
 * idempotent (fixed ids overwrite). Returns the count created/updated for the report. */
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

/**
 * Run the full-funnel seed. Idempotent + additive. Returns the report (its `holes` list is the deliverable).
 * `opts.dryRun` logs the plan + would-be stub calls WITHOUT writing any.data (for a safe preview).
 * `opts.count` sizes the count-parametric backfill (default 48; a busy variant can pass 200+).
 * `opts.plan` injects a fixed plan (tests/the legacy buildPlanFixed); default = buildPlan(count).
 * `opts.devKeySlice` (default true) also seeds the dev-key owner slice so the god-mode
 * LOCAL SIGNER's node/org/agent/buyer.test.near accounts own real, populated dashboards.
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

  // Register the vvv-dev developer records from DEV_BUILDINGS/DEV_PROFILES so a COLD .data/ seeds a
  // complete world (previously these records only existed in a pre-populated .data/, so a fresh clone's
  // spotlight failed with "dev=false"). Idempotent: saveDeveloper upserts by account.
  for (const [account, buildingIds] of Object.entries(DEV_BUILDINGS)) {
    const profile = DEV_PROFILES[account];
    if (!profile) continue;
    await saveDeveloper({
      account,
      name: profile.name,
      buildingIds,
      houseOrgAccount: profile.houseOrg,
      directSaleThresholdUsd: 1,
    });
  }

  // Register every generated agent → its agency so agencyOf resolves on a COLD .data/ (clears the
  // "agencyOf returned null" holes). Idempotent: recordAgent upserts by agent account.
  for (const [agent, agency] of Object.entries(AGENT_AGENCY)) {
    await recordAgent(agent, agency);
  }

  // Open the direct-sale desk on the DIRECT_VISIBLE buildings (flip directSale.visible → true) so a COLD
  // .data/ lets walk-in buyers open a desk conversation (resolveDirectConversation needs visible===true +
  // a desk developer; the dev registration above provides the latter). Keeps each building's existing
  // funnelCopy. Idempotent.
  for (const bid of DIRECT_VISIBLE) {
    const b = await getBuilding(bid);
    if (b && b.directSale?.visible !== true) {
      await saveBuilding({ ...b, directSale: { ...(b.directSale ?? {}), visible: true } });
    }
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
  // Establish one multi-building agreement per (developer, agency) pair.
  for (const [pk, buildings] of pairBuildings) {
    const [developer, agency] = pk.split("|");
    await ensureAgreementForBuildings(developer, agency, [...buildings], (n) => notes.push(n));
  }

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

  notes.push(`${chain.calls.length} on-chain calls STUBBED (never broadcast): ${chain.calls.filter((c) => c.method === "open_claim").length} open_claim, ${chain.calls.filter((c) => c.method === "confirm_claim").length} confirm_claim.`);
  return { directCreated, offersCreated, commissionsResolved, stubbedCalls: chain.calls, holes, notes, dated };
}
