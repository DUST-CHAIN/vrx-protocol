// GET ?account=<acct> → { profile, verified } — ONE actor's PUBLIC profile (name/region/role/vetted
// age) + its ✓ Vetted re-hash result. Safe to serve to a counterparty for the
// cards. Returns { profile: null } if unvetted.
// GET (no params) → { profiles: [...public] } — all vetted actors' public profiles (for the card
// lists). Public-safe projection only (no notes/salt).
// POST { identity, notes } → ROOT-ONLY: set/correct a profile. Operator-gated (x-vrx-operator header vs
// VRX_OPERATOR_SECRET) — the SAME convention as /api/applications. There is NO
// user write path by design: immutable by the user, corrigible by root).
// AUTH: the write is operator-gated (root sets KYC at vetting / on an approved change request). Reads are
// public-safe (name/region only — the point of a vetting card is that counterparties can see who they're
// dealing with). The raw notes + salt never leave the server.
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: ProfileRole[] = ["developer", "agency", "agent"];

// Operator gate (review fix #3) — FAIL CLOSED. Profiles are root-set KYC that ✓ Vetted leans on
//, so a write must prove the operator secret. Previously an UNSET secret meant "open", which in
// production (where the env var might simply be missing) let anyone self-vet with any legal name. Now: if no
// secret is configured, writes are DENIED — unless VRX_DEMO_OPEN=1 is explicitly set, the deliberate local-
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
  const profiles = (await listProfiles()).map(publicProfile);
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
