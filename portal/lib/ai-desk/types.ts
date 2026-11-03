// AI Sales Director — shared types. Role-agnostic by design (the design docs §4): the
// engine is built so the same brain later powers an AI counterparty for ANY party; v1 WIRES the direct-sales
// desk only. Everything here is PURE data — no fs, no network, no React — so it imports safely anywhere.

import type { Phase } from "./permissions";

/** A masked buyer profile field map (already run through buyer-mask.publicDirectProfileView — NO raw PII). */
export type MaskedProfile = Record<string, string>;

/** One chat turn, PII-scrubbed (lib/ai-desk/pii-scrub). `from` mirrors the direct-thread author roles we care
 *  about here: the buyer, or the desk (developer side the AI plays), or a vrx system notice. */
export type ScrubbedTurn = { from: "buyer" | "developer" | "vrx"; text: string };

/** A concession lever the AI is allowed to compose from — REAL, draftable terms only (verified at build, §3b).
 *  Kept generic so the playbook can combine them; the $-value lets the bound check (maxConcessionPct) count a
 *  furniture-pack combo as a discount equivalent.
 * (slice 4): the lever KINDS are now only what `leversForBuilding` can actually produce — a furniture
 *  pack or a bounded price discount. The old `rental_guarantee` / `payment_plan` / `alt_unit` kinds were
 *  REMOVED: no resolver ever produced them, so they were a confabulation surface (the AI could emit a
 *  concession built on a rental guarantee this building doesn't offer — the live-transcript bug). A real
 *  guarantee/plan a developer DOES author surfaces via building_terms (the real-terms path), never as an
 *  invented lever. */
export type ConcessionLever = {
  kind: "furniture_pack" | "price_discount";
  label: string;
  /** Approx $ value to the buyer (for the bound check). Absent = non-priceable (e.g. a payment-plan tweak). */
  valueUsd?: number;
  /** Optional deadline (ms epoch) for an early-bird framing. */
  deadline?: number;
};

/** The PII-SAFE context handed to the model. Built by lib/ai-desk/sanitize.buildDeskContext — the single
 *  inbound gate. By construction contains NO raw PII (masked profile + scrubbed thread). */
export type DeskContext = {
  conversationId: string;
  /** WHO the desk is talking to, which selects the playbook: a prospective "buyer" (the retail
   *  value-sell — qualify, deflect discount, close) or a professional "agent" booking for their client
   *  (B2B — confirm the hold, be clear on the deal structure + commission, no retail qualifying). Defaults
   *  to "buyer" when absent so the existing direct-desk path is unchanged. */
  counterparty?: "buyer" | "agent";
  /** Masked buyer view — partial name hint + nationality; hard identifiers dropped. (For an AGENT booking
   *  this is the agent's masked view / may be empty — the agent is a vetted professional, not the end buyer.) */
  buyer: MaskedProfile;
  /** The conversation so far, PII-scrubbed (unless the buyer consented to share — §3b). */
  thread: ScrubbedTurn[];
  /** Plain building/unit facts the AI may quote (public market info — NOT PII). */
  building: { id: string; name: string; area?: string };
  /** The real concession levers available for THIS building/unit (verified draftable). */
  levers: ConcessionLever[];
  /** The conversation PHASE — gates the permission matrix alongside the persona. Defaults to "browse"
   *  (the opening phase). The loop can advance it as the deal moves (the AI declares a phase change, or the act
   *  layer bumps it on a hold/deposit). Absent ⇒ treated as "browse" by the loop. */
  phase?: Phase;
  /** The deal state flags the brain reasons over (from conversations-direct). */
  deal: { epoch: number; blocked: boolean; revealPending: boolean; grantedFields: string[] };
};

/** The action the AI may emit alongside its reply. A tagged union; `none` = chat only. Each non-`none` action
 *  is RE-GATED by config at fire time (lib/ai-desk/act) — fail-closed if its toggle is off. */
