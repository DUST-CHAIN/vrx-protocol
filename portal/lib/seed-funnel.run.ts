// Runner for the full-funnel seed harness (+ dated backfill). MUST be run from the portal/ dir so
// process.cwd/.data resolves to the real store. Usage:
//   npx -y tsx lib/seed-funnel.run.ts                 → seed + date the world (writes .data)
//   npx -y tsx lib/seed-funnel.run.ts --dry-run       → print the plan, write nothing
//   npx -y tsx lib/seed-funnel.run.ts --count 60      → size the count-parametric backfill (default 48)
//   npx -y tsx lib/seed-funnel.run.ts --fresh         → wipe the seed's OWN rows first (reproducible reseed)
//   npx -y tsx lib/seed-funnel.run.ts --no-dates      → seed only, SKIP the timestamp post-pass
//
// It prints a compact report; the HOLES list is the real deliverable (copy into the design docs).

import { runSeedFunnel } from "./seed-funnel";
import { backfillDates, freshWipeSeedRows } from "./backfill-dates";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const fresh = process.argv.includes("--fresh");
  const noDates = process.argv.includes("--no-dates");
  const countArg = argValue("--count");
  const count = countArg ? Math.max(1, parseInt(countArg, 10) || 48) : 48;

  if (fresh && !dryRun) {
    const w = await freshWipeSeedRows();
    console.log(`--fresh: removed ${w.offersRemoved} offers, ${w.agreementsRemoved} agreements, ${w.baselinesRemoved} baselines, ${w.directConvsRemoved} direct convs, ${w.directBuyersRemoved} direct buyers, ${w.rosterRemoved} roster buyers, ${w.threadsRemoved} threads, ${w.paymentsRemoved} payments + reset status/event/$VRX stores before reseed.`);
  }

  const r = await runSeedFunnel({ dryRun, count });

  // The timestamp POST-PASS: re-date the seed's own rows to the ~2–3yr timeline (unless --dry-run/--no-dates).
  let dateNote = "";
  if (!dryRun && !noDates) {
    const dr = await backfillDates(r.dated);
    dateNote = dr.notes[0] ?? "";
  }

  console.log("── SEED FUNNEL REPORT ─────────────────────────────────────");
  console.log(`plan size             : ${count}${dryRun ? " (dry-run)" : ""}`);
  console.log(`direct buyers created : ${r.directCreated}`);
  console.log(`offers created        : ${r.offersCreated}`);
  console.log(`commissions resolved  : ${r.commissionsResolved}`);
  console.log(`dated targets         : ${r.dated.length}`);
  console.log(`on-chain calls STUBBED: ${r.stubbedCalls.length} (never broadcast)`);
  if (dateNote) console.log(`post-pass             : ${dateNote}`);
  console.log("");
  if (r.notes.length) {
    console.log("NOTES:");
    for (const n of r.notes) console.log(`  • ${n}`);
    console.log("");
  }
  if (r.holes.length) {
    console.log(`HOLES (${r.holes.length}):`);
    for (const h of r.holes) {
      console.log(`  ✗ [${h.where}]`);
      console.log(`      promise : ${h.promise}`);
      console.log(`      broken  : ${h.brokenBy}`);
    }
  } else {
    console.log("HOLES: none surfaced by the harness.");
  }
  console.log("───────────────────────────────────────────────────────────");
}

main().catch((e) => {
  console.error("seed-funnel runner failed:", e);
  process.exit(1);
});
