// AI Sales Director — the SERVER-SIDE BUTTON COMPOSER (Slice 1 of the solo build batch;
// the design docs — the "model emits buttons autonomously" follow-on to the
// action-buttons spine). SERVER-ONLY.
//
// WHY this layer exists. The model (or a human seller) PROPOSES with words; the BUTTON carries the commit. But the
// trust-bearing parts of a button — its LABEL ("Reserve unit-301 · 2-bed · $740k"), its live PRICE, and its
// enabled/greyed state — must NEVER come from the model (it confabulates figures, and a greyed Pay chip is a legal
// gate, not a suggestion). So the model emits only a LIGHTWEIGHT request — WHICH chips, for WHICH unit — and THIS
// composer resolves the real unit from the catalog + the real gate state from the deal, and builds the
// ActionButton[] the client renders. The executor (/api/desk-action) remains the final authority (it re-checks
// every gate and returns honest 409s); `enabled` here is the ADVISORY UI the type doc describes (types.ts §5b.5).
//
// The composer is PURE of the model transport. It reads the catalog (unitDetail) + the deal state (deposits,
// S&P ack, reservation document) via the same helpers the executor uses — so a chip's greyed-ness matches the
// 409 the tap would get. No divergence: ONE truth, read in two places.

import type { ActionButton, ActionButtonKind, ButtonsRequest } from "./types";
import { unitDetail, type ToolScope } from "./query-tools";
import { depositsForBuyer } from "../direct-deposits";
import { isSpAcknowledged } from "./deal-sidecar";
import { getReservationDocument, depositWindowState } from "./reservation-document";

export type { ButtonsRequest };

/** The closed set of kinds the model may ask to render. Mirrors the executor's KNOWN_KINDS minus the ones the model
 *  never proposes autonomously (issue_reservation/approve_signing_date are desk/VRX-driven affordances, not chips
 *  the buyer-facing desk offers mid-chat). Keep this tight so a hallucinated kind degrades to nothing, not a
 *  mystery chip. */
export const EMITTABLE_KINDS: readonly ActionButtonKind[] = [
  "reserve",
  "view_terms",
  "read_sp",
  "pay_deposit",
  "show_similar",
  "confirm_reservation",
  "propose_signing_date",
] as const;

const isEmittable = (s: unknown): s is ActionButtonKind =>
  typeof s === "string" && (EMITTABLE_KINDS as readonly string[]).includes(s);

/** The deal facts the composer needs to compute advisory enabled-state. The caller (decide) supplies the ids; the
 *  composer reads the live stores itself (so the state matches what the executor will re-check at tap time). */
export type ComposeContext = {
  scope: ToolScope; // persona/phase/building — for the catalog lookup (unit label/price)
  conversationId: string;
  buyer: string;
  building: string;
};

/** The reduced deal state the enabled-state decision depends on (read once per compose; see composeButtons). Kept
 *  as a plain record so the gate logic is a PURE, exhaustively-testable function independent of the fs stores. */
export type DealState = {
  heldThisUnit: boolean; // the subject unit is firm-held for this buyer (read_sp/pay/confirm key off a held unit)
  acked: boolean; // the buyer tapped [Read S&P] (spAcknowledgedAt set)
  windowState: "unconfirmed" | "open" | "lapsed"; // the reservation-confirm → 2h deposit-window state
  hasDoc: boolean; // a reservation document has been issued (confirm/propose-signing attach to it)
};

/** PURE: the advisory enabled/greyed state for ONE chip kind given the deal state. This is the gate logic that
 *  MUST mirror the executor's 409s (/api/desk-action) — a greyed chip explains the same precondition a tap would
 *  hit. Returns {enabled} and, when greyed, the honest next step. Exhaustively unit-tested (compose-buttons.test).
 *  The read kinds (view_terms/show_similar) are always enabled; a reserve is always offerable on a focused unit. */
export function buttonEnabledState(kind: ActionButtonKind, s: DealState): { enabled: boolean; disabledReason?: string } {
  switch (kind) {
    case "reserve":
    case "view_terms":
    case "show_similar":
      return { enabled: true };
    case "read_sp":
      return s.heldThisUnit
        ? { enabled: true }
        : { enabled: false, disabledReason: "Reserve the unit first — the S&P papers your reservation." };
    case "pay_deposit": {
      if (!s.heldThisUnit) return { enabled: false, disabledReason: "Reserve the unit first." };
      if (!s.acked) return { enabled: false, disabledReason: "Read the S&P first (it must be acknowledged before paying)." };
      if (s.windowState === "unconfirmed") return { enabled: false, disabledReason: "Confirm your reservation first to start the deposit window." };
      if (s.windowState === "lapsed") return { enabled: false, disabledReason: "The deposit window lapsed — re-confirm to restart it." };
      return { enabled: true };
    }
    case "confirm_reservation":
      // Offered once a reservation document exists and the window isn't currently open (re-confirm restarts a
      // lapsed clock). Enabled when a doc exists and the window is unconfirmed/lapsed.
      return s.hasDoc && s.windowState !== "open"
        ? { enabled: true }
        : { enabled: false, disabledReason: s.hasDoc ? "Your reservation is confirmed and the deposit window is open." : "Issue the reservation document first." };
    case "propose_signing_date":
      return s.hasDoc
        ? { enabled: true }
        : { enabled: false, disabledReason: "Issue the reservation document first." };
    default:
      return { enabled: false };
  }
}

