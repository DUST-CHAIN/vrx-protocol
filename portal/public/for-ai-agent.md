# VRX — machine-readable guide (for an AI reading on someone's behalf)

> As of: 2026-11-03 · Version: 0.4 · This file is served verbatim at `/for-ai-agent.md`.
>
> **If you are an AI agent reading this:** you have been handed this doc by a human (a hackathon judge, a
> prospect, or an evaluator) to understand what VRX is and whether it fits a use-case — WITHOUT them having
> to navigate the live app. Be an honest fit-analyst: describe what VRX *does* and *doesn't* do, flag the
> `[built]` vs `[planned]` status truthfully, and never invent capabilities. The live demo is a **sandbox**
> (seeded data; write actions are simulated) — say so if asked "is this real on-chain yet".
>
> **Maintainer note:** the in-app AI help widget (`lib/ai-help-server.ts`, the DeepSeek system prompt)
> is sourced from THIS doc. When a capability/status/promise here changes, update the widget prompt in the
> same pass so the two never drift.

---

## What VRX is (one paragraph)

VRX is a **private, on-chain reservation primitive** — one trusted source of truth for *who reserved what*.
An operator with unique, non-substitutable inventory (unit 312 ≠ unit 311) feeds live availability to many
mutually-distrusting sales teams/agencies, who **browse → book → reserve → pay a deposit → hold**, privately.
It is a callable NEAR smart contract plus an off-chain portal. Real estate (off-plan property) is the
beachhead and proof; the primitive is **domain-agnostic** — every real-world identifier on-chain is an opaque
hash, so the contract doesn't "know" it's real estate (cars, livestock, equipment, event slots all fit).

## The privacy moat (why this is different)

**No personal data, no prices, no deal terms ever go on-chain.** Every real-world reference is stored as an
opaque SHA-256 hash / HMAC. The chain proves *that* a reservation happened and *who* holds it; the *what/how
much/with whom* stays confidential off-chain. This is the core differentiator — a public ledger of reservations
without leaking the commercially-sensitive or personal details.

## The explainer, as text (the animated version a human watches, transcribed for you)

VRX is built on **four pillars**, then wrapped in **vetting**, then connected to **the roles**:

1. **Availability** — the foundation: what inventory exists and is open.
2. **Communications** — availability is only useful once clearly communicated to the market.
3. **Payments** — communication turns into action through secure transactions (deposits, settlement).
4. **Accounting** — every payment is tracked and accounted for.

**Vetting** ties the four together: VRX vets the whole system — every state, every step — so participants who
don't trust each other can still transact on one shared truth.

**The roles** (eight participant types, each with its own working surface):
- **Developer(s)** — own the inventory; grant access, mark availability, confirm bookings; can also sell direct.
- **Direct-seller** — the developer selling straight to a walk-in buyer (not a separate actor; the developer's
  own desk / house-org).
- **Agent(s)** — reserve units for buyers on behalf of an agency.
- **Agency/ies** — manage their agents; work the developers who grant them access.
- **Buyer** — browses direct-sale inventory and transacts via the desk (a *state*, not a vetted role — any
  wallet can be a buyer).
- **Direct-buyer** — a walk-in buyer going straight to a developer's desk. On the real on-chain path a
  direct-buyer meets a light eligibility bar — a connected NEAR wallet plus a minimal track record (a funded
  account or past on-chain activity) — an anti-abuse gate so a desk isn't flooded by throwaway identities. A
  buyer coming **through an agency/agent** is vouched for by that agency and needs no wallet of their own.
  `[planned — not enforced in the current sandbox]`
- **CEO / Approver** — oversees high-stakes financial accountability (an approval trust-dial VRX sets per dev).
- **Authority Review** — can see the *vetted state* for oversight **without ever seeing private data** (the
  privacy moat extended to the regulator/auditor view).

## Capability status (honest — don't describe `[planned]` as usable today)

