# VRX — a private, on-chain reservation primitive

> **Active development (as of November 2026).** This is the product source, curated for the NEAR hackathon. The capability status tags (`[built]` / `[in progress]` / `[planned]`) are honest about what runs today; the live demo below is the fastest way to see it working.

> **One trusted source of truth for *who reserved what* — without putting prices, terms, or personal data on-chain.**
>
> *The why:* an open, private, secure marketplace where anyone, anywhere can transact — across borders, without asking permission. Real estate is where we start; the goal was never just property.
>
> Live demo: **https://vrx.poolo.org** · The business behind it: **[Vetted Realty](https://vettedrealty.com)**

---

## What's new

*A running log of what's landed — refreshed through the hackathon window so a repeat visitor can see movement.*

- **2026-11-05** — **The AI Sales Director now SHOWS, not just tells.** The desk AI can open a specific unit
  straight into the buyer's in-app view (floor plan, renderings, live availability) the way a human operator
  would — instead of describing it or offering to email photos — and it drives the deal through real stages
  (browse → qualify → hold → deposit) with each action gated by the deal's actual state, so it can't fast-talk
  past a step it hasn't earned. PII is still scrubbed before the model ever sees it. `[built]`, live in the demo.
- **2026-11-05** — Portal polish from live testing: the agency's "My agents" roster now lists its agents
  (previously only the performance view did), and the mobile account menu's settings + identity-card buttons
  open correctly. `[built]`.
- **2026-11-05** — **AI Sales Director is live.** The developer's direct sales desk can now run itself: a buyer
  messages the desk, and an AI salesperson qualifies them, sells on value, and *deflects discount asks into
  real levers* (furniture packages, payment-plan terms) instead of just dropping the price — all inside the
  same privacy gates, with every PII field scrubbed before the model ever sees it. Fully autonomous by default,
  with per-action operator toggles and a bounded concession cap. `[built]`, default-on in the demo.
