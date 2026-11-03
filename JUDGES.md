# VRX — read this first (for judges & reviewers)

*A plain, current summary of what VRX is, what runs today, and where it's going. Honest status tags throughout:
`[built]` runs now · `[in progress]` partially built · `[planned]` designed, not yet shipped.*

---

## In one paragraph

**VRX is a private, on-chain reservation primitive.** An operator with unique, non-substitutable inventory
(unit **312 ≠ 311** — value scales with the specific item) feeds **live availability** to many
**mutually-distrusting** sales teams and agencies, and lets them **browse → book → reserve → pay a deposit →
hold — privately**. It is a callable **NEAR smart contract** (the reservation/hold registry) plus an off-chain
**portal** (the apps each role uses). **No personal data, no prices, and no deal terms ever go on-chain** — every
real-world identifier is an opaque **SHA-256 hash / HMAC**; the chain proves *that* a reservation exists and *who*
holds it, never *what*. Real estate is the beachhead and proof; the primitive is **domain-agnostic** (cars,
equipment, livestock, event slots — any Class-A inventory).

## Why it's different

- **Privacy is the moat.** The mechanism is designed so amounts, terms, and identities stay off any public chain.
  A competitor can copy a reservation registry; copying a reservation registry that reveals *nothing* is the hard
  part.
- **Non-substitutability.** VRX reserves *the specific item*, not a fungible token — so it is not an NFT and not a
  payment rail; it is a reservation/hold registry for inventory where identity matters.
- **A notary, not a bank.** VRX **witnesses and seals**; the money moves off-chain on a private, hardened ledger
  with party-held encrypted copies. This is a deliberate privacy choice.

## What runs today — the core

- **On-chain reservation/hold registry** on NEAR, opaque-hash, **live on testnet** (contract at V7). `[built]`
- **Role-scoped apps** for every participant (developer desk, agency, agent, buyer) — browse, book, reserve, hold.
  `[built]`
- **Buyer reservation flow end-to-end** through an in-app **AI sales desk**: browse → open a unit → reserve →
  deductible deposit → hold, each action gated by the deal's real state, with PII scrubbed before the model ever
  sees it. `[built]`
- **Booking tokens** — scarce, VRX-issued reservation capacity handed developer → agency → agent with a
  tamper-evident receipt at each hop. `[built]`
- **Model Maker** — a hosted browser studio that authors the inventory itself (land → building → floor → unit
  geometry, stacking plans, payment plans, media), with a **NEAR authorship sign-off** binding an identified party
  to a specific building version. `[built]` / `[in progress]` (pro floor plans, map polygons).

## What runs today — the durability & trust layer (newest work)

- **Bitcoin-anchored evidence (OpenTimestamps).** Each sealed step (an S&P document, a deposit event) gets a
  free, permanent, **hash-only** proof it existed at a point in time — no amount, no PII published. Shown in-app as
  "pending → Bitcoin-anchored." `[built]`
- **Encrypted party-held evidence copies.** For money events, VRX seals an **encrypted copy to the party** —
  openable only by them; the server stores ciphertext it has no key for. If VRX disappeared, the party still holds
  an independently-verifiable record. `[built]` (in-browser opening + wallet-derived keys `[in progress]`)
- **Identity provenance with an honest clock.** A vetting proof states *"VRX-vetted as of T"* (optionally
  Bitcoin-anchored) **paired with a live active/revoked status** — so a trust badge never over-claims. `[built]`
- **A real time model.** Timestamps carry their trust level: asserted time + a tamper-evident Bitcoin upper-bound +
  a NEAR-block cross-check; everyone sees times in their own timezone, each side sees the other's working hours.
  `[built]`
- **Escrow custody on every deposit.** Deposits are held in platform custody with a buyer veto window, released
  when the deal proceeds — a platform guarantee, not an opt-in. `[built in the demo]` (real-money custody gated on
  the compliance track below).

## Revenue model (stated honestly)

The **buyer pays only a deductible reservation deposit — never a VRX markup.** Agency commission and VRX's own fee
are business-to-business. VRX's revenue is a small **0.5% protocol fee, once per unit, charged only at settlement
on a genuine facilitated sale** — derived from a unit's on-chain lifecycle alone, never from any private deal term,
so it is both un-gameable and privacy-preserving. The anti-gaming settlement engine, signed conduct terms, and an
optional good-behaviour bond are **designed and documented**, not yet shipped. `[planned]`

## Where it's going (path to market)

VRX is built to go to market. The remaining work to run real deals with real money is deliberate and sequenced:

- **Real-wallet sign-in** (NEP-413) — seam built; a flag flip for production. `[in progress]`
- **Real-money escrow + on-rail settlement** — the custody FSM and fee model are proven on play-money; moving real
  funds pulls in money-transmission licensing, KYC/AML, and custody hardening, so it is **gated behind a compliance
  track by design.** `[planned]`
- **Legal & jurisdiction** — reservation-agreement templates and per-market licensing are being worked through with
  the boundary held firmly: VRX makes records **provable**, it does not make legal claims on a party's behalf.
- **Independent security review is standing practice** — outside researchers invited, every finding remediated, the
  posture published. (The first external black-box audit's findings are all fixed and deployed.)

The honest shape today: the **primitive and the privacy/durability layer are real and running**; the remaining
go-to-market work is **money-handling compliance and legal packaging**, which we are moving on openly.

## See it in 60 seconds

```bash
cd portal
npm ci
npm run demo        # offline, no wallet — walks one buyer through the whole privacy funnel, do X → see Y
```

Or click through the live sandbox at **https://vrx.poolo.org** (passphrase on the cover page; pick any role, no
wallet needed). A machine-readable capability guide for your own AI is at
**https://vrx.poolo.org/for-ai-agent.md** (mirrored in this repo).

## Provenance & verifying the work

This public repo is a **curated single-commit snapshot** — the full commit history is squashed because it contains
private material (personal contacts, real client and building names, internal notes) that must not go public. **The
timeline is not hidden to obscure the work; it's hidden for privacy.** The work is independently verifiable through
dated, tamper-proof public sources: the **live V7 contract on NEAR testnet** (on-chain deploy/transaction
timestamps), the **running demo at https://vrx.poolo.org**, and the dated *What's new* log in the README. **If you
need to confirm development timeline or authorship, we will provide a full private git-history walkthrough on
request** — the complete, honest commit log lives in our private repository. We'd rather prove it directly than ask
you to take our word for it.

---

VRX **facilitates and seals** reservations and agreements; it does **not** adjudicate disputes or warrant the legal
enforceability of any underlying contract — parties' own terms and local law govern. Contact **vrx@vettedrealty.com**.
