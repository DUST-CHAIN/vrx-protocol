// /api/root/overview — the GOD'S-EYE read for the VRX Root relationships dashboard.
// This is the operational console behind the "trusted marketplace with a HUMAN team" promise: it lets the
// VRX team see who's connected to who, each agreement's status + expiry, who still needs attention (pending
// KYC, open invitations, ungated agencies), and which deals have stalled so the team can nudge.
// WHY A NEW ENDPOINT (not the party routes): every other read was deliberately scoped to a PARTY
// (agreements `?party=` requires viewer===party; `?id=` requires being a party). Root is NOT a party to any
// agreement, so it legitimately needs the opposite — an aggregate across ALL parties. That is exactly the
// kind of read that must be OPERATOR-GATED, never party-facing, or it would leak every pair's private
// relationship. So: same fail-closed operator gate as /api/profiles + /api/applications (x-vrx-operator vs
// VRX_OPERATOR_SECRET, or the explicit local VRX_DEMO_OPEN=1 escape hatch). No wallet-sig infra here yet.
// PRIVACY (fix #1): the response is a God's-eye projection but STILL salt-stripped — agreements go
// through publicAgreement so the secret salt never leaves the server. KYC is the public profile
// projection (name/region, no notes/salt). The team seeing names here is the whole point (they act on them),
// but the cryptographic secrets stay server-side.

import { NextResponse } from "next/server";
import { listProfiles, publicProfile, type ProfileRole } from "@/lib/profiles";
import { listAgents, agencyOf } from "@/lib/agents";
import { listGates } from "@/lib/gates";
import { listApplications } from "@/lib/applications";
import { listDevelopers } from "@/lib/developers";
import { getCatalog } from "@/lib/catalog";
import { allOffers } from "@/lib/offers";
import {
  listAllAgreements,
  publicAgreement,
  agreementExpiry,
  type Agreement,
} from "@/lib/agreements";
import { resolveStandingForDeveloper, standingCopy } from "@/lib/dev-standing";
import { misrepresentationTrigger } from "@/lib/misrepresentation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical posture to /api/profiles + /api/applications (fix #3). A root
// overview is the single most sensitive read in the system (it crosses every party boundary), so an unset
// secret must DENY, not open. The explicit VRX_DEMO_OPEN=1 flag is the deliberate local-demo escape hatch.
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

