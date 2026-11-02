"use client";

// Agent screen — the BUYER-SIDE actor's surface (Peer, i.e. an agency's agent).
// An agent opens a booking claim against a developer's open unit: open_claim(request_id, unit_key,
// node_id, request_hash) [Peer-signed]. The contract requires the caller be an ACTIVE Peer whose Org
// has an ACTIVE Gate on that developer (else NOT_PEER / PEER_INACTIVE / NO_GATE / GATE_INACTIVE), and
// the unit must be status 0 (open). This screen is where the reservation flow STARTS on the demand
// side; the developer then replies/confirms on the /node screen.
// PICKER: instead of typing a developer id + unit ref, the agent PICKS from cascading
// dropdowns scoped to only the developers their agency has access to. The scope is resolved + enforced
// SERVER-SIDE (GET /api/agent/developers): agent → agency (Peer.g) → active gates → gated developers
// only. Then developer → building → unit, the units drawn from that developer's off-chain catalog with
// live on-chain status baked in (the catalog is the info gate, the chain the action gate —
// vrx-read-privacy-model). Held-for-another-agency units (a live exclusive) are surfaced on the
// selected unit before signing (the contract also enforces it → E58).
// PRIVACY: the unit reference is hashed to the same opaque unit_key the developer stamped (same
// hashRef domain "vrx-unit" → same digest). The request terms are hashed to an opaque request_hash —
// never sent raw. Peer writes are #[payable] + tolled (V5/; depositFor(me) auto-sizes it.

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { useEventStream } from "@/lib/useEventStream";
import { useUnreadConversations } from "@/lib/useUnreadConversations";
import { useNotifier } from "@/lib/useNotifier";
import {
  hashRef,
  getPeer,
  getExclusive,
  liveHolder,
  openClaimArgs,
  depositFor,
  TILE_STATUS,
  CLAIM_STATUS,
  isRequestLapsed,
  requestClock,
  humanDuration,
  type ClaimWire,
} from "@/lib/vrx";
import { card, lbl, input, submitBtn, banner, mono, statusColor } from "@/lib/ui";
import { DealChatPanel, type ViewerRole } from "@/components/DealChat";
import BookingCode from "@/components/BookingCode";
import SaleContractButton from "@/components/SaleContractButton";
import BuyerPaymentPanel from "@/components/BuyerPaymentPanel";
import ReconciliationPanel from "@/components/ReconciliationPanel";
import { FurnitureSelector } from "@/components/BuildingAuthoring";
import { KycVaultPanel } from "@/components/KycVault";
import { T } from "@/lib/theme";
import { commissionReasonCopy, type CommissionReason } from "@/lib/commission-reason";
import { useRole } from "@/lib/role";
import { useBuildingStatus } from "@/lib/useBuildingStatus";
import { useTxRun, TxProgress } from "@/components/TxAction";
import ConnectLog, { type LogLine } from "@/components/ConnectLog";
import { timeAgo, CACHED_ORANGE, type Unit as CatalogUnitType, type Building as CatalogBuildingType } from "@/lib/catalog-client";
import { freeholdQuota, emptyQuota, bookableForBuyer, priceForBuyer, unitSqm, buyerLabel, BUYER_TYPE_LABEL, type BuyerType, type FreeholdQuota } from "@/lib/freehold";
import { StackingPlan } from "@/components/StackingPlan";
import BuildingCards from "@/components/BuildingCards";
import { BuildingSummaryBlock } from "@/components/BuildingSummary";
import SitePlanMap from "@/components/SitePlanMap";
import UnitDetail from "@/components/UnitDetail";
import LoadingUnits from "@/components/LoadingUnits";
import { useMoney } from "@/lib/currency";
import DashboardShell, { type ShellSection } from "@/components/DashboardShell";
import HaltNotices from "@/components/HaltNotices";
import EventLog from "@/components/EventLog";
import { buyerSnapshot, composeName, TITLES, type BuyerSnapshotFields } from "@/lib/buyer-snapshot";
import { presetMask, type BuyerMask, type MaskPreset } from "@/lib/buyer-mask";
import { checkBuyerPolicy, policySummary } from "@/lib/buyer-policy";
import { checkFieldPlausibility, plausibilityHint, type PlausibleField } from "@/lib/field-plausibility";
import AgentTokensPanel from "@/components/AgentTokensPanel";
import DemoCurrencyPanel from "@/components/DemoCurrencyPanel";
import { DEMO_MODE_FLAG } from "@/lib/dev-signer-fence";

// ── Types mirrored from the APIs this screen calls ──────────────────────────────────────────
type GatedDeveloper = { account: string; name: string; buildings: { id: string; name: string; onContract?: boolean }[]; listingsPaused?: boolean; requiredProfileFields?: string[] };
// A buyer from this agent's roster. Mirrors the publicBuyer shape from /api/buyers (salt stripped).
type RosterBuyer = {
  id: string;
  agent: string;
  fields: BuyerSnapshotFields;
  sealHash: string;
  at: number;
  updatedAt: number;
  verified: boolean;
};
// Reuse the shared catalog types (so StackingPlan, the summary, and the offer form all agree).
type CatalogUnit = CatalogUnitType;
type CatalogBuilding = CatalogBuildingType;

