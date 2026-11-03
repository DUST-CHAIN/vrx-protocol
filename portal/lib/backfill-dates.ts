// TIMESTAMP POST-PASS for the dated off-chain backfill (BACKFILL_DESIGN_S130 §5–§6).
// SERVER-ONLY, dev/test tool — NEVER touches the chain, NEVER runs in prod.
//
// WHAT THIS IS: the second half of the time-aware backfill. lib/seed-funnel drives the REAL product code
// paths at real-NOW (markConfirmed/advanceFunnel/postMessage all stamp Date.now); this pass then REWRITES
// the stamped time fields in the seed's own .data to the intended ~2–3-year dated timeline, so the demo looks
// like it has been OPERATING, not freshly switched on. It consumes the EXPLICIT `dated[]` map runSeedFunnel
// returns (requestId/conversationId → developer/building/schedule) — it never re-derives keys by re-hashing,
// so a future hash change can't silently break it.
//
// THE THREE SEALED-DATE HAZARDS (verified — re-dating a SEALED field is a TAMPER unless re-sealed):
//   • channels.json — a message `at` is INSIDE chainHash's payload (channels.ts:94). Rewriting `at` alone
//  breaks every `h`; verifyChain would flag the whole thread. → we call channels.rechainThread to
//     recompute the chain oldest→first with the new dates.
//  • sale-baselines.json — `establishedAt` is INSIDE the baseline seal. → sale-baseline.resealBaselineWithDate.
//   • agreements.json / vrx-developer-agreements.json — `proposedAt`/`signedAt` are INSIDE the agreement seal.
//  → agreementDigest / vrxDeveloperAgreementDigest (both exported) recompute sealHash.
// OFF-SEAL date fields (offer `at`, `confirmed.at`, `contract.*At`, status snapshot/ledger times) are plain
// overwrites — those are explicitly "not part of the hash" (offers.ts).
//
// CONSISTENCY INVARIANTS (§5 — the real deliverable; a reviewer hunts exactly these seams). For every deal:
//   agreement.signedAt < baseline.establishedAt < deal.at < confirm.at < each payment.at < now
//   AND a confirmed deal's status-transition date == its confirm date.
// assertInvariants below checks these and THROWS on violation (fail loud — a silent bad date is worse than
// a crash in a dev seed). LAUNCH-ERA CLUSTERING (: projects 1–2yr apart, >1 building/project): we
// group a developer's buildings into launch-era clusters and stagger each cluster's agreement+baseline dates
// by ~1–2yr, so "signing precedes listing" (§7) lands at DIFFERENT dates per cluster, not all at once.
//
// WHY A POST-PASS (design §2): it leaves the harness AND the product code untouched (every real function keeps
// stamping Date.now); only the seed's own rows are re-dated afterward. The alternative — threading dates into
// markConfirmed/postMessage/etc. — would mean changing real product signatures for a demo concern. Rejected.

import { promises as fs } from "fs";
import path from "path";
import { isSeedAccount, isSeedDeveloper as isSeedDeveloperAcct, isTestJunkOffer, type DatedTarget } from "./seed-funnel";
import { rechainThread, type ChannelMessage } from "./channels";
import { resealBaselineWithDate, type SaleBaseline } from "./sale-baseline";
import { agreementDigest, type Agreement } from "./agreements";
import { vrxDeveloperAgreementDigest, type VrxDeveloperAgreement } from "./vrx-developer-agreement";

const DATA_DIR = path.join(process.cwd(), ".data");
const DAY = 86_400_000;

// ── Raw .data file helpers (clean UTF-8 write per the machine rule; the Write-tool discipline for scripts
// doesn't apply to runtime fs.writeFile, which already emits clean UTF-8/LF). Missing file ⇒ null (skip). ──
async function readJson<T>(name: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
async function writeJson(name: string, value: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, name), JSON.stringify(value, null, 2), "utf8");
}

