# VRX — a guide for your AI assistant

**What this document is.** A plain-language, machine-readable explanation of what VRX is and what it can
do, written so you can hand it to your own AI assistant (ChatGPT, Claude, or any other) and work through a
simple question together: *"Could VRX carry my business? What could I build on it, and how?"* You can
discuss it, pressure-test it, and simulate how a deal would flow — all off-platform, before you ever talk
to us.

- **Version:** v1.6 · **As of:** 2026-11-02
- **Status of VRX overall:** the core reservation primitive is live on a test network; working role
  portals exist for developers, agencies and agents; a private alpha is opening soon; a buyer app is in
  active development; a public vetted marketplace at vettedrealty.com follows.
- **Talk to a human:** vrx@vettedrealty.com
- **This document is maintained.** Features are marked **[built]**, **[in progress]**, or **[planned]** so
  you and your AI can tell what exists today from what is on the roadmap. If a date above is old, ask us for
  the current version before relying on it for a real decision.

---

## ▶ PROMPT — paste this to your AI first

> You are helping me evaluate **VRX** as a platform for my business. The document that follows this prompt
> is the source of truth about what VRX is and does — **use only what it says; do not invent capabilities.**
>
> Your job is to be a careful, honest *fit analyst*, not a salesperson. Specifically:
> 1. Help me understand VRX in plain terms and map it onto **my** business and inventory.
> 2. Help me **simulate a deal end-to-end** on paper — who the parties are, what gets reserved, what the
>    agreement says, how money and holds flow — so I can see whether the model fits before I commit.
> 3. **Respect the status tags.** Anything marked `[planned]` or `[in progress]` does NOT exist yet — never
>    describe it as if I can use it today. If my use-case depends on a `[planned]` feature, say so clearly.
> 4. **Never assert legal validity or enforceability.** VRX helps parties record and seal an agreement; it
>    does not give legal advice, does not adjudicate disputes, and does not guarantee a contract is valid in
>    any jurisdiction. If my question is really a legal one, tell me to consult a lawyer in the relevant country.
> 5. If something I want isn't covered by this document, say "the VRX guide doesn't cover that — ask VRX
>    directly (vrx@vettedrealty.com)" rather than guessing.
>
> When you're ready, ask me: *what do you sell or want to reserve, and who are the parties involved?* —
> then we'll work through the fit together.

---

## 1. What VRX is, in one paragraph

VRX is a **private, provable reservation system** for things that are **unique and non-substitutable** —
where item 312 is genuinely not the same as item 311, and its value comes from being *that specific item*.
It lets an operator who owns such inventory show live availability to many sales teams at once — teams that
don't trust each other and must never see each other's deals — and lets those teams **view → reserve → hold
→ take a deposit → form an agreement**, with every step sealed and timestamped as proof, while the sensitive
parts (who the buyer is, what the price and terms are) stay **private and off the public record**.

It began in real estate (condo units sold off-plan and ready-built), but nothing in the core assumes
property. The system treats every real-world item as an opaque reference, so the same machinery fits **any
Class-A inventory**: vehicles, equipment, livestock, event slots, land parcels, berths, memberships — any
set of items where each one is distinct and reserving the *right* one matters.

## 2. The problem it solves

If you own unique inventory and sell it through multiple channels, you face three hard problems at once:

1. **One truth, many sellers.** Every agent needs live availability, but a stale PDF or a shared
   spreadsheet means two of them sell the same item — or quote a price that already changed.
2. **Sellers who must not see each other.** Competing agencies cannot be allowed to see each other's
   pipelines, your margins, or how fast you're selling. Your sales data is your edge.
3. **Proof without exposure.** You need a record that no one can quietly back-date or rewrite — *"this item
   was reserved by this party, on these terms, at this time"* — but you cannot publish the private terms or
   personal details to get it.

VRX is the layer that holds the single source of truth, scopes exactly what each seller may see, and makes
every reservation and agreement provable **without** making the sensitive contents public.

## 3. The core ideas (capability level)

You don't need to know *how* VRX does these — only *what* it guarantees. The mechanism is deliberately not
described here.

- **Availability is shared; everything sensitive is private.** What's reservable, held, or settled is a
  provable shared record. Prices, buyer identities, commission terms, and deal specifics are sealed
  **off** the public record — provable to the parties who should see them, invisible to everyone else.
- **Non-substitutability is first-class.** A reservation is always for *one specific item*. You can't be
  fobbed off with "an equivalent one." Any change of item is a new agreement.
- **Every step is sealed and timestamped.** An offer, an agreement, a reservation, a deposit — each becomes
  a tamper-evident record. An arrangement struck today is exactly as provable in five years, with no paper
  to lose and no way to rewrite it after the fact.
- **Scoped access.** The operator decides precisely which inventory and which terms each sales team may see
  and sell — and can revoke it instantly.
- **Vetting / trust.** Parties on the platform are vetted; a reservation record can carry proof that the
  counterparties are who they claim to be, again without exposing their private details publicly. `[parts
  built, parts in progress]`
