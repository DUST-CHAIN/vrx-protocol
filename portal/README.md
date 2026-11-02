# VRX Portal

Operator / agency portal for the VRX reservation primitive. **Next.js (App Router) + near-api-js 5.x**,
talking to the **live testnet contract** (`calculating-hand.testnet`, owner-gated build).

## Why testnet, not localnet
For a frontend, testnet removes more friction than a local node adds: stable public RPC, real wallet login
(when we add wallet-selector), nothing to babysit. The local-first bar was for contract-hardening; the
UI phase flips the calculus.

## Run (on Windows — node 22 is native here; the CONTRACT toolchain stays in WSL, the PORTAL does not)
```
cd portal
npm install
npm run dev        # http://localhost:3011
```
The landing page reads `get_owner` / `get_toll` / `get_treasury` / `get_hold_window` off the live contract —
if those render, the whole config→provider→testnet wire works.

## Judge demo (one command, zero wallet setup)
```
cd portal
npm install
npm run demo              # seeds the world + walks one buyer through the whole privacy funnel, prints a trace + JSON
npm run demo -- --json    # JSON only (for an AI judge to parse); or: npx tsx lib/demo.run.ts --json
```
`npm run demo` seeds the real multi-actor system (via `lib/seed-funnel`: 9 buildings, 3 developers, agencies,
agents, offers at every stage, commissions) and then **spotlights one buyer end-to-end** through the private
reservation funnel — _do X → see Y_ at each step: **save profile → seal (attest + lock) → desk opens a unit →
eligibility bar → deposit → firm-hold**. It proves the privacy moat at every sealed record (re-verifying the
salted seal) and shows that **only an opaque `unit_key` + a house org ever reach the chain** — PII, deal terms,
and amounts stay off-chain and sealed. Zero setup: no funded wallet (eligibility uses the pure combiner with a
demo balance, no RPC) and nothing is broadcast (the on-chain firm-hold is stubbed — the contract is
frozen). Idempotent: re-runs only touch the demo's own rows. Entry point: `lib/demo.run.ts`.

## Layout
- `lib/config.ts` — network / contract id / RPC (all env-overridable; contract id is neutral).
- `lib/vrx.ts` — the near-api-js client + the **full documented method surface** (views + writes + who signs).
  This is the reusable wiring every feature screen builds on. Reads only for now; writes need an Account
  signer (owner keypair for dev, wallet-selector for real users — the method names don't change between them).
- `app/` — App Router. `page.tsx` is the skeleton landing page.

## Privacy (non-negotiable)
Everything the portal sends on-chain is an **opaque hash/HMAC computed off-chain** (instance_hash, org_ref,
request_hash, integrity_hash, scope, unit_key…). NEVER put PII, prices, terms, or milestones on-chain in the
clear. This is the concrete improvement over the pilot (whose `createUnit` wrote type/size/status plaintext).

## Next
- Wire the signer (owner keypair → later wallet-selector) and build the **owner-gated onboarding** screen
  (`register_node` / `register_org`, owner-signed) — the first write flow.
- Then tiles (`stamp_tile`) + claims (`open_claim`/`reply_claim`/`confirm_claim`), and the buyer paths.
