// GET /api/conversations?viewer=<account>
//  → the viewer's CONVERSATIONS roll-up (step 3): every booking CHAT the viewer is a participant in,
//     as an openable thread with its title + last message. The list-all-my-threads read the per-thread
//     channel API (/api/channels/[requestId]) never had — it answered ONE thread at a time; this rolls up
//     ALL of them for a surface (the agent's Conversations area first; the developer + agency are later
//  consumers of the SAME route + component, — one seam, three role views).
//
//   Each row carries:
//       • requestId   — the booking/thread id (opaque; the DealChat panel keys on it).
//       • title       — buyer · building · unit# · developer  (same shape as the My-bookings row title).
//       • lastMsg     — { from, by, text, at } of the most recent message, or null if no one has spoken.
//       • counterpart — the OTHER party's neutral account id (who the viewer is talking to).
//       • msgCount    — total messages (lets the client show activity + derive unread against a local marker).
//       • developer / agent — the two sides (neutral account ids), for display + the counterpart resolve.
//
// SCOPING (reuses the channel API's participantRole boundary): a channel is a PRIVATE thread about a
// booking. Its participants are the offer's DEVELOPER, the AGENT who signed it (seal.by), and that agent's
// supervising AGENCY (agencyOf). We enumerate the thread store (allThreadSummaries), resolve each thread's
// offer, and keep only threads where the viewer is one of those three — the exact fail-closed rule the
// single-thread GET enforces, applied in bulk. A thread whose offer we don't hold (booked outside the
// portal) has no resolvable participants off-chain, so it's dropped rather than leaked (fail closed).
//
// PRIVACY: bodies are off-chain plaintext; the chain is untouched. Only neutral account ids leave the
// server. The buyer name in the title is the viewer's OWN (unmasked) copy only when the viewer authored the
// offer (the agent); for a developer/agency viewer we use the masked developer view, never raw PII.

import { NextResponse } from "next/server";
import { allThreadSummaries, type ChannelFrom } from "@/lib/channels";
import { getOffer, developerView, type Offer } from "@/lib/offers";
import { partyOnOffer } from "@/lib/participant";
import { requireCaller } from "@/lib/caller";
import { seenFor } from "@/lib/read-markers";
import { getCatalog } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ConversationRow = {
  requestId: string;
  title: string;
  lastMsg: { from: ChannelFrom; by: string; text: string; at: number } | null;
  counterpart: string | null;
  msgCount: number;
  /**  notify-on-login: true iff this viewer has unseen messages here (server read-marker, survives
   *  device/login) AND the newest message is from the counterpart (your own last word isn't unread to you). */
  unread: boolean;
  developer: string | null;
  agent: string | null;
};

type Role = "developer" | "agent";

export async function GET(req: Request) {
  // F1: identity from the VERIFIED session via requireCaller — param-fallback mode still honours
  // the legacy ?viewer= param (flag off = today's behaviour); strict mode ignores a forged param.
  const caller = requireCaller(req, { param: new URL(req.url).searchParams.get("viewer") });
  if (!caller.ok) return NextResponse.json({ error: "signin_required" }, { status: caller.status });
  const viewer = caller.account;

  try {
    const [threads, catalog, seen] = await Promise.all([
      allThreadSummaries().catch(() => []),
      getCatalog().catch(() => []),
      seenFor(viewer).catch(() => ({} as Record<string, number>)),
    ]);

    // Resolve the viewer's role on a booking from its offer — the SAME shared participant rule the
    // single-thread GET authorizes (lib/participant, the F1 chokepoint). Returns the viewer's role + the two
    // sides, or null if the viewer isn't a party (→ the thread is dropped, fail closed).
    const partyOf = (offer: Offer | null) => partyOnOffer(offer, viewer);

    // Catalog name enrichment (one catalog, reused) — only resolvable when we hold the offer's display refs.
    const nameOf = (o: Offer): { building?: string; unit?: string } | null => {
      if (!o.display) return null;
      const b = catalog.find((x) => x.id === o.display.buildingId);
      if (!b) return null;
      const u = b.inventory.find((x) => x.id === o.display.unitId);
      return { building: b.name, unit: u?.id?.replace(/^unit-/, "") ?? o.display.unitId };
    };

    // Buyer name for the title. An AGENT viewer authored the buyer detail → sees its own unmasked copy; a
    // DEVELOPER/AGENCY viewer gets the masked developer view (never raw PII while the buyer is still locked).
    const buyerNameOf = (o: Offer, role: Role): string => {
      const seal = role === "developer" ? developerView(o).seal : o.seal;
      const b = seal.buyer;
      if (b && typeof b === "object") {
        const name = (b as Record<string, unknown>).name;
        if (typeof name === "string") return name.trim();
      }
      return "";
    };

    const rows: ConversationRow[] = [];
    for (const t of threads) {
      const offer = await getOffer(t.requestId);
      const party = await partyOf(offer);
      if (!party || !offer) continue; // not a participant / no offer → drop (fail closed)

      const names = nameOf(offer);
      const unit = names?.unit ? `Unit ${names.unit}` : "";
      const building = names?.building ?? offer.display?.buildingId ?? "";
      const buyer = buyerNameOf(offer, party.role);
      // buyer · building · unit# · developer — same spine as the My-bookings row title. Fall back to a short
      // opaque handle when nothing resolves, so a row never reads as a broken/empty title.
      const titleParts = [buyer, building, unit, party.developer].filter(Boolean);
      const title = titleParts.length > 0 ? titleParts.join(" · ") : `Conversation ${t.requestId.slice(0, 8)}`;

      // The counterpart is the OTHER side from the viewer.
      const counterpart = party.role === "developer" ? party.agent || null : party.developer || null;

      // Unread (server read-marker): more messages than this viewer last saw, AND the newest is from the
      // counterpart (your own last word isn't unread to you). seen is keyed by requestId.
      const seenCount = seen[t.requestId] ?? 0;
      const unread = t.msgCount > seenCount && !!t.lastMsg && t.lastMsg.from !== party.role;

      rows.push({
        requestId: t.requestId,
        title,
        lastMsg: t.lastMsg
          ? { from: t.lastMsg.from, by: t.lastMsg.by, text: t.lastMsg.text, at: t.lastMsg.at }
          : null,
        counterpart,
        msgCount: t.msgCount,
        unread,
        developer: party.developer || null,
        agent: party.agent || null,
      });
    }

    // Most-recent activity first (a thread with no messages — seeded but silent — sinks to the bottom).
    rows.sort((a, b) => (b.lastMsg?.at ?? 0) - (a.lastMsg?.at ?? 0));

    return NextResponse.json({ viewer, rows });
  } catch {
    return NextResponse.json({ error: "server_busy" }, { status: 503 });
  }
}