// ── --fresh : wipe the SEED's OWN rows so a re-run regenerates a byte-identical dated world ──────────────
// The opener text-equality dedup guard (driveDirect) protects same-TEXT re-runs but NOT varied dated content;
// a dated backfill needs a real idempotency story. Per design §2 this is SCOPED to the seed's own rows — it
// must NEVER touch hand-made demo data (highbird.testnet, the spotlight account, etc.). We identify seed rows
// precisely: OFFERS by the provenance marker `display.origin === "seed"`, and their booking THREADS by
// the wiped offers' requestIds. Idempotent + conservative: baselines/agreements/buyers are left (they are
// re-established idempotently by the next seed run and carry no dated drift that varies run-to-run). Returns a
// count of what it removed. DEV-ONLY.
//
//  FIX: the origin-only rule left 19 STALE rows behind — pre-provenance-marker offers from old seed
// runs (on seeded developers' real buildings) PLUS ad-hoc test/probe debris. Those were the exact rows that
// double-sold unit-101 and read "unit still available" on a confirmed sale (they predate the finding-#1 status
// fix), contradicting the non-substitutability moat in the smoke review. --fresh now ALSO wipes any non-seed
// offer that (a) sits on a seeded developer [isSeedDeveloper] — definitionally the seed's own territory, a
// hand-made offer would never target it — or (b) is unmistakable test junk [isTestJunkOffer]. Hand-made demo
// data (highbird/spotlight) is on NEITHER a seeded developer NOR a junk pattern, so it stays untouched.
export type FreshWipeReport = { offersRemoved: number; threadsRemoved: number; directConvsRemoved: number; directBuyersRemoved: number; rosterRemoved: number; agreementsRemoved: number; baselinesRemoved: number; paymentsRemoved: number };
export async function freshWipeSeedRows(): Promise<FreshWipeReport> {
  let offersRemoved = 0;
  let threadsRemoved = 0;
  let directConvsRemoved = 0;
  let directBuyersRemoved = 0;
  let rosterRemoved = 0;

  // ── OFFERS (by provenance marker + stale/junk reclaim) + their BOOKING threads (by requestId) ──
  const offers = await readJson<Array<{ requestId: string; developer?: string; display?: { origin?: string; buildingId?: string; unitId?: string } }>>("offers.json");
  const seedReqIds = new Set<string>();
  if (offers) {
    const kept = offers.filter((o) => {
      // A row is OURS-to-wipe if it's a current seed row, a stale pre-marker row on a seeded developer, or junk.
      const isSeed = o.display?.origin === "seed";
      const wipe = isSeed || isSeedDeveloperAcct(o.developer) || isTestJunkOffer(o);
      if (wipe) seedReqIds.add(o.requestId); // so the booking-thread sweep below clears their threads too
      return !wipe;
    });
    offersRemoved = offers.length - kept.length;
    await writeJson("offers.json", kept);
  }

  // ── DIRECT conversations + buyers for SEED-synthetic accounts (isSeedAccount), + their channel threads.
  // This is the fix for the review: a plain offer-only wipe left old direct-conversation WALLS behind
  // (threads keyed by conversationId, not requestId, on legacy accounts like amber-finch/quiet-harbor). We
  // recognise every account THIS seed could have made — both the new synthAccount space and legacy handles —
  // so a --fresh truly resets the seeded world. Hand-made demo accounts (highbird.testnet, the spotlight
  // account) are NOT seed accounts → never wiped (conservative; isSeedAccount returns false for them).
  const seedConvKeys = new Set<string>();
  const convs = await readJson<Array<{ id: string; buyer?: string; account?: string; [k: string]: unknown }>>("conversations-direct.json");
  if (convs) {
    const kept = convs.filter((c) => {
      const acct = (c.buyer ?? c.account ?? "") as string;
      const isSeed = isSeedAccount(acct);
      if (isSeed) seedConvKeys.add(c.id);
      return !isSeed;
    });
    directConvsRemoved = convs.length - kept.length;
    await writeJson("conversations-direct.json", kept);
  }
  const buyers = await readJson<Array<{ account: string; [k: string]: unknown }>>("buyers-direct.json");
  if (buyers) {
    const kept = buyers.filter((b) => !isSeedAccount(b.account));
    directBuyersRemoved = buyers.length - kept.length;
    await writeJson("buyers-direct.json", kept);
  }

  // ── AGENT ROSTER (buyers.json) — only the rows THIS seed created (roster-coherence fix). driveOffer
  // now writes each seeded sale's buyer onto the booking agent's roster with a deterministic `seed-roster-*`
  // id, so a non-fresh reseed OVERWRITES them. On --fresh we wipe the offers that justify those roster rows,
  // so clear the matching roster rows too — else a --fresh leaves orphan "My buyers" with no booking. Scoped
  // STRICTLY by the id prefix, so the hand-seeded demo roster (seed-buyers.mjs, random `buyer-*` ids) and any
  // real agent's buyers are NEVER touched (buyers.json is otherwise a hand-made/read-only input, per below).
  const roster = await readJson<Array<{ id?: string; [k: string]: unknown }>>("buyers.json");
  if (roster) {
    const kept = roster.filter((b) => !String(b.id ?? "").startsWith("seed-roster-"));
    rosterRemoved = roster.length - kept.length;
    await writeJson("buyers.json", kept);
  }

  // ── CHANNELS: remove booking threads (seed offers) AND direct threads (seed conversations). ──
  if (seedReqIds.size > 0 || seedConvKeys.size > 0) {
    const channels = await readJson<ChannelsFile>("channels.json");
    if (channels) {
      for (const key of Object.keys(channels)) {
        if (seedReqIds.has(key) || seedConvKeys.has(key)) {
          delete channels[key];
          threadsRemoved++;
        }
      }
      await writeJson("channels.json", channels);
    }
  }

  // ── AGREEMENTS + BASELINES: clear the SEED-created commission wiring so the reseed re-establishes it
  // COHERENTLY. Without this, a stale narrow pre-existing agreement is found FIRST by
  // liveAgreementBetween → the reseed's new multi-building agreement is shadowed → phantom "no_rate"
  // commission holes (the 15 saw on /dev/smoke). We remove ONLY the seed's own agreements — those
  // between a seed developer (`vvv-dev-*`) and a real agency in the proposed/agreed state (exactly what
  // ensureAgreement* creates). We PRESERVE any `declined`/`published`/`revoked` agreement and the direct
  // house-publish row (agency === "") — those are hand-curated demo states the seed never produces. Seed
  // baselines (keyed dev+building, regenerated idempotently each run) are cleared for seed developers so
  // the reseed re-dates them cleanly through the post-pass. Hand-made data is untouched.
  const isSeedDeveloper = (d: string) => /^vvv-dev-\d+\.testnet$/i.test((d ?? "").trim());
  let agreementsRemoved = 0;
  const agreements = await readJson<Array<{ seal?: { developer?: string; agency?: string }; status?: string }>>("agreements.json");
  if (agreements) {
    const kept = agreements.filter((g) => {
      const dev = g.seal?.developer ?? "";
      const agency = g.seal?.agency ?? "";
      const seedPair = isSeedDeveloper(dev) && agency.trim() !== "";
      const seedState = g.status === "proposed" || g.status === "agreed";
      const isSeedAgreement = seedPair && seedState;
      if (isSeedAgreement) agreementsRemoved++;
      return !isSeedAgreement;
    });
    await writeJson("agreements.json", kept);
  }
  let baselinesRemoved = 0;
  const baselines = await readJson<Array<{ developer?: string }>>("sale-baselines.json");
  if (baselines) {
    const kept = baselines.filter((b) => {
      const isSeed = isSeedDeveloper(b.developer ?? "");
      if (isSeed) baselinesRemoved++;
      return !isSeed;
    });
    await writeJson("sale-baselines.json", kept);
  }

  // ── PURE SEED-OUTPUT state stores: regenerated wholesale by each seed run, hold no hand-made data.
  // Resetting them to empty avoids stale status/ledger/event rows surviving across a --fresh. (status-
  // snapshot/ledger are re-derived by ensureBaseline + the finding-#1 status write; stamp-jobs/warroom/
  // buyer-events/events/activity are seed byproducts.) Catalog/agents/developers/gates/profiles/buyers/
  // KYC are NEVER touched (read-only inputs or hand-made).
  for (const f of ["status-snapshot.json", "status-ledger.json", "buyer-events.json", "events.json", "activity.json"]) {
    const existing = await readJson<unknown>(f);
    if (existing != null) await writeJson(f, Array.isArray(existing) ? [] : {});
  }

  // ── $VRX LEDGER (genesis STEP 2) — pure seed/demo output. The whole ledger (balances + claims + the
  // history txn log) is regenerated by the distribute pass + re-seeds its treasury on first mutation
  // (ensureGenesis), so resetting it to empty gives a clean, reproducible distribution each --fresh. (A real
  // deploy's ledger is NOT reseeded this way — this only runs under the dev/test --fresh reseed.)
  // reset UNCONDITIONALLY to [] (not just when non-null). A run crashed mid-write leaves a PARTIAL,
  // non-200M ledger; the old `if (existing != null)` guard would skip a deleted file but a half-written one
  // would survive and poison the next --fresh with "insufficient $VRX balance" (genesis never re-seeds because
  // the ledger isn't empty). Forcing [] makes --fresh self-healing regardless of prior crash state.
  for (const f of ["vrx-balances.json", "vrx-claims.json", "vrx-txns.json"]) {
    await writeJson(f, []);
  }

  // ── IMAGE SUBSYSTEM — pure seed/demo output. The hash-chained provenance ledger, the account-image
  // index, and the serve-time reveal-log are all regenerated by the seed's portrait/passport pass. Reset them
  // to empty AND clear the blob store so a --fresh gives a clean, reproducible image world each run. (A real
  // deploy's image store is NOT wiped this way — this only runs under the dev/test --fresh reseed.)
  for (const f of ["image-provenance.json", "account-images.json", "image-reveal-log.json"]) {
    const existing = await readJson<unknown>(f);
    if (existing != null) await writeJson(f, []);
  }
  try {
    const imagesDir = path.join(process.cwd(), ".data", "images");
    await fs.rm(imagesDir, { recursive: true, force: true });
  } catch {
    /* no blob dir yet — fine */
  }

  // ── PAYMENTS (genesis STEP 3/4) — remove ONLY the seed's own payment rows so the reseed re-logs them
  // cleanly (no double deposit/installments on re-run). A row is the seed's if its deal is a seed offer
  // (requestId collected above), OR its buyer/developer is a seed-synthetic account / seed developer (covers
  // the direct-lane synthetic requestIds). Hand-made/real payments (any other buyer/developer) are PRESERVED.
  let paymentsRemoved = 0;
  const payments = await readJson<Array<{ requestId?: string; buyer?: string; developer?: string }>>("payment-vault.json");
  if (payments) {
    const kept = payments.filter((p) => {
      const isSeedDeal = p.requestId ? seedReqIds.has(p.requestId) : false;
      const isSeedParty = isSeedAccount(p.buyer ?? "") || isSeedDeveloperAcct(p.developer ?? "");
      const wipe = isSeedDeal || isSeedParty;
      if (wipe) paymentsRemoved++;
      return !wipe;
    });
    await writeJson("payment-vault.json", kept);
  }

  return { offersRemoved, threadsRemoved, directConvsRemoved, directBuyersRemoved, rosterRemoved, agreementsRemoved, baselinesRemoved, paymentsRemoved };
}

