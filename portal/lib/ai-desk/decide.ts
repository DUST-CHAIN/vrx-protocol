// AI Sales Director — decide (the design docs §9.5). The brain: DeskContext → DeskDecision.
// The only impure edge is the DeepSeek call (behind the ai-help-server transport seam, askWithSystem). The
// PARSER (parseDecision) + the BOUND enforcement (clampDecision) are PURE and unit-tested against stub replies,
// so the negotiation logic is provable without spending a token.
//
// Safety: the model's proposed action is advisory — parseDecision validates its SHAPE, clampDecision enforces
// the config (strip an action whose toggle is off; cap a concession to maxConcessionPct). act.ts re-gates again
// at fire time (belt and braces). A malformed / non-JSON model reply degrades to a plain {type:"none"} talk.

import { askWithSystem, type ChatMessage } from "../ai-help-server";
import { buildSystemPrompt, buildMessages } from "./prompt";
import { scrubOutbound } from "./pii-scrub";
import { runTool, toolScope, type ToolActionContext } from "./tool-loop";
import { parseButtonsRequest, composeButtons, type ComposeContext } from "./compose-buttons";
import { upsertSidecar, getSidecar } from "./deal-sidecar";
import { resolvePhase, coercePhase, type DealState } from "./phase-advance";
import { activeHoldForDeal } from "./unit-holds";
import { can, type Persona, type Phase } from "./permissions";
import type { DeskContext, AiDeskConfig, DeskDecision, DeskAction, ConcessionLever, TermsRow } from "./types";

/** Max retrieval rounds per turn (Option-B loop). A runaway query loop is the cost risk; this caps it.
 *: LOWERED 4→3 for LATENCY — each round is a full DeepSeek call (~10-20s), so 4 rounds was ~1-2 min on a
 *  tool-heavy turn (the live demo stall-fix exposed it). 3 still covers find → (detail|terms) → answer, which is
 *  the common path; a deeper chain just answers one tool earlier. Pair with the single-round guard below. */
const MAX_TOOL_ROUNDS = 3;

// the "promised to check but never searched" GUARD. DeepSeek often returns a terminal reply that either
// PROMISES to look something up ("let me pull the options") or CONFABULATES inventory ("three 1-beds at $78k")
// WITHOUT emitting the required query action — so the real data never loads and the buyer is left waiting /
// shown invented figures (the live bug). Prompt instructions alone did NOT stop it. This structural guard
// detects such a reply and FORCES one find_units query so the next round answers from the real catalog.

