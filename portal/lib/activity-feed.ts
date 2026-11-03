// VRX ACTIVITY ENGINE — SERVER-ONLY. The "engine/filter that creates what the user sees": it
// takes every event we hold and produces ONE reverse-chronological, plain-language, viewer-scoped timeline.
//
// It MERGES three already-recorded sources into the single ActivityEntry shape (lib/activity.ts), then
// humanises each per viewer:
//   • the on-chain event MIRROR (lib/events.ts)      → bookings (requested / accepted / declined / alt)
//   • the sealed BUYER-EVENTS trail (lib/buyer-events)→ buyer introduced / revised / reveal / ack
//   • the AGREEMENTS store (lib/agreements)           → proposed / published / joined / agreed / … (+ spine)
//   • the SPINE (lib/activity.ts)                     → off-chain acts with no store of their own
//
// WHY PROJECT, NOT RE-EMIT: each fact already has ONE owner (the chain for bookings, buyer-events for
// reveals, agreements for lifecycle). Re-emitting them into the spine would double-book + drift. So the
// engine re-presents what's recorded; the spine only carries the GAP. This is the mainnet-safe design
// flagged: the spine is OFF-CHAIN-ONLY facts and NEVER mirrors an on-chain act — so a mainnet re-sync of the
// chain mirror regenerates the booking lines identically, with no collision against the spine. (Projected
// rows use a stable id "<source>:<natural-key>" so re-projection de-dups rather than duplicates.)
//
// VIEWER SCOPE (+ "in respect to the counterparty"): getActivityFeed(viewer) returns only entries whose
// `parties` include the viewer. Booking counterparties come from the offer store (the agent = seal.by, the
// developer = offer.developer) where we hold the offer; a booking opened outside this portal has no offer, so
// we scope it to the developer we can see on-chain (the mirror's `node`). We never widen a party's view.

import { allEvents, type RawEvent } from "./events";
import { eventsForBooking, type BuyerEvent } from "./buyer-events";
import { allOffers, type Offer } from "./offers";
import { listAllAgreements, type Agreement } from "./agreements";
import { getCatalog } from "./catalog";
import { getProfile } from "./profiles";
import { agencyOf } from "./agents";
import { spineEntries, type ActivityEntry, type ActivityVerb } from "./activity";

// ── Humanisation ────────────────────────────────────────────────────────────────────────────────────
// Each verb → a plain-language line, rendered from the VIEWER's point of view (so a developer reads "you
// accepted" while the agent reads "the developer accepted"). the "decide the per-event vocabulary":
// legible, no contract words, no D-refs, no hashes. The engine passes the humaniser the viewer so
// "you" vs the counterparty's name/role resolves correctly.

/** A fully-rendered line for the UI. `tone` lets the UI tint it (positive/negative/neutral/pending). */
export type FeedLine = ActivityEntry & {
  /** The plain-language sentence, from the viewer's perspective. */
  text: string;
  /** A short category for the filter chips (the "filter"). */
  category: "booking" | "buyer" | "agreement" | "standing" | "inventory";
  /** Visual tone hint. */
  tone: "positive" | "negative" | "neutral" | "pending";
  /** A one-word tone badge label for the UI chip (e.g. "Agreed", "Declined", "Awaiting"). */
  badge: string;
  /** True when this row is something the VIEWER can act on now (a pending item awaiting THEM). The UI
 * marks these rows active + deep-links them to where the action lives ("ACTIVE things
   *  clickable → deep-link to the pending item"). */
  actionable: boolean;
  /** Deep-link into the surface where this subject lives, as "?section=&focus=" params the DashboardShell
   *  honours. Present whenever we can route to the item (not only for actionable rows). */
  link?: { section: string; focus: string };
};

