// AI Sales Director — the PERMISSION MATRIX (the design docs §2). The SPINE of the
// real-data arc: ONE declarative table that is the single source of truth for WHAT DATA the AI may touch,
// keyed by persona × phase. Everything else (the query tools, the loop) reads its verdict from here instead
// of scattering per-lane if-statements. Pure, building-agnostic, fail-closed, unit-tested without a token.
//
// The verdict for a (persona, phase, category) is one of:
//   "allow"  — the (already reduced) answer may be returned to the model AND may surface in the reply.
//   "reason" — the server MAY use the figure to shape the answer, but it is NEVER returned verbatim to the
//              model (e.g. a commission delta → "your margin is protected"; a comparison → "better value").
//   "deny"   — the tool refuses; the model is told the datum isn't available in this context.
// A missing cell = "deny" (fail-closed) — a new phase/category is locked until explicitly granted.
//
// The driving example (the first real instance): "what's my commission?" yields a DIFFERENT
// lawful answer by counterparty — deny to a buyer, reason-only (reassure, never quote) to an agent, allow
// (delta from baseline) to an agency. That rule lives HERE as cells, not baked into one persona's prompt.

/** Who the AI is talking to. `buyer`/`agent` are wired today (sanitize.buildBookingContext derives them via
 *  isDirectOffer). `agency` is the lawful holder of the developer agreement — column DEFINED (so the
 *  commission-delta distinction is encoded + the spine is future-ready) but its conversation lane is NOT wired
 * yet. */
export type Persona = "buyer" | "agent" | "agency";

/** The conversation phase. Phases change mid-conversation, so the accessible-data set changes with them. The
 *  AI (or the loop) advances the phase; the matrix gates each turn by the CURRENT phase. */
export type Phase = "browse" | "qualify" | "negotiate" | "book" | "deposit" | "aftercare";

/** The data categories the matrix gates (rows). Mirrors the query tools in §3 + the sensitive figures. */
export type DataCategory =
  | "inventory" // the list/count of matching units (reduced to summaries, never the full table)
  | "unit_detail" // one unit's public facts (floor/sqm/price/view/corner/baths/note)
  | "building_terms" // deposit / instalment plan / fees / contract days — ONLY fields that exist
  | "fees" // reservation/booking/maintenance/transfer fees
  | "price" // a unit's list price (public market info)
  | "commission_rate" // the developer-side commission — the privacy-sensitive one
  | "buyer_pii" // any raw buyer identifier — never to the model, ever
  | "concession_levers" // the real draftable levers (furniture packs / discount)
  | "open_unit" // the grant/open-claim action (gated further by cfg.canOpenUnit at fire time)
  | "reveal_unit" // OPEN a unit into the buyer's in-app view (the operator grant the AI lacked)
  | "deposit" // the reservation-deposit action (slice 6 — file + validate the deposit receipt)
  | "deal_sidecar"; // the AI's own per-deal memory (state + summary)

export type Access = "allow" | "reason" | "deny";

/** A phase→category access map. Any category absent from a phase inherits the persona's `base` row, and any
 *  category absent from BOTH the phase and the base = "deny" (fail-closed). */
type PhaseAccess = Partial<Record<DataCategory, Access>>;

/** A persona's matrix: a `base` row applied in every phase (the persona-wide invariants — e.g. buyer_pii is
 *  ALWAYS deny; commission_rate is deny-to-buyer / reason-to-agent in every phase) + per-phase overrides that
 *  widen access as the deal progresses (e.g. open_unit only becomes reachable at `book`). */
type PersonaMatrix = { base: PhaseAccess; phases: Partial<Record<Phase, PhaseAccess>> };

// ── buyer_pii and commission_rate are the two invariants worth stating once per persona (the `base` row), so a
//    new phase can never accidentally widen them. Everything a buyer may freely see (inventory/price/terms) is
//    "allow" from the start; the only things that unlock by phase are the ACTIONS (open_unit at book). ──

