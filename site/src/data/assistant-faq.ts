// Canned Q&A for the site assistant — the biggest token-saver.
// If a visitor's question closely matches one of these, the widget answers INSTANTLY from here
// with ZERO DeepSeek API call (no tokens spent). Only genuine misses hit the LLM.
// The 4 suggestion chips map 1:1 onto the first entries so the most-asked questions are free.
// Matching is keyword-overlap (see AssistantWidget). Keep `q` as the canonical question and
// `keys` as the distinctive trigger words a visitor is likely to use.

export interface FaqEntry {
  q: string;
  keys: string[];
  a: string;
}

export const FAQ: FaqEntry[] = [
  {
    q: "What is VRX?",
    keys: ["what", "vrx", "vetted realty", "about", "explain", "is this", "what's"],
    a: "VRX is a private, on-chain reservation primitive — one single source of truth for who reserved what. An operator with unique inventory publishes live availability, and many sales teams can view, book, reserve and settle — privately and provably. Real estate is the proving ground, but it fits any high-value item that needs no shipping (changes hands by deed, key or access): land, houses, art, event/travel tickets, software licence keys, AI models — any unique, non-substitutable asset.",
  },
  {
    q: "How does privacy work?",
    keys: ["privacy", "private", "secure", "hash", "encrypt", "confidential", "data", "gdpr", "leak"],
    a: "Privacy is designed in, not bolted on. No personal data, prices, or deal terms ever go on the public blockchain — only sealed cryptographic fingerprints (hashes). The chain shows only \"available / held / settled\", never the deal itself. So the market can see a unit is reserved, but never who reserved it, for how much, or on what terms.",
  },
  {
    q: "I'm a developer — what do I get?",
    keys: ["developer", "develop", "builder", "portfolio", "units", "projects", "my stock", "inventory owner"],
    a: "As a property developer you get one live view over your entire portfolio — every project, unit, reservation and milestone across years — that you feed to as many sales agencies as you like without any of them seeing each other's deals, your prices, or your velocity. You approve or decline bookings, chat with the agent on each, and your sales data stays private because it never touches the public chain.",
  },
  {
    q: "How do I join the alpha?",
    keys: ["join", "alpha", "sign up", "signup", "get involved", "start", "register", "partner", "contact", "invite"],
    a: "The core primitive is live on a test network today and a private alpha is opening soon. To get involved — as a developer, agency, agent, landowner or partner — use the contact form on this page, or email vrx@vettedrealty.com, and we'll be in touch.",
  },
  {
    q: "What's in it for an agent?",
    keys: ["agent", "salesperson", "sell", "seller", "commission", "close"],
    a: "As an agent you get confident, real-time detail in your hand: live availability, the exact current price, and a direct line to whoever can say yes — all from one screen. You request to book a unit for your buyer in seconds, chat per-booking, and see accepted/declined instantly. No more quoting a price that changed or a unit that already sold. Your buyer's details stay sealed and private.",
  },
  {
    q: "What about agencies?",
    keys: ["agency", "agencies", "sales team", "team", "brokerage"],
    a: "An agency is granted scoped access by a developer to sell inventory — so you always work from live, authoritative availability and pricing (never a stale PDF), and you can't double-sell a unit. You run your sales team on top of it, each agent seeing only what they should, and your commission terms are cryptographically sealed: provable to the developer, invisible to rivals.",
  },
  {
    q: "I own land — can I use this?",
    keys: ["land", "landowner", "own land", "parcel", "farm", "forest", "property owner", "steward"],
    a: "Yes. If you hold land or a unique asset, VRX is the trust layer to sell it, partner it with a developer, or run novel arrangements — like a community living on it, a residency, or renewable-energy tenants — while keeping a clear, provable record of who agreed to what. Your terms and counterparties stay private; what's recorded is tamper-proof and time-stamped.",
  },
  {
    q: "Is it trusted or trustless?",
    keys: ["trust", "trustless", "trusted", "safe", "why believe", "guarantee"],
    a: "Both. \"Vetted\" means every participant is verified before they can act — a network of known, accountable parties. \"Trustless\" means you still don't have to rely on anyone's goodwill, because the record itself enforces the rules and proves what happened. You get the comfort of a vetted club and the certainty of math.",
  },
  {
    q: "What blockchain does it use?",
    keys: ["blockchain", "near", "chain", "crypto", "token", "which chain", "built on"],
    a: "VRX is built on NEAR. Only sealed cryptographic fingerprints go on-chain — never personal data or deal terms. The product is proven by over a decade of real property-sales deployment, now hardened and generalised into a domain-agnostic primitive.",
  },
  {
    q: "Is it available now?",
    keys: ["available", "ready", "live", "when", "launch", "roadmap", "soon", "status"],
    a: "The core primitive is live on a test network today, with working role portals for developers, agencies and agents. A private alpha is opening soon, the buyer app is in active development now, and a public vetted marketplace at vettedrealty.com follows. We're building in the open — email vrx@vettedrealty.com to get involved early.",
  },
];