// ── The resolved absolute timeline for ONE deal (all ms-epoch, derived from the schedule's days-ago) ──
export type DealDates = {
  key: string;
  kind: "offer" | "direct";
  developer: string;
  building: string;
  arrivalAt: number;
  previewFinalAt?: number;
  paymentArrivedAt?: number;
  signedAt?: number;
  confirmAt?: number;
  outcome: DatedTarget["schedule"]["outcome"];
};

/** Resolve each dated target's schedule (days-ago + dwell) into absolute, monotonic, strictly-past ms-epochs.
 *  dwell is applied cumulatively from arrival; every produced time is clamped to be < now and strictly after
 *  its predecessor (so the §5 ordering holds even if a dwell sample is 0). */
export function resolveDealDates(now: number, targets: DatedTarget[]): DealDates[] {
  return targets.map((t) => {
    const s = t.schedule;
    // Count the stages this deal actually has, so we can reserve room for a STRICTLY-increasing chain that all
    // lands before `now` even if a very-recent arrival + long dwell would otherwise overflow. We never collide
    // two stages on the `now-1` ceiling (the bug the invariant caught): instead, if arrival+dwell would reach
    // now, pull arrival earlier so the whole chain fits with ≥1ms gaps.
    const stageDwells = [s.dwell.toConfirm, s.dwell.toPreviewFinal, s.dwell.toPaymentArrived, s.dwell.toSigned];
    const nStages = stageDwells.filter((d) => d != null).length;
    const totalDwellMs = stageDwells.reduce<number>((acc, d) => acc + (d != null ? Math.max(d * DAY, 1) : 0), 0);
    // Latest arrival that still leaves room for every stage + a 1ms-per-stage safety margin before now.
    const latestArrival = now - totalDwellMs - nStages - 1;
    const arrivalAt = Math.min(now - s.arrivalDaysAgo * DAY, latestArrival);
    // Build forward from arrival; each stage strictly after the prior (≥ dwell, min +1ms).
    let cursor = arrivalAt;
    const step = (days: number | undefined): number | undefined => {
      if (days == null) return undefined;
      cursor = cursor + Math.max(days * DAY, 1);
      return cursor;
    };
    const confirmAt = s.dwell.toConfirm != null ? step(s.dwell.toConfirm) : undefined;
    const previewFinalAt = s.dwell.toPreviewFinal != null ? step(s.dwell.toPreviewFinal) : undefined;
    const paymentArrivedAt = s.dwell.toPaymentArrived != null ? step(s.dwell.toPaymentArrived) : undefined;
    const signedAt = s.dwell.toSigned != null ? step(s.dwell.toSigned) : undefined;
    return {
      key: t.key,
      kind: t.kind,
      developer: t.developer,
      building: t.building,
      arrivalAt,
      confirmAt,
      previewFinalAt,
      paymentArrivedAt,
      signedAt,
      outcome: s.outcome,
    };
  });
}

