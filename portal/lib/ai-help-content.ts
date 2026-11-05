// Free pre-written help — the "(a) free help" half of the help widget. Always available, instant, no
// token cost. Shown as the default "Quick help" tab and as the fallback when the AI is rate/spend-capped.
//
// Sourced from public/for-ai-agent.md + the landing copy — CAPABILITY-level only, honest, no mechanism. Keep
// in sync with for-ai-agent.md's owner-rule: if a capability ships or a product promise moves, update both.
// Client-importable (no secrets, no server deps) so the widget can render it even with the API down.

export type HelpTopic = { q: string; a: string };

export const HELP_TOPICS: HelpTopic[] = [
  {
    q: "What is VRX?",
    a: "VRX is a private, on-chain reservation primitive — one trusted source of truth for who reserved what. An operator with unique inventory (unit 312 is not unit 311) feeds live availability to many sales teams and agencies, who browse, book, reserve, pay a deposit and hold — privately. It's a NEAR smart contract plus this portal. Real estate is the first proof; the primitive is domain-agnostic.",
  },
  {
    q: "Why is it private? What stays off-chain?",
    a: "No personal data, no prices and no deal terms ever go on-chain. The chain proves that a reservation happened and who holds it; the what, how much and with whom stays confidential off-chain. That private shared truth is the whole point.",
  },
  {
    q: "Is this real on-chain yet, or a demo?",
    a: "This site is a sandbox: the real app on seeded data that resets clean. You can enter wallet-free and assume any role. Write actions in the sandbox are simulated — but the VRX contract runs for real on NEAR testnet, which is the honesty anchor.",
  },
  {
    q: "What can I do in the demo?",
    a: "Assume any role (Developer, Agency, Agent, Buyer) from the landing page and see that side of a deal: browse live availability, work a booking from reserve through hold, author a sale-and-purchase contract, and see commission and settlement projections.",
  },
  {
    q: "Who are the roles?",
    a: "Developers own the inventory and grant access; Agencies manage their agents and work the developers; Agents reserve units for buyers; a Buyer browses and transacts via the desk; a CEO/Approver oversees high-stakes financial accountability; and an Authority Review can see the vetted state for oversight without ever seeing private data.",
  },
  {
    q: "What are booking tokens (reservation capacity)?",
    a: "A booking token is a unit of reservation capacity that VRX issues to a developer. The developer hands or sells it down the trust chain — to an agency they work with, then to that agency's field agents — so an agent can secure a real booking and take a deposit on a unit. It works because of visibility, not blind trust: whoever holds a token has the unit visibly off-market, and the developer and agency can see who holds it, so a professional agent can't misuse it without it tracing back to them. Capacity is scarce and reusable — a released or cancelled token returns up the chain to be handed out again. Every hand-off carries a tamper-evident receipt, so cash and capacity can move hand-to-hand with proof at each step instead of the old ATM-and-office cash run. You see your tokens as 'coins' in your wallet.",
  },
  {
    q: "What's built versus planned?",
    a: "Built: live availability, role dashboards, the book/reserve/hold flow with attested records, booking-token reservation capacity handed developer→agency→agent with sealed receipts, sale-and-purchase contract authoring, the vetting gate, and the live testnet contract. In progress: real-wallet verified sign-in, and a richer agency console (per-agent cards, chat, scheduling/dispatch). Planned (not usable yet): a real on-chain settlement rail, a secondary market, and multi-jurisdiction packs.",
  },
  {
    q: "What's VRX's legal position?",
    a: "VRX facilitates and seals reservations and agreements; it does not adjudicate disputes or warrant the legal enforceability of any underlying contract. The parties' own terms and local law govern — VRX provides the tamper-evident record and the private shared truth.",
  },
  {
    q: "How do I get in touch?",
    a: "Email vrx@vettedrealty.com. The business behind the primitive is Vetted Realty (vettedrealty.com).",
  },
];