export default function AgentPage() {
  const { accountId, ready, signIn, callFunction } = useWallet();
  // Cross-booking unread count → the Conversations sidebar badge ( notify-on-login): a party who logs on
  // sees "you have N unread" without opening the section. Server truth, survives device/login; ticks on SSE.
  const unreadConversations = useUnreadConversations(accountId);
  const money = useMoney();
  const { role } = useRole(); // cached (stale-while-revalidate) → lets us trust "agent" without re-reading
  const [isPeer, setIsPeer] = useState<boolean | null>(null);

  // Developers this agent's agency has access to (gated-only, server-enforced). null = not loaded yet.
  const [developers, setDevelopers] = useState<GatedDeveloper[] | null>(null);
  // The last developer load couldn't reach the network (RPC 429/down) rather than confirming no access.
  const [rpcError, setRpcError] = useState(false);
  // steps + retries instead of a blank spinner. Driven by the resolution loop below.
  const [connLog, setConnLog] = useState<LogLine[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!accountId) {
      setIsPeer(null);
      setDevelopers(null);
      return;
    }
    let cancelled = false;
    // If the cached role already says this account is an agent, trust it immediately so the page
    // paints without waiting on a chain read (which may be throttled after a status burst). The
    // read below still runs to confirm/correct; it just no longer BLOCKS the cards.
    if (role === "agent") setIsPeer(true);
    getPeer(accountId)
      .then((p) => {
        if (cancelled) return;
        const ok = !!p && (p as { a?: boolean }).a !== false;
        // Don't flip a cached-true agent to false on a failed/empty read during an RPC blip; only
        // a definitive non-null-but-inactive record should demote. (p===null on timeout → keep.)
        if (p === null && role === "agent") return;
        setIsPeer(ok);
      })
      .catch(() => {
        if (!cancelled && role !== "agent") setIsPeer(false);
      });
    // Load the agency's gated developers. On an RPC blip the server returns rpcError OR — during a
    // throttle where get_peer works but the get_gate reads don't — a false EMPTY list. Both are
    // transient, so we auto-retry both (bounded) with backoff before believing a real "no access":
    // an empty result is suspicious while the RPC is flaky, and briefly showing "no developers" then
    // until we have a trustworthy answer.
    setRpcError(false);
    setDevelopers(null);
    setConnLog([{ text: "connecting to the network", state: "pending" }]);
    (async () => {
      const MAX = 5;
      for (let attempt = 0; attempt < MAX && !cancelled; attempt++) {
        try {
          const r = await fetch(`/api/agent/developers?agent=${encodeURIComponent(accountId)}`);
          const d = await r.json();
          if (cancelled) return;
          const list = Array.isArray(d.developers) ? d.developers : [];
          // A `stale` result is the server's persisted last-known access served because the chain was
          // unreachable — that's a GOOD answer (cards show), don't retry it. Otherwise an rpcError or a
          // (suspicious) empty during a flaky RPC is worth retrying before believing "no access".
          const retryable = !d.stale && (d.rpcError || list.length === 0);
          if (retryable && attempt < MAX - 1) {
            setConnLog([
              { text: "checking your access", state: "warn", detail: `network busy, retrying (${attempt + 1}/${MAX})…` },
            ]);
            await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
            continue;
          }
          // Final answer: only call it an RPC problem if the server said so (a persistent empty after
          // all retries is a genuine "no access", not an error).
          setRpcError(!!d.rpcError);
          setDevelopers(list);
          if (list.length > 0) {
            setConnLog([
              { text: "your agency", state: "ok", detail: d.agency ?? undefined },
              {
                text: "properties you can offer",
                state: "ok",
                detail: `${list.length} developer${list.length === 1 ? "" : "s"}${d.stale ? " (last known)" : d.cached ? " (cached)" : ""}`,
              },
            ]);
          }
          return;
        } catch {
          if (cancelled) return;
          if (attempt < MAX - 1) {
            setConnLog([
              { text: "checking your access", state: "warn", detail: `network busy, retrying (${attempt + 1}/${MAX})…` },
            ]);
            await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
            continue;
          }
          setRpcError(true);
          setDevelopers([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, reloadKey, role]);

  // Cascading selection: developer → building → unit.
  const [devAccount, setDevAccount] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [terms, setTerms] = useState("");
  // The unit whose full DETAIL screen (A3) is open — the tap target on the grid. null = the grid view.
  const [openUnitId, setOpenUnitId] = useState<string | null>(null);
  // The customer's assembled payment plan (A4) from the calculator tab — hashed into the booking's
  // request_hash: the raw plan stays off-chain; only its hash goes on-chain).
  const [plan, setPlan] = useState<import("@/components/PaymentCalculator").AssembledPlan | null>(null);
  // Buyer ownership type — chosen FIRST for a quota building. Only "freehold" (foreigner)
  // consumes the 49% foreign-freehold pool; "company" (Thai Company) + "individual" (local in own name)
  // never do. Drives which price shows + which units are bookable. null = not yet chosen.
  const [buyerType, setBuyerType] = useState<BuyerType | null>(null);
  // when the agent taps Reserve with NO buyer attached, we don't dead-disable the button; we open a
  // prompt (pick an existing buyer, add a new one inline, or cancel). This holds that prompt's open state.
  const [buyerPromptOpen, setBuyerPromptOpen] = useState(false);
  // Signal to the BuyerPicker to open its inline add-form (set when the agent chooses "Add new" in the prompt).
  const [buyerPromptAddNew, setBuyerPromptAddNew] = useState(false);
  // Set when a booking failed because the unit was taken mid-browse (the read-vs-book race) — carries
  const [raceSuggestion, setRaceSuggestion] = useState<{ tookUnitId: string; altId: string } | null>(null);

  // customer roster — the buyers THIS agent owns + reuses across deals. null = not loaded yet.
  const [roster, setRoster] = useState<RosterBuyer[] | null>(null);
  // The buyer attached to the booking in progress (its snapshot fills the offer seal's `buyer` slot). The
  // agent picks one of their roster, or leaves it empty (allowed — the developer sees "detail not yet
  // provided" and may decline. Reset per building like the other selections.
  const [buyerId, setBuyerId] = useState<string>("");
  // anti-poaching masking — which preset the agent applies to the attached buyer so the developer
  // sees only a non-identifying proof until the deposit unlocks it. Default = first+last char of name/id,
  // country shown, contact hidden (presetMask). The full per-field customiser is a later polish; v1 ships
  // the three one-click presets. Only meaningful when a buyer is attached; dropped from the seal otherwise.
  const [maskPreset, setMaskPreset] = useState<MaskPreset>("default");

  // Load this agent's roster once signed in; refresh on demand after an add/edit.
  const loadRoster = useMemo(
    () => async () => {
      if (!accountId) return;
      try {
        const r = await fetch(`/api/buyers?agent=${encodeURIComponent(accountId)}`);
        const d = await r.json();
        setRoster(Array.isArray(d.buyers) ? d.buyers : []);
      } catch {
        setRoster([]);
      }
    },
    [accountId]
  );
  useEffect(() => {
    if (!accountId) {
      setRoster(null);
      return;
    }
    void loadRoster();
  }, [accountId, loadRoster]);

  const selectedBuyer = useMemo(
    () => roster?.find((b) => b.id === buyerId) ?? null,
    [roster, buyerId]
  );

  // Building load + status via the SHARED hook (same snapshot-first, per-floor-tap pattern as the
  // developer app). Replaces the old eager full-building chunk-walk that re-fetched all ~200
  // units every time you switched buildings and back (and bursted the RPC). The hook seeds from the
  // snapshot instantly; floors only read the chain on tap.
  const bs = useBuildingStatus(buildingId, accountId);
  const building = bs.data?.building ?? null;
  const statusMap = bs.status;

  // Foreign-freehold quota for the open building — recomputed as availability changes. `enabled`
  // is false for buildings the developer didn't configure with a quota → the whole buyer-type layer
  // disappears and the flow behaves exactly as before.
  const quota: FreeholdQuota = useMemo(
    () => (building ? freeholdQuota(building, statusMap) : emptyQuota()),
    [building, statusMap]
  );
  const quotaOn = quota.enabled;
  // A quota building must have its buyer type chosen before booking; a non-quota building doesn't.
  const buyerReady = !quotaOn || buyerType !== null;

  // shown as available; a local sees them all"). For a FREEHOLD buyer we downgrade open units that
  // wouldn't fit the remaining 49% quota from 0 (available) to 2 (shown as reserved/unavailable) in the
  // map the grid + counts read — so the freehold view naturally hides what a foreigner can't take.
  // Local (company/private) buyers see the real map unchanged. No quota → unchanged.
  const viewStatus: Record<string, number> = useMemo(() => {
    if (!building) return statusMap;
    const adjusted: Record<string, number> = { ...statusMap };
    for (const u of building.inventory) {
      // Off-market units (blocked/killed) are DEVELOPER-ONLY — an agent never sees them as
      // bookable. Force them unavailable regardless of buyer type. (Killed ones are also stripped from
      // the inventory the buyer views; this belt-and-suspenders covers the status map.)
      if (u.offMarket) {
        adjusted[u.id] = 2;
        continue;
      }
      // Freehold quota: hide what a foreign freehold buyer can't take for this size.
      if (quotaOn && buyerType === "freehold" && adjusted[u.id] === 0 && !bookableForBuyer(u, "freehold", quota)) {
        adjusted[u.id] = 2;
      }
    }
    return adjusted;
  }, [quotaOn, buyerType, building, statusMap, quota]);

  // A live exclusive held by an agency OTHER than this agent's own blocks the selected unit —
  // the contract enforces it (E58); we surface it before signing. Holds the blocking agency id or null.
  const [heldByOther, setHeldByOther] = useState<string | null>(null);
  const [myAgency, setMyAgency] = useState<string | null>(null);
  // A human message if the availability check itself couldn't run (e.g. insecure-context crypto over a
  // plain http://<LAN-IP> address, where crypto.subtle is undefined). Kept separate so a preview
  // failure never crashes the page and we can tell the agent what to fix.
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const { state, run, busy } = useTxRun();

  const selectedDev = useMemo(
    () => developers?.find((d) => d.account === devAccount) ?? null,
    [developers, devAccount]
  );
  // All building ids across the developers this agency is gated to → the building cards are scoped to
  // exactly these (the information gate, vrx-read-privacy-model). Plus a building→developer map so
  // opening a card sets the right node_id for the booking.
  const gatedBuildingIds = useMemo(
    () => (developers ?? []).flatMap((d) => d.buildings.map((b) => b.id)),
    [developers]
  );
  const buildingToDev = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of developers ?? []) for (const b of d.buildings) m[b.id] = d.account;
    return m;
  }, [developers]);
  const selectedUnit = useMemo(() => {
    const u = building?.inventory.find((x) => x.id === unitId);
    if (!u) return null;
    // Attach the live status from the progressive map so the preview + label read correctly (the lazy
    // catalog inventory carries no status).
    return { ...u, status: statusMap[u.id] ?? -1 };
  }, [building, unitId, statusMap]);
  // The canonical on-chain reference the developer stamped: "<building>/<unit>".
  const unitRef = buildingId && unitId ? `${buildingId}/${unitId}` : "";

  useEffect(() => {
    if (!accountId) {
      setMyAgency(null);
      return;
    }
    getPeer(accountId)
      .then((p) => setMyAgency((p as { g?: string } | null)?.g ?? null))
      .catch(() => setMyAgency(null));
  }, [accountId]);

  // Reset the unit selection whenever the building changes; the shared hook (useBuildingStatus) loads
  // the building + seeds status from the snapshot and handles per-floor tap-to-load — no eager fill.
  useEffect(() => {
    setUnitId("");
    setOpenUnitId(null);
    setBuyerType(null); // re-pick the buyer type per building (only asked when the building has a quota)
    setBuyerId(""); // re-pick which roster customer this booking is for, per building
  }, [buildingId]);

  // When a unit is selected, check for a live exclusive held by ANOTHER agency (the unit stays OPEN
  // under an exclusive — the held state lives only in get_exclusive, not the tile status).
  useEffect(() => {
    let cancelled = false;
    setHeldByOther(null);
    setCheckErr(null);
    if (!unitRef) return;
    (async () => {
      try {
        const key = await hashRef(unitRef, "vrx-unit");
        const ex = await getExclusive(key).catch(() => null);
        if (cancelled) return;
        const holder = liveHolder(ex);
        setHeldByOther(holder && holder !== myAgency ? holder : null);
      } catch (e) {
        if (cancelled) return;
        setCheckErr(e instanceof Error ? e.message : "Could not check this unit right now.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unitRef, myAgency]);

  async function submit() {
    if (!devAccount || !unitRef) return;
    if (heldByOther || checkErr) return; // guarded in the UI; the contract would also reject it
    if (!buyerReady) return; // quota building: the buyer type must be chosen first
    // a buyer is REQUIRED (supersedes). Reserve with no buyer doesn't fail silently: open the
    // pick/add/cancel prompt so the agent attaches (or creates) a buyer and continues. The button stays live.
    if (noBuyer) {
      setBuyerPromptOpen(true);
      return;
    }
    // §3c new-deal admission gate: a developer PAUSED for overdue VRX fees can't take NEW bookings
    // (existing deals continue — they never reach this path). Off-chain courtesy block, like the quota
    // re-check above: refuse here with a clear note rather than send a doomed/unwanted tx. The eventual
    // on-chain enforcement suspends the gate (open_claim would then NO_GATE); the /api/offers POST guard
    // is the server belt today. The UI already shows the paused note (devPaused) on the unit screen.
    if (selectedDev?.listingsPaused) return;
    // Freehold quota RE-CHECK at submit: a foreign booking must still
    // fit under the cap now (another freehold booking may have landed since we painted the grid). This
    // is an off-chain courtesy gate — the chain doesn't know about the quota — so we simply block with a
    // clear message rather than sending a doomed tx. Company/individual buyers are never quota-limited.
    if (quotaOn && buyerType && selectedUnit && !bookableForBuyer(selectedUnit, buyerType, quota)) {
      return; // the UI already shows the "quota full for this size" note; nothing to send
    }
    // fail-closed RELEASE gate: a unit is bookable only if its building has gone ON
    // CONTRACT (released) AND the unit is stamped OPEN (status 0). This is the REAL off-chain enforcement
    // today — it refuses BEFORE open_claim is sent, so a not-yet-released unit genuinely can't be booked
    // (the /api/offers POST is only a post-chain record belt). Fail-closed: no onContract flag (not
    // released, or a stale pre-flag cache) → refuse. The UI shows the not-bookable note on the unit screen.
    if (!bookable) return;
    setRaceSuggestion(null);
    // Carried out of the tx closure so we can persist the PLAINTEXT offer once the on-chain seal
    // confirms — the inbox can then show + verify it. The seal object MUST be byte-identical to what we
    // hash below (same fields/shape/domain), or the developer's re-hash check would show a false mismatch.
    let persist: { requestId: string; requestHash: string; seal: Record<string, unknown> } | null = null;
    const ok = await run(
      async () => {
        const unitKey = await hashRef(unitRef, "vrx-unit");
        // request_id must be unique; derive an opaque one from the tuple + a timestamp.
        const requestId = await hashRef(
          { node: devAccount, unit: unitKey, by: accountId, at: Date.now() },
          "vrx-req"
        );
        // The opaque request_hash carries the free-text notes, the assembled payment plan (A4), AND the
        // ownership/quota promise (: buyer type + freehold flag) — all hashed off-chain, so
        // the full deal terms bind the request without ever going on-chain. The chain just WITNESSES the
        // freehold promise; it never sees the plaintext.
        // The SEAL (what we hash) — keep this object in lock-step with the persisted `seal` below.
        // `buyer` is the seam: an optional slot for the attested buyer snapshot. The roster arc now
        // FILLS it — if the agent attached a buyer, its snapshot (buyerSnapshot, a flat PII map) goes here
        // and becomes part of the request_hash, so the developer inbox sees + ✓-verifies the buyer detail.
        // Left `undefined` when no buyer is attached, so JSON.stringify drops it → the hash is identical to
        // a booking made before a buyer was chosen (minimal is allowed; the developer may decline).
        const buyerAttached = selectedBuyer ? buyerSnapshot(selectedBuyer.fields) : undefined;
        // — the agent's per-field MASK choice, sealed alongside the buyer so "what was shown when" is
        // tamper-evident. Only when a buyer is attached (else undefined → JSON.stringify drops it → the
        // digest is unchanged for buyer-less bookings, exactly like the `buyer` slot).
        const buyerMaskAttached: BuyerMask | undefined = buyerAttached ? presetMask(maskPreset) : undefined;
        const seal: Record<string, unknown> = {
          terms: terms.trim(),
          plan: plan ?? null,
          ownership: quotaOn ? buyerType : undefined,
          freehold: quotaOn ? buyerType === "freehold" : undefined,
          buyer: buyerAttached,
          buyerMask: buyerMaskAttached,
          by: accountId,
        };
        const requestHash = await hashRef(seal, "vrx-terms");
        persist = { requestId, requestHash, seal };
        const built = openClaimArgs(requestId, unitKey, devAccount, requestHash);
        const deposit = await depositFor(accountId!);
        return callFunction({ method: built.method, args: built.args, deposit });
      },
      { successNote: "Booking request sent.", mapError: openErr, ensureGasFor: accountId }
    );
    if (ok) {
      // Persist the plaintext offer alongside the on-chain seal ( attested record). Fire-and-forget:
      // the booking already succeeded on-chain; this only powers the readable, VERIFIABLE developer inbox.
      // The chain remains the authority. (If this POST fails, the inbox simply shows "offer unavailable".)
      if (persist) {
        const p = persist as { requestId: string; requestHash: string; seal: Record<string, unknown> };
        fetch("/api/offers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: p.requestId,
            requestHash: p.requestHash,
            developer: devAccount,
            seal: p.seal,
            display: { buildingId, unitId, buyerType: quotaOn ? buyerType : null, buyerId: selectedBuyer?.id },
          }),
        }).catch(() => {});
      }
      setTerms("");
      return;
    }
    // have landed between the read and this submit. Re-check the unit live; if it's no longer open, it's
    // the race — offer the nearest available same-type unit with a comforting message rather than just
    // a bare error. (The contract already PREVENTED the double-book; this just makes the rare loss kind.)
    try {
      const nowStatus = await bs.ensureUnitStatus(unitId);
      if (nowStatus !== 0 && building) {
        const alt = nearestSameType(building, unitId, statusMap);
        if (alt) setRaceSuggestion({ tookUnitId: unitId, altId: alt.id });
      }
    } catch {
      /* if the re-check itself can't run, the plain error from `run` already showed — leave it */
    }
  }

  // For a quota building the selected unit must also be bookable for the chosen buyer type (freehold
  // buyers can't take a unit that would breach the cap). Company/individual are never blocked.
  const quotaBlocks =
    quotaOn && buyerType != null && !!selectedUnit && !bookableForBuyer(selectedUnit, buyerType, quota);
  // — the buyer-detail gate. A buyer is now REQUIRED before booking (supersedes its
  // "attaching a buyer is optional"): you cannot book a unit FOR a buyer without a buyer on record, else the
  // agent carries a ghost deal. The required DETAIL is THIS developer's `requiredProfileFields` ( §9) —
  // passport / full legal name / contact, whatever they set — falling back to the global default floor when
  // they set none. Shown PRE-EMPTIVELY (below the picker) so the agent knows what's needed before Reserve,
  // not as a post-hoc rejection. A partial buyer is fine to CREATE; it just can't be booked until it clears.
  const buyerPolicy = selectedBuyer
    ? checkBuyerPolicy(selectedBuyer.fields, "book", selectedDev?.requiredProfileFields)
    : { ok: false, gaps: [] };
  const noBuyer = !selectedBuyer;
  const buyerBlocks = !buyerPolicy.ok; // true when no buyer OR an attached buyer misses the developer's reqs
  // PRE-EMPTIVE requirement hint — a human list of what THIS developer needs on a buyer, shown on the
  // picker + the submit note BEFORE Reserve so the agent prepares the right detail (no post-hoc surprise).
  // Derived from the developer's requiredProfileFields; empty when they use the default floor (we then show
  // the generic floor wording). De-duped (passport/idCard collapse to one).
  const requiredHint = useMemo(() => {
    const req = selectedDev?.requiredProfileFields;
    if (!req || req.length === 0) return "full name, country and ID on file";
    const LABELS: Record<string, string> = {
      legalName: "full legal name", nationality: "country / nationality", phone: "phone",
      email: "email", passportNo: "passport / ID number", idCardNo: "passport / ID number",
      address: "residential address",
    };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of req) { const l = LABELS[k]; if (l && !seen.has(l)) { seen.add(l); out.push(l); } }
    return out.join(", ");
  }, [selectedDev]);
  // §3c: a developer PAUSED for overdue VRX fees can't take NEW bookings (existing deals continue).
  const devPaused = selectedDev?.listingsPaused === true;
  // fail-closed RELEASE gate (client mirror of lib/bookable.isBookable): a unit is bookable
  // only if its building has gone ON CONTRACT (released) AND the unit is stamped OPEN (status 0). `onContract`
  // ships per-building from the picker route; fail-closed — absent/false (not released, or a stale pre-flag
  // cache) → NOT bookable. The unit-open half: only open units are selectable + the submit re-checks live
  // status, but we assert it here too so the single `bookable` flag is the honest gate.
  const buildingOnContract =
    selectedDev?.buildings.find((b) => b.id === buildingId)?.onContract === true;
  const bookable = buildingOnContract && !!selectedUnit && selectedUnit.status === 0;
  const notReleased = !!selectedUnit && !buildingOnContract;
  // An ATTACHED buyer that misses this developer's requirements → a hard block (the agent must fix the buyer
  // first). NO buyer is NOT a hard disable: the button stays live and its click opens the pick/add prompt
  //. So the submit button is enabled for every non-buyer precondition + (a buyer attached & complete)
  // OR (no buyer yet — click routes to the prompt).
  const buyerIncomplete = !noBuyer && !buyerPolicy.ok;
  const canSubmit =
    !!devAccount && !!unitId && !heldByOther && !checkErr && !busy && buyerReady && !quotaBlocks &&
    !buyerIncomplete && !devPaused && bookable && (noBuyer || buyerPolicy.ok);

  // Dashboard-shell — unlike /node, /agency, /root (each a stack of independent sections), the agent
  // page is ONE continuous booking FLOW (building cards → unit grid → unit detail → send request) with all
  // its state lifted to this component. So it maps to a SINGLE shell section — the shell just gives it the
  // same topbar + sidebar chrome (the one "Book a unit" sidebar link mirrors navFor). The flow body below
  // is unchanged; only the outer <main> + heading are replaced by the shell. Only built when signed in as
  // an agent; otherwise the shell shows just the RoleBanner.
  const flow = (
    <>
      {/* Resolving access (get_peer + gates, with retries on a flaky RPC) — a live DOS-style progress
          log so the page never looks like an empty "no access" while it's still working, and the user
 sees WHY it's waiting ("network busy, retrying") (the idea). */}
      {accountId && isPeer !== false && developers === null && connLog.length > 0 && (
        <div style={{ ...card }}>
          <ConnectLog lines={connLog} title="Finding the properties you can offer…" />
        </div>
      )}

      {accountId && isPeer && developers !== null && developers.length === 0 && rpcError && (
        <NetworkTrouble onRetry={() => setReloadKey((k) => k + 1)} />
      )}
      {accountId && isPeer && developers !== null && developers.length === 0 && !rpcError && <NoAccess />}

      {/* Building cards (scoped to gated developers). Tap a card → open its grid + booking form. */}
      {accountId && isPeer && developers !== null && developers.length > 0 && !buildingId && (
        <section style={card}>
          <BuildingCards
            heading="Available properties"
            filterIds={gatedBuildingIds}
            account={accountId}
            onOpen={(id) => {
              setBuildingId(id);
              setDevAccount(buildingToDev[id] ?? "");
              setUnitId("");
            }}
          />
        </section>
      )}

      {accountId && isPeer && developers !== null && developers.length > 0 && buildingId && (
        <section style={card}>
          <button
            type="button"
            onClick={() => {
              setBuildingId("");
              setUnitId("");
            }}
            style={{ ...submitBtn, padding: "5px 11px", fontSize: 13, background: "#18202f", color: "#c7cde0", marginBottom: 14 }}
          >
            ← All properties
          </button>

          {building && (
            <>
              {/* Featured image: the building-selected screen showed only name + area — no photo,
                  though the media is already loaded (bs.data.images). Show the building's hero (first
                  exterior shot) so the picked building looks like the card the agent just tapped. Absent-safe
                  — no media yet → just the name block, as before. */}
              {(() => {
                const hero = bs.data?.images?.exterior?.[0] ?? null;
                return hero ? (
                  <div style={{ margin: "0 0 12px", borderRadius: 8, overflow: "hidden", aspectRatio: "16 / 7", background: "#0f1420" }}>
                    <img src={hero} alt={building.name} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }} />
                  </div>
                ) : null;
              })()}
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 2 }}>{building.name}</div>
              <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 12 }}>
                {selectedDev?.name} · {building.area}
              </div>
              {/* Non-disruptive update prompt: a newer availability snapshot is ready. The agent
                  chooses — never yanked mid-booking. */}
              {bs.update && (
                <div
                  style={{
                    ...banner,
                    border: "1px solid #2a4a6e",
                    background: "#0f1c2e",
                    fontSize: 13,
                    marginBottom: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ flex: 1 }}>Updated availability is ready.</span>
                  <button
                    type="button"
                    onClick={() => void bs.applyUpdate()}
                    style={{ ...submitBtn, padding: "4px 12px", fontSize: 13 }}
                  >
                    Show latest
                  </button>
                  <button
                    type="button"
                    onClick={bs.dismissUpdate}
                    style={{ padding: "4px 10px", fontSize: 13, background: "transparent", color: "#8a93a8", border: "1px solid #2a3350", borderRadius: 7, cursor: "pointer" }}
                  >
                    Not now
                  </button>
                </div>
              )}
              <BuildingSummaryBlock building={building} status={statusMap} money={money} />

              {/* Location + access roads — absent-safe (hidden until the developer sets a location). */}
              {building.geo && (
                <div style={{ margin: "14px 0" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>📍 Location & access</div>
                  <SitePlanMap geo={building.geo} height={220} />
                </div>
              )}

              {/* Buyer-type-first: a building the developer configured with a foreign-freehold
                  quota asks WHO the buyer is before browsing units — the quota question comes first
 . This drives the price shown + which units a foreign buyer may book. Buildings
                  with no quota skip this entirely. */}
              {quotaOn && (
                <BuyerTypePicker
                  building={building}
                  value={buyerType}
                  onChange={(t) => {
                    setBuyerType(t);
                    setUnitId("");
                    setOpenUnitId(null);
                  }}
                  quota={quota}
                />
              )}
            </>
          )}

          {/* A3 unit-detail screen (double-click a unit) — gallery + specs + terms + reserve. Slotting
              A4's offer form into its footer is the next step. */}
          {building && openUnitId && (() => {
            const u = building.inventory.find((x) => x.id === openUnitId);
            if (!u) return null;
            return (
              <>
                <UnitDetail
                  building={building}
                  unit={u}
                  images={bs.data?.images ?? null}
                  status={statusMap[u.id]}
                  verifiedAt={bs.unitVerifiedAt(u.id)}
                  buyerType={quotaOn ? buyerType : null}
                  quota={quotaOn ? quota : null}
                  onClose={() => {
                    setOpenUnitId(null);
                    setUnitId("");
                  }}
                  onPlanChange={setPlan}
                  onReserve={() => setUnitId(u.id)}
                />

                {/* Booking happens HERE, inside the unit's detail (: one way to book — via the
                    unit detail, not a separate flat form). Tapping "Reserve" in the detail selects the
                    unit; then the agent enters the offer/terms and sends. All the submit logic stays in
                    the parent; we just render its controls in the detail context. */}
                {unitId === u.id && (
                  <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: "18px 0 0" }}>
                    <UnitPreview
                      // The raw inventory unit carries NO status (lazy catalog) — attach the live status
                      // from the map, else UnitPreview reads undefined → shows "unavailable" on an
                      unit={{ ...u, status: statusMap[u.id] ?? -1 }}
                      heldByOther={heldByOther}
                      checkErr={checkErr}
                      verifiedAt={bs.unitVerifiedAt(u.id)}
                      buyerType={quotaOn ? buyerType : null}
                      quotaBlocks={quotaBlocks}
                    />
                    {/* attach the buyer this booking is FOR. REQUIRED (supersedes):
                        a booking always has a buyer on record. Pick from the roster or add one inline; the
                        picker shows, pre-emptively, what THIS developer requires on the buyer. */}
                    <BuyerPicker
                      roster={roster}
                      value={buyerId}
                      onChange={setBuyerId}
                      onAdded={async (b) => {
                        await loadRoster();
                        setBuyerId(b.id);
                      }}
                      accountId={accountId}
                      requiredHint={requiredHint}
                      startAdding={buyerPromptAddNew}
                      onStartAddingHandled={() => setBuyerPromptAddNew(false)}
                    />
                    {/* Reserve-with-no-buyer prompt: pick an existing buyer, add a new one (opens the
                        inline form above), or cancel. Shown in place; keeps the half-built offer intact. */}
                    {buyerPromptOpen && noBuyer && (
                      <div style={{ margin: "0 0 12px", padding: "12px 14px", background: "#1a2230", border: "1px solid #2f3a52", borderRadius: 10 }}>
                        <p style={{ margin: "0 0 10px", fontSize: 13, color: "#c7cde0" }}>
                          A booking is always <strong>for a buyer</strong>. Pick one from your list or add a new one.
                          {requiredHint && <><br /><span style={{ fontSize: 11.5, color: "#9aa6be" }}>This developer needs: {requiredHint}.</span></>}
                        </p>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {(roster?.length ?? 0) > 0 && (
                            <button type="button" onClick={() => setBuyerPromptOpen(false)}
                              style={{ ...submitBtn, padding: "7px 12px", fontSize: 13 }}>
                              Pick from my list
                            </button>
                          )}
                          <button type="button" onClick={() => { setBuyerPromptOpen(false); setBuyerPromptAddNew(true); }}
                            style={{ ...submitBtn, padding: "7px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}>
                            + Add a new buyer
                          </button>
                          <button type="button" onClick={() => setBuyerPromptOpen(false)}
                            style={{ padding: "7px 12px", fontSize: 13, borderRadius: 7, border: "1px solid #2a3350", background: "transparent", color: "#9aa6be", cursor: "pointer" }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {/* how much of the attached buyer the developer sees BEFORE the deposit unlocks
                        it. Protects your customer from being poached: the developer sees a proof a real,
                        vetted buyer is committed, but not enough to contact them. You can always reveal
                        early, and it auto-unlocks when the deposit is paid. */}
                    {selectedBuyer && (
                      <MaskPresetPicker value={maskPreset} onChange={setMaskPreset} />
                    )}
                    {/*  pt-2 — attach the buyer's encrypted KYC documents + contract details. Optional
                        booking; completable up to signing. The developer reviews these before finalising. */}
                    {selectedBuyer && accountId && (
                      <KycVaultPanel buyerId={selectedBuyer.id} agent={accountId} />
                    )}
                    <label style={lbl}>
                      Offer / terms <span style={{ opacity: 0.6 }}>— price, buyer reference, notes</span>
                    </label>
                    <textarea
                      value={terms}
                      onChange={(e) => setTerms(e.target.value)}
                      rows={3}
                      placeholder="Your offer and any notes for the developer — kept private."
                      style={{ ...input, fontFamily: "inherit", resize: "vertical" }}
                    />
                    <button type="button" onClick={submit} disabled={!canSubmit} style={submitBtn}>
                      {busy
                        ? "Signing…"
                        : devPaused
                        ? "Developer listings paused"
                        : notReleased
                        ? "Not released for booking yet"
                        : heldByOther
                        ? "Reserved for another agency"
                        : quotaBlocks
                        ? "Freehold quota full for this size"
                        : buyerIncomplete
                        ? "Buyer detail incomplete"
                        : noBuyer
                        ? "Reserve this unit"
                        : "Send booking request"}
                    </button>
                    {devPaused && (
                      <p style={{ fontSize: 11.5, color: "#e8b84b", margin: "6px 0 0" }}>
                        This developer&rsquo;s listings are paused while overdue platform fees are settled.
                        Existing deals continue; new bookings can&rsquo;t be opened until this clears.
                      </p>
                    )}
                    {notReleased && (
                      <p style={{ fontSize: 11.5, color: "#e8b84b", margin: "6px 0 0" }}>
                        This building isn&rsquo;t released for booking yet. The developer has to put it on
                        contract before its units can be reserved.
                      </p>
                    )}
                    {noBuyer && !devPaused && !notReleased && !heldByOther && !quotaBlocks && (
                      <p style={{ fontSize: 11.5, color: "#9aa6be", margin: "6px 0 0" }}>
                        A booking is always FOR a buyer — tap <strong>Reserve</strong> to pick one from your
                        list or add a new one. {requiredHint && <>This developer requires: {requiredHint}.</>}
                      </p>
                    )}
                    {buyerIncomplete && (
                      <p style={{ fontSize: 11.5, color: "#e8b84b", margin: "6px 0 0" }}>
                        {policySummary(buyerPolicy)}. Edit the buyer to add it before you can reserve.
                      </p>
                    )}
                  </fieldset>
                )}
              </>
            );
          })()}

          {/* A quota building waits for the buyer type before showing units (: quota question
              first). Non-quota buildings render units immediately (buyerReady is always true). */}
          {building && !buyerReady && (
            <p style={{ opacity: 0.65, fontSize: 14, marginTop: 8 }}>
              Choose who the unit is for above to see availability and pricing.
            </p>
          )}

          {/* The grid is now the ONLY entry point: tap a unit → its detail opens, and the
              booking is made from inside that detail (above). No separate flat offer form here. Hidden
              while a unit detail is open (the detail replaces it) or before a quota buyer type is chosen. */}
          {!openUnitId && buyerReady && (
            <div>
              {building && (
                <UnitPicker
                  building={building}
                  statusMap={viewStatus}
                  buyerType={buyerType}
                  quota={quota}
                  filling={bs.filling || bs.loading}
                  busy={bs.busy}
                  selectedId={unitId}
                  snapshotAt={bs.data?.snapshot?.filledAt ?? null}
                  onRefresh={() => void bs.refreshStatus()}
                  isFloorReady={bs.isFloorReady}
                  isFloorFresh={bs.isFloorFresh}
                  onLoadFloor={(f) => void bs.loadFloor(f)}
                  onSelect={(id) => {
                    // A tap = open that unit's detail (the single booking path).
                    void bs.ensureUnitStatus(id);
                    setOpenUnitId(id);
                  }}
                  onOpenDetail={(id) => setOpenUnitId(id)}
                  onProbeUnit={async (id) => {
                    // safe single read), so even before a floor is loaded the agent gets a real answer.
                    return await bs.ensureUnitStatus(id);
                  }}
                />
              )}
              {!building &&
                (bs.loading ? (
                  <LoadingUnits />
                ) : (
                  <p style={{ opacity: 0.6, fontSize: 14, marginTop: 8 }}>No units available.</p>
                ))}
            </div>
          )}

          <TxProgress state={state} />

          {/* Read-vs-book race: the unit was taken while the agent was working on it. Comfort +
              offer the nearest same-type unit — the double-book was already prevented on-chain. */}
          {raceSuggestion && building && (() => {
            const alt = building.inventory.find((u) => u.id === raceSuggestion.altId);
            if (!alt) return null;
            return (
              <div style={{ ...banner, border: "1px solid #6b5426", background: "#241d0e", fontSize: 13.5, marginTop: 12 }}>
                <p style={{ margin: "0 0 6px", fontWeight: 600 }}>
                  That one just got reserved — sorry!
                </p>
                <p style={{ margin: "0 0 10px", opacity: 0.85 }}>
                  This is rare, but while you were putting the offer together, another buyer&apos;s deposit
                  landed on this unit first. The nearest match of the same type is{" "}
                  <strong>{alt.id.replace(/^unit-/, "Unit ")}</strong> · {alt.type.toUpperCase()} ·{" "}
                  {alt.sqm}m²{alt.floor ? ` · floor ${alt.floor}` : ""} · {money(alt.priceUsd)}.
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setUnitId(alt.id);
                      setRaceSuggestion(null);
                    }}
                    style={{ ...submitBtn, padding: "5px 12px", fontSize: 13 }}
                  >
                    Offer {alt.id.replace(/^unit-/, "Unit ")} instead
                  </button>
                  <button
                    type="button"
                    onClick={() => setRaceSuggestion(null)}
                    style={{ padding: "5px 11px", fontSize: 13, background: "transparent", color: "#8a93a8", border: "1px solid #2a3350", borderRadius: 7, cursor: "pointer" }}
                  >
                    Pick another myself
                  </button>
                </div>
              </div>
            );
          })()}
        </section>
      )}
    </>
  );

  const sections: ShellSection[] =
    accountId && isPeer
      ? [
          { id: "book", label: "Book a unit", icon: "🏢", keepAlive: true, element: flow },
          {
            id: "bookings",
            label: "My bookings",
            icon: "📨",
            keepAlive: true,
            element: <AgentBookings accountId={accountId} money={money} />,
          },
          {
            id: "conversations",
            label: "Conversations",
            icon: "💬",
            keepAlive: true,
            badge: unreadConversations,
            element: <Conversations accountId={accountId} viewerRole="agent" />,
          },
          {
            id: "news",
            label: "News",
            icon: "🕑",
            keepAlive: true,
            element: (
              <EventLog
                me={accountId}
                role="agent"
                title="News"
                blurb="Updates from the developers you work with — bookings, agreements and listing changes."
              />
            ),
          },
          {
            id: "buyers",
            label: "My buyers",
            icon: "👤",
            keepAlive: true,
            element: (
              <BuyerRoster
                roster={roster}
                accountId={accountId}
                onChanged={loadRoster}
              />
            ),
          },
          {
            id: "protection",
            label: "Buyer protection",
            icon: "🔒",
            keepAlive: true,
            element: <BuyerProtection accountId={accountId} />,
          },
          {
            id: "tokens",
            label: "Booking tokens",
            icon: "🎟",
            keepAlive: true,
            element: <AgentTokensPanel me={accountId} />,
          },
          // $VRX practice money — demo-only; the section only appears under the demo flag so a real
          // deploy never shows play-money (the panel itself also fail-closes to null).
          ...(DEMO_MODE_FLAG
            ? [{
                id: "demo-money",
                label: "$VRX practice",
                icon: "🪙",
                keepAlive: true,
                element: <DemoCurrencyPanel me={accountId} />,
              } as ShellSection]
            : []),
        ]
      : [];

  return (
    <DashboardShell
      title="Reserve a unit"
      persistKey="agent"
      intro="Reserve an available unit on behalf of a buyer — private & confidential"
      banner={<RoleBanner ready={ready} accountId={accountId} isPeer={isPeer} signIn={signIn} />}
      topSlot={accountId && isPeer ? <HaltNotices me={accountId} /> : undefined}
      sections={sections}
    />
  );
}

