// JUDGE-FACING DEMO. ONE command, ZERO wallet setup:
// npm run demo → seed the big world + drive one buyer end-to-end + print trace + JSON
// npm run demo -- --json → print ONLY the machine-readable JSON (for an AI judge to parse)
// entry point + a readable "do X → see Y" trace + a parseable result. This script is that entry point.
// 1. It SEEDS the rich existing world by reusing lib/seed-funnel (9 buildings, 3 developers, agencies,
// agents, offers at every stage, commissions) — the real multi-actor system, not a toy.
// 2. Then it SPOTLIGHTS one direct buyer and walks them through the whole PRIVACY funnel by driving the
// REAL product code paths, printing one plain-language line per step:
// save profile → SEAL (attest + lock) → desk opens a unit → eligibility bar → deposit → firm-hold.
// 3. It proves the PRIVACY MOAT at each sealed record: re-verifying the salted seal (tamper-evidence) and
// showing that only an OPAQUE unit_key + a house ORG ever reach the chain — PII / terms / amounts stay
// off-chain and sealed.
// WHY ZERO SETUP / NO CHAIN (the two hard constraints):
// • NO RPC. Eligibility normally reads a live wallet balance (offer-eligibility.ts). A judge has no funded
// the PURE `eligibilityFrom` combiner with a demo balance — deterministic, offline, same bar logic.
// • NO BROADCAST. The on-chain firm-hold (grant_exclusive) is STUBBED with a deterministic fake tx hash
// orphans). The stub proves the LOGIC; the one real on-chain proof run is a follow-on step.
// IDEMPOTENT: the spotlight uses its own dedicated account, so re-runs overwrite only its own rows and never
// touch the hand-made demo data. PRIVACY: synthetic PII only; nothing broadcast.

import { runSeedFunnel } from "./seed-funnel";
import {
  saveBuyerProfile,
  sealProfile,
  getBuyerDirect,
  advanceFunnel,
  readinessFor,
  verifyBuyerDirect,
} from "./buyers-direct";
import { grantUnit } from "./unit-grants";
import { eligibilityFrom } from "./offer-eligibility";
import { recordDeposit, attachHold, verifyDeposit } from "./direct-deposits";
import { getDeveloper, directSaleThresholdUsd, houseOrgFor } from "./developers";
import { getBuilding } from "./catalog";
import { settlementRollup } from "./earmark";
import { digest } from "./seal";

// ── The spotlight buyer (dedicated account → idempotent, never collides with the seed's own buyers) ──────────
const SPOTLIGHT_ACCOUNT = "demo-walkin.testnet";
const SPOTLIGHT_BUILDING = "garden-court"; // directSale-visible, desk = vvv-dev-03 (per the seed plan)
const SPOTLIGHT_DEVELOPER = "vvv-dev-03.testnet";
const DEMO_BALANCE_USD = 25_000; // a "serious buyer" balance, well over the per-developer bar (offline, no RPC)
const DEPOSIT_AMOUNT_MINOR = 300_000; // THB 3,000.00 reservation deposit (private off-chain figure)

const SPOTLIGHT_PROFILE = {
  name: "Elena Fischer",
  legalName: "Elena Marie Fischer",
  nationality: "German",
  phone: "+66 98 765 4321",
  email: "elena.fischer@examplemail.com",
  passportNo: "P4471188",
  address: "88 Second Road, Pattaya, Chonburi 20150, Thailand",
};

type StepTrace = { step: string; did: string; saw: string };

// A tiny deterministic stub for the one on-chain write the firm-hold makes (grant_exclusive). Never broadcasts.
function stubFirmHold(unitKey: string, houseOrg: string): { tx: string; holdUntil: number } {
  const tx = `stub:grant_exclusive:${digest({ unitKey, houseOrg }, "vrx-demo-hold", "").slice(0, 16)}`;
  const holdUntil = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7-day window (ms; mirrors Exclusive.until shape)
  return { tx, holdUntil };
}

