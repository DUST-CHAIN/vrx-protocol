// AI Sales Director — act (the design docs §9.6). SERVER-ONLY. Applies a (already parsed +
// clamped) DeskDecision to the live direct-conversation stores: posts the reply as a vrx system notice, then
// fires the action IFF its config toggle is on — the THIRD and final gate (parse validated shape, clamp enforced
// config + bounds, act re-checks the toggle at fire time; fail-closed if off). The desk account the AI acts AS
// is the building's desk developer (resolved by the caller / directParties).
//
// Concession posture (v1): a concession is POSTED into the thread as a concrete, draftable offer — NOT auto-
// written into the sealed S&P. The AI proposes the exact combo + $ figure; accepting it into the contract stays
// a confirmed human step (and a pre-booking conversation may have no contract yet). This keeps the AI's money
// moves visible + reversible while still "drafting the number" the buyer sees.

import { postSystemNotice, postMessage } from "../channels";
import { requestDirectReveal, requestCallOff, blockBuyer, type DirectRole } from "../conversations-direct";
import { sealRecord } from "../seal";
import type { AiDeskConfig, DeskDecision, QuoteLine } from "./types";

/** Render a structured quote as a DETERMINISTIC aligned text block (real newlines + padding we control — NOT the
 *  model's unreliable whitespace). pre-wrap in the chat renders this as a clean column. A negative amount shows
 * as a deduction; a dashed rule separates the net. (the screenshot showed free-text runs together). */
export function formatQuote(lines: QuoteLine[], netUsd: number): string {
  const money = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString();
  const labelW = Math.max(10, ...lines.map((l) => l.label.length), "Net price".length);
  const row = (label: string, amount: string) => "  " + label.padEnd(labelW + 2) + amount;
  const body = lines.map((l) => row(l.label, money(l.amountUsd)));
  const rule = "  " + "-".repeat(labelW + 2 + 12);
  return [...body, rule, row("Net price", money(netUsd))].join("\n");
}

/** The non-circumvention declaration the desk "accepts" when the AI asks for a reveal (T1 evidence —
 *  recorded even though the AI issued it, so the audit trail shows the undertaking was given). */
const AI_DESK_DECLARATION = "VRX automated sales desk reveal request — the desk undertakes not to circumvent the buyer's chosen channel and to use revealed detail only to progress THIS deal.";
const DECLARATION_DOMAIN = "vrx-direct-reveal-declaration";

export type ActResult = {
  replied: boolean;
  actionFired: DeskDecision["action"]["type"] | null;
};

/**
 * Apply a DeskDecision to a conversation. `deskAccount` is the desk developer the AI acts as (for call-off
 * provenance / reveal `by`). Every action re-checks its toggle here (the model + clamp already filtered, but a
 * toggle could have flipped between decide and act). Returns what happened.
 */