// ── Launch-era clustering (reworked): group by DEVELOPER, not per-building. Each
// developer is ONE launch era — their buildings cluster within a few months of each other — and the three
// developers' eras stagger ~1yr apart, with the OLDEST capped at ~3yr before now. This fixes the review
// finding: the old per-building stagger (~1.5yr × 9 buildings) spread launches across ~13yr → 2013–2024, which
// put a VRX "Signed 2013" on screen (before VRX existed). Clustering by developer reads like three real
// operators who each launched a recent portfolio. Deterministic (developers ordered by earliest deal). The
// per-building launch is still forced STRICTLY before that building's earliest deal (assertInvariants guards). ──
const PRE_LISTING_MARGIN = 90 * DAY;   // signing/baseline precede the first listing by ~3 months
const ERA_STAGGER = 365 * DAY;         // ~1yr between the three developers' launch eras
const INTRA_DEV_SPREAD = 75 * DAY;     // a developer's buildings launch within ~2.5 months of each other
const OLDEST_LAUNCH_CAP = 3 * 365 * DAY; // the oldest developer era sits no more than ~3yr before now

/** earliest deal arrival per building (ms). Buildings with no dated deal are omitted (nothing to anchor). */
function earliestArrivalPerBuilding(deals: DealDates[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of deals) {
    const cur = m.get(d.building);
    if (cur == null || d.arrivalAt < cur) m.set(d.building, d.arrivalAt);
  }
  return m;
}

