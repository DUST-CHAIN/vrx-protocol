"use client";

// Developer dashboard — the SELLER's home, now catalog-driven.
//
// A Developer (contract: Node; provisioned owner-gated) manages their buildings and units
// here. This screen is built on the off-chain demo catalog (lib/catalog-client — buildings→units with
// price/size/images from the the operator catalog "MM" archive, renamed to the demo names) laid over the on-chain
// primitive:
//  • pick a building → see its hero image, specs, and a dense STACKING PLAN (the Binance-style
//     color+number grid) of its units with LIVE on-chain status;
//   • click a unit → mark it available on-chain (stamp_tile) with one click — the catalog ref
//  `<building>/<unit>` is hashed to the opaque unit_key, so no plaintext unit reaches the chain;
//   • grant an agency access (gate); reply to / confirm incoming booking requests (the queue).
//
// PRIVACY: only opaque keys/hashes ever go on-chain. Price, size, images = off-chain catalog.
// VOCAB (vrx-vocab-translation): Developer/Agency/Agent/unit/access — contract keeps Node/Org/Peer/
// tile/gate under the hood. Non-owner writes are #[payable] + tolled (V5/) → depositFor(me).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/lib/wallet";
import { useRole } from "@/lib/role";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";
import {
  hashRef,
  getNode,
  getOrg,
  getGate,
  stampTileArgs,
  stampTilesArgs,
  STAMP_BATCH_MAX,
  grantGateArgs,
  replyClaimArgs,
  confirmClaimArgs,
  grantExclusiveArgs,
  releaseExclusiveArgs,
  getExclusive,
  liveHolder,
  daysToWindowNs,
  windowEndDate,
  fmtUntil,
  depositFor,
  isRequestLapsed,
  requestClock,
  humanDuration,
  TILE_STATUS,
  CLAIM_STATUS,
  type ClaimWire,
  type ExclusiveWire,
  type StampTuple,
} from "@/lib/vrx";
import {
  fetchCatalog,
  timeAgo,
  CACHED_ORANGE,
  unitRef,
  BLOCK_CATEGORY_LABEL,
  checkEnvelope,
  envelopeLabel,
  type Building,
  type Unit,
  type BlockCategory,
} from "@/lib/catalog-client";
import { useMoney } from "@/lib/currency";
import { EXPLORER_URL } from "@/lib/config";
import { freeholdQuota } from "@/lib/freehold";
import { packForeignQuota } from "@/lib/packing";
import { card, lbl, input, submitBtn, banner, mono, statusColor } from "@/lib/ui";
import { StackingPlan, type UnitStatus } from "@/components/StackingPlan";
import { useBuildingStatus } from "@/lib/useBuildingStatus";
import BuildingCards from "@/components/BuildingCards";
import { BuildingSummaryBlock, FloorAvailabilityList } from "@/components/BuildingSummary";
import { useTxRun, TxProgress } from "@/components/TxAction";
import { seal, chip, T } from "@/lib/theme";
import { commissionReasonCopy, type CommissionReason } from "@/lib/commission-reason";
import { PrivateMark, SealedMark } from "@/lib/marks";
import { ContractModal } from "@/components/ContractModal";
import { prettyTerms } from "@/lib/contract";
import { useEventStream } from "@/lib/useEventStream";
import { channelTopic } from "@/lib/channel-topic";
import { DealChat, type Msg as DealChatMsg } from "@/components/DealChat";
import BookingCode from "@/components/BookingCode";
import SaleContractButton from "@/components/SaleContractButton";
//  slice 4 — the per-deal tailoring editors + their offer shape now live in a SHARED component so the
// direct desk reuses them verbatim (one source of truth). The node page keeps its own JSX order below.
import {
  ConcessionsEditor,
  TimedTermsEditor,
  InstalmentMilestoneEditor,
  DiscountEditor,
  TaxEditor,
  ContractStageControls,
  type OfferRecord,
  type AssembledPlanLite,
} from "@/components/OfferTailoring";
import { KycDocsReview } from "@/components/KycVault";
import SitePlanMap, { type SitePlanTheme } from "@/components/SitePlanMap";
import Carousel from "@/components/Carousel";
import DocumentsPanel from "@/components/DocumentsPanel";
import { StampJobPanel } from "@/components/StampJobPanel";
import type { BuildingGeo } from "@/lib/catalog-client";
import { ConstructionTimelineEditor, BuildingSetupEditor, FurniturePacksManager, BuildingFurniturePreview } from "@/components/BuildingAuthoring";
import DashboardShell, { useShellFocus, type ShellSection } from "@/components/DashboardShell";
import Link from "next/link";
import EventLog from "@/components/EventLog";
import WarroomOverview from "@/components/WarroomOverview";
import DirectEnquiries from "@/components/DirectEnquiries";
import { useDirectUnread } from "@/lib/useDirectUnread";
import { useNotifier } from "@/lib/useNotifier";
import BuyerRequirements from "@/components/BuyerRequirements";
import SettlementView from "@/components/SettlementView";
import IncomeProjection from "@/components/IncomeProjection";
import PaymentLedgerPanel from "@/components/PaymentLedgerPanel";
import ReconciliationPanel from "@/components/ReconciliationPanel";
import VrxAgreementPanel from "@/components/VrxAgreementPanel";
import SaleTermsDefaultsPanel from "@/components/SaleTermsDefaultsPanel";
import DeveloperTokensPanel from "@/components/DeveloperTokensPanel";
import DeveloperDemoHoldsPanel from "@/components/DeveloperDemoHoldsPanel";
import { DEMO_MODE_FLAG } from "@/lib/dev-signer-fence";

// Pill button style for the building-plan controls (rounded, compact, three visual states).
function pill(variant: "idle" | "active-blue" | "active-green"): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "2px 11px",
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
    minHeight: 24,
    height: 24,
    lineHeight: 1,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#2a3350",
    background: "#18202f",
    color: "#c7cde0",
    transition: "background 0.12s ease, border-color 0.12s ease",
  };
  if (variant === "active-blue") return { ...base, background: "#2b62ff", borderColor: "#2b62ff", color: "#fff" };
  if (variant === "active-green") return { ...base, background: "#123a2a", borderColor: "#1f6b4c", color: "#5fe0a8" };
  return base;
}

// ──: the pending-approval HOLD, developer view ─────────────────────────────────────────────────────
// One open inventory-version awaiting approval (the subset of fields the dev UI needs — never the changeset's
// from/to prices, which /api/catalog/held deliberately omits). `units` = the held unit ids it covers.
type HeldVersion = {
  version: number;
  at: number;
  by: string;
  approver: string;
  changeClass: string;
  status: "open";
  units: string[];
  count: number;
};
type HeldInfo = { held: Set<string>; versions: HeldVersion[] };

// Read the developer's own held-units + open versions for a building. Absent/failed → empty (never throws;
// the hold is a derived convenience, not a gate — the gate is server-side in lib/bookable).
async function fetchHeld(building: string, account?: string | null): Promise<HeldInfo> {
  try {
    const q = account ? `&account=${encodeURIComponent(account)}` : "";
    const res = await fetch(`/api/catalog/held?building=${encodeURIComponent(building)}${q}`);
    if (!res.ok) return { held: new Set(), versions: [] };
    const j = (await res.json()) as { held?: string[]; versions?: HeldVersion[] };
    return { held: new Set(j.held ?? []), versions: j.versions ?? [] };
  } catch {
    return { held: new Set(), versions: [] };
  }
}

// Dark toolbar theme for the shared SitePlanMap, derived from the console pill styles so the map's draw
// controls match the rest of /node (the component ships light defaults for read-only/other callers).
const MAP_DARK_THEME: SitePlanTheme = {
  tabIdle: { ...pill("idle"), fontSize: 12 },
  tabActive: { ...pill("active-blue"), fontSize: 12 },
  editBtn: { ...pill("idle"), fontSize: 12, height: "auto", minHeight: 0, padding: "4px 11px" },
  mutedText: "#8a93ab",
  labelText: "#c7cde0",
};

// ── Building location authoring ────────────────────────────────────────────────────────────────
// The developer places the building on the map + traces the main access road(s). "Approach matters as much
// as the pin." OFF-CHAIN, public context. Seeds a sensible default center (Pattaya, the the operator catalog beachhead) when
// a building has no geo yet so there's a pin to drag; saves via /api/catalog/geo. Collapsed by default so it
// doesn't crowd the console — the developer opens it to edit.
const DEFAULT_CENTER: BuildingGeo = { lat: 12.9236, lng: 100.8825 }; // Pattaya (demo beachhead)