- **2026-11-05** — **Model Maker (MM)** added to the toolchain (source in this repo). An authoring studio for
  building the inventory itself — land → building → floor → unit geometry, stacking plans, furniture, marketing
  media, and a developer-view preview. `[in progress]` — see the [Model Maker](#model-maker-mm--authoring-the-inventory) section.
- **2026-11-05** — Demo world refreshed: cleaner building/brand presentation, self-healing seed, and a $VRX
  genesis that funds the full developer→agency→agent trust chain end-to-end.

---

## For a hackathon judge, in 60 seconds

You don't need a wallet, a browser, or an account. Clone the repo and run **one command**:

```bash
cd portal
npm ci
npm run demo
```

It seeds the real multi-actor world and walks one buyer through the whole privacy funnel —
save profile → seal → desk opens a unit → eligibility → deposit → firm-hold — printing a
plain **"do X → see Y"** line for every step, then a machine-readable JSON result. It runs
fully offline: no RPC, nothing broadcast. (Add `-- --json` for JSON only, if your AI judge
would rather parse than read.) The exact output you'll see is quoted below under
[Run the judge demo](#run-the-judge-demo-verified).

Everything the demo does is also live as a clickable app at **https://vrx.poolo.org** (a
sandbox — enter the passphrase on the cover page, pick any role, no wallet needed). The
command-line demo is the faster path for an AI judge; the live site is the faster path for a human.

---

## The one-liner

VRX lets an operator with unique, non-substitutable inventory (unit **312 ≠ 311**) feed **live availability** to
many **mutually-distrusting** sales teams and agencies, and let them **browse → book → reserve → pay a deposit →
hold — privately**. It's a callable **NEAR smart contract** (the reservation/hold registry) plus an off-chain
**portal** (the apps each participant uses). Real estate is the beachhead and proof; the primitive is
**domain-agnostic** — cars, livestock, equipment, event slots, any Class-A inventory.

## Why it's different — the privacy moat

**No personal data, no prices, and no deal terms ever go on-chain.** Every real-world identifier is stored as an
opaque **SHA-256 hash / HMAC**. The chain proves *that* a reservation exists and *who* holds it; the
*what / how-much / with-whom* stays confidential off-chain. You get a public, tamper-evident ledger of
reservations **without leaking** the commercially-sensitive or personal detail. The contract literally doesn't
"know" it's real estate — which is why the same primitive serves any domain.

## The three tracks this submission speaks to

VRX is one system that lands squarely in three of the hackathon's tracks:

- **Open Innovation** — a genuinely new primitive: a private reservation/hold registry that many distrusting
  parties share. Not a clone of anything.
- **Privacy & Private AI** — the moat. Availability and holds are provable on a public chain; identities, prices,
  terms and commissions never are. The demo proves this at every sealed step.
- **Real-World Money** — a real commercial funnel: deposits, commissions between operators and agencies, a
  developer→VRX protocol fee, and a settlement view that reconciles who owes whom. **Booking tokens** make it
  concrete: VRX issues a developer scarce reservation capacity, which is handed down the trust chain
  (developer → agency → agent) with a tamper-evident receipt at every hop. Trust is enforced by *visibility*, not
  blind trust — a token takes the unit visibly off-market and the developer + agency see who holds it, so a
  professional agent can't misuse it without it tracing back. It replaces the old "take the buyer to an ATM / back
  to the office" cash ritual with hand-to-hand, receipted, in-app transfer. The money *logic* is built and shown;
  the on-rail *take* (moving the money on-chain) is honestly marked planned.

> **The bigger idea (an offer to NEAR).** VRX wants to run the global reservation + marketplace layer for unique
> inventory *on NEAR infrastructure* — as an official marketplace, with real-money settlement, confidential
> compute (TEEs) for the private matching/money half, and agent intents where they fit. That's the vision, not
> today's build. Everything in *this* repo is marked `[built]`, `[in progress]`, or `[planned]` so you never
> have to guess what runs today versus what's proposed.

> **A note on this repository (and why some of it is private).** This is the **product source**, published
> openly and refreshed through the hackathon window. The *detailed design docs, decision history, and internal
> planning are kept private* — deliberately, under legal advice, because VRX is a reservation primitive we
> believe is a global product and the know-how is the asset. We publish the code that runs, the general-
> correctness tests that prove it's real, and an honest status for every capability; we do **not** publish the
> mechanism write-ups or the privacy/deal-logic tests. That posture is a protection, not evasion — the live
> demo and this source let you verify VRX does what it claims without handing over the blueprint.

## How it works — the four pillars, vetting, and the roles

**Four pillars**, wrapped in **vetting**, connecting **eight roles**:

1. **Availability** — what inventory exists and is open (the foundation).
2. **Communications** — availability, clearly communicated to the market.
3. **Payments** — secure transactions: deposits, settlement.
4. **Accounting** — every payment tracked and reconciled.

**Vetting** ties them together so parties who don't trust each other transact on one shared truth.

**The eight roles**, each a working app surface:
**Developer** (owns inventory; grants access, marks availability, confirms bookings — and sells direct) ·
**Direct-seller** (the developer's own desk, not a separate actor) · **Agent** (books for buyers) ·
**Agency** (manages agents) · **Buyer** (a *state* — any wallet can browse + transact) · **Direct-buyer**
(walk-in to a developer's desk) · **CEO / Approver** (high-stakes financial oversight) ·
**Authority Review** (sees the *vetted state* for oversight — **never the private data**).

## What's built (honest status)

| Area | Status |
|---|---|
| On-chain reservation/hold registry (NEAR, opaque-hash) — live on testnet | `[built]` |
| Role-scoped apps for all participant types (browse, book, reserve, hold) | `[built]` |
| Attested off-chain records · commission · settlement projection | `[built]` |
| **Booking tokens** — scarce VRX-issued reservation capacity, handed developer→agency→agent with a tamper-evident receipt at each hop (trust enforced by visibility, capacity reusable); shown as "coins" in the wallet | `[built]` |
| `$VRX` in-system credit ledger (fixed 200M supply, treasury-held; claim / send / spend) | `[built]` |
| S&P contract authoring (payment plans, furniture packages, concessions, termination) | `[built]` |
| Richer agency console (per-agent cards, chat, scheduling/dispatch) | `[in progress]` |
| Vetting / listing gate · change-notice + oversight · §3c enforcement (off-chain) | `[built]` |
| Real-wallet verified sign-in (NEP-413) — seam built, flag off for the demo | `[in progress]` |
| On-rail settlement (moving money on-chain) · secondary market · multi-jurisdiction packs | `[planned]` |
| Confidential compute (TEE) for the private money/matching half · agent intents | `[planned]` |

The same status vocabulary runs through the machine-readable guide at
**https://vrx.poolo.org/for-ai-agent.md** (mirrored in this repo) — hand it to your own AI to assess fit without
walking the UI.

## Run the judge demo (verified)

`npm run demo` drives the **real product code**, not a script that prints a happy story. Here is the actual
trace (abridged — the money JSON continues past this):

```
WORLD SEEDED (real multi-actor system, all off-chain — no wallet needed):
  • direct buyers created : 5
  • agent offers created  : 47
  • commissions resolved  : 47
  • on-chain calls stubbed: 75 (never broadcast)
  • holes surfaced        : 2

SPOTLIGHT — one buyer, the whole privacy funnel, do X → see Y:

  ▸ 1. save profile
      do  : buyer demo-walkin.testnet saves their KYC profile
      see : profile stored OFF-CHAIN, buyer-owned; PII never touches the chain
  ▸ 2. seal profile
      do  : buyer seals (attests + locks) their profile
      see : sealed=true; seal re-verifies=true; on-chain this is only an opaque SHA-256 digest
            (salt held off-chain) — un-brute-forceable
  ▸ 3. desk opens unit
      do  : desk vvv-dev-03.testnet opens unit unit-102 in garden-court to the buyer
      see : grant sealed=true; funnel → units_opened; buyer may now see this unit in detail
  ▸ 4. eligibility bar
      do  : check the offer bar (profile ∧ sealed+KYC ∧ balance ≥ threshold)
      see : eligible=true (profile=true · sealed+kyc=true · balance=true)
  ▸ 5. deposit
      do  : desk records the buyer's deposit (THB 3,000)
      see : deposit sealed=true; seal re-verifies=true; amount is PRIVATE off-chain — never on-chain
  ▸ 6. firm-hold (on-chain, STUBBED)
      do  : desk firm-holds unit unit-102 for the buyer via grant_exclusive
      see : status=held; on-chain = opaque unit_key + house org ONLY (PII/terms/amount never leave off-chain)
```

Two things to notice, both deliberate and stated in the code
([portal/lib/demo.run.ts](portal/lib/demo.run.ts)):

- **It never calls the network.** Eligibility uses a pure combiner with a demo balance, so a judge with no
  funded wallet still sees the real bar logic.
- **The firm-hold tx is a stub, not a broadcast.** The contract is frozen pending one deliberate end-game
  redeploy; stamping now would orphan the state. The stub proves the *logic*; the real on-chain anchor is the
  live V6 contract on testnet (below). This is marked honestly everywhere it appears.

## Try the live demo (no wallet needed)

**https://vrx.poolo.org** — a **sandbox**: it runs the real app on seeded data and resets clean.

1. The cover page explains VRX; enter the passphrase: **`i want to see how i can transact globally`**
   *(or append `?enter=i want to see how i can transact globally` to the URL to skip typing).*
2. Choose **Explore the demo** → **assume any role** (Developer / Agency / Agent / Buyer). No wallet. Switch
   roles freely from the top bar. Or choose **Connect a wallet** for the real path.

> **Honesty note:** in the sandbox, *write* actions are **simulated** (nothing is broadcast). The real contract
> runs for real on NEAR **testnet** — that's the on-chain anchor, not the sandbox clicks. Browse data is a real
> cached read of on-chain state.

## The on-chain anchor (real, verifiable)

The reservation/hold registry is a Rust NEAR contract, live on **testnet** at **`calculating-hand.testnet`**
(V6). It is deliberately frozen; the end-game plan is one batched V7 redeploy + migration, done once, when the
contract stops moving. The demo's stubbed writes map one-to-one onto this contract's real methods
(`grant_exclusive`, deposit/hold) — so the chain is the anchor, and the sandbox is the fast way to walk the flow
without funding a wallet.

## Architecture (proof the code is real)

```
Browser ─▶ Next.js portal (role apps, :3011)
             │  browse = snapshot-authoritative (cached on-chain state; no per-view RPC)
             │  commit = write-through to the NEAR contract (deposits, holds)
             ▼
          NEAR smart contract (Rust, near-sdk) — opaque-hash reservation/hold registry
             • every real-world ref is a SHA-256 hash / HMAC (the privacy moat)
             • V0→V7 borsh-safe state migrations; V6 live on testnet
```

- **Contract:** `contract/` — Rust, `near-sdk`, `#[near]` macros, built to `wasm32-unknown-unknown`.
  Live on NEAR **testnet** (`calculating-hand.testnet`, V6).
- **Portal:** `portal/` — Next.js (App Router), TypeScript. A suite of general-correctness tests ships and
  runs with `npm test` (the privacy & deal-logic tests are kept private — see the note above). Off-chain
  stores are file-backed JSON; browse serves from a seeded snapshot so the chain isn't hammered.
- **Guide for AI judges:** `site/public/for-ai-agent.md` — a machine-readable capability guide you can hand
  to your own AI to assess fit, with an honest `[built]`/`[in progress]`/`[planned]` status for each line.

## Model Maker (MM) — authoring the inventory

Before an operator can *reserve* inventory, someone has to *describe* it. **Model Maker** is VRX's authoring
studio for exactly that — the tool a developer uses to build a building once and hand VRX a clean, structured
pack the whole system can consume.

It has one data model (a "pack") and three faces over it:

- **Structured** — a form/tree editor: developer → building → floors → units, with types, prices, and payment
  terms as first-class fields.
- **Studio** — a drawing board: lay out the real geometry (land parcel → building footprint → floors → units
  → furniture), with polygons, a map, and a stacking plan derived from the actual unit areas.
- **Preview** — the *developer's-eye view of VRX itself*, rendered from the pack. It's the acceptance test:
  if the building looks right here, VRX received the right data. (Verified on a real 476-unit tower.)

A pack exports as a self-describing bundle — structured JSON, a DRT-style `matrix.csv` stacking plan, and
marketing media, with every known media slot always filled (a real upload or a deterministic placeholder) so an
export is never half-complete. What exports can also re-import — the round-trip is a design rule, not an
afterthought.

**Status: `[in progress]`.** The source lives in this repo (`portal/mm`, its own Next app) and its
general-correctness tests ship and run. It is **not** wired into the live hosted demo yet — it's a developer
tool in the VRX toolchain, published here for transparency, not a judge-facing surface. Treat it as the answer
to "where does the inventory in the demo come from, and how would a real operator author their own?"

## Run it locally

```bash
# Portal (the apps + the judge demo)
cd portal
npm ci
npm run demo       # the judge trace above — offline, no wallet
npm run dev        # http://localhost:3011 — the full app
npm test           # general-correctness suites

# Contract (Rust, NEAR) — in WSL/Linux
cd contract
cargo near build non-reproducible-wasm --no-abi   # builds to wasm32-unknown-unknown
```

## License / contact

Contact **vrx@vettedrealty.com**. VRX **facilitates and seals** reservations and agreements; it does **not**
adjudicate disputes or warrant the legal enforceability of any underlying contract — parties' own terms and
local law govern.