const CATEGORY_OF: Record<ActivityVerb, FeedLine["category"]> = {
  "booking.requested": "booking",
  "booking.accepted": "booking",
  "booking.declined": "booking",
  "booking.alternative": "booking",
  "booking.confirmed": "booking",
  "contract.final": "booking",
  "contract.payment_arrived": "booking",
  "contract.signed": "booking",
  "buyer.introduced": "buyer",
  "buyer.revised": "buyer",
  "buyer.reveal_requested": "buyer",
  "buyer.reveal_declined": "buyer",
  "buyer.revealed": "buyer",
  "buyer.acknowledged": "buyer",
  "agreement.proposed": "agreement",
  "agreement.published": "agreement",
  "agreement.joined": "agreement",
  "agreement.agreed": "agreement",
  "agreement.declined": "agreement",
  "agreement.revoke_requested": "agreement",
  "agreement.revoked": "agreement",
  "standing.flagged": "standing",
  "standing.cleared": "standing",
  "standing.advanced": "standing",
  // edit-policy trust-dial rows share the developer-oversight ("standing") category.
  "policy.relaxed": "standing",
  "policy.tightened": "standing",
  // inventory change notices — their own filter chip.
  "inventory.repriced": "inventory",
  "inventory.off_market": "inventory",
  "inventory.availability": "inventory",
  "inventory.halted": "inventory",
  "inventory.resumed": "inventory",
  "inventory.unit_added": "inventory",
  "inventory.unit_removed": "inventory",
  "inventory.unit_changed": "inventory",
  "inventory.listing_updated": "inventory",
  // governance events (Slice 4) — building-change notices, same "inventory" filter chip as the rest.
  "governance.director_changed": "inventory",
  "governance.seller_changed": "inventory",
};

const TONE_OF: Record<ActivityVerb, FeedLine["tone"]> = {
  "booking.requested": "pending",
  "booking.accepted": "positive",
  "booking.declined": "negative",
  "booking.alternative": "neutral",
  "booking.confirmed": "positive",
  "contract.final": "neutral",
  "contract.payment_arrived": "positive",
  "contract.signed": "positive",
  "buyer.introduced": "neutral",
  "buyer.revised": "neutral",
  "buyer.reveal_requested": "pending",
  "buyer.reveal_declined": "negative",
  "buyer.revealed": "positive",
  "buyer.acknowledged": "positive",
  "agreement.proposed": "pending",
  "agreement.published": "neutral",
  "agreement.joined": "positive",
  "agreement.agreed": "positive",
  "agreement.declined": "negative",
  "agreement.revoke_requested": "pending",
  "agreement.revoked": "negative",
  "standing.flagged": "negative",
  "standing.cleared": "positive",
  "standing.advanced": "negative",
  // relaxing a class = more latitude granted (positive); tightening = more oversight imposed (neutral, not
  // an adverse action — it's VRX reverting to caution, not a strike against the developer).
  "policy.relaxed": "positive",
  "policy.tightened": "neutral",
  // inventory notices are informational (neutral) — they report a change, they aren't good/bad in themselves.
  // off-market + removal lean negative (inventory shrank); add leans positive (slate grew).
  "inventory.repriced": "neutral",
  "inventory.off_market": "negative",
  "inventory.availability": "neutral",
  // a halt pauses new bookings (the slate shrank for the partner) → negative; resuming restores it → positive.
  "inventory.halted": "negative",
  "inventory.resumed": "positive",
  "inventory.unit_added": "positive",
  "inventory.unit_removed": "negative",
  "inventory.unit_changed": "neutral",
  "inventory.listing_updated": "neutral",
  // governance events (Slice 4) — informational (who you contract with / who signed changed), not good/bad.
  "governance.director_changed": "neutral",
  "governance.seller_changed": "neutral",
};

/** One-word tone badge per verb — the coloured chip the UI shows so positive/negative/pending reads at a
 * glance ("a color badge or hint depending on which are neutral, positive or negative"). */