// ── Map authoring field — small thumbnail + lightbox ─────────────────────────────────────────────
// The map used to render as a large inline block that crowded the console. Instead: a COMPACT read-only
// thumbnail (sits beside the feature image) that opens a full-screen LIGHTBOX for the real authoring work —
// pin / roads / land & footprint polygons / orientation, with room for the layer-2 image overlay next.
// Caller owns persistence (onSave); this owns the draft + the open/close + the dark-themed editable map.
function MapAuthoringField({
  geo,
  seed,
  canClear,
  onSave,
  thumbHeight = 150,
}: {
  geo: BuildingGeo | undefined; // the currently-saved geo (drives the thumbnail + "has pin" state)
  seed: BuildingGeo; // where the editor starts when nothing is saved yet
  canClear: boolean; // whether to offer a Clear action
  onSave: (next: BuildingGeo | null) => Promise<void>;
  thumbHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BuildingGeo>(geo ?? seed);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const has = !!geo;

  function openEditor() {
    setDraft(geo ?? seed); // always start from the latest saved state
    setMsg(null);
    setOpen(true);
  }

  async function save(next: BuildingGeo | null) {
    setBusy(true);
    setMsg(null);
    try {
      await onSave(next);
      setOpen(false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Compact thumbnail (or a "set it" placeholder) — click to open the lightbox. */}
      {has ? (
        <button
          type="button"
          onClick={openEditor}
          title="Open the site-plan map"
          style={{ display: "block", width: "100%", padding: 0, border: "none", background: "none", cursor: "pointer", position: "relative" }}
        >
          <SitePlanMap geo={geo} height={thumbHeight} thumbnail />
          <span
            style={{
              position: "absolute", bottom: 8, right: 8, zIndex: 600,
              background: "rgba(16,20,30,0.85)", color: "#dfe5f5", fontSize: 11.5,
              padding: "3px 9px", borderRadius: 999, border: "1px solid #2a3350",
            }}
          >
            ⤢ Edit on map
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={openEditor}
          style={{ ...pill("idle"), height: "auto", padding: "8px 14px", fontSize: 13 }}
        >
          🗺 Place on the map
        </button>
      )}
      {msg && <div style={{ marginTop: 6, fontSize: 12.5, opacity: 0.8 }}>{msg}</div>}

      {/* Lightbox — full-screen scrim + a centered panel holding the editable map and save controls. */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => !busy && setOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000, background: "rgba(4,6,12,0.78)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              ...card, background: "#0e1119", width: "min(1000px, 96vw)",
              maxHeight: "92vh", overflow: "auto", padding: 18,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>🗺 Site plan</h3>
              <span style={{ fontSize: 12.5, opacity: 0.6 }}>
                Place the pin, trace roads, draw the land parcel + building footprint, set orientation.
              </span>
              <button
                type="button"
                onClick={() => !busy && setOpen(false)}
                style={{ marginLeft: "auto", background: "none", border: "none", color: "#9aa4bf", cursor: "pointer", fontSize: 20 }}
              >
                ×
              </button>
            </div>

            <SitePlanMap geo={draft} editable onChange={setDraft} height={460} theme={MAP_DARK_THEME} />

            <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void save(draft)}
                disabled={busy}
                style={{ ...submitBtn, padding: "8px 18px", opacity: busy ? 0.6 : 1 }}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => !busy && setOpen(false)}
                style={{ ...pill("idle"), height: "auto", padding: "8px 14px", fontSize: 13 }}
              >
                Cancel
              </button>
              {canClear && has && (
                <button
                  type="button"
                  onClick={() => void save(null)}
                  disabled={busy}
                  style={{ ...submitBtn, padding: "8px 14px", background: "#3a1414", color: "#e0a0a0", marginLeft: "auto" }}
                >
                  Clear
                </button>
              )}
              {msg && <span style={{ fontSize: 13, opacity: 0.8 }}>{msg}</span>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function BuildingLocationEditor({ building, onSaved }: { building: Building; onSaved: () => void }) {
  async function save(next: BuildingGeo | null) {
    const res = await fetch("/api/catalog/geo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ building: building.id, geo: next }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "save failed");
    }
    onSaved();
  }

  // Compact — sits flush beside the text, no label (the "⤢ Edit on map" chip carries the affordance).
  // Thumbnail height matches the image (450).
  return (
    <MapAuthoringField geo={building.geo} seed={DEFAULT_CENTER} canClear onSave={save} thumbHeight={450} />
  );
}

export default function NodePage() {
  const { accountId, ready, signIn, callFunction } = useWallet();
  const { role } = useRole();
  const [isNode, setIsNode] = useState<boolean | null>(null);
  // direct-enquiry unread badge on the "Direct enquiries" nav item — so a desk reply/new enquiry is
  // visible even when the developer is on another section (the gap hit). Mirrors the booking badge.
  const directUnread = useDirectUnread(accountId);

  useEffect(() => {
    if (!accountId) {
      setIsNode(null);
      return;
    }
    // If the (possibly demo-override) role already says developer, trust it immediately — same pattern the
    // /agent page uses for the agent role. This is what makes the DEMO work: in the snapshot sandbox there's
    // no chain to register node.test.near on, so the on-chain getNode below returns null; the demo-role
    // override (lib/role) resolves "developer", so we paint the dashboard without blocking on the chain read.
    if (role === "developer") setIsNode(true);
    getNode(accountId)
      .then((n) => {
        const ok = !!n && (n as { a?: boolean }).a !== false;
        // Don't demote a role-confirmed developer on an empty/failed read (demo has no chain record).
        if (n === null && role === "developer") return;
        // c (the "isn't set up as a developer" FLASH): in DEMO mode the on-chain read is ALWAYS
        // empty (vvv-dev-01 is off-chain-only), and `role` resolves a beat AFTER accountId — so an early
        // null read would set isNode=false and flash the not-a-developer banner before the demo role lands.
        // While demo is armed and the role is STILL RESOLVING (null), hold — never demote on the empty read;
        // the role effect re-runs and confirms "developer". A real unregistered wallet (demo off) still gets
        // the honest banner.
        if (n === null && role === null && demoRoleUxArmed()) return;
        setIsNode(ok);
      })
      .catch(() => { if (role !== "developer") setIsNode(false); });
  }, [accountId, role]);

  // Dashboard-shell sections — the developer page was already a thin assembler stacking five
  // self-contained section components; the shell turns that stack into a sidebar VIEW-SWITCHER with the
  // internals untouched. Queue (the booking-request inbox) is keepAlive so a half-typed reply / loaded
  // thread isn't torn down when switching away. Only built when signed in as a developer; otherwise the
  // shell shows just the RoleBanner (sign-in / not-onboarded prompt).
  const sections: ShellSection[] =
    accountId && isNode
      ? [
          { id: "portfolio", label: "My buildings", icon: "🏢", element: <Portfolio me={accountId} callFunction={callFunction} /> },
          { id: "access", label: "Agency access", icon: "🔑", element: <GrantAccess me={accountId} callFunction={callFunction} /> },
          { id: "furniture", label: "Furniture packs", icon: "🛋️", element: <FurniturePacksManager developer={accountId} /> },
          { id: "exclusives", label: "Exclusive holds", icon: "⭐", element: <Exclusives me={accountId} callFunction={callFunction} /> },
          { id: "tokens", label: "Booking tokens", icon: "🎟", element: <DeveloperTokensPanel me={accountId} /> },
          // Practice holds (the $VRX demo upgrade handoff) only exist under the demo flag — omit the nav entry
          // entirely in a real deploy rather than show an empty section.
          ...(DEMO_MODE_FLAG ? [{ id: "practice-holds", label: "Practice holds", icon: "🎓", element: <DeveloperDemoHoldsPanel me={accountId} /> }] : []),
          { id: "queue", label: "Booking requests", icon: "📥", keepAlive: true, element: <Queue me={accountId} callFunction={callFunction} /> },
          { id: "enquiries", label: "Direct enquiries", icon: "💬", keepAlive: true, badge: directUnread, element: <DirectEnquiries me={accountId} /> },
          { id: "buyer-reqs", label: "Buyer requirements", icon: "✅", element: <BuyerRequirements me={accountId} /> },
          { id: "agreements", label: "Agreements", icon: "📄", element: <DeveloperAgreements me={accountId} /> },
          { id: "settlement", label: "Settlement", icon: "💰", element: <SettlementView me={accountId} role="developer" /> },
          { id: "income", label: "Projected income", icon: "📈", element: <IncomeProjection developer={accountId} /> },
          { id: "activity", label: "Event log", icon: "🕑", element: <EventLog me={accountId} role="developer" /> },
          // Warroom = a developer menu item FOR NOW. It's a factored, standalone surface
          // (WarroomOverview + /api/warroom + the per-developer snapshot store) so it can graduate to its
          // own app later — a CEO onboarded per-developer from VRX root, with their own wallet, lands on
          // the warroom scoped to that developer. Build nothing for that yet; the data is already per-dev.
          { id: "warroom", label: "Warroom", icon: "📊", element: <WarroomOverview me={accountId} /> },
        ]
      : [];

  return (
    <DashboardShell
      title="Units & bookings"
      persistKey="node"
      intro="Mark units available, grant agency access, confirm booking requests"
      banner={<RoleBanner ready={ready} accountId={accountId} isNode={isNode} signIn={signIn} />}
      sections={sections}
    />
  );
}

// ── Portfolio: buildings → stacking plan → click-to-stamp ─────────────────────────────────
function Portfolio({
  me,
  callFunction,
}: {
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
}) {
  // Card grid → open one building's console. Back returns to the cards.
  const [activeId, setActiveId] = useState<string | null>(null);

  // Scope "My buildings" to THIS developer's own buildings (the off-chain info gate — vrx-read-privacy-model:
  // the chain holds only opaque hashes and has no building concept, so building↔developer ownership is an
  // off-chain registry fact; the developer registry's `buildingIds` is the scope). Without this the view showed
  // the ENTIRE catalog regardless of who's signed in (live-walk finding #1) — the agent view already
  // scopes this way. `null` while loading = BuildingCards shows nothing yet (no "all buildings" flash); an
  // empty array = a developer who lists nothing. (Demo note: god-mode still becomes any developer; it just sees
  // that developer's own buildings, which is the honest multi-owner behaviour.)
  const [ownIds, setOwnIds] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/developers?account=${encodeURIComponent(me)}`)
      .then((r) => (r.ok ? r.json() : { developer: null }))
      .then((d: { developer?: { buildingIds?: string[] } | null }) => {
        if (!cancelled) setOwnIds(d.developer?.buildingIds ?? []);
      })
      .catch(() => {
        if (!cancelled) setOwnIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  if (activeId) {
    return (
      <section style={card}>
        <button
          type="button"
          onClick={() => setActiveId(null)}
          style={{ ...submitBtn, padding: "5px 11px", fontSize: 13, background: "#18202f", color: "#c7cde0", marginBottom: 14 }}
        >
          ← All buildings
        </button>
        <BuildingConsole key={activeId} buildingId={activeId} me={me} callFunction={callFunction} />
      </section>
    );
  }

  return (
    <section style={card}>
      <BuildingCards heading="My buildings" filterIds={ownIds} account={me} onOpen={(id) => setActiveId(id)} />
    </section>
  );
}

function BuildingConsole({
  buildingId,
  me,
  callFunction,
}: {
  buildingId: string;
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
}) {
  const money = useMoney();
  // Building load + status via the SHARED hook — the ONE snapshot-first, per-floor-tap-to-load
  // implementation, now also used by /agent + /agency so they can't drift. This app layers its own
  // selection + batch-stamp state on top.
  const bs = useBuildingStatus(buildingId, me);
  const data = bs.data;
  const status = bs.status;
  const { live, setLive, filling, busy: statusBusy, isFloorReady, isFloorFresh, loadFloor, ensureUnitStatus, refreshStatus, reloadBuilding } = bs;

  const [selected, setSelected] = useState<Unit | null>(null);
  // Batch mode: select many units then stamp them in one (or a few) transactions.
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // the pending-approval HOLD, developer view. Which units are held + the open versions driving them
  // (for the Approve/Reject + revert/resubmit surface). Fetched from /api/catalog/held; refreshed whenever an
  // edit/request/decision happens (bumpHeld). Derived server-side from open versions — no local state machine.
  const [heldData, setHeldData] = useState<HeldInfo>({ held: new Set(), versions: [] });
  const [heldTick, setHeldTick] = useState(0);
  const bumpHeld = useCallback(() => setHeldTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    void (async () => {
      const info = await fetchHeld(buildingId, me);
      if (live) setHeldData(info);
    })();
    return () => { live = false; };
  }, [buildingId, heldTick, me]);
  // Hero gallery (reuses the server-served building images, same source the agents get) — carousel + lightbox.
  const [heroIdx, setHeroIdx] = useState(0);
  const [heroLightbox, setHeroLightbox] = useState<number | null>(null);

  // Reset this app's selection state whenever the building or Live toggle changes (the hook resets its
  // own data/status). Keeps batch-pick from leaking across buildings.
  useEffect(() => {
    setSelected(null);
    setSelectMode(false);
    setPicked(new Set());
    setHeroIdx(0);
    setHeroLightbox(null);
  }, [buildingId, live]);

  const togglePick = useCallback((u: Unit) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(u.id)) next.delete(u.id);
      else next.add(u.id);
      return next;
    });
  }, []);

  if (!data) return <BuildingSkeleton />;
  const { building, images } = data;
  // Full building gallery (same server-served set the agents get): exterior → facilities → interior, deduped.
  const gallery = Array.from(
    new Set([...(images?.exterior ?? []), ...(images?.facilities ?? []), ...(images?.interior ?? [])])
  );

  return (
    <div>
      {/* Hero + specs + the site-plan map (ORDER: image → text → map). */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 16 }}>
        {/* 1. Feature gallery — the FULL building gallery (same server-served images the agents), as a
 carousel with click-to-lightbox. RESPONSIVE 3:2 frame + fit=cover (B5/): the old fixed
              450px-tall contain frame letterboxed the ~landscape renders into a huge black band on a
 stacked phone column (the "so much vertical space wasted"). cover fills the frame at any
              width — the lightbox still uses contain to show the whole image. */}
        {gallery.length > 0 && (
          <div style={{ flex: "1 1 600px", minWidth: 360, maxWidth: 720, alignSelf: "flex-start" }}>
            <Carousel
              images={gallery}
              alt={building.name}
              aspectRatio="3 / 2"
              fit="cover"
              index={heroIdx}
              onIndexChange={setHeroIdx}
              onImageClick={(k) => setHeroLightbox(k)}
            />
          </div>
        )}
        {/* 2. Text + documents — slim framed column; the specs sit on top, the reusable building-documents
              panel fills the space below (replaces the old empty box). Column so the docs panel stretches. */}
        <div
          style={{
            flex: "0 1 280px",
            minWidth: 220,
            maxWidth: 320,
            alignSelf: "stretch",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            background: "#0e1119",
            border: "1px solid #232838",
            borderRadius: 10,
            padding: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{building.name}</div>
            <div style={{ opacity: 0.7, fontSize: 14 }}>{building.tagline}</div>
            <div style={{ opacity: 0.6, fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>
              {building.type} · {building.stories} floors · {building.units} units · {building.area}
              <br />
              {building.address} · {building.completion}
              <br />
              Reservation fee {money(building.reservationFeeUsd)} · maintenance {money(building.maintenancePerSqmUsd)}/m²
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {building.unitTypes.map((t) => (
                <span
                  key={t.key}
                  style={{ fontSize: 12, padding: "3px 9px", borderRadius: 6, background: "#0b0e16", border: "1px solid #2a2f40", opacity: 0.85 }}
                >
                  {t.label} · {t.sqmMin === t.sqmMax ? `${t.sqmMin}` : `${t.sqmMin}–${t.sqmMax}`}m²
                </span>
              ))}
            </div>
          </div>
          {/* Reusable documents panel (developer view). Replicates to agency/agent/buyer with role+stage. */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <DocumentsPanel building={building.id} buildingName={building.name} role="developer" />
          </div>
        </div>
        {/* 3. Site-plan map — grows to absorb the slack so it sits FLUSH against the slim text column (no
              black gap), but capped so it never gets huge. Click the thumbnail = lightbox. 450 tall. */}
        <div style={{ flex: "1 1 420px", minWidth: 320, maxWidth: 560 }}>
          <BuildingLocationEditor building={building} onSaved={() => void reloadBuilding()} />
        </div>
      </div>

      {/* Hero gallery lightbox — full-screen view of the clicked image, prev/next via the same carousel. */}
      {heroLightbox != null && gallery.length > 0 && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setHeroLightbox(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000, background: "rgba(4,6,12,0.88)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(1100px, 94vw)" }}>
            <Carousel
              images={gallery}
              alt={building.name}
              aspectRatio="3 / 2"
              fit="contain"
              index={heroLightbox}
              onIndexChange={setHeroLightbox}
            />
            <div style={{ textAlign: "center", marginTop: 10 }}>
              <button
                type="button"
                onClick={() => setHeroLightbox(null)}
                style={{ ...pill("idle"), height: "auto", padding: "6px 16px", fontSize: 13 }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Building setup — the the operator catalog-style rich per-building record: project / physical / fees & terms /
          land & legal / seller entity. Tabbed, section-scoped saves, absent-safe. */}
      <BuildingSetupEditor developer={me} building={building} onSaved={() => void reloadBuilding()} />

      {/* Clean-slate onboarding (§6c) — assemble each unit's real state → a durable BACKGROUND stamp
          job (server drips ≤50 chunks over time, resumable) → "Go on contract" fixes the commission zero-time.
          The sign step is STUBBED this session (no live txs); the live FC-key signer lands later. */}
      <StampJobPanel developer={me} building={building.id} units={building.inventory} />

      {/* Construction timeline — building-specific; feeds the S&P "Construction and Handover". */}
      <ConstructionTimelineEditor building={building} onSaved={() => void reloadBuilding()} />

      {/* Furniture offered here — read-only; packs are authored + attached in the Furniture packs menu. */}
      <BuildingFurniturePreview developer={me} building={building} />

      {/* Summary: totals + per-type size table (echoes the the operator catalog reference; per-floor list is below the grid) */}
      <BuildingSummaryBlock building={building} status={status} money={money} />

      {/* Freehold-quota packing advisor: only for a building the developer configured with a quota. */}
      <PackingAdvisor building={building} status={status} />

      {/* Building plan header: title + pill controls + "last cached" all on one row. */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 16, margin: 0, marginRight: 2 }}>Building Plan</h3>
          <button
            type="button"
            onClick={() => {
              setSelectMode((v) => !v);
              setPicked(new Set());
              setSelected(null);
            }}
            style={pill(selectMode ? "active-blue" : "idle")}
          >
            {selectMode ? "Done" : "Select"}
          </button>
          <button
            type="button"
            onClick={() => setLive(!live)}
            title={
              live
                ? "Live: full on-chain availability, complete snapshot"
                : "Fast: availability from the cache; tap a floor for the latest. Switch to Live for a complete snapshot."
            }
            style={pill(live ? "active-green" : "idle")}
          >
            {live ? "● Live" : "○ Live"}
          </button>
          <button
            type="button"
            onClick={() => void refreshStatus()}
            disabled={bs.loading}
            style={pill("idle")}
          >
            {bs.loading ? "…" : "↻ Refresh"}
          </button>
          {(bs.loading || filling) && (
            <span style={{ fontSize: 12, opacity: 0.7, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Spinner /> loading…
            </span>
          )}
          {!bs.loading && !filling && data?.snapshot?.filledAt && (
            <span style={{ fontSize: 11.5, color: CACHED_ORANGE, opacity: 0.9 }}>
              last cached {timeAgo(data.snapshot.filledAt)}
            </span>
          )}
        </div>
      </div>
      {statusBusy && (
        <div style={{ ...banner, border: "1px solid #6b5426", background: "#241d0e", fontSize: 13, marginBottom: 8 }}>
          Network busy — showing the latest known availability, cached{" "}
          <strong style={{ color: CACHED_ORANGE }}>{timeAgo(statusBusy.asOf)}</strong>. Live status
          resumes automatically once the network frees up; use Refresh to retry.
        </div>
      )}
      {/* Price & structure tools — building-wide reprice + add/remove/edit, with the 409
          needs_version → request-approval flow. Collapsed by default so it doesn't crowd the plan. */}
      <PriceStructureTools building={building} me={me} heldVersions={heldData.versions} onChanged={async () => { await reloadBuilding(); bumpHeld(); }} />

      <StackingPlan
        units={building.inventory}
        status={status}
        selectedId={selected?.id ?? null}
        formatPrice={money}
        isFloorReady={isFloorReady}
        isFloorFresh={isFloorFresh}
        onLoadFloor={(f) => void loadFloor(f)}
        onSelect={(u) => {
          setSelected(u);
          // the "status loads when you click a unit": make sure the selected unit's status is
          // current right now (cheap single read), even if the snapshot hasn't reached it.
          void ensureUnitStatus(u.id);
        }}
        selectMode={selectMode}
        selectedIds={picked}
        onToggle={togglePick}
        held={heldData.held}
      />

      {selectMode && (
        <BatchBar
          building={building}
          picked={picked}
          status={status}
          me={me}
          callFunction={callFunction}
          onClearAll={() => setPicked(new Set())}
          onSelectAllOpen={() => {
            // "select all not-yet-listed" — the common case (list a whole building at once).
            const ids = building.inventory.filter((u) => (status[u.id] ?? -1) !== 0).map((u) => u.id);
            setPicked(new Set(ids));
          }}
          onOffMarketChanged={reloadBuilding}
          onDone={async () => {
            setPicked(new Set());
            await refreshStatus();
          }}
        />
      )}

      {!selectMode && selected && (
        <UnitPanel
          building={building}
          unit={selected}
          onChain={status[selected.id] ?? -1}
          me={me}
          callFunction={callFunction}
          onStamped={refreshStatus}
          onOffMarketChanged={reloadBuilding}
          onClose={() => setSelected(null)}
          heldVersion={heldData.versions.find((v) => v.units.includes(selected.id)) ?? null}
          onHeldChanged={async () => { await reloadBuilding(); bumpHeld(); }}
        />
      )}

      <FloorAvailabilityList building={building} status={status} />
    </div>
  );
}

// ── Freehold-quota packing advisor ────────────────────────────────────────────────────────
// The foreign-freehold quota (49% of sellable m²) gets STRANDED when the units left are all larger than
// the remaining quota m² (: "120 m² left but the smallest unit is 44 m² → 32 m² wasted"). This
// advisor runs a knapsack over the AVAILABLE units vs the remaining foreign m² and reports the best
// set that packs the most quota + the irreducible stranded m². Advisory only — the developer acts on it
// via the block controls (reserve the suggested set for foreign buyers). Shown only for quota buildings.
function PackingAdvisor({ building, status }: { building: Building; status: Record<string, number> }) {
  const q = freeholdQuota(building);
  const [show, setShow] = useState(false);
  if (!q.enabled) return null;

  const remaining = q.foreign.availableSqm;
  const plan = packForeignQuota(building.inventory, remaining, status);
  const packablePct = remaining > 0 ? Math.round((plan.usedSqm / remaining) * 100) : 0;
  const strandedBad = plan.strandedSqm > 0 && plan.candidateCount > 0;

  return (
    <div style={{ ...card, marginTop: 12, background: "#0e1119", borderColor: "#3a2f5a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Freehold quota planner</span>
        <span style={{ fontSize: 12.5, opacity: 0.7 }}>
          {remaining.toLocaleString()} m² of foreign quota left ({q.foreign.soldPct}% sold)
        </span>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          style={{ ...submitBtn, marginLeft: "auto", padding: "5px 12px", fontSize: 12.5, background: "#18202f", color: "#c7cde0" }}
        >
          {show ? "Hide" : "Plan"}
        </button>
      </div>
      {show && (
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
          {plan.candidateCount === 0 ? (
            <p style={{ opacity: 0.7, margin: 0 }}>No available units to pack right now.</p>
          ) : (
            <>
              <p style={{ margin: "0 0 8px" }}>
                Best packing uses <strong>{plan.usedSqm.toLocaleString()} m²</strong> of your{" "}
                {remaining.toLocaleString()} m² ({packablePct}%) across{" "}
                <strong>{plan.unitIds.length}</strong> unit{plan.unitIds.length === 1 ? "" : "s"}.
                {strandedBad ? (
                  <>
                    {" "}
                    <span style={{ color: CACHED_ORANGE }}>
                      {plan.strandedSqm.toLocaleString()} m² would be stranded
                    </span>{" "}
                    — no available unit fits the remainder.
                  </>
                ) : (
                  <> No quota is stranded — the available units pack cleanly.</>
                )}
              </p>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {plan.unitIds.map((id) => (
                  <span
                    key={id}
                    style={{ fontSize: 11.5, padding: "2px 8px", borderRadius: 999, background: "#1a1430", border: "1px solid #4a3a6a", color: "#c8b8e8", fontFamily: "ui-monospace, monospace" }}
                  >
                    {id.replace(/^unit-/, "")}
                  </span>
                ))}
              </div>
              <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 8, marginBottom: 0 }}>
                Reserve this set for freehold buyers to use the most quota. Take other units off-market
                (a company/shop or phase-2 hold) to steer the mix — re-plan after each change.
                {plan.approximate && " (Large building — near-optimal estimate.)"}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Batch action bar: stamp many selected units in one go ──────────────────────────────────
// Uses the contract's stamp_tiles(Vec<(key,status,hash)>) — ONE wallet approval + ONE toll per
// batch instead of per unit. The contract caps a batch at 50 (E12), so a big selection is chunked
// into ≤50-unit calls; 500 units = 10 approvals instead of 500. Deposit is sized for the batch.
function BatchBar({
  building,
  picked,
  status,
  me,
  callFunction,
  onClearAll,
  onSelectAllOpen,
  onOffMarketChanged,
  onDone,
}: {
  building: Building;
  picked: Set<string>;
  status: Record<string, number>;
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
  onClearAll: () => void;
  onSelectAllOpen: () => void;
  onOffMarketChanged: () => void | Promise<void>;
  onDone: () => void | Promise<void>;
}) {
  const { state, run, busy } = useTxRun();
  const [progress, setProgress] = useState<string | null>(null);
  const n = picked.size;
  const batches = Math.ceil(n / STAMP_BATCH_MAX);

  async function stampAll(status: number) {
    const ids = [...picked];
    if (ids.length === 0) return;
    // Build the (key, status, hash) tuples for every picked unit (hashing off-chain).
    const tuples: StampTuple[] = await Promise.all(
      ids.map(async (id): Promise<StampTuple> => {
        const u = building.inventory.find((x) => x.id === id)!;
        const ref = unitRef(building.id, id);
        const key = await hashRef(ref, "vrx-unit");
        const integrity = await hashRef(
          { ref, type: u.type, sqm: u.sqm, floor: u.floor, priceUsd: u.priceUsd },
          "vrx-tile"
        );
        return [key, status, integrity];
      })
    );
    // Chunk into ≤50 and send each as its own tx (one approval each). We report progress across them.
    const chunks: StampTuple[][] = [];
    for (let i = 0; i < tuples.length; i += STAMP_BATCH_MAX) chunks.push(tuples.slice(i, i + STAMP_BATCH_MAX));

    let lastTx = "";
    const ok = await run(
      async () => {
        for (let i = 0; i < chunks.length; i++) {
          setProgress(`Batch ${i + 1} of ${chunks.length} (${chunks[i].length} units)…`);
          const built = stampTilesArgs(chunks[i]);
          // One deposit covers the whole batch: size for N units of storage + one toll.
          const deposit = await depositFor(me, 2048 * chunks[i].length);
          lastTx = await callFunction({ method: built.method, args: built.args, deposit });
        }
        setProgress(null);
        return lastTx;
      },
      {
        successNote: `${ids.length} unit${ids.length > 1 ? "s" : ""} marked ${TILE_STATUS[status]} on-chain${
          chunks.length > 1 ? ` (in ${chunks.length} batches)` : ""
        }.`,
        mapError: (e) => {
          setProgress(null);
          return writeErr(e);
        },
        ensureGasFor: me,
      }
    );
    if (ok) await onDone();
  }

  return (
    <div style={{ ...card, marginTop: 14, background: "#0e1119", borderColor: "#2b62ff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>
          {n} unit{n === 1 ? "" : "s"} selected
        </b>
        {n > STAMP_BATCH_MAX && (
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            → {batches} approvals (max {STAMP_BATCH_MAX}/tx)
          </span>
        )}
        <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
          <button type="button" onClick={onSelectAllOpen} disabled={busy} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}>
            Select all unlisted
          </button>
          <button type="button" onClick={onClearAll} disabled={busy || n === 0} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}>
            Clear
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={() => stampAll(0)} disabled={busy || n === 0} style={btnOf("open")}>
          Mark {n || ""} available
        </button>
        <button type="button" onClick={() => stampAll(2)} disabled={busy || n === 0} style={btnOf("closed")}>
          Mark {n || ""} sold
        </button>
      </div>
      {progress && (
        <p className="vrx-working" style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 13, opacity: 0.9 }}>
          {progress}
        </p>
      )}
      <TxProgress state={state} />

      <BulkOffMarket
        building={building}
        picked={picked}
        status={status}
        disabled={busy}
        onChanged={onOffMarketChanged}
      />

      <ExclusiveGrant building={building} picked={picked} me={me} callFunction={callFunction} onDone={onDone} />
    </div>
  );
}

// ── Take MANY units off-market at once (off-chain) ────────────────────────────
// One shared reason + category for the whole selection. Each unit is POSTed to /api/offmarket
// individually so the server runs the anti-fraud guard per unit: any unit with a live
// on-chain reservation is REFUSED there (409) and reported back here as skipped — the batch
// hides the safe ones and never quietly hides a live sale. Off-chain only; the chain is untouched.
function BulkOffMarket({
  building,
  picked,
  status,
  disabled,
  onChanged,
}: {
  building: Building;
  picked: Set<string>;
  status: Record<string, number>;
  disabled: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<BlockCategory>("phase-pricing");
  const [confirmedBy, setConfirmedBy] = useState("");
  const [kill, setKill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ done: number; skipped: string[]; failed: string[] } | null>(null);

  const ids = [...picked];
  // Units the developer already knows are live on-chain (held/booked/sold) — the server will
  // refuse these anyway; we surface the count up-front so the action isn't a surprise.
  const liveCount = ids.filter((id) => {
    const s = status[id];
    return s === 1 || s === 2 || s === 3;
  }).length;

  async function submit() {
    if (ids.length === 0 || !reason.trim()) return;
    setBusy(true);
    setResult(null);
    const skipped: string[] = [];
    const failed: string[] = [];
    let done = 0;
    for (const id of ids) {
      try {
        const res = await fetch("/api/offmarket", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: kill ? "kill" : "block",
            building: building.id,
            unit: id,
            reason: reason.trim(),
            category: kill ? "regulatory" : category,
            confirmedBy: confirmedBy.trim() || undefined,
            by: "developer",
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok) done++;
        else if (json?.code === "live_reservation") skipped.push(id);
        else failed.push(id);
      } catch {
        failed.push(id);
      }
    }
    setResult({ done, skipped, failed });
    setBusy(false);
    if (done > 0) await onChanged();
  }

  const n = ids.length;

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #232a3d" }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled || n === 0}
          style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: "#3a2416", border: "1px solid #5a3a1e", color: "#e0b88a" }}
        >
          Take {n || ""} off-market…
        </button>
      ) : (
        <div style={{ padding: "12px 14px", borderRadius: 8, background: "#151922", border: "1px solid #2b3350" }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Take {n} unit{n === 1 ? "" : "s"} off the market</div>
          <p style={{ fontSize: 12.5, opacity: 0.7, margin: "4px 0 10px" }}>
            One reason applies to all selected units. They stop showing to agents and buyers; you can
            release them any time. Units with a live reservation on-chain are skipped and left as-is.
          </p>
          {liveCount > 0 && (
            <div style={{ ...banner, fontSize: 12.5, borderColor: "#6b5426", background: "#241d0e", marginBottom: 10 }}>
              {liveCount} of these {liveCount === 1 ? "has" : "have"} a live reservation on-chain and will be
              skipped — those must go through a recorded cancellation first.
            </div>
          )}
          <label style={lbl}>Reason</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as BlockCategory)}
            style={{ ...input, padding: "7px 8px" }}
          >
            {(Object.keys(BLOCK_CATEGORY_LABEL) as BlockCategory[]).map((k) => (
              <option key={k} value={k}>
                {BLOCK_CATEGORY_LABEL[k]}
              </option>
            ))}
          </select>
          <label style={lbl}>Note</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Hold this line for phase-2 pricing"
            style={input}
          />
          <label style={lbl}>Confirmed by (optional)</label>
          <input
            value={confirmedBy}
            onChange={(e) => setConfirmedBy(e.target.value)}
            placeholder="e.g. K. Wee, 18/07"
            style={input}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={kill} onChange={(e) => setKill(e.target.checked)} />
            Regulatory removal (excluded from all figures)
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || !reason.trim() || n === 0}
              onClick={() => void submit()}
              style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: kill ? "#5e1c1c" : "#3a2416" }}
            >
              {busy ? "Working…" : kill ? `Remove ${n} unit${n === 1 ? "" : "s"}` : `Take ${n} off-market`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setResult(null);
              }}
              style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}
            >
              Cancel
            </button>
          </div>
          {result && (
            <div style={{ ...banner, marginTop: 10, fontSize: 12.5, borderColor: "#2b5e3a", background: "#0f1c14" }}>
              {result.done} taken off-market
              {result.skipped.length > 0 && ` · ${result.skipped.length} skipped (live reservation)`}
              {result.failed.length > 0 && ` · ${result.failed.length} failed`}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Grant an exclusive hold over the selected units ──────────────────────────────────
// The developer gives ONE agency the SOLE right to book the selected units for a bounded window
// ("solo / exhibition mode"): all other agencies are blocked + see them as held, and they auto-revert
// to the shared pool at expiry. One grant_exclusive call per unit (the contract has no batch form),
// each requiring the unit be OPEN and the agency to already have access here. Duration is chosen in
// whole days (default 3, ± stepper) and we show the end date it computes to.
function ExclusiveGrant({
  building,
  picked,
  me,
  callFunction,
  onDone,
}: {
  building: Building;
  picked: Set<string>;
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
  onDone: () => void | Promise<void>;
}) {
  const { state, run, busy } = useTxRun();
  const [agencyId, setAgencyId] = useState("");
  const [days, setDays] = useState(3);
  const [progress, setProgress] = useState<string | null>(null);
  const n = picked.size;
  const endDate = windowEndDate(days).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  async function grant() {
    const id = agencyId.trim();
    const ids = [...picked];
    if (!id || ids.length === 0) return;
    const windowNs = daysToWindowNs(days);
    let lastTx = "";
    let done = 0;
    const ok = await run(
      async () => {
        for (const uid of ids) {
          done += 1;
          setProgress(`Reserving unit ${done} of ${ids.length} for ${id}…`);
          const key = await hashRef(unitRef(building.id, uid), "vrx-unit");
          const built = grantExclusiveArgs(key, id, windowNs);
          const deposit = await depositFor(me);
          lastTx = await callFunction({ method: built.method, args: built.args, deposit });
          // Write-through mirror: record the hold WE just authored so the Exclusive-holds panel reads
          // it without scanning get_exclusive over the whole catalog. `until` ns = now(ms→ns) + window.
          const until = Date.now() * 1e6 + windowNs;
          void fetch("/api/exclusives", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "grant", unitKey: key, buildingId: building.id, unitId: uid, orgId: id, developer: me, until }),
          }).catch(() => {});
        }
        setProgress(null);
        return lastTx;
      },
      {
        successNote: `${ids.length} unit${ids.length > 1 ? "s" : ""} reserved exclusively for ${id} until ${endDate}.`,
        mapError: (e) => {
          setProgress(null);
          return exclusiveErr(e);
        },
        ensureGasFor: me,
      }
    );
    if (ok) await onDone();
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #232838" }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Reserve exclusively for one agency</div>
      <p style={{ opacity: 0.6, fontSize: 12, margin: "0 0 10px" }}>
        Give one agency the sole right to book the selected units for a set number of days (for a
        launch or exhibition). Every other agency is blocked and sees them as held; the units return to
        the shared pool automatically when the time is up. The agency must already have access to you.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label style={lbl}>Agency account</label>
          <input
            value={agencyId}
            onChange={(e) => setAgencyId(e.target.value)}
            placeholder="e.g. dysfunctional-smoke.testnet"
            style={input}
            disabled={busy}
          />
        </div>
        <div>
          <label style={lbl}>Days</label>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button type="button" onClick={() => setDays((d) => Math.max(1, d - 1))} disabled={busy || days <= 1} style={stepBtn}>−</button>
            <span style={{ minWidth: 28, textAlign: "center", fontSize: 16, fontWeight: 600, ...mono }}>{days}</span>
            <button type="button" onClick={() => setDays((d) => d + 1)} disabled={busy} style={stepBtn}>+</button>
          </div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.65, paddingBottom: 8 }}>
          until <b>{endDate}</b>
        </div>
      </div>
      <button
        type="button"
        onClick={grant}
        disabled={busy || n === 0 || !agencyId.trim()}
        style={{ ...btnOf("hold"), marginTop: 12 }}
      >
        {busy ? "Signing…" : `Reserve ${n || ""} unit${n === 1 ? "" : "s"} for this agency`}
      </button>
      {progress && (
        <p className="vrx-working" style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 13, opacity: 0.9 }}>
          {progress}
        </p>
      )}
      <TxProgress state={state} />
    </div>
  );
}

function exclusiveErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NOT_NODE/i.test(msg)) return "This account isn't set up as a developer.";
  if (/ORG_NOT_FOUND/i.test(msg)) return "No such agency — it must be onboarded by us (VRX) first.";
  if (/NO_GATE|GATE_INACTIVE/i.test(msg)) return "That agency doesn't have access to you yet — grant access first.";
  if (/E59|TILE_NODE_MISMATCH|TILE_BUSY/i.test(msg)) return "One of the units isn't available to reserve (already reserved, sold, or held). Only available units can be set aside.";
  if (/TILE_NOT_FOUND/i.test(msg)) return "One of the units isn't listed yet — mark it available first.";
  if (/rejected|cancell?ed|user closed|denied/i.test(msg)) return "Cancelled.";
  if (/E57|deposit/i.test(msg)) return "Couldn't complete — please try again.";
  return "Something went wrong. Please try again.";
}

// ── Unit detail panel: shows catalog detail + one-click stamp to available ────────────────
// ── — the HELD-pending-approval banner (developer unit panel) ──────────────────────────────────────
// Shown on a unit that's in an open version-gated change. States the hold plainly + the revert/resubmit path,
// and — only to the version's APPROVER (the developer themselves by default, or the VRX/CEO wallet VRX-root
// pointed it at) — the Approve / Reject buttons. Approve auto-applies the attested changeset (no re-type);
// reject lifts the hold with nothing to roll back (the write never happened). A non-approver sees
// "awaiting approval from <approver>" and no buttons.
function HeldBanner({
  building,
  unit,
  me,
  version,
  onDecided,
}: {
  building: Building;
  unit: Unit;
  me: string;
  version: HeldVersion;
  onDecided?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const iAmApprover = me.trim().toLowerCase() === version.approver.trim().toLowerCase();

  async function decide(decision: "approved" | "rejected") {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/catalog/version/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ building: building.id, version: version.version, decision, by: me }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(typeof j.error === "string" ? j.error : "Could not record the decision."); return; }
      await onDecided?.();
    } catch {
      setErr("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, padding: "11px 13px", borderRadius: 8, background: "#2e2110", border: "1px solid #9a6a1e" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: "#f0b25a" }}>⏳ Held — pending approval</span>
        <span style={{ fontSize: 12.5, opacity: 0.75 }}>· change #{version.version} · {version.count} unit{version.count === 1 ? "" : "s"}</span>
      </div>
      <p style={{ fontSize: 13, margin: "7px 0 0", lineHeight: 1.5, opacity: 0.9 }}>
        A change to this unit is awaiting sign-off, so it&apos;s frozen from booking until it&apos;s decided.
        {iAmApprover
          ? " Approve to apply the change, or reject to leave the current terms in place (nothing to undo — the change hasn't been written)."
          : ` Awaiting approval from ${version.approver}.`}
      </p>
      {iAmApprover && (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => void decide("approved")} style={btnOf("open")}>
            {busy ? "…" : "Approve & apply"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("rejected")}
            style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: "#3a1414", color: "#e0a0a0" }}
          >
            Reject
          </button>
        </div>
      )}
      <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 8, marginBottom: 0 }}>
        Rejected a change you still want? Re-request it from Price &amp; structure tools — it opens a fresh
        change and holds the units again until approved.
      </p>
      {err && <p style={{ color: "#ff8080", fontSize: 12.5, marginTop: 6, marginBottom: 0 }}>{err}</p>}
    </div>
  );
}

// ── — developer PRICE & STRUCTURE tools (building-wide) ────────────────────────────────────────
// The visible half of item 2: reprice (units/floor/all × set/pct/delta) and add/remove/edit a unit. A change
// that is version-gated for this developer (post-sign-off) 409s with `needs_version`; we catch that and offer
// a "Request VRX approval" action that opens a version (POST /api/catalog/request-approval) → the units go
// held. A self-serve change applies immediately. Collapsed by default. The approver is set by VRX-root;
// this surface doesn't set it, it just routes a gated change into the request-approval flow.
function PriceStructureTools({
  building,
  me,
  heldVersions,
  onChanged,
}: {
  building: Building;
  me: string;
  heldVersions: HeldVersion[];
  onChanged: () => void | Promise<void>;
}) {
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"price" | "structure">("price");

  return (
    <div style={{ ...card, marginTop: 12, background: "#0e1119", borderColor: "#2b3350" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Price &amp; structure</span>
        <span style={{ fontSize: 12.5, opacity: 0.65 }}>reprice or change units — some changes need VRX approval</span>
        {heldVersions.length > 0 && (
          <span style={{ fontSize: 12, color: "#f0b25a" }}>
            · {heldVersions.length} change{heldVersions.length === 1 ? "" : "s"} awaiting approval
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{ ...submitBtn, marginLeft: "auto", padding: "5px 12px", fontSize: 12.5, background: "#18202f", color: "#c7cde0" }}
        >
          {open ? "Hide" : "Open"}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button type="button" onClick={() => setTab("price")} style={pill(tab === "price" ? "active-blue" : "idle")}>Reprice</button>
            <button type="button" onClick={() => setTab("structure")} style={pill(tab === "structure" ? "active-blue" : "idle")}>Add / remove / edit</button>
          </div>
          {tab === "price"
            ? <RepriceTool building={building} me={me} money={money} onChanged={onChanged} />
            : <StructureTool building={building} me={me} onChanged={onChanged} />}
        </div>
      )}
    </div>
  );
}

// Reprice a scope (whole building / one floor / picked units) by set|pct|delta. On a 409 needs_version, shows
// "Request VRX approval" which re-sends the SAME scope/op to /api/catalog/request-approval (→ held). Self-serve
// (e.g. a price drop for a trusted developer) applies straight away.
function RepriceTool({
  building,
  me,
  money,
  onChanged,
}: {
  building: Building;
  me: string;
  money: (usd: number) => string;
  onChanged: () => void | Promise<void>;
}) {
  const floors = useMemo(() => Array.from(new Set(building.inventory.map((u) => u.floor))).sort((a, b) => b - a), [building]);
  const [scopeKind, setScopeKind] = useState<"all" | "floor" | "units">("all");
  const [floor, setFloor] = useState<number>(floors[0] ?? 1);
  const [unitsCsv, setUnitsCsv] = useState("");
  const [opKind, setOpKind] = useState<"pct" | "delta" | "set">("pct");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [needsVersion, setNeedsVersion] = useState(false);

  function buildScope() {
    if (scopeKind === "all") return { all: true as const };
    if (scopeKind === "floor") return { floor };
    const units = unitsCsv.split(",").map((s) => s.trim()).filter(Boolean);
    return { units };
  }
  function buildOp(): Record<string, number> | null {
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    if (opKind === "set") return n > 0 ? { set: n } : null;
    if (opKind === "pct") return { pct: n };
    return { delta: n };
  }

  async function apply(viaApproval: boolean) {
    const op = buildOp();
    if (!op) { setMsg("Enter a valid amount."); return; }
    setBusy(true); setMsg(null);
    try {
      const url = viaApproval ? "/api/catalog/request-approval" : "/api/catalog/price";
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ building: building.id, by: me, scope: buildScope(), op }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setNeedsVersion(false);
        setMsg(viaApproval
          ? `Requested approval — ${j.held?.length ?? 0} unit${(j.held?.length ?? 0) === 1 ? "" : "s"} held pending sign-off.`
          : `Repriced ${j.changed?.length ?? 0} unit${(j.changed?.length ?? 0) === 1 ? "" : "s"}.`);
        setAmount("");
        await onChanged();
        return;
      }
      if (j.code === "needs_version") {
        setNeedsVersion(true);
        setMsg("This raise needs VRX approval. Request it and the units are held until it's signed off.");
        return;
      }
      if (j.code === "not_gated") {
        // request-approval refused because it's self-serve — apply directly.
        setMsg("That change is self-serve; applying it now…");
        setNeedsVersion(false);
        await apply(false);
        return;
      }
      setMsg(typeof j.error === "string" ? j.error : `Failed (${res.status}).`);
    } catch {
      setMsg("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label style={lbl}>Which units</label>
          <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as typeof scopeKind)} style={{ ...input, marginBottom: 0, width: 160, padding: "7px 8px" }}>
            <option value="all">Whole building</option>
            <option value="floor">One floor</option>
            <option value="units">Specific units</option>
          </select>
        </div>
        {scopeKind === "floor" && (
          <div>
            <label style={lbl}>Floor</label>
            <select value={floor} onChange={(e) => setFloor(Number(e.target.value))} style={{ ...input, marginBottom: 0, width: 90, padding: "7px 8px" }}>
              {floors.map((f) => <option key={f} value={f}>{f}F</option>)}
            </select>
          </div>
        )}
        {scopeKind === "units" && (
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={lbl}>Unit ids (comma-separated)</label>
            <input value={unitsCsv} onChange={(e) => setUnitsCsv(e.target.value)} placeholder="unit-501, unit-502" style={{ ...input, marginBottom: 0 }} />
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label style={lbl}>Change</label>
          <select value={opKind} onChange={(e) => setOpKind(e.target.value as typeof opKind)} style={{ ...input, marginBottom: 0, width: 150, padding: "7px 8px" }}>
            <option value="pct">By percent (%)</option>
            <option value="delta">By amount (±$)</option>
            <option value="set">Set to ($)</option>
          </select>
        </div>
        <div>
          <label style={lbl}>{opKind === "pct" ? "Percent (e.g. 5 or -3)" : opKind === "delta" ? "Amount (e.g. 5000 or -2000)" : "New price (USD)"}</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.-]/g, ""))} inputMode="decimal" placeholder={opKind === "set" ? String(building.inventory[0]?.priceUsd ?? "") : ""} style={{ ...input, marginBottom: 0, width: 180 }} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!needsVersion ? (
          <button type="button" disabled={busy || !amount} onClick={() => void apply(false)} style={{ ...submitBtn, padding: "7px 16px", fontSize: 13 }}>
            {busy ? "…" : "Apply"}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void apply(true)} style={{ ...btnOf("hold"), padding: "7px 16px", fontSize: 13 }}>
            {busy ? "…" : "Request VRX approval"}
          </button>
        )}
        {msg && <span style={{ fontSize: 12.5, opacity: 0.85 }}>{msg}</span>}
      </div>
      <p style={{ fontSize: 11.5, opacity: 0.55, margin: 0 }}>
        Prices are stored exactly; your display rounding is a separate setting. A price rise after you&apos;re on
        contract is reviewed by VRX; a price drop is immediate.
      </p>
    </div>
  );
}

// Add / remove / edit a unit's structure (/api/catalog/unit). Structural changes are version-gated post-sign-
// off → a 409 needs_version is surfaced with a "Request VRX approval" action that re-sends the SAME op to
// /api/catalog/request-approval (mirrors RepriceTool). Requesting opens a sealed version; remove/edit
// hold the unit until it's signed off, add holds nothing (the unit doesn't exist yet). Self-serve ops apply
// straight away. The approve-side auto-applies the exact change the approver signed off (apply-version).
function StructureTool({
  building,
  me,
  onChanged,
}: {
  building: Building;
  me: string;
  onChanged: () => void | Promise<void>;
}) {
  const [op, setOp] = useState<"add" | "remove" | "edit">("add");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [needsVersion, setNeedsVersion] = useState(false);
  // add fields
  const [id, setId] = useState("");
  const [type, setType] = useState("");
  const [floor, setFloor] = useState("");
  const [sqm, setSqm] = useState("");
  const [priceUsd, setPriceUsd] = useState("");
  // remove / edit target
  const [targetId, setTargetId] = useState("");
  // edit changes
  const [editSqm, setEditSqm] = useState("");
  const [editType, setEditType] = useState("");

  // The payload is IDENTICAL for the direct route and the request-approval route (both mirror /api/catalog/unit)
  // — only the URL differs. Build it once.
  function buildBody(): Record<string, unknown> {
    if (op === "add") {
      return { building: building.id, by: me, op: "add", unit: { id: id.trim(), type: type.trim(), floor: Number(floor), sqm: Number(sqm), priceUsd: Number(priceUsd) } };
    }
    if (op === "remove") {
      return { building: building.id, by: me, op: "remove", unit: targetId.trim() };
    }
    const changes: Record<string, unknown> = {};
    if (editSqm) changes.sqm = Number(editSqm);
    if (editType.trim()) changes.type = editType.trim();
    return { building: building.id, by: me, op: "edit", unit: targetId.trim(), changes };
  }

  function resetFields() {
    setId(""); setType(""); setFloor(""); setSqm(""); setPriceUsd(""); setTargetId(""); setEditSqm(""); setEditType("");
  }

  async function submit(viaApproval: boolean) {
    setBusy(true); setMsg(null);
    try {
      const url = viaApproval ? "/api/catalog/request-approval" : "/api/catalog/unit";
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setNeedsVersion(false);
        if (viaApproval) {
          const n = j.held?.length ?? 0;
          setMsg(op === "add"
            ? "Requested approval — the new unit lands once VRX signs it off."
            : `Requested approval — ${n} unit${n === 1 ? "" : "s"} held pending sign-off.`);
        } else {
          setMsg(op === "add" ? `Added ${j.added}.` : op === "remove" ? `Removed ${j.removed}.` : `Edited ${j.edited}.`);
        }
        resetFields();
        await onChanged();
        return;
      }
      if (j.code === "needs_version") {
        setNeedsVersion(true);
        setMsg("This structural change needs VRX approval while you're on contract. Request it and it lands once signed off.");
        return;
      }
      if (j.code === "not_gated") {
        // request-approval refused because it's self-serve — apply directly.
        setMsg("That change is self-serve; applying it now…");
        setNeedsVersion(false);
        await submit(false);
        return;
      }
      if (j.code === "live_reservation") {
        setMsg("That unit has a live reservation on-chain — it must go through a recorded cancellation first.");
        return;
      }
      setMsg(typeof j.error === "string" ? j.error : `Failed (${res.status}).`);
    } catch {
      setMsg("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {(["add", "remove", "edit"] as const).map((o) => (
          <button key={o} type="button" onClick={() => { setOp(o); setMsg(null); }} style={pill(op === o ? "active-blue" : "idle")}>
            {o === "add" ? "Add unit" : o === "remove" ? "Remove unit" : "Edit unit"}
          </button>
        ))}
      </div>
      {op === "add" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 120px), 1fr))", gap: 8 }}>
          <div><label style={lbl}>Unit id</label><input value={id} onChange={(e) => setId(e.target.value)} placeholder="unit-999" style={{ ...input, marginBottom: 0 }} /></div>
          <div><label style={lbl}>Type</label><input value={type} onChange={(e) => setType(e.target.value)} placeholder="1BR" style={{ ...input, marginBottom: 0 }} /></div>
          <div><label style={lbl}>Floor</label><input value={floor} onChange={(e) => setFloor(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" style={{ ...input, marginBottom: 0 }} /></div>
          <div><label style={lbl}>Size (m²)</label><input value={sqm} onChange={(e) => setSqm(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" style={{ ...input, marginBottom: 0 }} /></div>
          <div><label style={lbl}>Price (USD)</label><input value={priceUsd} onChange={(e) => setPriceUsd(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" style={{ ...input, marginBottom: 0 }} /></div>
        </div>
      )}
      {op === "remove" && (
        <div style={{ maxWidth: 240 }}>
          <label style={lbl}>Unit id to remove</label>
          <input value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="unit-999" style={{ ...input, marginBottom: 0 }} />
        </div>
      )}
      {op === "edit" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div><label style={lbl}>Unit id</label><input value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="unit-999" style={{ ...input, marginBottom: 0, width: 140 }} /></div>
          <div><label style={lbl}>New size (m², optional)</label><input value={editSqm} onChange={(e) => setEditSqm(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" style={{ ...input, marginBottom: 0, width: 140 }} /></div>
          <div><label style={lbl}>New type (optional)</label><input value={editType} onChange={(e) => setEditType(e.target.value)} placeholder="2BR" style={{ ...input, marginBottom: 0, width: 140 }} /></div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {!needsVersion ? (
          <button type="button" disabled={busy} onClick={() => void submit(false)} style={{ ...submitBtn, padding: "7px 16px", fontSize: 13 }}>
            {busy ? "…" : op === "add" ? "Add unit" : op === "remove" ? "Remove unit" : "Save changes"}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void submit(true)} style={{ ...btnOf("hold"), padding: "7px 16px", fontSize: 13 }}>
            {busy ? "…" : "Request VRX approval"}
          </button>
        )}
        {msg && <span style={{ fontSize: 12.5, opacity: 0.85 }}>{msg}</span>}
      </div>
    </div>
  );
}

function UnitPanel({
  building,
  unit,
  onChain,
  me,
  callFunction,
  onStamped,
  onOffMarketChanged,
  onClose,
  heldVersion,
  onHeldChanged,
}: {
  building: Building;
  unit: Unit;
  onChain: number;
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
  onStamped: () => void | Promise<void>;
  onOffMarketChanged: () => void | Promise<void>;
  onClose: () => void;
  /** — the open version holding THIS unit pending approval, or null if it's not held. */
  heldVersion?: HeldVersion | null;
  /** Called after a decide (approve/reject) so the console re-reads held + catalog. */
  onHeldChanged?: () => void | Promise<void>;
}) {
  const { state, run, busy } = useTxRun();
  const money = useMoney();
  const ref = unitRef(building.id, unit.id);
  const ut = building.unitTypes.find((t) => t.key === unit.type);
  const statusLabel = onChain < 0 ? "not listed" : TILE_STATUS[onChain] ?? String(onChain);

  async function stamp(status: number) {
    const ok = await run(
      async () => {
        // Canonical ref → opaque unit_key; a fresh integrity anchor over the catalog detail (never
        // sent raw). Same hashRef domains the agent screen uses, so the stamped tile is bookable.
        const unitKey = await hashRef(ref, "vrx-unit");
        const integrityHash = await hashRef(
          { ref, type: unit.type, sqm: unit.sqm, floor: unit.floor, priceUsd: unit.priceUsd },
          "vrx-tile"
        );
        const built = stampTileArgs(unitKey, status, integrityHash);
        const deposit = await depositFor(me);
        return callFunction({ method: built.method, args: built.args, deposit });
      },
      { successNote: `Unit marked ${TILE_STATUS[status]} on-chain.`, mapError: writeErr, ensureGasFor: me }
    );
    if (ok) await onStamped();
  }

  return (
    <div style={{ ...card, marginTop: 16, background: "#0e1119" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0, fontSize: 17 }}>
          Unit {unit.id.replace(/^unit-/, "")}{" "}
          <span style={{ fontSize: 13, opacity: 0.6 }}>· {ut?.label ?? unit.type} · floor {unit.floor}</span>
        </h3>
        <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "#9aa4bf", cursor: "pointer", fontSize: 18 }}>
          ×
        </button>
      </div>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 8, fontSize: 14 }}>
        <div><span style={{ opacity: 0.55 }}>Size</span> {unit.sqm} m²</div>
        <div><span style={{ opacity: 0.55 }}>Price</span> {money(unit.priceUsd)}</div>
        {unit.note && <div><span style={{ opacity: 0.55 }}>Note</span> {unit.note}</div>}
        <div>
          <span style={{ opacity: 0.55 }}>Status</span>{" "}
          <span style={{ color: statusColor(onChain < 0 ? "" : statusLabel) }}>{onChain < 0 ? "○" : "●"} {statusLabel}</span>
        </div>
      </div>
      <div style={{ ...mono, fontSize: 11, opacity: 0.6, marginTop: 6 }}>
        Reference {ref}
      </div>

      {/* HELD pending approval: this unit is in an open version-gated change awaiting sign-off. Frozen
          from booking meanwhile (lib/bookable). The approver (developer-self by default, or a VRX/CEO wallet if
 VRX-root set one) decides it here; everyone else just sees it's awaiting approval. */}
      {heldVersion && (
        <HeldBanner building={building} unit={unit} me={me} version={heldVersion} onDecided={onHeldChanged} />
      )}

      <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: "12px 0 0" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {onChain !== 0 && (
            <button type="button" onClick={() => stamp(0)} style={btnOf("open")}>
              {onChain < 0 ? "List as available" : "Re-open (available)"}
            </button>
          )}
          {onChain === 0 && (
            <button type="button" onClick={() => stamp(2)} style={btnOf("closed")}>
              Mark sold / off-market
            </button>
          )}
        </div>
      </fieldset>
      <TxProgress state={state} />

      {/* Off-market control — take the unit off the market with a reason, or release it. */}
      <OffMarketControl unit={unit} building={building} onChain={onChain} onChanged={onOffMarketChanged} />

      {/* Per-unit map pin — the rare villa/plot/townhouse with its own location. */}
      <UnitLocationEditor unit={unit} building={building} onSaved={onOffMarketChanged} />
    </div>
  );
}

// ── Per-unit location authoring ──────────────────────────────────────────────────────────────────
// The RARE case: a unit with its own location inside a wider development — a villa, townhouse, or plot. A
// tower unit normally has no pin (the building pin IS its location), so this stays COLLAPSED by default and
// out of the way. Seeds the draft from the unit's own pin, else the building's pin, else the demo center, so
// there's always something to drag. Clearing the pin makes the unit inherit the building location again.
// Saves via /api/catalog/geo with a `unit` id (branch). Mirrors BuildingLocationEditor.
function UnitLocationEditor({
  unit,
  building,
  onSaved,
}: {
  unit: Unit;
  building: Building;
  onSaved: () => void | Promise<void>;
}) {
  const hasPin = !!unit.geo;

  async function save(next: BuildingGeo | null) {
    const res = await fetch("/api/catalog/geo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ building: building.id, unit: unit.id, geo: next }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "save failed");
    }
    await onSaved();
  }

  return (
    <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "#0b0e16", border: "1px solid #24304a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>📍 Unit location</span>
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          {hasPin
            ? "This unit has its own pin (overrides the building location). Click the map to edit."
            : "Inherits the building location. Set a pin only for a villa / plot with its own spot."}
        </span>
      </div>
      {/* Seed from the unit pin, else the building pin, else the demo center. canClear = revert to inherit. */}
      <MapAuthoringField
        geo={unit.geo}
        seed={unit.geo ?? building.geo ?? DEFAULT_CENTER}
        canClear
        onSave={save}
        thumbHeight={150}
      />
    </div>
  );
}

// ── Off-market control: block / kill a unit, or release it back to market ────────────
// A developer takes a unit off the market with a REASON + CATEGORY (the reason is the story), or
// releases a blocked unit back to available, typically at a new price. The chain is never touched:
// this is the off-chain developer control surface. The server refuses to block a unit that has a LIVE
// on-chain reservation — that must go through the recorded cancellation instead.
function OffMarketControl({
  unit,
  building,
  onChain,
  onChanged,
}: {
  unit: Unit;
  building: Building;
  onChain: number;
  onChanged: () => void | Promise<void>;
}) {
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<BlockCategory>("phase-pricing");
  const [confirmedBy, setConfirmedBy] = useState("");
  const [kill, setKill] = useState(false);
  const [newPrice, setNewPrice] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const om = unit.offMarket;
  const liveOnChain = onChain === 1 || onChain === 2 || onChain === 3;

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/offmarket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(typeof json.error === "string" ? json.error : "Could not update the unit.");
        return false;
      }
      setOpen(false);
      setReason("");
      setConfirmedBy("");
      await onChanged();
      return true;
    } catch {
      setErr("Network error — please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ── Already off-market: show the reason + release control ──
  if (om) {
    const isKilled = om.state === "killed";
    return (
      <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "#1a1410", border: "1px solid #5a3a1e" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: isKilled ? "#e06a6a" : "#e0953a" }}>
            {isKilled ? "Removed (regulatory)" : "Off-market"}
          </span>
          <span style={{ fontSize: 12.5, opacity: 0.75 }}>· {BLOCK_CATEGORY_LABEL[om.category]}</span>
        </div>
        <div style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.5 }}>{om.reason}</div>
        {om.confirmedBy && (
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 3 }}>Confirmed by {om.confirmedBy}</div>
        )}
        <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 4 }}>
          By {om.by} · {timeAgo(om.at)}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12.5, opacity: 0.8 }}>New price (optional)</label>
          <input
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value.replace(/[^\d]/g, ""))}
            placeholder={String(unit.priceUsd)}
            inputMode="numeric"
            style={{ ...input, width: 130, margin: 0, padding: "5px 8px" }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              post({
                action: isKilled ? "unkill" : "unblock",
                building: building.id,
                unit: unit.id,
                by: "developer",
                newPriceUsd: newPrice ? Number(newPrice) : undefined,
              })
            }
            style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: "#1c5e2a" }}
          >
            {busy ? "Releasing…" : "Release to market"}
          </button>
        </div>
        <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 8, marginBottom: 0 }}>
          Releasing floats this unit back to available. Set a new price to update it at the same time.
        </p>
        {err && <div style={{ ...banner, marginTop: 8, fontSize: 12.5, borderColor: "#7a2b2b", background: "#241010" }}>{err}</div>}
      </div>
    );
  }

  // ── On-market: the "take off-market" control ──
  return (
    <div style={{ marginTop: 12 }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: "#3a2416", border: "1px solid #5a3a1e", color: "#e0b88a" }}
        >
          Take off-market…
        </button>
      ) : (
        <div style={{ padding: "12px 14px", borderRadius: 8, background: "#151922", border: "1px solid #2b3350" }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Take this unit off the market</div>
          <p style={{ fontSize: 12.5, opacity: 0.7, margin: "4px 0 10px" }}>
            The unit stops showing to agents and buyers. It stays yours — you can release it back any time,
            usually at a new price. Only available units can be taken off-market.
          </p>
          {liveOnChain && (
            <div style={{ ...banner, fontSize: 12.5, borderColor: "#6b5426", background: "#241d0e", marginBottom: 10 }}>
              This unit has a live reservation on-chain. It can&apos;t be quietly taken off-market — it must
              go through a recorded cancellation first.
            </div>
          )}
          <label style={lbl}>Reason</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as BlockCategory)}
            style={{ ...input, padding: "7px 8px" }}
          >
            {(Object.keys(BLOCK_CATEGORY_LABEL) as BlockCategory[]).map((k) => (
              <option key={k} value={k}>
                {BLOCK_CATEGORY_LABEL[k]}
              </option>
            ))}
          </select>
          <label style={lbl}>Note</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Hold for phase-2 pricing once the tower tops out"
            style={input}
          />
          <label style={lbl}>Confirmed by (optional)</label>
          <input
            value={confirmedBy}
            onChange={(e) => setConfirmedBy(e.target.value)}
            placeholder="e.g. K. Wee, 18/07"
            style={input}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={kill} onChange={(e) => setKill(e.target.checked)} />
            Regulatory removal (excluded from all figures)
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() =>
                post({
                  action: kill ? "kill" : "block",
                  building: building.id,
                  unit: unit.id,
                  reason: reason.trim(),
                  category: kill ? "regulatory" : category,
                  confirmedBy: confirmedBy.trim() || undefined,
                  by: "developer",
                })
              }
              style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: kill ? "#5e1c1c" : "#3a2416" }}
            >
              {busy ? "Working…" : kill ? "Remove unit" : "Take off-market"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setErr(null);
              }}
              style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}
            >
              Cancel
            </button>
          </div>
          <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 8, marginBottom: 0 }}>
            {money(unit.priceUsd)} · {unit.sqm} m². The reason is kept as the unit&apos;s history.
          </p>
          {err && <div style={{ ...banner, marginTop: 8, fontSize: 12.5, borderColor: "#7a2b2b", background: "#241010" }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

// ── Grant an agency access (gate) ─────────────────────────────────────────────────────────
type AgencyRosterRow = { account: string; legalName?: string; region?: string; vettedAt?: number; gated?: boolean };

function GrantAccess({
  me,
  callFunction,
}: {
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
}) {
  const [agencyId, setAgencyId] = useState("");
  const [units, setUnits] = useState("");
  const { state, run, busy } = useTxRun();
  const [lookup, setLookup] = useState<string | null>(null);
  // : offer the already-vetted agencies as PICK BUTTONS so the developer doesn't have to know/type
  // the account id. Data-driven from /api/agencies (every KYC-vetted agency; `gated` = already has access).
  const [roster, setRoster] = useState<AgencyRosterRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const j = await fetch(`/api/agencies?developer=${encodeURIComponent(me)}`).then((r) => r.json());
        if (live) setRoster(Array.isArray(j.agencies) ? j.agencies : []);
      } catch {
        if (live) setRoster([]);
      }
    })();
    return () => { live = false; };
  }, [me]);

  async function check() {
    setLookup(null);
    const id = agencyId.trim();
    if (!id) return;
    const org = await getOrg(id).catch(() => null);
    if (!org) {
      setLookup("No such agency — it must be onboarded by us (VRX) first.");
      return;
    }
    const gate = (await getGate(me, id).catch(() => null)) as { a?: boolean } | null;
    if (!gate) setLookup("Agency found — no access yet. Granting will set it up.");
    else setLookup(gate.a === false ? "Access was revoked — granting will re-open it." : "Access is already active.");
  }

  async function submit() {
    const id = agencyId.trim();
    if (!id) return;
    const refs = units
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean);
    const ok = await run(
      async () => {
        const scope = await Promise.all(refs.map((r) => hashRef(r, "vrx-unit")));
        const built = grantGateArgs(id, scope);
        const deposit = await depositFor(me);
        return callFunction({ method: built.method, args: built.args, deposit });
      },
      {
        successNote: `Access granted to ${id}${refs.length ? ` (${refs.length} unit scope${refs.length > 1 ? "s" : ""}).` : " (broad access)."}`,
        mapError: gateErr,
        ensureGasFor: me,
      }
    );
    // Write-through: record the gate server-side the moment it confirms on-chain, so the agent picker
    // can resolve access from our server without reading the (throttle-prone) chain. Fire-and-forget;
    // the on-chain gate remains the real authority for the booking itself.
    if (ok) {
      fetch("/api/gates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ developer: me, agency: id }),
      }).catch(() => {});
    }
    setLookup(null);
  }

  return (
    <section style={card}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Grant an agency access</h2>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 4 }}>
        Let an agency&apos;s agents see and book your units. Required before any agent can open a
        booking request on you.
      </p>
      <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: 0 }}>
        {/* Pick from the already-vetted agencies — CARDS showing who/when vetted so the developer picks with
 context, not a bare id. All agencies on VRX are KYC-vetted by us (root/VRX), so
            "Vetted by VRX" is the honest provenance; `vettedAt` is the real date; `gated` = you already granted. */}
        {roster && roster.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Pick a vetted agency</label>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 210px), 1fr))",
                gap: 8,
                marginTop: 4,
              }}
            >
              {roster.map((a) => {
                const active = agencyId.trim().toLowerCase() === a.account.toLowerCase();
                const since = a.vettedAt ? new Date(a.vettedAt).toLocaleDateString(undefined, { year: "numeric", month: "short" }) : null;
                return (
                  <button
                    key={a.account}
                    type="button"
                    onClick={() => { setAgencyId(a.account); setLookup(null); setTimeout(check, 0); }}
                    title={`${a.account}${a.region ? ` · ${a.region}` : ""}`}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
                      padding: "10px 12px", borderRadius: 10, cursor: "pointer", textAlign: "left",
                      border: `1px solid ${active ? T.accent : T.border}`,
                      background: active ? T.panel2 : T.bg2, color: T.text,
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.legalName || a.account}
                      </span>
                      {a.gated && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#07140d", background: T.vetted, borderRadius: 999, padding: "1px 7px", flexShrink: 0 }} title="You already granted this agency access">
                          ✓ access
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 11, fontFamily: T.mono, opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                      {a.account}
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.7, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ color: T.vetted }}>✓ Vetted by VRX</span>
                      {since && <span style={{ opacity: 0.6 }}>· since {since}</span>}
                      {a.region && <span style={{ opacity: 0.6 }}>· {a.region}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <label style={lbl}>Agency account</label>
        <input
          value={agencyId}
          onChange={(e) => {
            setAgencyId(e.target.value);
            setLookup(null);
          }}
          onBlur={check}
          placeholder="e.g. dysfunctional-smoke.testnet"
          style={input}
        />
        {lookup && <p style={{ fontSize: 13, opacity: 0.75, marginTop: -8, ...mono }}>{lookup}</p>}

        <label style={lbl}>Units in scope</label>
        <UnitScopePicker me={me} value={units} onChange={setUnits} />

        <button type="button" onClick={submit} disabled={busy} style={{ ...submitBtn, marginTop: 14 }}>
          {busy ? "Signing…" : "Grant access"}
        </button>
      </fieldset>
      <TxProgress state={state} />
    </section>
  );
}

// ── UnitScopePicker (: "the UI is miserable" — replace the hand-typed building/unit textarea) ──
// Grant-access scope, as a PICKER instead of raw text. Default = broad access (whole portfolio → empty scope,
// the contract's "no scope = all" path). Switch to "specific units" → pick a building, tick its units. Emits
// the SAME newline-joined `building/unit` string the submit already parses, so nothing downstream changes.
// Reuses the DeskVetting building→unit-checkbox pattern (the "build the pattern once").
type ScopeBuilding = { id: string; name: string };

function UnitScopePicker({ me, value, onChange }: { me: string; value: string; onChange: (v: string) => void }) {
  const [mode, setMode] = useState<"broad" | "specific">(value.trim() ? "specific" : "broad");
  const [buildings, setBuildings] = useState<ScopeBuilding[] | null>(null);
  const [building, setBuilding] = useState<string>("");
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [status, setStatus] = useState<UnitStatus>({});

  // The currently-selected refs, parsed from the value string (building/unit per line).
  const selected = useMemo(() => new Set(value.split("\n").map((s) => s.trim()).filter(Boolean)), [value]);
  // StackingPlan works with a Set of UNIT ids for the CURRENT building; derive it from the global ref set.
  const selectedIdsHere = useMemo(() => {
    const s = new Set<string>();
    const prefix = `${building}/`;
    for (const ref of selected) if (ref.startsWith(prefix)) s.add(ref.slice(prefix.length));
    return s;
  }, [selected, building]);

  // Load this developer's own buildings (same scope the Portfolio uses).
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const dev = await fetch(`/api/developers?account=${encodeURIComponent(me)}`).then((r) => r.json());
        const ids: string[] = dev.developer?.buildingIds ?? [];
        const sum = await fetch(`/api/catalog/summary?account=${encodeURIComponent(me)}`).then((r) => r.json());
        const all: ScopeBuilding[] = (sum.buildings ?? []).map((b: { id: string; name: string }) => ({ id: b.id, name: b.name }));
        const mine = ids.length ? all.filter((b) => ids.includes(b.id)) : all;
        if (!live) return;
        setBuildings(mine);
        if (mine.length && !building) setBuilding(mine[0].id);
      } catch {
        if (live) setBuildings([]);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // Load the selected building's full inventory + its snapshot status map (for the color-coded matrix).
  useEffect(() => {
    if (!building) { setUnits(null); return; }
    let live = true;
    void (async () => {
      try {
        const j = await fetch(`/api/catalog?building=${encodeURIComponent(building)}&account=${encodeURIComponent(me)}`).then((r) => r.json());
        const inv: Unit[] = j.building?.inventory ?? [];
        const statusMap: UnitStatus = j.snapshot?.units ?? {};
        if (!live) return;
        setUnits(inv);
        setStatus(statusMap);
      } catch {
        if (live) { setUnits([]); setStatus({}); }
      }
    })();
    return () => { live = false; };
  }, [building, me]);

  function toggleUnit(unitId: string) {
    const ref = `${building}/${unitId}`;
    const next = new Set(selected);
    if (next.has(ref)) next.delete(ref); else next.add(ref);
    onChange(Array.from(next).join("\n"));
  }

  // Select ALL units in the CURRENT building (keeps selections from other buildings).: avoids
  // ticking 200 boxes — select all, then untick the few you don't want.
  function selectAllInBuilding() {
    if (!units) return;
    const next = new Set(selected);
    for (const u of units) next.add(`${building}/${u.id}`);
    onChange(Array.from(next).join("\n"));
  }

  // Clear the current building's selections (leaves other buildings' selections intact).
  function clearBuilding() {
    const next = new Set(selected);
    for (const ref of selected) if (ref.startsWith(`${building}/`)) next.delete(ref);
    onChange(Array.from(next).join("\n"));
  }

  function setBroad() {
    setMode("broad");
    onChange("");
  }

  const buildingName = buildings?.find((b) => b.id === building)?.name ?? building;
  const selectedInBuilding = selectedIdsHere.size;

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", background: T.bg2 }}>
      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 8, marginBottom: mode === "specific" ? 12 : 0, flexWrap: "wrap" }}>
        <button type="button" onClick={setBroad} style={scopePill(mode === "broad")}>
          Whole portfolio <span style={{ opacity: 0.6 }}>— all units (broad)</span>
        </button>
        <button type="button" onClick={() => setMode("specific")} style={scopePill(mode === "specific")}>
          Specific units{selected.size > 0 ? ` · ${selected.size}` : ""}
        </button>
      </div>

      {mode === "broad" ? (
        <p style={{ fontSize: 11.5, opacity: 0.55, margin: "8px 0 0", lineHeight: 1.5 }}>
          The agency&apos;s agents can see and book <b>any</b> of your units. Switch to “Specific units” to limit it.
        </p>
      ) : buildings === null ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, margin: 0 }}>Loading your buildings…</p>
      ) : buildings.length === 0 ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, margin: 0 }}>You have no buildings yet.</p>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, opacity: 0.6 }}>Building</span>
            <select value={building} onChange={(e) => setBuilding(e.target.value)} style={{ ...input, margin: 0, padding: "6px 8px", fontSize: 13, width: "auto" }}>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            {units && units.length > 0 && (
              <>
                <button type="button" onClick={selectAllInBuilding} style={miniBtn} title={`Select all ${units.length} units in ${buildingName}`}>
                  Select all ({units.length})
                </button>
                {selectedInBuilding > 0 && (
                  <button type="button" onClick={clearBuilding} style={miniBtn} title={`Clear selections in ${buildingName}`}>
                    Clear
                  </button>
                )}
              </>
            )}
            <span style={{ fontSize: 11.5, opacity: 0.55 }}>
              {selectedInBuilding > 0 ? `${selectedInBuilding} selected in ${buildingName}` : `none selected in ${buildingName}`}
            </span>
          </div>
          {units === null ? (
            <p style={{ fontSize: 12, opacity: 0.55, margin: 0 }}>Loading units…</p>
          ) : units.length === 0 ? (
            <p style={{ fontSize: 12, opacity: 0.55, margin: 0 }}>No units in this building.</p>
          ) : (
            // The color-coded stacking-plan MATRIX in multi-select mode (: "a nicer view like the
            // matrix, with colors so you can see which units those are, quota etc"). Reuses the exact grid the
            // developer uses in "My buildings" — floors × unit-lines, status-colored, click to toggle into the
            // scope. Scrolls within a capped height so a 476-unit tower stays usable here.
            <div style={{ maxHeight: 340, overflowY: "auto" }}>
              <StackingPlan
                units={units}
                status={status}
                selectMode
                selectedIds={selectedIdsHere}
                onToggle={(u) => toggleUnit(u.id)}
              />
            </div>
          )}
          <p style={{ fontSize: 10.5, opacity: 0.6, margin: "8px 0 0", lineHeight: 1.5 }}>
            Click units to add them to this agency&apos;s scope — the colors show each unit&apos;s current
            status (available / on hold / sold / not listed). You can mix units from several buildings — switch
            buildings above; selections are kept.
          </p>
        </div>
      )}
    </div>
  );
}

function scopePill(active: boolean): React.CSSProperties {
  return {
    fontSize: 12.5, padding: "7px 13px", borderRadius: 8, cursor: "pointer",
    border: `1px solid ${active ? T.accent : T.border}`,
    background: active ? T.panel2 : "transparent", color: active ? T.text : T.faint,
    fontWeight: active ? 600 : 400,
  };
}

const miniBtn: React.CSSProperties = {
  fontSize: 11.5, padding: "4px 9px", borderRadius: 7, cursor: "pointer",
  border: `1px solid ${T.border}`, background: T.bg2, color: T.accent, fontWeight: 500,
};

function gateErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NOT_NODE/i.test(msg)) return "This account isn't set up as a developer.";
  if (/ORG_NOT_FOUND/i.test(msg)) return "No such agency — it must be onboarded by us (VRX) first.";
  if (/E57|deposit/i.test(msg)) return "Couldn't complete — please try again.";
  return "Something went wrong. Please try again.";
}

// ── Current exclusive holds ─────────────────────────────────────────────────────────
// Lists the units this developer has currently reserved exclusively for an agency, with the holding
// agency, the end date, and a one-click early release. Because the contract stores exclusives by
// opaque unit_key (not by developer), we scan this developer's own catalog units, read get_exclusive
// for each, and keep only the LIVE ones this developer granted. Reuses the server-cached catalog
// so the scan hits our own catalog, and reads get_exclusive per candidate directly (a handful, not
// hundreds — only granted units surface).
type ExclusiveRow = { unitId: string; buildingId: string; buildingName: string; key: string; ex: ExclusiveWire };

function Exclusives({
  me,
  callFunction,
}: {
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
}) {
  const [rows, setRows] = useState<ExclusiveRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  // this panel only LISTS + releases holds; you CREATE one in "My buildings" (select units →
  // reserve for an agency → grant_exclusive). The panel named that action but didn't link to it, so add a
  // deep-link to the portfolio section (the shell honours ?section=, DashboardShell.tsx).
  const goCreate = useCallback(() => router.push("/node?section=portfolio"), [router]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // read our LIVE holds from the write-through mirror in ONE request — zero chain reads. (This used
      // to scan get_exclusive over EVERY catalog unit, ~1,558 reads, which flooded keyless RPC and hung. We
      // author every hold through this portal, so the mirror already knows them; the CONTRACT remains the
      // authority — a booking against a held unit still reverts E58 regardless of this map.)
      const holds = await fetch(`/api/exclusives?developer=${encodeURIComponent(me)}`)
        .then((r) => r.json())
        .then((d: { holds?: { unitKey: string; buildingId: string; unitId: string; orgId: string; until: number }[] }) => d.holds ?? [])
        .catch(() => []);
      // Map building ids → names from the catalog (one fetch, no chain reads) so rows stay labelled.
      const buildings = await fetchCatalog(me).catch(() => [] as Building[]);
      const nameOf = new Map(buildings.map((b) => [b.id, b.name]));
      const found: ExclusiveRow[] = holds.map((h) => ({
        unitId: h.unitId,
        buildingId: h.buildingId,
        buildingName: nameOf.get(h.buildingId) ?? h.buildingId,
        key: h.unitKey,
        ex: { o: h.orgId, u: h.until, b: me },
      }));
      found.sort((a, b) => a.ex.u - b.ex.u);
      setRows(found);
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Exclusive holds</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={goCreate} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13 }}>
            ＋ Create a hold
          </button>
          <button type="button" onClick={() => void refresh()} disabled={loading} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
        Units you&apos;ve currently set aside for one agency only. Others can&apos;t book these until
        the hold ends; they revert automatically on the end date. Release early any time. To create a new
        hold, use <strong>＋ Create a hold</strong> — it takes you to My buildings, where you select units and
        reserve them for an agency.
      </p>
      {rows === null && loading && <p style={{ opacity: 0.5, fontSize: 14 }}>Loading your holds…</p>}
      {rows && rows.length === 0 && !loading && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>
          No exclusive holds right now. Go to{" "}
          <button
            type="button"
            onClick={goCreate}
            style={{ background: "none", border: "none", padding: 0, color: "#6cc4ff", fontSize: 14, cursor: "pointer", textDecoration: "underline" }}
          >
            My buildings
          </button>
          , select units, and reserve them for an agency to create one.
        </p>
      )}
      {rows?.map((r) => (
        <ExclusiveRowView key={r.key} row={r} me={me} callFunction={callFunction} onChanged={refresh} />
      ))}
    </section>
  );
}

function ExclusiveRowView({
  row,
  me,
  callFunction,
  onChanged,
}: {
  row: ExclusiveRow;
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
  onChanged: () => void | Promise<void>;
}) {
  const { state, run, busy } = useTxRun();

  async function release() {
    const ok = await run(
      async () => {
        const built = releaseExclusiveArgs(row.key);
        const deposit = await depositFor(me);
        return callFunction({ method: built.method, args: built.args, deposit });
      },
      { successNote: "Exclusive hold released — the unit is back in the shared pool.", mapError: exclusiveErr, ensureGasFor: me }
    );
    if (ok) {
      // Write-through mirror: tombstone the released hold so the panel drops it with no chain read.
      void fetch("/api/exclusives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release", unitKey: row.key }),
      }).catch(() => {});
      await onChanged();
    }
  }

  return (
    <div style={{ borderTop: "1px solid #232838", padding: "14px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div>
          <b style={{ fontSize: 15 }}>
            {row.buildingName} · unit {row.unitId.replace(/^unit-/, "")}
          </b>
          <div style={{ opacity: 0.7, fontSize: 13, marginTop: 2 }}>
            reserved for <code style={{ ...mono, fontSize: 12 }}>{row.ex.o}</code> · until{" "}
            <b>{fmtUntil(row.ex.u)}</b>
          </div>
        </div>
        <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: 0 }}>
          <button type="button" onClick={release} style={btnOf("declined")}>
            {busy ? "…" : "Release early"}
          </button>
        </fieldset>
      </div>
      <TxProgress state={state} />
    </div>
  );
}

// ── Incoming bookings INBOX ─────────────────────────────────────────────────────────
// The developer's first-class deal surface. Each booking shows the ATTESTED OFFER (payment plan / terms /
// ownership — the plaintext the agent made), VERIFIED against the on-chain request_hash (a ✓ VETTED
// seal, or a loud red mismatch = tamper tripwire), with catalog NAMES (not opaque hashes), grouped into
// PENDING (awaiting you) and RESOLVED (history). Each row carries a channel THREAD to talk to the
// agent. Reads one batched /api/claims call (server, FastNEAR-keyed) that joins chain + offer + names.
type InboxRow = {
  requestId: string;
  claim: ClaimWire | null;
  offer: OfferRecord | null;
  verified: boolean;
  names: { building?: string; unit?: string } | null;
  /** completeness against the booking floor (computed server-side from the full buyer). */
  buyerPolicy?: { ok: boolean; summary: string } | null;
  /** — agency commission payable on this sale (what the developer will owe); null = no live rate. */
  commission?: { pct: number; priceUsd: number; amountUsd: number; agency: string } | null;
  /** H2 — WHY, so a blank payable is explained honestly instead of silent. */
  commissionReason?: CommissionReason;
  baselineAt?: number;
};
// `OfferRecord` + `AssembledPlanLite` moved to components/OfferTailoring.tsx (slice 4) and imported
// the top of this file — shared with the direct desk so both channels read the identical offer shape.

// A chat message in a booking channel, re-exported from the shared DealChat component so the
// lifted thread state + the Messages tab agree on one shape.
type Msg = DealChatMsg;

// Which group a booking falls into (the Awaiting / Held / History).
type Group = "awaiting" | "held" | "history";
function groupOf(row: InboxRow): Group {
  const s = row.claim?.s;
  if (s === 0 && !isRequestLapsed(row.claim)) return "awaiting";
  if (s === 1) return "held"; // accepted on-chain, deposit awaited → confirm to close
  return "history"; // declined / alternative / confirmed-closed / lapsed-open
}

function rowTitle(row: InboxRow): string {
  const { names, claim } = row;
  if (names?.unit) return `${names.building ?? "Unit"} · unit ${names.unit}`;
  if (claim) return `unit ${claim.k.slice(0, 10)}…`;
  return "Booking";
}

/** Derive a readable booking status from the ATTESTED OFFER when there's no on-chain claim (the demo/seed world —
 *  off-chain offers with no chain record). Maps the offer's real lifecycle (confirmed / S&P contract stage) to the
 *  same status vocabulary the claim path uses, so history reads as a complete, realistic deal state (not "unknown",
 *). Only returns "unknown" when there's genuinely nothing to show (no offer at all). */
function statusFromOffer(offer: InboxRow["offer"]): string {
  if (!offer) return "unknown";
  if (offer.confirmed) return "sold"; // developer-confirmed close (statusColor → settled blue)
  switch (offer.contract?.stage) {
    case "signed": return "signed";
    case "payment_arrived": return "payment received"; // matches statusColor's in-progress amber
    case "final": return "ready to sign";
    case "preview": return "in contract";
    default: return "offer made";
  }
}

// ── The master-detail dashboard (redesign) ───────────────────────────────────────────────────
// Replaces the expanding-row inbox. ONE parent owns: the rows, the selection, the notification
// state, AND the per-request channel threads + drafts (LIFTED out of the row — the bug was that
// ChannelThread held its draft locally and an Accept re-render unmounted it, wiping an unsent message).
// Left = grouped/filterable list (Awaiting / Held / History); right = detail panel with tabs
// Offer / Buyer / Messages for the selected booking. Scales to hundreds of bookings per building.
function Queue({
  me,
  callFunction,
}: {
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
}) {
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Deep-link focus: a "Review →" click in the event log routes here with ?focus=<requestId>; open
  // that booking in the detail pane once it's present in the loaded rows, then clear so manual nav is free.
  const { focus, clearFocus } = useShellFocus("queue");
  useEffect(() => {
    if (!focus) return;
    if (rows.some((x) => x.requestId === focus)) {
      setSelectedId(focus);
      clearFocus();
    }
  }, [focus, rows, clearFocus]);

  // NOTIFICATION (the fix-first issue 1): an UNFOCUSED tab must alert. We drive three cues off the
  // count of unseen awaiting-you bookings: (a) a document-title badge (always), (b) a soft chime, and
  // (c) a real browser Notification (one-time permission; degrades silently if denied). Reads go through
  // /api/claims (SERVER, keyed) so the browser never hits the throttled RPC. Real push (indexer /
  //  real-time transport) is a later arc.
  const seenRef = useRef<Set<string>>(new Set());
  const [newCount, setNewCount] = useState(0);
  const everLoaded = useRef(false);
  const notify = useNotifier();

  // LIFTED channel state (the fix): threads + drafts live HERE, keyed by requestId, so a row/list
  // re-render (e.g. a booking moving Awaiting→Held on Accept) never unmounts a thread or wipes a draft.
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      setErr(null);
      try {
        const r = await fetch(`/api/claims?node=${encodeURIComponent(me)}`);
        if (!r.ok) throw new Error(r.status === 503 ? "network busy" : `claims ${r.status}`);
        const j = (await r.json()) as { rows?: InboxRow[] };
        const list = j.rows ?? [];
        setRows(list);
        // Count AWAITING arrivals we hadn't seen (after first load, so the initial set isn't "new").
        if (everLoaded.current) {
          const fresh = list.filter((x) => groupOf(x) === "awaiting" && !seenRef.current.has(x.requestId));
          if (fresh.length > 0) {
            setNewCount((n) => n + fresh.length);
            // shared notifier — ring 3× + deep-link straight to the booking inbox.
            notify(
              fresh.length === 1 ? "New booking request" : `${fresh.length} new booking requests`,
              fresh.length === 1 ? rowTitle(fresh[0]) : `Including ${rowTitle(fresh[0])}`,
              { tag: "vrx-inbox", repeat: 3, href: "/node?section=queue" }
            );
          }
        }
        list.forEach((x) => seenRef.current.add(x.requestId));
        everLoaded.current = true;
      } catch (e) {
        if (!opts?.silent) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [me, notify]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // REAL-TIME: the server pushes a "tick" over SSE whenever the mirror advances, so we refresh on
  // actual change instead of polling every 60s (the poll that caused the /api/* 120/min 429s). We listen
  // to every tick; a mirror change ("events") refreshes the whole inbox. Thread ticks are handled by the
  // selected-thread effect below.
  useEventStream((t) => {
    if (t.topic === "events") void refresh({ silent: true });
  });

  // SLOW safety poll (5 min) — catches up if the SSE stream silently dropped (proxy, sleep/wake). This is
  // a fallback, not the primary path, so it's gentle on the rate limit; visible-tab only.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh({ silent: true });
    }, 300_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Document-title badge mirrors the unseen count; cleared when the dev engages with the inbox.
  useEffect(() => {
    const base = "Developer — VRX";
    document.title = newCount > 0 ? `(${newCount}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [newCount]);
  const clearNew = () => setNewCount(0);

  // Load (and keep polling, visible-tab) the SELECTED booking's thread into the lifted store.
  const loadThread = useCallback(async (requestId: string) => {
    try {
      const r = await fetch(`/api/channels/${encodeURIComponent(requestId)}?viewer=${encodeURIComponent(me)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { messages?: Msg[] };
      setThreads((prev) => ({ ...prev, [requestId]: j.messages ?? [] }));
    } catch {
      /* transient — keep the last known thread */
    }
  }, [me]);

  // Load the selected thread on selection, and keep a SLOW safety poll (5 min) as an SSE fallback. The
  // fast path is the SSE tick below: a message landing in THIS thread pushes "channel:<id>" → reload now.
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  useEffect(() => {
    if (!selectedId) return;
    void loadThread(selectedId);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadThread(selectedId);
    }, 300_000);
    return () => clearInterval(timer);
  }, [selectedId, loadThread]);

  // REAL-TIME: push for the currently-open thread. We compare against the ref (not a stale closure)
  // so the single subscription always targets whatever thread is selected right now.
  useEventStream((t) => {
    const sel = selectedIdRef.current;
    if (sel && t.topic === channelTopic(sel)) void loadThread(sel);
  });

  const setDraft = useCallback((requestId: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [requestId]: value }));
  }, []);

  // Send takes the body EXPLICITLY from the caller (not re-read from the drafts closure) so it can't go
  // stale and silently no-op — the sender always posts exactly what's in the box right now. No `drafts`
  // dep means this callback is stable, too.
  const sendMessage = useCallback(
    async (requestId: string, body: string) => {
      const text = body.trim();
      if (!text) return;
      try {
        const r = await fetch(`/api/channels/${encodeURIComponent(requestId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: "developer", by: me, text }),
        });
        if (r.ok) {
          setDrafts((prev) => ({ ...prev, [requestId]: "" }));
          await loadThread(requestId);
        }
      } catch {
        /* leave the draft so the developer can retry — this is the whole point of lifting it */
      }
    },
    [me, loadThread]
  );

  // Group + filter.
  const q = query.trim().toLowerCase();
  const matches = (row: InboxRow) => {
    if (!q) return true;
    const hay = [rowTitle(row), row.claim?.p, row.claim?.o, row.offer?.seal.terms]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  };
  const filtered = rows.filter(matches);
  const groups: Record<Group, InboxRow[]> = {
    awaiting: filtered.filter((r) => groupOf(r) === "awaiting"),
    held: filtered.filter((r) => groupOf(r) === "held"),
    history: filtered.filter((r) => groupOf(r) === "history"),
  };

  // Keep a valid selection: default to the first awaiting (or first of anything) once rows load.
  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId && rows.some((r) => r.requestId === selectedId)) return;
    const first = groups.awaiting[0] ?? groups.held[0] ?? groups.history[0] ?? rows[0];
    setSelectedId(first?.requestId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const selected = rows.find((r) => r.requestId === selectedId) ?? null;

  return (
    <section style={card} onClick={newCount > 0 ? clearNew : undefined}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontSize: 18, margin: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
          Incoming bookings
          {newCount > 0 && (
            <span
              className="vrx-pulse"
              title="New booking requests since you last looked"
              style={{ fontSize: 12, fontWeight: 700, color: "#0b0e14", background: "#38d39f", borderRadius: 999, padding: "1px 8px" }}
            >
              {newCount} new
            </span>
          )}
        </h2>
        <button type="button" onClick={() => refresh()} disabled={loading} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13 }}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
        Bookings from the agents you&apos;ve authorised. Pick one on the left to see the offer, buyer, and
        messages. Accept, decline, or offer an alternative; once the buyer has paid the deposit, confirm to
        close the unit. This list checks itself every minute and alerts you when a new one arrives.
      </p>
      {err && <p style={{ color: "#ff8080" }}>Network busy — {err}. Try Refresh in a moment.</p>}

      {!err && rows.length === 0 && !loading && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>No bookings yet. Mark a unit available and have an agent open one.</p>
      )}

      {rows.length > 0 && (
        <div className="vrx-master-detail" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 320px) 1fr", gap: 16, marginTop: 14, alignItems: "start" }}>
          <InboxList
            groups={groups}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              clearNew();
            }}
            query={query}
            onQuery={setQuery}
          />
          <InboxDetail
            key={selected?.requestId ?? "none"}
            row={selected}
            me={me}
            callFunction={callFunction}
            onChanged={() => refresh()}
            thread={selected ? threads[selected.requestId] ?? null : null}
            draft={selected ? drafts[selected.requestId] ?? "" : ""}
            onDraft={setDraft}
            onSend={sendMessage}
          />
        </div>
      )}
    </section>
  );
}

