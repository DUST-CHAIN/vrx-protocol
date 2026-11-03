// GET /api/agencies?developer=<accountId>
//  → the roster a DEVELOPER picks from when setting up an agreement directly for an agency (Mode 1).
//
// Returns every KYC-vetted AGENCY on the platform (public-safe profile projection — name/region), each
// flagged `gated:true` if this developer already has an ACTIVE access gate to it. The badge lets the
// developer tell "an agency I already work with" from "a new agency I'm onboarding" without exposing
// anything private — it's the mirror of /api/agent/developers (which scopes the agency's view to its gated
// developers). Here the developer sees ALL vetted agencies because a developer may legitimately want to
// onboard a NEW agency it knows of — discovery among already-vetted parties, not a leak.
//
// PRIVACY: public-safe fields only (account/role/legalName/region/vettedAt) — no notes/salt. The
// gate flag is derived from OUR write-through gate store (lib/gates.ts), not a chain read.

import { NextResponse } from "next/server";
import { listProfiles, publicProfile } from "@/lib/profiles";
import { agenciesForDeveloper } from "@/lib/gates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const developer = new URL(req.url).searchParams.get("developer")?.trim();

  const profiles = await listProfiles();
  const agencies = profiles.filter((p) => p.role === "agency").map(publicProfile);

  // Which of them this developer already has an active gate to (lowercased set for case-insensitive match).
  const gatedSet = developer
    ? new Set((await agenciesForDeveloper(developer)).map((a) => a.toLowerCase()))
    : new Set<string>();

  const roster = agencies.map((a) => ({ ...a, gated: gatedSet.has(a.account.toLowerCase()) }));
  return NextResponse.json({ agencies: roster });
}
