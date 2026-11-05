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
import { upsertSidecar, getSidecar } from "./deal-sidecar";
import { resolvePhase, coercePhase, type DealState } from "./phase-advance";
import { activeHoldForDeal } from "./unit-holds";
import type { Persona, Phase } from "./permissions";
import type { DeskContext, AiDeskConfig, DeskDecision, DeskAction, ConcessionLever } from "./types";

/** Max retrieval rounds per turn (Option-B loop). A runaway query loop is the new cost risk; this caps
 *  it. 4 is generous for a real deal turn (find → detail → terms → availability) and still bounded. */
const MAX_TOOL_ROUNDS = 4;

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
  return { reply, action: parseAction(o.action), summary, phase };
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

  if (action.type === "concession" && priceUsd && priceUsd > 0) {
    const cap = priceUsd * cfg.maxConcessionPct;
    if (action.totalValueUsd > cap) {
      // Over the bound — the AI must not exceed it. Drop to talk-only (a human can still grant more manually).
      action = { type: "none" };
    }
  }

  if (action.type === "quote" && priceUsd && priceUsd > 0) {
    // Total giveaway = the sum of the negative (deduction) lines. Must not exceed the bound.
    const giveaway = action.lines.filter((l) => l.amountUsd < 0).reduce((s, l) => s - l.amountUsd, 0);
    if (giveaway > priceUsd * cfg.maxConcessionPct) action = { type: "none" };
  }

  const reply = plainText(scrubOutbound(d.reply, consented));
  return { reply, action, summary: d.summary, phase: d.phase }; // carry summary + phase through (both internal, not posted)
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
async function resolveTurnPhase(dealId: string, ctxPhase: Phase): Promise<Phase> {
  const { state, storedPhase } = await dealStateFor(dealId);
  return resolvePhase({ storedPhase: storedPhase ?? ctxPhase, state });
}

/** Write the AI's running SUMMARY + the resolved/advanced PHASE to the deal sidecar (summary writer;
 *  phase persistence). The phase persisted is the model-ADVANCED resolve (it may nudge the talk one notch forward
 *  from this turn's scope phase), so NEXT turn reads it back and the newly-reached phase unlocks its tools. The
 *  sidecar is keyed by the conversation id. Writes when there's a summary OR a phase change to record (don't
 *  create an empty sidecar for a pure browse turn with nothing new). Fail-SOFT: a sidecar IO error must never
 *  break the reply the buyer is waiting on. */
async function persistTurn(ctx: DeskContext, decision: DeskDecision, scopePhase: Phase): Promise<void> {
  try {
    const { state, storedPhase } = await dealStateFor(ctx.conversationId);
    // The model MAY advance the phase one notch past the scope phase (bounded by the server floor+cap). Resolve
    // WITH the model's declared phase this time — that's what we persist for next turn.
    const advanced = resolvePhase({ storedPhase: storedPhase ?? scopePhase, modelPhase: decision.phase, state });
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
  const turnPhase = await resolveTurnPhase(ctx.conversationId, phaseOf(ctx));
  const scope = toolScope(personaOf(ctx), turnPhase, ctx.building.id);
  //  (slice 6) — the action-tool context (open_unit / record_deposit). The dealId keys the hold + sidecar;
  // canOpenUnit is the live config authority; the buyer account is left to the context (the desk-side record is
  // what the AI files — the buyer-scoped confirm surface isn't part of the AI's turn).
  //  (slice 9) — signingPosture carries the vault config to the seam. No `authorization` is threaded from an
  // LLM turn (a human supplies it out-of-band via the TAN/TG channel, not yet wired) — so under posture "vault"
  // an autonomous hold correctly resolves to "needs_authorization" until that channel lands.
  const actionCtx: ToolActionContext = { dealId: ctx.conversationId, canOpenUnit: cfg.canOpenUnit, signingPosture: cfg.signingPosture };

  let tokensTotal = 0;
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
      // Append the model's own query turn (assistant) then the tool RESULT as a user turn the model reads next.
      messages.push({ role: "assistant", content: res.answer });
      messages.push({ role: "user", content: `TOOL RESULT (${tool}):\n${result}` });
      continue;
    }

    const decision = clampDecision(parsed, cfg, priceUsd, consented);
    await persistTurn(ctx, decision, turnPhase);
    return { ok: true, decision, tokens: tokensTotal };
  }

  // Exhausted the rounds while still querying — resolve with a plain talk turn (never leave the buyer hanging).
  return {
    ok: true,
    decision: { reply: "Let me pull that together for you — one moment.", action: { type: "none" } },
    tokens: tokensTotal,
  };
}
