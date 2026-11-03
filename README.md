# VRX — a private, on-chain reservation primitive

> **Active development (as of November 2026).** This is the product source, curated for the NEAR hackathon. The capability status tags (`[built]` / `[in progress]` / `[planned]`) are honest about what runs today; the live demo below is the fastest way to see it working.

> **One trusted source of truth for *who reserved what* — without putting prices, terms, or personal data on-chain.**
>
> *The why:* an open, private, secure marketplace where anyone, anywhere can transact — across borders, without asking permission. Real estate is where we start; the goal was never just property.
>
> Live demo: **https://vrx.poolo.org** · The business behind it: **[Vetted Realty](https://vettedrealty.com)**

---

## What's new

*The full build story, newest first — every meaningful day from the September kickoff through today, with the
official hackathon window (1 November onward) marked below. For a commit-count breakdown see
[CHANGELOG.md](CHANGELOG.md).*

- **2026-11-19** — **Durability, time, and identity: the "notary that outlives the notary" layer.** A run of work
  that hardens VRX's core promise — *prove what happened, when, without exposing it* — into something that survives
  even VRX itself:
  - **Bitcoin-anchored evidence.** Each sealed step (an S&P document, a deposit event) is anchored to the Bitcoin
    blockchain via OpenTimestamps — a free, permanent, independently-verifiable proof that the record existed at a
    point in time, revealing **no amount and no private detail** (only a hash is published). A record struck today
    stays provable years from now, with nothing to trust but mathematics. `[built: real anchoring; shown as
    "pending → Bitcoin-anchored" in-app]`
  - **Hold your own encrypted copy.** For your money events, VRX seals an **encrypted copy to you** — one only you
    can open, which the platform itself cannot read (it stores ciphertext it has no key for). If VRX ever
    disappeared, you would still hold an independently-verifiable record. `[built: sealing + your-own-key delivery;
    in-browser opening and wallet-derived keys in progress]`
  - **An honest "vetted as of when."** A party's vetting proof now states the *date* it was issued and is paired
    with a **live status** — if a vetting is ever revoked, that shows too. A trust badge can never over-claim: it
    tells you both what was true when they were vetted and whether it still holds now. `[built]`
  - **A real time model.** Timestamps are explicit about their trust level — the asserted time, plus a
    tamper-evident upper bound from the Bitcoin anchor, cross-checked against the NEAR chain's own block clock.
    Everyone sees times in **their own timezone**, and each side can see the other's local time and working hours.
    `[built]`
  - **Escrow custody on every deposit.** A buyer's deposit is held in platform custody — released to the seller
    only when the deal proceeds, with a buyer veto window — not sent straight to the seller's wallet. A
    platform-level guarantee on every reservation, not an opt-in. `[built in the demo; real-money custody gated on
    the licensing/compliance track below]`
  - *Design note, stated plainly:* amounts and deal terms **never** touch a public chain. VRX is a **notary, not a
    bank** — it witnesses and seals; the money itself moves off-chain on a private, hardened, party-held-copy
    ledger. This is a deliberate privacy choice, not a limitation.