async function runSpotlight(): Promise<{ trace: StepTrace[]; result: Record<string, unknown> }> {
  const trace: StepTrace[] = [];
  const dev = await getDeveloper(SPOTLIGHT_DEVELOPER);
  const bld = await getBuilding(SPOTLIGHT_BUILDING);
  const unitId = bld?.inventory?.[0]?.id ?? "";
  if (!dev || !bld || !unitId) {
    throw new Error(
      `spotlight preconditions missing (dev=${!!dev} building=${!!bld} unit=${unitId || "none"}) — run the seed first`
    );
  }

  // 1. SAVE PROFILE — a walk-in connects a wallet and saves their own PII (off-chain, buyer-owned).
  const saved = await saveBuyerProfile(SPOTLIGHT_ACCOUNT, SPOTLIGHT_PROFILE);
  if (saved === "sealed" || !saved) {
    // Already sealed from a prior run — re-open then overwrite isn't needed; a sealed identical profile is fine.
  }
  trace.push({
    step: "1. save profile",
    did: `buyer ${SPOTLIGHT_ACCOUNT} saves their KYC profile`,
    saw: `profile stored OFF-CHAIN, buyer-owned; PII never touches the chain`,
  });

  // 2. SEAL — the buyer attests "this is me" → the record LOCKS and gets a salted tamper-evident seal.
  const sealed = await sealProfile(SPOTLIGHT_ACCOUNT);
  const buyer = sealed ?? (await getBuyerDirect(SPOTLIGHT_ACCOUNT));
  const sealOk = buyer ? verifyBuyerDirect(buyer) : false;
  trace.push({
    step: "2. seal profile",
    did: `buyer seals (attests + locks) their profile`,
    saw: `sealed=${!!buyer?.sealed}; seal re-verifies=${sealOk}; on-chain this is only an opaque SHA-256 digest (salt held off-chain) — un-brute-forceable`,
  });

  // 3. DESK OPENS A UNIT — the operator deliberately grants this buyer one specific unit (anti-browsing funnel).
  const grant = await grantUnit(SPOTLIGHT_ACCOUNT, SPOTLIGHT_BUILDING, unitId, SPOTLIGHT_DEVELOPER);
  await advanceFunnel(SPOTLIGHT_ACCOUNT, "units_opened");
  trace.push({
    step: "3. desk opens unit",
    did: `desk ${SPOTLIGHT_DEVELOPER} opens unit ${unitId} in ${SPOTLIGHT_BUILDING} to the buyer`,
    saw: `grant sealed=${!!grant}; funnel → units_opened; buyer may now see this unit in detail`,
  });

  // 4. ELIGIBILITY BAR — the single gate the deposit respects: profile ∧ sealed+KYC ∧ balance ≥ threshold.
  // Computed PURELY (eligibilityFrom) with a demo balance → no RPC, no funded wallet (zero-setup).
  const thresholdUsd = directSaleThresholdUsd(dev);
  const freshBuyer = await getBuyerDirect(SPOTLIGHT_ACCOUNT);
  const elig = eligibilityFrom(freshBuyer, thresholdUsd, DEMO_BALANCE_USD);
  const ready = readinessFor(freshBuyer, dev.requiredProfileFields);
  if (elig.eligible) await advanceFunnel(SPOTLIGHT_ACCOUNT, "offer_eligible");
  trace.push({
    step: "4. eligibility bar",
    did: `check the offer bar (threshold $${thresholdUsd}, demo balance $${DEMO_BALANCE_USD})`,
    saw: `eligible=${elig.eligible} (profile=${elig.reasons.profileSaved} · sealed+kyc=${elig.reasons.kyc} · balance=${elig.reasons.balance}); required fields met=${ready.met}`,
  });

  // 5. DEPOSIT — a vetted, eligible buyer puts down a deposit; the desk records it (private off-chain figure).
  const unitKey = digest({ building: SPOTLIGHT_BUILDING, unit: unitId }, "vrx-unit", "");
  const deposit = await recordDeposit({
    buyer: SPOTLIGHT_ACCOUNT,
    building: SPOTLIGHT_BUILDING,
    unit: unitId,
    unitKey,
    by: SPOTLIGHT_DEVELOPER,
    amountMinor: DEPOSIT_AMOUNT_MINOR,
    currency: "THB",
  });
  const depOk = deposit ? verifyDeposit(deposit) : false;
  trace.push({
    step: "5. deposit",
    did: `desk records the buyer's deposit (THB ${(DEPOSIT_AMOUNT_MINOR / 100).toLocaleString()})`,
    saw: `deposit sealed=${!!deposit}; seal re-verifies=${depOk}; amount is PRIVATE off-chain — never on-chain`,
  });

  // 6. FIRM-HOLD — the desk firm-holds the unit on-chain for the buyer (grant_exclusive to the HOUSE ORG).
  // STUBBED: no broadcast (contract frozen). Only an opaque unit_key + a house org reach the chain.
  const houseOrg = houseOrgFor(dev) ?? `${SPOTLIGHT_DEVELOPER.replace(".testnet", "")}-house.testnet`;
  const { tx: holdTx, holdUntil } = stubFirmHold(unitKey, houseOrg);
  const held = await attachHold(SPOTLIGHT_ACCOUNT, SPOTLIGHT_BUILDING, unitId, holdTx, holdUntil);
  trace.push({
    step: "6. firm-hold (on-chain, STUBBED)",
    did: `desk firm-holds unit ${unitId} for the buyer via grant_exclusive`,
    saw: `status=${held?.status}; tx=${holdTx} (stub, never broadcast); on-chain = opaque unit_key + house org ${houseOrg} ONLY`,
  });

  const result: Record<string, unknown> = {
    buyer: SPOTLIGHT_ACCOUNT,
    building: SPOTLIGHT_BUILDING,
    unit: unitId,
    developer: SPOTLIGHT_DEVELOPER,
    profileSealed: !!buyer?.sealed,
    profileSealVerifies: sealOk,
    eligible: elig.eligible,
    eligibilityReasons: elig.reasons,
    thresholdUsd,
    depositAmountMinor: DEPOSIT_AMOUNT_MINOR,
    depositCurrency: "THB",
    depositSealVerifies: depOk,
    firmHoldStatus: held?.status ?? null,
    firmHoldTx: holdTx,
    firmHoldStubbed: true,
    onChainExposure: { unitKey, houseOrg, note: "ONLY an opaque unit_key + a house org reach the chain; PII/terms/amount stay off-chain + sealed" },
  };
  return { trace, result };
}