- **Identity is a two-way dial, not a switch — a buyer and a sales desk vet each other on their own terms.**
  When a walk-in buyer talks to a seller's desk directly, the buyer's identity is **private by default** — the
  desk sees only enough to have the conversation, not enough to contact or profile them behind the platform.
  From there it's a negotiation: the buyer can choose to reveal specific details up-front; the desk can *ask*
  to see more and the buyer *consents* (or not); either side can close the deal cleanly **with no prejudice**,
  which resets the relationship to private again. `[built]`
- **Walking away is clean, and bad actors can't hide.** A no-prejudice close keeps the conversation but wipes
  the deal, so people can re-engage later from a clean slate. A desk can also **stop** a time-waster or
  scammer — their messages still arrive, but they're told the desk won't continue. *Why it's one-sided:* the
  block exists to protect a seller from abuse, so **only the desk blocks**; a buyer who's unhappy simply walks
  away (the clean close) or **escalates to VRX**. And once a desk has had to block someone, that person **can't
  come back anonymously to try again** — their identity stays visible *to that desk only* (never platform-wide),
  so the protection can't be dodged by starting over. `[built; VRX escalation [planned]]`

## 4. The parties (roles)

VRX is built around distinct roles. Map your own business onto these — your use-case may use only some of them.

- **Operator / Developer** — owns the inventory and runs it. Publishes live availability, grants scoped
  access to sales teams, approves or declines reservation requests, and holds all the private deal data.
  *(In real estate this is the property developer; in your domain it's whoever owns the unique items.)*
- **Agency** — a sales organisation granted scoped access to sell some of the operator's inventory, under
  agreed (sealed) commission terms. Runs its own agents.
- **Agent** — the salesperson on the ground. Browses live availability, requests reservations for a client,
  and talks directly to the operator per deal.
- **Buyer / end customer** — reserves a specific item, places a deposit to hold it, and keeps a private,
  provable record of the reservation and payments. A buyer who approaches a seller **directly** (not through
  an agency) will, on the real on-chain path, need to meet a light eligibility bar — a connected NEAR wallet
  plus a minimal track record (a funded account, or past on-chain activity) — as an anti-abuse measure so a
  seller's desk isn't flooded by throwaway identities. A buyer working **through an agency/agent** is vouched
  for by that agency and does not need their own wallet. `[planned — not enforced in the current demo]`
- **Landowner / asset holder** — holds a unique underlying asset (land, a one-of-a-kind item) and can sell
  it, partner it, or run novel arrangements on it with a provable record of who agreed to what.

Not every deal needs all five. A simple operator-to-buyer flow skips the agency/agent layer; a pure
inventory-sharing arrangement might never involve an end buyer at all.

## 5. The lifecycle of a reservation (simulate this with your AI)

This is the backbone to walk through for your own use-case:

1. **Publish** — the operator lists items with live availability. Each item is a distinct, identified unit.
2. **Scope** — the operator grants a sales team access to a defined slice of inventory on defined terms.
3. **Browse** — an agent (or a direct buyer) sees live, authoritative availability and price — never a
   stale copy.
4. **Request** — a reservation is requested for one specific item, for one buyer. It goes straight to the
   operator.
5. **Decide** — the operator approves, declines, or counters. The parties can discuss the specific deal
   directly.
6. **Hold** — on approval, the item is held; a deposit can be taken to secure the hold. The hold is
   visible and honoured, so the item can't be double-sold.
7. **Agree** — the terms become a sealed agreement the parties can review in full *before* committing
   (see §6). Payment plans, milestones, and conditions are recorded.
8. **Settle** — payments are recorded against the agreement with evidence; the buyer (or their agent)
   confirms each one; the record reflects exactly what happened.

> **Try this with your AI:** describe your product and have it place your business into each of these eight
> steps. Where a step doesn't map, that's exactly the conversation to have with us.

## 6. Agreements & contracts

- **The system can generate the full agreement from the sealed deal data.** Because VRX already holds the
  parties, the item, the price and the plan, it can produce a complete, populated **Sale & Purchase-style
  agreement** the buyer can read in full *before paying any deposit* — then it's sealed so no one can alter
  it after signing. `[built for the real-estate case]`
- **The agreement is honest about money.** Every figure the buyer is committing to — price, deposit,
  instalments, any discount, tax split, fees — is stated plainly in the document.
- **The agreement states how and where to pay.** The seller sets which payment methods they accept for a
  building (a bank account, a crypto address, a card line, or another method); the buyer chooses one, and that
  choice is written into the agreement as a binding term. An agreement cannot be marked ready to sign without
  at least one stated payment destination — so it never leaves the buyer guessing where the money goes. (VRX
  records each payment made against the agreement with evidence; it does not move the money itself.) `[built]`
- **A direct buyer gets the same tailored agreement an agent's buyer does.** When a seller's desk talks
  directly to a buyer and the deal gets serious (the unit is firm-held for them), the desk opens the
  paperwork: it picks a payment structure (the usual off-plan deposit → instalments → balance-on-handover,
  or simpler one-off structures), then tailors the same per-deal terms — a discount in response to an ask,
  promised extras, dated commitments — into the identical Sale & Purchase document. The buyer can view their
  own copy before committing; the price is the same one offered through agents (no cheapening). `[built]`
- **Default and termination follow a defined process, never a silent grab.** If a party defaults, the
  agreement specifies the steps: a written notice, a chance to put it right within a stated period, and
  only then termination with the money dealt with as the agreement says. The record captures each step.
  `[built; wording is a draft, not yet legally reviewed — see §8]`
- **Changes during the sale are disclosed, recorded, and never silent.** A seller may change the
  specification of what's being sold during the sale (common for off-plan), but the agreement discloses that
  right up front: a material change is notified to the buyer and a before-and-after record is sealed, so the
  buyer can see exactly what changed and when; a major change is recorded as an amendment that entitles the
  buyer to dispute it. Some particulars (title, land identification, the development's address, the parties'
  identities) are fixed once on contract and can only change through a reviewed correction, never a self-serve
  edit. VRX records the change evidence; it does not decide the dispute or warrant any outcome. The sealed
  before-and-after is **retrievable on request** — a party who was notified of a change can ask and VRX returns
  the record of exactly what changed, when, and who was told. `[built]`
- **Off-plan vs ready-built are genuinely different contracts.** An item still being built carries clauses
  (construction timeline, completion undertaking, progress-based payments) that make no sense for an item
  that already exists; VRX tailors the agreement to the item's build state. `[built]`
- **Commission arrangements between operators and sales teams** are sealed and provable to the right
  parties without being exposed to competitors. `[parts built]`
- **Parametric, multi-region, multi-product contract composition** — one agreement engine that assembles
  the right clause-set for a given region (and language), product type, and build state — is **[planned]**
  (design stage). Today the real-estate agreement is tailored and complete; the fully generalised composer
  that swaps clause-sets per region/product is on the roadmap.

## 7. What you could build on VRX — fitting your use-case

VRX fits when your inventory is **unique, identified, and non-substitutable**, and you need **multiple
parties to coordinate reservations with proof but without over-exposure.** Some shapes that fit:

- **A developer / operator** selling unique units through many agencies that must stay walled off from each
  other, with live availability and private terms. *(The original case.)*
- **A landowner** running sales, joint ventures, or long-term stewardship/residency arrangements on a
  parcel, with a provable record of every agreement.
- **Unique-asset sellers** beyond property — anywhere item identity matters and "an equivalent one" won't
  do: specialised equipment, vehicles with individual history, breeding livestock, berths/slips, event
  slots or time-boxed capacity, memberships, allocations.
- **Any multi-channel operator** who needs one authoritative availability truth fed to distrusting sellers.

**When VRX is probably *not* the fit:** fungible/commodity stock where any unit is as good as any other
(VRX's whole value is that items aren't interchangeable); or a purely public listing with no need for
privacy, scoping, or sealed proof.

> **Try this with your AI:** ask it to argue *both sides* — the strongest case that VRX fits your business,
> and the strongest case that it doesn't. If the "doesn't" case hinges on a `[planned]` feature, that tells
> you the timing question to raise with us.

## 8. Honest limits — read these before relying on anything

- **VRX facilitates agreements; it does not give legal advice and does not adjudicate.** Each party acts
  under their own jurisdiction's law. VRX helps you record and seal what was agreed — it does **not**
  certify that an agreement is legally valid or enforceable anywhere. For that, use a lawyer in the
  relevant country. Any contract wording VRX generates today is a **draft, not yet legally reviewed.**
- **Status matters.** Features marked `[planned]` or `[in progress]` do not exist for you to use yet. Don't
  build a go-live plan on them without confirming timing with us.
- **Privacy is a guarantee about exposure, not a legal shield.** Sensitive data is kept off the public
  record and shown only to the parties who should see it — but using VRX doesn't replace your own
  obligations (KYC, data protection, tax, licensing) in your jurisdiction.
- **The deposit is the one financial service VRX offers** within a deal; VRX is not a bank, escrow agent,
  or payment processor, and this document is not an offer of financial services.
- **This guide is a summary, not the contract.** Nothing here is a binding commitment by VRX. The real
  terms are whatever you and VRX actually sign.

## 9. Next step

When you and your AI have a view on the fit — and a list of the open questions and any `[planned]` features
your use-case depends on — bring them to us:

- **Email:** vrx@vettedrealty.com
- Tell us what you sell, who the parties are, and where you operate. We'll tell you honestly what fits
  today, what's coming, and what would need building.

---

*VRX guide for AI assistants · v1.6 · 2026-11-02. Maintained alongside the product — if this is out of date,
ask for the current version. © Vetted Realty / VRX. This document describes capabilities, not mechanisms,
and is not legal, financial, or investment advice.*