/** For each (developer, building), the launch date its agreement+baseline should carry — strictly before the
 *  building's earliest deal, staggered per launch era. Returns a map keyed `${developer}|${building}`. */
export function launchDates(now: number, deals: DealDates[]): Map<string, number> {
  const earliestByBuilding = earliestArrivalPerBuilding(deals);
  // developer for a building (direct deals carry "" developer, so prefer an offer's dev).
  const devOf = new Map<string, string>();
  for (const d of deals) if (d.developer && !devOf.has(d.building)) devOf.set(d.building, d.developer);

  // Group buildings under their developer; track each developer's earliest deal across all its buildings.
  const devBuildings = new Map<string, string[]>();
  const devEarliest = new Map<string, number>();
  for (const [building, firstDeal] of earliestByBuilding.entries()) {
    const dev = devOf.get(building) ?? "";
    if (!devBuildings.has(dev)) devBuildings.set(dev, []);
    devBuildings.get(dev)!.push(building);
    const cur = devEarliest.get(dev);
    if (cur == null || firstDeal < cur) devEarliest.set(dev, firstDeal);
  }

  // Order developers oldest→newest by their earliest deal; newest era sits ~PRE_LISTING_MARGIN before its
  // earliest deal, each older developer one ERA_STAGGER further back, the whole span capped at OLDEST_LAUNCH_CAP.
  const devOrder = [...devEarliest.entries()].sort((a, b) => a[1] - b[1]).map(([dev]) => dev);
  const n = devOrder.length;
  const out = new Map<string, number>();
  devOrder.forEach((dev, devIdx) => {
    // Era anchor: newest (devIdx=n-1) = earliest deal − margin; older eras step back by ERA_STAGGER. Clamp the
    // oldest so the whole timeline is at most ~OLDEST_LAUNCH_CAP before now ("recent portfolios", not 2013).
    const stepsBack = (n - 1) - devIdx;
    const anchor = devEarliest.get(dev)! - PRE_LISTING_MARGIN - stepsBack * ERA_STAGGER;
    const eraAnchor = Math.max(anchor, now - OLDEST_LAUNCH_CAP);
    // Buildings within this developer cluster within ~INTRA_DEV_SPREAD, ordered by their own earliest deal.
    const buildings = devBuildings.get(dev)!.sort((a, b) => earliestByBuilding.get(a)! - earliestByBuilding.get(b)!);
    buildings.forEach((building, bIdx) => {
      const clustered = eraAnchor - (buildings.length - 1 - bIdx) * INTRA_DEV_SPREAD;
      // Hard invariant guard: a building's launch MUST precede its own earliest deal (assertInvariants throws
      // otherwise). If the era date landed after this building's first deal, pull it back a day before it.
      const ceiling = earliestByBuilding.get(building)! - DAY;
      out.set(`${dev}|${building}`, Math.min(clustered, ceiling, now - 1));
    });
  });
  return out;
}

