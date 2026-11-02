// THE TWO HALVES of "this agency sells this developer's units" are set by SEPARATE flows with no link:
// • the ACCESS GATE (lib/gates) — the developer grant_gate lets the agency BOOK (the on-chain enforcement).
// • the commission AGREEMENT (lib/agreements) — the money relationship that makes those bookings EARN.
// They can drift apart: an agency can hold an active gate (can book) while NO live agreement exists (every
// sale there resolves to null commission — H2's `no_agreement`). That's a real, silent gap — the agency is
// selling but the terms that pay it were never set.
// This module answers ONE question honestly: for a developer, which gated agencies have NO live agreement?
// It is a READ-ONLY cross-check (no writes, no on-chain) — a surface (dashboard) or the seed harness reads it
// and flags "access granted, but commission terms not set". It does NOT auto-fix: granting access and setting
// terms stay deliberate, separate developer actions (the fix is to surface the drift, not to paper over it).
// "Live agreement" = the SAME truth commission reads: liveAgreementBetween (a proposed|agreed row between the
// two parties). A `published` open offer (empty agency, joinable) is NOT a live agreement with any specific
// agency, so an agency gated but only covered by a published offer still counts as "no agreement" here — which
// is correct: nobody has joined/agreed, so no sale by that agency would earn.: caller-facing copy lives in
// the surface, not here; this returns accounts + a machine reason.)

import { agenciesForDeveloper } from "./gates";
import { liveAgreementBetween } from "./agreements";

/** One gated agency that lacks a live commission agreement with the developer. */
export type GateAgreementGap = {
  developer: string;
  agency: string;
};

/**
 * The gated agencies for `developer` that have NO live (proposed|agreed) agreement with it — i.e. they can
 * book, but their sales can't earn because the money relationship was never established. Empty = consistent.
 * Pure read (gates + agreements stores only). Accounts are returned lowercased (gate-store grain).
 */
export async function agenciesWithGateButNoAgreement(developer: string): Promise<GateAgreementGap[]> {
  const dev = developer.trim().toLowerCase();
  if (!dev) return [];
  const gated = await agenciesForDeveloper(dev);
  const gaps: GateAgreementGap[] = [];
  const seen = new Set<string>();
  for (const agencyRaw of gated) {
    const agency = agencyRaw.trim().toLowerCase();
    if (!agency || seen.has(agency)) continue;
    seen.add(agency);
    const live = await liveAgreementBetween(dev, agency);
    if (!live) gaps.push({ developer: dev, agency });
  }
  return gaps;
}