// ── Master list (left): grouped Awaiting / Held / History + a search filter ────────────────────────
// Scrolls within a capped height so hundreds of bookings per building stay usable. (True
// virtualization is deferred — it needs a lib; a scroll container windows the DOM well enough here.)
function InboxList({
  groups,
  selectedId,
  onSelect,
  query,
  onQuery,
}: {
  groups: Record<Group, InboxRow[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQuery: (v: string) => void;
}) {
  const total = groups.awaiting.length + groups.held.length + groups.history.length;
  return (
    <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 10, background: T.bg2, overflow: "hidden" }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${T.borderSoft}` }}>
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search bookings…"
          style={{ ...input, margin: 0, padding: "7px 9px", fontSize: 13 }}
        />
      </div>
      <div style={{ maxHeight: 520, overflowY: "auto" }}>
        {total === 0 && (
          <p style={{ fontSize: 12.5, opacity: 0.55, padding: "14px 12px", margin: 0 }}>No bookings match.</p>
        )}
        <ListGroup label="Awaiting you" color={T.vetted} rows={groups.awaiting} selectedId={selectedId} onSelect={onSelect} />
        <ListGroup label="Held" color={T.hold} rows={groups.held} selectedId={selectedId} onSelect={onSelect} />
        <ListGroup label="History" color={T.faint} rows={groups.history} selectedId={selectedId} onSelect={onSelect} dim />
      </div>
    </div>
  );
}

function ListGroup({
  label,
  color,
  rows,
  selectedId,
  onSelect,
  dim,
}: {
  label: string;
  color: string;
  rows: InboxRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  dim?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color, padding: "9px 12px 4px" }}>
        {label} · {rows.length}
      </div>
      {rows.map((row) => (
        <ListItem key={row.requestId} row={row} selected={row.requestId === selectedId} onSelect={onSelect} dim={dim} />
      ))}
    </div>
  );
}

function ListItem({
  row,
  selected,
  onSelect,
  dim,
}: {
  row: InboxRow;
  selected: boolean;
  onSelect: (id: string) => void;
  dim?: boolean;
}) {
  const { claim, offer, verified } = row;
  const lapsed = isRequestLapsed(claim);
  // Status PREFERS the on-chain claim, but FALLS BACK to the attested offer's own state when there is no claim
  // (the demo/seed world has off-chain offers with no chain claim — without this fallback every seeded history
  // row read "unknown"). The offer carries a real lifecycle (confirmed / contract.stage) we can show.
  const statusLabel = lapsed
    ? "lapsed"
    : claim
      ? CLAIM_STATUS[claim.s] ?? String(claim.s)
      : statusFromOffer(offer);
  return (
    <button
      type="button"
      onClick={() => onSelect(row.requestId)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "9px 12px",
        border: "none",
        borderLeft: `3px solid ${selected ? T.accent : "transparent"}`,
        background: selected ? T.panel2 : "transparent",
        color: T.text,
        cursor: "pointer",
        opacity: dim && !selected ? 0.78 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {rowTitle(row)}
        </span>
        {offer ? (
          <span
            title={verified ? "Verified against the on-chain record" : "Does not match the on-chain record"}
            style={{ fontSize: 11, color: verified ? T.vetted : T.danger }}
          >
            {verified ? "✓" : "⚠"}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 11, marginTop: 2, color: lapsed ? CACHED_ORANGE : statusColor(statusLabel) }}>
        ● {statusLabel}
        {claim?.s === 0 && !lapsed && (() => {
          const c = requestClock(claim);
          return c ? <span style={{ color: c.urgent ? T.hold : T.dim, marginLeft: 6 }}>· {humanDuration(c.leftMs)} left</span> : null;
        })()}
      </div>
    </button>
  );
}

// ── Detail panel (right): the selected booking, with tabs Offer / Buyer / Messages ─────────────────
function InboxDetail({
  row,
  me,
  callFunction,
  onChanged,
  thread,
  draft,
  onDraft,
  onSend,
}: {
  row: InboxRow | null;
  me: string;
  callFunction: ReturnType<typeof useWallet>["callFunction"];
  onChanged: () => void;
  thread: Msg[] | null;
  draft: string;
  onDraft: (requestId: string, value: string) => void;
  onSend: (requestId: string, body: string) => void | Promise<void>;
}) {
  const money = useMoney();
  const { state, run, busy } = useTxRun();
  const [tab, setTab] = useState<"offer" | "buyer" | "messages">("offer");
  // confirm_claim closes the TILE but (contract FROZEN) leaves claim.status at 1, so a second Confirm
  // would pass the on-chain assert and re-run (wasteful). The DURABLE "sold" signal is offer.confirmed
  // stamped server-side on confirm, so it survives refresh (the chain can't tell us: status
  // stays 1). `confirmedId` is only an OPTIMISTIC flip for THIS render, until the /api/claims re-read
  // brings offer.confirmed back. Keyed by requestId so switching rows resets the optimistic bit.
  const [confirmedId, setConfirmedId] = useState<string | null>(null);

  if (!row) {
    return (
      <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 10, padding: 24, color: T.dim, fontSize: 13 }}>
        Select a booking on the left to see its offer, buyer, and messages.
      </div>
    );
  }

  const { requestId, claim, offer, verified } = row;

  async function reply(status: number) {
    const ok = await run(
      async () => {
        const responseHash = await hashRef({ requestId, decision: CLAIM_STATUS[status] }, "vrx-reply");
        const tileHash = status === 1 ? await hashRef({ requestId, held: true }, "vrx-tile") : "";
        const built = replyClaimArgs(requestId, status, responseHash, tileHash);
        const deposit = await depositFor(me);
        return callFunction({ method: built.method, args: built.args, deposit });
      },
      { successNote: `Replied ${CLAIM_STATUS[status]} on-chain.`, mapError: writeErr, ensureGasFor: me }
    );
    if (ok) onChanged();
  }

  async function confirm() {
    if (busy || isConfirmed) return; // guard double-submit / re-confirm (durable + optimistic)
    // Capture the on-chain receipt here (the same lastTx pattern StampTiles uses): the wallet returns the
    // confirm_claim tx hash, which we persist into offer.confirmed so the SoldBadge shows a permanent
    // explorer link (keep the receipt, don't hide the magic). state.tx would be stale in this closure.
    let lastTx = "";
    const ok = await run(
      async () => {
        const integrityHash = await hashRef({ requestId, confirmed: true }, "vrx-tile");
        const built = confirmClaimArgs(requestId, integrityHash);
        const deposit = await depositFor(me);
        lastTx = await callFunction({ method: built.method, args: built.args, deposit });
        return lastTx;
      },
      { successNote: "Confirmed — unit closed on-chain.", mapError: writeErr, ensureGasFor: me }
    );
    if (ok) {
      setConfirmedId(requestId); // optimistic flip until the /api/claims re-read brings offer.confirmed back
      // Durably record the sale server-side (survives refresh — the chain leaves claim.status at 1)..
      // Pass the tx hash so offer.confirmed carries the on-chain receipt.
      void fetch("/api/claims/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, by: me, tx: lastTx || undefined }),
      }).catch(() => {});
      onChanged();
    }
  }

  const statusLabel = claim ? CLAIM_STATUS[claim.s] ?? String(claim.s) : "unknown";
  const lapsed = isRequestLapsed(claim);
  const msgCount = thread?.length ?? 0;
  // SOLD = durable server marker (survives refresh) OR the optimistic flip from this session's confirm.
  // The chain can't tell us (claim.status stays 1 after confirm_claim) — offer.confirmed is the truth.
  const isConfirmed = Boolean(offer?.confirmed) || confirmedId === requestId;

  const tabBtn = (key: typeof tab, label: string): React.CSSProperties => ({
    padding: "7px 14px",
    border: "none",
    borderBottom: `2px solid ${tab === key ? T.accent : "transparent"}`,
    background: "none",
    color: tab === key ? T.text : T.dim,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: tab === key ? 600 : 400,
  });

  return (
    <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 10, background: T.bg2, overflow: "hidden" }}>
      {/* Header: unit name · verification seal · status */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.borderSoft}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{rowTitle(row)}</div>
            <BookingCode requestId={row.requestId} size={12} />
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <VerifiedSeal offer={offer} verified={verified} />
            {lapsed ? (
              <span style={{ color: CACHED_ORANGE, fontSize: 13, whiteSpace: "nowrap" }} title="No response within 2 hours — the buyer didn't proceed">
                ● lapsed
              </span>
            ) : (
              <span style={{ color: statusColor(statusLabel), fontSize: 13, whiteSpace: "nowrap" }}>● {statusLabel}</span>
            )}
          </div>
        </div>
        {claim && (
          <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4, ...mono }}>
            agent {claim.p} · agency {claim.o}
          </div>
        )}

        {/* Actions */}
        <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: "12px 0 0" }}>
          {claim?.s === 0 && (
            <div style={{ marginBottom: 8 }}><RequestClock claim={claim} /></div>
          )}
          {claim?.s === 0 && !lapsed && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => reply(1)} disabled={busy} style={{ ...btnOf("accepted"), opacity: busy ? 0.5 : 1 }}>Accept</button>
              <button type="button" onClick={() => reply(2)} disabled={busy} style={{ ...btnOf("declined"), opacity: busy ? 0.5 : 1 }}>Decline</button>
              <button type="button" onClick={() => reply(3)} disabled={busy} style={{ ...btnOf("alternative"), opacity: busy ? 0.5 : 1 }}>Offer alternative</button>
            </div>
          )}
          {claim?.s === 0 && lapsed && (
            <div>
              <p style={{ opacity: 0.6, fontSize: 12.5, margin: "0 0 8px" }}>
                This request has been open over 2 hours. If the buyer is still proceeding you can accept or
                offer an alternative; otherwise decline to clear it.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => reply(1)} disabled={busy} style={{ ...btnOf("accepted"), opacity: busy ? 0.5 : 1 }}>Accept</button>
                <button type="button" onClick={() => reply(2)} disabled={busy} style={{ ...btnOf("declined"), opacity: busy ? 0.5 : 1 }}>Decline</button>
                <button type="button" onClick={() => reply(3)} disabled={busy} style={{ ...btnOf("alternative"), opacity: busy ? 0.5 : 1 }}>Offer alternative</button>
              </div>
            </div>
          )}
          {claim?.s === 1 && !isConfirmed && (
            <button type="button" onClick={confirm} disabled={busy} style={{ ...btnOf("closed"), opacity: busy ? 0.5 : 1 }}>
              Confirm (deposit paid → close unit)
            </button>
          )}
          {claim?.s === 1 && isConfirmed && <SoldBadge confirmed={offer?.confirmed} />}
          {claim && claim.s >= 2 && (
            <span style={{ opacity: 0.6, fontSize: 13 }}>No further action — request {statusLabel}.</span>
          )}
        </fieldset>
        <TxProgress state={state} />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, padding: "0 10px", borderBottom: `1px solid ${T.borderSoft}` }}>
        <button type="button" style={tabBtn("offer", "Offer")} onClick={() => setTab("offer")}>Offer</button>
        <button type="button" style={tabBtn("buyer", "Buyer")} onClick={() => setTab("buyer")}>Buyer</button>
        <button type="button" style={tabBtn("messages", "Messages")} onClick={() => setTab("messages")}>
          Messages{msgCount > 0 ? ` · ${msgCount}` : ""}
        </button>
      </div>

      <div style={{ padding: 16 }}>
        {tab === "offer" && (
          <>
            <OfferDetail offer={offer} money={money} />
            {/* commission payable to the agency on this sale (what you'll owe). B2B; never on the buyer S&P. */}
            {row.commission && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <span style={{ opacity: 0.55 }}>Agency commission payable</span>{" "}
                <strong>{money(row.commission.amountUsd)}</strong>{" "}
                <span style={{ opacity: 0.6 }}>· {row.commission.pct}% of {money(row.commission.priceUsd)}</span>
              </div>
            )}
            {/* H2 (scope widened) — a booking with NO payable: say WHY, don't leave it blank, for ANY
                booking (not just accepted). The copy fn is null for earned/prospective, so this only fills the
 otherwise-silent no-commission cases (incl. the unconfirmed one caught). */}
            {!row.commission && row.commissionReason && commissionReasonCopy(row.commissionReason, row.baselineAt) && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: T.dim }}>
                <span style={{ opacity: 0.55 }}>Agency commission payable</span>{" "}
                {commissionReasonCopy(row.commissionReason, row.baselineAt)}
              </div>
            )}
            {offer && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
                <SaleContractButton requestId={requestId} viewer={me} />
                <div style={{ fontSize: 11.5, color: T.dim, marginTop: 6 }}>
                  The full Sale &amp; Purchase agreement, populated from this booking — the buyer sees exactly
                  this before paying the deposit.
                </div>
                <ConcessionsEditor offer={offer} me={me} onChanged={onChanged} />
                <TimedTermsEditor offer={offer} me={me} onChanged={onChanged} />
                <DiscountEditor offer={offer} me={me} onChanged={onChanged} />
                <TaxEditor offer={offer} me={me} onChanged={onChanged} />
                <InstalmentMilestoneEditor offer={offer} me={me} onChanged={onChanged} />
                <ContractStageControls offer={offer} me={me} onChanged={onChanged} />
                {/*  step 5 — the customer→developer payment ledger for this deal: log payments received,
                    see schedule-vs-actual variance, and whether the agency commission is payable yet. */}
                <PaymentLedgerPanel
                  requestId={requestId}
                  developer={me}
                  buildingId={offer.display?.buildingId}
                  unitId={offer.display?.unitId}
                  buyer={offer.display?.buyerId}
                />
                {/* §5b — the developer's READ-ONLY view of the two-sided reconciliation: how their own
                    "received" records pair against the buyer side's independent "sent" records. canLog=false —
                    the developer logs via the ledger above; here they only see where the two ledgers agree or
                    diverge, so they can reconcile their books. VRX states the variance, never adjudicates. */}
                <ReconciliationPanel requestId={requestId} viewer={me} canLog={false} heading="Reconcile payments" />
              </div>
            )}
          </>
        )}
        {tab === "buyer" && <BuyerBlock offer={offer} policy={row.buyerPolicy ?? null} me={me} requestId={requestId} onChanged={onChanged} />}
        {tab === "messages" && (
          <DealChat
            viewerRole="developer"
            thread={thread}
            draft={draft}
            onDraft={(v) => onDraft(requestId, v)}
            onSend={(body) => onSend(requestId, body)}
          />
        )}
      </div>
    </div>
  );
}

// ── The ✓ VETTED verification seal ──────────────────────────────────────────────────────────
// Green ✓ VETTED when the stored offer plaintext re-hashes to the on-chain request_hash (unaltered since
// signing). Loud RED when it DOESN'T match (a tamper tripwire). Neutral when we hold no plaintext (booked
// outside this portal) — honest "offer not on file", not a false pass.
function VerifiedSeal({ offer, verified }: { offer: OfferRecord | null; verified: boolean }) {
  if (!offer) {
    return (
      <span style={{ ...chip, fontSize: 10.5 }} title="No offer plaintext on file — this booking was made outside this portal. The on-chain record still stands.">
        offer not on file
      </span>
    );
  }
  if (verified) {
    return (
      <span style={seal} title="The offer on file matches the on-chain record exactly — unaltered since it was signed.">
        ✓ Vetted
      </span>
    );
  }
  return (
    <span
      style={{ ...seal, color: T.danger, background: "rgba(255,107,107,0.10)", border: `1px solid rgba(255,107,107,0.4)` }}
      title="The offer on file does NOT match the on-chain record. Do not act on it — contact the agent."
    >
      ⚠ Mismatch
    </span>
  );
}

// The durable SOLD state — shown once the deposit is confirmed and the unit is closed on-chain.
// Replaces the Confirm button permanently (survives refresh via offer.confirmed), so can't lose the
// sold confirmation or accidentally re-confirm. Loud + green so a closed sale reads at a glance.
//
// it also KEEPS THE ON-CHAIN RECEIPT (: don't hide the magic). TxProgress flashes the tx hash
// then disappears; here we render it permanently: the confirm date + the tx hash as an explorer link. The
// hash is optional (a booking confirmed outside this portal, or before we captured it) — then we show just
// the badge + date, same as before.
function SoldBadge({ confirmed }: { confirmed?: { at: number; by: string; tx?: string } }) {
  const at = confirmed?.at;
  const tx = confirmed?.tx;
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderRadius: 8,
          background: "rgba(56,211,159,0.12)",
          border: `1px solid ${T.vetted}`,
          color: T.vetted,
          fontSize: 13,
          fontWeight: 600,
        }}
        title={at ? `Deposit confirmed and unit closed on-chain · ${new Date(at).toLocaleString()}` : "Deposit confirmed and unit closed on-chain."}
      >
        ✓ SOLD — deposit confirmed, unit closed on-chain
      </span>
      {(at || tx) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11.5, color: T.dim, paddingLeft: 2 }}>
          {at && <span>Closed {new Date(at).toLocaleString()}</span>}
          {tx && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...mono }}>
              <span style={{ color: T.faint }}>on-chain receipt</span>
              <a
                href={`${EXPLORER_URL}/transactions/${tx}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: T.accent, wordBreak: "break-all" }}
                title="View the confirm transaction on the NEAR explorer"
              >
                {tx.length > 18 ? `${tx.slice(0, 10)}…${tx.slice(-6)}` : tx}
              </a>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// The six per-deal tailoring editors (Concessions / Timed-terms / Instalment-milestone / Discount / Tax /
