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
  | { type: "call_off" } //  PROPOSE only — never auto-agree (Q3).
  | { type: "block" } //  anti-scammer; default-OFF toggle (Q1).
  | { type: "query"; tool: string; args?: Record<string, unknown> }; // a RETRIEVAL request the server
//      runs over the real catalog (matrix-gated) and feeds BACK into the model loop; NEVER returned to the
//  caller, NEVER acted, NEVER clamped — it's intercepted inside decide's Option-B loop (tool-loop.ts).

/** One line of a price quote. `amountUsd` negative = a deduction (discount / included pack value). The app
 *  renders these as an aligned block (deterministic layout — NOT the model's whitespace, which is unreliable). */
export type QuoteLine = { label: string; amountUsd: number };

/** The brain's output: the reply text to post + an optional action + an optional running SUMMARY. The summary is
 *  the AI's own one-line distillation of where the deal stands (phase, budget band, which unit, next step) — it
 *  rewrites it each turn and the act layer files it to the deal sidecar (the developer work-report source). No PII
 *  (the context is already masked+scrubbed); absent on a turn where the AI has nothing new to record. */
export type DeskDecision = { reply: string; action: DeskAction; summary?: string; phase?: Phase };

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