const BUYER: PersonaMatrix = {
  base: {
    inventory: "allow",
    unit_detail: "allow",
    building_terms: "allow",
    fees: "allow",
    price: "allow",
    concession_levers: "allow",
    deal_sidecar: "allow",
    commission_rate: "deny", // a buyer never sees the developer-side commission
    buyer_pii: "deny", // the AI never receives raw PII (the masked view is separate, pre-scrubbed)
    open_unit: "deny", // unlocks only at the book phase (below)
    reveal_unit: "deny", // unlocks from qualify onward (below) — showing units to view is a mid-conversation act
    deposit: "deny", // unlocks only at the deposit phase (below)
  },
  phases: {
    // reveal_unit (open a unit to VIEW) unlocks early — a human desk opens units during the conversation, well
    // before any hold — and stays reachable through booking. Distinct from open_unit (the HOLD, book/deposit only).
    qualify: { reveal_unit: "allow" },
    negotiate: { reveal_unit: "allow" },
    book: { open_unit: "allow", reveal_unit: "allow" }, // can hold once booking (gated by cfg.canOpenUnit) + still reveal
    deposit: { open_unit: "allow", reveal_unit: "allow", deposit: "allow" }, // hold + reveal reachable + deposit unlocks
  },
};

const AGENT: PersonaMatrix = {
  base: {
    inventory: "allow",
    unit_detail: "allow",
    building_terms: "allow",
    fees: "allow",
    price: "allow",
    concession_levers: "allow",
    deal_sidecar: "allow",
    // THE driving rule: to an AGENT the AI KNOWS the rate but must NEVER quote it (the agency sets what it
    // passes to its own agents; quoting the developer-side rate leaks the agency's margin). "reason" lets the
    // server reassure ("your commission stands under your agency's agreement") without ever emitting a figure.
    commission_rate: "reason",
    buyer_pii: "deny",
    open_unit: "deny",
    reveal_unit: "deny",
    deposit: "deny",
  },
  phases: {
    qualify: { reveal_unit: "allow" },
    negotiate: { reveal_unit: "allow" },
    book: { open_unit: "allow", reveal_unit: "allow" },
    deposit: { open_unit: "allow", reveal_unit: "allow", deposit: "allow" },
  },
};

// AGENCY — DEFINED, lane UNWIRED. The lawful holder of the developer agreement CAN get a straight
// commission answer, but only the DELTA from the baseline agreement (not the whole agreement) — encoded as
// "allow" on commission_rate. No conversation lane consumes this column yet; it exists so the distinction is
// captured and the matrix is complete when the agency arc is built.
const AGENCY: PersonaMatrix = {
  base: {
    inventory: "allow",
    unit_detail: "allow",
    building_terms: "allow",
    fees: "allow",
    price: "allow",
    concession_levers: "allow",
    deal_sidecar: "allow",
    commission_rate: "allow", // lawful holder → straight answer (delta from baseline — enforced at the tool)
    buyer_pii: "deny",
    open_unit: "deny",
    reveal_unit: "deny",
    deposit: "deny",
  },
  phases: {
    qualify: { reveal_unit: "allow" },
    negotiate: { reveal_unit: "allow" },
    book: { open_unit: "allow", reveal_unit: "allow" },
    deposit: { open_unit: "allow", reveal_unit: "allow", deposit: "allow" },
  },
};

const MATRIX: Record<Persona, PersonaMatrix> = { buyer: BUYER, agent: AGENT, agency: AGENCY };

/**
 * The single verdict function the tools + loop consult. Fail-closed: an unknown persona, or a category granted
 * by neither the phase override nor the persona base, returns "deny". Phase override wins over the base row.
 */
export function can(persona: Persona, phase: Phase, category: DataCategory): Access {
  const m = MATRIX[persona];
  if (!m) return "deny";
  const phaseCell = m.phases[phase]?.[category];
  if (phaseCell) return phaseCell;
  return m.base[category] ?? "deny";
}

/** Convenience: true iff the datum may be RETURNED to the model (allow) — "reason" is NOT returnable (the
 *  server reasons over it but must not emit it). Tools use this to decide whether to include a raw value. */
export function mayReturn(persona: Persona, phase: Phase, category: DataCategory): boolean {
  return can(persona, phase, category) === "allow";
}

/** Convenience: true iff the server may REASON over the datum to shape an answer, even if it can't emit it
 *  (allow OR reason). "deny" excludes it entirely. */
export function mayReason(persona: Persona, phase: Phase, category: DataCategory): boolean {
  const a = can(persona, phase, category);
  return a === "allow" || a === "reason";
}