// Contract-stage) moved to components/OfferTailoring.tsx (slice 4) and are imported at the top of this
// file. The JSX below renders them in this page's own order; the direct desk imports the same components.

// The non-circumvention undertaking the developer accepts to reveal a buyer (trigger T1). Accepting
// it is itself a sealed, timestamped act — the reveal MANUFACTURES evidence against a later end-run: the
// developer can't later claim they "found" the buyer independently. Kept in one place so the text that was
// agreed is reproducible for the agent's evidence bundle.
const NON_CIRCUMVENTION_TEXT =
  "I will not contact or transact with this buyer except through the introducing agent. The introducer's " +
  "commission is owed in full regardless of who ultimately closes the deal, for the protected period set " +
  "in our agreement. I am revealing this identity only to progress this specific transaction.";

// Live booking-request CLOCK (UX) — self-ticking "requested 34m ago · 1h 26m to respond", amber
// in the last 30 min, so the developer feels the 2-hour window BEFORE it lapses rather than hitting a cliff.
// Renders nothing for a non-open claim. (Business-hours-aware countdown is a queued sub-arc.)
function RequestClock({ claim }: { claim: ClaimWire | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!claim || claim.s !== 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [claim]);
  const c = requestClock(claim, now);
  if (!c) return null;
  const color = c.lapsed ? CACHED_ORANGE : c.urgent ? T.hold : T.dim;
  return (
    <span style={{ fontSize: 12, color }}>
      ⏱ requested {humanDuration(c.ageMs)} ago ·{" "}
      {c.lapsed ? "response window passed" : `${humanDuration(c.leftMs)} to respond`}
    </span>
  );
}

