// Per-role sections. Each role answers the same four questions so every visitor can read
// the site from their own perspective: what it is · how it works · how you'll use it · why you trust it.

export interface Role {
  id: string;
  name: string;
  tag: string;
  tagline: string;
  what: string;
  how: string;
  use: string[]; // "how you'll use it" — concrete bullets
  trust: string; // "why you trust it"
  image: string; // filename in /img (see IMAGE_PROMPTS.md)
  imageAlt: string;
  imageCaption: string;
}

export const ROLES: Role[] = [
  {
    id: "landowners",
    name: "Landowners",
    tag: "own the asset",
    tagline: "You hold something unique. Put it to work — on your terms, with proof at every step.",
    what:
      "If you hold land or a one-of-a-kind asset, VRX is the trust layer that lets you sell it, partner it with a developer, or run novel arrangements — like a community living on it, a residency, renewable-energy tenants — while keeping a clear, provable record of who agreed to what.",
    how:
      "Your parcels become private, verifiable records. You decide who may see them and on what terms. Every offer, agreement and reservation is sealed and timestamped — so a partnership struck today is exactly as provable in five years, with no stack of paper to lose or dispute.",
    use: [
      "List a parcel privately and invite only vetted developers or partners to view it.",
      "Strike a sale, a joint venture, or a long-term stewardship/residency deal — each sealed on-chain.",
      "Track every unit, resident or tenant arrangement on the land from one live view.",
      "Keep full provenance: who agreed, when, and to what — without exposing terms publicly.",
    ],
    trust:
      "Your terms and your counterparties' details never go public. What is recorded is tamper-proof and time-stamped, so no one can quietly rewrite the deal. You own your record, and you choose who reads it.",
    image: "role-landowner.jpg",
    imageAlt: "A landowner granting vetted developers private, sealed access to a unique parcel",
    imageCaption: "Your land, your terms — every arrangement sealed and provable.",
  },
  {
    id: "developers",
    name: "Property developers",
    tag: "run the inventory",
    tagline: "Thousands of units. Tens of thousands of payments. Years of timeline. One source of truth.",
    what:
      "VRX is the live, single source of truth for your entire portfolio — every project, every unit, every reservation and milestone — that you feed to as many sales agencies as you like without any of them seeing each other's deals, your margins, or your velocity.",
    how:
      "You run your own secure node: your data, your keys, your local tools. You publish live availability; agencies and agents read it in real time; bookings and holds flow back to you for a yes or no. Money, prices and milestones stay private off-chain as sealed records — the shared ledger shows only available, held, or settled.",
    use: [
      "See every project, building, unit and payment status across years from one executive view.",
      "Grant each agency precisely the inventory and terms it may sell — and revoke it instantly.",
      "Approve, decline or counter booking requests, and chat directly with the agent on each one.",
      "Watch sales velocity and availability move in real time — without leaking it to competitors.",
    ],
    trust:
      "Your sales data is your edge, so it never touches the public chain. Agencies can't see each other; the market can't see your numbers. What you do publish — availability — is provable and can't be faked or back-dated against you.",
    image: "role-developer.jpg",
    imageAlt: "A developer's executive dashboard tracking thousands of units and payments over years",
    imageCaption: "One live view over thousands of units and years of timeline.",
  },
  {
    id: "agencies",
    name: "Agencies",
    tag: "sell at scale",
    tagline: "Sell confidently from live, authoritative inventory — and manage your whole team on it.",
    what:
      "An agency is granted scoped access by a developer to sell inventory. VRX gives you live, authoritative availability and pricing — no stale PDFs, no double-sold units — plus the tools to run your sales team on top of it.",
    how:
      "You accept a developer's grant, which defines exactly what you can sell and your commission terms (sealed, never public). Your agents work under you, each seeing only what they should. Every booking they place is instantly reflected to the developer and back.",
    use: [
      "Onboard your sales team; give each agent the right slice of inventory.",
      "Work from always-current prices and availability — the developer's live truth, not a copy.",
      "See your team's pipeline and holds in one place; never double-sell a unit again.",
      "Have your commission terms sealed and provable, without exposing them to anyone else.",
    ],
    trust:
      "The inventory you sell from is the developer's own live record — so you're never caught selling something already gone. Your commission agreement is cryptographically sealed: provable to the developer, invisible to rivals.",
    image: "role-agency.jpg",
    imageAlt: "An agency managing its sales team on live, scoped inventory from a developer",
    imageCaption: "Live inventory, scoped access, a team that can't double-sell.",
  },
  {
    id: "agents",
    name: "Agents",
    tag: "close the deal",
    tagline: "Everything you need to close — live price, live availability, and a direct line to the decider.",
    what:
      "An agent is the salesperson on the ground. VRX puts confident, real-time, full detail in your hand: what's available, the exact price, and a direct conversation with whoever can say yes — all from one screen.",
    how:
      "You browse live inventory, request to book a specific unit for your buyer, and the request goes straight to the developer. You chat per-booking in real time, see accepted / declined / counter instantly, and manage all your deals in one place.",
    use: [
      "Browse live availability and prices you can actually trust in front of a client.",
      "Request to book a unit in seconds — the developer sees it immediately.",
      "Chat directly with the person who decides, per booking, in real time.",
      "Track all your bookings and their status in one 'my deals' view.",
    ],
    trust:
      "No more quoting a price that changed or a unit that sold this morning. What you see is the live truth. Your buyer's personal details are sealed and never exposed on-chain — you look professional and your client stays private.",
    image: "role-agent.jpg",
    imageAlt: "An agent booking a unit and chatting live with the decision-maker from one screen",
    imageCaption: "Live truth in your hand, and a direct line to yes.",
  },
  {
    id: "buyers",
    name: "Buyers",
    tag: "reserve with trust",
    tagline: "Reserve with confidence, knowing the record is real and your details stay yours.",
    what:
      "For the end buyer, VRX means the unit you're reserving is genuinely available, the terms are honoured, and your personal information is never splashed across a public ledger.",
    how:
      "You view vetted inventory, place a reservation through a vetted agent or directly, pay a deposit to hold, and have every step provable — all while your identity and the deal terms stay private.",
    use: [
      "Reserve a specific, genuinely-available unit — no bait, no double-sell.",
      "Hold it with a deposit while you finalise, with the hold visibly honoured.",
      "Keep a private, provable record of your reservation and payments.",
      "Know everyone you deal with is vetted.",
    ],
    trust:
      "Your name, your payments and your terms are sealed off-chain — never public. The availability and the hold are on-chain and provable, so you can trust that what you reserved is truly yours to complete.",
    image: "role-buyer.jpg",
    imageAlt: "A buyer reserving a vetted, genuinely-available unit with private details",
    imageCaption: "A real reservation, your details kept private.",
  },
];
