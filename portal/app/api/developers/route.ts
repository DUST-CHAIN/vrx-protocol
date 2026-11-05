// /api/developers — read a developer's off-chain registry row + let a desk set its HOUSE ORG (§9 step 9)
// and its HOUSE-DEFAULT buyer-default / termination clause numbers (§config-surface).
//
//   GET  ?account=<dev>             — the developer's row (name, buildingIds, directSaleThresholdUsd, houseOrgAccount,
//                                      terminationTerms + the RESOLVED effective buyer-default numbers for the editor).
//   POST { caller, houseOrgAccount } — the developer sets its own house-org account id (the on-chain org the
//                                      direct-sale firm-hold is granted to). caller MUST equal the account it edits
//                                      (self-scoped). This only RECORDS the id — the on-chain register_org (owner)
//                                      + grant_gate (developer) are separate signed txs; this is the off-chain link.
//   POST { caller, terminationTerms } — the developer sets its HOUSE-DEFAULT buyer-default clause numbers
//                                      (threshold %, cure-day floor, interest % p.a.) for the §Default-and-
//                                      Termination section of its buyers' S&Ps. Self-scoped. A blank/invalid field
//                                      is dropped (→ inherits the code default); terminationTerms:null clears it.
//                                      These are the DEVELOPER's OWN terms toward buyers — NOT VRX's fee/settlement
//                                      terms (those are VRX-root-set, a separate surface). A key is only touched
//                                      when present, so the two POST shapes don't clobber each other.
//
// AUTH (this slice): capability-based (caller names its own account), consistent with the sibling direct routes.
// -safe: this route only reads/writes the off-chain registry — it signs nothing. A neutral account id.

import { NextResponse } from "next/server";
import { getDeveloper, saveDeveloper } from "@/lib/developers";
import { cleanTerminationTerms, resolveTerminationChain } from "@/lib/termination-terms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim() || "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  const dev = await getDeveloper(account);
  if (!dev) return NextResponse.json({ developer: null });
  // The RESOLVED effective house-default buyer-default numbers (developer tier over the code default) so the
  // editor can show "currently 12.5% (code default)" vs an explicit override without re-deriving on the client.
  const effectiveTerminationTerms = resolveTerminationChain(undefined, dev.terminationTerms);
  return NextResponse.json({ developer: dev, effectiveTerminationTerms });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  if (!caller) return NextResponse.json({ error: "caller required" }, { status: 400 });

  const dev = await getDeveloper(caller);
  if (!dev) return NextResponse.json({ error: "not a registered developer" }, { status: 403 });

  // Self-scoped: a developer edits only its own row. (The caller IS the subject — capability auth.) Each field
  // is touched ONLY when its key is present in the body, so the house-org POST and the termination-terms POST
  // never clobber one another (a terms save leaves houseOrgAccount untouched, and vice-versa).
  const next = { ...dev };

  if ("houseOrgAccount" in body) {
    const houseOrgAccount = typeof body.houseOrgAccount === "string" ? body.houseOrgAccount.trim() : "";
    next.houseOrgAccount = houseOrgAccount || undefined;
  }

  if ("terminationTerms" in body) {
    // null/invalid → cleared (inherits the code default). A valid partial is stored field-by-field.
    const cleaned = cleanTerminationTerms(body.terminationTerms);
    next.terminationTerms = cleaned ?? undefined;
  }

  await saveDeveloper(next);
  const updated = await getDeveloper(caller);
  const effectiveTerminationTerms = resolveTerminationChain(undefined, updated?.terminationTerms);
  return NextResponse.json({ developer: updated, effectiveTerminationTerms });
}
