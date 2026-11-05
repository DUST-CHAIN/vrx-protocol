// /api/root/party?account=<acct> — ONE party's full relation card for the Relation Browser.
//
// The browser (a new top section on /root) is master-detail: the LEFT picker lists every party; selecting
// one calls THIS endpoint for that party's relation card, which the RIGHT pane renders. Every related party
// in the card is itself clickable → re-calls this endpoint for THAT account → you navigate the web.
//
// WHY A SEPARATE ENDPOINT (not fold into /overview): keeps the overview payload lean (it already ships the
// whole `people` list the picker needs) and lazy-loads the heavier per-party join only on select. Same
// operator gate + fail-closed posture as /overview — this is still a God's-eye, cross-party read that must
// NEVER be party-facing (it would show one party another party's buildings/agreements).
//
// PRIVACY: salt NEVER served (agreements go through publicAgreement). KYC is the PUBLIC profile
// projection — name/region/vetted only; the `notes`/contact field is DELIBERATELY NOT surfaced, even to root
// (the call, RELATION_BROWSER_SPEC §5a). Live DEALS are reported as a PRESENCE COUNT only — THAT a deal
// exists + how many, never the chat bodies or the deal terms (§5b). The count doubles as a reconciliation
// CHECKSUM against the eventual watchlist-based commission accrual.

import { NextResponse } from "next/server";
import { listProfiles, getProfile, publicProfile, type Profile, type ProfileRole } from "@/lib/profiles";
import { listAgents, agencyOf } from "@/lib/agents";
import { listGates } from "@/lib/gates";
import {
  listDevelopers, getDeveloper, saveDeveloper, protocolFeePct, vrxSettleWorkingDays,
  DEFAULT_PROTOCOL_FEE_PCT, DEFAULT_VRX_SETTLE_WORKING_DAYS, type Developer,
} from "@/lib/developers";
import { getCatalog } from "@/lib/catalog";
import { allOffers } from "@/lib/offers";
import { listAllAgreements, publicAgreement, agreementExpiry } from "@/lib/agreements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical posture to /api/root/overview (fix #3).
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