const BADGE_OF: Record<ActivityVerb, string> = {
  "booking.requested": "Awaiting",
  "booking.accepted": "Accepted",
  "booking.declined": "Declined",
  "booking.alternative": "Alternative",
  "booking.confirmed": "Sold",
  "contract.final": "Ready to sign",
  "contract.payment_arrived": "Payment in",
  "contract.signed": "Signed",
  "buyer.introduced": "Introduced",
  "buyer.revised": "Updated",
  "buyer.reveal_requested": "Awaiting",
  "buyer.reveal_declined": "Declined",
  "buyer.revealed": "Revealed",
  "buyer.acknowledged": "Confirmed",
  "agreement.proposed": "Proposed",
  "agreement.published": "Published",
  "agreement.joined": "Joined",
  "agreement.agreed": "Agreed",
  "agreement.declined": "Declined",
  "agreement.revoke_requested": "Pending",
  "agreement.revoked": "Ended",
  "standing.flagged": "Flagged",
  "standing.cleared": "Cleared",
  "standing.advanced": "Standing",
  "policy.relaxed": "Eased",
  "policy.tightened": "Tightened",
  "inventory.repriced": "Repriced",
  "inventory.off_market": "Off market",
  "inventory.availability": "Availability",
  "inventory.halted": "Paused",
  "inventory.resumed": "Resumed",
  "inventory.unit_added": "Unit added",
  "inventory.unit_removed": "Unit removed",
  "inventory.unit_changed": "Unit changed",
  "inventory.listing_updated": "Listing",
  // governance events (Slice 4).
  "governance.director_changed": "Director",
  "governance.seller_changed": "Seller",
};

/** Where each subject-kind lives in the dashboard — the section id the DashboardShell switches to. */
const SECTION_OF: Record<ActivityEntry["subject"]["kind"], string> = {
  booking: "queue",
  buyer: "queue", // buyer events hang off a booking → the booking queue thread
  agreement: "agreements",
  unit: "portfolio", // a unit-level act (none emitted today) → the buildings/portfolio section
  developer: "standing", // a standing act → the VRX-root Standing & accuracy console
};

/**
 * Is THIS entry something the viewer can act on right now? A pending item is actionable only by the party
 * who OWES the next move — so a developer sees "a booking request awaiting YOU" as actionable, while the
 * agent who sent it sees the same row as merely pending (not their move). We infer "owes the move" from the
 * verb + who the actor was: the actionable party is the OTHER party to a pending entry.
 */
function isActionable(entry: ActivityEntry, viewer: string): boolean {
  if (TONE_OF[entry.verb] !== "pending") return false;
  const v = viewer.toLowerCase();
  const actor = entry.actor?.toLowerCase();
  // The mover already moved; the counterparty owes the response. If the viewer IS the actor, it's not
  // their move. If the viewer is a (non-actor) party, it's awaiting them.
  if (actor && actor === v) return false;
  return entry.parties.some((p) => p.toLowerCase() === v);
}

/** Name the actor from the viewer's seat: the viewer is "You"; a counterparty is named by role + short id. */
function actorLabel(entry: ActivityEntry, viewer: string): string {
  const v = viewer.trim().toLowerCase();
  if (entry.actor && entry.actor.toLowerCase() === v) return "You";
  // Prefer a role word from context (so it reads "The agency" not a raw account) when supplied.
  const role = entry.context?.actorRole;
  if (typeof role === "string" && role) return `The ${role}`;
  return entry.actor || "Someone";
}

/** The deal reference phrase — unit + building when we have them, else a neutral "a booking". */
function unitPhrase(entry: ActivityEntry): string {
  const unit = entry.context?.unit;
  const building = entry.context?.building;
  if (unit && building) return `unit ${unit} · ${building}`;
  if (building) return `${building}`;
  if (unit) return `unit ${unit}`;
  return entry.subject.kind === "agreement" ? "the agreement" : "a unit";
}

/** Plain-words phrase for an edit-policy change class. Keeps the feed — no field-name keys
 *  leak to the UI. An unknown/missing class degrades to a neutral "their listings". */
