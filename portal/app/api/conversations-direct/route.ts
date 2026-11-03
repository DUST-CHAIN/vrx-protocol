// /api/conversations-direct — the BUYER↔DESK (pre-booking) conversation thread (§9 step 3). The direct-
// context twin of /api/channels/[requestId]: same generalized channel store, different context + party set.
//
//   GET  ?account=<viewer>&building=<id>   → start/resolve the (viewer-as-buyer, building) conversation and
//                                            return { conversationId, messages, role }. Fail-closed: the
//                                            building must be direct-sale-visible and have a desk developer.
//   GET  ?account=<viewer>&conversationId= → read an EXISTING conversation by id (either party), scoped.
//   POST { account, conversationId, text } → append a message; the author's role (buyer|developer) is
//                                            resolved server-side from the conversation — the client can't
//                                            claim a role. Returns { message }.
//
// SCOPING (fail-closed): lib/conversations-direct.directRole authorizes the viewer as the buyer OR the
// building's desk developer; anyone else gets 403. Transport is the same swappable poll+SSE as the booking
// channel (the message push uses the opaque channelTopic on the conversationId).
//
// PRIVACY: bodies off-chain plaintext; chain untouched; neutral account ids only.: reads the
// caller's named account, signs nothing.

import { NextResponse } from "next/server";
import { getThread, postMessage, postSystemNotice } from "@/lib/channels";
import { resolveDirectConversation, directRole, isBuyerBlocked, directParties } from "@/lib/conversations-direct";
import { upsertSidecar, type AgreedPlan } from "@/lib/ai-desk/deal-sidecar";
import { requireCaller } from "@/lib/caller";

/** The autoreply a hard-blocked buyer gets when they post (E-slice). The blocker (desk) still RECEIVES the
 * message — this is the honest, non-hostile signal to the sender (friction kept at bay), per the model. */
const BLOCK_AUTOREPLY = "This user doesn't want to talk to you anymore.";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Coerce an untrusted reservePlan body into the stored AgreedPlan shape — finite non-negative numbers,
 *  a bounded schedule of {label, amountUsd}. Returns null for anything that isn't a plausible plan (missing
 *  price, not an object) so a malformed body simply falls back to the template path. Neutral money only (no PII). */
function sanitizeAgreedPlan(raw: unknown): AgreedPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const priceUsd = num(p.priceUsd);
  if (priceUsd <= 0) return null;
  const rawSchedule = Array.isArray(p.schedule) ? p.schedule.slice(0, 64) : [];
  const schedule = rawSchedule
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
    .map((r) => ({ label: typeof r.label === "string" ? r.label.slice(0, 64) : "", amountUsd: num(r.amountUsd) }))
    .filter((r) => r.label);
  return {
    priceUsd,
    depositUsd: num(p.depositUsd),
    onContractUsd: num(p.onContractUsd),
    onKeyUsd: num(p.onKeyUsd),
    instalmentCount: num(p.instalmentCount),
    instalmentUsd: num(p.instalmentUsd),
    schedule,
    balanced: p.balanced === true,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const claimed = url.searchParams.get("account")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  const conversationId = url.searchParams.get("conversationId")?.trim() || "";
  // AUTH (VRX-0001 IDOR / F3 class): the viewer MUST be the PROVEN caller, not a trusted `?account=`.
  // directRole on a CLAIMED account only proves "that account is a party", not "the CALLER is that account" —
  // so without this an attacker naming the victim + a conversationId could read the thread AS them.
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const account = who.account;
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });

  // Path A — resolve/start by (buyer, building). The caller is the BUYER starting an enquiry.
  if (building) {
    const conv = await resolveDirectConversation(account, building, /* ensure */ true);
    if (!conv) return NextResponse.json({ error: "no desk for this building" }, { status: 404 });
    const role = await directRole(conv.id, account);
    if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
    return NextResponse.json({ conversationId: conv.id, role, messages: await getThread(conv.id) });
  }

  // Path B — read an existing conversation by id (either party).
  if (conversationId) {
    const role = await directRole(conversationId, account);
    if (!role) return NextResponse.json({ error: "not a participant" }, { status: 403 });
    return NextResponse.json({ conversationId, role, messages: await getThread(conversationId) });
  }

  return NextResponse.json({ error: "building or conversationId required" }, { status: 400 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const claimed = typeof body.account === "string" ? body.account.trim() : "";
  // AUTH (F3 class): bind the author to the proven session before resolving their role (below).
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  const account = who.account;
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  // the Reserve-from-card deep-link passes the unit the buyer explicitly chose. A reserved unit IS the
  // deal's focus, so we seed the sidecar's focusUnitId below — that lets the server phase fast-path (phase-advance
  // bookFastPath) reach "book" directly so the AI can place the hold the buyer just asked for, instead of being
  // stuck at qualify/negotiate (the live-drive gap: focusUnitId was null → open_unit never unlocked → no hold).
  const reserveUnit = typeof body.reserveUnit === "string" ? body.reserveUnit.trim() : "";
  // the composed OFFER plan the buyer designed in the review overlay (within the dev's caps). A neutral
  // money structure only (no PII); we sanitize it to the stored AgreedPlan shape and stash it on the deal so the
  // deposit + S&P use the AGREED figures. Untrusted input → coerced to finite numbers, never used raw.
  const reservePlan = sanitizeAgreedPlan(body.reservePlan);
  if (!account || !conversationId || !text.trim()) {
    return NextResponse.json({ error: "account + conversationId + text required" }, { status: 400 });
  }

  // The author's role is resolved from the conversation — not claimed by the client. Fail closed for a
  // non-participant.
  const role = await directRole(conversationId, account);
  if (!role) return NextResponse.json({ error: "not a participant in this conversation" }, { status: 403 });

  // seed the deal focus from the reserved unit (buyer-only; the unit they explicitly chose on the card).
  // Best-effort: a sidecar write must never block the message. Resolves the building server-side (never trusted
  // from the client). Only sets focus; the phase itself still resolves from real state + the model's declaration.
  if (reserveUnit && role === "buyer") {
    try {
      const parties = await directParties(conversationId);
      if (parties)
        await upsertSidecar(conversationId, parties.building, "buyer", {
          focusUnitId: reserveUnit,
          // stash the composed offer alongside the focus so the deposit/seal use the AGREED plan.
          ...(reservePlan ? { agreedPlan: reservePlan } : {}),
        });
    } catch {
      /* focus is an optimisation; the hold flow still works without it, just a notch slower */
    }
  }

  const message = await postMessage({
    requestId: conversationId, // the field name is historical; here it carries the conversationId
    from: role,
    by: account,
    text,
    context: { kind: "direct", id: conversationId },
  });
  if (!message) return NextResponse.json({ error: "could not post" }, { status: 400 });

  // E-slice: a hard-blocked BUYER's message STILL LANDS (the desk receives it — nothing lost), but the
  // buyer gets an honest autoreply. Desk-only block, so this only applies when the author is the buyer. The
  // autoreply is a `vrx` system notice in the thread so the buyer sees it inline; `blocked:true` tells the
  // client to show the signal. (The desk's own messages are never auto-replied.)
  if (role === "buyer" && (await isBuyerBlocked(conversationId))) {
    await postSystemNotice({
      requestId: conversationId,
      text: BLOCK_AUTOREPLY,
      context: { kind: "direct", id: conversationId },
    });
    return NextResponse.json({ message, blocked: true, autoreply: BLOCK_AUTOREPLY });
  }
  return NextResponse.json({ message });
}
