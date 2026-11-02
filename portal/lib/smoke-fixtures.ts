// from the real seeded offers, a representative booking per interesting stage so the dev-only /dev/smoke
// page can mount every money/legal surface on ONE scroll with REAL data.
// WHY PURE + SEPARATE: the whole value of the smoke route is "a green here means the SAME code path the
// real apps use" (no hand-written fixtures that could drift). This file holds NO data of its own — it is
// handed the live offers (read via lib/offers.offersForDeveloper by the server component) and just chooses
// which ones to showcase. Keeping the selection pure lets `smoke-fixtures.test.ts` assert the picker's
// contract (picks a signed deal when one exists, falls back honestly when none do, scopes to the developer)
// WITHOUT a running store — the untestable browser surfaces then mount on top of a proven selection.
// It deliberately knows nothing about React; it operates on the minimal Offer shape (lib/offers.Offer) via
// the stage classifier passed in, so it cannot drift from the real stage machine.

import type { Offer, ContractStage } from "./offers";

/** The seeded demo developers (lib/seed-funnel). Exported so the server component and the test agree on ONE
 * list — if the seed grows a dev-04, add it here and both surfaces pick it up. */
export const SMOKE_DEVELOPERS = [
  "vvv-dev-01.testnet",
  "vvv-dev-02.testnet",
  "vvv-dev-03.testnet",
] as const;

/** One chosen booking to showcase, with everything the surfaces need to mount without a wallet connect. */
export type SmokeBooking = {
  requestId: string;
  developer: string;
  /** The agent who authored it (seal.by) — the agent-viewer for the S&P masking demo. */
  agent: string;
  /** The supervising agency, when derivable from the booking; may be undefined. */
  buildingId?: string;
  unitId?: string;
  /** The roster buyer id (display.buyerId) — lets the KYC vault panel mount against a real buyer. */
  buyerId?: string;
  /** The resolved contract stage, so the page can label WHAT it is showing. */
  stage: ContractStage;
  /** Whether the booking is closed on-chain (confirmed) — a SIGNED+confirmed deal is the richest S&P. */
  confirmed: boolean;
};

function toBooking(o: Offer, stage: ContractStage): SmokeBooking {
  return {
    requestId: o.requestId,
    developer: o.developer,
    agent: o.seal.by,
    buildingId: o.display.buildingId,
    unitId: o.display.unitId,
    buyerId: o.display.buyerId,
    stage,
    confirmed: Boolean(o.confirmed),
  };
}

/**
 * From a developer's offers, pick ONE booking per distinct contract stage (most-advanced instance of each),
 * so the smoke page can show the S&P / settlement / payment surfaces at every interesting point in the
 * funnel. Deterministic: within a stage, prefer a CONFIRMED (closed) booking, then the earliest requestId
 * (stable ordering so the page doesn't reshuffle between renders / reseeds with the same data).
 *
 * `stageOf` is injected (lib/offers.contractStage) so this never re-implements the stage machine.
 */
export function pickBookingsByStage(
  offers: Offer[],
  stageOf: (o: Offer) => ContractStage
): SmokeBooking[] {
  const best = new Map<ContractStage, SmokeBooking>();
  for (const o of offers) {
    const stage = stageOf(o);
    const cand = toBooking(o, stage);
    const cur = best.get(stage);
    if (!cur) {
      best.set(stage, cand);
      continue;
    }
    // Prefer confirmed, then the lexicographically-earliest requestId (stable).
    const better =
      (cand.confirmed && !cur.confirmed) ||
      (cand.confirmed === cur.confirmed && cand.requestId < cur.requestId);
    if (better) best.set(stage, cand);
  }
  // A readable order: the funnel's natural progression, unknown stages appended.
  const order: ContractStage[] = ["preview", "final", "payment_arrived", "signed"];
  const out: SmokeBooking[] = [];
  for (const s of order) {
    const b = best.get(s);
    if (b) out.push(b);
  }
  for (const [s, b] of best) if (!order.includes(s)) out.push(b);
  return out;
}

/**
 * The single RICHEST booking across a set — the one whose S&P exercises the most clauses: a signed+confirmed
 * deal if any exists, else the most-advanced stage present. Used for the "primary" S&P showcase (all three
 * viewer roles) so masking + review-mode + the seal block all have real content. Returns null if none.
 */
export function pickRichestBooking(bookings: SmokeBooking[]): SmokeBooking | null {
  if (bookings.length === 0) return null;
  const rank: Record<string, number> = { preview: 0, final: 1, payment_arrived: 2, signed: 3 };
  let best = bookings[0];
  for (const b of bookings.slice(1)) {
    const bScore = (rank[b.stage] ?? 0) + (b.confirmed ? 0.5 : 0);
    const bestScore = (rank[best.stage] ?? 0) + (best.confirmed ? 0.5 : 0);
    if (bScore > bestScore) best = b;
  }
  return best;
}