/** Does this reply look like it is promising to fetch, or claiming, inventory — the signal that a query was owed? */
export function replyImpliesInventory(reply: string): boolean {
  const t = reply.toLowerCase();
  const promises = /(let me|i'?ll|i will|give me a|one moment|hold on|pull (up|that|the)|check (what|the|our|availab)|look (up|into)|search|find out|see what)/.test(t);
  const claims = /\b(bed|bedroom|studio|unit|m²|m2|sq\s?m|floor\s*\d|\$\s?\d|options?|available|availability|view)\b/.test(t);
  return promises || claims;
}

/**  (D-): does this reply CLAIM a unit is held/reserved/secured? The signal that an open_unit was owed.
 *  The AI confabulates "unit-X is now held for you" WITHOUT calling open_unit (caught live — the sidecar showed
 *  the tool never ran). A terminal reply matching this, when NO open_unit returned "held" this turn, is a false
 *  claim; the guard forces a real open_unit so the next round answers from the TRUE outcome (and the hold→deposit
 *  bridge actually fires). Narrow on PAST/PRESENT hold assertions, NOT offers/questions ("shall I hold…?"). */
export function replyClaimsHold(reply: string): boolean {
  const t = reply.toLowerCase();
  // "is held / now held / firmly held / is reserved / is secured / hold is confirmed / reserved for you"
  const asserts = /\b(is (now )?(firmly )?held|now (firmly )?held|hold (is|'?s) (confirmed|in place|placed)|is reserved|reserved for you|is secured|secured for you|firm hold (is|'?s) confirmed|successfully (held|reserved)|the one you'?re holding|you'?re (currently )?holding|currently held|held for you)\b/.test(t);
  // Exclude pure OFFERS/QUESTIONS to hold (the AI asking permission is not a claim).
  const offerOnly = /\b(shall i|want me to|would you like me to|should i|ready for me to)\b[^.?!]*\b(hold|reserve|secure)\b/.test(t) && !asserts;
  return asserts && !offerOnly;
}

/**  (Step 2) — the NEGOTIATION stall: the model returns a terminal reply that PROMISES to look up the
 *  deposit / payment-plan / price terms ("let me pull the real terms before I answer on structure") but runs no
 * tool, so the customer's price/structure question goes unanswered (caught live — the guard only forced
 *  find_units, which is the wrong tool for a terms question). This detects that promise so the guard can force
 *  the RIGHT tool (building_terms). Narrow: a lookup verb AND a terms/price/plan/deposit noun, and NO concrete
 *  figure already present (if it already quoted numbers it answered — don't re-force). */
export function replyPromisesTerms(reply: string): boolean {
  const t = reply.toLowerCase();
  const lookup = /(let me|i'?ll|i will|before i|give me a|one moment|pull (up|the|that|real)|check (the|our)|look (up|into|at)|get the|confirm the)/.test(t);
  const termsNoun = /\b(deposit|payment plan|plan terms?|structure|instal?ment|on[- ]?transfer|on[- ]?key|terms|fees?|the best|discount|price)\b/.test(t);
  const hasFigure = /\$\s?\d|\b\d{1,2}\s?%/.test(t);
  return lookup && termsNoun && !hasFigure;
}

/** does this reply OFFER to reserve/hold/secure the unit (a "shall I / would you like me to reserve?"
 * question), without claiming it's already done? This is the READY-TO-ACT moment the walk showed the model
 *  landing on — run B asked "Shall I file it?" in WORDS instead of emitting a Reserve chip. When the model does
 *  this AND it emitted no buttons request, the server composes a Reserve chip itself (the nudge below), turning a
 *  dead-end question into a tappable commit (a tap can't be misheard, loop, or hit the wrong unit). The TWIN of
 * the file-on-yes belt, but for the pre-consent offer moment the belt (which needs the buyer's hard "yes")
 *  doesn't reach. Narrow: an OFFER/QUESTION verb ("shall I / want me to / would you like me to / ready to / I can")
 *  near a reserve/hold/secure/book verb — NOT a past-tense claim (replyClaimsHold owns those). */
export function replyOffersToReserve(reply: string): boolean {
  const t = reply.toLowerCase();
  if (replyClaimsHold(reply)) return false; // already asserts a hold — not an offer
  const offer = /\b(shall i|want me to|would you like me to|should i|ready for me to|i can|happy to|i'?ll|let me|do you want me to)\b[^.?!]*\b(reserve|hold|secure|book|place (a|the) hold|lock (it|this) in)\b/.test(t);
  return offer;
}

/**  (Step 1b) — the unit id the reply CLAIMS is held, if any. The guard forced a hold on the sidecar's
 *  focusUnitId, but a flip-flopping thread leaves focus stale (caught live: asked 421, guard held the old 321).
 *  So when the model asserts "unit-421 is held" we hold the unit it NAMED, not the stale focus. Returns the first
 *  `unit-<id>` token in the reply (lowercased, the catalog's canonical form), or null if the claim names none. */
export function claimedHeldUnit(reply: string): string | null {
  const m = reply.toLowerCase().match(/\bunit-[a-z0-9-]+/);
  return m ? m[0] : null;
}

/**  (Step 1c) — scrub a confabulated hold ASSERTION out of a reply the guard could NOT back with a real hold.
 *  Rather than ship "unit-X is held for you" when no open_unit succeeded, soften the assertion to an honest
 *  in-progress phrasing. Best-effort string surgery on the worst offenders; the prompt + the forced-hold round
 *  are the primary defence — this is the belt for the residual case (no focus unit, or the gate still denied). */
export function scrubHoldClaim(reply: string): string {
  return reply
    .replace(/\b(is (now )?(firmly )?held|now (firmly )?held|is reserved|reserved for you|is secured|secured for you|currently held|held for you)\b/gi, "is being arranged")
    .replace(/\bhold (is|'?s) (confirmed|in place|placed)\b/gi, "hold is being arranged")
    .replace(/\bthe one you'?re holding\b/gi, "the one we're arranging")
    .replace(/\byou'?re (currently )?holding\b/gi, "we're arranging for you");
}

/** should this turn FORCE the hold on the buyer's agreed plan (vs letting the model stall on terms)? The
 *  buyer composed a payment plan in the overlay and hit "Reserve with this offer", so the reserve route stashed it
 *  on the sidecar (agreedPlan) and seeded the focus unit — the plan IS the agreement, there's nothing to look up.
 *  Without this, the richer plan-carrying message made the model reply "let me get the real payment terms", which
 * trips the terms-stall guard and the hold never lands (caught live). Pure gate: an agreed plan + a focused
 *  unit + the desk permitting autonomous holds. Returns the unit to hold, or null (no force). Behaviour-level
 *  side-conditions (no tool ran this turn, no real hold yet, fire-once, rounds-to-spare) stay in the loop. Skips
 *  when the focused unit is ALREADY held (agreedPlan + focus persist on the sidecar after the hold lands, so a
 *  LATER unrelated stall mustn't re-force a hold on the unit that's already reserved — it's done). */
export function agreedHoldUnit(
  sidecar: { agreedPlan?: unknown; focusUnitId?: string; heldUnitId?: string } | null | undefined,
  canOpenUnit: boolean
): string | null {
  if (!canOpenUnit) return null;
  if (!sidecar?.agreedPlan) return null;
  if (!sidecar.focusUnitId) return null;
  if (sidecar.heldUnitId === sidecar.focusUnitId) return null; // already reserved — nothing to force
  return sidecar.focusUnitId;
}

/** did the BUYER just verbally consent to RESERVING / holding / filing the deposit on a unit, in plain chat?
 * (The twin of agreedHoldUnit for the NON-overlay path.) Found live: on a plain-chat flow with NO
 *  overlay-composed agreedPlan, the buyer said "yes, file it now" on a focused unit, the model FLAKED (emitted a
 * bare "unit-402" with no open_unit tool call), and because the forced-hold belt only fires on an agreedPlan,
 * nothing caught it → no hold → the bridge never ran → no deposit (the design docs). This detects
 *  a clear in-chat reserve/file consent on the BUYER's latest message so the forced-hold belt can fire the hold the
 *  same way. Narrow: an action verb (reserve/hold/secure/book/take/file/proceed) OR a bare affirmation (yes / go
 *  ahead / do it / please do) — but NOT a question ("shall I…?" / "can you…?" are the DESK's, not matched here since
 *  this reads the buyer turn). Keep it tight so we never force a hold the buyer didn't ask for. */
export function buyerConsentsToReserve(text: string): boolean {
  const t = (text || "").toLowerCase().trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return false; // a trailing question is not a consent
  // explicit reserve/hold/deposit intent
  const action = /\b(reserve|place (the |a )?hold|hold (it|the unit|this)|secure (it|the unit|this)|book (it|this)|take (my|the) deposit|file (it|the deposit|the reservation)|pay (the )?deposit|proceed with the (hold|reservation|deposit))\b/.test(t);
  // a bare affirmative to a just-asked "shall I file/hold it?" ("yes", "yes please", "go ahead", "do it", "file it now")
  const affirm = /^(yes|yep|yeah|sure|ok(ay)?|please do|go ahead|do it|let'?s do it|sounds good|that works|file it( now)?|go for it|confirm(ed)?)\b/.test(t);
  return action || affirm;
}

/** — the latest BUYER turn's text from the scrubbed thread (the consent signal for the forced-hold belt). */
function lastBuyerText(thread: { from: "buyer" | "developer" | "vrx"; text: string }[] | undefined): string {
  if (!thread?.length) return "";
  for (let i = thread.length - 1; i >= 0; i--) if (thread[i].from === "buyer") return thread[i].text || "";
  return "";
}

/** The customer's words this turn — to seed the forced search's budget/beds (best-effort; broad if nothing parses). */
export function forcedSearchArgs(thread: DeskContext["thread"]): Record<string, unknown> {
  const lastBuyer = [...thread].reverse().find((m) => m.from === "buyer")?.text ?? "";
  const all = thread.map((m) => m.text).join(" ").toLowerCase();
  const args: Record<string, unknown> = {};
  if (/studio/.test(all)) args.beds = "studio";
  else if (/\b2[\s-]?(bed|br)\b/.test(all)) args.beds = "2";
  else if (/\b1[\s-]?(bed|br)\b/.test(all) || /one[\s-]?bed/.test(all)) args.beds = "1";
  const budget = lastBuyer.match(/\$?\s?(\d[\d,]{3,})/);
  if (budget) { const n = Number(budget[1].replace(/,/g, "")); if (n >= 1000) args.maxBudgetUsd = n; }
  return args; // all-optional → a bare {} is a valid broad "what do you have" search
}

/** Map the context's counterparty (buyer|agent) to the matrix Persona. Absent ⇒ buyer (the default lane). The
 * agency persona exists in the matrix but no lane sets counterparty="agency" yet (column defined,
 *  lane unwired), so it can't arise here. */
function personaOf(ctx: DeskContext): Persona {
  return ctx.counterparty === "agent" ? "agent" : "buyer";
}

/** The conversation phase, defaulting to the opening "browse" when the context doesn't set one. */
function phaseOf(ctx: DeskContext): Phase {
  return ctx.phase ?? "browse";
}

/** Pull the first JSON object out of a model reply (handles ```json fences / leading prose defensively). */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const KNOWN_REVEAL_FIELDS = new Set(["name", "legalName", "nationality", "phone", "email", "passportNo", "idCardNo", "address"]);
//  (slice 4): only the kinds leversForBuilding actually produces. rental_guarantee / payment_plan / alt_unit
// were removed — a model-emitted concession built on an INVENTED rental guarantee is now rejected here (the
// parser drops the whole concession as "unknown lever kind"). A REAL guarantee comes via building_terms, not a lever.
const LEVER_KINDS = new Set(["furniture_pack", "price_discount"]);

function parseAction(a: unknown): DeskAction {
  if (!a || typeof a !== "object") return { type: "none" };
  const o = a as Record<string, unknown>;
  switch (o.type) {
    case "reveal_request": {
      const fields = Array.isArray(o.fields)
        ? o.fields.filter((f): f is string => typeof f === "string" && KNOWN_REVEAL_FIELDS.has(f))
        : [];
      return fields.length ? { type: "reveal_request", fields: [...new Set(fields)] } : { type: "none" };
    }
    case "concession": {
      const levers: ConcessionLever[] = Array.isArray(o.levers)
        ? o.levers
            .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
            .filter((l) => typeof l.kind === "string" && LEVER_KINDS.has(l.kind as string))
            .map((l) => ({
              kind: l.kind as ConcessionLever["kind"],
              label: typeof l.label === "string" ? l.label.slice(0, 200) : String(l.kind),
              valueUsd: typeof l.valueUsd === "number" && isFinite(l.valueUsd) ? Math.max(0, l.valueUsd) : undefined,
            }))
        : [];
      if (!levers.length) return { type: "none" };
      const totalValueUsd = typeof o.totalValueUsd === "number" && isFinite(o.totalValueUsd)
        ? Math.max(0, o.totalValueUsd)
        : levers.reduce((s, l) => s + (l.valueUsd ?? 0), 0);
      return { type: "concession", levers, totalValueUsd };
    }
    case "quote": {
      const lines = Array.isArray(o.lines)
        ? o.lines
            .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
            .map((l) => ({
              label: typeof l.label === "string" ? l.label.slice(0, 28) : "", // short so the quote columns align
              amountUsd: typeof l.amountUsd === "number" && isFinite(l.amountUsd) ? Math.round(l.amountUsd) : NaN,
            }))
            .filter((l) => l.label && isFinite(l.amountUsd))
        : [];
      if (lines.length < 2) return { type: "none" }; // a quote needs at least a price + one line
      const netUsd = typeof o.netUsd === "number" && isFinite(o.netUsd)
        ? Math.round(o.netUsd)
        : lines.reduce((s, l) => s + l.amountUsd, 0);
      return { type: "quote", lines, netUsd };
    }
    case "terms": {
      // a payment-TERMS table as DATA (deposit/on-contract/on-handover %, fees). Each row is label|value,
      // value a free-form formatted string. Validated loosely (both strings, trimmed, length-capped); drop empties.
      const rows: TermsRow[] = Array.isArray(o.rows)
        ? o.rows
            .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
            .map((r) => ({
              label: typeof r.label === "string" ? r.label.trim().slice(0, 28) : "", // short so columns align
              value: typeof r.value === "string" ? r.value.trim().slice(0, 80) : "",
            }))
            .filter((r) => r.label && r.value)
        : [];
      if (rows.length < 1) return { type: "none" }; // a terms table needs at least one real row
      return { type: "terms", rows };
    }
    case "buttons":
      // a model-emitted BUTTONS request. parseAction stays PURE/sync, but the real ActionButton[] needs
      // async catalog + deal-state reads (labels, live price, enabled/greyed), so it's composed in the impure
      // decide from the request parseDecision captured on `buttonsRequest`. Here we degrade to none; decide
      // overwrites `action` with the resolved {type:"buttons"} (or leaves none if nothing composable survives).
      return { type: "none" };
    case "call_off":
      return { type: "call_off" };
    case "block":
      return { type: "block" };
    case "query": {
      // a retrieval request. Validated loosely (the tool-loop dispatcher re-validates the tool name +
      // args); an empty/non-string tool degrades to none so a malformed query can't spin the loop.
      const tool = typeof o.tool === "string" ? o.tool : "";
      if (!tool) return { type: "none" };
      const args = o.args && typeof o.args === "object" ? (o.args as Record<string, unknown>) : {};
      return { type: "query", tool, args };
    }
    default:
      return { type: "none" };
  }
}

/** PURE: strip markdown + collapse to a clean, short, chat-safe plain-text reply (defense-in-depth — the prompt
 *  asks for plain text, but models slip markdown in ~10% of the time). Removes bold/italic/heading/list/code/link
 *  markup, collapses whitespace, and hard-caps the length so a runaway reply can't flood the bubble. */
export function plainText(s: string): string {
  let t = s;
  //  (D-): STRIP leaked native tool-call markup. DeepSeek is TRAINED to call tools in its own token
  // syntax (`<｜｜DSML｜｜ invoke name="record_deposit">…`, special-pipe `｜` U+FF5C, sometimes plain-pipe `<|…|>`),
  // but our protocol is a JSON `action` field (parseAction) — so when the model slips into its native format it
  // lands in the REPLY text and dumps raw `<｜｜DSML｜｜…>` into the chat bubble (caught live on the deposit step).
  // Remove any such block defensively (same spirit as the markdown strip below): a leaked tool call must NEVER be
  // shown to the buyer. The action it meant to take still goes through the JSON path on the retry / via the UI
  // deposit button; here we only guarantee the visible reply is clean. Matches both the special-pipe and ASCII forms.
  t = t.replace(/<[｜|]+\s*[\s\S]*?[｜|]+\s*>/g, " "); // <｜｜DSML｜｜ …> / <| … |> native tool-call tokens
  t = t.replace(/<\/?｜[\s\S]*?｜?>/g, " "); // any stray special-pipe tag the first pass didn't pair
  t = t.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "")); // unwrap code fences, keep content
  t = t.replace(/`([^`]*)`/g, "$1"); // inline code
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"); // links/images → their text
  t = t.replace(/^#{1,6}\s+/gm, ""); // headings
  t = t.replace(/^\s*>[ \t]?/gm, ""); // blockquotes
  t = t.replace(/^(\s*)[-*+]\s+/gm, "$1• "); // markdown list bullets → a plain dot (keep leading indent)
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2"); // bold
  t = t.replace(/(\*|_)(.*?)\1/g, "$2"); // italic
  // NOTE: deliberately DO NOT strip a dashed/underscored run or collapse multi-space runs — the chat renders
  // pre-wrap, so a dashed total line + column-aligning spaces are WANTED for a clean price quote.
  // Only normalise markdown HRs made of asterisks (never used in a quote) + trim trailing per-line whitespace.
  t = t.replace(/^\s*\*{3,}\s*$/gm, ""); // asterisk HR (markdown) — a dash HR in a quote is intentional, kept
  t = t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > 700 ? t.slice(0, 700).replace(/\s+\S*$/, "") + "…" : t; // hard cap, don't cut mid-word
}

/** PURE: parse a raw model reply into a DeskDecision. A non-JSON / malformed reply becomes a plain talk turn
 *  (the raw text as the reply, action none) so a model hiccup never silently drops the buyer's conversation. */
export function parseDecision(raw: string): DeskDecision {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") {
    return { reply: raw.trim().slice(0, 2000) || "Thanks — let me get back to you on that.", action: { type: "none" } };
  }
  const o = obj as Record<string, unknown>;
  const reply = typeof o.reply === "string" && o.reply.trim() ? o.reply.trim().slice(0, 2000) : "Thanks for your message.";
  // the optional running summary (the AI's one-line deal distillation). Captured here (pure); the IMPURE
  // decide writes it to the sidecar. Capped short — it's a status line, not a transcript. Absent/blank ⇒ undefined.
  const summary = typeof o.summary === "string" && o.summary.trim() ? o.summary.trim().slice(0, 280) : undefined;
  // the optional phase the model declares it's in (browse|qualify|negotiate|book|deposit|aftercare). ADVISORY:
  // resolvePhase in decide clamps it to [server-floor, one-notch-above-floor] so the model can move the talk
  // forward but can't self-unlock a hold/deposit without the real deal state. Invalid ⇒ undefined (ignored).
  const phase = coercePhase(o.phase);
  // capture a model-emitted BUTTONS request (the lightweight {kinds, unit} ask). parseAction degrades
  // `type:"buttons"` to none (it can't compose the real buttons synchronously); decide resolves this request to
  // the final {type:"buttons", buttons:[…]} action via compose-buttons. Absent on a non-buttons turn.
  const buttonsRequest =
    o.action && typeof o.action === "object" && (o.action as Record<string, unknown>).type === "buttons"
      ? parseButtonsRequest(o.action) ?? undefined
      : undefined;
  return { reply, action: parseAction(o.action), summary, phase, buttonsRequest };
}

/**
 * PURE: enforce the live config over a parsed decision (the second gate; act.ts is the third at fire time).
 *   - strip any action whose toggle is OFF → none;
 *   - cap a concession to maxConcessionPct of `priceUsd` (drop it to none if even the smallest lever exceeds —
 *     the model was told the bound, but we never trust it);
 *   - scrub the reply text outbound unless the buyer consented to share.
 */
export function clampDecision(
  d: DeskDecision,
  cfg: AiDeskConfig,
  priceUsd: number | undefined,
  consented: boolean
): DeskDecision {
  let action = d.action;
  const off =
    (action.type === "concession" && !cfg.canConcede) ||
    (action.type === "quote" && !cfg.canConcede) || // a quote presents a concession → same toggle
    (action.type === "reveal_request" && !cfg.canRequestReveal) ||
    (action.type === "call_off" && !cfg.canCallOff) ||
    (action.type === "block" && !cfg.canBlock) ||
    action.type === "query"; // a query is loop-internal; it must NEVER survive to a returned decision
  if (off) action = { type: "none" };

  // AUDIT VRX-0010: the concession/quote cap is a FRACTION of priceUsd, so with priceUsd UNKNOWN the
  // cap can't be computed. The old code skipped the check entirely in that case → the numeric maxConcessionPct
  // guardrail was INERT on the prod autoresponder lanes (which call decide with priceUsd=undefined), leaving the
  // AI's giveaway size unbounded. Now: a known price caps against the bound; an UNKNOWN price FAILS CLOSED
  // (drop concession/quote to talk-only). A human can still grant more manually; the AI can't self-authorise an
  // unbounded giveaway it can't size. The RIGHT fix is also to resolve priceUsd before decide on both lanes
  // (done in act/the lanes) so the cap evaluates against the real price — this is the belt behind that.
  const priceKnown = typeof priceUsd === "number" && priceUsd > 0;
  if (action.type === "concession") {
    if (!priceKnown) {
      action = { type: "none" }; // can't size the cap → fail closed
    } else if (action.totalValueUsd > priceUsd * cfg.maxConcessionPct) {
      action = { type: "none" }; // over the bound → talk-only (a human can still grant more manually)
    }
  }

  if (action.type === "quote") {
    if (!priceKnown) {
      action = { type: "none" }; // can't size the cap → fail closed
    } else {
      // Total giveaway = the sum of the negative (deduction) lines. Must not exceed the bound.
      const giveaway = action.lines.filter((l) => l.amountUsd < 0).reduce((s, l) => s - l.amountUsd, 0);
      if (giveaway > priceUsd * cfg.maxConcessionPct) action = { type: "none" };
    }
  }

  const reply = plainText(scrubOutbound(d.reply, consented));
  //  BUG FIX (drift): carry `buttonsRequest` THROUGH the clamp. The model-emitted buttons ask is
  // captured on the decision in parseDecision, but the clamp used to drop it here (returned only reply/action/
  // summary/phase) — so EVERY chip the model emitted was silently eaten before act.ts could compose it. This was a
  // prime cause of the walk seeing "zero chips". A buttons action's REAL composition happens in applyDecision
  // (compose-buttons, server-side) off this field, so it must survive clamp. (The buttons action itself is degraded
  // to `none` by parseAction — correct — but the REQUEST must persist so act.ts can resolve it.)
  return { reply, action, summary: d.summary, phase: d.phase, ...(d.buttonsRequest ? { buttonsRequest: d.buttonsRequest } : {}) };
}

export type DecideResult =
  | { ok: true; decision: DeskDecision; tokens: number }
  | { ok: false; error: "no_key" | "upstream" };

/** the REAL deal-state signals the phase server-floor is computed from (the model can't fake these). Read
 *  from the stores we already keep: the sidecar (heldUnit / focusedUnit) + the hold store (authoritative live hold).
 *  depositRecorded isn't tracked as a sidecar flag yet, so a live hold is the top floor the signals raise today
 *  (a recorded deposit still advances via the model's declaration, bounded by the one-notch cap). Fail-soft: any
 *  read error ⇒ empty state (floor "browse") so a store hiccup never crashes the turn. */
async function dealStateFor(dealId: string): Promise<{ state: DealState; storedPhase?: Phase }> {
  try {
    const [sidecar, hold] = await Promise.all([getSidecar(dealId), activeHoldForDeal(dealId)]);
    const heldUnit = !!(hold && !hold.released) || !!sidecar?.heldUnitId;
    const focusedUnit = !!sidecar?.focusUnitId;
    return { state: { heldUnit, focusedUnit }, storedPhase: sidecar?.phase };
  } catch {
    return { state: {} };
  }
}

/** the phase for THIS turn's tool scope: the HYBRID resolve from (stored phase + real deal state), WITHOUT
 *  the model's declared phase (that only takes effect next turn — a model can't unlock a tool in the same breath
 *  it declares the phase; it advances the phase this turn, uses the newly-unlocked tool next turn). Pure of the
 *  model; just the provable floor + monotonic stored progress. */
async function resolveTurnPhase(dealId: string, ctxPhase: Phase, allowAutoBook: boolean): Promise<Phase> {
  const { state, storedPhase } = await dealStateFor(dealId);
  return resolvePhase({ storedPhase: storedPhase ?? ctxPhase, state, allowAutoBook });
}

/** Write the AI's running SUMMARY + the resolved/advanced PHASE to the deal sidecar (summary writer;
 *  phase persistence). The phase persisted is the model-ADVANCED resolve (it may nudge the talk one notch forward
 *  from this turn's scope phase), so NEXT turn reads it back and the newly-reached phase unlocks its tools. The
 *  sidecar is keyed by the conversation id. Writes when there's a summary OR a phase change to record (don't
 *  create an empty sidecar for a pure browse turn with nothing new). Fail-SOFT: a sidecar IO error must never
 *  break the reply the buyer is waiting on. */
async function persistTurn(ctx: DeskContext, decision: DeskDecision, scopePhase: Phase, allowAutoBook: boolean): Promise<void> {
  try {
    const { state, storedPhase } = await dealStateFor(ctx.conversationId);
    // The model MAY advance the phase one notch past the scope phase (bounded by the server floor+cap). Resolve
    // WITH the model's declared phase this time — that's what we persist for next turn. allowAutoBook lets
    // the persisted phase reach "book" when the desk permits autonomous holds, so next turn the hold tool unlocks.
    const advanced = resolvePhase({ storedPhase: storedPhase ?? scopePhase, modelPhase: decision.phase, state, allowAutoBook });
    const phaseChanged = advanced !== storedPhase;
    if (!decision.summary && !phaseChanged) return; // nothing new to record
    const counterparty: "buyer" | "agent" = ctx.counterparty === "agent" ? "agent" : "buyer";
    await upsertSidecar(ctx.conversationId, ctx.building.id, counterparty, {
      ...(decision.summary ? { summary: decision.summary } : {}),
      phase: advanced,
    });
  } catch {
    // swallow — the running summary + phase are best-effort; the conversation reply is the real product.
  }
}

/**
 * The impure brain: build the prompt from the (already PII-safe) context, call DeepSeek via the shared
 * transport, parse + clamp. On any upstream fault returns ok:false so the caller falls back to the scripted
 * reply (same fail-soft posture as ai-help-server). `priceUsd`/`consented` feed the clamp.
 *
 * — the Option-B RETRIEVAL LOOP. The model may answer with a {type:"query", tool, args} action instead of
 * a final reply. When it does, we run the matrix-gated query tool over the REAL catalog (lib/ai-desk/tool-loop),
 * append the model's query turn + the tool RESULT turn to the conversation, and call again — up to
 * MAX_TOOL_ROUNDS. This is how real inventory/terms reach the model WITHOUT ever sending it the raw catalog
 * (the model sees "71 match, best 3: …", never the table). Tokens are summed across rounds; a query that
 * survives to the final round is treated as "no more queries" (clamped to none) so the turn always resolves to
 * a real reply. Any upstream fault mid-loop falls back like the single-shot path.
 */
export async function decide(
  ctx: DeskContext,
  cfg: AiDeskConfig,
  priceUsd: number | undefined,
  consented: boolean,
  signal?: AbortSignal
): Promise<DecideResult> {
  const system = buildSystemPrompt(ctx, cfg);
  const messages: ChatMessage[] = buildMessages(ctx, cfg);
  // resolve the phase for this turn from the stored sidecar phase + real deal state (the HYBRID floor; NOT
  // the model's same-turn declaration — that only takes effect next turn). Before the scope used the context's
  // hard-coded "browse", which left every phase-gated action tool (reveal_unit / open_unit / record_deposit) dark.
  const turnPhase = await resolveTurnPhase(ctx.conversationId, phaseOf(ctx), cfg.canOpenUnit);
  const scope = toolScope(personaOf(ctx), turnPhase, ctx.building.id);
  //  (slice 6) — the action-tool context (open_unit / record_deposit). The dealId keys the hold + sidecar;
  // canOpenUnit is the live config authority; the buyer account is left to the context (the desk-side record is
  // what the AI files — the buyer-scoped confirm surface isn't part of the AI's turn).
  //  (slice 9) — signingPosture carries the vault config to the seam. No `authorization` is threaded from an
  // LLM turn (a human supplies it out-of-band via the TAN/TG channel, not yet wired) — so under posture "vault"
  // an autonomous hold correctly resolves to "needs_authorization" until that channel lands.
  const actionCtx: ToolActionContext = { dealId: ctx.conversationId, canOpenUnit: cfg.canOpenUnit, signingPosture: cfg.signingPosture };

  let tokensTotal = 0;
  let toolRan = false; // has ANY tool run this turn? gates the one-shot forced-search guard
  let forcedSearch = false; // have we already force-injected a find_units? (fire at most once, no loop)
  let heldThisTurn = false; // did an open_unit actually return "held" this turn? (gates the forced-hold guard)
  let forcedHold = false; // have we already force-injected an open_unit? (fire at most once, no loop)
  let forcedTerms = false; // have we already force-injected a building_terms? (terms-stall guard, once)
  let forcedAgreedHold = false; // have we already force-injected the agreed-plan hold? (fire at most once)
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await askWithSystem(system, messages, { signal, temperature: 0.6, maxTokens: 600 });
    if (!res.ok) return res; // upstream fault → caller falls back to scripted
    tokensTotal += res.tokens;

    const parsed = parseDecision(res.answer);

    // A query action drives another round — unless we're out of rounds (then fall through: clamp will strip the
    // dangling query to none and we return the model's reply text as-is).
    if (parsed.action.type === "query" && round < MAX_TOOL_ROUNDS - 1) {
      const { tool, args } = parsed.action;
      const result = await runTool(scope, tool, args ?? {}, actionCtx);
      toolRan = true;
      // track a REAL hold — runTool returns "Held unit <id> …" only when open_unit's outcome was "held".
      // Used by the forced-hold guard below so a confabulated "it's reserved" can't pass without a true hold.
      if (tool === "open_unit" && /^Held unit\b/.test(result)) heldThisTurn = true;
      // Append the model's own query turn (assistant) then the tool RESULT as a user turn the model reads next.
      messages.push({ role: "assistant", content: res.answer });
      messages.push({ role: "user", content: `TOOL RESULT (${tool}):\n${result}` });
      continue;
    }

    //  GUARD — the AGREED-PLAN reserve. When the buyer composed a payment plan in the overlay and hit "Reserve
    // with this offer", the reserve route stashes it on the sidecar (agreedPlan) and seeds the focus unit. There is
    // NOTHING left to look up — the plan IS the agreement. But the richer plan-carrying message makes the model
    // over-cautious: it replies "let me get the real payment terms for unit-X" → trips the terms-stall guard below →
    // answers about terms → never places the hold (caught live: `agreedPlan=YES dep$270 inst6` reached the
    // sidecar but the AI looped on terms and the hold never landed, so pay→S&P couldn't be driven e2e). So when the
    // deal carries an agreed plan + a focused unit and the desk permits autonomous holds, force the hold DIRECTLY
    // (no terms detour) — same book-scope path the confabulation guard uses. Fires at most once, rounds to spare.
    // do NOT gate this on `!toolRan`. The live harness (buy-flow drive) proved the bug: a structurally
    // off-standard plan makes the model legitimately call `building_terms` FIRST (toolRan=true) to quote the real
    // structure, then NEGOTIATE a counter instead of holding — so the agreed-plan hold never landed (the desk said
    // "on contract it's 25% + 30%, want me to hold on the closest structure?"). But the buyer ALREADY composed +
    // reserved a plan; the plan IS the agreement, nothing to look up. So fire on ANY terminal round with an agreed
    // plan + focus + no hold yet, lookup-or-not. `forcedAgreedHold` (fire-once) + `heldThisTurn` keep it loop-safe.
    if (
      !forcedAgreedHold &&
      !heldThisTurn &&
      cfg.canOpenUnit &&
      round < MAX_TOOL_ROUNDS - 1 &&
      can(personaOf(ctx), "book", "open_unit") === "allow"
    ) {
      const sc = await getSidecar(ctx.conversationId);
      const holdUnit = agreedHoldUnit(sc, cfg.canOpenUnit);
      if (holdUnit) {
        forcedAgreedHold = true;
        toolRan = true;
        // Run at BOOK phase so open_unit's own matrix gate passes regardless of this turn's lower scope phase.
        const bookScope = toolScope(personaOf(ctx), "book", ctx.building.id);
        const result = await runTool(bookScope, "open_unit", { unitId: holdUnit }, actionCtx);
        if (/^Held unit\b/.test(result)) heldThisTurn = true;
        messages.push({ role: "assistant", content: res.answer });
        messages.push({
          role: "user",
          content:
            `TOOL RESULT (open_unit ${holdUnit}):\n${result}\n\n(The customer already AGREED a payment plan for ` +
            `this unit — do NOT ask again for terms or offer to "check". Answer from THIS result only: if it ` +
            `confirmed the hold, tell them it's secured against their agreed plan and point them to pay the deposit; ` +
            `if it did not, explain honestly why and what's next.)`,
        });
        continue;
      }
    }

    //  GUARD (Step 2) — the NEGOTIATION stall. The model promises to look up deposit/plan/price TERMS but ran
    // no tool, so the customer's "can you do $50k / 5% deposit?" went unanswered (caught live). The guard below
    // would force find_units — the WRONG tool for a terms question. So force building_terms FIRST (on the focused
    // unit if any) and let the next round answer price/structure from the REAL terms. Once, rounds to spare, no loop.
    if (
      !toolRan &&
      !forcedTerms &&
      round < MAX_TOOL_ROUNDS - 1 &&
      can(personaOf(ctx), turnPhase, "building_terms") === "allow" &&
      replyPromisesTerms(parsed.reply)
    ) {
      forcedTerms = true;
      toolRan = true;
      const focusUnit = (await getSidecar(ctx.conversationId))?.focusUnitId;
      const result = await runTool(scope, "building_terms", focusUnit ? { unitId: focusUnit } : {}, actionCtx);
      messages.push({ role: "assistant", content: res.answer });
      messages.push({
        role: "user",
        content:
          `TOOL RESULT (building_terms):\n${result}\n\n(Answer the customer's price/structure question from THESE ` +
          `real terms. State concrete figures or ranges; do NOT promise to "check" again. If a request is outside ` +
          `the allowed range, say so plainly and give the closest you CAN do.)`,
      });
      continue;
    }

    //  GUARD — the model returned a TERMINAL reply (no query) but it PROMISED/CLAIMED inventory and NO tool
    // has run this turn: it either stalled ("let me check") or confabulated ("three 1-beds at $78k"). Force ONE
    // find_units over the real catalog and let the next round answer from the TOOL RESULT. Fires at most once
    // (forcedSearch) and only with rounds to spare, so it can never loop. `inventory` is allow for every lane.
    if (
      !toolRan &&
      !forcedSearch &&
      round < MAX_TOOL_ROUNDS - 1 &&
      can(personaOf(ctx), turnPhase, "inventory") === "allow" &&
      replyImpliesInventory(parsed.reply)
    ) {
      forcedSearch = true;
      toolRan = true;
      const args = forcedSearchArgs(ctx.thread);
      const result = await runTool(scope, "find_units", args, actionCtx);
      // Feed the model its own (incomplete) turn + the REAL result + a nudge to answer from it, not from memory.
      messages.push({ role: "assistant", content: res.answer });
      messages.push({
        role: "user",
        content:
          `TOOL RESULT (find_units):\n${result}\n\n(Use ONLY these real units in your answer. Do not state any ` +
          `unit or price that is not in this result. If the customer wants to see one, use reveal_unit.)`,
      });
      continue;
    }

    //  GUARD (D-) — the model returned a TERMINAL reply CLAIMING a hold ("unit-X is now held for you")
    // but NO open_unit returned "held" this turn: it confabulated the hold (caught live — the sidecar showed the
    // tool never ran, so the hold→deposit bridge never fired and the buyer had nothing to pay against). Force ONE
    // real open_unit and let the next round answer from the TRUE outcome.
    //  fixes two holes the live drive exposed:
    //   (a) PHASE HOLE — the gate used `turnPhase`, but a confabulated hold-claim can land at ANY phase (browse/
    //       negotiate) so the guard was SKIPPED and the lie shipped. A hold CLAIM is book-intent, so when the desk
    //       permits autonomous holds (cfg.canOpenUnit) we evaluate + run the forced hold at the "book" phase (the
    //       same allowAutoBook intent the fast-path uses), not the stale turnPhase.
    //   (b) WRONG-UNIT HOLE — it held the sidecar's focusUnitId, which a flip-flopping thread leaves STALE (asked
    //       421, guard held old 321). Prefer the unit the reply NAMED (claimedHeldUnit); fall back to focus.
    if (
      !forcedHold &&
      !heldThisTurn &&
      cfg.canOpenUnit &&
      round < MAX_TOOL_ROUNDS - 1 &&
      can(personaOf(ctx), "book", "open_unit") === "allow" &&
      replyClaimsHold(parsed.reply)
    ) {
      // The unit the model NAMED in its claim wins over the (possibly stale) sidecar focus.
      const holdUnit = claimedHeldUnit(parsed.reply) ?? (await getSidecar(ctx.conversationId))?.focusUnitId;
      if (holdUnit) {
        forcedHold = true;
        toolRan = true;
        // Run the hold at BOOK phase so open_unit's own matrix gate (open-unit.ts) passes — turnPhase may be lower.
        const bookScope = toolScope(personaOf(ctx), "book", ctx.building.id);
        const result = await runTool(bookScope, "open_unit", { unitId: holdUnit }, actionCtx);
        if (/^Held unit\b/.test(result)) heldThisTurn = true;
        messages.push({ role: "assistant", content: res.answer });
        messages.push({
          role: "user",
          content:
            `TOOL RESULT (open_unit ${holdUnit}):\n${result}\n\n(Answer from THIS result only. If it did not ` +
            `confirm a hold, do NOT tell the customer the unit is held/reserved — say you're securing it and will ` +
            `confirm, or explain honestly why it couldn't be held.)`,
        });
        continue;
      }
    }

    // the AGREED-PLAN hold, as a TERMINAL-EXIT fallback. The in-loop guard above needs round headroom
    // (round < MAX-1), so if the model spends ALL its rounds on terms lookups and THEN terminates (e.g. "shall I
    // place the hold on the building's real plan?"), the guard never gets its shot and the hold is missed (caught
    // live — the LLM is non-deterministic about how many lookups it does). The plan IS the agreement, so land
    // it here regardless of rounds spent, before we return. Fire-once (forcedAgreedHold) + only when nothing is held.
    if (!forcedAgreedHold && !heldThisTurn && cfg.canOpenUnit && can(personaOf(ctx), "book", "open_unit") === "allow") {
      const holdUnit = agreedHoldUnit(await getSidecar(ctx.conversationId), cfg.canOpenUnit);
      if (holdUnit) {
        forcedAgreedHold = true;
        const bookScope = toolScope(personaOf(ctx), "book", ctx.building.id);
        const result = await runTool(bookScope, "open_unit", { unitId: holdUnit }, actionCtx);
        if (/^Held unit\b/.test(result)) {
          heldThisTurn = true;
          // Replace the model's "shall I?" ask with a confirmation that matches the hold we just placed.
          parsed.reply =
            `Done — ${holdUnit} is held for you against your agreed plan. The next step is to pay the deposit to ` +
            `keep it secured.`;
        }
      }
    }

    // the VERBAL-CONSENT hold, as a TERMINAL-EXIT fallback (the twin of the agreed-plan belt above, for the
    // PLAIN-CHAT path). NOTE: autonomous buttons (compose-buttons.ts) now give the model a Reserve CHIP as the
    // clean path — a tapped chip can't flake/loop/hit-the-wrong-unit, so it's the primary way a hold lands. This
    // belt STAYS as the fallback for the plain-chat "yes" (no chip emitted / buyer types instead of tapping), per
    // the no-transition-gap rule — retire it only AFTER the live walk proves the model emits the chip
    // reliably (the design docs). Until then, belt + buttons coexist (both are idempotent on the same hold).
    // Found live: in a chat flow with NO overlay-composed agreedPlan, the buyer said "yes,
    // file it now" on a focused unit, the model FLAKED (bare "unit-402", no open_unit call), and the agreed-plan belt
    // couldn't fire (no agreedPlan) → no hold → no bridged deposit. So when the buyer's latest turn clearly consents
    // to reserving a focused/named unit and nothing was held this turn, force the hold here. Fire-once (forcedAgreedHold
    // doubles as the hold-forced flag), only when nothing is held. The deposit rides the hold via the existing bridge
    // (open_unit → bridgeHoldToDirectDeposit records the deductible deposit). the design docs.
    if (!forcedAgreedHold && !heldThisTurn && cfg.canOpenUnit && can(personaOf(ctx), "book", "open_unit") === "allow") {
      const buyerSaidYes = buyerConsentsToReserve(lastBuyerText(ctx.thread));
      if (buyerSaidYes) {
        const sc = await getSidecar(ctx.conversationId);
        // Prefer a unit the buyer NAMED this turn (flip-flop safety, like claimedHeldUnit); else the focused unit.
        const namedUnit = lastBuyerText(ctx.thread).toLowerCase().match(/\bunit-[a-z0-9-]+/)?.[0];
        const holdUnit = namedUnit ?? sc?.focusUnitId;
        // Don't re-force a hold on a unit already held for this deal (idempotent, like agreedHoldUnit's heldUnitId skip).
        if (holdUnit && sc?.heldUnitId !== holdUnit) {
          forcedAgreedHold = true;
          const bookScope = toolScope(personaOf(ctx), "book", ctx.building.id);
          const result = await runTool(bookScope, "open_unit", { unitId: holdUnit }, actionCtx);
          if (/^Held unit\b/.test(result)) {
            heldThisTurn = true;
            parsed.reply =
              `Done — ${holdUnit} is held for you. The deposit is recorded; the next step is to pay it to keep the ` +
              `unit secured.`;
          }
        }
      }
    }

    // the CHIP-EMISSION NUDGE (the twin of the file-on-yes belt, but for the pre-consent OFFER moment).
    // The walk showed the model lands on "Shall I reserve it?" in WORDS at the ready-to-act point instead of
    // emitting a Reserve chip. When (a) the model emitted NO buttons request this turn, (b) nothing was held/forced
    // (a held unit needs no Reserve chip — the belt already ran), (c) the desk's reply OFFERS to reserve/hold a
    // unit, and (d) there's a focused unit to anchor it to — synthesise a lightweight {reserve, view_terms} request
    // so act.ts composes a REAL tappable chip. This turns the dead-end "shall I?" question into a tap (which can't
    // be misheard, loop, or hit the wrong unit). The chip is a NICE next step, not a commit: the server re-gates at
    // tap time (/api/desk-action) exactly like a model-emitted chip, so this is purely additive + safe. We DON'T
    // fire the hold here (that's the belt's job on the buyer's hard "yes"); we just offer the chip the model missed.
    if (!parsed.buttonsRequest && !heldThisTurn && cfg.canOpenUnit && replyOffersToReserve(parsed.reply)) {
      const sc = await getSidecar(ctx.conversationId);
      // Prefer a unit named in the reply (what the desk is offering to reserve), else the focused unit.
      const offeredUnit = parsed.reply.toLowerCase().match(/\bunit-[a-z0-9-]+/)?.[0] ?? sc?.focusUnitId;
      if (offeredUnit && sc?.heldUnitId !== offeredUnit) {
        parsed.buttonsRequest = { kinds: ["reserve", "view_terms"], unit: offeredUnit };
      }
    }

    const decision = clampDecision(parsed, cfg, priceUsd, consented);
    //  (Step 1c) — BELT: if the reply still ASSERTS a hold but no open_unit succeeded this turn (the guard
    // couldn't place one — no unit named/focused, or the gate denied), don't ship the confabulation. Soften the
    // assertion to honest in-progress phrasing so the UI never claims a hold the system doesn't have.
    if (!heldThisTurn && replyClaimsHold(decision.reply)) {
      decision.reply = scrubHoldClaim(decision.reply);
    }
    await persistTurn(ctx, decision, turnPhase, cfg.canOpenUnit);
    return { ok: true, decision, tokens: tokensTotal };
  }

  // Exhausted the rounds while still querying — resolve with a plain talk turn (never leave the buyer hanging).
  return {
    ok: true,
    decision: { reply: "Let me pull that together for you — one moment.", action: { type: "none" } },
    tokens: tokensTotal,
  };
}