- **2026-11-16** — **The buyer reservation flow works end to end, and the revenue model is stated honestly.**
  A buyer can now **browse → open a unit → reserve → place a deductible deposit → hold** entirely through an
  in-app AI sales desk — proven live in the demo. The money model is now clean and separated: the **buyer pays
  only a deductible reservation deposit — never a VRX markup**; the agency commission and VRX's own fee are
  business-to-business. VRX's revenue is a small **0.5% protocol fee, once per unit, charged only at settlement
  on a genuine facilitated sale** — determined from a unit's on-chain lifecycle alone, never from any private
  deal term, so it stays both un-gameable and privacy-preserving. The automated anti-gaming settlement engine
  (plus signed conduct terms and an optional good-behaviour bond that back the network's honesty rules) is
  **designed**, not yet shipped — the whitepapers now carry the policy in full. `[built]` flow · `[planned]`
  settlement engine.
- **2026-11-14** — **V7 is live on-chain, and there's a new technical paper to match.** The batched V7 upgrade
  (booking-token on-chain rail, owner emergency-stop, attestation seal) shipped to `calculating-hand.testnet` in
  one gated migrate-and-redeploy — the contract is now at **V7**. Alongside it, a new **[Reservation as
  Infrastructure](https://vettedrealty.com/vrx/whitepapers/vrx-reservation-as-infrastructure.html)** technical
  paper: the verified method surface, the privacy model, the boundary against NFTs and payment rails, and the
  role of NEAR Intents — grounded in the live contract. `[built]`.
- **2026-11-13** — **Model Maker is live, and its models can be signed off.** The authoring studio is now
  running as a hosted app at **[vettedrealty.com/vrx/mm](https://vettedrealty.com/vrx/mm)** — you can open it
  and build a development in the browser. New alongside it: a **NEAR authorship sign-off** — an identified party
  can sign off on a specific building model, binding their identity to that exact version; any later edit visibly
  invalidates the sign-off, so it can never silently cover a different design than the one approved. It's a
  provable answer to *"who stands behind this plan, and is it the one they approved?"* — without exposing anything
  private. `[built]`. See the [Model Maker](#model-maker-mm--authoring-the-inventory) section.
- **2026-11-10** — **Model Maker — big authoring upgrade.** The in-browser studio that turns a development into
  the package VRX imports got a major pass: one simplified workspace with three faces (the facts · the plan ·
  the buyer preview), a richer unit palette (shops → penthouses, plus sky *duplexes* that span two floors as one
  unit and shared "public space" cores), stable position-fixed unit numbering so a building can keep growing after
  import, a live completeness report, a structured payment-plan editor, and optional AI assists (a text brief →
  a whole building, and image generation) that run with **your own** API keys kept on your device. A one-click
  "Aurora Tower" sample (34 storeys, ~230 units) shows it off. `[in progress]` — more coming (professional
  floor plans, map/plan polygons). See the [Model Maker](#model-maker-mm--authoring-the-inventory) section.
- **2026-11-08** — **Independent security audit — all findings fixed & deployed.** We invited outside security
  researchers to assess VRX and committed to publishing every professional audit we receive. The first one (a
  black-box review by an independent researcher) reported findings across the web app and the on-chain contract;
  every one has now been remediated, the web-app fixes are live on the demo, and the contract fixes are now
  deployed live in the V7 migration. We treat independent scrutiny as a feature of a privacy-first
  system, and we've invited a follow-up pass. `[built]`.
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

### ═══ Official hackathon build window began 1 November 2026 ═══

*Everything above this line is hackathon-window work. Everything below is the foundation the window built on — pre-work
the hackathon rules explicitly allow (prior work is permitted and the commit timeline is not judged). Shown in full
for honesty and completeness; see [CHANGELOG.md](CHANGELOG.md) for the commit-count breakdown.*

- **2026-10-31** — **A private negotiation channel between a buyer and the seller's desk — with consent, graceful exits, and an escalation path to VRX.** The direct buyer↔desk relationship got a full negotiation arc: the buyer's identity stays **masked to the desk until the buyer explicitly consents to a reveal** (a two-step ceremony — the desk asks, the buyer agrees), either side can **politely call off** a deal, the desk can **hard-block** an abusive thread (with an anti-cheat guard so it can't quietly hide a live deal), and unresolved disputes can **escalate to VRX** as a neutral party. A standing, submittable **security/privacy posture document** was added as the single place an auditor reads to see how data is protected, and a **PII leak where the buyer was visible to the desk too early was closed**. `[built]` negotiation arc · `[built]` privacy audit doc.
- **2026-10-30** — **The whole product now runs on a local blockchain with one command, and a polished public demo goes live.** A **one-command local network bring-up** plus a **walletless local signer** means the entire buy-flow can be driven end to end on a real (local) NEAR chain with no wallet friction — and a **multi-actor simulation** generates realistic VRX history (developers, agencies, agents, buyers all acting) so the demo world looks lived-in. On top of that foundation the public demo site went live with a **role-picker and landing page** (browse as developer, agency, agent or buyer), a **password-gated pitch cover**, and a hardened deploy playbook. Several privacy and production-build fixes landed in the same stretch — developers only see **their own** buildings, the production build was unblocked, and demo transactions now read **honestly as sandbox, not "confirmed on-chain."** `[built]`, live in the demo.
- **2026-10-27** — **Nothing can be sold until it's actually been released — the vetting and release lifecycle is now enforced, not assumed.** A unit is **bookable only once it's been formally released**, and a fail-closed gate blocks any attempt to go to contract on inventory that hasn't passed that bar. Developers get a **per-developer edit-policy matrix and trust dial** (how much they're allowed to change on their own), a **versioned inventory store with a freeze gate**, and **change-notices that automatically reach subscribed agencies** when terms move. Pending approvals **quarantine a booking** until signed off, with a request-approval-then-auto-apply path and root-level oversight. The catalog also got its full image pass (all nine buildings), honest availability counts, and representative hero images on building cards. `[built]`.
- **2026-10-26** — **The demo world was given realistic texture so it reads like a real market, not a test fixture.** The seeded inventory now clusters each development's launch era by developer, carries **per-building project status**, withholds roughly a third of units as off-market (as a real developer would), and reclaims stale junk rows on a clean reseed — so a judge browsing the catalog sees a believable, differentiated market with distinct amenities and descriptions rather than uniform filler. `[built]` demo data.
- **2026-10-22** — **A complete, honest payment ledger — who owes what, who's been paid, and where the numbers disagree.** The payment-ledger arc closed out: a **variance engine** that reconciles expected vs received money, earmarks that graduate from *earned* to *payable*, a **buyer/agent confirm-and-dispute surface** so both sides attest to payments, and a **developer projected-income view** (Expected / Received / Behind, per building). A full **cancellation-and-termination state machine** also landed — serve notice, run a cure clock, terminate, and tie the outcome to a retain-or-refund settlement. Configuration numbers (the knobs behind all this) were made editable and wired through, and buyer payment reminders were added. `[built]`.
- **2026-10-21** — **VRX can now hold a misrepresenting operator accountable — end to end — and the money side graduates on a real clock.** The developer-standing system became fully enforceable: a **misrepresentation store and a root-level console** to act on it, a **gate** that hides a bad-standing developer from buyer discovery and refuses new deals, an automatic **SYSTEM/vrx channel** that notifies parties, and a VRX↔developer agreement surface the developer actually **signs**. A **14-working-day protocol clock** now governs when VRX's own fee moves from earned to payable, and a God's-eye payments-and-disputes console plus an "everlasting chat" notify-on-login badge rounded out the stretch. Chat security got a hardening pass — an authorization audit came back green with tamper-evident durability. `[built]`.
- **2026-10-20** — **The settlement engine comes alive, and the project aims squarely at a judge with a one-command demo.** A **judge-facing `npm run demo`** spins up the entire privacy funnel with a single command. Behind it, the **earmark/accrual resolver and settlement rollup** compute who-gets-paid-what at settlement, surfaced through a **settlement dashboard with an audit breakdown and balance check**. The buyer profile gained a **seal-lock with an append-only edit trail and per-developer readiness**, and a proprietary license/notice was put in place. This is the day the money model stopped being design and started computing real numbers. `[built]` settlement engine · `[built]` demo command.
- **2026-10-13** — **The buyer's sealed profile is protected from both tampering and leaks.** The buyer-profile seal added its UI — relocate-and-complete nudges, a seal gate, and a red-card deep-link to whatever's missing — and a security review caught and fixed a real issue: **the seal secret (salt and seal-hash) must never reach the buyer's browser.** `[built]`.
- **2026-10-12** — **A direct developer-to-buyer sales channel, driven honestly through the funnel.** The direct-sales path got its workspace: a buyer can be advanced through the funnel, granted specific units, pass an **offer-eligibility bar**, and place a deposit that triggers an **on-chain firm-hold** — with the important guardrail that a firm-hold **does not publish the unit to the market** (it blocks and shows availability instead). A full-funnel seed harness with a holes-list drove out the gaps, and commission outcomes are now **explained rather than left as silent blanks**. `[built]`.
- **2026-10-11** — **Every property gets a real place on the map and a provable paper trail.** A reusable **site-plan map** arrived — land and footprint polygons, orientation and facing cones, editable by the developer and read-only for agent and buyer — alongside **per-unit map pins**, a satellite/street toggle, and a **documents panel** surfacing the title deed and sealed location as "this is final" provenance. The commission model was refined (earmark-then-take, with a VRX-facilitation clause on the agency agreement), a **building-setup editor** was built, and a **status-transition ledger** gave every deal a timestamped spine. A direct-buyer record spine with a fail-closed, buyer-owned encrypted vault also landed. `[built]`.
- **2026-10-10** — **The deal gets real commercial depth: contracts, maps, a document vault, and the money split.** A rich session: the **sale-and-purchase contract gained a state machine** (stage-aware generation that only reveals a buyer's full name at the final stage), an **encrypted buyer-KYC document vault** with an offline operator-key escrow model, a **maps-and-location arc** (OpenStreetMap/Leaflet with building geo and access roads), construction-timeline and reusable furniture-pack authoring, **per-sale commission and a negotiable transfer-tax split**, and installments tied to construction milestones. This is where VRX stopped being just a hold registry and started modeling the actual commercial transaction. `[built]`.
- **2026-10-07** — **The sale itself is now first-class: an on-chain receipt and a contract viewer, with isolation proven by test.** The sale arc shipped — an **on-chain receipt plus a sale-and-purchase contract viewer** — and the booking participant-scoping logic was consolidated into one chokepoint and **guarded by a cross-booking isolation test** so one deal's participants can never see another's. A local control panel (one shell to start/stop/status the servers) made the dev loop faster. `[built]`.
- **2026-10-06** — **A public overview website, and the wallet write-path routed through a keyed proxy.** The public marketing site for the project went live, and the wallet's on-chain write path was routed through a **keyed RPC proxy** to keep it reliable under load. A double-submit guard on the Confirm button closed a real race. `[built]`.
- **2026-10-05** — **Buyer protection becomes a real arc, and developers get a war-room to watch their market.** The **buyer-protection arc** was built (including agent-side reveal notifications and a live booking countdown clock), a **developer event log** gave each developer an activity spine with a projection engine, and a **developer war-room** landed — a KPI strip, an availability wall with a play-scrubber and mini-grid, and a what's-new feed. Store writes were serialized to prevent lost writes under concurrency, and the agent gained a "My bookings" post-booking surface with all booking chats as openable threads. `[built]`.
- **2026-10-04** — **A God's-eye relationship dashboard, plus the RPC cost problem solved properly.** The VRX-root view got a **radial relationship graph** (master-detail plus a spring layout, with zoom and pan) and a shared dashboard shell propagated across every role's app. The RPC-cost subsystem was rethought: run the **free keyless tier by default** to surface rate-limit pain honestly in development, then **auto-escalate** to an owner-managed reserve-key registry only when needed. A contract generator and an exclusive-hold write-through mirror (which stopped a 1,558-unit chain scan) also shipped. `[built]`.
- **2026-10-03** — **Agreements v2: private, salted, building-scoped B2B contracts between developers and agencies.** The agreements engine got its v2 core — **salted hashing, KYC profiles, and building-scoped agreements** — with a publish/join UI, an offer flow with a guard, and demo seed data. An invariant review hardened it server-side and added trust-marks. `[built]`.
- **2026-10-02** — **One unifying spine for everything off-chain: attested records, a real-time inbox, and the agency app.** A key architectural move — a master **"attested off-chain records" spine** that every off-chain record (messages, channels, agreements) now rides. On top of it: a **developer inbox** that became a master-detail dashboard, a **NEP-297 event indexer** (hybrid seed plus a forward block-tailer), **SSE push** that gave the inbox real-time updates and killed the 60-second polling, and the **agency app** built on the same shared spine with its own agreements and personas. `[built]`.
- **2026-10-01** — **The portal goes public, and becomes genuinely usable on a phone.** The portal was packaged (Dockerfile) and **deployed to a public URL**, made fully self-contained with all building and unit imagery, and gated behind a **per-IP rate limiter** on its API. A heavy mobile-polish pass landed — a horizontally-scrolling grid, payment-plan sliders, an adaptive gallery with a clean carousel and lightbox, and booking only via the unit-detail view. A living architecture-diagram prompt was added and kept in sync with the system. `[built]`, live.
- **2026-09-30** — **The developer gets real inventory controls, and the chain-read storm is finally tamed.** Developers can now take units **off-market or kill them outright** (and killed units vanish from buyer views), with bulk multi-select, a packing advisor, and off-chain request time-to-live. A **freehold-quota arc** modeled buyer-driven ownership with a two-sided quota and grid filter. On the infrastructure side, a **dedicated keyed RPC path on all server reads** plus proxying every browser read through the keyed server finally killed the throttle storms and CORS floods that had been starving the UI. `[built]`.
- **2026-09-29** — **A real developer's entire inventory — 1,558 units across nine buildings — rendered as a live, resilient visual grid.** The portal took on a real developer's full catalog (all nine buildings, 1,558 units, priced in USD and the user's own currency) and presented it as a **proportional visual unit grid** with lazy/progressive status loading, a persistent snapshot that survives RPC congestion, per-floor tap-to-load, and rich building cards with totals and per-floor breakdowns. A **VRX gas faucet** auto-funds a vetted actor's first on-chain write so newcomers aren't blocked, and a graceful read-vs-book race handler keeps the UI honest under load. This was the day the demo started looking like a real product with real data. `[built]`.
- **2026-09-28** — **Exclusive holds go live, and each login sees only its own app.** The **Exclusive Hold** feature shipped on-chain and was proven live across three roles — a developer can grant a temporary, per-unit exclusive to a single agency, which the agent then sees in a held-view, and release it. Role-aware routing means **each login sees only the app meant for it** (developer, agency, agent), backed by an off-chain demo catalog, read-only image serving, and a server-side building-status cache. `[built]`.
- **2026-09-27** — **The protocol gets its money layer and its first live testnet deploys — then the revenue model is thought through honestly.** A dense day: the deploy blocker was fixed (near-sdk bumped, built on stable) and the contract made its **first live testnet deploys**, including a **commissions Agreement record** and a **protocol usage fee** where every state-writing method is payable and carries a toll. Crucially, the thinking was kept honest — the on-chain fee is framed as a **spam/storage guard, not revenue**; real revenue is the small token commission at settlement, and the treasury must be a neutral account. **Owner-gated onboarding** was added, and the portal skeleton with a live owner-gated write path and the first reservation-flow UI (developer, agent, agency screens plus a shared-indexer network view) was scaffolded. `[built]` contract money layer · `[built]` portal skeleton.
- **2026-09-26** — **The ported contract is frozen behind tests, made readable, and taught to expire holds.** Before changing anything, a **characterization test suite was brought green in a sandbox** to freeze the existing behavior — then the contract got a readability pass (named error constants, legible field names), had **migrate() locked to the owner with NEP-297 events** added, gained **on-chain hold expiry** (a hold-until sidecar with a release()), and was renamed to a clean, generic, domain-agnostic API. A real migration roundtrip was proven by test. This is the disciplined "port-and-harden, don't rewrite" foundation the whole project stands on. `[built]`.
- **2026-09-25** — **Day one: the mature Rust booking contract is pulled in as the seed, with a prior-art study to justify porting over rewriting.** The project began by **porting in an already-mature on-chain booking/hold registry** rather than starting from scratch, paired with a prior-art design study confirming that decision. The reservation-flow test harness and toolchain/sandbox constraints were set up the same day. `[built]` foundation.

---

## Provenance & verifying the work

This public repo is a **curated single-commit snapshot** — the full commit history is squashed because it contains
private material (personal contacts, real client and building names, internal notes) that must not go public. The
timeline is **not hidden to obscure the work; it's hidden for privacy.** The work itself is independently verifiable
through dated, tamper-proof public sources:

- the **live V7 contract on NEAR testnet** — on-chain deploy and transaction timestamps anyone can read;
- the **running demo at https://vrx.poolo.org**;
- the dated **What's new** log above;
- and, fittingly, the **Bitcoin anchors** the product itself produces (proof-of-existence at a point in time).

A **day-by-day build log** — drawn from the full commit history, scrubbed of private material — is published here as
**[CHANGELOG.md](CHANGELOG.md)**: ~8 weeks, 1,307 commits across 42 active days, with the official hackathon window
marked. It shows the real shape and pace of the work that the squashed snapshot alone can't.

**If a reviewer needs to confirm development timeline or authorship beyond that, we will provide a full private
git-history walkthrough on request** — the complete, honest commit log lives in our private repository. We'd rather
prove it directly than ask anyone to take our word for it. Contact **vrx@vettedrealty.com**.

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
- **Real-World Money** — a real commercial funnel with three cleanly separated layers: the buyer's **deductible
  reservation deposit** (the only money a buyer ever sees — never a VRX markup), the **agency commission** between
  operators and agencies, and the **developer→VRX protocol fee** (0.5%, once per unit, only at settlement on a
  genuine sale) — plus a settlement view that reconciles who owes whom. **Booking tokens** make it
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
| Buyer reservation flow end-to-end (AI sales desk: browse → open → reserve → deductible deposit → hold) | `[built]` |
| **Booking tokens** — scarce VRX-issued reservation capacity, handed developer→agency→agent with a tamper-evident receipt at each hop (trust enforced by visibility, capacity reusable); shown as "coins" in the wallet | `[built]` |
| `$VRX` in-system credit ledger (fixed 200M supply, treasury-held; claim / send / spend) | `[built]` |
| S&P contract authoring (payment plans, furniture packages, concessions, termination) | `[built]` |
| **Bitcoin-anchored evidence** (OpenTimestamps) — each sealed step gets a free, permanent, hash-only proof-of-existence; shown "pending → anchored" in-app | `[built]` |
| **Encrypted party-held evidence copies** — a buyer holds their own copy of each money event, openable only by them; the server stores ciphertext it can't read | `[built]` (in-browser opening + wallet-derived keys `[in progress]`) |
| **Identity provenance** — "VRX-vetted as of T" (optionally Bitcoin-anchored) paired with a live active/revoked status | `[built]` |
| **Time-trust model** — asserted time + tamper-evident Bitcoin upper-bound + NEAR-block cross-check; viewer-local timezones + counterparty working-hours | `[built]` |
| **Escrow custody FSM** — deposits held in platform custody with a buyer veto window, released on the deal proceeding (not straight to the seller) | `[built in demo; real-money gated on compliance track]` |
| Richer agency console (per-agent cards, chat, scheduling/dispatch) | `[in progress]` |
| Vetting / listing gate · change-notice + oversight · §3c enforcement (off-chain) | `[built]` |
| Real-wallet verified sign-in (NEP-413) — seam built, flag off for the demo | `[in progress]` |
| Anti-gaming fee-settlement engine (0.5% at settlement, un-gameable by status-shuffling) · signed conduct terms · optional good-behaviour bond — designed | `[planned]` |
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
- **The firm-hold tx is a stub, not a broadcast.** The demo runs fully offline so a judge needs no funded
  wallet; the stub proves the *logic*, and the real on-chain anchor is the live V7 contract on testnet
  (below). This is marked honestly everywhere it appears.

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
(**V7** — the batched V7 upgrade + migration shipped in one gated redeploy, done once the contract stopped
moving). The demo's stubbed writes map one-to-one onto this contract's real methods (`grant_exclusive`,
deposit/hold) — so the chain is the anchor, and the sandbox is the fast way to walk the flow without funding a
wallet.

**Go deeper:** the **[Reservation as Infrastructure](https://vettedrealty.com/vrx/whitepapers/vrx-reservation-as-infrastructure.html)**
technical paper walks the full design — the verified contract method surface, the privacy model, the boundary
against NFT ownership and payment rails, and the role of NEAR Intents and Confidential Intents — grounded in
this live V7 contract. (One of [four whitepaper editions](https://vettedrealty.com/vrx/whitepapers/): judges,
investors, the protocol spec, and this deep-dive.)

## Architecture (proof the code is real)

```
Browser ─▶ Next.js portal (role apps, :3011)
             │  browse = snapshot-authoritative (cached on-chain state; no per-view RPC)
             │  commit = write-through to the NEAR contract (deposits, holds)
             ▼
          NEAR smart contract (Rust, near-sdk) — opaque-hash reservation/hold registry
             • every real-world ref is a SHA-256 hash / HMAC (the privacy moat)
             • V0→V7 borsh-safe state migrations; V7 live on testnet
```

- **Contract:** `contract/` — Rust, `near-sdk`, `#[near]` macros, built to `wasm32-unknown-unknown`.
  Live on NEAR **testnet** (`calculating-hand.testnet`, V7).
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

A pack exports as a self-describing bundle — structured JSON, a `matrix.csv` stacking plan, and
marketing media, with every known media slot always filled (a real upload or a deterministic placeholder) so an
export is never half-complete. What exports can also re-import — the round-trip is a design rule, not an
afterthought.

**A model can be signed off.** An identified party can put a **NEAR authorship sign-off** on a specific building
model — binding their identity to that exact version. The sign-off is tied to the content, so any later edit to
the model visibly invalidates it; it can never silently cover a different design than the one that was approved.
This gives a provable answer to *"who stands behind this plan, and is it the one they approved?"* without exposing
anything private. `[built]`.

**Status: `[in progress]`.** The source lives in this repo (`portal/mm`, its own Next app) and its
general-correctness tests ship and run. It also runs as a hosted app you can open at
**[vettedrealty.com/vrx/mm](https://vettedrealty.com/vrx/mm)**. It's the authoring tool in the VRX toolchain —
the answer to "where does the inventory in the demo come from, and how would a real operator author their own?"
More is coming (professional floor plans, map/plan polygons).

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

## Where this is going (path to market)

VRX is built to go to market, not to end at a demo. The reservation primitive, the privacy model, and the
durability layer above are live or in active build; the remaining work to run real deals with real money is
deliberate and sequenced:

- **Real-wallet sign-in** (NEP-413) — the seam is built; turning it on is a flag flip for production.
- **Real-money escrow + on-rail settlement.** The custody state machine and the fee model are built and proven on
  play-money today. Moving **real** funds pulls in money-transmission licensing, KYC/AML, and custody hardening —
  so it is gated behind a compliance track by design, not rushed. The privacy posture (amounts off-chain, notary
  not bank) is what keeps that track tractable.
- **Legal & jurisdiction.** VRX **facilitates and seals**; it does not adjudicate disputes or warrant the legal
  enforceability of any underlying contract — parties' own terms and local law govern. Reservation-agreement
  templates, per-jurisdiction packs, and the licensing posture for each market we enter are being worked through
  with that boundary held firmly: the platform makes records **provable**, it does not make legal claims on a
  party's behalf.
- **Independent security review is a standing practice** — we invite outside researchers, remediate every finding,
  and publish the posture. A privacy-first system earns trust by being scrutinised, not by being opaque.

The honest shape today: the **primitive and the privacy/durability layer are real and running**; the **go-to-market
work is money-handling compliance and legal packaging**, which we are moving on deliberately and openly.

## License / contact

Contact **vrx@vettedrealty.com**. VRX **facilitates and seals** reservations and agreements; it does **not**
adjudicate disputes or warrant the legal enforceability of any underlying contract — parties' own terms and
local law govern.