function changeClassPhrase(cls: unknown): string {
  switch (cls) {
    case "priceDown": return "lower a price";
    case "priceUp": return "raise a price";
    case "copy": return "the listing description";
    case "images": return "listing images";
    case "withholdToggle": return "whether a unit is shown";
    case "offMarket": return "take a unit off market";
    case "addUnit": return "add a unit";
    case "removeUnit": return "remove a unit";
    case "sizeTypeLayout": return "a unit's size, type or layout";
    case "terms": return "the terms";
    default: return "their listings";
  }
}

/** Render one entry to its plain-language line from the viewer's perspective. */
function humanise(entry: ActivityEntry, viewer: string): string {
  const who = actorLabel(entry, viewer);
  const unit = unitPhrase(entry);
  const cp = entry.context?.counterparty; // display name of the other party, when known
  const cpPhrase = typeof cp === "string" && cp ? cp : "the other party";
  switch (entry.verb) {
    case "booking.requested":
      return `${who === "You" ? "A booking request arrived" : `${who} requested a booking`} on ${unit}.`;
    case "booking.accepted":
      return `${who} accepted the booking on ${unit}.`;
    case "booking.declined":
      return `${who} declined the booking on ${unit}.`;
    case "booking.alternative":
      return `${who} offered an alternative for the booking on ${unit}.`;
    case "booking.confirmed":
      return `${who} confirmed the deposit and closed ${unit} — sold.`;
    case "contract.final":
      return `${who} marked the sale contract on ${unit} ready to sign.`;
    case "contract.payment_arrived":
      return `${who} confirmed the on-contract payment arrived on ${unit} — ready to sign online.`;
    case "contract.signed":
      return `The sale contract on ${unit} was signed.`;
    case "buyer.introduced":
      return `A buyer was introduced on ${unit}.`;
    case "buyer.revised":
      return `${who} amended the buyer's details on ${unit}${entry.context?.diff ? ` (${entry.context.diff})` : ""}.`;
    case "buyer.reveal_requested":
      return `${who} requested to reveal the buyer's identity on ${unit} — awaiting the agent.`;
    case "buyer.reveal_declined":
      return `${who} declined the reveal request on ${unit}; the buyer stays masked.`;
    case "buyer.revealed":
      return `The buyer's identity was revealed on ${unit}.`;
    case "buyer.acknowledged":
      return `The buyer confirmed the introduction on ${unit}.`;
    case "agreement.proposed":
      return `${who} proposed a commission agreement to ${cpPhrase}.`;
    case "agreement.published":
      return `${who} published an agreement for agencies to join.`;
    case "agreement.joined":
      return `${who} joined your published agreement.`;
    case "agreement.agreed":
      return `${who} agreed the commission agreement with ${cpPhrase}.`;
    case "agreement.declined":
      return `${who} declined the proposed agreement.`;
    case "agreement.revoke_requested":
      return `${who} requested to end the agreement with ${cpPhrase} (the other party must confirm).`;
    case "agreement.revoked":
      return `The agreement with ${cpPhrase} was ended by mutual consent.`;
    // Developer standing (§3c) — the viewer is the developer (its own standing) or VRX-root. plain words,
    // reason-CATEGORY only (never the raw operator note). `subjectName` = the developer's display name.
    case "standing.flagged": {
      const dn = entry.context?.subjectName;
      return `${who === "You" ? "VRX raised an accuracy flag" : `An accuracy flag was raised`}${dn && who !== "You" ? ` on ${dn}` : ""} — a listing was reported inaccurate.`;
    }
    case "standing.cleared": {
      const dn = entry.context?.subjectName;
      return `An accuracy flag was withdrawn${dn && who !== "You" ? ` on ${dn}` : ""} — standing restored.`;
    }
    case "standing.advanced": {
      const dn = entry.context?.subjectName;
      const stage = entry.context?.stage;
      const stageWord = stage === "grace" ? "flagged (grace period)" : stage === "suspended" ? "paused" : stage === "removed" ? "removed" : "updated";
      return `Standing${dn && who !== "You" ? ` for ${dn}` : ""} moved to ${stageWord}.`;
    }
    // Edit-policy trust-dial — the viewer is the developer (its own policy) or VRX-root. plain
    // words, change-CLASS only (never prices/terms/unit specifics). `changeClass` is the raw class key;
    // map it to a plain phrase.
    case "policy.relaxed":
    case "policy.tightened": {
      const dn = entry.context?.subjectName;
      const subj = dn && who !== "You" ? dn : "you";
      const label = changeClassPhrase(entry.context?.changeClass);
      return entry.verb === "policy.relaxed"
        ? `VRX now lets ${subj} change ${label} without approval.`
        : `VRX now requires approval before ${subj} can change ${label}.`;
    }
    // Inventory change notices — the viewer is a subscribed agency/agent (ephemeral, dismiss
    // read-markers) or VRX-root (persistent oversight). plain words; the row carries only the building
    // name + a count/direction phrase, NEVER a unit's price or terms specifics. `building` = the
    // developer's project name; `count` = how many units the change touched; `direction` = "up"/"down" for
    // a reprice; `dev` = the developer's display name (VRX view).
    case "inventory.repriced": {
      const b = entry.context?.building;
      const n = Number(entry.context?.count ?? 0);
      const dir = entry.context?.direction;
      const where = b ? ` in ${b}` : "";
      const how = dir === "up" ? "raised" : dir === "down" ? "lowered" : "updated";
      const what = n > 1 ? `prices on ${n} units` : "a unit's price";
      return `${who === "You" ? "You" : who} ${how} ${what}${where}.`;
    }
    case "inventory.off_market": {
      const b = entry.context?.building;
      return `${who === "You" ? "You took" : `${who} took`} a unit off market${b ? ` in ${b}` : ""}.`;
    }
    case "inventory.availability": {
      const b = entry.context?.building;
      return `${who === "You" ? "You changed" : `${who} changed`} whether a unit is shown${b ? ` in ${b}` : ""}.`;
    }
    // A building halt — new bookings paused on a whole building (governed-change A). Plain words, no note
    // (the "why" surfaces verbatim on the A2/B notice surfaces, never in this feed line).
    case "inventory.halted": {
      const b = entry.context?.building;
      return `${who === "You" ? "You paused" : `${who} paused`} new bookings${b ? ` on ${b}` : ""}.`;
    }
    case "inventory.resumed": {
      const b = entry.context?.building;
      return `${who === "You" ? "You resumed" : `${who} resumed`} new bookings${b ? ` on ${b}` : ""}.`;
    }
    case "inventory.unit_added": {
      const b = entry.context?.building;
      return `${who === "You" ? "You added" : `${who} added`} a unit${b ? ` to ${b}` : ""}.`;
    }
    case "inventory.unit_removed": {
      const b = entry.context?.building;
      return `${who === "You" ? "You removed" : `${who} removed`} a unit${b ? ` from ${b}` : ""}.`;
    }
    case "inventory.unit_changed": {
      const b = entry.context?.building;
      return `${who === "You" ? "You updated" : `${who} updated`} a unit's details${b ? ` in ${b}` : ""}.`;
    }
    case "inventory.listing_updated": {
      const b = entry.context?.building;
      return `${who === "You" ? "You updated" : `${who} updated`} the listing${b ? ` for ${b}` : ""}.`;
    }
    // CHANGE-GOVERNANCE TIER-1 governance events (Slice 4). Capability-level only,: name WHICH field moved
    // + the building, NEVER the old/new values (those live in the sealed evidence, not the feed line).
    case "governance.director_changed": {
      const b = entry.context?.building;
      return `The director / signatory${b ? ` for ${b}` : ""} changed.`;
    }
    case "governance.seller_changed": {
      const b = entry.context?.building;
      return `The seller company${b ? ` for ${b}` : ""} changed.`;
    }
    default:
      return "Something happened.";
  }
}

