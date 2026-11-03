// /api/sp-reconciliation — the digital→paper S&P reconciliation surface (Slice 5). SERVER-ONLY.
//
// The digital S&P is PROVISIONAL until the signed PAPER is scanned back. This route lets the
// building's DEVELOPER ADMIN (a) record the scanned paper (seal + OTS-anchor + AI read-back) and (b) attest it
// MATCHES the system terms, or record a VARIANCE (the real agreed terms) so payment tracking stays correct. A
// deal PARTICIPANT (buyer or developer) may READ the reconciliation status.
//
//   GET  ?requestId=&account=            -> { record, anchor } (participant-gated)
//   POST { action:"record_scan", requestId, conversationId, building, by, scanDocId, scanPayload, readBackTerms }
//          -> { ok, record }           (developer-admin + ownership gated)
//   POST { action:"attest", requestId, building, by, outcome:"match"|"variance", variance? }
//          -> { ok, record }           (developer-admin + ownership gated)
//
// ── AUTHORIZATION (pattern — requireCaller + ownership) ────────────────────────────────────────────
//   • The acting account is the PROVEN caller (requireCaller), never a trusted body field (the VRX-0001 IDOR class).
//   • record_scan + attest are OWNERSHIP-gated: the proven caller must be the building's desk developer
//  (callerOwnsBuilding) — only the developer who signed the paper may seal + attest it (VRX records the
//     attestation; it does not authorize it, the route does).
//   • GET is PARTICIPANT-gated: either party to the deal may read the status (it carries no counterparty PII — the
//     terms are the deal's own B2B money facts, already shared between the two sides).
//
// PRIVACY: the store holds the sealed scan HASH (never bytes/PII on-chain), the neutral deal UID, and the
// structured terms (the deal's own data). The anchor carries only the hash + the kind + the UID.

import { NextResponse } from "next/server";
import { requireCaller } from "@/lib/caller";
import { callerOwnsBuilding } from "@/lib/catalog-edit-gate";
import { directRole } from "@/lib/conversations-direct";
import {
  recordScannedSp,
  attestReconciliation,
  reconciliationWithAnchor,
  type ReconcileTermLine,
} from "@/lib/sp-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const terms = (v: unknown): ReconcileTermLine[] =>
  Array.isArray(v)
    ? v
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r) => ({ label: str(r.label), value: str(r.value) }))
        .filter((r) => r.label && r.value)
    : [];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestId = str(url.searchParams.get("requestId"));
  const claimed = str(url.searchParams.get("account"));
  if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });

  // Bind the reader to the proven session, then confirm they're a party to THIS deal (the record carries the
  // conversationId; a reconciliation that doesn't exist yet is implicitly provisional → anyone proven can see "none").
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });

  const { record, anchor } = await reconciliationWithAnchor(requestId);
  if (record) {
    const role = await directRole(record.conversationId, who.account);
    if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, record, anchor });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = str(body.action);
  const requestId = str(body.requestId);
  const building = str(body.building);
  const claimedBy = str(body.by);
  if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });

  // Bind to the proven caller, then OWNERSHIP-gate: only the building's desk developer may record/attest.
  const who = requireCaller(req, { param: claimedBy });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const by = who.account;
  if (!building) return NextResponse.json({ error: "building required" }, { status: 400 });
  if (!(await callerOwnsBuilding(by, building))) {
    return NextResponse.json({ error: "only the building's developer may reconcile its S&P" }, { status: 403 });
  }

  if (action === "record_scan") {
    const conversationId = str(body.conversationId);
    const scanDocId = str(body.scanDocId);
    const scanPayload = body.scanPayload && typeof body.scanPayload === "object" ? body.scanPayload : str(body.scanPayload);
    if (!conversationId || !scanDocId || !scanPayload) {
      return NextResponse.json({ error: "conversationId + scanDocId + scanPayload required" }, { status: 400 });
    }
    const res = await recordScannedSp({
      requestId,
      conversationId,
      building,
      scanDocId,
      scanPayload: scanPayload as Record<string, unknown> | string,
      readBackTerms: terms(body.readBackTerms),
    });
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 });
    return NextResponse.json({ ok: true, record: res.record });
  }

  if (action === "attest") {
    const outcome = str(body.outcome);
    if (outcome !== "match" && outcome !== "variance") {
      return NextResponse.json({ error: "outcome must be match|variance" }, { status: 400 });
    }
    const res = await attestReconciliation({
      requestId,
      attestedBy: by,
      outcome,
      variance: outcome === "variance" ? terms(body.variance) : undefined,
    });
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 });
    return NextResponse.json({ ok: true, record: res.record });
  }

  return NextResponse.json({ error: "unknown action (record_scan|attest)" }, { status: 400 });
}