// ── §5 invariant assertion — THROWS on violation (fail loud in a dev seed) ──
export function assertInvariants(now: number, deals: DealDates[], launch: Map<string, number>): void {
  for (const d of deals) {
    const L = launch.get(`${d.developer}|${d.building}`);
    if (L != null && !(L < d.arrivalAt)) {
      throw new Error(`invariant: launch(${L}) !< arrival(${d.arrivalAt}) for ${d.building} ${d.key.slice(0, 8)}`);
    }
    const chain = [d.arrivalAt, d.confirmAt, d.previewFinalAt, d.paymentArrivedAt, d.signedAt].filter(
      (x): x is number => x != null
    );
    for (let i = 1; i < chain.length; i++) {
      if (!(chain[i] > chain[i - 1])) throw new Error(`invariant: non-monotonic stage dates for ${d.key.slice(0, 8)}`);
    }
    for (const x of chain) if (!(x < now)) throw new Error(`invariant: date ${x} !< now for ${d.key.slice(0, 8)}`);
  }
}

// ── On-disk shapes we touch (minimal — only the date fields; the rest is spread through untouched) ──
type OffersFile = Array<{
  requestId: string;
  at?: number;
  confirmed?: { at: number; by: string; tx?: string };
  contract?: { stage: string; finalAt?: number; paymentArrivedAt?: number; signedAt?: number; [k: string]: unknown };
  [k: string]: unknown;
}>;
type ChannelsFile = Record<string, ChannelMessage[]>;
type StatusSnapshotFile = Record<string, { units: Record<string, number>; filledAt: number; complete?: boolean; unitAt?: Record<string, number> }>;
type LedgerFile = Array<{ id: string; buildingId: string; unit: string; from: number | null; to: number; at: number }>;

/** The report the post-pass returns (for the seed's summary + a reviewer). */
export type BackfillDatesReport = {
  offersDated: number;
  threadsRechained: number;
  baselinesResealed: number;
  agreementsResealed: number;
  vrxAgreementsResealed: number;
  statusTransitionsDated: number;
  notes: string[];
};