// Buyer-type-first selector — shown for a building the developer configured with a foreign-
// Freehold (foreigner, quota-limited) vs the LOCAL side (Company + Private grouped, the ≥51%). Only
function BuyerTypePicker({
  building,
  value,
  onChange,
  quota,
}: {
  building: CatalogBuilding;
  value: BuyerType | null;
  onChange: (t: BuyerType) => void;
  quota: FreeholdQuota;
}) {
  // Foreign (freehold) is the scarce capped side; Company + Private are grouped as the LOCAL side (the
  // ≥51%). We show the foreign side its own m²-left number, and the two local buckets share the local
  const foreignLeft = quota.foreign.availableSqm;
  const localLeft = quota.local.availableSqm;
  const options: { key: BuyerType; blurb: string; side: "foreign" | "local" }[] = [
    { key: "freehold", blurb: "Foreign buyer, freehold title", side: "foreign" },
    { key: "company", blurb: "Held through a company", side: "local" },
    { key: "private", blurb: "Local citizen, own name", side: "local" },
  ];
  return (
    <div style={{ margin: "4px 0 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <label style={{ ...lbl, marginBottom: 8 }}>Quota</label>
        <div style={{ fontSize: 11.5, opacity: 0.75, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span>
            <span style={{ color: "#8fc4ff" }}>Foreign {quota.pct}%</span>{" "}
            {quota.foreign.soldPct > 0 && <span style={{ color: "#e0705a" }}>{quota.foreign.soldPct}% sold · </span>}
            {foreignLeft.toLocaleString()} m² left{quota.foreignIsEstimate ? "*" : ""}
          </span>
          <span>
            <span style={{ color: "#8fc4ff" }}>Local {100 - quota.pct}%</span>{" "}
            {quota.local.soldPct > 0 && <span style={{ color: "#e0705a" }}>{quota.local.soldPct}% sold · </span>}
            {localLeft.toLocaleString()} m² left
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {options.map((o) => {
          const active = value === o.key;
          const left = o.side === "foreign" ? foreignLeft : localLeft;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onChange(o.key)}
              style={{
                flex: "1 1 150px",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${active ? "#2f6bff" : "#2a3350"}`,
                background: active ? "#12203a" : "#0e1119",
                color: "#e8ecf4",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14.5 }}>{buyerLabel(building, o.key)}</div>
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>{o.blurb}</div>
              <div style={{ fontSize: 11.5, color: left > 0 ? "#8fc4ff" : "#e0953a", marginTop: 6 }}>
                {left > 0 ? `${left.toLocaleString()} m² available` : "fully allocated"}
              </div>
            </button>
          );
        })}
      </div>
      {quota.foreignIsEstimate && (
        <p style={{ fontSize: 11.5, color: "#e0953a", marginTop: 8 }}>
          * {quota.undeclaredUnits} unit{quota.undeclaredUnits === 1 ? "": "s"} aren&apos;t assigned to a
          quota yet, so the foreign figure is an estimate. The developer can complete it.
        </p>
      )}
    </div>
  );
}

// Unit picker (A2): a visual stacking-plan grid + an "available only" dropdown. The grid shows every
// unit coloured by live status (filled progressively, with a spinner); only OPEN units are selectable.
// This replaces the old flat dropdown-of-476 where nearly everything read "not listed yet" and the few
// bookable units were impossible to find. For a quota building + a freehold buyer, units that would
// breach the cap are surfaced as non-bookable in the dropdown label (the grid still shows them).
function UnitPicker({
  building,
  statusMap,
  buyerType,
  quota,
  filling,
  busy,
  selectedId,
  snapshotAt,
  onRefresh,
  isFloorReady,
  isFloorFresh,
  onLoadFloor,
  onSelect,
  onOpenDetail,
  onProbeUnit,
}: {
  building: CatalogBuilding;
  statusMap: Record<string, number>;
  buyerType: BuyerType | null;
  quota: FreeholdQuota;
  filling: boolean;
  busy: { asOf: number | null } | null;
  selectedId: string;
  snapshotAt: number | null;
  onRefresh: () => void;
  isFloorReady: (floor: number) => boolean;
  isFloorFresh: (floor: number) => boolean;
  onLoadFloor: (floor: number) => void;
  onSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
  onProbeUnit: (id: string) => Promise<number | undefined>;
}) {
  const money = useMoney();
  // blocked unit to agencies as plain "sold" so they don't beg for it; we allow a small colour difference,
  // nothing more — and a released unit reappears the instant the developer re-opens it, VRX's live edge).
  const visibleInventory = building.inventory.filter((u) => u.offMarket?.state !== "killed");
  const openUnits = visibleInventory.filter((u) => statusMap[u.id] === 0);
  const availCount = openUnits.length;
  // Price + freehold-eligibility helpers that respect the chosen buyer type (falls back cleanly when
  // the building has no quota — priceForBuyer returns the headline price, bookable is always true).
  const priceOf = (u: CatalogUnit) => (buyerType ? priceForBuyer(u, buyerType) : u.priceUsd);
  const freeholdBlocked = (u: CatalogUnit) =>
    quota.enabled && buyerType === "freehold" && !bookableForBuyer(u, "freehold", quota);

  return (
    <div style={{ marginTop: 6 }}>
      {busy && (
        <div
          style={{
            ...banner,
            border: "1px solid #6b5426",
            background: "#241d0e",
            fontSize: 13,
            marginBottom: 10,
          }}
        >
          Network busy — showing the latest known availability, captured{" "}
          <strong>{timeAgo(busy.asOf)}</strong>
          {busy.asOf ? ` (${new Date(busy.asOf).toLocaleTimeString()})` : ""}. Live status resumes
          automatically once the network frees up.
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={{ ...lbl, marginBottom: 0 }}>
          Choose a unit{" "}
          <span style={{ opacity: 0.55 }}>
            — click an available unit
            {!filling && ` · ${availCount} available now`}
          </span>
          {filling && (
            <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className="vrx-spin" aria-hidden="true" /> checking availability…
            </span>
          )}
        </label>

        {/* Freshness — how old the served availability is, + a manual refresh. Same honesty cue as the
 building cards + the developer view (noticed the grid didn't show it). */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {!filling && snapshotAt && (
            <span style={{ fontSize: 11.5, color: CACHED_ORANGE, opacity: 0.9 }} title={new Date(snapshotAt).toLocaleString()}>
              availability from {timeAgo(snapshotAt)}
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={filling}
            title="Check the latest availability now"
            style={{
              fontSize: 12,
              padding: "3px 9px",
              borderRadius: 7,
              border: "1px solid #2a3350",
              background: "#18202f",
              color: "#c7cde0",
              cursor: filling ? "default" : "pointer",
              opacity: filling ? 0.5 : 1,
            }}
          >
            ↻ Refresh
          </button>
        </span>
      </div>

      <div style={{ marginTop: 10 }}>
        <StackingPlan
          units={visibleInventory}
          status={statusMap}
          selectedId={selectedId || null}
          formatPrice={money}
          isFloorReady={isFloorReady}
          isFloorFresh={isFloorFresh}
          onLoadFloor={onLoadFloor}
          onSelect={(u) => {
            // Probe its live status first so the detail shows real availability, then open the panel;
            // the agent reserves from INSIDE the detail. (onOpen kept as an alias for the same action.)
            void onProbeUnit(u.id);
            onOpenDetail(u.id);
          }}
          onOpen={(u) => {
            void onProbeUnit(u.id);
            onOpenDetail(u.id);
          }}
        />
      </div>

      {/* Available-unit FINDER (not a booking form): picking one opens that unit's detail, where the
 booking is made (one booking path, via the detail). A quick alternative on mobile
          to hunting the dense grid. */}
      {availCount > 0 && (
        <select
          value=""
          onChange={(e) => e.target.value && onSelect(e.target.value)}
          style={{ ...input, cursor: "pointer", marginTop: 10 }}
        >
          <option value="">Jump to an available unit — {availCount} available…</option>
          {openUnits.map((u) => (
            // and looked junky. Just number · type · size · price — full details are on the unit's screen.
            <option key={u.id} value={u.id} disabled={freeholdBlocked(u)}>
              {u.id.replace(/^unit-/, "")} · {u.type.toUpperCase()} · {unitSqm(u)}m² · {money(priceOf(u))}
              {freeholdBlocked(u) ? " · quota full" : ""}
            </option>
          ))}
        </select>
      )}
      {!filling && availCount === 0 && (
        <p style={{ opacity: 0.6, fontSize: 13, marginTop: 10 }}>
          No units are available to book in this property right now.
        </p>
      )}
    </div>
  );
}

function UnitPreview({
  unit,
  heldByOther,
  checkErr,
  verifiedAt,
  buyerType,
  quotaBlocks,
}: {
  unit: CatalogUnit;
  heldByOther: string | null;
  checkErr: string | null;
  verifiedAt: number | null;
  buyerType: BuyerType | null;
  quotaBlocks: boolean;
}) {
  const money = useMoney();
  // A check failure (e.g. insecure-context crypto over plain http) takes top priority — the agent
  // can't trust availability until it's fixed, so say plainly what to do.
  if (checkErr) {
    return (
      <p style={noteBox("#2a1616", "#7a2a2a", "#e0a0a0")}>{checkErr}</p>
    );
  }
  // Freehold quota full for this size: the unit is open, but a foreign-freehold booking would
  // breach the building's 49% cap. Offer the clear alternative (Company/Individual are never limited).
  if (quotaBlocks) {
    return (
      <p style={noteBox("#2a2412", "#7a6a2a", "#e0c67c")}>
        ⌂ The foreign-freehold allowance for a unit this size is fully taken in this building. You can
        still reserve it under a <strong>Company</strong> or <strong>Private</strong> structure.
      </p>
    );
  }
  // A live exclusive for another agency: the unit itself is "open", but this agent cannot book it
  // while the hold is live.
  if (heldByOther) {
    return (
      <p style={noteBox("#2a2412", "#7a6a2a", "#e0c67c")}>
        ◐ This unit is currently reserved exclusively for another agency. It will become available to
        you again when that hold ends.
      </p>
    );
  }
  const open = unit.status === 0;
  const label = TILE_STATUS[unit.status ?? -1] ?? "unavailable";
  // Buyer-aware price: freehold vs company differ. Show it when a buyer type is chosen.
  const buyerPrice = buyerType ? priceForBuyer(unit, buyerType) : null;
  return (
    <>
      <p style={{ fontSize: 13, marginTop: -4, marginBottom: buyerPrice != null ? 6 : 14, ...mono }}>
        {open ? (
          <>
            <span style={{ color: statusColor("open") }}>● available</span> — ready to book.
          </>
        ) : (
          <span style={{ color: "#ff8080" }}>● {label} — not available for booking right now.</span>
        )}
        {verifiedAt && (
          <span style={{ opacity: 0.6, marginLeft: 8, fontSize: 12 }} title={new Date(verifiedAt).toLocaleString()}>
            · availability verified {timeAgo(verifiedAt)}
          </span>
        )}
      </p>
      {buyerPrice != null && buyerType && (
        <p style={{ fontSize: 13, marginTop: 0, marginBottom: 14 }}>
          {BUYER_TYPE_LABEL[buyerType]} price: <strong>{money(buyerPrice)}</strong>
        </p>
      )}
    </>
  );
}

function noteBox(bg: string, border: string, color: string) {
  return {
    fontSize: 13,
    marginTop: -4,
    marginBottom: 14,
    padding: "8px 10px",
    borderRadius: 8,
    background: bg,
    border: `1px solid ${border}`,
    color,
  } as const;
}

// Shown when the agent is a valid agent but their agency has no developer access yet. Includes a
// clearly-labelled "coming soon" pointer to the future self-service apply flow (its own session —
// agency application + on-chain attestation). We deliberately offer NO manual developer entry here:
// access is gated, and the picker only ever shows developers the agency is authorized for.
function NoAccess() {
  return (
    <div style={{ ...banner, border: "1px solid #3a3f52" }}>
      <p style={{ margin: 0, fontWeight: 600 }}>No developers have granted your agency access yet.</p>
      <p style={{ margin: "8px 0 0", opacity: 0.75 }}>
        Once a developer gives your agency access, their available units will appear here to book.
      </p>
      <p style={{ margin: "10px 0 0", fontSize: 13, opacity: 0.6 }}>
        Coming soon: apply to a developer directly — submit your agency details for review and sign an
        agreement to start working together.
      </p>
    </div>
  );
}

// Shown when the developer load couldn't reach the network (RPC rate-limited / down) — NOT the same as
// "no access". Distinguishing these matters: during a busy demo an RPC 429 storm would otherwise tell a
// legitimately-gated agency it has no developers. Offer a retry; the RPC failover usually clears it.
function NetworkTrouble({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{ ...banner, border: "1px solid #6b5426", background: "#241d0e" }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Couldn&apos;t reach the network just now.</p>
      <p style={{ margin: "8px 0 0", opacity: 0.8 }}>
        We couldn&apos;t confirm your developer access — the network was busy. This is usually momentary.
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          marginTop: 12,
          padding: "7px 14px",
          borderRadius: 8,
          border: "1px solid #6b5426",
          background: "#2f2712",
          color: "#f0d9a0",
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  );
}

function RoleBanner({
  ready,
  accountId,
  isPeer,
  signIn,
}: {
  ready: boolean;
  accountId: string | null;
  isPeer: boolean | null;
  signIn: () => void;
}) {
  if (!ready) return null;
  if (!accountId) {
    return (
      <div style={{ ...banner, border: "1px solid #3a3f52" }}>
        Connect your agent wallet to open a booking request.{" "}
        <button onClick={signIn} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, marginLeft: 8 }}>
          Connect
        </button>
      </div>
    );
  }
  if (isPeer === false) {
    return (
      <div style={{ ...banner, border: "1px solid #5a3a3a", background: "#22161a" }}>
        Connected as <code>{accountId}</code>, which isn&apos;t set up as an active agent. Your agency
        needs to register you first before you can open a booking request.
      </div>
    );
  }
  // not-registered prompts show.
  return null;
}

function openErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NOT_PEER/i.test(msg)) return "This account isn't set up as an agent.";
  if (/PEER_INACTIVE/i.test(msg)) return "Your agent account has been deactivated.";
  if (/NO_GATE|GATE_INACTIVE/i.test(msg)) return "Your agency doesn't have access to this developer yet — ask the developer to grant access.";
  if (/TILE_NOT_FOUND/i.test(msg)) return "That unit isn't listed for booking yet — try another unit.";
  if (/TILE_NOT_OPEN/i.test(msg)) return "That unit is no longer available (already reserved or sold).";
  if (/REQUEST_EXISTS/i.test(msg)) return "That request already exists — please try again.";
  if (/rejected|cancell?ed|user closed|denied/i.test(msg)) return "Request cancelled.";
  if (/E57|deposit/i.test(msg)) return "Couldn't complete — please try again.";
  return "Something went wrong. Please try again.";
}

// "pick the nearest unit of the same type and offer that"). Same type + status open (0); ranked by
// closeness in floor then size, so the suggestion feels like a genuine substitute. null if none.
function nearestSameType(
  building: CatalogBuilding,
  lostUnitId: string,
  statusMap: Record<string, number>
): CatalogUnit | null {
  const lost = building.inventory.find((u) => u.id === lostUnitId);
  if (!lost) return null;
  const candidates = building.inventory
    .filter((u) => u.id !== lostUnitId && u.type === lost.type && statusMap[u.id] === 0)
    .sort((a, b) => {
      const df = Math.abs((a.floor ?? 0) - (lost.floor ?? 0)) - Math.abs((b.floor ?? 0) - (lost.floor ?? 0));
      if (df !== 0) return df;
      return Math.abs((a.sqm ?? 0) - (lost.sqm ?? 0)) - Math.abs((b.sqm ?? 0) - (lost.sqm ?? 0));
    });
  return candidates[0] ?? null;
}

// ── customer roster UI ──────────────────────────────────────────────────────────────────────────
// A buyer/customer is a reusable record the AGENT owns. These three components are the producer
// side: pick a buyer onto a booking (BuyerPicker), and manage the roster (BuyerRoster, with BuyerForm).
// The developer inbox already READS the attached snapshot (node/page.tsx BuyerBlock) — this fills it.

//  name-split — the name is now captured as structured PARTS (Title + First + (Nick) + (Middle) + Last),
// each sealing + masking independently. The composed legal `name` (Title+First+Middle+Last) is derived on
// submit via composeName, so the one required field is never free-typed when parts are used. The remaining
// (non-name) fields stay metadata-driven below.
const NAME_PART_META: { key: "firstName" | "nickName" | "middleName" | "lastName"; label: string; placeholder: string; required?: boolean }[] = [
  { key: "firstName", label: "First name", placeholder: "Given name", required: true },
  { key: "lastName", label: "Last name", placeholder: "Family name" },
  { key: "middleName", label: "Middle name", placeholder: "Optional" },
  { key: "nickName", label: "Nickname", placeholder: "Preferred name (optional)" },
];

const BUYER_FIELD_META: { key: keyof BuyerSnapshotFields; label: string; placeholder: string; required?: boolean }[] = [
  { key: "phone", label: "Phone", placeholder: "Contact number" },
  { key: "email", label: "Email", placeholder: "Contact email" },
  { key: "nationality", label: "Nationality", placeholder: "e.g. Thai, British" },
  { key: "idRef", label: "ID / passport no.", placeholder: "As the buyer provided it" },
  { key: "remarks", label: "Remarks", placeholder: "Anything the developer should know (optional)" },
  { key: "note", label: "Private note", placeholder: "Your own note — not shown to the developer (optional)" },
];

// — the anti-poaching mask preset selector. Three one-click presets govern how much of the attached
// buyer the developer sees BEFORE the deposit unlocks it. (Per-field customise is a later polish.) The
// chosen preset is sealed into the booking so "what was shown when" is tamper-evident.
const MASK_PRESETS: { key: MaskPreset; label: string; hint: string }[] = [
  { key: "default", label: "Protected", hint: "Initials + country shown, contact hidden (recommended)" },
  { key: "mask-all", label: "Fully masked", hint: "Only a proof a vetted buyer is committed" },
  { key: "show-all", label: "Open", hint: "Developer sees the full buyer now" },
];
function MaskPresetPicker({ value, onChange }: { value: MaskPreset; onChange: (p: MaskPreset) => void }) {
  return (
    <div style={{ ...lbl, marginBottom: 8 }}>
      <span>Buyer privacy before deposit <span style={{ opacity: 0.6 }}>— protects your customer from being poached</span></span>
      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        {MASK_PRESETS.map((p) => {
          const on = value === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onChange(p.key)}
              title={p.hint}
              style={{
                fontSize: 12,
                padding: "5px 10px",
                borderRadius: 7,
                cursor: "pointer",
                border: on ? "1px solid rgba(95,160,255,0.6)" : "1px solid rgba(255,255,255,0.15)",
                background: on ? "rgba(95,160,255,0.14)" : "transparent",
                color: "inherit",
                fontWeight: on ? 600 : 400,
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 11, opacity: 0.55, margin: "5px 0 0" }}>
        {MASK_PRESETS.find((p) => p.key === value)?.hint} · auto-reveals when the deposit is paid; you can reveal early anytime.
      </p>
    </div>
  );
}

// the warn-only plausibility nudge rendered under phone/email/idRef inputs. Advisory: it uses the
// local Rampart deterministic validators (sync, no model/network) to tell the agent when a value doesn't
// look like a real instance of that field ("2946524" isn't a phone). It NEVER blocks save — a legitimate
// buyer with an unusual identifier must still go through. Only the three judgeable fields warn; everything
// else renders nothing. Empty/short input is "unknown" → silent.
const PLAUSIBLE_FIELDS: ReadonlySet<string> = new Set<PlausibleField>(["phone", "email", "idRef"]);
function PlausibilityNudge({ field, value }: { field: string; value?: string }) {
  if (!PLAUSIBLE_FIELDS.has(field)) return null;
  const verdict = checkFieldPlausibility(field as PlausibleField, value ?? "");
  if (verdict.status !== "warn") return null;
  return (
    <p style={{ fontSize: 11, color: "#e0953a", margin: "4px 0 0", lineHeight: 1.35 }}>
      {plausibilityHint(field as PlausibleField)}
    </p>
  );
}

// POST a buyer to /api/buyers (create when no id, update when id). Returns the saved RosterBuyer or null.
async function saveBuyer(
  accountId: string,
  fields: BuyerSnapshotFields,
  id?: string
): Promise<RosterBuyer | null> {
  try {
    const r = await fetch("/api/buyers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: accountId, fields, id }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.buyer ?? null;
  } catch {
    return null;
  }
}

// The buyer detail form — shared by the inline add (BuyerPicker) and the roster editor (BuyerRoster). Only
// `name` is required: minimal detail is allowed; the developer can decline if it's unclear).
function BuyerForm({
  initial,
  busy,
  onSubmit,
  onCancel,
  submitLabel,
  isEdit = false,
}: {
  initial?: BuyerSnapshotFields;
  busy: boolean;
  onSubmit: (fields: BuyerSnapshotFields) => void;
  onCancel: () => void;
  submitLabel: string;
  /**  audit (c2) — true on the EDIT path, so we can warn that updates affect NEW bookings only; existing
   * reservations keep the buyer snapshot that was sealed at booking time. Without this, an agent who
   * edits a phone number expects it to flow to a held booking — it doesn't. */
  isEdit?: boolean;
}) {
  const [f, setF] = useState<BuyerSnapshotFields>(initial ?? { name: "" });
  // the composed legal name previewed live from the parts (Title+First+Middle+Last). When editing a
  // pre-split record (parts empty but `name` set), fall back to the stored `name` so nothing looks lost.
  const composed = composeName(f);
  const previewName = composed || (f.name ?? "").trim();
  // First name is now the one required part (it's what composes a non-empty name); a legacy record with only
  // a free-typed `name` and no parts can still save (previewName covers it) so editing old buyers never blocks.
  const canSave = previewName.length > 0 && !busy;
  return (
    <fieldset disabled={busy} style={{ border: "1px solid #2a3350", borderRadius: 10, padding: 14, margin: "4px 0 0" }}>
      {isEdit && (
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px", lineHeight: 1.4 }}>
          Changes apply to <strong>new bookings only</strong> — existing reservations keep the buyer details
          they were created with.
        </p>
      )}
      {/* Name parts — Title dropdown (closed set) + First/Last/Middle/Nick. Each seals + masks independently. */}
      <div style={{ marginBottom: 8 }}>
        <label style={{ ...lbl, marginBottom: 4 }}>
          Title
        </label>
        <select
          value={f.title ?? ""}
          onChange={(e) => setF((p) => ({ ...p, title: (e.target.value || undefined) as BuyerSnapshotFields["title"] }))}
          style={{ ...input, cursor: "pointer" }}
        >
          {TITLES.map((t) => (
            <option key={t || "none"} value={t}>
              {t || "— none —"}
            </option>
          ))}
        </select>
      </div>
      {NAME_PART_META.map((m) => (
        <div key={m.key} style={{ marginBottom: 8 }}>
          <label style={{ ...lbl, marginBottom: 4 }}>
            {m.label}
            {m.required && <span style={{ color: "#e0953a" }}> *</span>}
          </label>
          <input
            value={f[m.key] ?? ""}
            onChange={(e) => setF((p) => ({ ...p, [m.key]: e.target.value }))}
            placeholder={m.placeholder}
            style={input}
          />
        </div>
      ))}
      {previewName && (
        <p style={{ fontSize: 11.5, opacity: 0.6, margin: "-2px 0 10px" }}>
          Full name on record: <strong style={{ opacity: 0.85 }}>{previewName}</strong>
          {f.nickName?.trim() ? ` (“${f.nickName.trim()}”)` : ""}
        </p>
      )}
      {BUYER_FIELD_META.map((m) => (
        <div key={m.key} style={{ marginBottom: 8 }}>
          <label style={{ ...lbl, marginBottom: 4 }}>
            {m.label}
            {m.required && <span style={{ color: "#e0953a" }}> *</span>}
          </label>
          {m.key === "note" ? (
            <textarea
              value={f.note ?? ""}
              onChange={(e) => setF((p) => ({ ...p, note: e.target.value }))}
              rows={2}
              placeholder={m.placeholder}
              style={{ ...input, fontFamily: "inherit", resize: "vertical" }}
            />
          ) : (
            <input
              value={f[m.key] ?? ""}
              onChange={(e) => setF((p) => ({ ...p, [m.key]: e.target.value }))}
              placeholder={m.placeholder}
              style={input}
            />
          )}
          {/* warn-only plausibility nudge (phone/email/idRef). Local, advisory, NEVER blocks save
              (canSave above is untouched). Shows only when the value is non-trivial AND unrecognisable. */}
          <PlausibilityNudge field={m.key} value={f[m.key]} />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          type="button"
          onClick={() => canSave && onSubmit({ ...f, name: previewName })}
          disabled={!canSave}
          style={{ ...submitBtn, padding: "7px 14px", fontSize: 13 }}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{ padding: "7px 12px", fontSize: 13, background: "transparent", color: "#8a93a8", border: "1px solid #2a3350", borderRadius: 7, cursor: "pointer" }}
        >
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

// Attach a buyer to the booking in progress — a dropdown of the agent's roster + an inline "add new".
// a buyer is now REQUIRED before booking; this is the first step of the booking form. `startAdding`
// lets the parent's Reserve-with-no-buyer prompt open the inline add form directly; `requiredHint` shows,
// pre-emptively, what the selected developer needs on a buyer (so the agent prepares the right detail).
function BuyerPicker({
  roster,
  value,
  onChange,
  onAdded,
  accountId,
  requiredHint,
  startAdding,
  onStartAddingHandled,
}: {
  roster: RosterBuyer[] | null;
  value: string;
  onChange: (id: string) => void;
  onAdded: (b: RosterBuyer) => void | Promise<void>;
  accountId: string | null;
  requiredHint?: string;
  startAdding?: boolean;
  onStartAddingHandled?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // The parent's "Add new" choice (from the Reserve prompt) opens the inline form here.
  useEffect(() => {
    if (startAdding) {
      setAdding(true);
      onStartAddingHandled?.();
    }
  }, [startAdding, onStartAddingHandled]);
  return (
    <div style={{ margin: "4px 0 12px" }}>
      <label style={lbl}>
        Buyer <span style={{ opacity: 0.6 }}>— who this booking is for (required)</span>
      </label>
      {requiredHint && (
        <p style={{ fontSize: 11.5, color: "#9aa6be", margin: "0 0 6px" }}>
          This developer needs: <strong>{requiredHint}</strong> on the buyer before a booking.
        </p>
      )}
      {!adding && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...input, cursor: "pointer", flex: "1 1 200px" }}>
            <option value="">Select a buyer…</option>
            {(roster ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.fields.name}
                {b.fields.phone ? ` · ${b.fields.phone}` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setAdding(true)}
            style={{ ...submitBtn, padding: "7px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}
          >
            + Add a buyer
          </button>
        </div>
      )}
      {adding && accountId && (
        <BuyerForm
          busy={busy}
          submitLabel="Save buyer"
          onCancel={() => setAdding(false)}
          onSubmit={async (fields) => {
            setBusy(true);
            const saved = await saveBuyer(accountId, fields);
            setBusy(false);
            if (saved) {
              setAdding(false);
              await onAdded(saved);
            }
          }}
        />
      )}
    </div>
  );
}

// The "My buyers" management section — list + add + edit. The agent's reusable roster.
function BuyerRoster({
  roster,
  accountId,
  onChanged,
}: {
  roster: RosterBuyer[] | null;
  accountId: string | null;
  onChanged: () => void | Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSave(fields: BuyerSnapshotFields, id?: string) {
    if (!accountId) return;
    setBusy(true);
    const saved = await saveBuyer(accountId, fields, id);
    setBusy(false);
    if (saved) {
      setAdding(false);
      setEditingId(null);
      await onChanged();
    }
  }

  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>My buyers</div>
        {!adding && (
          <button type="button" onClick={() => { setAdding(true); setEditingId(null); }} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13 }}>
            + Add a buyer
          </button>
        )}
      </div>
      <p style={{ fontSize: 13, opacity: 0.6, margin: "0 0 14px" }}>
        Your private list of customers. Attach one to a booking so the developer knows who it&apos;s for.
        Only you can see this — it never goes on-chain.
      </p>

      {adding && (
        <div style={{ marginBottom: 14 }}>
          <BuyerForm busy={busy} submitLabel="Save buyer" onCancel={() => setAdding(false)} onSubmit={(f) => handleSave(f)} />
        </div>
      )}

      {roster === null && <p style={{ opacity: 0.6, fontSize: 14 }}>Loading your buyers…</p>}
      {roster !== null && roster.length === 0 && !adding && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>No buyers yet. Add one to reuse across your bookings.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {(roster ?? []).map((b) =>
          editingId === b.id ? (
            <BuyerForm
              key={b.id}
              initial={b.fields}
              busy={busy}
              submitLabel="Save changes"
              isEdit
              onCancel={() => setEditingId(null)}
              onSubmit={(f) => handleSave(f, b.id)}
            />
          ) : (
            <div key={b.id} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #2a3350", background: "#0e1119" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 14.5 }}>{b.fields.name}</span>
                {b.verified && (
                  <span style={{ fontSize: 11, color: "#38d39f", border: "1px solid rgba(56,211,159,0.35)", borderRadius: 999, padding: "1px 8px" }} title="Sealed & unaltered since you saved it">
                    ✓ sealed
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => { setEditingId(b.id); setAdding(false); }}
                  style={{ marginLeft: "auto", fontSize: 12, padding: "3px 10px", borderRadius: 7, border: "1px solid #2a3350", background: "#18202f", color: "#c7cde0", cursor: "pointer" }}
                >
                  Edit
                </button>
              </div>
              <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4, lineHeight: 1.6 }}>
                {b.fields.phone && <span style={{ marginRight: 12 }}>{b.fields.phone}</span>}
                {b.fields.email && <span style={{ marginRight: 12 }}>{b.fields.email}</span>}
                {b.fields.nationality && <span style={{ marginRight: 12 }}>{b.fields.nationality}</span>}
                {b.fields.idRef && <span style={{ marginRight: 12 }}>ID {b.fields.idRef}</span>}
              </div>
              {b.fields.note && <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4 }}>{b.fields.note}</div>}
            </div>
          )
        )}
      </div>
    </section>
  );
}

// ── My bookings — the AGENT's post-booking surface ────────────────────────────────────────────
// The agent app was WRITE-ONLY (book, then blind). This is the read-back: every booking this agent sent,
// its LIVE on-chain status = the developer's reply (open=awaiting · accepted=held/awaiting-deposit ·
// declined · alternative-offered), the offer recap, and the per-booking CHAT (DealChatPanel, — the
// channel API already authorizes the agent as a participant, participantRole). Mobile-first: a scrollable
// LIST of booking cards; tapping one drills into its detail (status + reply + offer + chat). No side-by-
// FastNEAR-keyed, so the phone never hits the throttled RPC).
// that will re-point this request at a NEW unit, carrying the buyer + terms over (→ developer agrees →
// booking request → booked/awaiting deposit). STUBBED here (step 2) — the button shows + explains;
// the full re-point reuses the existing booking submit path pre-filled, wired in a later step.
type AgentBookingRow = {
  requestId: string;
  claim: ClaimWire | null;
  offer: {
    requestId: string;
    requestHash: string;
    developer: string;
    seal: { terms: string; plan: AgentPlanLite | null; ownership?: string; freehold?: boolean; buyer?: unknown; by: string };
    display: { buildingId?: string; unitId?: string; buyerType?: string | null };
    at: number;
    /** the off-chain CONFIRMED-sale marker (set when the developer confirmed the sale). Its presence
     * is the terminal "sold" truth even when the on-chain claim is stubbed/null (latent-bug fix). */
    confirmed?: { at: number; by: string; tx?: string };
  } | null;
  verified: boolean;
  names: { building?: string; unit?: string } | null;
  developer: string | null;
  /** — the agency commission earned on this sale (agent-only; null when no live agreement/rate). */
  commission: { pct: number; priceUsd: number; amountUsd: number; agency: string; agent: string; agreementId: string } | null;
  /** H2 — WHY, so a blank earning is explained honestly instead of silent. */
  commissionReason?: CommissionReason;
  baselineAt?: number;
};
type AgentPlanLite = {
  priceUsd?: number;
  depositUsd?: number;
  onContractUsd?: number;
  onKeyUsd?: number;
  instalmentCount?: number;
  instalmentUsd?: number;
  frequencyDays?: number;
  taxPct?: number;
  furnitureUsd?: number;
  balanced?: boolean;
};

// The agent-facing lifecycle label for a booking, derived from the on-chain claim status (the developer's
// reply). Mirrors the developer inbox's groupOf + CLAIM_STATUS, but phrased for the SELL side.
type BookingState = "confirmed" | "awaiting" | "held" | "declined" | "alternative" | "lapsed";
// has a null on-chain claim (the claim is stubbed), yet settlement treats it CONFIRMED via the off-chain
// `offer.confirmed` marker — so reading only `claim.s` mislabelled a confirmed sale as "Awaiting the
// developer". Check `offer.confirmed` first; fall back to the claim status for everything pre-confirmation.
function bookingStateOf(row: AgentBookingRow): BookingState {
  if (row.offer?.confirmed) return "confirmed"; // off-chain terminal truth — a facilitated sale was confirmed
  const claim = row.claim;
  const s = claim?.s;
  if (s === 1) return "held"; // accepted on-chain → held, deposit awaited
  if (s === 2) return "declined";
  if (s === 3) return "alternative";
  if (s === 0) return isRequestLapsed(claim) ? "lapsed" : "awaiting";
  return "awaiting"; // no claim yet (offer recorded, chain not read) → treat as awaiting
}
const BOOKING_STATE_META: Record<BookingState, { label: string; color: string; blurb: string }> = {
  confirmed: { label: "Confirmed · sold", color: statusColor("done"), blurb: "The sale is confirmed. Commission settles on the agreed payment progress." },
  awaiting: { label: "Awaiting the developer", color: statusColor("open"), blurb: "Sent — waiting for the developer to reply." },
  held: { label: "Accepted · held", color: statusColor("accepted"), blurb: "The developer accepted. The unit is held for your buyer — deposit next." },
  declined: { label: "Declined", color: statusColor("declined"), blurb: "The developer couldn't take this one. You can book another unit for this buyer." },
  alternative: { label: "Alternative offered", color: statusColor("alternative"), blurb: "The developer suggested an alternative — see the chat, or book another unit." },
  lapsed: { label: "Lapsed", color: statusColor("default"), blurb: "This request went unanswered and lapsed. Book another unit to try again." },
};

function AgentBookings({ accountId, money }: { accountId: string | null; money: (usd: number) => string }) {
  const [rows, setRows] = useState<AgentBookingRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null); // the drilled-into booking (mobile stack nav)

  const load = useMemo(
    () => async () => {
      if (!accountId) return;
      try {
        const r = await fetch(`/api/agent-claims?agent=${encodeURIComponent(accountId)}`);
        const d = await r.json();
        setRows(Array.isArray(d.rows) ? d.rows : []);
      } catch {
        setRows([]);
      }
    },
    [accountId]
  );
  useEffect(() => { void load(); }, [load]);

  // REAL-TIME: refresh on any mirror tick — a developer accept/decline/alternative publishes to the SSE
  // bus, so the reply reaches the agent without a manual refresh (same wiring as the other inboxes).
  useEventStream((t) => {
    if (t.topic === "events") void load();
  });

  if (!accountId) {
    return <div style={card}><p style={{ opacity: 0.6, fontSize: 14, margin: 0 }}>Connect your agent wallet to see your bookings.</p></div>;
  }
  if (rows === null) {
    return <div style={card}><p style={{ opacity: 0.6, fontSize: 14, margin: 0 }}>Loading your bookings…</p></div>;
  }
  if (rows.length === 0) {
    return (
      <div style={card}>
        <p style={{ opacity: 0.75, fontSize: 14, margin: 0 }}>No bookings yet.</p>
        <p style={{ opacity: 0.55, fontSize: 13, margin: "6px 0 0" }}>Reserve a unit from “Book a unit” — it appears here with the developer’s reply and a chat.</p>
      </div>
    );
  }

  const open = openId ? rows.find((r) => r.requestId === openId) ?? null : null;

  // DETAIL (drill-down) — one booking, full width (mobile stack: list → tap → detail → back).
  if (open) {
    return (
      <AgentBookingDetail
        row={open}
        accountId={accountId}
        money={money}
        onBack={() => setOpenId(null)}
      />
    );
  }

  // LIST — compact tappable cards, newest/open first (the API already sorts).
  return (
    <div>
      {rows.map((row) => {
        const st = bookingStateOf(row);
        const meta = BOOKING_STATE_META[st];
        const title = agentRowTitle(row);
        return (
          <button
            key={row.requestId}
            type="button"
            onClick={() => setOpenId(row.requestId)}
            style={{
              ...card,
              display: "block",
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "inherit",
              color: T.text,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
              <strong style={{ fontSize: 15 }}>{title}</strong>
              <span style={{ fontSize: 12.5, color: meta.color, whiteSpace: "nowrap" }}>● {meta.label}</span>
            </div>
            <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4 }}>
              {row.developer ?? "—"}
              {row.offer?.seal.plan?.priceUsd ? ` · ${money(row.offer.seal.plan.priceUsd)}` : ""}
              {" · "}
              {timeAgo(row.offer?.at ?? (row.claim?.tc ? Math.floor(row.claim.tc / 1_000_000) : Date.now()))}
            </div>
            <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
              <BookingCode requestId={row.requestId} size={11.5} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

// here so step 3 reuses it). When we hold no offer/display data (an older booking whose offer POST didn't
// land, or one made outside this portal — the claim resolves on-chain but we have no plaintext), we DON'T
// render a bare "Unit —" that looks broken: we fall back to the booking's short opaque id so the row is
// still distinguishable + clearly reads as "a booking we don't have local details for".
function agentRowTitle(row: AgentBookingRow): string {
  const unit = row.names?.unit ? `Unit ${row.names.unit}` : "";
  const building = row.names?.building ?? row.offer?.display.buildingId ?? "";
  const buyer = buyerDisplayName(row.offer?.seal.buyer);
  const parts = [buyer, building, unit].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  // Nothing resolvable — show a stable short handle for the booking rather than an empty/"—" title.
  return `Booking ${row.requestId.slice(0, 8)}`;
}
// Best-effort buyer display from the (agent's own, unmasked) seal buyer snapshot.
function buyerDisplayName(buyer: unknown): string {
  if (!buyer || typeof buyer !== "object") return "";
  const b = buyer as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name : "";
  return name.trim();
}

// DETAIL view for one booking — status + developer reply + offer recap + chat + queue-router stub.
function AgentBookingDetail({
  row,
  accountId,
  money,
  onBack,
}: {
  row: AgentBookingRow;
  accountId: string;
  money: (usd: number) => string;
  onBack: () => void;
}) {
  const st = bookingStateOf(row);
  const meta = BOOKING_STATE_META[st];
  const clock = requestClock(row.claim);
  const chatRef = useRef<HTMLDivElement>(null); // deep-link target for the "See the chat ↓" jump
  const p = row.offer?.seal.plan ?? null;
  const terms = row.offer?.seal.terms?.trim();
  // Queue-router: declined / alternative / lapsed bookings can be re-pointed at another unit (stub).
  const canRebook = st === "declined" || st === "alternative" || st === "lapsed";

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer", fontSize: 13.5, padding: "2px 0", marginBottom: 6 }}
      >
        ← All bookings
      </button>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 16 }}>{agentRowTitle(row)}</strong>
          <span style={{ fontSize: 13, color: meta.color }}>● {meta.label}</span>
        </div>
        <p style={{ fontSize: 13, opacity: 0.75, margin: "6px 0 0" }}>{meta.blurb}</p>
        {/* Deep-link: the "alternative" blurb says "see the chat" — give it a real jump to the
            per-booking DealChat below (it's on this same screen), so the agent reaches it in one click. */}
        {st === "alternative" && (
          <button
            type="button"
            onClick={() => chatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            style={{ background: "transparent", border: "none", color: T.accent, cursor: "pointer", fontSize: 12.5, padding: "4px 0 0" }}
          >
            See the chat ↓
          </button>
        )}
        {st === "awaiting" && clock && !clock.lapsed && (
          <p style={{ fontSize: 12, color: clock.urgent ? T.hold : T.dim, margin: "4px 0 0" }}>
            Sent {humanDuration(clock.ageMs)} ago · lapses in {humanDuration(clock.leftMs)} if unanswered
          </p>
        )}
        <p style={{ fontSize: 11.5, opacity: 0.55, margin: "6px 0 0" }}>
          Developer: {row.developer ?? "—"}
          {row.verified ? " · ✓ terms sealed on-chain" : ""}
        </p>
      </div>

      {/* Offer recap — the agent's own copy of what it sent. */}
      <div style={card}>
        <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 8 }}>Your offer</div>
        {p ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 13 }}>
            {typeof p.priceUsd === "number" && <span><span style={{ opacity: 0.55 }}>Price</span> {money(p.priceUsd)}</span>}
            {typeof p.depositUsd === "number" && p.depositUsd > 0 && <span><span style={{ opacity: 0.55 }}>Deposit</span> {money(p.depositUsd)}</span>}
            {typeof p.onContractUsd === "number" && p.onContractUsd > 0 && <span><span style={{ opacity: 0.55 }}>On contract</span> {money(p.onContractUsd)}</span>}
            {typeof p.instalmentCount === "number" && p.instalmentCount > 0 && (
              <span><span style={{ opacity: 0.55 }}>Instalments</span> {p.instalmentCount}×{typeof p.instalmentUsd === "number" ? ` ${money(p.instalmentUsd)}` : ""}{p.frequencyDays ? ` / ${p.frequencyDays}d` : ""}</span>
            )}
            {typeof p.onKeyUsd === "number" && p.onKeyUsd > 0 && <span><span style={{ opacity: 0.55 }}>On transfer</span> {money(p.onKeyUsd)}</span>}
            {typeof p.furnitureUsd === "number" && p.furnitureUsd > 0 && <span><span style={{ opacity: 0.55 }}>Furniture</span> {money(p.furnitureUsd)}</span>}
            {typeof p.taxPct === "number" && p.taxPct > 0 && <span><span style={{ opacity: 0.55 }}>Tax</span> {p.taxPct}%</span>}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, opacity: 0.6 }}>No structured payment plan — see terms below.</div>
        )}
        {terms && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 2 }}>Terms</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{terms}</div>
          </div>
        )}
        {!row.offer && (
          <div style={{ fontSize: 12.5, opacity: 0.55 }}>No offer detail on file for this booking.</div>
        )}
        {row.offer && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
            <SaleContractButton requestId={row.requestId} viewer={accountId} />
            <div style={{ fontSize: 11.5, color: T.dim, marginTop: 6 }}>
              The full Sale &amp; Purchase agreement — what your buyer sees before paying the deposit.
            </div>
          </div>
        )}
        {/* the buyer's furniture-pack choice for this booking (absent-safe: nothing if none offered). */}
        {row.offer && <FurnitureSelector requestId={row.requestId} viewer={accountId} />}
        {/* your commission on this sale (from the live agreement rate × price). Agent-only; never shown
            to the buyer. Absent when there's no live agreement / rate for this building. */}
        {row.commission && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
            <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 2 }}>Your commission on this sale</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.vetted }}>
              {money(row.commission.amountUsd)}{" "}
              <span style={{ fontSize: 12.5, fontWeight: 400, opacity: 0.7 }}>
                · {row.commission.pct}% of {money(row.commission.priceUsd)}
              </span>
            </div>
            <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>Per your agency&apos;s agreement with the developer.</div>
          </div>
        )}
        {/* H2 (scope widened) — when a booking carries NO commission, explain WHY in plain words
            instead of a silent blank, for ANY booking (not just accepted/held): an UNCONFIRMED booking that
 resolves to nothing was showing a blank too (the VRX-6S0XP case caught). The copy fn returns
            null for the positive reasons (earned/prospective → a figure shows), so dropping the st-guard can't
            double-render — it only fills the previously-silent no-commission cases. */}
        {!row.commission && row.commissionReason && commissionReasonCopy(row.commissionReason, row.baselineAt) && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
            <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 2 }}>Your commission on this sale</div>
            <div style={{ fontSize: 12.5, color: T.dim }}>{commissionReasonCopy(row.commissionReason, row.baselineAt)}</div>
          </div>
        )}
      </div>

      {/* Per-booking CHAT — self-contained transport (useDealChat); the agent posts on the sell side. */}
      <div ref={chatRef} style={card}>
        <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 8 }}>Chat with the developer</div>
        <DealChatPanel requestId={row.requestId} viewerRole="agent" me={accountId} />
      </div>

      {/*  step 6 — the agent acting as the BUYER's PROXY on payments ("the agent must do all things
          for a customer they handle"). Confirm/dispute each offline payment the developer recorded for this
          buyer on this deal. Same BuyerPaymentPanel the buyer uses in person; the route authorises the agent
          via lib/participant off the offer. Only meaningful once an offer exists on the booking. */}
      {row.offer && accountId && (
        <div style={card}>
          <BuyerPaymentPanel mode="agent" account={accountId} requestId={row.requestId} heading="Your buyer's payments" />
          {/* §5b — reconcile the developer's "received" records against the buyer side's independent "sent"
              records. The agent acts as the buyer's proxy (canLog): records what their client sent + sees the
              two-ledger comparison. The buyer ACCOUNT is NOT exposed to the agent surface (the offer's buyer
              snapshot is masked — the privacy moat), so the server attributes a proxy-logged sent record to the
              buyer already on the deal's developer records; `buyerAccount` is omitted here deliberately. */}
          <ReconciliationPanel
            requestId={row.requestId}
            viewer={accountId}
            canLog
            heading="Reconcile payments"
          />
        </div>
      )}

      {/* Queue-router stub — re-point a declined/alternative/lapsed booking at another unit. */}
      {canRebook && (
        <div style={card}>
          <button
            type="button"
            onClick={() => alert("Coming soon: this will open a new booking for this buyer on another unit, carrying the terms over.")}
            style={{ ...submitBtn, padding: "8px 16px", fontSize: 14 }}
          >
            Book another unit for this buyer
          </button>
          <p style={{ fontSize: 11.5, opacity: 0.55, margin: "6px 0 0" }}>
            Re-points this request to a new available unit, carrying the buyer and terms over — no need to start from scratch.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Conversations (step 3) — every booking chat as an openable thread ───────────────────────────────
// A surface listing EVERY thread the viewer is a participant in, titled buyer · building · unit# ·
// developer. Reuses the roll-up read (api/conversations, scoped by participantRole) + the DealChatPanel
// transport (so SSE/near.email swaps don't touch this). Mobile-first, same list→tap→thread drill-down as
// My bookings: no side pane — the agent is on a phone. Built role-parameterized so the developer + agency
// mount the SAME component later ( — one seam, three role views); the agent is its first consumer.
// UNREAD is a SERVER read-marker now (lib/read-markers + /api/conversations/seen) — it survives across
// devices and logins (the "log on anywhere → see the notification" behaviour), so the row's `unread`
// comes straight from the server (msgCount > this viewer's last-seen count AND newest msg from counterpart).
// We no longer keep a per-browser localStorage seen-map. Opening a thread POSTs a mark-seen, then reloads.
type ConversationRow = {
  requestId: string;
  title: string;
  lastMsg: { from: "developer" | "agent"; by: string; text: string; at: number } | null;
  counterpart: string | null;
  msgCount: number;
  unread: boolean;
  developer: string | null;
  agent: string | null;
};

function Conversations({ accountId, viewerRole }: { accountId: string | null; viewerRole: ViewerRole }) {
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useMemo(
    () => async () => {
      if (!accountId) return;
      try {
        const r = await fetch(`/api/conversations?viewer=${encodeURIComponent(accountId)}`);
        const d = await r.json();
        setRows(Array.isArray(d.rows) ? d.rows : []);
      } catch {
        setRows([]);
      }
    },
    [accountId]
  );
  useEffect(() => {
    void load();
  }, [load]);

  // REAL-TIME: any message landing in ANY thread publishes an opaque "channel:<token>" topic (F2); a developer
  // reply also ticks "events". This roll-up can't cheaply tell WHICH of the viewer's threads moved from the
  // opaque token, so it reloads on ANY channel tick (prefix match) — then the gated re-read scopes the result.
  useEventStream((t) => {
    if (t.topic === "events" || t.topic.startsWith("channel:")) void load();
  });

  // Mark a thread seen on the SERVER (survives device/login), then reload so the unread dot clears from
  // server truth. Best-effort: if the POST fails the dot just stays until the next successful mark.
  async function markSeen(requestId: string, count: number) {
    if (!accountId) return;
    try {
      await fetch("/api/conversations/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewer: accountId, requestId, count }),
      });
      await load();
    } catch {
      /* best-effort — a failed mark leaves the row unread, no crash */
    }
  }

  // Unread is server truth now (row.unread already folds "newest from counterpart" + the read-marker).
  const isUnread = (row: ConversationRow): boolean => row.unread;

  if (!accountId) {
    return (
      <div style={card}>
        <p style={{ opacity: 0.6, fontSize: 14, margin: 0 }}>Connect your wallet to see your conversations.</p>
      </div>
    );
  }
  if (rows === null) {
    return (
      <div style={card}>
        <p style={{ opacity: 0.6, fontSize: 14, margin: 0 }}>Loading your conversations…</p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={card}>
        <p style={{ opacity: 0.75, fontSize: 14, margin: 0 }}>No conversations yet.</p>
        <p style={{ opacity: 0.55, fontSize: 13, margin: "6px 0 0" }}>
          Each booking opens a private thread with the developer — they appear here once there&apos;s a message.
        </p>
      </div>
    );
  }

  const open = openId ? rows.find((r) => r.requestId === openId) ?? null : null;

  // DETAIL (drill-down) — one thread, full width (mobile stack: list → tap → thread → back).
  if (open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpenId(null)}
          style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer", fontSize: 13.5, padding: "2px 0", marginBottom: 6 }}
        >
          ← All conversations
        </button>
        <div style={card}>
          <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 2 }}>{open.title}</div>
          <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 12 }}>
            {viewerRole === "agent" ? "Developer" : "Agent"}: {open.counterpart ?? "—"}
          </div>
          <DealChatPanel requestId={open.requestId} viewerRole={viewerRole} me={accountId} />
        </div>
      </div>
    );
  }

  // LIST — compact tappable thread cards, most-recent activity first (the API sorts).
  return (
    <div>
      {rows.map((row) => {
        const unread = isUnread(row);
        const preview = row.lastMsg
          ? `${row.lastMsg.from === viewerRole ? "You: " : ""}${row.lastMsg.text}`
          : "No messages yet";
        return (
          <button
            key={row.requestId}
            type="button"
            onClick={() => {
              void markSeen(row.requestId, row.msgCount);
              setOpenId(row.requestId);
            }}
            style={{
              ...card,
              display: "block",
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "inherit",
              color: T.text,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
              <strong style={{ fontSize: 14.5 }}>{row.title}</strong>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                {unread && (
                  <span
                    aria-label="unread"
                    style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor("open"), display: "inline-block" }}
                  />
                )}
                {row.lastMsg && (
                  <span style={{ fontSize: 11.5, opacity: 0.6 }}>{timeAgo(row.lastMsg.at)}</span>
                )}
              </span>
            </div>
            <div
              style={{
                fontSize: 12.5,
                opacity: unread ? 0.9 : 0.55,
                fontWeight: unread ? 600 : 400,
                marginTop: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {preview}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Buyer protection — the AGENT's control over masked bookings ───────────────────────────────
// For each booking the agent made with a buyer attached: the reveal/mask state, any PENDING developer
// decides), a reveal-early (T2) button, and the sealed EVIDENCE BUNDLE (proof-of-introduction + the
// developer's accepted non-circumvention declaration + reveals) that protects the agent against an end-run.
type ProtectionRow = {
  requestId: string;
  developer: string;
  names: { building?: string; unit?: string };
  buyer: Record<string, string> | null;
  unlock: { revealed: boolean; at?: number; trigger?: string; by?: string; revealRequest?: { by: string; at: number; declarationSeal: string } };
  at: number;
  evidence: { id: string; kind: string; by: string; detail: string; at: number; verified: boolean }[];
};
const EVIDENCE_LABEL: Record<string, string> = {
  introduction: "Introduction registered",
  declaration: "Developer accepted non-circumvention terms",
  reveal: "Identity revealed",
  revision: "Buyer detail amended",
  "buyer-ack": "Buyer acknowledged",
};
function BuyerProtection({ accountId }: { accountId: string | null }) {
  const [rows, setRows] = useState<ProtectionRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  // their booked buyers — a pending REVEAL REQUEST awaiting approval, or a reveal that just fired. Same
  // three cues the developer inbox uses: a soft chime + a browser Notification + a document-title badge.
  const notify = useNotifier();
  const everLoaded = useRef(false);
  const pendingSeen = useRef<Set<string>>(new Set()); // requestIds we've already alerted a pending request for
  const [pendingCount, setPendingCount] = useState(0);

  const load = useMemo(
    () => async () => {
      if (!accountId) return;
      try {
        const r = await fetch(`/api/buyers/protection?agent=${encodeURIComponent(accountId)}`);
        const d = await r.json();
        const list: ProtectionRow[] = Array.isArray(d.rows) ? d.rows : [];
        // Which bookings currently have a dev reveal request awaiting THIS agent's approval?
        const pending = list.filter((x) => x.unlock?.revealRequest && !x.unlock?.revealed);
        setPendingCount(pending.length);
        // Alert only on requests we haven't alerted before, and only after the first load (so the initial
        // set isn't announced as "new"). Clear the seen-flag once a request is resolved so a later one re-alerts.
        if (everLoaded.current) {
          const fresh = pending.filter((x) => !pendingSeen.current.has(x.requestId));
          if (fresh.length > 0) {
            const first = fresh[0];
            const who = first.names.unit ? `Unit ${first.names.unit}` : (first.buyer?.name ?? "a buyer");
            notify(
              fresh.length === 1 ? "A developer wants to reveal your buyer" : `${fresh.length} buyer reveal requests`,
              fresh.length === 1 ? `${first.developer} requested to see the buyer on ${who}. Approve or decline.` : `Including ${who}.`,
              { tag: "vrx-agent-reveal", repeat: 3 }
            );
          }
        }
        pendingSeen.current = new Set(pending.map((x) => x.requestId));
        everLoaded.current = true;
        setRows(list);
      } catch {
        setRows([]);
      }
    },
    [accountId, notify]
  );
  useEffect(() => { void load(); }, [load]);

  // REAL-TIME: refresh on any mirror tick (the reveal/approve writes publish to the same SSE bus), so a
  // developer's request reaches the agent without a manual refresh. Mirrors the developer-inbox wiring.
  useEventStream((t) => {
    if (t.topic === "events") void load();
  });

  // Document-title badge mirrors the count of reveal requests awaiting the agent.
  useEffect(() => {
    const base = "Agent — VRX";
    document.title = pendingCount > 0 ? `(${pendingCount}) ${base}` : base;
    return () => { document.title = base; };
  }, [pendingCount]);

  async function act(requestId: string, action: "approve" | "decline" | "reveal") {
    if (!accountId) return;
    setBusyId(requestId);
    try {
      const trigger = action === "reveal" ? "T2-agent" : undefined;
      await fetch("/api/offers/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, action, trigger, by: accountId }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section style={card}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Buyer protection</div>
      <p style={{ fontSize: 13, opacity: 0.6, margin: "0 0 14px" }}>
        Your booked buyers are kept private from the developer until the deposit is paid — so your customer
        can&apos;t be poached. A developer can request an early reveal, but only you can approve it. Every
        step is sealed as proof that protects your commission.
      </p>

      {rows === null && <p style={{ opacity: 0.6, fontSize: 14 }}>Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>No booked buyers yet. Attach a buyer to a booking to protect them here.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {(rows ?? []).map((row) => {
          const pending = !!row.unlock.revealRequest && !row.unlock.revealed;
          const revealed = row.unlock.revealed;
          const name = row.buyer?.name ?? "Buyer";
          const unit = row.names.unit ? `Unit ${row.names.unit}` : row.requestId.slice(0, 8);
          const where = [row.names.building, unit].filter(Boolean).join(" · ");
          return (
            <div key={row.requestId} style={{ padding: "11px 13px", borderRadius: 10, border: "1px solid #2a3350", background: "#0e1119" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 14.5 }}>{name}</span>
                <span style={{ fontSize: 12, opacity: 0.6 }}>{where} · {row.developer}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, borderRadius: 999, padding: "1px 9px", ...(revealed
                  ? { color: "#38d39f", border: "1px solid rgba(56,211,159,0.35)" }
                  : pending
                  ? { color: "#e8b84b", border: "1px solid rgba(232,184,75,0.4)" }
                  : { color: "#3d7dff", border: "1px solid rgba(61,125,255,0.4)" }) }}>
                  {revealed ? "✓ revealed" : pending ? "⏳ reveal requested" : "🔒 protected"}
                </span>
              </div>

              {pending && (
                <div style={{ marginTop: 8, padding: 9, borderRadius: 8, background: "rgba(232,184,75,0.07)", border: "1px solid rgba(232,184,75,0.25)" }}>
                  <p style={{ fontSize: 12.5, margin: "0 0 8px" }}>
                    <strong>{row.unlock.revealRequest!.by}</strong> accepted the non-circumvention terms and asks to see this buyer now.
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" disabled={busyId === row.requestId} onClick={() => act(row.requestId, "approve")} style={{ ...submitBtn, padding: "5px 12px", fontSize: 12.5 }}>
                      Approve reveal
                    </button>
                    <button type="button" disabled={busyId === row.requestId} onClick={() => act(row.requestId, "decline")} style={{ fontSize: 12.5, padding: "5px 12px", borderRadius: 7, border: "1px solid #2a3350", background: "#18202f", color: "#c7cde0", cursor: "pointer" }}>
                      Decline
                    </button>
                  </div>
                </div>
              )}

              {!revealed && !pending && (
                <button type="button" disabled={busyId === row.requestId} onClick={() => act(row.requestId, "reveal")}
                  style={{ marginTop: 8, fontSize: 12.5, padding: "5px 12px", borderRadius: 7, border: "1px solid #2a3350", background: "#18202f", color: "#c7cde0", cursor: "pointer" }}>
                  Reveal to developer now
                </button>
              )}

              {/* The sealed evidence bundle — the agent's proof against an end-run (dispute path #1). */}
              <button type="button" onClick={() => setOpenEvidence(openEvidence === row.requestId ? null : row.requestId)}
                style={{ marginTop: 8, marginLeft: !revealed && !pending ? 8 : 0, fontSize: 12, padding: "4px 10px", borderRadius: 7, border: "1px solid #2a3350", background: "transparent", color: "#8b93a7", cursor: "pointer" }}>
                {openEvidence === row.requestId ? "Hide" : "View"} protection evidence ({row.evidence.length})
              </button>
              {openEvidence === row.requestId && (
                <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
                  {row.evidence.length === 0 && <p style={{ opacity: 0.6 }}>No sealed events yet.</p>}
                  {row.evidence.map((e) => (
                    <div key={e.id} style={{ padding: "6px 0", borderTop: "1px solid #1c2434" }}>
                      <span style={{ color: e.verified ? "#38d39f" : "#e8b84b" }}>{e.verified ? "✓" : "⚠"}</span>{" "}
                      <strong>{EVIDENCE_LABEL[e.kind] ?? e.kind}</strong>
                      <span style={{ opacity: 0.6 }}> · {new Date(e.at).toLocaleString()}</span>
                      <div style={{ opacity: 0.7, marginTop: 2 }}>{e.detail}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
