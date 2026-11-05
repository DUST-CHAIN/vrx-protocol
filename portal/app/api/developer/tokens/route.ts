// /api/developer/tokens — the DEVELOPER's booking-token surface (slice 7b). The developer READS the
// capacity VRX issued them and HANDS/SELLS a token one step down the trust graph to one of their gated
// agencies, choosing the token's economics (the trust-dial, design §3a/3b/3c). The developer cannot MINT
// (that is VRX-root's power — /api/root/booking-tokens); here they deploy capacity they already hold.
//
//   GET  ?developer=<acct>&viewer=<acct>
//        → { tokens, agencies, config }
//          tokens   = the developer's tokens (their capacity), each decorated with a plain-words state label +
//  the custody holder's name. The sealed custody mechanics stay under the hood.
//          agencies = the developer's GATED agencies (account + name) — the only legitimate hand-to targets
//                     (chain-constrained: a token may only move along the trust graph, never peer-to-peer).
//          config   = the developer's effective issuance-fee config (shown transparently — the honest fee).
//   POST { developer, op:"hand", tokenId, toAgency, economics, payment? }
//        → { token }  — hand/sell a token to a gated agency. A stake/prepaid hand is a crypto-verified SALE
//                       (payment required); a permission hand is free. The lib enforces holder-scope +
//                       counterparty validation + the crypto-receipt rule; a refusal → 400 with its message.
//
// AUTH (demo-layer, same posture as /api/vrx-developer-agreement): the viewer/caller names its own account
// and must equal the developer subject. The real wallet/session binding lands with the signing arc.
// PRIVACY: token ids + accounts + states only here; amounts (the sale `payment`) stay off-chain.

import { NextResponse } from "next/server";
import { listProfiles } from "@/lib/profiles";
import { agenciesForDeveloper } from "@/lib/gates";
import {
  tokensForDeveloper,
  transferToken,
  confirmCash,
  issuanceConfigFor,
  type TokenEconomics,
} from "@/lib/booking-tokens";
import { publish } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ECONOMICS: readonly TokenEconomics[] = ["stake", "prepaid", "permission"];

// Plain-words state labels — the developer never sees the raw state machine vocabulary.
const STATE_LABEL: Record<string, string> = {
  issued: "In your hands",
  with_agency: "With an agency",
  with_agent: "With a field agent",
  committed: "Securing a booking",
  cash_taken: "Cash taken",
  reconciling: "Reconciling",
  settled: "Settled",
  frozen: "Paused",
  recycled: "Returned (recyclable)",
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const developer = url.searchParams.get("developer")?.trim() || "";
  const viewer = url.searchParams.get("viewer")?.trim() || "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
  if (!viewer || viewer.toLowerCase() !== developer.toLowerCase()) {
    return NextResponse.json({ error: "viewer must match developer" }, { status: 403 });
  }

  const [tokens, agencyAccounts, profiles, config] = await Promise.all([
    tokensForDeveloper(developer),
    agenciesForDeveloper(developer),
    listProfiles(),
    issuanceConfigFor(developer),
  ]);
  const nameByAccount = new Map(profiles.map((p) => [p.account.toLowerCase(), p.legalName]));
  const nameOf = (account: string): string => nameByAccount.get(account.trim().toLowerCase()) || account;

  return NextResponse.json({
    tokens: tokens.map((t) => ({
      id: t.id,
      state: t.state,
      stateLabel: STATE_LABEL[t.state] ?? t.state,
      economics: t.economics,
      custody: t.custody,
      custodyName: nameOf(t.custody),
      issuanceFee: t.issuanceFee ?? null,
      tokenPayment: t.tokenPayment ? { amountMinor: t.tokenPayment.amountMinor, currency: t.tokenPayment.currency, refundedAt: t.tokenPayment.refundedAt ?? null } : null,
      // The customer cash leg — surfaced so the developer sees "reconciling" tokens awaiting their confirm.
      cash: t.cash ? { amountMinor: t.cash.amountMinor, currency: t.cash.currency, disputed: !!t.cash.disputed, agencyConfirmedAt: t.cash.agencyConfirmedAt ?? null, developerConfirmedAt: t.cash.developerConfirmedAt ?? null } : null,
      recycleOf: t.recycleOf ?? null,
      buildingId: t.buildingId ?? null,
      unitId: t.unitId ?? null,
      issuedAt: t.issuedAt,
    })),
    agencies: agencyAccounts.map((a) => ({ account: a, name: nameOf(a) })),
    config: config ? { model: config.model, feeMinor: config.feeMinor, currency: config.currency, allotmentCap: config.allotmentCap ?? null } : null,
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const developer = typeof body.developer === "string" ? body.developer.trim() : "";
  const op = typeof body.op === "string" ? body.op : "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });

  try {
    if (op === "hand") {
      const tokenId = typeof body.tokenId === "string" ? body.tokenId.trim() : "";
      const toAgency = typeof body.toAgency === "string" ? body.toAgency.trim() : "";
      if (!tokenId || !toAgency) return NextResponse.json({ error: "tokenId and toAgency required" }, { status: 400 });
      const economics = ECONOMICS.includes(body.economics) ? (body.economics as TokenEconomics) : undefined;
      // The developer is the current holder of a token they hand down (holder-scope enforced in the lib). The
      // lib also validates toAgency is a legitimate counterparty (a gated agency) and the crypto-sale rule.
      const token = await transferToken({
        tokenId,
        by: developer,
        to: toAgency,
        economics,
        payment: body.payment,
      });
      publish("events");
      return NextResponse.json({ token });
    }

    if (op === "confirmCash") {
      // The developer confirms it COLLECTED the cash from the agency (reconciling → settled) — the final hop
      // of the three-hop reconcile. The lib checks `developer` owns the token.
      const tokenId = typeof body.tokenId === "string" ? body.tokenId.trim() : "";
      if (!tokenId) return NextResponse.json({ error: "tokenId required" }, { status: 400 });
      const token = await confirmCash({ tokenId, by: developer, role: "developer" });
      publish("events");
      return NextResponse.json({ token });
    }

    return NextResponse.json({ error: "unknown op (hand | confirmCash)" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "request failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
