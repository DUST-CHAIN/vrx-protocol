// /api/term-requests — a buyer's ask for payment terms OUTSIDE the developer's acceptable range. The one
// terms case the overlay form + the AI desk cannot self-serve (only the developer may bend their own published
// rule), so it becomes a DEVELOPER-facing work item. Three shapes, mirroring the unit-grants auth posture:
//
//   POST   { account, building, milestone?, askedValue?, note? }  — the BUYER files a request (the overlay form's
//            "ask for different terms" note). Buyer-authorized: names ONLY their own account; the request is
//            scoped to the building's desk developer (resolved server-side). Posts a neutral note into the thread.
//   GET    ?developer=<me> [&all=1]                               — the DEVELOPER reads their OPEN term requests
//            (scoped to their buildings, newest-first). `all=1` includes resolved. (The /node panel source.)
//   PATCH  { caller, id, action:"resolve" }                       — the DEVELOPER marks a request resolved. caller
//            must own the request's building (deskDeveloperFor).
//
// AUTH: capability-based (the SAME posture as the sibling direct routes). The GET derives the developer from the
// PROVEN caller (requireCaller — a forgeable ?developer= is unreachable on a real deploy, Audit VRX-0004 pattern).
// PRIVACY: a term request carries only a neutral money structure + the buyer's note; NO sealed PII.