export type DeskAction =
  | { type: "none" }
  | { type: "reveal_request"; fields: string[] }
  | { type: "concession"; levers: ConcessionLever[]; totalValueUsd: number }
  | { type: "quote"; lines: QuoteLine[]; netUsd: number } // a price breakdown as DATA — the app renders it
  | { type: "terms"; rows: TermsRow[] } // a PAYMENT-TERMS table as DATA (deposit/on-contract/on-handover %) —
  | { type: "buttons"; buttons: ActionButton[] } // tappable commit chips the buyer taps instead of typing
  //      "yes". The AI (or a human seller) composes words + PROPOSES; the BUTTON carries the commit. Rendered as
  //      chips in the buyer's desk chat; a tap POSTs to /api/desk-action which executes the SAME open_unit/record_
  //  deposit executors server-side. Design: the design docs (Decision B). The spine that
  //      kills the confab/loop/wrong-unit bug class (the commit is a structured payload, never a parsed chat turn).
  | { type: "call_off" } //  PROPOSE only — never auto-agree (Q3).
  | { type: "block" } //  anti-scammer; default-OFF toggle (Q1).
  | { type: "query"; tool: string; args?: Record<string, unknown> }; // a RETRIEVAL request the server
//      runs over the real catalog (matrix-gated) and feeds BACK into the model loop; NEVER returned to the
//  caller, NEVER acted, NEVER clamped — it's intercepted inside decide's Option-B loop (tool-loop.ts).

/** One line of a price quote. `amountUsd` negative = a deduction (discount / included pack value). The app
 *  renders these as an aligned block (deterministic layout — NOT the model's whitespace, which is unreliable). */
export type QuoteLine = { label: string; amountUsd: number };

/** One row of a payment-TERMS table. Unlike a QuoteLine, `value` is a free-form formatted string (a
 *  percentage set, an instalment schedule, a fee) — terms are %/schedules, NOT dollar amounts summing to a net.
 *  The app renders these as an aligned label|value block (deterministic layout — never the model's whitespace,
 * which runs a prose breakdown together). Used to answer a `building_terms` question as DATA. */
export type TermsRow = { label: string; value: string };

/** One tappable COMMIT chip in a desk reply (the in-chat action-buttons spine). The AI/seller PROPOSES
 *  with words; this button carries the exact commit. `kind` selects the executor the server runs when tapped
 *  (`/api/desk-action`); `unit` is the subject the commit acts on; `amountUsd` carries a display figure (e.g. the
 *  deposit) — DISPLAY ONLY, the server always re-derives money (depositPct × live price), never trusting it.
 * `label` is APP-composed from the unit identity (: each button SHOWS what it commits to — "Reserve
 *  unit-301 · 2-bed · $740k"), never model free-text; the server ignores any client-sent label and re-derives it.
 *  `enabled`/`disabledReason` carry gate state (e.g. a Pay-deposit chip greyed until the S&P is acknowledged —
 * the Slice 3a gate; the server re-checks the ack in /api/desk-action, `enabled` is advisory UI). The
 *  payload rides the message's un-hashed `action?` field (channels.ts) — a presentation
 *  affordance, not an attested fact; the attested fact is the hold/deposit the tap PRODUCES (its own ledger/on-
 *  chain truth), so trust-bearing values must NOT live here (§5b.5). */
export type ActionButtonKind =
  | "reserve"
  | "issue_reservation" //  Slice 3b-i — promote the hold into the Reservation Document (§0b). Chip emission is
  //      a later slice; the route (/api/desk-action) accepts it now (materializes the doc + posts a buyer summary).
  | "view_terms"
  | "read_sp"
  | "pay_deposit"
  | "show_similar"
  | "confirm_reservation" //  Slice 3b-ii — the buyer confirms ("time to think" → go); starts the 2h deposit window (§4).
  | "propose_signing_date" //  Slice 3b-iii — either side proposes a signing/ratification date (§0b negotiation).
  | "approve_signing_date"; //  Slice 3b-iii — VRX/the desk approves the agreed date (ratify-before-Land-Office).
export type ActionButton = {
  kind: ActionButtonKind;
  label: string;
  unit: { key: string; type?: string; priceUsd?: number };
  amountUsd?: number;
  enabled: boolean;
  disabledReason?: string;
};

/** A model-emitted BUTTONS request — the LIGHTWEIGHT ask the model produces ("offer these chips for this unit").
 *  The trust-bearing ActionButton[] (labels, live price, enabled/greyed) is composed SERVER-SIDE from this
 *  (lib/ai-desk/compose-buttons) — the model never hand-crafts a button (it confabulates figures + a greyed Pay
 * chip is a legal gate). parseDecision captures this (pure); the impure decide resolves it to the real action. */