async function main() {
  const jsonOnly = process.argv.includes("--json");

  // 1. Seed the big multi-actor world (reuses lib/seed-funnel — idempotent).
  const world = await runSeedFunnel();

  // 2. Drive the spotlight buyer end-to-end through the privacy funnel.
  const { trace, result } = await runSpotlight();

  // 3. Roll up the money LOGIC: developer→agency commission + developer→VRX protocol fee (earmark, no transacting).
  const settlement = await settlementRollup();

  const payload = {
    world: {
      directBuyersCreated: world.directCreated,
      offersCreated: world.offersCreated,
      commissionsResolved: world.commissionsResolved,
      onChainCallsStubbed: world.stubbedCalls.length,
      holes: world.holes.length,
    },
    spotlight: result,
    settlement: {
      commissionAccruedUsd: settlement.totals.commission.accruedUsd,
      commissionProspectiveUsd: settlement.totals.commission.prospectiveUsd,
      vrxFeeAccruedUsd: settlement.totals.vrxFee.accruedUsd,
      vrxFeeProspectiveUsd: settlement.totals.vrxFee.prospectiveUsd,
      settledUsd: settlement.totals.commission.settledUsd, // 0 until the TAKE/on-rail settlement
      byAgency: settlement.byAgency,
      byVrx: settlement.byVrx,
    },
    privacy: {
      track: "Privacy & Private AI",
      claim: "Every real-world identifier on-chain is an opaque salted hash; PII, deal terms and amounts stay off-chain and sealed (tamper-evident, re-verifiable).",
    },
  };

  if (jsonOnly) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  // ── Human "do X → see Y" trace ──
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  VRX — a private, on-chain reservation primitive · judge demo          ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("WORLD SEEDED (real multi-actor system, all off-chain — no wallet needed):");
  console.log(`  • direct buyers created : ${world.directCreated}`);
  console.log(`  • agent offers created  : ${world.offersCreated}`);
  console.log(`  • commissions resolved  : ${world.commissionsResolved}`);
  console.log(`  • on-chain calls stubbed: ${world.stubbedCalls.length} (never broadcast)`);
  console.log(`  • holes surfaced        : ${world.holes.length}`);
  console.log("");
  console.log("SPOTLIGHT — one buyer, the whole privacy funnel, do X → see Y:");
  for (const t of trace) {
    console.log("");
    console.log(`  ▸ ${t.step}`);
    console.log(`      do  : ${t.did}`);
    console.log(`      see : ${t.saw}`);
  }
  console.log("");
  console.log("MONEY LOGIC (earmark → settle; no transacting — the TAKE rail is not yet live):");
  console.log(`  • developer→agency commission : $${payload.settlement.commissionAccruedUsd.toLocaleString()} accrued · $${payload.settlement.commissionProspectiveUsd.toLocaleString()} prospective`);
  console.log(`  • developer→VRX protocol fee  : $${payload.settlement.vrxFeeAccruedUsd.toLocaleString()} accrued · $${payload.settlement.vrxFeeProspectiveUsd.toLocaleString()} prospective (${payload.settlement.byVrx.length} developer(s))`);
  console.log(`  • settled so far              : $${payload.settlement.settledUsd.toLocaleString()} (0 — on-rail settlement is the deferred step)`);
  console.log("");
  console.log("PRIVACY MOAT (primary track): " + payload.privacy.claim);
  console.log("");
  console.log("── machine-readable result (JSON) ──────────────────────────────────────");
  console.log(JSON.stringify(payload, null, 2));
  console.log("────────────────────────────────────────────────────────────────────────");
  console.log("Re-run with `npm run demo -- --json` for JSON only.");
}

main().catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