// A proposal sitting untouched this long is "stalled" — surfaced so the human team can nudge the party whose
// turn it is. 7 days is a reasonable demo default; a real deploy can tune it.
const STALLED_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = Date.now();

  // ── Load every off-chain store the team acts on (all server-side, no chain reads) ──
  const [profiles, agents, gates, applications, developers, allAgreements, catalog, offers] = await Promise.all([
    listProfiles(),
    listAgents(),
    listGates(),
    listApplications(),
    listDevelopers(),
    listAllAgreements(),
    getCatalog(),
    allOffers(),
  ]);

  // Building id → display name, so the agreement rows show "Miracle Tower" not raw "miracle-tower" ( polish).
  const buildingName = new Map(catalog.map((b) => [b.id, b.name]));

  // Quick lookups.
  const profileByAccount = new Map(profiles.map((p) => [p.account.toLowerCase(), p]));
  const nameOf = (account: string): string =>
    profileByAccount.get(account.trim().toLowerCase())?.legalName || account;

  // ── People: the vetted actors, grouped by role, each with its public KYC (name/region) ──
  const people = profiles.map((p) => ({
    ...publicProfile(p),
    verified: true, // listProfiles only returns stored profiles; the ✓ seal itself is per-record, shown on agreements
  }));
  const byRole = (role: ProfileRole) => people.filter((p) => p.role === role);

  // ── The relationship GRAPH: developer → its agencies (via active gates) → each agency's agents ──
  // Built from the developer REGISTRY (who owns buildings) joined to gates + agents. Agencies that are
  // vetted but NOT gated to a developer still appear (as "no access yet") so the team can see who to open up.
  const agentsByAgency = new Map<string, { account: string; name: string }[]>();
  for (const a of agents) {
    const key = a.agency.trim().toLowerCase();
    const list = agentsByAgency.get(key) ?? [];
    list.push({ account: a.account, name: nameOf(a.account) });
    agentsByAgency.set(key, list);
  }

  const activeGates = gates.filter((g) => g.active);
  const agenciesGatedTo = (dev: string) =>
    activeGates.filter((g) => g.developer.toLowerCase() === dev.toLowerCase()).map((g) => g.agency);

  // ── PER-PARTY COUNTS for the two badges ──────────────────────────────────────────────────────────
  // • inBooking = RECORDED BOOKINGS in flight (what we track today). Transient/live → the amber pulsing badge.
  // • sold = CONFIRMED SALES per the model (booked AND unavailable > 2 weeks → billable). Settled →
  // the green static badge. The authoritative figure needs the WATCHLIST (an on-chain
  // availability + dwell check) which is NOT built yet, so sold is 0 for now; the plumbing is
  // ready end-to-end so it lights up the moment lands. (A badge only renders when > 0.)
  // An offer is booked by `seal.by` (an agent or the agency itself) against a developer; an agent's counts
  // roll up to its agency too.
  const inBookingByAccount = new Map<string, number>();
  const soldByAccount = new Map<string, number>();
  const bumpInto = (m: Map<string, number>, acct: string) => m.set(acct.toLowerCase(), (m.get(acct.toLowerCase()) ?? 0) + 1);
  for (const o of offers) {
    const booker = o.seal.by;
    const ag = await agencyOf(booker);
    const parties = [o.developer, booker, ...(ag && ag.toLowerCase() !== booker.toLowerCase() ? [ag] : [])];
    for (const party of parties) bumpInto(inBookingByAccount, party);
    // sold rule (placeholder — authoritative version pends the watchlist / on-chain availability check):
    // none counted yet. Left as the single seam to flip on in the build.
    const isConfirmedSold = false; // TODO: booked && unavailable > 2 weeks
    if (isConfirmedSold) for (const party of parties) bumpInto(soldByAccount, party);
  }
  const inBookingOf = (acct: string) => inBookingByAccount.get(acct.toLowerCase()) ?? 0;
  const soldOf = (acct: string) => soldByAccount.get(acct.toLowerCase()) ?? 0;

  // Developer → the building NAMES it owns (resolved once; reused for each agency's "can book" tooltip).
  const devBuildingNames = new Map(
    developers.map((d) => [d.account.toLowerCase(), d.buildingIds.map((id) => buildingName.get(id) ?? id)])
  );
  // For an agency: the buildings it can BOOK = those from developers that gated it, grouped by developer.
  const bookableFor = (agencyAcct: string) =>
    developers
      .filter((d) => activeGates.some((g) => g.active && g.agency.toLowerCase() === agencyAcct.toLowerCase() && g.developer.toLowerCase() === d.account.toLowerCase()))
      .map((d) => ({ developerName: nameOf(d.account), buildings: devBuildingNames.get(d.account.toLowerCase()) ?? [] }))
      .filter((x) => x.buildings.length > 0);

  const graph = developers.map((dev) => {
    const gatedAgencyAccounts = agenciesGatedTo(dev.account);
    const gatedSet = new Set(gatedAgencyAccounts.map((a) => a.toLowerCase()));
    // Every vetted agency; flag whether this developer has granted it access.
    const agencies = byRole("agency").map((ag) => ({
      account: ag.account,
      name: ag.legalName,
      region: ag.region,
      gated: gatedSet.has(ag.account.toLowerCase()),
      inBooking: inBookingOf(ag.account),
      sold: soldOf(ag.account),
      bookable: bookableFor(ag.account), // [{developerName, buildings[]}] — for the hover tooltip
      agents: (agentsByAgency.get(ag.account.toLowerCase()) ?? []).map((a) => ({
        ...a, inBooking: inBookingOf(a.account), sold: soldOf(a.account),
      })),
    }));
    return {
      account: dev.account,
      name: nameOf(dev.account),
      buildingIds: dev.buildingIds,
      inBooking: inBookingOf(dev.account),
      sold: soldOf(dev.account),
      agencies,
    };
  });

  // ── Agreements: salt-stripped + verified + computed expiry ──
  const pubAgreements = await Promise.all(
    allAgreements.map(async (g) => {
      const pub = await publicAgreement(g);
      const expiry = agreementExpiry(g, now);
      return {
        ...pub,
        agencyName: g.seal.agency ? nameOf(g.seal.agency) : null,
        developerName: nameOf(g.seal.developer),
        expiry,
        seal: {
          ...pub.seal,
          buildings: pub.seal.buildings.map((b) => ({ ...b, buildingName: buildingName.get(b.buildingId) ?? b.buildingId })),
        },
      };
    })
  );

  // ── "Needs attention" roll-ups the team works from ──
  const vettedAccounts = new Set(profiles.map((p) => p.account.toLowerCase()));

  // Open invitations: agency applications still awaiting the team (invited = link out, applied = vet now).
  const openInvitations = applications
    .filter((a) => a.status === "invited" || a.status === "applied")
    .map((a) => ({
      token: a.token,
      status: a.status,
      label: a.label ?? null,
      account: a.account ?? null,
      updatedAt: a.updatedAt,
      expiresAt: a.expiresAt,
    }));

  // Pending KYC: actors referenced by the graph (gated agencies, their agents, the developers) that have
  // NO vetted profile yet — the team still owes them a KYC record. (A relationship exists without identity.)
  const referenced = new Set<string>();
  for (const dev of developers) referenced.add(dev.account.toLowerCase());
  for (const g of activeGates) referenced.add(g.agency.toLowerCase());
  for (const a of agents) {
    referenced.add(a.account.toLowerCase());
    referenced.add(a.agency.toLowerCase());
  }
  const pendingKyc = [...referenced]
    .filter((acct) => !vettedAccounts.has(acct))
    .map((acct) => {
      // Best-effort role hint from where we saw it.
      const isDev = developers.some((d) => d.account.toLowerCase() === acct);
      const isAgent = agents.some((a) => a.account.toLowerCase() === acct);
      return { account: acct, roleHint: isDev ? "developer" : isAgent ? "agent" : "agency" };
    });

  // Stalled deals: a proposal untouched for > STALLED_MS. Names the party whose turn it is to respond.
  const stalledDeals = allAgreements
    .filter((g: Agreement) => g.status === "proposed" && now - g.updatedAt > STALLED_MS)
    .map((g) => {
      // The waiting party is the COUNTERPARTY of whoever proposed.
      const waitingOn = g.seal.by === "agency" ? g.seal.developer : g.seal.agency;
      return {
        id: g.id,
        developer: g.seal.developer,
        developerName: nameOf(g.seal.developer),
        agency: g.seal.agency,
        agencyName: g.seal.agency ? nameOf(g.seal.agency) : null,
        proposedBy: g.seal.by,
        waitingOn,
        waitingOnName: nameOf(waitingOn),
        sinceDays: Math.floor((now - g.updatedAt) / (24 * 60 * 60 * 1000)),
      };
    });

  const expiringAgreements = pubAgreements
    .filter((a) => a.expiry.expiringSoon || a.expiry.expired)
    .map((a) => ({
      id: a.id,
      developer: a.seal.developer,
      developerName: a.developerName,
      agency: a.seal.agency,
      agencyName: a.agencyName,
      expiresAt: a.expiry.expiresAt,
      expired: a.expiry.expired,
    }));

  // Ungated agencies: vetted agencies with no active gate anywhere — fully onboarded but can't work yet.
  const gatedAgencySet = new Set(activeGates.map((g) => g.agency.toLowerCase()));
  const ungatedAgencies = byRole("agency")
    .filter((ag) => !gatedAgencySet.has(ag.account.toLowerCase()))
    .map((ag) => ({ account: ag.account, name: ag.legalName, region: ag.region }));

  // Adverse standing (§3c,: developers NOT in good standing — late paying VRX and/or asserted to
  // have misrepresented a listing. The StandingPanel lets the team act on ONE developer at a time; THIS is the
  // proactive roll-up so a flagged/late developer surfaces in "Needs attention" without the team polling each
  // one. Resolve the SAME way the /root console does: the §3c resolver, fed the misrepresentation trigger from
  // the operator store. Only non-`good` developers are included; sorted most-severe first so the worst
  // (removed → suspended → grace) sit at the top. All off-chain (reads receipts + earmark + the store).
  const stageRank: Record<string, number> = { removed: 3, suspended: 2, grace: 1, good: 0 };
  const adverseStanding = (
    await Promise.all(
      developers.map(async (dev) => {
        const misrepresentation = (await misrepresentationTrigger(dev.account)) ?? undefined;
        const standing = await resolveStandingForDeveloper(dev.account, { asOf: now, misrepresentation });
        if (standing.stage === "good") return null;
        return {
          developer: dev.account,
          developerName: nameOf(dev.account),
          stage: standing.stage,
          reasons: standing.reasons,
          note: standingCopy(standing),
          overdueUnpaidCount: standing.overdueUnpaidCount,
          suspendsAt: standing.suspendsAt ?? null,
          removesAt: standing.removesAt ?? null,
          listingsHidden: standing.listingsHidden,
        };
      })
    )
  )
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (stageRank[b.stage] ?? 0) - (stageRank[a.stage] ?? 0));

  return NextResponse.json({
    counts: {
      developers: byRole("developer").length,
      agencies: byRole("agency").length,
      agents: byRole("agent").length,
      agreements: allAgreements.length,
    },
    // The flat party list the Relation Browser's LEFT picker renders (grouped by role client-side).
    // Already computed above for the graph — returned here so the picker needs no extra call. Public
    // projection only (name/region/role/vettedAt; no notes/salt) + the same inBooking/sold counts the graph
    // badges use, so the roster can show matching badges (agents = in-booking, agencies = sold).
    people: people.map((p) => ({ ...p, inBooking: inBookingOf(p.account), sold: soldOf(p.account) })),
    graph,
    agreements: pubAgreements,
    attention: {
      adverseStanding,
      openInvitations,
      pendingKyc,
      stalledDeals,
      expiringAgreements,
      ungatedAgencies,
    },
  });
}
