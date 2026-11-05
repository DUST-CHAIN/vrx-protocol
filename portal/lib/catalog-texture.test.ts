// the CATALOG-TEXTURE pass: the seed finally feeds the two EXISTING off-chain subsystems it
// never populated — per-building project.status (→ resolveBuildState clause fork) and ~30% off-market
// withholding (→ buyer-facing status mask + stats exclusion). This is a PURE unit test of the deterministic
// pieces (projectStatusFor, pickWithheld) + the invariants the full pass must honour; it does NOT touch .data.
// Run via `npx -y tsx lib/catalog-texture.test.ts` (same plain-assertion harness as the sibling tests).
import { projectStatusFor, pickWithheld, textureRng } from "./seed-funnel";
import { resolveBuildState } from "./sale-contract";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// The 9 seed buildings (mirror DEV_BUILDINGS order: dev-01 oldest era → dev-03 newest).
const DEV01 = ["miracle-tower", "oceanview", "skyline-tower"];
const DEV02 = ["parkgate", "palmgate", "gardengate"];
const DEV03 = ["garden-court", "northpoint", "southbay"];
const ALL = [...DEV01, ...DEV02, ...DEV03];

// ── project.status: EXACTLY ONE ready analogue, coherent with launch-era ────────────────────────────────
const statuses = ALL.map(projectStatusFor);
ok(statuses.filter((s) => s === "complete").length === 1, "exactly one building is 'complete' (the Paradise/ready analogue)");
ok(projectStatusFor("miracle-tower") === "complete", "the oldest developer's FIRST building is the ready one");
ok(DEV01.slice(1).every((b) => projectStatusFor(b) === "building"), "oldest-era siblings are late-stage 'building'");
ok(DEV02.every((b) => projectStatusFor(b) === "building"), "mid-era buildings are 'building'");
ok(DEV03.every((b) => projectStatusFor(b) === "planning"), "newest-era buildings are 'planning'");
// It must drive the clause fork the right way: complete → ready (omits construction machinery), else off_plan.
ok(resolveBuildState({ projectStatus: projectStatusFor("miracle-tower") }) === "ready", "the ready building resolves to a READY (built) S&P");
ok(ALL.filter((b) => b !== "miracle-tower").every((b) => resolveBuildState({ projectStatus: projectStatusFor(b) }) === "off_plan"), "every other building resolves to an OFF-PLAN S&P");

// ── withholding: deterministic, ~share, reproducible, non-destructive to the input ──────────────────────
const inv = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}` }));
const a = pickWithheld(inv, 0.3, textureRng());
const b = pickWithheld(inv, 0.3, textureRng());
ok(a.length === 12, `~30% of 40 units withheld (got ${a.length}, want 12)`);
ok(JSON.stringify(a) === JSON.stringify(b), "selection is reproducible — two runs of the seeded RNG pick the SAME units (idempotent reseed)");
ok(new Set(a.map((u) => u.id)).size === a.length, "no duplicate units in the withheld set");
ok(a.every((u) => inv.some((o) => o.id === u.id)), "every withheld unit comes from the input inventory");
ok(inv.length === 40, "pickWithheld does not mutate its input array");
ok(pickWithheld(inv, 0, textureRng()).length === 0, "share 0 withholds nothing (disable knob)");

// ── anti-fraud: the pass only ever offers OPEN/UNSTAMPED units to pickWithheld. Simulate the eligibility
//    filter the real pass applies and assert a held/sold unit can never be selected. ──────────────────────
const OPEN = 0, HOLD = 1, CLOSED = 2, DONE = 3, UNSTAMPED = -1;
const mixed = [
  { id: "open-1", st: OPEN }, { id: "unstamped-1", st: UNSTAMPED },
  { id: "hold-1", st: HOLD }, { id: "closed-1", st: CLOSED }, { id: "done-1", st: DONE },
  { id: "open-2", st: OPEN },
];
const eligible = mixed.filter((u) => u.st === OPEN || u.st === UNSTAMPED);
const withheld = pickWithheld(eligible, 1.0, textureRng()); // share 1.0 → take ALL eligible
ok(withheld.every((u) => u.st === OPEN || u.st === UNSTAMPED), "a held/closed/done unit is NEVER withheld (D98 anti-fraud guard)");
ok(withheld.length === 3, "only the 3 open/unstamped units are eligible to withhold (the 3 held/sold ones excluded)");

console.log(`\ncatalog-texture: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