import { NextResponse } from "next/server";
import {
  fileTermRequest,
  resolveTermRequest,
  getTermRequest,
  termRequestsForBuildings,
  type TermRequest,
} from "@/lib/ai-desk/term-requests";
import { deskDeveloperFor, resolveDirectConversation } from "@/lib/conversations-direct";
import { postSystemNotice } from "@/lib/channels";
import { getDeveloper } from "@/lib/developers";
import { getBuilding, effectiveTerms } from "@/lib/catalog";
import { isAskInRange, rangeBreach, type TermsMilestone } from "@/lib/payment-plan";
import { requireCaller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MILESTONES: TermsMilestone[] = ["depositPct", "onContractPct", "onKeyPct", "instalments"];
const MILESTONE_LABEL: Record<TermsMilestone, string> = {
  depositPct: "deposit %",
  onContractPct: "on-contract %",
  onKeyPct: "on-handover %",
  instalments: "instalments",
};

/** A short human line for the thread note + the developer queue, composed from the structured ask (no PII). */
function askLine(milestone: TermsMilestone | undefined, value: number | undefined, note: string | undefined): string {
  if (milestone && typeof value === "number") {
    const unit = milestone === "instalments" ? "" : "%";
    const body = `${MILESTONE_LABEL[milestone]} of ${value}${unit}`;
    return note ? `${body} — "${note}"` : body;
  }
  return note ? `"${note}"` : "a custom payment structure";
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const milestoneRaw = typeof body.milestone === "string" ? body.milestone.trim() : "";
  const milestone = MILESTONES.includes(milestoneRaw as TermsMilestone) ? (milestoneRaw as TermsMilestone) : undefined;
  const askedValue = typeof body.askedValue === "number" && isFinite(body.askedValue) ? body.askedValue : undefined;
  if (!account || !building) {
    return NextResponse.json({ error: "account + building required" }, { status: 400 });
  }
  // A request needs SOMETHING to act on — either a structured ask or a free-text note.
  if (!milestone && !note) {
    return NextResponse.json({ error: "a note or a structured ask is required" }, { status: 400 });
  }

  // Resolve the developer who OWNS the terms for this building (the request's destination).
  const developer = await deskDeveloperFor(building);
  if (!developer) return NextResponse.json({ error: "no desk for this building" }, { status: 404 });

  // GUARD (the form path): only file for an ask that is genuinely OUT of range — an in-range figure is the
  // overlay sliders' job (self-serve, no human needed). If it's a structured ask that's IN range, tell the
  // client to compose it in the overlay instead (never create pointless developer work). A free-text-only ask
  // (no milestone) always files — we can't range-check prose.
  let breach: { side: "below" | "above"; bound: number } | undefined;
  if (milestone && typeof askedValue === "number") {
    const bld = await getBuilding(building);
    // Building-level terms (no specific unit here); effectiveTerms needs a unit, so derive ranges from the
    // building default via the shared range shape the desk uses. A building with no terms → no range → escalate.
    const terms = bld?.inventory?.[0] ? effectiveTerms(bld, bld.inventory[0]) : bld?.terms ?? null;
    const ranges = terms?.caps
      ? {
          depositPct: boundOf(terms.caps.depositPctMin, terms.caps.depositPctMax),
          onContractPct: boundOf(terms.caps.onContractPctMin, terms.caps.onContractPctMax),
          onKeyPct: boundOf(terms.caps.onKeyPctMin, terms.caps.onKeyPctMax),
          instalments: boundOf(terms.caps.instalmentsMin, terms.caps.instalmentsMax),
        }
      : undefined;
    if (isAskInRange(ranges, milestone, askedValue)) {
      return NextResponse.json(
        { inRange: true, message: "That's within the developer's published range — set it in the plan calculator." },
        { status: 200 },
      );
    }
    breach = rangeBreach(ranges, milestone, askedValue) ?? undefined;
  }

  // Resolve the deal/conversation so the developer can open the thread + we post a neutral note.
  const conv = await resolveDirectConversation(account, building, true);
  const dealId = conv?.id ?? `${account}|${building}`;

  const { request, created } = await fileTermRequest({
    dealId,
    buildingId: building,
    developer,
    ...(milestone ? { milestone } : {}),
    ...(typeof askedValue === "number" ? { askedValue } : {}),
    ...(breach ? { breach } : {}),
    ...(note ? { note } : {}),
    source: "buyer",
  });

  // Post a neutral note into the thread so the conversation stays coherent + the desk sees it landed.
  if (conv) {
    try {
      await postSystemNotice({
        requestId: conv.id,
        text: `The buyer asked for terms outside the published range (${askLine(milestone, askedValue, note)}). It has been flagged for the developer to review.`,
        context: { kind: "direct", id: conv.id },
      });
    } catch {
      /* note is best-effort; the request itself is the authoritative action */
    }
  }

  return NextResponse.json({ filed: true, created, id: request.id });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const claimed = (url.searchParams.get("developer") ?? "").trim();
  const all = url.searchParams.get("all") === "1";
  // Derive the developer from the PROVEN caller (the ?developer= param is unreachable on a real deploy).
  const caller = requireCaller(req, { param: claimed });
  if (!caller.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });

  const dev = await getDeveloper(caller.account);
  const buildingIds = dev?.buildingIds ?? [];
  const requests = buildingIds.length ? await termRequestsForBuildings(buildingIds, all) : [];
  return NextResponse.json({ developer: caller.account, requests, open: requests.filter((r) => r.status === "open").length });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!caller || !id) return NextResponse.json({ error: "caller + id required" }, { status: 400 });
  if (action !== "resolve") return NextResponse.json({ error: "unknown action" }, { status: 400 });

  const existing = await getTermRequest(id);
  if (!existing) return NextResponse.json({ error: "no such request" }, { status: 404 });
  // AUTHORIZE: the caller must be the desk developer that OWNS the request's building.
  const desk = await deskDeveloperFor(existing.buildingId);
  if (!desk || desk.toLowerCase() !== caller.toLowerCase()) {
    return NextResponse.json({ error: "not the desk for this request" }, { status: 403 });
  }
  const resolved = await resolveTermRequest(id);
  return NextResponse.json({ resolved: resolved?.status === "resolved", request: resolved });
}

/** Build an {min,max} range bound, omitting absent sides. PURE. */
function boundOf(min?: number, max?: number): { min?: number; max?: number } | undefined {
  if (min == null && max == null) return undefined;
  return { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) };
}

export type { TermRequest };