export async function applyDecision(
  conversationId: string,
  decision: DeskDecision,
  cfg: AiDeskConfig,
  deskAccount: string
): Promise<ActResult> {
  // 1. Post the reply AS THE DESK (from:"developer") so it renders as a proper "Sales desk" bubble — NOT a
  // muted centered vrx system notice (the AI reply landed with poor formatting because it posted as
  // vrx). Only true system EVENTS (reveal/call-off markers, the structured quote block) stay as vrx notices.
  let replied = false;
  if (cfg.autoReply && decision.reply.trim()) {
    const posted = await postMessage({
      requestId: conversationId, // the channel-store key for a direct thread IS the conversationId
      from: "developer",
      by: deskAccount,
      text: decision.reply.trim(),
      context: { kind: "direct", id: conversationId },
    });
    replied = posted !== null;
  }

  // 2. Fire the action — re-gated at fire time (fail-closed).
  const a = decision.action;
  let actionFired: ActResult["actionFired"] = null;

  if (a.type === "reveal_request" && cfg.canRequestReveal && a.fields.length) {
    const seal = sealRecord(AI_DESK_DECLARATION, DECLARATION_DOMAIN);
    const r = await requestDirectReveal(conversationId, deskAccount, a.fields, seal.hash);
    if (r) actionFired = "reveal_request";
  } else if (a.type === "concession" && cfg.canConcede && a.levers.length) {
    // v1: post the concrete offer into the thread (draftable, human accepts into the S&P). Not auto-sealed.
    const lines = a.levers.map((l) => `• ${l.label}${l.valueUsd ? ` (~$${l.valueUsd.toLocaleString()})` : ""}`).join("\n");
    const posted = await postSystemNotice({
      requestId: conversationId,
      text: `Proposed offer (total value ~$${a.totalValueUsd.toLocaleString()}):\n${lines}\nIf you'd like this, we'll draft it into your Sale & Purchase agreement.`,
      context: { kind: "direct", id: conversationId },
    });
    if (posted) actionFired = "concession";
  } else if (a.type === "quote" && cfg.canConcede && a.lines.length) {
    // Deterministic aligned quote block (app-controlled layout, not the model's whitespace).
    const posted = await postSystemNotice({
      requestId: conversationId,
      text: formatQuote(a.lines, a.netUsd) + "\n\nIf this works for you, we'll draft it into your Sale & Purchase agreement.",
      context: { kind: "direct", id: conversationId },
    });
    if (posted) actionFired = "quote";
  } else if (a.type === "call_off" && cfg.canCallOff) {
    const r = await requestCallOff(conversationId, "developer" as DirectRole, deskAccount);
    if (r) actionFired = "call_off";
  } else if (a.type === "block" && cfg.canBlock) {
    const r = await blockBuyer(conversationId);
    if (r) actionFired = "block";
  }

  return { replied, actionFired };
}

/**
 * Apply a DeskDecision to a BOOKING thread (the seller-autoresponder "chat" lane). Posts the reply +
 * quote/concession into the BOOKING channel (context kind "booking", keyed by the offer requestId). The
 * direct-only actions (reveal_request / call_off / block) do NOT apply here — a booking has its own lifecycle
 * (deposit / hold / confirm), so those action types are a no-op in this lane (the reply still lands). This keeps
 * the AI's money moves VISIBLE (a posted draftable offer), never auto-sealing the booking's contract.
 */
export async function applyBookingDecision(
  requestId: string,
  decision: DeskDecision,
  cfg: AiDeskConfig,
  deskAccount: string
): Promise<ActResult> {
  let replied = false;
  if (cfg.autoReply && decision.reply.trim()) {
    const posted = await postMessage({
      requestId,
      from: "developer",
      by: deskAccount,
      text: decision.reply.trim(),
      context: { kind: "booking", id: requestId },
    });
    replied = posted !== null;
  }

  const a = decision.action;
  let actionFired: ActResult["actionFired"] = null;
  if (a.type === "quote" && cfg.canConcede && a.lines.length) {
    const posted = await postSystemNotice({
      requestId,
      text: formatQuote(a.lines, a.netUsd) + "\n\nIf this works for your client, we'll draft it into the Sale & Purchase agreement.",
      context: { kind: "booking", id: requestId },
    });
    if (posted) actionFired = "quote";
  } else if (a.type === "concession" && cfg.canConcede && a.levers.length) {
    const lines = a.levers.map((l) => `• ${l.label}${l.valueUsd ? ` (~$${l.valueUsd.toLocaleString()})` : ""}`).join("\n");
    const posted = await postSystemNotice({
      requestId,
      text: `Proposed for your client (total value ~$${a.totalValueUsd.toLocaleString()}):\n${lines}\nIf you'd like this, we'll draft it into the Sale & Purchase agreement.`,
      context: { kind: "booking", id: requestId },
    });
    if (posted) actionFired = "concession";
  }
  // reveal_request / call_off / block are direct-lane only — ignored in the booking lane (reply still posted).
  return { replied, actionFired };
}