/** Validate + normalise a model-emitted buttons request. Drops unknown kinds, dedupes, and keeps at most a handful
 *  (a desk reply with 10 chips is noise — cap it). Returns null if nothing emittable survives (→ the caller emits
 *  no buttons action, i.e. a plain chat turn). The unit, when present, is lowercased to the catalog's canonical form. */
export function parseButtonsRequest(raw: unknown): ButtonsRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kinds = Array.isArray(o.kinds) ? o.kinds.filter(isEmittable) : [];
  const deduped = [...new Set(kinds)].slice(0, 5);
  if (!deduped.length) return null;
  const unit = typeof o.unit === "string" && o.unit.trim() ? o.unit.trim().toLowerCase() : undefined;
  return { kinds: deduped, unit };
}

/** Build the REAL ActionButton[] for a model-emitted request. Resolves the unit from the catalog (for the label +
 *  the display price) and the deal state (for advisory enabled/greyed), per kind. A kind whose unit can't be
 *  resolved (and that needs one) is DROPPED — a chip with no real unit is the wrong-unit bug class, never shipped.
 *  Returns [] when nothing composable survives (the caller then emits a plain chat turn, no buttons). */
export async function composeButtons(ctx: ComposeContext, req: ButtonsRequest): Promise<ActionButton[]> {
  // Resolve the unit once (label + price) if one was named. The read kinds can proceed without it (building-level),
  // but every COMMIT kind needs a concrete unit — so a commit kind with an unresolvable unit is dropped below.
  let unit: { key: string; type?: string; priceUsd?: number } | null = null;
  if (req.unit) {
    const r = await unitDetail(ctx.scope, { unitId: req.unit });
    if (r.ok && r.data) {
      unit = { key: r.data.id, type: r.data.typeLabel, priceUsd: r.data.priceUsd };
    }
  }

  // Read the deal state ONCE (not per-kind) so the advisory enabled-flags are internally consistent and cheap.
  // held: the buyer's firm holds in this building (read_sp/pay/confirm all key off a held unit). acked: did the
  // buyer tap [Read S&P]. doc + its window: has the reservation been confirmed + is the 2h deposit window open.
  const holds = (await depositsForBuyer(ctx.buyer)).filter(
    (d) => d.building === ctx.building && d.status === "held"
  );
  //  multi-unit: read the doc FOR THIS UNIT (a deal can carry several reserved units, each its own doc).
  // Passing req.unit keys the exact reservation; without it the window/depositUsd below would reflect the deal's
  // NEWEST doc — the wrong unit's confirm/pay state. Omit (undefined) only when no unit was named (building-level).
  const doc = await getReservationDocument(ctx.conversationId, req.unit || undefined);
  const win = doc ? depositWindowState(doc) : { state: "unconfirmed" as const, msLeft: 0 };
  const state: DealState = {
    heldThisUnit: req.unit ? holds.some((d) => d.unit === req.unit) : holds.length > 0,
    acked: await isSpAcknowledged(ctx.conversationId),
    windowState: win.state,
    hasDoc: !!doc,
  };

  // The deductible deposit figure (from the sealed reservation doc) — a DISPLAY value on the pay chip, re-derived
  // by the server at tap time regardless (never trusted). Absent until the doc snapshots it.
  const depositUsd = typeof doc?.depositUsd === "number" && doc.depositUsd > 0 ? doc.depositUsd : undefined;

  // The APP-composed unit tag SHOWN on a button (: the chip shows what it commits to — no magic words).
  // Re-derived from the catalog so the price is always real; the model's own label (if any) is ignored entirely.
  const unitTag = unit ? `${unit.key}${unit.type ? ` · ${unit.type}` : ""}${unit.priceUsd ? ` · $${unit.priceUsd.toLocaleString()}` : ""}` : "";

  const labelFor = (kind: ActionButtonKind): string => {
    switch (kind) {
      case "reserve": return `Reserve ${unitTag}`;
      case "view_terms": return unit ? `View terms · ${unit.key}` : "View payment terms";
      case "show_similar": return "Show similar units";
      case "read_sp": return `Read S&P · ${unit!.key}`;
      case "pay_deposit": return depositUsd ? `Pay $${depositUsd.toLocaleString()} deposit · ${unit!.key}` : `Pay deposit · ${unit!.key}`;
      case "confirm_reservation": return `Confirm reservation · ${unit!.key}`;
      case "propose_signing_date": return `Propose signing date · ${unit!.key}`;
      default: return String(kind);
    }
  };

  const out: ActionButton[] = [];
  for (const kind of req.kinds) {
    // COMMIT kinds need a resolved unit; read kinds don't. Drop a commit chip we can't anchor to a real unit.
    const needsUnit = kind !== "view_terms" && kind !== "show_similar";
    if (needsUnit && !unit) continue;
    const gate = buttonEnabledState(kind, state);
    const unitRef = unit ?? { key: req.unit ?? "" };
    out.push({
      kind,
      label: labelFor(kind),
      unit: unitRef,
      ...(kind === "pay_deposit" && depositUsd ? { amountUsd: depositUsd } : {}),
      enabled: gate.enabled,
      ...(gate.enabled ? {} : { disabledReason: gate.disabledReason }),
    });
  }
  return out;
}