// the attestation-source TRUST TIER badge. Who stands behind this record: the agent (frictionless
// floor, lower trust), or the buyer themselves (confirmed via a link / self-created — higher trust, a
// bilateral introduction). The developer weights the record accordingly.
function AttestationBadge({ source }: { source: string }) {
  const map: Record<string, { label: string; color: string; bg: string; border: string; title: string }> = {
    agent: {
      label: "agent-attested",
      color: T.dim,
      bg: "rgba(255,255,255,0.04)",
      border: "rgba(255,255,255,0.15)",
      title: "The agent entered this buyer. Reliable for booking; a buyer confirmation (coming via the buyer app) would strengthen it.",
    },
    "buyer-confirmed": {
      label: "✓ buyer-confirmed",
      color: T.vetted,
      bg: "rgba(56,211,159,0.10)",
      border: "rgba(56,211,159,0.35)",
      title: "The buyer themselves confirmed this record — a bilateral introduction, higher trust.",
    },
    "buyer-self": {
      label: "✓ buyer-entered",
      color: T.vetted,
      bg: "rgba(56,211,159,0.10)",
      border: "rgba(56,211,159,0.35)",
      title: "The buyer created this record in their own account — the most trusted source.",
    },
  };
  const m = map[source] ?? map.agent;
  return (
    <span title={m.title} style={{ fontSize: 11, color: m.color, background: m.bg, border: `1px solid ${m.border}`, borderRadius: 999, padding: "2px 8px" }}>
      {m.label}
    </span>
  );
}