// ── Projection: the three recorded sources → ActivityEntry[] ───────────────────────────────────────────

/** Map an on-chain reply status to our verb. 1 = accepted/HELD, 2 = declined, 3 = alternative. */
function replyVerb(status: number | undefined): ActivityVerb | null {
  if (status === 1) return "booking.accepted";
  if (status === 2) return "booking.declined";
  if (status === 3) return "booking.alternative";
  return null;
}

function evStr(e: RawEvent, key: string): string | undefined {
  const d = e.data as Record<string, unknown> | null;
  const v = d?.[key];
  return typeof v === "string" ? v : undefined;
}
function evNum(e: RawEvent, key: string): number | undefined {
  const d = e.data as Record<string, unknown> | null;
  const v = d?.[key];
  return typeof v === "number" ? v : undefined;
}

/** Project the on-chain event mirror → booking entries, enriched from the offer store where we hold it. */
async function projectBookings(offers: Offer[]): Promise<ActivityEntry[]> {
  const events = await allEvents().catch(() => [] as RawEvent[]);
  const catalog = await getCatalog().catch(() => []);
  const offerById = new Map(offers.map((o) => [o.requestId, o]));

  const nameOf = (o: Offer | undefined): { unit?: string; building?: string } => {
    if (!o?.display) return {};
    const b = catalog.find((x) => x.id === o.display.buildingId);
    if (!b) return {};
    const u = b.inventory.find((x) => x.id === o.display.unitId);
    return { building: b.name, unit: u?.id?.replace(/^unit-/, "") ?? o.display.unitId };
  };

  const out: ActivityEntry[] = [];
  for (const e of events) {
    const id = evStr(e, "id");
    if (!id) continue;
    const offer = offerById.get(id);
    // Parties: the developer is always visible (named on-chain as `node`); the agent is the offer author
    // (opaque on-chain → only known when we hold the offer).
    const dev = offer?.developer ?? evStr(e, "node") ?? "";
    const agent = offer?.seal.by ?? "";
    const parties = [dev, agent].filter(Boolean);
    const names = nameOf(offer);

    if (e.event === "claim_opened") {
      out.push({
        id: `mirror:${id}:opened`,
        verb: "booking.requested",
        actor: agent, // the agent authored the request
        subject: { kind: "booking", id },
        context: { unit: names.unit, building: names.building, actorRole: "agent" },
        parties,
        source: "mirror",
        at: e.at,
      });
    } else if (e.event === "claim_replied") {
      const verb = replyVerb(evNum(e, "status"));
      if (!verb) continue;
      out.push({
        id: `mirror:${id}:replied:${e.at}`,
        verb,
        actor: dev, // the developer replies
        subject: { kind: "booking", id },
        context: { unit: names.unit, building: names.building, actorRole: "developer" },
        parties,
        source: "mirror",
        at: e.at,
      });
    }
  }
  return out;
}