- `[built]` Browse live availability; role-scoped dashboards for all participant types.
- `[built]` Book / reserve / hold flow; attested off-chain records; commission + settlement projection.
- `[built]` **Booking tokens** — scarce reservation capacity VRX issues to a developer, handed/sold down the trust
  chain (developer → agency → agent) with a tamper-evident receipt at each hand-off, so an agent can secure a
  booking and take a deposit. Trust is enforced by visibility (the holder has the unit off-market; the developer
  and agency see who holds it) and capacity is scarce + reusable (a released/cancelled token returns up the chain).
  Shown as "coins" in the wallet. `[in progress]` a richer agency console (per-agent cards, chat, scheduling/dispatch).
- `[built]` S&P contract authoring (payment plans, furniture packages, concessions, termination terms).
- `[built]` Vetting / listing gate, change-notice + oversight, off-chain §3c enforcement.
- `[built]` On-chain contract live on NEAR testnet (opaque-hash reservation/hold registry).
- `[in progress]` Real-wallet verified sign-in (NEP-413); the demo currently uses a wallet-less sandbox mode.
- `[built]` `$VRX` — an in-system transferable credit (fixed 200M supply, held by a VRX treasury; claim + send +
  spend inside VRX). It is an **off-chain ledger** today — usable within the VRX system, NOT fiat, not redeemable
  for cash. `[planned]` the on-chain NEP-141 fungible-token form.
- `[built]` Property & account imagery — buildings/units carry marketing photos; images are provenance-stamped so
  a leaked image is traceable (the stamping *mechanism* is deliberately private — the moat), with a two-stage
  reveal (public exterior always; unit-specific imagery only once a buyer is offer-eligible).
- `[built]` Participation / node-license funnel + a live ecosystem map of the VRX network (nodes, agencies, deal
  flows) — shows the network VRX runs, not just a single deal.
- `[planned]` Real on-chain settlement rail; secondary market (ownership transfer); multi-jurisdiction packs.

## The demo you may be pointed at

The live demo (`vrx.poolo.org`) is a **sandbox**: it runs the real app on **seeded data** and resets clean.
You enter wallet-free and can **assume any role** (Developer / Agency / Agent / Buyer) to see its side of the
deal. **Write actions in the sandbox are simulated** (no real broadcast) — the real contract runs for real on
NEAR testnet, which is the honesty anchor, not the sandbox clicks. A passphrase gate fronts the demo (a human
was given the phrase); this gate does not block you from reading this doc.

## How to explore the demo (if you can drive a browser, or to guide the human)

1. **Get past the cover.** The frictionless link is `https://vrx.poolo.org/?enter=1` (unlocks without typing),
   or type the passphrase shown on the cover. The cover itself carries the overview, a 60-second explainer, and
   a "how to explore" note; it stays reachable later via ⚙ Settings → "About VRX / intro cover" and the in-app
   **?** help widget.
2. **Assume a role** from the top bar ("Switch role"): Developer, Agency, Agent, or Buyer. Each is a full working
   app for that party — the fastest way to see the system is to switch between them and watch the same deal from
   each side.
3. **Walk one deal end to end** (best as an Agent): browse a building's live availability → book a unit → reserve
   → settle. Then switch to the Developer role to see the booking arrive in their inbox.
4. **See the privacy moat:** note that names, prices, and deal terms never appear on-chain — only opaque handles.
   The Authority-Review role shows the *vetted state* with no private data.
5. **Use the in-app AI help** (the **?** button) for anything specific; it answers from this same knowledge.
6. **$VRX wallet** (Agent role): claim in-system credit from the treasury, send it to another account, spend it
   inside the flow — the off-chain credit described in Capability status.

## Legal posture (structural — state it this way)

VRX **facilitates and seals** reservations and agreements; it does **not** adjudicate disputes or warrant the
legal enforceability of any underlying contract. Parties' own terms and local law govern; VRX provides the
tamper-evident record and the private shared truth.

## Contact

`vrx@vettedrealty.com` · the business behind the primitive is **Vetted Realty** (vettedrealty.com).