const lc = (s: string) => s.trim().toLowerCase();

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const account = (new URL(req.url).searchParams.get("account") ?? "").trim();
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  const now = Date.now();

  const [profiles, agents, gates, developers, catalog, offers, allAgreements] = await Promise.all([
    listProfiles(),
    listAgents(),
    listGates(),
    listDevelopers(),
    getCatalog(),
    allOffers(),
    listAllAgreements(),
  ]);

  const profileByAccount = new Map(profiles.map((p) => [lc(p.account), p]));
  const nameOf = (acct: string): string => profileByAccount.get(lc(acct))?.legalName || acct;
  // Building id → display name (RELATION_BROWSER_SPEC §server: resolve raw ids like "miracle-tower" → "Miracle Tower").
  const buildingName = new Map(catalog.map((b) => [b.id, b.name]));
  const resolveBuildings = (ids: string[]) => ids.map((id) => ({ id, name: buildingName.get(id) ?? id }));

  const profile = await getProfile(account);
  // Determine role: prefer the KYC profile; fall back to structural evidence (dev registry / agent registry).
  const isDev = developers.some((d) => lc(d.account) === lc(account));
  const isAgent = agents.some((a) => lc(a.account) === lc(account));
  const role: ProfileRole =
    profile?.role ?? (isDev ? "developer" : isAgent ? "agent" : "agency");

  const kyc = profile
    ? { ...publicProfile(profile), vetted: true as const }
    : { account, role, legalName: account, region: "", vettedAt: 0, vetted: false as const };

  const activeGates = gates.filter((g) => g.active);
  const agentsOfAgency = (agencyAcct: string) =>
    agents
      .filter((a) => lc(a.agency) === lc(agencyAcct))
      .map((a) => ({ account: a.account, name: nameOf(a.account) }));

  // ── Live-deal presence count (§5b) — PRESENCE ONLY, no bodies/terms. A recorded offer is a booking in
  // flight against a developer, booked by `seal.by` (an agent or the agency itself). Resolve the booker to
  // its agency so an agency sees deals its whole team has in flight. This count is the checksum. ──
  const bookerAgencyCache = new Map<string, string | null>();
  const agencyOfBooker = async (booker: string): Promise<string | null> => {
    const key = lc(booker);
    if (bookerAgencyCache.has(key)) return bookerAgencyCache.get(key)!;
    const ag = await agencyOf(booker);
    bookerAgencyCache.set(key, ag);
    return ag;
  };
  async function liveDealCount(): Promise<number> {
    if (role === "developer") {
      return offers.filter((o) => lc(o.developer) === lc(account)).length;
    }
    if (role === "agent") {
      return offers.filter((o) => lc(o.seal.by) === lc(account)).length;
    }
    // agency: offers booked by the agency itself OR by any agent that resolves to it.
    let n = 0;
    for (const o of offers) {
      if (lc(o.seal.by) === lc(account)) { n++; continue; }
      const bookerAgency = await agencyOfBooker(o.seal.by);
      if (bookerAgency && lc(bookerAgency) === lc(account)) n++;
    }
    return n;
  }

  // ── Agreements this party is on (either side), salt-stripped + expiry + resolved building names ──
  async function agreementsFor(acct: string) {
    const mine = allAgreements.filter(
      (g) => lc(g.seal.agency) === lc(acct) || lc(g.seal.developer) === lc(acct)
    );
    return Promise.all(
      mine.map(async (g) => {
        const pub = await publicAgreement(g);
        return {
          ...pub,
          agencyName: g.seal.agency ? nameOf(g.seal.agency) : null,
          developerName: nameOf(g.seal.developer),
          expiry: agreementExpiry(g, now),
          // resolve the per-building rate ids → names for display (private rate stays 🔒 in the UI).
          buildings: pub.seal.buildings.map((b) => ({
            ...b,
            buildingName: buildingName.get(b.buildingId) ?? b.buildingId,
          })),
        };
      })
    );
  }

  // ── Role-specific card ──────────────────────────────────────────────────────────────────────────────
  if (role === "developer") {
    const dev: Developer | null = await getDeveloper(account);
    const gatedAgencyAccounts = activeGates
      .filter((g) => lc(g.developer) === lc(account))
      .map((g) => g.agency);
    const gatedSet = new Set(gatedAgencyAccounts.map(lc));
    const allAgencies = profiles.filter((p) => p.role === "agency");
    const agenciesWithAccess = allAgencies
      .filter((a) => gatedSet.has(lc(a.account)))
      .map((a) => ({ account: a.account, name: a.legalName, region: a.region }));
    const agenciesNoAccess = allAgencies
      .filter((a) => !gatedSet.has(lc(a.account)))
      .map((a) => ({ account: a.account, name: a.legalName, region: a.region }));

    return NextResponse.json({
      account, role, kyc,
      liveDeals: await liveDealCount(),
      buildingsOwned: resolveBuildings(dev?.buildingIds ?? []),
      agenciesWithAccess,
      agenciesNoAccess,
      agreements: await agreementsFor(account),
      //  §config-surface — VRX's OWN commercial terms with this developer: the protocol fee
      // and the settlement window. VRX-ROOT sets these (distinct from the developer's buyer-default terms, which
      // the developer sets). `effective` = the resolved in-force value (override or code default); `override` =
      // the explicit per-developer value if set, else null → the editor shows "default" vs an explicit figure.
      vrxTerms: {
        protocolFeePct: {
          effective: protocolFeePct(dev),
          override: typeof dev?.protocolFeePct === "number" ? dev.protocolFeePct : null,
          default: DEFAULT_PROTOCOL_FEE_PCT,
        },
        vrxSettleWorkingDays: {
          effective: vrxSettleWorkingDays(dev),
          override: typeof dev?.vrxSettleWorkingDays === "number" ? dev.vrxSettleWorkingDays : null,
          default: DEFAULT_VRX_SETTLE_WORKING_DAYS,
        },
      },
    });
  }

  if (role === "agent") {
    const myAgency = await agencyOf(account);
    // An agent sees what its AGENCY can see (agents hold no gates of their own — honest).
    const agencyGatedDevs = myAgency
      ? activeGates.filter((g) => lc(g.agency) === lc(myAgency)).map((g) => g.developer)
      : [];
    const buildingsViaAgency = agencyGatedDevs.flatMap((devAcct) => {
      const d = developers.find((x) => lc(x.account) === lc(devAcct));
      return (d?.buildingIds ?? []).map((id) => ({
        id, name: buildingName.get(id) ?? id, viaDeveloper: nameOf(devAcct), developerAccount: devAcct,
      }));
    });
    return NextResponse.json({
      account, role, kyc,
      liveDeals: await liveDealCount(),
      agency: myAgency ? { account: myAgency, name: nameOf(myAgency) } : null,
      buildingsViaAgency,
      // Agents aren't parties to agreements — those are agency↔developer.
      agreements: [],
      agentNote: "Agents don't hold their own agreements — those are between the agency and the developer.",
    });
  }

  // agency (default)
  const myDevs = activeGates
    .filter((g) => lc(g.agency) === lc(account))
    .map((g) => g.developer);
  const myDevSet = new Set(myDevs.map(lc));
  // Which buildings this agency can see, GROUPED by developer (the ASK). Derived from its active gates.
  const buildingsVisible = developers
    .filter((d) => myDevSet.has(lc(d.account)))
    .map((d) => ({
      developerAccount: d.account,
      developerName: nameOf(d.account),
      buildings: resolveBuildings(d.buildingIds),
    }));

  return NextResponse.json({
    account, role, kyc,
    liveDeals: await liveDealCount(),
    buildingsVisible, // [] → "No building access yet."
    agents: agentsOfAgency(account),
    agreements: await agreementsFor(account),
  });
}