export type ButtonsRequest = { kinds: ActionButtonKind[]; unit?: string };

/** The brain's output: the reply text to post + an optional action + an optional running SUMMARY. The summary is
 *  the AI's own one-line distillation of where the deal stands (phase, budget band, which unit, next step) — it
 *  rewrites it each turn and the act layer files it to the deal sidecar (the developer work-report source). No PII
 *  (the context is already masked+scrubbed); absent on a turn where the AI has nothing new to record.
 * `buttonsRequest` carries a model-emitted buttons ask (captured pure in parseDecision; decide composes the real
 *  ActionButton[] from it + sets `action` to the resolved {type:"buttons"}). Absent on a non-buttons turn. */
export type DeskDecision = { reply: string; action: DeskAction; summary?: string; phase?: Phase; buttonsRequest?: ButtonsRequest };

/** The per-action authority config — autonomous-by-default, each switchable at VRX-root. Stored
 *  in .data/ai-desk-config.json (lib/ai-desk/config). */
export type AiDeskConfig = {
  /** Master. OFF = the scripted stub (today's behavior). Default OFF until verifies, then ON. */
  enabled: boolean;
  /** AI drafts + POSTS chat replies autonomously. */
  autoReply: boolean;
  /** AI may fire a C-slice reveal-request (buyer still consents). */
  canRequestReveal: boolean;
  /** AI may offer a bounded concession (within maxConcessionPct). */
  canConcede: boolean;
  /** AI may PROPOSE a call-off (never auto-AGREE). */
  canCallOff: boolean;
  /** AI may hard-block. Default OFF (Q1 — too consequential to be autonomous). */
  canBlock: boolean;
  /** AI may autonomously OPEN (hold) a unit for a deal via the open_unit tool (slice 6). Default ON
 * (D-): the auto-release timers are the safety net for a mistaken hold. Flip OFF at VRX-root to
   *  make the AI PROPOSE a hold (ask a human) instead of placing one. Same posture as the other authority toggles. */
  canOpenUnit: boolean;
  /** Hard discount ceiling as a fraction (0.10 = 10%), counting combo $-value. The real guardrail for canConcede. */
  maxConcessionPct: number;
  /** The §3(b) inbound chat PII scrub. Default ON; buyer per-conversation consent can override per-thread. */
  piiScrubChat: boolean;
  /** HARD global daily token ceiling across all AI-desk calls (reuse ai-help-server ledger posture). */
  spendCapTokensPerDay: number;
  /** How the signing SEAM effects a unit hold (slice 9, docs §9b, the D-D- swap point):
   *   "soft_hold" — the default stub: a sealed OFF-CHAIN soft-hold, NO authorization required (today's behavior).
   *   "vault"     — the autonomous signing vault: open_unit must present a one-time human AUTHORIZATION
   *                 (lib/ai-desk/signing-vault) scoped to THIS unit+deal before the hold is placed. Still
   *                 off-chain in this slice; the on-chain grant_exclusive leg is V7-gated.
   *   "demo_key"  — reserved: sign grant_exclusive on-chain with a server-held demo node key (V7). Not wired yet.
 * Default "soft_hold" so slice 9 is inert until opts in — same fail-safe posture as every authority toggle. */
  signingPosture: "soft_hold" | "vault" | "demo_key";
};

/** The autonomous-by-default config. `enabled` ON by default (verified-ok) — flip off
 *  the VRX-root panel instantly if a reply misbehaves. canBlock stays OFF (permanent + un-anonymizing). */
export const DEFAULT_AI_DESK_CONFIG: AiDeskConfig = {
  enabled: true,
  autoReply: true,
  canRequestReveal: true,
  canConcede: true,
  canCallOff: true,
  canBlock: false, //  Q1 — on-demand only.
  canOpenUnit: true, //  D- — autonomous holds ON; the auto-release timers are the safety net.
  maxConcessionPct: 0.12,
  piiScrubChat: true, // the PII guard is ON; a buyer can REMOVE it per-conversation (the "remove PII guard" toggle).
  spendCapTokensPerDay: 300_000,
  signingPosture: "soft_hold", //  slice 9 — default stub; flip to "vault" at VRX-root to require a one-time authorization.
};