/** Map a sealed buyer-event kind → our verb. */
function buyerVerb(kind: BuyerEvent["kind"], detail: string): ActivityVerb {
  switch (kind) {
    case "introduction":
      return "buyer.introduced";
    case "revision":
      return "buyer.revised";
    case "declaration":
      return "buyer.reveal_requested"; // the developer accepted the declaration = a pending reveal request
    case "reveal":
      return /declined/i.test(detail) ? "buyer.reveal_declined" : "buyer.revealed";
    case "buyer-ack":
      return "buyer.acknowledged";
    case "confirmed":
      return "booking.confirmed"; // the sale — deposit confirmed, unit closed
    case "contract_final":
      return "contract.final";
    case "payment_arrived":
      return "contract.payment_arrived";
    case "contract_signed":
      return "contract.signed";
  }
}

/** Project the sealed buyer-events trail → entries, scoped to the booking's two deal parties. */
async function projectBuyerEvents(offers: Offer[]): Promise<ActivityEntry[]> {
  const catalog = await getCatalog().catch(() => []);
  const offerById = new Map(offers.map((o) => [o.requestId, o]));
  const out: ActivityEntry[] = [];
  // Only offers we hold have a buyer trail worth showing (and the parties to scope to).
  for (const o of offers) {
    const trail = await eventsForBooking(o.requestId).catch(() => [] as BuyerEvent[]);
    if (trail.length === 0) continue;
    const dev = o.developer;
    const agent = o.seal.by ?? "";
    const parties = [dev, agent].filter(Boolean);
    const b = catalog.find((x) => x.id === o.display.buildingId);
    const u = b?.inventory.find((x) => x.id === o.display.unitId);
    const ctx: ActivityEntry["context"] = {
      unit: u?.id?.replace(/^unit-/, "") ?? o.display.unitId,
      building: b?.name,
    };
    for (const ev of trail) {
      const byl = ev.by.toLowerCase();
      const actorRole =
        byl === dev.toLowerCase() ? "developer" : byl === agent.toLowerCase() ? "agent" : "buyer";
      out.push({
        id: `buyer-events:${ev.id}`,
        verb: buyerVerb(ev.kind, ev.detail),
        actor: ev.by,
        subject: { kind: "buyer", id: o.requestId },
        context: { ...ctx, actorRole },
        parties,
        source: "buyer-events",
        at: ev.at,
      });
    }
  }
  void offerById;
  return out;
}