// Human labels for the buyer snapshot keys (added the structured name parts). Unmapped keys fall back to
// the raw key, so a future field still renders (just un-prettified) rather than disappearing.
const BUYER_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  firstName: "First name",
  nickName: "Nickname",
  middleName: "Middle name",
  lastName: "Last name",
  phone: "Phone",
  email: "Email",
  nationality: "Nationality",
  idRef: "ID / passport",
  remarks: "Remarks",
};

// ── Buyer block — the masked proof, the reveal act, or an honest "not yet provided" ─
function BuyerBlock({
  offer,
  policy,
  me,
  requestId,
  onChanged,
}: {
  offer: OfferRecord | null;
  policy: { ok: boolean; summary: string } | null;
  me: string;
  requestId: string;
  onChanged: () => void;
}) {
  const buyer = offer?.seal.buyer;
  const buyerType = offer?.display.buyerType;
  const revealed = !!offer?.unlock?.revealed;
  const requested = !!offer?.unlock?.revealRequest && !revealed;
  // attestationSource is record metadata (trust tier), not a PII field: pull it out so it renders as
  // a badge and is excluded from the identifying-field rows + the "has buyer" check.
  const buyerMap = (buyer != null && typeof buyer === "object" ? (buyer as Record<string, unknown>) : {}) as Record<string, unknown>;
  const attestationSource = typeof buyerMap.attestationSource === "string" ? buyerMap.attestationSource : null;
  //  name-split — the snapshot may carry structured name PARTS (title/first/nick/middle/last) alongside the
  // composed `name`. In this developer view we show the PARTS when present (they carry the agent's per-part mask
  // intent) and suppress the redundant composed `name` line; a pre-split record (no parts) still shows `name`.
  const NAME_PART_KEYS = ["title", "firstName", "nickName", "middleName", "lastName"];
  const hasNameParts = NAME_PART_KEYS.some((k) => k in buyerMap);
  const buyerFields = Object.entries(buyerMap).filter(
    ([k]) => k !== "attestationSource" && !(hasNameParts && k === "name")
  );
  const hasBuyer = buyerFields.length > 0;
  const [accepting, setAccepting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  // : a developer's pre-deposit reveal is a REQUEST — the developer accepts the sealed
  // non-circumvention declaration, but the buyer only unlocks once the AGENT approves. The developer can
  // never force the mask off before deposit.
  async function requestReveal() {
    if (!agreed) return;
    setBusy(true);
    try {
      const r = await fetch("/api/offers/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, action: "request", trigger: "T1-dev", by: me, declaration: NON_CIRCUMVENTION_TEXT }),
      });
      if (r.ok) onChanged();
    } finally {
      setBusy(false);
      setAccepting(false);
      setAgreed(false);
    }
  }

  return (
    <div style={{ padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}`, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Buyer</span>
        {buyerType && <span style={{ ...chip, fontSize: 10.5 }}>{String(buyerType)}</span>}
        {hasBuyer && !revealed && (
          <span
            style={{ fontSize: 11, color: T.accent, background: "rgba(95,160,255,0.10)", border: "1px solid rgba(95,160,255,0.35)", borderRadius: 999, padding: "2px 8px" }}
            title="A vetted buyer is committed. Identity stays protected until the deposit is paid, so the agent's customer can't be poached. You can reveal early by accepting the non-circumvention terms."
          >
            🔒 protected until deposit
          </span>
        )}
        {hasBuyer && revealed && (
          <span style={{ fontSize: 11, color: T.vetted, background: "rgba(56,211,159,0.10)", border: "1px solid rgba(56,211,159,0.35)", borderRadius: 999, padding: "2px 8px" }}>
            ✓ revealed
          </span>
        )}
        {hasBuyer && policy && (
          <span
            title={policy.ok ? "This buyer meets the minimum detail required to book." : "Below the booking floor — you can decline, or ask the agent to complete it."}
            style={{
              fontSize: 11,
              borderRadius: 999,
              padding: "2px 8px",
              color: policy.ok ? T.vetted : T.hold,
              background: policy.ok ? "rgba(56,211,159,0.10)" : "rgba(232,184,75,0.10)",
              border: `1px solid ${policy.ok ? "rgba(56,211,159,0.35)" : "rgba(232,184,75,0.35)"}`,
            }}
          >
            {policy.ok ? "✓ enough to book" : policy.summary}
          </span>
        )}
        {hasBuyer && attestationSource && <AttestationBadge source={attestationSource} />}
        {!hasBuyer && (
          <span
            style={{ fontSize: 11, color: T.hold, background: "rgba(232,184,75,0.10)", border: "1px solid rgba(232,184,75,0.35)", borderRadius: 999, padding: "2px 8px" }}
            title="The agent hasn't attached buyer identity yet. You can decline if it's not clear who the buyer is."
          >
            detail not yet provided
          </span>
        )}
      </div>

      {hasBuyer ? (
        <>
          <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
            {buyerFields.map(([k, v]) => (
              <div key={k}>
                <span style={{ opacity: 0.55 }}>{BUYER_FIELD_LABELS[k] ?? k}</span> {String(v)}
              </div>
            ))}
          </div>
          {!revealed && requested && (
            <p style={{ fontSize: 11.5, color: T.hold, margin: "8px 0 0" }}>
              ⏳ Reveal requested — you&apos;ve accepted the non-circumvention terms (recorded). Awaiting the
              agent&apos;s approval. It also unlocks automatically once the deposit is paid.
            </p>
          )}
          {!revealed && !requested && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 11.5, opacity: 0.6, margin: "0 0 6px" }}>
                A real, vetted buyer is committed and the record is unaltered (seal verified above). Full
                identity unlocks automatically when the deposit is paid. To see it sooner, request a reveal:
                you accept the non-circumvention terms (recorded), and the agent approves.
              </p>
              {!accepting ? (
                <button type="button" onClick={() => setAccepting(true)} style={{ ...chip, cursor: "pointer", fontSize: 12, padding: "5px 11px" }}>
                  Request buyer identity…
                </button>
              ) : (
                <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 7, padding: 10, background: T.bg }}>
                  <p style={{ fontSize: 12, lineHeight: 1.55, margin: "0 0 8px" }}>{NON_CIRCUMVENTION_TEXT}</p>
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, cursor: "pointer" }}>
                    <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>I accept these terms. I understand this acceptance is recorded and timestamped, and the agent must approve before the identity is shown.</span>
                  </label>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button type="button" disabled={!agreed || busy} onClick={requestReveal} style={{ ...btnOf("accepted"), opacity: !agreed || busy ? 0.5 : 1 }}>
                      {busy ? "Sending…" : "Accept & request reveal"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => { setAccepting(false); setAgreed(false); }} style={btnOf("declined")}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <p style={{ fontSize: 12, opacity: 0.6, margin: "6px 0 0" }}>
          No buyer identity on file yet. Ask the agent in the thread below, or decline if it&apos;s unclear
          who the buyer is or whether they&apos;re real.
        </p>
      )}
    </div>
  );
}

// ── Offer detail — the verified payment plan + free-text terms ───────────────────────────────
function OfferDetail({ offer, money }: { offer: OfferRecord | null; money: (usd: number) => string }) {
  if (!offer) {
    return (
      <div style={{ fontSize: 12.5, opacity: 0.55, marginBottom: 10 }}>
        No offer detail on file for this booking (it may have been made outside this portal).
      </div>
    );
  }
  const p = offer.seal.plan;
  const terms = offer.seal.terms?.trim();
  return (
    <div style={{ marginBottom: 10 }}>
      {p ? (
        <div style={{ padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
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
          {p.balanced === false && (
            <div style={{ fontSize: 11.5, color: T.hold, marginTop: 6 }}>⚠ The plan&apos;s milestones don&apos;t reconcile to the price — review before accepting.</div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, opacity: 0.6 }}>No structured payment plan — see terms below.</div>
      )}
      {terms && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 2 }}>Offer / terms</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{terms}</div>
        </div>
      )}
    </div>
  );
}

// ── shared bits ──
function RoleBanner({
  ready,
  accountId,
  isNode,
  signIn,
}: {
  ready: boolean;
  accountId: string | null;
  isNode: boolean | null;
  signIn: () => void;
}) {
  if (!ready) return null;
  if (!accountId) {
    return (
      <div
        style={{
          ...banner,
          border: "1px solid #3a3f52",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span>Connect your developer wallet to manage units.</span>
        <button onClick={signIn} style={{ ...submitBtn, padding: "8px 16px", fontSize: 14, whiteSpace: "nowrap" }}>
          Connect wallet
        </button>
      </div>
    );
  }
  if (isNode === false) {
    return (
      <div style={{ ...banner, border: "1px solid #5a3a3a", background: "#22161a" }}>
        Connected as <code>{accountId}</code>, which isn&apos;t set up as a developer. Developers are
        onboarded by us (VRX) first — please contact us to get set up.
      </div>
    );
  }
  // Signed in + onboarded → no banner at all (role + account are already in the top bar; the "Signed in
  // as a developer" confirmation just ate space). Only the sign-in / not-onboarded prompts show.
  return null;
}

// Progressive-load skeleton (the rule: "looks fast and impressive at all times"). The structure
// paints instantly — a shimmering hero block + a grid of placeholder boxes — so there's never a blank
// or a dead spinner; real content swaps in as it streams.
/** Small rotating spinner for the progressive-load hint (A1). */
function Spinner() {
  return <span className="vrx-spin" aria-hidden="true" />;
}

function BuildingSkeleton() {
  const block = (w: number | string, h: number): React.CSSProperties => ({
    width: w,
    height: h,
    borderRadius: 8,
    background: "#151b28",
    border: "1px solid #1c2434",
  });
  return (
    <div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <div className="vrx-working" style={block(260, 170)} />
        <div style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="vrx-working" style={block("55%", 20)} />
          <div className="vrx-working" style={block("40%", 14)} />
          <div className="vrx-working" style={block("70%", 40)} />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 46px)", gap: 4 }}>
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i} className="vrx-working" style={{ width: 46, height: 38, borderRadius: 6, background: "#151b28", border: "1px solid #1c2434" }} />
        ))}
      </div>
    </div>
  );
}

function btnOf(label: string): React.CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 8,
    border: `1px solid ${statusColor(label)}`,
    background: "#0e1119",
    color: statusColor(label),
    cursor: "pointer",
    fontSize: 14,
  };
}

const stepBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: "1px solid #2a2f40",
  background: "#0e1119",
  color: "#c7cde0",
  cursor: "pointer",
  fontSize: 18,
  lineHeight: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

// Prettify a catalog building id → a readable label for display (e.g. "skyline-tower" → "Skyline Tower").
// The seal only stores the id; this is a display nicety (the id stays canonical for matching).
function prettyBuildingId(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ── Commission agreements — the developer's side of the attested record ───────────────────
// The agency proposes a commission agreement (lib/agreements.ts, an attested record on the spine);
// the developer agrees or declines it here. Same off-chain seal + re-hash ✓ VETTED. The on-chain stamp
//  is a later arc — the contract is untouched. List + agree/decline; ending an agreed agreement is
// mutual-consent only — the developer's forward-looking lever is the access gate, not revoke.
type AgreementBuildingClause = {
  buildingId: string;
  commissionPct: number;
  scope: "whole" | { units: string[] };
};
type PartyIdentity = { legalName: string; region: string; role: "developer" | "agency" | "agent" };
type AgreementRecord = {
  id: string;
  seal: {
    agency: string;
    developer: string;
    buildings: AgreementBuildingClause[];
    terms: string;
    by: "agency" | "developer";
    proposedAt: number;
    agencyIdentity?: PartyIdentity;
    developerIdentity?: PartyIdentity;
  };
  sealHash: string;
  status: "published" | "proposed" | "agreed" | "declined" | "revoked";
  revokeRequestBy?: string;
  at: number;
  updatedAt: number;
  verified: boolean;
};

function DeveloperAgreements({ me }: { me: string }) {
  const [rows, setRows] = useState<AgreementRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Two entry points: "offer" = set up for a specific agency (Mode 1); "publish" = open terms (Mode 2).
  const [compose, setCompose] = useState<null | "offer" | "publish">(null);

  // Deep-link focus: a "Review →" click in the event log routes here with ?focus=<agreementId>.
  // Highlight + scroll that row into view once it's loaded, then clear.
  const { focus, clearFocus } = useShellFocus("agreements");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || !rows) return;
    if (rows.some((g) => g.id === focus)) {
      setHighlightId(focus);
      clearFocus();
      const t = setTimeout(() => setHighlightId(null), 2600);
      return () => clearTimeout(t);
    }
  }, [focus, rows, clearFocus]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/agreements?party=${encodeURIComponent(me)}&viewer=${encodeURIComponent(me)}`);
      const j = (await r.json()) as { agreements?: AgreementRecord[] };
      setRows(j.agreements ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* The developer's own agreement WITH VRX (§7) — read the disclosure terms + sign off each
 building + sign. Sits above the commission agreements because it's the developer↔VRX
          relationship (VRX's own terms), distinct from the developer↔agency commission terms below. */}
      <VrxAgreementPanel me={me} />

      {/* The developer's own house-default buyer-default / termination clause numbers (§config-surface,
 ) — the figures that fill the §Default-and-Termination part of their buyers' S&Ps. These
          are the developer's OWN terms toward their customers, distinct from VRX's fee/settlement terms above
          (which VRX-root sets). Sits with the VRX agreement because both are the developer's standing terms. */}
      <SaleTermsDefaultsPanel me={me} />

      <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Commission agreements</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setCompose((v) => (v === "offer" ? null : "offer"))} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: compose === "offer" ? T.accent : T.panel2, color: compose === "offer" ? "#fff" : T.dim }}>
            {compose === "offer" ? "Close" : "Set up for an agency"}
          </button>
          <button type="button" onClick={() => setCompose((v) => (v === "publish" ? null : "publish"))} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13 }}>
            {compose === "publish" ? "Close" : "Publish open terms"}
          </button>
        </div>
      </div>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
        Your commission terms with each agency. Set up an agreement for a specific agency, publish standing
        terms for any vetted agency to join, or agree to terms an agency proposes to you. A ✓ Vetted seal
        means the agreement hasn&apos;t changed since it was signed. Rates are kept off-chain and private.
      </p>

      {compose === "offer" && <OfferAgreement me={me} onDone={async () => { setCompose(null); await refresh(); }} />}
      {compose === "publish" && <PublishAgreement me={me} onDone={async () => { setCompose(null); await refresh(); }} />}

      {loading && rows === null && <p style={{ opacity: 0.5, fontSize: 14 }}>Loading…</p>}
      {rows && rows.length === 0 && !compose && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>
          No commission agreements yet. Set up an agreement for an agency, publish open terms for agencies to
          join, or wait for an agency to propose terms to you.
        </p>
      )}
      {/* Pack agreements as CARDS — up to ~3 per row on a wide screen (min 420px keeps each readable),
 wrapping down to 1 on a phone. Cards are vertical stacks; height varies with content. */}
      {rows && rows.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))",
            alignItems: "start",
            gap: 12,
            marginTop: 12,
          }}
        >
          {rows.map((g) => (
            <DeveloperAgreementRow key={g.id} g={g} me={me} onChanged={refresh} highlight={g.id === highlightId} />
          ))}
        </div>
      )}
      </section>
    </div>
  );
}