// ── POST — VRX-root sets a developer's VRX commercial terms (§config-surface) ─────────────
// Operator-only (same God's-eye fail-closed gate as GET). Sets the protocol fee % and/or the settlement window
// (working days) on the developer's record — VRX's OWN terms with that developer (NOT the developer's
// buyer-default terms, which the developer self-serves on /api/developers). A field is touched only when its
// key is present; a null/blank value CLEARS the override (→ the code default). Validated server-side so a bad
// payload can't corrupt the store. Signs nothing on-chain (off-chain registry write).
export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  const dev = await getDeveloper(account);
  if (!dev) return NextResponse.json({ error: "not a registered developer" }, { status: 404 });

  const next: Developer = { ...dev };

  // Protocol fee: a positive % ≤ 100 keeps; null/blank/invalid clears (→ code default).
  if ("protocolFeePct" in body) {
    const v = body.protocolFeePct;
    next.protocolFeePct =
      typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100 ? v : undefined;
  }
  // Settlement window: a positive integer keeps; null/blank/invalid clears (→ code default).
  if ("vrxSettleWorkingDays" in body) {
    const v = body.vrxSettleWorkingDays;
    next.vrxSettleWorkingDays =
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  }

  await saveDeveloper(next);
  const updated = await getDeveloper(account);
  return NextResponse.json({
    ok: true,
    vrxTerms: {
      protocolFeePct: {
        effective: protocolFeePct(updated),
        override: typeof updated?.protocolFeePct === "number" ? updated.protocolFeePct : null,
        default: DEFAULT_PROTOCOL_FEE_PCT,
      },
      vrxSettleWorkingDays: {
        effective: vrxSettleWorkingDays(updated),
        override: typeof updated?.vrxSettleWorkingDays === "number" ? updated.vrxSettleWorkingDays : null,
        default: DEFAULT_VRX_SETTLE_WORKING_DAYS,
      },
    },
  });
}