/** Project the agreements store's CURRENT state → entries. The lifecycle moves themselves come from the
 *  spine (logActivity at each move); this adds the ORIGINATION (proposed/published) so an agreement that
 *  predates the spine still shows its first line. De-duped against spine rows by the stable id. */
function projectAgreements(agreements: Agreement[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const g of agreements) {
    const parties = [g.seal.developer, g.seal.agency].filter(Boolean);
    const originVerb: ActivityVerb = g.status === "published" ? "agreement.published" : "agreement.proposed";
    // Prefer the KYC legal name folded into the seal over the raw account id — a CEO feed reads
    // "to Blue Horizon Realty", not "to dysfunctional-smoke.testnet" (owed polish). Falls back to the
    // account when a party has no vetted profile (identity-less seal).
    const devName = g.seal.developerIdentity?.legalName || g.seal.developer || undefined;
    const agencyName = g.seal.agencyIdentity?.legalName || g.seal.agency || undefined;
    out.push({
      id: `agreements:${g.id}:origin`,
      verb: originVerb,
      actor: g.seal.by === "agency" ? g.seal.agency : g.seal.developer,
      subject: { kind: "agreement", id: g.id },
      context: {
        actorRole: g.seal.by,
        counterparty: g.seal.by === "agency" ? devName : agencyName,
      },
      parties,
      source: "agreements",
      at: g.at,
    });
  }
  return out;
}

// ── The public engine ─────────────────────────────────────────────────────────────────────────────────

/**
 * Build the humanised, viewer-scoped activity feed. `viewer` = the signed-in account; `role` tags it for the
 * UI (not used for filtering — visibility is purely `parties`, so the same call serves every role, the
 * reusable module). Newest first, de-duped on `id`, capped at `limit`.
 */
