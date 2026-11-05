// /api/profiles — the immutable KYC profile store (the design docs §2).
//
//   GET  ?account=<acct>   → { profile, verified } — ONE actor's PUBLIC profile (name/region/role/vetted
//                            age) + its ✓ Vetted re-hash result. Safe to serve to a counterparty for the
//  cards. Returns { profile: null } if unvetted.
//   GET  (no params)       → { profiles: [...public] } — all vetted actors' public profiles (for the card
//                            lists). Public-safe projection only (no notes/salt).
//   POST { identity, notes } → ROOT-ONLY: set/correct a profile. Operator-gated (x-vrx-operator header vs
//                            VRX_OPERATOR_SECRET) — the SAME convention as /api/applications. There is NO
//  user write path by design (immutable by the user, corrigible by root).
//
// AUTH: the write is operator-gated (root sets KYC at vetting / on an approved change request). Reads are
// public-safe (name/region only — the point of a vetting card is that counterparties can see who they're
// dealing with). The raw notes + salt never leave the server.
//
// PRIVACY: no PII plaintext on-chain. This off-chain store holds the KYC; the chain carries at most a
// salted hash when a record that embeds this identity is later stamped. Honest trusted-root caveat
// lives in lib/profiles.ts.

import { NextResponse } from "next/server";
import {
  getProfile,
  listProfiles,
  publicProfile,
  setProfile,
  verifyProfile,
  type ProfileIdentity,
  type ProfileRole,
} from "@/lib/profiles";
import { imagesFor } from "@/lib/account-images";
import { listDevelopers } from "@/lib/developers";
import { listAgents } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: ProfileRole[] = ["developer", "agency", "agent"];

// Operator gate (review fix #3) — FAIL CLOSED. Profiles are root-set KYC that ✓ Vetted leans on
// so a write must prove the operator secret. Previously an UNSET secret meant "open", which
// production (where the env var might simply be missing) let anyone self-vet with any legal name. Now: if no
// secret is configured, writes are DENIED — unless VRX_DEMO_OPEN=1 is explicitly set, the deliberate local-
// demo escape hatch. (Document VRX_OPERATOR_SECRET as required for any real deploy — see the design docs.)
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1"; // no secret → closed, unless explicit demo flag
  return req.headers.get("x-vrx-operator") === secret;
}

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account")?.trim();
  if (account) {
    const p = await getProfile(account);
    if (!p) return NextResponse.json({ profile: null, verified: false });
    return NextResponse.json({ profile: publicProfile(p), verified: verifyProfile(p) });
  }
  // List form (card lists / the landing full-cast roster): the public projection PLUS, per actor, the ✓ Vetted
  // re-hash result and the public portrait icon URL — so the roster can render a SEALED avatar (ring + ✓) next
  // to each name (: show vetting visually where you see other actors). Portrait icon is public by
  // design (the avatar); `verified` drives whether the seal ring is shown. No sensitive data added.
  const raw = await listProfiles();
  // contentScore: a cheap "how much does this actor own/run" number so the landing full-cast
  // roster can order each role by richness (busiest first) instead of store order — which was floating the
  // thin dev-signer (node.test.near, 0 buildings) to the TOP of the developers. Registry-backed + honest:
  //   developer → number of buildings it lists · agency → number of agents under it · agent → verified(1)|0.
  // Agents have no cheap per-actor deal count in a registry (offers are sealed), so verified-first is the
  // stable tiebreak the client applies; score stays 0/1 for them. No sensitive data — all public handles.
  const [devs, agents] = await Promise.all([listDevelopers().catch(() => []), listAgents().catch(() => [])]);
  const buildingsByDev = new Map(devs.map((d) => [d.account, d.buildingIds?.length ?? 0]));
  const agentsByAgency = new Map<string, number>();
  for (const a of agents) agentsByAgency.set(a.agency, (agentsByAgency.get(a.agency) ?? 0) + 1);
  const scoreOf = (p: { account: string; role: string; verified?: boolean }): number =>
    p.role === "developer" ? buildingsByDev.get(p.account) ?? 0
    : p.role === "agency" ? agentsByAgency.get(p.account) ?? 0
    : p.verified ? 1 : 0; // agent: verified-first
  const profiles = await Promise.all(
    raw.map(async (p) => {
      const img = await imagesFor(p.account).catch(() => null);
      const pub = publicProfile(p);
      const verified = verifyProfile(p);
      return {
        ...pub,
        verified,
        portraitUrl: img?.portrait ? `/api/images/${img.portrait}?variant=icon` : null,
        contentScore: scoreOf({ account: pub.account, role: pub.role, verified }),
      };
    })
  );
  return NextResponse.json({ profiles });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const i = body.identity;
  if (!i || typeof i !== "object") {
    return NextResponse.json({ error: "identity required" }, { status: 400 });
  }
  const account = typeof i.account === "string" ? i.account.trim() : "";
  const role = ROLES.includes(i.role) ? (i.role as ProfileRole) : null;
  const legalName = typeof i.legalName === "string" ? i.legalName.trim() : "";
  const region = typeof i.region === "string" ? i.region.trim() : "";
  if (!account || !role || !legalName || !region) {
    return NextResponse.json(
      { error: "identity needs account, role (developer|agency|agent), legalName, region" },
      { status: 400 }
    );
  }
  const identity: ProfileIdentity = { account, role, legalName, region };
  const notes = typeof body.notes === "string" ? body.notes : undefined;
  const setBy = typeof body.setBy === "string" ? body.setBy : undefined;
  const profile = await setProfile(identity, { notes, setBy });
  return NextResponse.json({ profile: publicProfile(profile), verified: verifyProfile(profile) });
}