// ── Publish standing terms (Mode 2) ──────────────────────────────────────────────────────────
// The developer publishes commission terms OPENLY (no agency named) — a standing offer any vetted agency
// can discover and JOIN. This is the common agency-onboarding path: the developer sets the rate per
// building once; agencies accept it as-is (they don't counter-offer). The POST carries by:"developer"
// with an EMPTY agency, which the store reads as Mode 2 → status "published". Buildings come from the
// developer's OWN catalog (fetchCatalog), the same source the portfolio grid uses — no counterparty card
// here because a publish has no counterparty until an agency joins.
// A per-building clause row's editable state: whether it's included + the rate offered for it.
// `pct` = this building's commission rate. `unlock` = this building's PER-BUILDING unlock threshold (§3):
// the % of the price the developer must have received from the buyer before the agency's commission on THIS
// building becomes payable (sealed per building, alongside `commissionPct`). Blank = inherit the agreement-wide
// "minimum deposit %" fallback (tf.minDepositPct), so an unset row never silently blocks a payable commission.
type Clause = { on: boolean; pct: string; unlock: string };
const DEFAULT_PCT = "3";
// Blank unlock = inherit the agreement-wide minimum-deposit fallback at seal time (never a hard-coded per-row %).
const DEFAULT_UNLOCK = "";

// The Terms are captured as STRUCTURED fields — each term is its own labelled input so the
// developer thinks about each one deliberately, and a live preview shows exactly what the agency will see.
// The four terms: WHEN commission is paid (developer-set minimum deposit %), exclusivity, duration + how
// it ends, and what the % is calculated on. Publish is a standing offer to ANY agency → inherently
// non-exclusive (true exclusivity is the separate on-chain hold), so exclusivity is stated, not chosen.
type TermFields = {
  minDepositPct: string; // developer's minimum deposit % that triggers commission
  durationMonths: string; // agreement duration
  autoRenew: boolean; // rolls over unless ended
  commissionBasis: string; // what the % is calculated on (editable — phrasing varies)
  notes: string; // optional free-text the structure doesn't cover
};
const DEFAULT_TERM_FIELDS: TermFields = {
  minDepositPct: "10",
  durationMonths: "12",
  autoRenew: true,
  commissionBasis: "the net sale price, excluding taxes and transfer fees",
  notes: "",
};

// Assemble the structured fields into the canonical terms text — this exact string is what gets SEALED and
// shown to the agency, so the preview the developer sees IS the agreement text (no hidden divergence). The
// non-exclusive line reads slightly differently for a directed offer vs an open publish (same meaning).
function assembleTerms(t: TermFields, mode: "publish" | "offer" = "publish"): string {
  const nonExcl =
    mode === "offer"
      ? `• Non-exclusive — these commission terms do not lock any units to the agency; other agencies may also sell them.`
      : `• Non-exclusive — these terms are published for any vetted agency to join; other agencies may also sell these units.`;
  const lines = [
    `• Commission is paid when the buyer signs the contract and the developer has received the minimum deposit of ${t.minDepositPct || "___"}% of the price. Where a per-building unlock threshold is set, that building's own threshold applies.`,
    nonExcl,
    `• Duration: ${t.durationMonths || "___"} months from the agreement date${t.autoRenew ? ", auto-renewing unless ended" : " (does not auto-renew)"}.`,
    // Termination for convenience with survival of accrued commission: either side can exit on
    // notice — neither is trapped by the other's consent. Deals already concluded still pay; nothing new accrues
    // after the end date; ending imposes no duty to continue. This is the standard, fair agency-agreement exit.
    `• Ending: either party may end this Agreement at any time by giving the other 30 days' written notice. Commission already earned on deals concluded before the end date remains payable in full; no new commission accrues on introductions made after the end date. Ending does not oblige the Developer to offer any future units, nor the Agency to continue selling.`,
    `• Commission is calculated on ${t.commissionBasis.trim() || "the net sale price"}.`,
    //  trio #3 — the commission-tail / protected-period clause (platform default 6 months).
    // This is the contractual teeth that makes revealing the buyer's identity safe for the agent: once the
    // Agency has registered an introduction, the commission follows that introducer even if the deal later
    // closes through a different agent or directly — so a developer "end-run" after the reveal still owes it.
    `• Introduction protection: where the Agency has registered the introduction of a buyer through this platform, commission on any resulting transaction with that buyer follows the Agency for 6 months from the introduction date, regardless of which agent or channel ultimately closes the deal. Contacting or transacting with an introduced buyer other than through the Agency during this period does not avoid this commission.`,
  ];
  const extra = t.notes.trim();
  return extra ? `${lines.join("\n")}\n• ${extra}` : lines.join("\n");
}

// A vetted agency the developer can offer terms to directly (Mode 1 roster). `gated` = this developer
// already has an active access gate to it (badge "already work with" vs a new agency being onboarded).
type AgencyCard = { account: string; legalName: string; region: string; gated: boolean };

// ── Mode 2 wrapper: publish OPEN terms (no agency named → any vetted agency can join) ──────────────
function PublishAgreement({ me, onDone }: { me: string; onDone: () => void | Promise<void> }) {
  return <AgreementBuilder me={me} mode="publish" onDone={onDone} />;
}

// ── Mode 1 wrapper: set up an agreement FOR a specific vetted agency (developer→agency direct) ──
function OfferAgreement({ me, onDone }: { me: string; onDone: () => void | Promise<void> }) {
  return <AgreementBuilder me={me} mode="offer" onDone={onDone} />;
}

