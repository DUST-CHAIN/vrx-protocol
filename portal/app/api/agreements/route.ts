// /api/agreements — the commission-agreement store (the design docs §1), the SECOND
// consumer of the attested-records spine after /api/offers. Same shape: plaintext off-chain + a hash
// SEAL + re-hash verify.
//
//   GET  ?party=<account>      → { agreements: [{ ...record, verified }] } — every agreement this account
//                                is a party to (as agency OR developer), newest first, each with its
//                                ✓ VETTED re-hash result.
//   GET  ?id=<id>              → { agreement, verified } for one.
//   POST { seal }              → propose an agreement. The server computes + stores the seal (there is no
//  on-chain seal yet — — so the server attests for now). Returns the
//                                stored record + verified.
//   POST { id, status, by }    → move an agreement's lifecycle ("agreed" | "declined" | "revoked"). `by`
//                                must be a party; a proposal is agreed/declined by the COUNTERPARTY.
//
// PRIVACY: server-side only; the chain is untouched (the on-chain stamp is a later arc). Holds
// the plaintext deliberately — it's the two parties' private copy. Neutral account ids only.

import { NextResponse } from "next/server";
import {
  agreementsForParty,
  getAgreement,
  isPartyTo,
  isValidCommissionPct,
  isValidUnlockPct,
  joinAgreement,
  liveAgreementBetween,
  mutualRevoke,
  proposeAgreement,
  publicAgreement,
  publishedAgreements,
  setAgreementStatus,
  type AgreementBuilding,
  type AgreementSeal,
  type AgreementStatus,
} from "@/lib/agreements";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lifecycle moves a party may request via POST { id, status, by }. "published" is NOT settable here (it's
// an origination mode of propose); "agreed" via published → use the join action instead.
// Direct status moves a party may request via POST { id, status, by }. "revoked" is NOT here — ending an
// agreed agreement is mutual-consent only, routed through { revoke: <id>, by }.
const MOVE_STATUSES: AgreementStatus[] = ["agreed", "declined"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const party = url.searchParams.get("party")?.trim();
  const id = url.searchParams.get("id")?.trim();
  const published = url.searchParams.get("published");
  //  fix #1: the caller names who it is so we can scope private reads to a party. Demo-layer auth, same
  // posture as the `by`/`party` convention + the operator gate elsewhere (no wallet-sig infra here yet).
  const viewer = url.searchParams.get("viewer")?.trim();

  // NOTE (fix #1): every response goes through publicAgreement — it strips the secret per-record salt
  //  and attaches `verified`. The salt must NEVER leave the server; serving it defeats.
  if (id) {
    const agreement = await getAgreement(id);
    if (!agreement) return NextResponse.json({ agreement: null, verified: false });
    // Private record — only a party may read it (fix #1: `?id=` previously had NO auth at all).
    if (!viewer || !isPartyTo(agreement, viewer)) {
      return NextResponse.json({ error: "not a party to this agreement" }, { status: 403 });
    }
    const pub = await publicAgreement(agreement);
    return NextResponse.json({ agreement: pub, verified: pub.verified });
  }
  // Discovery feed for the agency "developers publishing terms" card list (Mode 2). Published cards are
  // open-to-all by design (no named counterparty yet), so no viewer scoping — but still salt-stripped.
  if (published !== null) {
    const list = await publishedAgreements();
    const agreements = await Promise.all(list.map(publicAgreement));
    return NextResponse.json({ agreements });
  }
  if (party) {
    // fix #1: `?party=` previously trusted the caller-supplied account. Require the viewer to BE that party.
    if (!viewer || viewer.toLowerCase() !== party.toLowerCase()) {
      return NextResponse.json({ error: "viewer must match party" }, { status: 403 });
    }
    const list = await agreementsForParty(party);
    const agreements = await Promise.all(list.map(publicAgreement));
    return NextResponse.json({ agreements });
  }
  return NextResponse.json({ error: "party, id, or published required" }, { status: 400 });
}

// Validate + normalize the per-building terms array. Each building needs an id, a valid commission
// (>0 and ≤100 — the shared isValidCommissionPct, fix #5, so empty/0/NaN can't seal a silent 0%), and a
// scope of "whole" or { units: string[] }.
function parseBuildings(raw: unknown): AgreementBuilding[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AgreementBuilding[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") return null;
    const buildingId = typeof b.buildingId === "string" ? b.buildingId.trim() : "";
    const commissionPct = b.commissionPct;
    if (!buildingId || !isValidCommissionPct(commissionPct)) return null;
    let scope: AgreementBuilding["scope"];
    if (b.scope === "whole") scope = "whole";
    else if (b.scope && typeof b.scope === "object" && Array.isArray(b.scope.units)) {
      scope = { units: b.scope.units.filter((u: unknown): u is string => typeof u === "string") };
    } else return null;
    const clause: AgreementBuilding = { buildingId, commissionPct, scope };
    // the AGENCY-commission unlock fields, optional + validated. Absent → omitted (hashes like a
    //  record; read-time falls back to deposit%). A PRESENT but invalid unlockPct is a hard reject
    // (don't silently seal a nonsense threshold). `unlockOnSigning` is a bare boolean when given.
    if (b.unlockPct !== undefined) {
      if (!isValidUnlockPct(b.unlockPct)) return null;
      clause.unlockPct = b.unlockPct;
    }
    if (typeof b.unlockOnSigning === "boolean") clause.unlockOnSigning = b.unlockOnSigning;
    out.push(clause);
  }
  return out;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  // Join a published agreement (Mode 2): { join: <id>, by: <agency> }
  if (typeof body.join === "string") {
    const by = typeof body.by === "string" ? body.by.trim() : "";
    if (!by) return NextResponse.json({ error: "join + by (agency) required" }, { status: 400 });
    const updated = await joinAgreement(body.join, by);
    if (!updated) return NextResponse.json({ error: "not a joinable published agreement" }, { status: 409 });
    // Joining a published agreement moves it straight to "agreed" (join = acceptance of the terms as-is).
    await logActivity(
      "agreement.joined",
      updated.seal.agency,
      { kind: "agreement", id: updated.id },
      [updated.seal.developer, updated.seal.agency],
      { actorRole: "agency", counterparty: updated.seal.developer }
    );
    const pub = await publicAgreement(updated);
    return NextResponse.json({ agreement: pub, verified: pub.verified });
  }

  // Mutual revoke of an agreed agreement: { revoke: <id>, by }. Two-step — the first party requests,
  // the counterparty confirms. Neither side can end a durable commitment alone.
  if (typeof body.revoke === "string") {
    const by = typeof body.by === "string" ? body.by.trim() : "";
    if (!by) return NextResponse.json({ error: "revoke + by required" }, { status: 400 });
    const updated = await mutualRevoke(body.revoke, by);
    if (!updated) return NextResponse.json({ error: "not allowed or not found" }, { status: 409 });
    // Two-step: the first call records a request (status still "agreed"); the counterparty's call confirms
    // → "revoked". Log the one that actually happened so the timeline reads true.
    const cp = by.toLowerCase() === updated.seal.developer.toLowerCase() ? updated.seal.agency : updated.seal.developer;
    await logActivity(
      updated.status === "revoked" ? "agreement.revoked" : "agreement.revoke_requested",
      by,
      { kind: "agreement", id: updated.id },
      [updated.seal.developer, updated.seal.agency],
      { counterparty: cp }
    );
    const pub = await publicAgreement(updated);
    return NextResponse.json({ agreement: pub, verified: pub.verified });
  }

  // Lifecycle move: { id, status, by }
  if (typeof body.id === "string" && typeof body.status === "string") {
    const status = body.status as AgreementStatus;
    const by = typeof body.by === "string" ? body.by : "";
    if (!MOVE_STATUSES.includes(status) || !by) {
      return NextResponse.json({ error: "id + status (agreed|declined|revoked) + by required" }, { status: 400 });
    }
    const updated = await setAgreementStatus(body.id, status, by);
    if (!updated) {
      return NextResponse.json({ error: "not allowed or not found" }, { status: 409 });
    }
    const cp = by.toLowerCase() === updated.seal.developer.toLowerCase() ? updated.seal.agency : updated.seal.developer;
    await logActivity(
      status === "agreed" ? "agreement.agreed" : "agreement.declined",
      by,
      { kind: "agreement", id: updated.id },
      [updated.seal.developer, updated.seal.agency],
      { counterparty: cp }
    );
    const pub = await publicAgreement(updated);
    return NextResponse.json({ agreement: pub, verified: pub.verified });
  }

  // Propose / publish: { seal }. Only the DEVELOPER may author an agreement's terms — Mode 1 (dev→named
  // agency, a directed offer) and Mode 2 PUBLISH (by:"developer", EMPTY agency, a vetted agency later joins).
  // The AGENCY may NOT author or counter-author terms: it can only JOIN a published rate card
  // as-is (the { join } branch above) or confirm a revoke. An agency can negotiate via chat, but the contract
  // detail is the developer's alone. So `by:"agency"` proposals are rejected here, fail-closed — not merely
  // hidden in the UI (the /agency "Propose your own" form was removed but a crafted request must bounce too).
  const s = body.seal;
  if (!s || typeof s !== "object") {
    return NextResponse.json({ error: "seal required" }, { status: 400 });
  }
  const agency = typeof s.agency === "string" ? s.agency.trim() : "";
  const developer = typeof s.developer === "string" ? s.developer.trim() : "";
  const by = s.by === "developer" ? "developer" : null;
  const buildings = parseBuildings(s.buildings);
  if (s.by === "agency") {
    return NextResponse.json(
      { error: "an agency cannot author an agreement — join a developer's published terms instead" },
      { status: 403 }
    );
  }
  if (!developer || !by || !buildings) {
    return NextResponse.json(
      { error: "seal needs developer, by (developer), buildings[{buildingId, commissionPct 0..100, scope}]" },
      { status: 400 }
    );
  }
  // A publish (dev, no agency) is allowed; every other mode requires a named counterparty.
  const isPublish = by === "developer" && !agency;
  if (!isPublish && !agency) {
    return NextResponse.json({ error: "agency required unless publishing" }, { status: 400 });
  }
  //  fix #2 — the DURABILITY guard, server-side. A developer+agency pair that already has a LIVE
  // agreement (proposed/agreed) can't have a second one created over it (that was how new terms could be
  // slipped over a signed, durable agreement). The UI guarded this on /node only; this covers the
  // agency Mode-3 path and any direct API caller too. A new agreement needs the old one ended first.
  if (!isPublish) {
    const existing = await liveAgreementBetween(developer, agency);
    if (existing) {
      return NextResponse.json(
        { error: "a live agreement already exists between these parties", existingId: existing.id },
        { status: 409 }
      );
    }
  }
  const seal: AgreementSeal = {
    agency,
    developer,
    buildings,
    terms: typeof s.terms === "string" ? s.terms : "",
    by,
    proposedAt: typeof s.proposedAt === "number" ? s.proposedAt : Date.now(),
  };
  const agreement = await proposeAgreement(seal);
  const pub = await publicAgreement(agreement);
  return NextResponse.json({ agreement: pub, verified: pub.verified });
}
