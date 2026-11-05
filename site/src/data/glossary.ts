// Glossary — single source of truth for both the inline <Term> hover-popups and the full
// glossary section. Keep definitions plain-language: a non-technical landowner and a technical
// reviewer should both come away correct. "key" is what you pass to <Term key="...">.

export interface GlossaryEntry {
  key: string;
  term: string; // display label
  short: string; // the popup body (1–3 sentences, plain words)
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    key: "primitive",
    term: "reservation primitive",
    short:
      "A small, reusable building block that does one thing extremely well — here, recording who reserved what, privately and provably. Like a single reliable brick that many different buildings can be made from.",
  },
  {
    key: "source-of-truth",
    term: "single source of truth",
    short:
      "One record everyone agrees on, that no single party can quietly change. Instead of every team keeping its own spreadsheet that drifts out of sync, all parties read and trust the same live state.",
  },
  {
    key: "on-chain",
    term: "on-chain",
    short:
      "Recorded on a public blockchain (we use NEAR). Once written it cannot be secretly altered or back-dated, and everyone can verify it — which is exactly why it makes a trustworthy shared record.",
  },
  {
    key: "trustless",
    term: "trustless",
    short:
      "You don't have to trust the other party — or even us — because the system itself enforces the rules and the record proves what happened. 'Trustless' means safe even between parties who don't know each other.",
  },
  {
    key: "hash",
    term: "cryptographic hash",
    short:
      "A short, irreversible fingerprint of some data. It proves the data exists and hasn't changed, without revealing the data itself. We put only fingerprints on-chain — never names, prices, or deal terms.",
  },
  {
    key: "hmac",
    term: "keyed seal (HMAC)",
    short:
      "A fingerprint made with a secret key, so only the holder of the key can produce or verify it. We use it to seal private terms: the seal proves the terms are genuine and untampered, while the terms stay off-chain and private.",
  },
  {
    key: "privacy-moat",
    term: "privacy by design",
    short:
      "Nothing sensitive ever touches the public record. All real-world identifiers — who, which unit, what price — stay off-chain as sealed fingerprints. The chain shows only 'reserved / available', never the deal.",
  },
  {
    key: "non-substitutable",
    term: "non-substitutable inventory",
    short:
      "Each item is unique and can't be swapped for another — unit 312 is not unit 311, this parcel is not that parcel. Value tracks the specific item, so getting the reservation exactly right actually matters.",
  },
  {
    key: "hold",
    term: "hold",
    short:
      "A temporary, exclusive reservation on a specific unit while a deal is being finalised. Other agents can see it's held (so they don't double-sell it) but cannot see the deal behind it. Holds expire if not completed.",
  },
  {
    key: "developer",
    term: "developer",
    short:
      "The party with the inventory to sell — a property developer, but equally a landowner, a car fleet, an equipment owner. They run the single source of truth for their own stock.",
  },
  {
    key: "agency",
    term: "agency",
    short:
      "A sales organisation granted access by a developer to sell some or all of the inventory. Each agency sees only what it's permitted to, and its sales team works under it.",
  },
  {
    key: "agent",
    term: "agent",
    short:
      "An individual salesperson working under an agency. They view live availability and prices, request bookings, and talk directly to whoever decides — in real time, from one screen.",
  },
  {
    key: "vetted",
    term: "vetted",
    short:
      "Every participant is verified before they can act. Identity checks are done once, sealed, and reusable — so the whole network is made of known, accountable parties, not anonymous strangers.",
  },
  {
    key: "node",
    term: "node",
    short:
      "A developer's own secure box that holds their data, keys and local tools. It feeds live availability to the shared record and can move with the business — your office is portable.",
  },
  {
    key: "regional-node",
    term: "regional node",
    short:
      "A local point of presence that keeps the shared record fast and in sync across regions, so a global network of developers, agencies and buyers all see the same live state.",
  },
  {
    key: "settlement",
    term: "settlement",
    short:
      "Completing the deal — deposit, payments and handover. Amounts and milestones stay private off-chain; the shared record reflects only that the unit moved from held to settled.",
  },
  {
    key: "provenance",
    term: "provenance",
    short:
      "A verifiable history of what happened and when — who reserved, who agreed, what was sealed — that any permitted party can check later. It's the audit trail that makes disputes short.",
  },
];

export const GLOSSARY_MAP: Record<string, GlossaryEntry> = Object.fromEntries(
  GLOSSARY.map((g) => [g.key, g]),
);