// ── The shared agreement builder — ONE structured form, two modes ────────────────────────────
// Both the developer's "Set up for an agency" (Mode 1 "offer") and "Publish open terms" (Mode 2 "publish")
// are the SAME form: a per-building rate table + structured terms + live preview. The ONLY differences are
// (a) "offer" picks a counterparty agency from a roster first; (b) the copy + submit label; (c) the POST
// (offer = named agency, by:"developer" → "proposed"; publish = empty agency → "published"). One component,
// no duplicated 250-line body (the "reuse the pattern").
function AgreementBuilder({ me, mode, onDone }: { me: string; mode: "publish" | "offer"; onDone: () => void | Promise<void> }) {
  const isOffer = mode === "offer";

  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  // buildingId → { on, pct } — which of my buildings these terms cover + the per-building rate.
  const [clauses, setClauses] = useState<Record<string, Clause>>({});
  const [tf, setTf] = useState<TermFields>(DEFAULT_TERM_FIELDS);
  const terms = assembleTerms(tf, mode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Mode-1 only: the agency roster + the chosen counterparty.
  const [agencies, setAgencies] = useState<AgencyCard[] | null>(null);
  const [picked, setPicked] = useState<AgencyCard | null>(null);
  // Mode-1 only: any EXISTING agreement(s) with the picked agency — so we never let the developer silently
  // set a new % over a durable signed one. null = not yet checked; [] = checked, none.
  const [existing, setExisting] = useState<AgreementRecord[] | null>(null);

  // Load the developer's own buildings (fetchCatalog) — with an explicit error state so a slow/throttled
  // fetch shows a Retry rather than a bare "no buildings" (the empty-form case hit).
  const loadBuildings = useCallback(async () => {
    setLoadErr(false);
    setBuildings(null);
    try {
      const bs = await fetchCatalog(me);
      setBuildings(bs);
      setClauses((prev) =>
        Object.fromEntries(
          bs.map((b) => [b.id, prev[b.id] ?? { on: false, pct: DEFAULT_PCT, unlock: DEFAULT_UNLOCK }])
        )
      );
    } catch {
      setBuildings([]);
      setLoadErr(true);
    }
  }, []);

  useEffect(() => {
    void loadBuildings();
  }, [loadBuildings]);

  // Mode-1 only: load the vetted-agency roster (badged with "already have access").
  useEffect(() => {
    if (!isOffer) return;
    fetch(`/api/agencies?developer=${encodeURIComponent(me)}`)
      .then((r) => r.json())
      .then((d: { agencies?: AgencyCard[] }) => setAgencies(d.agencies ?? []))
      .catch(() => setAgencies([]));
  }, [isOffer, me]);

  // Mode-1 only: when an agency is picked, look up any EXISTING agreement(s) with them before offering new
  // terms (guard). A signed (agreed) agreement is durable — the developer must NOT be able to silently
  // set a new % over it; a pending proposal shouldn't be duplicated either. We fetch the developer's own
  // agreements and keep the live ones (agreed / proposed / pending-end) with this agency.
  useEffect(() => {
    if (!isOffer || !picked) {
      setExisting(null);
      return;
    }
    let cancelled = false;
    setExisting(null);
    fetch(`/api/agreements?party=${encodeURIComponent(me)}&viewer=${encodeURIComponent(me)}`)
      .then((r) => r.json())
      .then((d: { agreements?: AgreementRecord[] }) => {
        if (cancelled) return;
        const acct = picked.account.toLowerCase();
        const live = (d.agreements ?? []).filter(
          (g) =>
            g.seal.agency.toLowerCase() === acct &&
            (g.status === "agreed" || g.status === "proposed")
        );
        setExisting(live);
      })
      .catch(() => { if (!cancelled) setExisting([]); });
    return () => { cancelled = true; };
  }, [isOffer, picked, me]);

  const setClause = (id: string, patch: Partial<Clause>) =>
    setClauses((p) => ({ ...p, [id]: { ...(p[id] ?? { on: false, pct: DEFAULT_PCT, unlock: DEFAULT_UNLOCK }), ...patch } }));

  const selected = (buildings ?? []).filter((b) => clauses[b.id]?.on);
  const allOn = !!buildings?.length && selected.length === buildings.length;

  // "One rate for all" quick-fill: set every ticked building to the same %. Falls back to turning all on
  // if none are ticked yet (the common "same rate across the whole portfolio" case).
  function applyRateToAll(pct: string) {
    setClauses((p) => {
      const anyOn = (buildings ?? []).some((b) => p[b.id]?.on);
      return Object.fromEntries(
        (buildings ?? []).map((b) => {
          const cur = p[b.id] ?? { on: false, pct: DEFAULT_PCT, unlock: DEFAULT_UNLOCK };
          return [b.id, { ...cur, on: anyOn ? cur.on : true, pct: anyOn ? (cur.on ? pct : cur.pct) : pct }];
        })
      );
    });
  }

  // "One unlock for all" quick-fill — the unlock-% twin of applyRateToAll. Sets every ticked building's
  // per-building unlock threshold to the same value (turns all on if none ticked yet). The agreement-wide
  // "minimum deposit %" (tf.minDepositPct) remains the FALLBACK for any row the developer leaves blank.
  function applyUnlockToAll(unlock: string) {
    setClauses((p) => {
      const anyOn = (buildings ?? []).some((b) => p[b.id]?.on);
      return Object.fromEntries(
        (buildings ?? []).map((b) => {
          const cur = p[b.id] ?? { on: false, pct: DEFAULT_PCT, unlock: DEFAULT_UNLOCK };
          return [b.id, { ...cur, on: anyOn ? cur.on : true, unlock: anyOn ? (cur.on ? unlock : cur.unlock) : unlock }];
        })
      );
    });
  }

  async function submit() {
    if (!buildings) return;
    if (isOffer && !picked) {
      setErr("Pick an agency to offer these terms to.");
      return;
    }
    //  §3 — seal each building's PER-BUILDING `unlockPct`: the % of the price the developer must have
    // received before the agency's commission on THAT building is payable, read by the payable gate
    // (lib/payment-ledger). Precedence: the per-building unlock input wins; a row left BLANK inherits the
    // agreement-wide "minimum deposit %" (tf.minDepositPct) so the free-text terms line and the sealed field
    // never disagree for the default case. `unlockOnSigning: true` because the agency unlock is a
    // signed-S&P-AND-paid-% gate and the terms line already says "when the buyer signs AND…".
    // Neither a valid per-row nor a valid fallback % → omit the field (legacy read-time fallback = deposit%,
    // same meaning); never seal a nonsense threshold.
    const toPct = (v: string): number | undefined => {
      const n = Number(v);
      return v.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
    };
    const fallbackUnlock = toPct(tf.minDepositPct);
    const pickedBuildings = selected.map((b) => {
      const unlockPct = toPct(clauses[b.id]?.unlock ?? "") ?? fallbackUnlock;
      return {
        buildingId: b.id,
        commissionPct: Number(clauses[b.id]?.pct),
        scope: "whole" as const,
        ...(unlockPct !== undefined ? { unlockPct, unlockOnSigning: true } : {}),
      };
    });
    if (pickedBuildings.length === 0) {
      setErr(`Select at least one building to ${isOffer ? "offer" : "publish terms for"}.`);
      return;
    }
    if (pickedBuildings.some((b) => !Number.isFinite(b.commissionPct) || b.commissionPct <= 0 || b.commissionPct > 100)) {
      setErr("Give each selected building a commission % between 0 and 100.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/agreements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Mode 1 OFFER: named agency, by:"developer" → "proposed" (the agency agrees/declines).
          // Mode 2 PUBLISH: EMPTY agency, by:"developer" → "published" (any vetted agency joins).
          seal: {
            agency: isOffer ? picked!.account : "",
            developer: me,
            buildings: pickedBuildings,
            terms: terms.trim(),
            by: "developer",
            proposedAt: Date.now(),
          },
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(typeof j.error === "string" ? j.error : "Could not save the terms.");
        return;
      }
      setTf(DEFAULT_TERM_FIELDS);
      setPicked(null);
      await onDone();
    } catch {
      setErr("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  // ── Mode-1 agency picker gate: choose a counterparty before filling the form ──
  if (isOffer && !picked) {
    return (
      <div style={{ padding: "14px 16px", borderRadius: 8, background: "#0e1119", border: "1px solid #2b3350", margin: "10px 0" }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>Set up an agreement for an agency</div>
        <p style={{ fontSize: 12.5, opacity: 0.7, margin: "4px 0 12px", lineHeight: 1.5 }}>
          Choose a vetted agency, then set the buildings and commission you&apos;re offering them. They review
          it and agree. You still grant them access to your units separately.
        </p>
        {agencies === null && <p style={{ opacity: 0.5, fontSize: 13 }}>Loading vetted agencies…</p>}
        {agencies && agencies.length === 0 && (
          <p style={{ opacity: 0.6, fontSize: 13 }}>No vetted agencies on the platform yet.</p>
        )}
        <div style={{ display: "grid", gap: 8 }}>
          {agencies?.map((a) => (
            <button
              key={a.account}
              type="button"
              onClick={() => setPicked(a)}
              style={{ textAlign: "left", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.bg, cursor: "pointer", color: "inherit" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{a.legalName}</span>
                {a.gated && (
                  <span style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 999, background: "rgba(95,224,168,0.12)", border: "1px solid rgba(95,224,168,0.35)", color: "#5fe0a8" }}>
                    already have access
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>
                {a.region} · <code style={{ ...mono, fontSize: 11 }}>{a.account}</code>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Mode-1 existing-agreement GUARD — never let the developer set a new % over a live agreement ──
  // Checking the picked agency: show a spinner; then if a live (agreed/proposed) agreement already exists,
  // SHOW it and block new terms (a signed agreement is durable — changing it goes through the mutual
  // end/termination process, not a silent re-offer; a pending proposal is just awaiting their response).
  if (isOffer && picked && existing === null) {
    return (
      <div style={{ padding: "14px 16px", borderRadius: 8, background: "#0e1119", border: "1px solid #2b3350", margin: "10px 0" }}>
        <p style={{ opacity: 0.6, fontSize: 13 }}>Checking your agreements with {picked.legalName}…</p>
      </div>
    );
  }
  if (isOffer && picked && existing && existing.length > 0) {
    const agreed = existing.filter((g) => g.status === "agreed");
    const proposed = existing.filter((g) => g.status === "proposed");
    return (
      <div style={{ padding: "14px 16px", borderRadius: 8, background: "#0e1119", border: "1px solid #2b3350", margin: "10px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>You already have terms with {picked.legalName}</div>
          <button type="button" onClick={() => setPicked(null)} style={{ ...submitBtn, padding: "3px 10px", fontSize: 12, background: T.panel2, color: T.dim }}>Change agency</button>
        </div>
        <p style={{ fontSize: 12.5, opacity: 0.75, margin: "4px 0 12px", lineHeight: 1.5 }}>
          {agreed.length > 0
            ? "A signed agreement is a durable commitment — you can’t set new terms over it here. To change a rate, end the current agreement first (both parties must agree), then set up a new one. To stop working with this agency going forward without touching past deals, withdraw their building access instead."
            : "You’ve already offered terms to this agency and they haven’t responded yet. Wait for them to agree or decline before offering again."}
        </p>
        {existing.map((g) => (
          <div key={g.id} style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.bg2, marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <span style={{ fontSize: 11.5, padding: "1px 8px", borderRadius: 999, color: g.status === "agreed" ? T.vetted : T.hold, background: g.status === "agreed" ? "rgba(95,224,168,0.1)" : "rgba(224,170,60,0.1)", border: `1px solid ${g.status === "agreed" ? "rgba(95,224,168,0.35)" : "rgba(224,170,60,0.35)"}` }}>
                ● {g.status === "agreed" ? "Signed" : "Proposed — awaiting reply"}
              </span>
              {g.verified && <span style={{ ...seal, fontSize: 10 }} title="Terms + identities match the seal — unaltered.">✓ Vetted<SealedMark /></span>}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              {g.seal.buildings.map((b) => (
                <div key={b.buildingId}>
                  <b>{b.commissionPct}%</b><PrivateMark /> on {b.buildingId}{b.scope === "whole" ? " (whole building)" : ` (${b.scope.units.length} units)`}
                </div>
              ))}
            </div>
            {g.seal.terms && <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.55, whiteSpace: "pre-wrap", opacity: 0.85 }}>{prettyTerms(g.seal.terms)}<PrivateMark /></div>}
            <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>
              <Link
                href={`/node?section=agreements&focus=${encodeURIComponent(g.id)}`}
                style={{ color: T.accent, textDecoration: "none" }}
              >
                Manage this agreement under “Commission agreements” →
              </Link>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 16px", borderRadius: 8, background: "#0e1119", border: "1px solid #2b3350", margin: "10px 0" }}>
      {isOffer ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Terms for {picked!.legalName}</div>
            <button type="button" onClick={() => setPicked(null)} style={{ ...submitBtn, padding: "3px 10px", fontSize: 12, background: T.panel2, color: T.dim }}>Change agency</button>
          </div>
          <p style={{ fontSize: 12.5, opacity: 0.7, margin: "0 0 12px", lineHeight: 1.5 }}>
            Set a commission rate for each building you&apos;re offering this agency. They review and agree;
            you still grant access to your units separately.
          </p>
        </>
      ) : (
        <>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>Publish standing commission terms</div>
          <p style={{ fontSize: 12.5, opacity: 0.7, margin: "4px 0 12px", lineHeight: 1.5 }}>
            Set a commission rate for each building you want to offer. Any vetted agency can see and join these
            terms as-is. Joining sets the commission only — you still grant each agency access to your units
            separately.
          </p>
        </>
      )}

      {/* ── Loading skeleton ── */}
      {buildings === null && (
        <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="vrx-working" style={{ height: 42, borderRadius: 7, background: "#151b28", border: "1px solid #1c2434" }} />
          ))}
        </div>
      )}

      {/* ── Load failed / empty: offer a retry rather than a silent empty form ── */}
      {buildings && buildings.length === 0 && (
        <div style={{ ...banner, fontSize: 13, borderColor: "#6b5426", background: "#241d0e", marginBottom: 10 }}>
          {loadErr ? "Couldn't load your buildings — the network may be busy." : "You have no buildings in your catalog yet."}
          {loadErr && (
            <button type="button" onClick={() => void loadBuildings()} style={{ ...submitBtn, marginLeft: 10, padding: "4px 12px", fontSize: 12.5, background: "#18202f", color: "#c7cde0" }}>
              Retry
            </button>
          )}
        </div>
      )}

      {/* ── The structured per-building table ── */}
      {!!buildings?.length && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, opacity: 0.85, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={allOn}
                ref={(el) => { if (el) el.indeterminate = selected.length > 0 && !allOn; }}
                onChange={(e) => {
                  const on = e.target.checked;
                  setClauses((p) => Object.fromEntries((buildings ?? []).map((b) => [b.id, { ...(p[b.id] ?? { pct: DEFAULT_PCT, unlock: DEFAULT_UNLOCK }), on }])));
                }}
              />
              Select all {buildings.length} buildings
            </label>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, opacity: 0.6 }}>One rate for all:</span>
                <input
                  inputMode="decimal"
                  placeholder="%"
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.]/g, "");
                    if (v) applyRateToAll(v);
                  }}
                  style={{ ...input, width: 70, margin: 0, padding: "5px 8px" }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, opacity: 0.6 }}>One unlock for all:</span>
                <input
                  inputMode="decimal"
                  placeholder="%"
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.]/g, "");
                    if (v) applyUnlockToAll(v);
                  }}
                  style={{ ...input, width: 70, margin: 0, padding: "5px 8px" }}
                />
              </div>
            </div>
          </div>

          {/* Column header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 2px 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6, borderBottom: "1px solid #1c2434" }}>
            <span style={{ width: 18 }} />
            <span style={{ flex: 1 }}>Building</span>
            <span style={{ width: 110, textAlign: "right" }}>Commission</span>
            <span style={{ width: 110, textAlign: "right" }}>Unlock</span>
          </div>

          <div style={{ display: "grid", gap: 0, marginBottom: 12 }}>
            {buildings.map((b) => {
              const c = clauses[b.id] ?? { on: false, pct: DEFAULT_PCT, unlock: DEFAULT_UNLOCK };
              return (
                <div
                  key={b.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 2px",
                    borderBottom: "1px solid #161c28",
                    opacity: c.on ? 1 : 0.72,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={c.on}
                    onChange={(e) => setClause(b.id, { on: e.target.checked })}
                    style={{ width: 18 }}
                  />
                  <label style={{ flex: 1, cursor: "pointer" }} onClick={() => setClause(b.id, { on: !c.on })}>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>{b.name}</div>
                    <div style={{ fontSize: 11.5, opacity: 0.55 }}>
                      {b.type} · {b.units} units · whole building
                    </div>
                    {/* soft terms-envelope flag: when this building has a band and the entered rate is
                        outside it, surface a gentle note. SOFT: it never disables submit (sealed terms are
                        frozen; the band only guides). Only shown for an ON building with a parseable rate. */}
                    {c.on && (() => {
                      const edge = checkEnvelope(Number(c.pct), b.termsEnvelope);
                      if (!edge) return null;
                      const band = envelopeLabel(b.termsEnvelope);
                      return (
                        <div style={{ fontSize: 11, color: "#e8c97f", marginTop: 3 }}>
                          ⚠ {edge === "below" ? "Below" : "Above"} your acceptable band{band ? ` (${band})` : ""} — you can still proceed.
                        </div>
                      );
                    })()}
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, width: 110, justifyContent: "flex-end" }}>
                    <input
                      value={c.pct}
                      disabled={!c.on}
                      onChange={(e) => setClause(b.id, { pct: e.target.value.replace(/[^\d.]/g, "") })}
                      inputMode="decimal"
                      style={{ ...input, width: 70, margin: 0, padding: "6px 8px", textAlign: "right", opacity: c.on ? 1 : 0.35 }}
                    />
                    <span style={{ fontSize: 13, opacity: c.on ? 0.7 : 0.3 }}>%</span>
                  </div>
                  {/*  §3 — this building's UNLOCK threshold. Blank → inherits the agreement-wide minimum
                      deposit % below (placeholder shows the fallback so the developer sees what will be sealed). */}
                  <div style={{ display: "flex", alignItems: "center", gap: 4, width: 110, justifyContent: "flex-end" }}>
                    <input
                      value={c.unlock}
                      disabled={!c.on}
                      placeholder={tf.minDepositPct || "—"}
                      onChange={(e) => setClause(b.id, { unlock: e.target.value.replace(/[^\d.]/g, "") })}
                      inputMode="decimal"
                      title="% of the price the buyer must have paid before your commission to the agency on this building is payable. Leave blank to use the minimum deposit % below."
                      style={{ ...input, width: 70, margin: 0, padding: "6px 8px", textAlign: "right", opacity: c.on ? 1 : 0.35 }}
                    />
                    <span style={{ fontSize: 13, opacity: c.on ? 0.7 : 0.3 }}>%</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected summary — see exactly what you're about to offer/publish */}
          <div style={{ fontSize: 12.5, marginBottom: 10, minHeight: 18 }}>
            {selected.length === 0 ? (
              <span style={{ opacity: 0.6 }}>No buildings selected yet.</span>
            ) : (
              <span style={{ opacity: 0.85 }}>
                {isOffer ? "Offering" : "Publishing"} <b>{selected.length}</b> building{selected.length === 1 ? "" : "s"}:{" "}
                {selected
                  .map((b) => {
                    const u = (clauses[b.id]?.unlock || "").trim() || (tf.minDepositPct || "").trim();
                    return `${b.name} ${clauses[b.id]?.pct || "—"}%${u ? ` (unlock ${u}%)` : ""}`;
                  })
                  .join(" · ")}
              </span>
            )}
          </div>

          <label style={lbl}>Terms <span style={{ opacity: 0.6 }}>— set each one; the preview below is exactly what the agency sees</span></label>

          {/* ── Structured term fields — each term its own input, so the developer considers each ── */}
          <div style={{ display: "grid", gap: 10, padding: "12px 14px", borderRadius: 8, background: "#0b0e16", border: "1px solid #222a3d", marginBottom: 10 }}>
            {/* 1. Payment trigger + minimum deposit % */}
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>When commission is paid</div>
              <div style={{ fontSize: 12.5, opacity: 0.8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", lineHeight: 1.5 }}>
                On signed contract, once the developer has received a minimum deposit of
                <input
                  value={tf.minDepositPct}
                  onChange={(e) => setTf((p) => ({ ...p, minDepositPct: e.target.value.replace(/[^\d.]/g, "") }))}
                  inputMode="decimal"
                  style={{ ...input, width: 56, margin: 0, padding: "4px 7px", textAlign: "right" }}
                />
                % of the price.
              </div>
              <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 4, lineHeight: 1.5 }}>
                This is the default unlock threshold. A building with its own <b>Unlock %</b> set in the table above
                uses that instead; buildings left blank use this.
              </div>
            </div>

            {/* 2. Exclusivity — stated non-exclusive; true exclusivity is the separate on-chain hold.
                Same for both modes: a commission agreement doesn't lock units (that's a hold), so the honest
                default is non-exclusive, with a pointer to the real tool. */}
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Exclusivity</div>
              <div style={{ fontSize: 12.5, opacity: 0.8, lineHeight: 1.5 }}>
                <b>Non-exclusive</b> — {isOffer ? "these commission terms don't lock units to this agency; others may also sell them." : "published terms are open for any vetted agency to join."}
                <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 3 }}>
                  Need to give one agency sole rights that block all others? Use <b>“Reserve exclusively for
                  one agency”</b> above — that&apos;s an on-chain hold, separate from these commission terms.
                </div>
              </div>
            </div>

            {/* 3. Duration + auto-renew (ending policy is fixed) */}
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Duration &amp; ending</div>
              <div style={{ fontSize: 12.5, opacity: 0.8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", lineHeight: 1.5 }}>
                <input
                  value={tf.durationMonths}
                  onChange={(e) => setTf((p) => ({ ...p, durationMonths: e.target.value.replace(/[^\d]/g, "") }))}
                  inputMode="numeric"
                  style={{ ...input, width: 52, margin: 0, padding: "4px 7px", textAlign: "right" }}
                />
                months
                <label style={{ display: "inline-flex", alignItems: "center", gap: 5, marginLeft: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={tf.autoRenew} onChange={(e) => setTf((p) => ({ ...p, autoRenew: e.target.checked }))} />
                  auto-renew
                </label>
              </div>
              <div style={{ fontSize: 11.5, opacity: 0.65, marginTop: 3, lineHeight: 1.5 }}>
                Ending needs a request + personal follow-up and both parties&apos; agreement — a signed
                agreement can&apos;t be cancelled one-sidedly.
              </div>
            </div>

            {/* 4. Commission basis (editable — phrasing varies by developer) */}
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Commission is calculated on</div>
              <input
                value={tf.commissionBasis}
                onChange={(e) => setTf((p) => ({ ...p, commissionBasis: e.target.value }))}
                placeholder="the net sale price, excluding taxes and transfer fees"
                style={{ ...input, margin: 0, fontSize: 12.5 }}
              />
            </div>

            {/* Additional notes — anything the structure doesn't cover */}
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>Additional notes <span style={{ opacity: 0.6, fontWeight: 400 }}>— optional</span></div>
              <textarea
                value={tf.notes}
                onChange={(e) => setTf((p) => ({ ...p, notes: e.target.value }))}
                rows={2}
                placeholder="Anything else the agency should know about these terms."
                style={{ ...input, margin: 0, fontFamily: "inherit", resize: "vertical", fontSize: 12.5 }}
              />
            </div>
          </div>

          {/* ── Live preview — the exact sealed terms text the agency will see ── */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6, marginBottom: 5 }}>
              Preview — what the agency sees
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap", padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.border}`, opacity: 0.92 }}>
              {terms}
            </div>
          </div>
          {err && <div style={{ ...banner, fontSize: 12.5, borderColor: "#7a2b2b", background: "#241010", margin: "0 0 10px" }}>{err}</div>}
          <button type="button" onClick={submit} disabled={busy || selected.length === 0} style={submitBtn}>
            {busy
              ? isOffer ? "Offering…" : "Publishing…"
              : isOffer
                ? selected.length > 0 ? `Offer ${selected.length} building${selected.length === 1 ? "" : "s"} to ${picked!.legalName}` : "Offer to agency"
                : selected.length > 0 ? `Publish ${selected.length} building${selected.length === 1 ? "" : "s"}` : "Publish terms"}
          </button>
          <p style={{ fontSize: 11, opacity: 0.6, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
            {isOffer
              ? "The terms are sealed when you offer them. To change a rate, offer a new agreement — an agreement the agency has already agreed to keeps the rate it was agreed at."
              : "Published terms are sealed at publication. To change a rate, publish new terms — an agreement an agency has already joined keeps the rate it was joined at."}
          </p>
        </>
      )}
    </div>
  );
}

// The written agency-agreement CONTRACT view/print modal is now the shared component
// `components/ContractModal` — both /node and /agency render the identical document from the same pure
// generator (lib/contract.ts). Imported at the top of this file.

function DeveloperAgreementRow({ g, me, onChanged, highlight }: { g: AgreementRecord; me: string; onChanged: () => void | Promise<void>; highlight?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [showContract, setShowContract] = useState(false);
  // Deep-link target: scroll this row into view when it's the focused agreement.
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlight) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight]);
  const proposerIsAgency = g.seal.by === "agency";
  // The developer responds to a proposal the AGENCY made (the common case).
  const canRespond = g.status === "proposed" && proposerIsAgency;
  // Ending an agreed agreement is MUTUAL: a signed agreement protects the agency's commission on deals
  // already done, so the developer can NOT revoke it alone. To stop working with an agency going forward the
  // developer withdraws future-unit EXPOSURE (the access gate, separate from this agreement) — that never
  // touches past deals. Ending the agreement itself takes both parties: one requests, the other confirms.
  const revokePending = !!g.revokeRequestBy;
  const iRequestedEnd = revokePending && g.revokeRequestBy?.toLowerCase() === me.toLowerCase();
  const canRequestEnd = g.status === "agreed" && !revokePending;
  const canConfirmEnd = g.status === "agreed" && revokePending && !iRequestedEnd;
  // A published agreement has no agency yet — it's a standing offer awaiting a vetted agency to join.
  const isPublished = g.status === "published";
  const statusColorOf = (s: string) => (s === "agreed" ? T.vetted : s === "proposed" || s === "published" ? T.hold : s === "declined" || s === "revoked" ? T.danger : T.dim);

  async function move(status: "agreed" | "declined") {
    setBusy(true);
    try {
      await fetch("/api/agreements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: g.id, status, by: me }),
      });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function requestEnd() {
    setBusy(true);
    try {
      await fetch("/api/agreements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revoke: g.id, by: me }),
      });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={rowRef}
      style={{
        // Self-contained CARD: full border + own surface so it reads as a tile in the agreements
        // grid (not the old top-divider row). Text wraps inside the fixed-width cell.
        border: `1px solid ${T.borderSoft}`,
        background: highlight ? "rgba(61,125,255,0.07)" : "#0e1119",
        padding: "14px 14px",
        borderRadius: 10,
        transition: "box-shadow 0.3s ease, background 0.3s ease",
        boxShadow: highlight ? `inset 0 0 0 2px ${T.accent}` : undefined,
        minWidth: 0,
      }}
    >
      {/* Card body = a VERTICAL stack: header → clauses → terms → status, then the actions row
          at the BOTTOM full-width. (The old left/right split collapsed badly in a narrow grid cell — buttons
          jumped up next to the title.) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* Agency NAME is the card's identity — bold + primary. A published card has no agency
                yet, so it reads "Open terms". The building COUNT moves to a small pill with a hover list. */}
            {isPublished ? (
              <b style={{ fontSize: 15 }}>Open terms</b>
            ) : (
              <b style={{ fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                {g.seal.agencyIdentity?.legalName || g.seal.agency}<PrivateMark />
              </b>
            )}
            {/* "× build." pill — hover lists the buildings this agreement covers. */}
            <span
              title={g.seal.buildings.map((b) => prettyBuildingId(b.buildingId)).join("\n")}
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: T.panel2,
                border: `1px solid ${T.border}`,
                color: T.dim,
                cursor: "help",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {g.seal.buildings.length} build.
            </span>
            {g.verified ? (
              <span style={{ ...seal, fontSize: 10 }} title="The signed terms AND the vetted identities both match the seal — unaltered.">✓ Vetted<SealedMark /></span>
            ) : (
              <span style={{ ...seal, fontSize: 10, color: T.danger, background: "rgba(255,107,107,0.10)", border: "1px solid rgba(255,107,107,0.4)" }} title="Does not match the signed seal.">⚠ Mismatch</span>
            )}
          </div>
          {isPublished && <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 2 }}>open to any vetted agency</div>}
          <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
            {g.seal.buildings.map((b) => (
              <div key={b.buildingId}>
                <b>{b.commissionPct}%</b><PrivateMark /> on {prettyBuildingId(b.buildingId)}
                {b.scope === "whole" ? " (whole building)" : ` (${b.scope.units.length} units — non-exclusive)`}
              </div>
            ))}
          </div>
          {g.seal.terms && <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap", opacity: 0.85 }}>{prettyTerms(g.seal.terms)}<PrivateMark /></div>}
          <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 4 }}>
            <span style={{ color: statusColorOf(g.status) }}>● {g.status}</span>
            {!isPublished && <> · proposed by {g.seal.by}</>} · {timeAgo(g.at)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
          <button type="button" onClick={() => setShowContract(true)} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }} title="Read the full written agreement and print or save it as a PDF.">View contract</button>
          {isPublished && <span style={{ fontSize: 12, opacity: 0.55 }}>Awaiting an agency to join</span>}
          {canRespond && (
            <>
              <button type="button" disabled={busy} onClick={() => move("agreed")} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#1c5e2a" }}>Agree</button>
              <button type="button" disabled={busy} onClick={() => move("declined")} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#5e1c1c" }}>Decline</button>
            </>
          )}
          {g.status === "proposed" && !canRespond && <span style={{ fontSize: 12, opacity: 0.55 }}>Awaiting the other party</span>}
          {canRequestEnd && (
            <button type="button" disabled={busy} onClick={requestEnd} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#3a2416", color: "#e0b88a" }} title="A signed agreement protects commission the agency already earned. Ending it needs both parties. To stop future business without affecting past deals, withdraw the agency's access to new units instead.">Request to end</button>
          )}
          {canConfirmEnd && (
            <button type="button" disabled={busy} onClick={requestEnd} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#5e1c1c" }} title="The agency asked to end this agreement. Confirm to end it by mutual consent.">Confirm ending</button>
          )}
          {iRequestedEnd && <span style={{ fontSize: 12, opacity: 0.55 }}>End requested — awaiting the agency</span>}
        </div>
      </div>
      {showContract && <ContractModal g={g} onClose={() => setShowContract(false)} />}
    </div>
  );
}

function writeErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NOT_NODE|E\d*.*node/i.test(msg)) return "This account isn't set up as a developer.";
  if (msg.includes("E23") || /NODE_MISMATCH/i.test(msg)) return "Only this unit's developer can reply to or confirm this request.";
  if (/TILE_NOT_OPEN/i.test(msg)) return "That unit is no longer available (already reserved or sold).";
  if (/E57|deposit/i.test(msg)) return "Couldn't complete — please try again.";
  if (/rejected|cancell?ed|user closed|denied/i.test(msg)) return "Request cancelled.";
  return "Something went wrong. Please try again.";
}