/**
 * Re-date the seed's own .data rows to the schedules in `dated`. Pure w.r.t. the chain (never broadcasts);
 * writes only .data files. Idempotent in the sense that re-running with the SAME `dated` produces the SAME
 * dates (the schedule is deterministic from the seed), but it is intended to run ONCE right after a seed run
 * (or a --fresh wipe + seed). THROWS if a §5 invariant is violated (caller should surface it, not swallow).
 */
export async function backfillDates(dated: DatedTarget[], now: number = Date.now()): Promise<BackfillDatesReport> {
  const notes: string[] = [];
  const deals = resolveDealDates(now, dated);
  const launch = launchDates(now, deals);
  assertInvariants(now, deals, launch); // fail loud BEFORE writing anything

  const byKey = new Map(deals.map((d) => [d.key, d]));

  // 1) OFFERS (off-seal dates — plain overwrite). Re-date record `at`, confirmed.at, contract.*At.
  let offersDated = 0;
  const statusTransitionDates = new Map<string, { building: string; unit: string; at: number }>(); // requestId → confirm-dated transition
  const offers = await readJson<OffersFile>("offers.json");
  if (offers) {
    for (const o of offers) {
      const d = byKey.get(o.requestId);
      if (!d || d.kind !== "offer") continue;
      o.at = d.arrivalAt;
      if (o.confirmed && d.confirmAt != null) o.confirmed.at = d.confirmAt;
      if (o.contract) {
        if (o.contract.finalAt != null && d.previewFinalAt != null) o.contract.finalAt = d.previewFinalAt;
        if (o.contract.paymentArrivedAt != null && d.paymentArrivedAt != null) o.contract.paymentArrivedAt = d.paymentArrivedAt;
        if (o.contract.signedAt != null && d.signedAt != null) o.contract.signedAt = d.signedAt;
      }
      offersDated++;
    }
    await writeJson("offers.json", offers);
  }

  // 2) CHANNELS (SEALED — re-chain). Re-date each message `at` within its deal's timeline, then re-chain the
  //    thread so every `h` verifies again. Messages are spread between arrival and the latest stage date.
  let threadsRechained = 0;
  const channels = await readJson<ChannelsFile>("channels.json");
  if (channels) {
    for (const d of deals) {
      const thread = channels[d.key];
      if (!thread || thread.length === 0) continue;
      const lastStage = d.signedAt ?? d.paymentArrivedAt ?? d.previewFinalAt ?? d.confirmAt ?? d.arrivalAt;
      const span = Math.max(lastStage - d.arrivalAt, (thread.length - 1) * 1000);
      // Spread messages evenly across [arrival, lastStage], strictly increasing, all < now.
      thread.forEach((m, i) => {
        const t = d.arrivalAt + Math.round((span * i) / Math.max(thread.length - 1, 1));
        m.at = Math.min(t, now - 1);
      });
      rechainThread(thread); // SEALED-date fix: recompute the hash chain with the new timestamps
      threadsRechained++;
    }
    await writeJson("channels.json", channels);
  }

  // 3) STATUS SNAPSHOT + LEDGER (off-seal). A confirmed deal's status transition date == its confirm date
  //    (§5). We re-date the ledger rows for a confirmed deal's unit to its confirmAt, and the snapshot's
  //    per-unit freshness (unitAt) to match. The snapshot filledAt is set to the newest dated activity.
  for (const d of deals) {
    if (d.kind === "offer" && d.confirmAt != null) {
      const o = (offers ?? []).find((x) => x.requestId === d.key);
      // the unit is on the offer display; re-read it from the offers file we loaded.
      const unit = (o?.display as { unitId?: string } | undefined)?.unitId;
      if (unit) statusTransitionDates.set(d.key, { building: d.building, unit, at: d.confirmAt });
    }
  }
  let statusTransitionsDated = 0;
  const ledger = await readJson<LedgerFile>("status-ledger.json");
  if (ledger) {
    // Map (building, unit) → confirm date for any confirmed deal.
    const want = new Map<string, number>();
    for (const v of statusTransitionDates.values()) want.set(`${v.building}|${v.unit}`, v.at);
    for (const row of ledger) {
      const key = `${row.buildingId}|${row.unit}`;
      const at = want.get(key);
      if (at != null && row.to === 2 /* closed */) {
        row.at = at;
        statusTransitionsDated++;
      }
    }
    await writeJson("status-ledger.json", ledger);
  }
  const snapshot = await readJson<StatusSnapshotFile>("status-snapshot.json");
  if (snapshot) {
    for (const v of statusTransitionDates.values()) {
      const b = snapshot[v.building];
      if (b) {
        b.unitAt = b.unitAt ?? {};
        b.unitAt[v.unit] = v.at;
      }
    }
    await writeJson("status-snapshot.json", snapshot);
  }

  // 4) BASELINES (SEALED — re-seal). establishedAt = the building's launch date (strictly before its first
  //    deal). Only re-date baselines for buildings the backfill touched.
  let baselinesResealed = 0;
  const baselines = await readJson<SaleBaseline[]>("sale-baselines.json");
  if (baselines) {
    for (let i = 0; i < baselines.length; i++) {
      const b = baselines[i];
      const L = launch.get(`${b.developer}|${b.building}`);
      if (L == null) continue;
      baselines[i] = resealBaselineWithDate(b, L);
      baselinesResealed++;
    }
    await writeJson("sale-baselines.json", baselines);
  }

  // 5) AGREEMENTS (SEALED — re-seal proposedAt). Date each agency↔developer agreement BEFORE the earliest
  //    deal it governs — use the developer's EARLIEST launch date (so the agency relationship predates every
  //    building it can sell). proposedAt is inside the seal → recompute sealHash via agreementDigest.
  let agreementsResealed = 0;
  const earliestLaunchPerDev = new Map<string, number>();
  for (const [k, v] of launch.entries()) {
    const dev = k.split("|")[0];
    const cur = earliestLaunchPerDev.get(dev);
    if (cur == null || v < cur) earliestLaunchPerDev.set(dev, v);
  }
  const agreements = await readJson<Agreement[]>("agreements.json");
  if (agreements) {
    for (const g of agreements) {
      const dev = g.seal?.developer;
      const L = dev ? earliestLaunchPerDev.get(dev) : undefined;
      if (L == null || !g.salt) continue;
      g.seal.proposedAt = Math.max(L - DAY, 0); // the agency agreement sits just before the first launch
      g.sealHash = agreementDigest(g.seal, g.salt);
      agreementsResealed++;
    }
    await writeJson("agreements.json", agreements);
  }

  // 6) VRX↔DEVELOPER AGREEMENTS (SEALED — re-seal signedAt + record `at`). "Signing precedes listing": date
  //    each developer's VRX agreement BEFORE that developer's earliest launch. signedAt is inside the seal.
  let vrxAgreementsResealed = 0;
  const vrxAgreements = await readJson<VrxDeveloperAgreement[]>("vrx-developer-agreements.json");
  if (vrxAgreements) {
    for (const g of vrxAgreements) {
      const dev = g.seal?.developer;
      const L = dev ? earliestLaunchPerDev.get(dev) : undefined;
      if (L == null || !g.salt) continue;
      const signAt = Math.max(L - 2 * DAY, 0); // VRX signing is the very first step, before any agency agreement
      g.seal.signedAt = signAt;
      g.at = signAt;
      g.sealHash = vrxDeveloperAgreementDigest(g.seal, g.salt);
      vrxAgreementsResealed++;
    }
    await writeJson("vrx-developer-agreements.json", vrxAgreements);
  }

  notes.push(
    `dated ${offersDated} offers, re-chained ${threadsRechained} threads, re-sealed ${baselinesResealed} baselines / ${agreementsResealed} agreements / ${vrxAgreementsResealed} VRX agreements, dated ${statusTransitionsDated} status transitions.`
  );
  return {
    offersDated,
    threadsRechained,
    baselinesResealed,
    agreementsResealed,
    vrxAgreementsResealed,
    statusTransitionsDated,
    notes,
  };
}
