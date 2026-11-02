// /api/vrx-developer-agreement — the developer SIGNS VRX's own disclosure terms ( + PAYMENT_LEDGER §7).
// The THIRD consumer of the attested-records spine after /api/offers and /api/agreements, and the
// developer-facing surface that turns 's pure lib/vrx-developer-agreement.ts into a real human action.
// Unlike /api/agreements (a two-party commission agreement an agency joins), this is a ONE-SIDED accept:
// VRX publishes standard disclosure terms (its OWN language — the fee + settlement clock, the accuracy
// compact, the §3c consequence routine, what continues, the upside), the developer READS them and SIGNS,
// attesting each building as true. There is no counter-offer — the terms are VRX's.
// GET ?developer=<acct>&viewer=<acct>
// → { current, terms, feePct, settleDays }
// current = the developer's CURRENT signed agreement (salt-stripped + ✓ Vetted), or null.
// terms = the LIVE disclosure copy to display (incl. the honest `draft` flag + version).
// feePct = the protocol fee % the developer WOULD agree to (snapshot from the Developer record,
// the single source — shown so the numbers are honest BEFORE signing).
// settleDays = the settlement window (working days) they would agree to.
// POST { developer, signOffs?: [{ buildingId, attested }] }
// → { agreement } — signs VRX's current terms with the per-building sign-offs. Developer-scoped.
// AUTH (this slice): capability-based, same posture as /api/agreements — the viewer/caller names its own
// account and must equal the developer subject (no wallet-sig infra in this demo layer). The agreement is
// VRX's own record with each developer, so the readable parties are that developer + VRX-root; here we scope
// to the developer themselves.
// PRIVACY: server-side only; the chain is untouched (the on-chain stamp is a later/defrost arc). The
// public projection strips the secret per-record salt. Neutral account ids only.

import { NextResponse } from "next/server";
import {
  currentVrxDeveloperAgreement,
  publicVrxDeveloperAgreement,
  signVrxDeveloperAgreement,
  VRX_DEVELOPER_TERMS,
  isValidBuildingId,
} from "@/lib/vrx-developer-agreement";
import { getDeveloper, protocolFeePct, vrxSettleWorkingDays } from "@/lib/developers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const developer = url.searchParams.get("developer")?.trim() || "";
  const viewer = url.searchParams.get("viewer")?.trim() || "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
  // Capability auth: the viewer must BE the developer whose agreement they read (same as /api/agreements
  // fix #1 — don't trust a caller-supplied account to read a party-private record).
  if (!viewer || viewer.toLowerCase() !== developer.toLowerCase()) {
    return NextResponse.json({ error: "viewer must match developer" }, { status: 403 });
  }

  const current = await currentVrxDeveloperAgreement(developer);
  const pub = current ? await publicVrxDeveloperAgreement(current) : null;

  // The fee + settlement window the developer WOULD agree to, read from the single source (the Developer
  // record resolvers, defaults applied). Shown with the terms so the numbers are honest before signing — the
  // same values signVrxDeveloperAgreement snapshots into the seal.
  const dev = await getDeveloper(developer);
  const feePct = protocolFeePct(dev);
  const settleDays = vrxSettleWorkingDays(dev);

  return NextResponse.json({ current: pub, terms: VRX_DEVELOPER_TERMS, feePct, settleDays });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const developer = typeof body.developer === "string" ? body.developer.trim() : "";
  const viewer = typeof body.viewer === "string" ? body.viewer.trim() : "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
  // Capability auth (same posture as GET above): the caller names its own account and must BE the developer
  // they sign as. Signing is a party-attributed WRITE with no lib-level actor scope (unlike the token ops,
  // whose lib enforces holder-scope) — so without this a caller could sign VRX's terms AS any developer.
  // The self-assertion becomes the real gate when the signing arc binds `viewer` to a wallet signature.
  if (!viewer || viewer.toLowerCase() !== developer.toLowerCase()) {
    return NextResponse.json({ error: "viewer must match developer" }, { status: 403 });
  }

  // Normalize the per-building sign-offs — drop malformed ids (an invalid id can't be a real attestation);
  // the lib validates + trims again, this is the defensive route-side pass.
  const rawSignOffs = Array.isArray(body.signOffs) ? body.signOffs : [];
  const signOffs = rawSignOffs
    .filter((s: unknown): s is { buildingId: unknown; attested: unknown } => !!s && typeof s === "object")
    .filter((s: { buildingId: unknown }) => isValidBuildingId(s.buildingId))
    .map((s: { buildingId: string; attested: unknown }) => ({
      buildingId: s.buildingId.trim(),
      attested: s.attested === true,
    }));

  const agreement = await signVrxDeveloperAgreement({ developer, signOffs });
  const pub = await publicVrxDeveloperAgreement(agreement);
  return NextResponse.json({ agreement: pub });
}