export async function getActivityFeed(
  viewer: string,
  role: string,
  limit = 200,
  /** When set (ms epoch), return only entries that happened AT OR AFTER it — the warroom's "what's new
 * since last visit" digest. Omitted = the full feed, exactly as before. Applied after scoping,
   *  before the limit, so the cap counts only the new entries. */
  since?: number
): Promise<FeedLine[]> {
  const v = viewer.trim().toLowerCase();
  if (!v) return [];

  // The identities that count as "me" for parties-membership. An AGENT inherits its AGENCY's scope: inventory
  // and agreement notices subscribe the AGENCY account (resolveNoticeParties / the agreement seal), not each
  // agent — so without this fold an agent's News tab would miss every building-level notice its agency gets.
  // (Same agent→agency fold halt-notices.ts applies.) An agency/developer/root viewer has no agency → just `v`.
  const myAgency = await agencyOf(v).catch(() => null);
  const scope = new Set<string>([v, ...(myAgency ? [myAgency.toLowerCase()] : [])]);

  const [offers, agreements, spine] = await Promise.all([
    allOffers().catch(() => [] as Offer[]),
    listAllAgreements().catch(() => [] as Agreement[]),
    spineEntries().catch(() => [] as ActivityEntry[]),
  ]);

  const [bookings, buyerEvents] = await Promise.all([
    projectBookings(offers),
    projectBuyerEvents(offers),
  ]);
  const agreementOrigins = projectAgreements(agreements);

  // Merge all sources, de-dup on id (spine rows win over a projected origin for the same natural key).
  const byId = new Map<string, ActivityEntry>();
  for (const e of [...bookings, ...buyerEvents, ...agreementOrigins, ...spine]) {
    byId.set(e.id, e);
  }

  // Scope to the viewer, sort newest-first. When `since` is set (warroom digest), keep only entries at or
  // after it — so the feed shows exactly "what's new since the viewer last looked".
  const visible = Array.from(byId.values()).filter(
    (e) => e.parties.some((p) => scope.has(p.toLowerCase())) && (since === undefined || e.at >= since)
  );
  visible.sort((a, b) => b.at - a.at);

  // Collapse consecutive IDENTICAL on-chain replies (same booking, same verb, back-to-back in time) — the
  // chain may record several, but a CEO feed wants one line (owed polish). Faithful because we keep the
  // newest; the de-dup is purely presentational and only within one subject's run.
  const collapsed: ActivityEntry[] = [];
  for (const e of visible) {
    const prev = collapsed[collapsed.length - 1];
    const dup =
      prev &&
      prev.subject.kind === e.subject.kind &&
      prev.subject.id === e.subject.id &&
      prev.verb === e.verb &&
      prev.source === "mirror" &&
      e.source === "mirror";
    if (dup) continue; // keep the newer (already pushed); drop this older identical one
    collapsed.push(e);
  }

  const rows = collapsed.slice(0, limit);

  // Resolve any counterparty that still looks like a raw account id → its KYC legal name. Spine rows
  // store the account; the projected agreement origin already resolved. One lookup per distinct account.
  const nameCache = new Map<string, string>();
  const looksLikeAccount = (s: string) => /\.(testnet|near)$/i.test(s) || /\.[a-z0-9-]+$/i.test(s);
  await Promise.all(
    rows.map(async (e) => {
      const cp = e.context?.counterparty;
      if (typeof cp !== "string" || !cp || !looksLikeAccount(cp)) return;
      if (!nameCache.has(cp)) {
        const p = await getProfile(cp).catch(() => null);
        nameCache.set(cp, p?.legalName?.trim() || cp);
      }
    })
  );

  return rows.map((e) => {
    const rawCp = e.context?.counterparty;
    const resolved =
      typeof rawCp === "string" && nameCache.has(rawCp) ? nameCache.get(rawCp)! : rawCp;
    const withName: ActivityEntry =
      resolved !== rawCp ? { ...e, context: { ...e.context, counterparty: resolved } } : e;
    const actionable = isActionable(e, viewer);
    return {
      ...withName,
      text: humanise(withName, viewer),
      category: CATEGORY_OF[e.verb],
      tone: TONE_OF[e.verb],
      badge: BADGE_OF[e.verb],
      actionable,
      link: { section: SECTION_OF[e.subject.kind], focus: e.subject.id },
    };
  });
}

// `role` is accepted for forward-compat (per-role default filters later) + API symmetry; visibility is
// parties-only today so a developer/agent/agency/root all get a correct slice from the same engine.
