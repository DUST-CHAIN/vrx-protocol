"use client";

// DIRECT-BUYER surface (§9 step 4, first buyer UI). The "walk-in" funnel's front door: a logged-in
// direct buyer browses ONLY direct-sale-visible buildings, projected to photos + description + unit count +
// price range (lib/buyer-catalog, the fail-closed server projection — this page NEVER sees per-unit data).
//
// WHY A STANDALONE ROUTE, NOT A ROLE (three-gates check): buyer access is a STATE not a role (§3,
// lib/buyers-direct) — a direct buyer is a walk-in, NOT a vetted/provisioned actor, so it must NOT go through
// useRole/navFor (it would classify as "unregistered"). Any connected wallet can reach /buyer; what it may
// SEE is governed server-side by directSale.visible + the buyer's funnel state, not by a role grant.
//
// the wallet is READ only (accountId) — saving a profile signs nothing, touches no chain. The deposit
// rail that offer-eligibility unlocks is the deferred signing arc (§7, step 9).
//
// ANTI-BROWSING FUNNEL (§3): this page is deliberately LOSSY. It shows enough to interest a buyer
// (photos, amenities, a price band, a count) and then points them at the desk — it never exposes individual
// units, exact prices, availability or floor plans. The operator opens specific units later, in conversation
// (steps 3–5, not built on this surface yet). So the primary call-to-action is "Talk to the desk", not "Buy".

import { useCallback, useEffect, useRef, useState } from "react";
import Carousel from "@/components/Carousel";
import ImagePlaceholder from "@/components/ImagePlaceholder";
import Lightbox from "@/components/Lightbox";
import BuyerPaymentPanel from "@/components/BuyerPaymentPanel";
import ReconciliationPanel from "@/components/ReconciliationPanel";
import CallOffControl from "@/components/CallOffControl";
import EscalateControl from "@/components/EscalateControl";
import SaleContractButton from "@/components/SaleContractButton";
import PurchasesTray from "@/components/PurchasesTray";
import PaymentOptionPicker from "@/components/PaymentOptionPicker";
import PaymentCalculator, { type AssembledPlan } from "@/components/PaymentCalculator";
import AskTermsControl from "@/components/AskTermsControl";
import VrxBalanceChip from "@/components/VrxBalanceChip";
import { evaluateOffer, type OfferVerdict } from "@/lib/offer-evaluate";
import type { Building, Unit, PaymentTerms } from "@/lib/catalog-client";
import type { ActionButton, DeskAction } from "@/lib/ai-desk/types";
import { useWallet } from "@/lib/wallet";
import { useEventStream } from "@/lib/useEventStream";
import { useNotifier } from "@/lib/useNotifier";
import { channelTopic } from "@/lib/channel-topic";
import { grantTopic } from "@/lib/grant-topic";
import { card, lbl, input, submitBtn, banner } from "@/lib/ui";
import { T, seal } from "@/lib/theme";
import { OPEN_BUYER_PROFILE_EVENT, type OpenBuyerProfileDetail } from "@/lib/buyer-profile-event";

// Reserve-from-card intent + the composed offer. `plan` is the payment plan the buyer DESIGNED
// the review overlay (within the dev's caps); when present it rides the reserve deep-link into the desk chat so
// the deposit/seal reflect what the buyer actually set, not a fixed template. Absent → the proven template path.
type ReserveIntent = { building: string; unit: string; label: string; plan?: AssembledPlan };

// ── The buyer-projected building shape (mirror of lib/buyer-catalog.BuyerBuildingView — the ONLY fields a
//    buyer surface ever receives). Kept local so this client file doesn't import the server module. ──
type BuyerBuildingView = {
  id: string;
  name: string;
  tagline: string;
  area: string;
  address: string;
  type: string;
  completion: string;
  amenities: string[];
  funnelCopy?: string;
  unitCount: number;
  priceRange: { minUsd: number; maxUsd: number } | null;
  photos: { exterior: string[]; interior: string[]; facilities: string[] };
};

type BuyerProfile = {
  name: string;
  legalName?: string;
  nationality?: string;
  phone?: string;
  email?: string;
  passportNo?: string;
  idCardNo?: string;
  address?: string;
};

// The per-field visibility mode the buyer dials. Mirrors lib/buyer-mask MaskMode.
type VisMode = "show" | "partial" | "hide";

type BuyerRecord = {
  account: string;
  profile: BuyerProfile;
  // the buyer's OWN visibility dial — what a desk sees of each field up-front. Self-read only (never on
  // the desk route). Absent/empty = the fully-masked default. Keys are BuyerProfile field names.
  maskOverride?: Partial<Record<string, VisMode>>;
  funnel: "new" | "in_conversation" | "units_opened" | "offer_eligible";
  profileSaved: boolean;
  sealed?: boolean;
  sealedAt?: number;
  historyCount?: number;
};

// Per-developer readiness summary from /api/buyers-direct (Phase 2). `perDev` is scoped to the buyer's
// OPENED developers only — [] (and allMet=true) for a fresh buyer, so the nudge never fires before the desk
// has engaged. The client never sees required-field config; the server resolves met/missing per developer.
type DevReadiness = { developer: string; developerName: string; met: boolean; missing: string[] };
type ReadinessSummary = { sealed: boolean; perDev: DevReadiness[]; allMet: boolean };

// The in-context profile-view focus request (red-card deep-link): which fields to highlight, for which dev.
type ProfileFocus = OpenBuyerProfileDetail;

// Human labels for profile field KEYS (the server returns keys; the UI labels them). Single source so the
// nudge, the red-card popup and the editor all agree. Mirrors PROFILE_FIELDS below.
const FIELD_LABEL: Record<string, string> = {
  name: "Display name",
  legalName: "Full legal name",
  nationality: "Nationality",
  phone: "Phone",
  email: "Email",
  passportNo: "Passport no.",
  idCardNo: "National ID no.",
  address: "Residential address",
};
const labelFields = (keys: string[]): string => keys.map((k) => FIELD_LABEL[k] ?? k).join(", ");

const FUNNEL_COPY: Record<BuyerRecord["funnel"], { label: string; note: string }> = {
  new: {
    label: "Browsing",
    note: "You can browse our listed developments below. To see specific units, availability and prices, start a conversation with our sales desk.",
  },
  in_conversation: {
    label: "In conversation with the desk",
    note: "Our desk is reviewing your enquiry. Once they open specific units to you, they'll appear here.",
  },
  units_opened: {
    label: "Units opened to you",
    note: "The desk has opened specific units for you to consider. Complete your profile below to be able to make an offer.",
  },
  offer_eligible: {
    label: "Ready to make an offer",
    note: "Your profile is complete and you're cleared to make an offer on the units opened to you.",
  },
};

// The top strip must tell the buyer the SAME truth the unit cards + profile chip do (F1): "cleared to
// make an offer" only once the profile is actually SEALED (and every opened developer's fields are met) — the
// `funnel` stage alone reached `offer_eligible` on profile COMPLETENESS, which over-claimed while still
// unsealed (the card said "verification needed", the chip said "ready to seal"). readinessCleared is the one
// predicate all three now read; when the funnel is offer_eligible but we're not cleared, show "almost there".
function readinessCleared(readiness: ReadinessSummary | null): boolean {
  // No readiness payload yet (fresh/browse, or still loading) → don't contradict the funnel; defer to it.
  if (!readiness) return true;
  // `allMet` IS the canonical offer-gate predicate (lib/buyers-direct.readinessAcross): sealed AND every
  // opened developer's required fields met. Reusing it here is exactly "one source of truth" — the strip,
  // the unit card, and the profile seal gate all answer "can this buyer offer yet?" the same way.
  return readiness.allMet;
}
function stripCopy(
  funnel: BuyerRecord["funnel"],
  readiness: ReadinessSummary | null
): { label: string; note: string } {
  if (funnel === "offer_eligible" && !readinessCleared(readiness)) {
    // Mirror the card/chip: the gating step is the seal (details are complete but not yet locked).
    return {
      label: "Almost ready — seal your profile",
      note: "Your details are complete. Seal your profile below to lock it and become cleared to make an offer on the units opened to you.",
    };
  }
  return FUNNEL_COPY[funnel];
}

export default function BuyerHome() {
  const { accountId, ready, signIn, signOut } = useWallet();

  // DEV-ONLY test override (?account=<id>): view a seeded buyer's surface WITHOUT connecting a wallet — the
  // same posture as the `?viewer=` dev affordances elsewhere. HARD-gated to non-production so it can NEVER be
  // an auth bypass in a deployed build (process.env.NODE_ENV is inlined at build time). Does nothing in prod.
  // Read AFTER mount (useEffect) so SSR and first client render agree (window-based reads during render would
  // hydration-mismatch); it flips in a second render on the client, which is exactly what a dev affordance wants.
  const [devAccount, setDevAccount] = useState<string | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      setDevAccount(new URLSearchParams(window.location.search).get("account")?.trim() || null);
    }
  }, []);
  const effectiveAccount = devAccount || accountId;

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "40px 20px" }}>
      <span style={seal}>✓ Vetted developments</span>
      <h1 style={{ fontSize: 30, margin: "12px 0 4px", letterSpacing: -0.5 }}>Find your home.</h1>
      <p style={{ opacity: 0.75, marginTop: 6, fontSize: 15.5, lineHeight: 1.55, maxWidth: 680 }}>
        Browse a curated selection of completed and upcoming developments. When something catches your eye,
        talk to the sales desk — they&apos;ll walk you through available units, prices and the next steps,
        privately.
      </p>

      {devAccount && (
        <div style={{ marginTop: 16, padding: "6px 12px", borderRadius: 8, border: "1px dashed #5a4a2a", color: "#e0c67c", fontSize: 12.5 }}>
          Dev preview — viewing as <code>{devAccount}</code> (no wallet connected). Works in dev only.
        </div>
      )}

      {!devAccount && !ready && <p style={{ opacity: 0.6, marginTop: 28 }}>Starting wallet…</p>}

      {!devAccount && ready && !accountId && (
        <section style={{ ...card, marginTop: 24 }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Sign in to browse</h2>
          <p style={{ opacity: 0.75, fontSize: 15 }}>
            Connect a wallet to browse our listed developments and talk to the sales desk. Your details stay
            private — nothing is shared until you choose to.
          </p>
          <button onClick={signIn} style={submitBtn}>Connect wallet</button>
        </section>
      )}

      {effectiveAccount && (ready || devAccount) && <BuyerApp account={effectiveAccount} signOut={signOut} />}
    </main>
  );
}

function BuyerApp({ account, signOut }: { account: string; signOut: () => Promise<void> }) {
  const [buildings, setBuildings] = useState<BuyerBuildingView[] | null>(null);
  const [record, setRecord] = useState<BuyerRecord | null>(null);
  const [kycMet, setKycMet] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // THREE view states: browse (catalog), building (detail swap), profile (full-width editor).
  // `selected` holds the building when view==="building"; `focus` carries a deep-link request into profile.
  const [view, setView] = useState<"browse" | "building" | "profile">("browse");
  const [selected, setSelected] = useState<BuyerBuildingView | null>(null);
  const [focus, setFocus] = useState<ProfileFocus>({});
  // Reserve-from-card deep-link: a cleared buyer hits "Reserve this unit" on an opened-unit card → we
  // navigate to that building's detail view and hand the unit to DeskChat, which auto-opens pre-seeded on it so
  // the PROVEN AI hold flow runs (no separate reserve logic — the card is a shortcut INTO the working chat buy).
  const [reserveIntent, setReserveIntent] = useState<ReserveIntent | null>(null);

  const loadRecord = useCallback(async () => {
    try {
      const j = await fetch(`/api/buyers-direct?account=${encodeURIComponent(account)}`).then((r) => r.json());
      setRecord(j.buyer ?? null);
      setKycMet(!!j.kycPrecondition);
      setReadiness(j.readiness ?? null);
    } catch {
      /* leave as-is */
    }
  }, [account]);

  useEffect(() => {
    fetch("/api/catalog/buyer")
      .then((r) => r.json())
      .then((j) => setBuildings(j.buildings ?? []))
      .catch(() => setErr("Could not load developments. Please try again."));
    void loadRecord();
  }, [loadRecord]);

  // The ⚙ launcher (global SettingsMenu) and the red-card popup both open the profile view via this event.
  const openProfile = useCallback((f: ProfileFocus = {}) => {
    setFocus(f);
    setSelected(null);
    setView("profile");
  }, []);

  // Reserve-from-card: resolve the card's building id → its browse view, switch to the building detail,
  // and stash the intent so DeskChat auto-opens on it. If the building isn't in the buyer's browse list (a grant
  // can bypass directSale.visible — §8-3), we can't swap to a detail view we don't have; fall back to just
  // flagging the intent at browse level (DeskChat only renders inside a building, so the common visible-building
  // path is what drives the reserve; the edge is a no-op swap rather than a crash).
  const onReserve = useCallback(
    (building: string, unit: string, label: string, plan?: AssembledPlan) => {
      const bldView = buildings?.find((x) => x.id === building) ?? null;
      setReserveIntent({ building, unit, label, plan });
      if (bldView) {
        setSelected(bldView);
        setView("building");
      }
    },
    [buildings]
  );
  useEffect(() => {
    const onOpen = (e: Event) => openProfile((e as CustomEvent<OpenBuyerProfileDetail>).detail ?? {});
    window.addEventListener(OPEN_BUYER_PROFILE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_BUYER_PROFILE_EVENT, onOpen);
  }, [openProfile]);

  // Live refresh of the readiness summary when the buyer's own record changes (seal/reopen/save push the
  // opaque grantTopic — reuse the same bus the opened-units list uses). Keeps the nudge honest without polling.
  const myTopic = grantTopic(account);
  useEventStream((t) => {
    if (t.topic === myTopic) void loadRecord();
  }, !!account);

  const funnel = record?.funnel ?? "new";
  // The nudge only has something to say once the desk has opened units from ≥1 developer AND the buyer isn't
  // yet ready for all of them. perDev is [] for a fresh walk-in → allMet is true → no nudge. Browsing is never
  // gated by verification: a brand-new buyer sees the full catalog and the invitation, no red, no nag.
  const showNudge = view === "browse" && !!readiness && readiness.perDev.length > 0 && !readiness.allMet;
  // F1: the strip reads the SAME sealed-aware readiness predicate as the unit cards + profile chip, so
  // the three can't contradict (green "cleared" vs amber "ready to seal" vs card "verification needed"). The
  // seal pill is the trust-GREEN; keep it green only when genuinely cleared, else amber (the in-progress hue
  // the profile chip's "Ready to seal" uses) so the COLOUR doesn't over-claim either.
  const strip = stripCopy(funnel, readiness);
  const cleared = funnel !== "offer_eligible" || readinessCleared(readiness);

  return (
    <>
      {/* Account + funnel status strip */}
      <section style={{ ...card, marginTop: 24, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ ...seal, ...(cleared ? {} : { color: "#e0c67c" }) }}>{strip.label}</span>
        <code style={{ fontSize: 13, opacity: 0.55, fontFamily: T.mono }}>{account}</code>
        {/* the buyer's $VRX balance + a tap-through to the full wallet (claim / top-up / send / history).
            This was MISSING on the buyer surface — the self-pay "Pay deposit with $VRX" told buyers to "claim or
            top up your wallet" with no wallet UI to reach. The chip reuses the same /wallet home every role uses. */}
        <VrxBalanceChip me={account} walletHref="/wallet" />
        <button
          onClick={() => void signOut()}
          style={{ marginLeft: "auto", background: "none", border: "none", color: T.faint, fontSize: 13, cursor: "pointer" }}
        >
          Sign out
        </button>
        <p style={{ flexBasis: "100%", margin: "4px 0 0", fontSize: 13.5, opacity: 0.7, lineHeight: 1.5 }}>
          {strip.note}
        </p>
      </section>

      {err && <div style={{ ...banner, borderColor: "#5a2a2a", color: "#e0a0a0", marginTop: 14 }}>{err}</div>}

      {/* F3: buyer-wide alert for a pending desk detail/reveal request — fires on EVERY view (the gap
  hit: browsing, he got no sound/notification/deep-link when the desk asked for detail). */}
      <DeskRequestWatcher account={account} onOpenProfile={openProfile} />

      {showNudge && readiness && <NudgeBanner readiness={readiness} onOpen={() => openProfile({})} />}

      {view === "profile" ? (
        <MyProfileView
          account={account}
          record={record}
          kycMet={kycMet}
          focus={focus}
          onSaved={loadRecord}
          onBack={() => setView("browse")}
        />
      ) : view === "building" && selected ? (
        <>
          <BuildingDetail
            building={selected}
            account={account}
            onBack={() => { setSelected(null); setReserveIntent(null); setView("browse"); }}
            reserveIntent={reserveIntent && reserveIntent.building === selected.id ? reserveIntent : null}
            onReserveConsumed={() => setReserveIntent(null)}
          />
          <OpenedUnits account={account} onFixProfile={openProfile} onReserve={onReserve} />
        </>
      ) : (
        <>
          <CatalogGrid buildings={buildings} onOpen={(b) => { setSelected(b); setView("building"); }} />
          <OpenedUnits account={account} onFixProfile={openProfile} onReserve={onReserve} />
          {/*  Slice B — the consolidated "My purchases" tray (reservations + draft S&P + honest status),
              always available on the browse home. Renders nothing until the buyer has a reservation. */}
          <PurchasesTray account={account} />
          <MyPayments account={account} />
        </>
      )}
    </>
  );
}

// ── My payments (step 6) — the buyer's Rail-B confirm/dispute surface. Lists every offline payment the
//    developer recorded against this buyer across all their deals; the buyer confirms or disputes each,
//    attaches their own slip, and may keep their agent in the loop. Renders nothing until a payment exists
//    (same "don't show an empty funnel section" discipline as OpenedUnits). The shared BuyerPaymentPanel is
//    the SAME component the agent deal-detail mounts as proxy (one build, two mounts). ──────────────────────
// The forward-view line (thread-#1 Thing A) — mirror of the route's BuyerNextDue. One per deal with a next
// payment coming; `dueAt` absent when the plan states no timing (we never show "in X days" we can't honestly
// derive). Amounts are the buyer's OWN money only (no commission, no VRX cut).
type BuyerNextDue = {
  requestId: string;
  unitLabel: string;
  nextDue: { label: string; dueUsd: number; dueAt?: number };
  lateByDays?: number;
};

function MyPayments({ account }: { account: string }) {
  const [has, setHas] = useState(false);
  const [deals, setDeals] = useState<BuyerNextDue[]>([]);

  // Probe once: only render the section if the buyer actually has recorded payments — keeps the pre-booking
  // funnel clean for a fresh walk-in who has no deals yet. The SAME read now also carries the forward
  // next-due view (Thing A), so the nudge needs no extra round-trip.
  useEffect(() => {
    let live = true;
    fetch(`/api/payments?buyer=${encodeURIComponent(account)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        setHas((j.payments ?? []).length > 0);
        setDeals((j.deals ?? []) as BuyerNextDue[]);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [account]);

  if (!has) return null;
  return (
    <section style={{ ...card, marginTop: 20 }}>
      {deals.length > 0 && <NextPaymentNudge deals={deals} />}
      <BuyerPaymentPanel mode="buyer" account={account} heading="My payments" />
      {/* §5b — per-deal reconciliation (buyer self-serve, canLog): record what I sent, independently of what
          the developer logged, and see the two ledgers compared. One per deal the buyer has money moving on
          (`deals` is the same per-deal next-due list already loaded above — no extra round-trip to list them). */}
      {deals.length > 0 && (
        <div style={{ marginTop: 16, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 12 }}>
          {deals.map((d) => (
            <div key={d.requestId} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>{d.unitLabel}</div>
              <ReconciliationPanel requestId={d.requestId} viewer={account} canLog heading="Reconcile payments" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Next-payment nudge (thread-#1 Thing A) — passive "your next payment is due in X days", straight off the
//    sealed plan's schedule (lib/payment-ledger.nextDue, computed server-side). Read-only: no action, no new
//    store, no auth. DELIBERATELY SOFT + HONEST: it says "indicative, per your agreement" and never states a
//    figure as a demand — the signed §Payments / §Default-and-Termination clauses are the authority, this is
//    a courtesy reminder. When the plan states no timing we show the amount WITHOUT a date (we never guess a
//    date). An overdue line reads in the danger tone; an upcoming one in the calm hold tone. ─────────────────
function NextPaymentNudge({ deals }: { deals: BuyerNextDue[] }) {
  const DAY_MS = 86_400_000;
  const now = Date.now();
  const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const fmtDate = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      {deals.map((d) => {
        const { dueAt, dueUsd, label } = d.nextDue;
        const overdue = (d.lateByDays ?? 0) > 0;
        const daysUntil = dueAt !== undefined ? Math.ceil((dueAt - now) / DAY_MS) : undefined;
        const tone = overdue ? T.danger : T.hold;
        // The time phrase — honest about what we do and don't know.
        let when: string;
        if (overdue) {
          when = `overdue by ${d.lateByDays} day${d.lateByDays === 1 ? "" : "s"}`;
        } else if (daysUntil === undefined) {
          when = "scheduled — your agreement states no fixed date";
        } else if (daysUntil <= 0) {
          when = "due today";
        } else if (daysUntil === 1) {
          when = "due tomorrow";
        } else {
          when = `due in ${daysUntil} days`;
        }
        return (
          <div
            key={d.requestId}
            style={{
              border: `1px solid ${tone}`,
              background: overdue ? "rgba(224,120,120,0.08)" : "rgba(232,184,75,0.08)",
              borderRadius: 10,
              padding: "10px 14px",
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 600, color: overdue ? "#e8a0a0" : "#e8c876" }}>
              {overdue ? "⚠ Payment overdue" : "🔔 Next payment"} — {d.unitLabel}
            </div>
            <div style={{ fontSize: 13, opacity: 0.85, marginTop: 3, lineHeight: 1.5 }}>
              {label}: <strong>{fmtUsd(dueUsd)}</strong> · {when}
              {dueAt !== undefined && !overdue ? ` (${fmtDate(dueAt)})` : ""}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
              Indicative, per your agreement. The signed contract is the authority.
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Nudge banner (ambient cue on browse) — "complete & seal your profile to make an offer". Per-developer
//    honest: names who you're ready for and what each still needs. Shown ONLY when the desk has opened units
//    (readiness.perDev non-empty) and you're not yet ready for all of them — never before engagement. ──────
function NudgeBanner({ readiness, onOpen }: { readiness: ReadinessSummary; onOpen: () => void }) {
  const notReady = readiness.perDev.filter((d) => !d.met);
  const ready = readiness.perDev.filter((d) => d.met);
  return (
    <div
      style={{
        marginTop: 16,
        border: `1px solid ${T.hold}`,
        background: "rgba(232,184,75,0.08)",
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#e8c876" }}>
          {readiness.sealed ? "Complete your verification to make an offer" : "Complete & seal your profile to make an offer"}
        </div>
        <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 4, lineHeight: 1.5 }}>
          {/* Per-developer: who still needs fields. */}
          {notReady.map((d) => (
            <div key={d.developer}>
              <strong>{d.developerName}</strong> still needs: {labelFields(d.missing)}.
            </div>
          ))}
          {/* Fields met everywhere but the profile isn't sealed → the one remaining step is to seal. */}
          {notReady.length === 0 && !readiness.sealed && (
            <div>Your details are complete — seal your profile to make an offer.</div>
          )}
          {/* Developers you're already fully ready for (fields met AND sealed). */}
          {ready.length > 0 && readiness.sealed && (
            <div style={{ color: T.vetted, marginTop: 2 }}>Ready for {ready.map((d) => d.developerName).join(", ")}.</div>
          )}
        </div>
      </div>
      <button onClick={onOpen} style={{ ...submitBtn, margin: 0, whiteSpace: "nowrap" }}>
        My profile &amp; verification →
      </button>
    </div>
  );
}

// ── Catalog grid ────────────────────────────────────────────────────────────────────────────────────────
function priceBand(r: { minUsd: number; maxUsd: number } | null): string {
  if (!r) return "Price on request";
  const f = (n: number) => `$${n.toLocaleString()}`;
  return r.minUsd === r.maxUsd ? f(r.minUsd) : `${f(r.minUsd)} – ${f(r.maxUsd)}`;
}

/** Split a building's `completion` string into TWO lines so every card's meta block is the same height (
 * — the uneven card heights that made some hero images "sit lower"). `primary` goes on the units line
 *  ("198 units · Under construction"), `secondary` on its own line below ("handover Q4 2027 (~1 yr)"). For a
 *  completed building (no "— handover …" clause) we still emit a CORRESPONDING secondary line ("Move-in ready")
 *  so completed + under-construction cards match height; a bare "Under construction" with no handover date gets
 *  a non-breaking-space placeholder so the line still occupies its row. */
function completionLines(completion: string): { primary: string; secondary: string } {
  const [head, ...rest] = completion.split(" — ");
  if (rest.length > 0) return { primary: head.trim(), secondary: rest.join(" — ").trim() };
  // No handover clause. Completed buildings get a matching second line; anything else gets a spacer.
  if (/^completed/i.test(completion)) return { primary: completion.trim(), secondary: "Move-in ready" };
  return { primary: completion.trim(), secondary: " " };
}

function firstPhoto(b: BuyerBuildingView): string | null {
  return b.photos.exterior[0] ?? b.photos.facilities[0] ?? b.photos.interior[0] ?? null;
}

function CatalogGrid({
  buildings,
  onOpen,
}: {
  buildings: BuyerBuildingView[] | null;
  onOpen: (b: BuyerBuildingView) => void;
}) {
  if (buildings === null) return <p style={{ opacity: 0.6, marginTop: 24 }}>Loading developments…</p>;
  if (buildings.length === 0)
    return (
      <section style={{ ...card, marginTop: 24 }}>
        <p style={{ opacity: 0.7, margin: 0 }}>No developments are open for browsing right now. Check back soon.</p>
      </section>
    );

  return (
    <div
      style={{
        marginTop: 24,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 16,
      }}
    >
      {buildings.map((b) => {
        const photo = firstPhoto(b);
        return (
          <button
            key={b.id}
            onClick={() => onOpen(b)}
            style={{
              textAlign: "left",
              padding: 0,
              overflow: "hidden",
              // c: near-square 2px corners so the hero image reads edge-to-edge, not rounded.
              borderRadius: 2,
              background: T.panel,
              border: `1px solid ${T.border}`,
              cursor: "pointer",
              color: T.text,
            }}
          >
            {/* S159c: responsive aspect-ratio banner (was a fixed 170px that cropped the building and didn't
                fit phones). objectPosition "top" keeps the tower; 16/9 scales with the card width. */}
            <div style={{ aspectRatio: "16 / 9", minHeight: 120, background: "#0b0e16" }}>
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt={b.name} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
              ) : (
                // : a nice branded SVG slide instead of a flat "No image" box — reads as
                // intentional, tells the viewer an exterior render WOULD be here, deterministic per building.
                <ImagePlaceholder id={b.id} kind="exterior" label={b.name} />
              )}
            </div>
            <div style={{ padding: "12px 14px 14px" }}>
              <div style={{ fontSize: 16.5, fontWeight: 600 }}>{b.name}</div>
              <div style={{ fontSize: 13, opacity: 0.65, marginTop: 2 }}>
                {b.area} · {b.type}
              </div>
              <div style={{ fontSize: 14, color: T.vetted, marginTop: 8 }}>{priceBand(b.priceRange)}</div>
              {/* Two lines: units + build-phase on line 1, handover/"move-in ready" on line 2, so
                  every card's meta block is equal height (completed + under-construction match). */}
              {(() => {
                const { primary, secondary } = completionLines(b.completion);
                return (
                  <>
                    <div style={{ fontSize: 12.5, opacity: 0.55, marginTop: 4 }}>
                      {b.unitCount.toLocaleString()} units · {primary}
                    </div>
                    <div style={{ fontSize: 12.5, opacity: 0.55, marginTop: 1 }}>{secondary}</div>
                  </>
                );
              })()}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Building detail (still the lossy projection — gallery + amenities + funnel copy + desk CTA) ──────────
function BuildingDetail({
  building: b,
  account,
  onBack,
  reserveIntent,
  onReserveConsumed,
}: {
  building: BuyerBuildingView;
  account: string;
  onBack: () => void;
  /**: a reserve-from-card deep-link targeting THIS building → forwarded to DeskChat to auto-open on the unit. */
  reserveIntent?: ReserveIntent | null;
  onReserveConsumed?: () => void;
}) {
  const gallery = [...b.photos.exterior, ...b.photos.facilities, ...b.photos.interior];

  return (
    <section style={{ ...card, marginTop: 24 }}>
      <button
        onClick={onBack}
        style={{ background: "none", border: `1px solid ${T.accentSoft}`, color: T.accent, fontSize: 13.5, fontWeight: 600, cursor: "pointer", padding: "5px 12px", borderRadius: 8, marginBottom: 14 }}
      >
        ← All developments
      </button>

      <h2 style={{ fontSize: 23, margin: "0 0 2px" }}>{b.name}</h2>
      <p style={{ opacity: 0.7, margin: "0 0 14px", fontSize: 14.5 }}>
        {b.tagline} — {b.area}, {b.address}
      </p>

      {gallery.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Carousel images={gallery} alt={b.name} aspectRatio="3 / 2" />
        </div>
      )}

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 14, marginBottom: 14 }}>
        <Stat label="From" value={priceBand(b.priceRange)} accent />
        <Stat label="Units" value={b.unitCount.toLocaleString()} />
        <Stat label="Type" value={b.type} />
        <Stat label="Status" value={b.completion} />
      </div>

      {b.funnelCopy && (
        <p style={{ fontSize: 14.5, lineHeight: 1.6, opacity: 0.9, borderLeft: `2px solid ${T.borderSoft}`, paddingLeft: 12, margin: "0 0 16px" }}>
          {b.funnelCopy}
        </p>
      )}

      {b.amenities.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: T.fsMeta, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.6, marginBottom: 8 }}>
            Facilities
          </div>
          {/* Compact amenity pills: denser padding + gap so a long facility list reads as a tight
              chip cloud, not chunky buttons. Each pill hugs its label (whiteSpace:nowrap) and the row wraps.
 FILL = a soft PASTEL PURPLE (the pick) — a gentle lilac tint (T.alt #c78ce0) + a matching
              border gives each pill a clear, distinct shape against the card while staying compact + legible. */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {b.amenities.map((a) => (
              <span
                key={a}
                style={{
                  fontSize: 12.5, lineHeight: 1.35, padding: "4px 10px", borderRadius: 999,
                  background: "rgba(199,140,224,0.16)", border: "1px solid rgba(199,140,224,0.40)",
                  color: "#e9d4f4", whiteSpace: "nowrap",
                }}
              >
                {a}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Primary action = talk to the desk. Specific units/prices/availability stay gated behind the
 conversation (§3); the desk opens units from the chat later. */}
      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, opacity: 0.8 }}>
          Individual units, exact prices and availability are shared privately once you talk to our desk.
        </p>
        <DeskChat
          building={b.id}
          account={account}
          reserveIntent={reserveIntent}
          onReserveConsumed={onReserveConsumed}
        />
      </div>
    </section>
  );
}

// A live "… is typing" bubble shown while a reply is being composed (the desk's human-like delay / the AI
// Sales Director thinking). Animated dots via a 1-up cycle so it reads as alive; styled as a left-aligned
// party bubble matching the desk's. Used on BOTH sides of the desk chat (buyer sees "Sales desk", the desk
// operator sees the buyer) so neither side stares at a dead screen during the ~30–45s compose window.
function TypingBubble({ who, mine = false }: { who: string; mine?: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => (x + 1) % 4), 450);
    return () => clearInterval(t);
  }, []);
  const dots = ".".repeat(n) + " ".repeat(3 - n); // keep width stable so it doesn't jiggle
  return (
    <div
      style={{
        alignSelf: mine ? "flex-end" : "flex-start",
        maxWidth: "85%",
        padding: "6px 10px",
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.45,
        background: mine ? T.accentSoft : T.panel,
        border: `1px solid ${T.hold}`,
      }}
      aria-live="polite"
    >
      <div style={{ fontSize: 10.5, opacity: 0.55, marginBottom: 2 }}>{who}</div>
      <div style={{ color: T.hold, fontWeight: 600, fontStyle: "italic" }}>typing{dots}</div>
    </div>
  );
}

// ── Buyer↔desk conversation (§9 step 3) — the pre-booking funnel chat. Reuses the generalized channel
//    store via /api/conversations-direct; the buyer posts as "buyer", the desk (developer) replies. ──
function DeskChat({
  building,
  account,
  reserveIntent,
  onReserveConsumed,
}: {
  building: string;
  account: string;
  /** a reserve-from-card deep-link → auto-open the chat pre-seeded on this unit so the proven AI hold
   *  flow runs. The card is a shortcut INTO the working chat buy-flow (not a separate reserve path). */
  reserveIntent?: ReserveIntent | null;
  onReserveConsumed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  // msgs carry an optional `action` (the un-hashed structured payload from channels.ts). Today only
  // `{type:"buttons"}` renders — as tappable commit chips under the desk bubble (the action-buttons spine).
  const [messages, setMessages] = useState<{ id: string; from: string; by: string; text: string; at: number; action?: DeskAction }[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // UNREAD count of desk messages the buyer hasn't read yet — shown on the collapsed "Talk to the desk"
  // button so a reply is visible WITHOUT opening the chat (the gap hit). Server read-marker = `seen`.
  const [unread, setUnread] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const notify = useNotifier();
  // Track the newest DESK message id we've already alerted on, so a reload only chimes for genuinely new
  // incoming messages (not our own sends, not the initial load).
  const lastDeskIdRef = useRef<string | null>(null);
  const primedRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  // Mark THIS thread seen on the server at `count` (monotonic) + clear the local unread badge.
  const markSeen = useCallback(
    (cid: string, count: number) => {
      setUnread(0);
      void fetch("/api/conversations/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewer: account, conversationId: cid, count, kind: "direct" }),
      }).catch(() => {});
    },
    [account]
  );

  // Resolve (buyer, building) → the conversation. Loads messages AND computes the unread count from the server
  // read-marker so the badge is right on first paint. Runs on MOUNT (not just on open) so a desk reply alerts
  // and badges the collapsed button. `ensureOpen` = this call is the buyer actively opening the thread.
  const resolve = useCallback(
    async (ensureOpen: boolean): Promise<string | null> => {
      setErr(null);
      try {
        const [conv, seenMap] = await Promise.all([
          fetch(`/api/conversations-direct?account=${encodeURIComponent(account)}&building=${encodeURIComponent(building)}`).then((r) => r.json()),
          fetch(`/api/conversations/seen?viewer=${encodeURIComponent(account)}`).then((r) => r.json()).catch(() => ({ seen: {} })),
        ]);
        if (conv.error) throw new Error(conv.error);
        const cid: string = conv.conversationId;
        const msgs = conv.messages ?? [];
        setConvId(cid);
        setMessages(msgs);
        primedRef.current = true;
        lastDeskIdRef.current = [...msgs].reverse().find((m: { from: string }) => m.from === "developer")?.id ?? null;
        const seenCount = (seenMap.seen && typeof seenMap.seen === "object" ? seenMap.seen[cid] : 0) ?? 0;
        const newest = msgs[msgs.length - 1];
        const unreadNow = newest?.from === "developer" ? Math.max(0, msgs.length - seenCount) : 0;
        if (ensureOpen) {
          markSeen(cid, msgs.length); // opening = reading
        } else {
          setUnread(unreadNow);
        }
        return cid; // return the id so a programmatic caller (reserve deep-link) needn't wait for state.
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not reach the desk");
        return null;
      }
    },
    [account, building, markSeen]
  );

  const reload = useCallback(async () => {
    if (!convId) return;
    try {
      const j = await fetch(
        `/api/conversations-direct?account=${encodeURIComponent(account)}&conversationId=${encodeURIComponent(convId)}`
      ).then((r) => r.json());
      if (j.error) return;
      const msgs: { id: string; from: string; by: string; text: string; at: number; action?: DeskAction }[] = j.messages ?? [];
      // Only update when the message set actually changed — avoids a needless re-render/flash on each poll.
      setMessages((prev) => (prev && prev.length === msgs.length && prev[prev.length - 1]?.id === msgs[msgs.length - 1]?.id ? prev : msgs));
      // Chime on a genuinely NEW incoming (desk) message. Prime silently on the first load so opening the
      // chat doesn't replay a chime for the backlog.: ring 3× + deep-link to this building's desk.
      const lastDesk = [...msgs].reverse().find((m) => m.from === "developer");
      if (!primedRef.current) {
        primedRef.current = true;
        lastDeskIdRef.current = lastDesk?.id ?? null;
      } else if (lastDesk && lastDesk.id !== lastDeskIdRef.current) {
        lastDeskIdRef.current = lastDesk.id;
        if (openRef.current) {
          markSeen(convId, msgs.length); // chat is open + being read → stays seen, no badge
        } else {
          setUnread((n) => n + 1);
          notify("Message from the sales desk", lastDesk.text.slice(0, 120), {
            tag: "vrx-desk-chat",
            repeat: 3,
            href: `/buyer`,
          });
        }
      } else if (openRef.current) {
        markSeen(convId, msgs.length);
      }
    } catch {
      /* transient */
    }
  }, [account, convId, notify, markSeen]);

  // Resolve on mount so the collapsed button can badge a waiting reply (not only after the buyer opens it).
  useEffect(() => {
    void resolve(false);
  }, [resolve]);

  // Fast push: a message landing in THIS thread pushes its opaque channel topic → reload.
  useEventStream((t) => {
    if (convId && t.topic === channelTopic(convId)) void reload();
  });

  // Safety poll (SSE can drop): re-read every 3s whether or not the chat is open, so an away-from-screen buyer
  // still gets the badge + chime. LOWERED 8s→3s — the AI reply is computed in ~2s server-side, but over the
  // flaky tunnel the SSE push often doesn't reach the browser, so this poll is what actually delivers it; at 8s a
  // ready reply sat up to 8s stale (the "AI is slow" complaint — it wasn't the AI, it was this cadence). 3s makes a
  // dropped-SSE reply appear within ~3s. One thread poll per 3s is still trivial first-party load.
  useEffect(() => {
    if (!convId) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 3000);
    return () => clearInterval(t);
  }, [convId, reload]);

  // "Sales desk is typing…" — the desk (human or the AI Sales Director) composes with a short human-like delay,
  // so an unanswered message can sit ~30–45s before a reply lands. Show a live typing indicator for that window
  // so the wait feels alive rather than dead. Self-expiring + bounded (TYPING_WINDOW_MS): if no reply comes
  // (e.g. the desk is offline / autoresponder off) the indicator fades instead of lying forever. Re-renders on
  // a 1s tick while active so it disappears on time without needing a new message.
  const TYPING_WINDOW_MS = 45_000;
  const [nowTick, setNowTick] = useState(() => Date.now());
  const lastMsg = (messages ?? [])[(messages ?? []).length - 1];
  const deskTyping = !!lastMsg && lastMsg.from === "buyer" && nowTick - lastMsg.at < TYPING_WINDOW_MS;
  useEffect(() => {
    if (!deskTyping) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deskTyping]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, deskTyping]);

  async function openChat() {
    setOpen(true);
    if (convId) {
      markSeen(convId, messages?.length ?? 0);
    } else {
      await resolve(true);
    }
  }

  //  reserve-from-card deep-link: when the page hands this chat a reserveIntent for its building, OPEN the
  // chat and SEND a natural reserve message for that unit — this kicks off the PROVEN AI hold flow (open_unit →
  // bridge → direct-deposit). We POST directly via sendText (not the Send button, whose enabled state needs a
  // real keystroke — D-), so the reserve fires reliably from a programmatic trigger. Fires ONCE per intent
  // (the ref guard), then signals the page to clear it so re-selecting the building doesn't re-send.
  const reserveFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!reserveIntent || reserveIntent.building !== building) return;
    const key = `${reserveIntent.building}:${reserveIntent.unit}`;
    if (reserveFiredRef.current === key) return;
    reserveFiredRef.current = key;
    void (async () => {
      setOpen(true);
      const id = convId ?? (await resolve(true));
      if (id) {
        // Pass reserveUnit so the server seeds the deal focus → the phase fast-path can reach "book" and the AI
        // places the hold the buyer just asked for (without it focusUnitId was null and the hold never fired).
        // when the buyer composed an offer in the review overlay, describe it in the reserve message AND stash
        // the plan on the deal (so the deposit/seal use the AGREED plan, not a fixed template). The verdict is
        // within-caps by construction (the sliders clamp), so the AI auto-agrees; an off-standard ask would carry
        // its own free-text and the desk would negotiate (future free-entry path).
        const msg = reserveIntent.plan
          ? `I'd like to reserve ${reserveIntent.unit} (${reserveIntent.label}) with this payment plan: ${describePlan(reserveIntent.plan)}. Can you place a hold and take my deposit on this plan?`
          : `I'd like to reserve ${reserveIntent.unit} (${reserveIntent.label}). Can you place a hold for me?`;
        await sendText(id, msg, reserveIntent.unit, reserveIntent.plan);
      }
      onReserveConsumed?.();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reserveIntent, building]);

  // Post a message directly (shared by the Send button and the reserve deep-link). Returns nothing; refreshes
  // the thread on success. The caller owns the conversationId (the button uses `convId`; the deep-link passes
  // the freshly-resolved id so it needn't wait for the convId state to settle).
  async function sendText(conversationId: string, text: string, reserveUnit?: string, reservePlan?: AssembledPlan) {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setErr(null);
    try {
      const res = await fetch("/api/conversations-direct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account,
          conversationId,
          text: t,
          ...(reserveUnit ? { reserveUnit } : {}),
          // the composed offer plan (within caps) — the route stashes it on the deal so the deposit/seal
          // reflect the AGREED plan. Only the neutral money structure (no PII) rides along.
          ...(reservePlan ? { reservePlan } : {}),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not send");
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  // tap a COMMIT chip (the action-buttons spine). POSTs the structured button to /api/desk-action, which
  // runs the real executor server-side (reserve → open_unit) with its own role + unit-eligibility re-check. The
  // client sends only the kind + the unit KEY (never a label/price — the server re-derives money). Fail-soft: a
  // denial surfaces inline; a success reloads the thread so the resulting hold/notice appears. `tapping` disables
  // the chip so a double-tap can't fire twice (idempotency is ALSO enforced server-side — belt and braces).
  const [tapping, setTapping] = useState<string | null>(null);
  async function tapAction(btn: ActionButton) {
    if (!convId || tapping) return;
    setTapping(btn.kind + ":" + btn.unit.key);
    setErr(null);
    try {
      const res = await fetch("/api/desk-action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, conversationId: convId, buttonKind: btn.kind, unit: { key: btn.unit.key } }),
      });
      const j = await res.json();
      if (j?.ok === false && j?.reason) {
        // Map the server's honest reason → a plain buyer-facing line. The S&P-before-deposit gate (Slice 3a)
        // speaks here: a pay_deposit tapped before [Read S&P] is refused with sp_not_acknowledged.
        const reason: string = j.reason;
        setErr(
          reason === "not_yet_available"
            ? "That option isn't available yet."
            : reason === "unit_not_offered"
              ? "That unit isn't open to you."
              : reason === "already_held"
                ? "That unit is no longer available."
                : reason === "sp_not_acknowledged"
                  ? "Please read the Sale & Purchase agreement first, then pay the deposit."
                  : reason === "no_held_reservation"
                    ? "Reserve the unit first — there's nothing to pay for yet."
                    : reason === "not_confirmed"
                      ? "Confirm your reservation first — that starts the 2-hour window to pay the deposit."
                      : reason === "deposit_window_lapsed"
                        ? "The 2-hour deposit window passed. Confirm again to restart it, then pay."
                        : reason === "insufficient $VRX balance"
                          ? "Not enough $VRX to pay the deposit — claim or top up your wallet, then try again."
                          : "Couldn't complete that just now."
        );
      } else if (j?.ok === true && btn.kind === "read_sp") {
        // The S&P is now materialized + acknowledged — the BuyerPaperworkLink below surfaces the document on
        // reload. Nudge the buyer to it so they know where to look.
        setErr(null);
      }
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't complete that");
    } finally {
      setTapping(null);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || !convId || sending) return;
    setSending(true);
    setErr(null);
    try {
      const res = await fetch("/api/conversations-direct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, conversationId: convId, text }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not send");
      setDraft("");
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <button style={{ ...submitBtn, display: "inline-flex", alignItems: "center", gap: 8 }} onClick={() => void openChat()}>
        {unread > 0 ? "The sales desk replied" : "Talk to the sales desk"} →
        {unread > 0 && (
          <span
            aria-label={`${unread} unread`}
            style={{
              fontSize: 11,
              minWidth: 18,
              textAlign: "center",
              padding: "1px 6px",
              borderRadius: 999,
              background: "#fff",
              color: T.accent,
              fontWeight: 700,
            }}
          >
            {unread}
          </span>
        )}
      </button>
    );
  }

  const msgs = messages ?? [];
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, background: T.bg2 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Sales desk</div>
      {/* C-slice: if the desk asked to see/add details, the buyer consents or declines here. */}
      {convId && <BuyerRevealConsent account={account} convId={convId} />}
      {err && <div style={{ ...banner, borderColor: "#5a2a2a", color: "#e0a0a0", marginTop: 0, marginBottom: 10 }}>{err}</div>}
      {messages === null ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, margin: "0 0 8px" }}>Connecting to the desk…</p>
      ) : msgs.length === 0 ? (
        <p style={{ fontSize: 12.5, opacity: 0.6, margin: "0 0 8px" }}>
          Say hello and tell the desk what you&apos;re looking for — budget, size, when you&apos;d like to move.
        </p>
      ) : (
        <div ref={scrollRef} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, maxHeight: 280, overflowY: "auto" }}>
          {msgs.map((m) => {
            // A `vrx` SYSTEM message (D-call-off markers, C-reveal grants, the E-block autoreply) renders as a
            // centred, muted notice — not a party bubble (it's VRX/the system speaking, not the desk).
            if (m.from === "vrx") {
              return (
                <div key={m.id} style={{ alignSelf: "center", maxWidth: "92%", textAlign: "center", fontSize: 11.5, opacity: 0.7, color: T.dim, padding: "4px 10px", whiteSpace: "pre-wrap" }}>
                  {m.text}
                </div>
              );
            }
            const mine = m.from === "buyer";
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: mine ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "6px 10px",
                  borderRadius: 10,
                  fontSize: 13,
                  lineHeight: 1.45,
                  background: mine ? T.accentSoft : T.panel,
                  border: `1px solid ${T.borderSoft}`,
                }}
              >
                <div style={{ fontSize: 10.5, opacity: 0.55, marginBottom: 2 }}>{mine ? "You" : "Sales desk"}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                {/* the in-chat action-buttons spine: tappable commit chips the desk (AI or human) proposes
                    alongside its words. A tap runs the real executor server-side via /api/desk-action — the commit
                    is a structured payload, never a parsed chat turn (kills the confab/loop/wrong-unit bug class). */}
                {!mine && m.action?.type === "buttons" && m.action.buttons.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {m.action.buttons.map((btn, bi) => {
                      const busy = tapping === btn.kind + ":" + btn.unit.key;
                      const disabled = !btn.enabled || !!tapping;
                      return (
                        <button
                          key={btn.kind + ":" + btn.unit.key + ":" + bi}
                          type="button"
                          onClick={() => void tapAction(btn)}
                          disabled={disabled}
                          title={!btn.enabled ? btn.disabledReason : undefined}
                          style={{
                            ...submitBtn,
                            margin: 0,
                            padding: "5px 11px",
                            fontSize: 12,
                            opacity: disabled ? 0.5 : 1,
                            cursor: disabled ? "not-allowed" : "pointer",
                          }}
                        >
                          {busy ? "…" : btn.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {deskTyping && <TypingBubble who="Sales desk" />}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Message the sales desk…"
          style={{ ...input, margin: 0, flex: 1 }}
          disabled={sending || !convId}
        />
        <button type="button" onClick={() => void send()} disabled={sending || !convId || !draft.trim()} style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, margin: 0 }}>
          {sending ? "…" : "Send"}
        </button>
      </div>
      {/*  slice 4: once the desk has opened the paperwork (materialized the deal's Offer), the buyer can
          view their OWN Sale & Purchase contract — the same document, scoped to them (full, unmasked). */}
      {convId && <BuyerPaperworkLink account={account} convId={convId} />}
      {/* D-slice: the bilateral call-off — either party can propose a no-prejudice close. */}
      {convId && <CallOffControl account={account} conversationId={convId} role="buyer" onChanged={reload} />}
      {/* F-slice: refer to VRX — the buyer's recourse (keeps the deal live, brings VRX). */}
      {convId && <EscalateControl account={account} conversationId={convId} onChanged={reload} />}
      <p style={{ fontSize: 10.5, opacity: 0.6, marginTop: 6, marginBottom: 0 }}>
        Private to you and the sales desk, kept off-chain.
      </p>
    </div>
  );
}

// ── BuyerPaperworkLink (slice 4) — once the desk has opened the paperwork (materialized the deal's Offer),
//    the buyer can view their OWN Sale & Purchase contract. The requestId is a server-side hash, so the buyer
//    can't compute it — we resolve it (scoped) via /api/conversations-direct/offer, then render the shared
//    SaleContractButton with viewer=the buyer (the S&P route authorizes the buyer as a party and shows their
//    own identity in full). Polls gently so the link appears when the desk opens it, without a reload. ──────────
function BuyerPaperworkLink({ account, convId }: { account: string; convId: string }) {
  const [requestId, setRequestId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await fetch(
        `/api/conversations-direct/offer?account=${encodeURIComponent(account)}&conversationId=${encodeURIComponent(convId)}`
      ).then((r) => r.json());
      setRequestId(typeof j.requestId === "string" ? j.requestId : null);
    } catch {
      /* transient */
    }
  }, [account, convId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (!requestId) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <SaleContractButton requestId={requestId} viewer={account} label="View my Sale & Purchase contract" />
      <p style={{ fontSize: 10.5, opacity: 0.6, margin: "5px 0 0", lineHeight: 1.5 }}>
        The desk has prepared your paperwork. Review the full agreement before you proceed.
      </p>
      {/*  slice 5 — the buyer picks how they'll pay from the developer's accepted methods (renders only
          when the deal has a payment menu). The pick states the binding method in §2 of the agreement. */}
      <PaymentOptionPicker requestId={requestId} viewer={account} />
      {/*  Slice 7 (party half) — amendments raised against THIS contract by a major change to the building,
          each with the buyer's sealed before/after proof + explicit dispute right. Renders only when any exist. */}
      <BuyerAmendments requestId={requestId} viewer={account} />
    </div>
  );
}

// ── BuyerAmendments (Slice 7 party half, the design docs §Slice 7) — the buyer's side of
//    the change-governance arc. When a MAJOR material change to their building filed a sealed amendment to this
//    contract (lib/contract-amendment, Slice 3), the buyer sees it here: what kind of change, that a tamper-evident
//    before/after is sealed and retrievable, and that they hold an explicit RIGHT TO DISPUTE. VRX anchors the
//  evidence + the right; VRX does NOT adjudicate (pt5) — so this NEVER shows an outcome, only that the right
//    exists and the proof is on file. Reads the party-gated /api/change-governance/amendments (salt-stripped). ──
// Plain-words labels for the change class (the buyer sees what changed, never the contract's class names).
const AMENDMENT_LABEL: Record<string, string> = {
  physical: "a change to the building’s physical specification",
  fees: "a change to the building’s fees",
  land: "a correction to the land & legal particulars",
  priceUp: "a price change",
  sizeTypeLayout: "a change to the unit’s size, type or layout",
  terms: "a change to the agreed terms",
};
function BuyerAmendments({ requestId, viewer }: { requestId: string; viewer: string }) {
  const [rows, setRows] = useState<
    { id: string; changeClass: string; evidenceId: string; disputeRight: boolean; at: number; verified: boolean }[]
  >([]);

  const load = useCallback(async () => {
    try {
      const j = await fetch(
        `/api/change-governance/amendments?requestId=${encodeURIComponent(requestId)}&viewer=${encodeURIComponent(viewer)}`
      ).then((r) => r.json());
      setRows(Array.isArray(j.amendments) ? j.amendments : []);
    } catch {
      /* transient */
    }
  }, [requestId, viewer]);

  useEffect(() => {
    void load();
  }, [load]);

  if (rows.length === 0) return null;
  return (
    <div style={{ ...card, marginTop: 12, padding: 12, borderLeft: `3px solid ${T.accent}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Changes to your reserved property</div>
      <p style={{ fontSize: 11.5, opacity: 0.75, margin: "0 0 8px", lineHeight: 1.5 }}>
        The developer notified a change affecting your contract. A tamper-evident record of exactly what changed
        — before and after — is sealed and retrievable. You have the right to dispute; VRX records the evidence,
        it does not decide the outcome. Speak to the desk, or refer to VRX, to raise it.
      </p>
      {rows.map((a) => (
        <div
          key={a.id}
          style={{ fontSize: 12, padding: "7px 0", borderTop: `1px solid ${T.border}`, lineHeight: 1.5 }}
        >
          <div>{AMENDMENT_LABEL[a.changeClass] ?? "a change to your contract"}</div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            {new Date(a.at).toLocaleDateString()} ·{" "}
            {a.verified ? "sealed record verified ✓" : "record sealed"}
            {a.disputeRight ? " · you may dispute this" : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── BuyerRevealConsent (C-slice) — the buyer's side of the reveal ceremony. When the desk asks to SEE or
//    ADD specific details, the buyer sees the ask here and CONSENTS (all or a subset) or DECLINES. A grant is
//  PERMANENT for this conversation (Q2) — once shared, the desk keeps seeing it (until a future call-off).
//    The desk's ask also appears inline in the chat as a message; this panel is the ACTION surface + a readout of
//  what's already shared. Masking stays SERVER-side — consenting here just tells the server to widen. ──
type RevealState = {
  request?: { by: string; at: number; fields: string[]; declarationSeal: string };
  grantedFields?: string[];
  grantedAt?: number;
};

function BuyerRevealConsent({ account, convId }: { account: string; convId: string }) {
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await fetch(
        `/api/conversations-direct/reveal?account=${encodeURIComponent(account)}&conversationId=${encodeURIComponent(convId)}`
      ).then((r) => r.json());
      if (j.reveal) setReveal(j.reveal);
    } catch {
      /* transient */
    }
  }, [account, convId]);

  // Load on mount + poll gently (same cadence as the chat) so a fresh desk request appears without a reload.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  // When a new request arrives, pre-select every asked field (buyer can uncheck to grant a subset).
  useEffect(() => {
    if (reveal?.request) setPicked(new Set(reveal.request.fields));
  }, [reveal?.request]);

  async function act(action: "grant" | "decline") {
    setBusy(true);
    try {
      await fetch("/api/conversations-direct/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account,
          conversationId: convId,
          action,
          ...(action === "grant" ? { fields: [...picked] } : {}),
        }),
      });
      await load();
    } catch {
      /* leave state; the user can retry */
    } finally {
      setBusy(false);
    }
  }

  const req = reveal?.request;
  const granted = reveal?.grantedFields ?? [];

  // Nothing to show if there's no pending ask and nothing has ever been shared.
  if (!req && granted.length === 0) return null;

  return (
    <div style={{ border: `1px solid ${req ? T.hold : T.borderSoft}`, borderRadius: 9, padding: "9px 11px", marginBottom: 10, background: req ? "rgba(232,184,75,0.07)" : T.panel }}>
      {req ? (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>The sales desk asked to see your details</div>
          <p style={{ fontSize: 11.5, opacity: 0.75, margin: "0 0 8px", lineHeight: 1.5 }}>
            They&apos;ve agreed not to use these to contact you outside VRX. Share what you&apos;re comfortable
            with — your details stay masked until you agree, and you can decline.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginBottom: 8 }}>
            {req.fields.map((f) => (
              <label key={f} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={picked.has(f)}
                  disabled={busy}
                  onChange={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(f)) next.delete(f); else next.add(f);
                      return next;
                    })
                  }
                />
                <span>{FIELD_LABEL[f] ?? f}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => void act("grant")} disabled={busy || picked.size === 0} style={{ ...submitBtn, padding: "5px 12px", fontSize: 12.5, margin: 0, opacity: picked.size === 0 ? 0.6 : 1 }}>
              {busy ? "…" : picked.size === req.fields.length ? "Share these" : `Share ${picked.size} selected`}
            </button>
            <button onClick={() => void act("decline")} disabled={busy} style={{ background: "none", border: `1px solid ${T.border}`, color: T.dim, fontSize: 12.5, cursor: "pointer", padding: "5px 12px", borderRadius: 8 }}>
              Decline
            </button>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 11.5, opacity: 0.8 }}>
          You&apos;re sharing with this desk: <strong style={{ color: T.vetted }}>{granted.map((f) => FIELD_LABEL[f] ?? f).join(", ")}</strong>.
        </div>
      )}
    </div>
  );
}

// ── Desk-request watcher (F3) — buyer-WIDE alert for a pending desk reveal request ─────────────────────
//  the F3: the desk asked him (as buyer) to add detail, but browsing elsewhere he got NO sound / no
//    notification / no deep-link. The per-building chat notifier only runs when THAT building's chat is mounted;
//    a browsing buyer isn't polling it. This page-level watcher polls /api/buyers-direct/desk-requests (cheap,
//    field-keys only) on EVERY view, chimes 3× + fires a browser notification the FIRST time it sees a new ask
//    (deduped by the request's `at`, same discipline as the chat's lastDeskId guard), and renders an in-app
//  banner whose button DEEP-LINKS the profile focused on exactly the requested fields. All three of the
//    misses (notification · sound · deep-link) in one reused-pattern surface. Renders nothing when no ask pends.
type DeskRequest = {
  conversationId: string;
  building: string;
  buildingName: string;
  developerName: string;
  fields: string[];
  at: number;
};

function DeskRequestWatcher({ account, onOpenProfile }: { account: string; onOpenProfile: (f: ProfileFocus) => void }) {
  const [reqs, setReqs] = useState<DeskRequest[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const notify = useNotifier();
  // Newest `at` we've already CHIMED on — so a reload/poll doesn't replay the ding for an ask already seen.
  const lastAlertedAtRef = useRef(0);
  const primedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const j = await fetch(`/api/buyers-direct/desk-requests?account=${encodeURIComponent(account)}`).then((r) => r.json());
      const list: DeskRequest[] = Array.isArray(j.requests) ? j.requests : [];
      setReqs(list);
      const newest = list[0]; // server sorts newest-first
      if (!primedRef.current) {
        // First load after mount: prime silently (an ask that was already pending shouldn't chime on arrival).
        primedRef.current = true;
        lastAlertedAtRef.current = newest?.at ?? 0;
      } else if (newest && newest.at > lastAlertedAtRef.current) {
        lastAlertedAtRef.current = newest.at;
        notify(
          `${newest.developerName} asked for a few details`,
          `For ${newest.buildingName}: add or share ${labelFields(newest.fields)}. Your details stay masked until you agree.`,
          { tag: "vrx-desk-request", repeat: 3, href: "/buyer" }
        );
      }
    } catch {
      /* leave the current list as-is on a transient error */
    }
  }, [account, notify]);

  // The buyer's own grantTopic ticks on reveal activity (same opaque bus the readiness refresh uses); refresh on
  // it for the live path, plus a slow visible-tab safety poll (the dropped-stream backstop — a cheap first-party
  // read, not a chain read). Same belt-and-suspenders pattern as OpenedUnits / the chat.
  const myTopic = grantTopic(account);
  useEventStream((t) => {
    if (t.topic === myTopic || t.topic === "events") void refresh();
  }, !!account);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const pending = reqs.filter((r) => !dismissed.has(`${r.conversationId}:${r.at}`));
  if (pending.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
      {pending.map((r) => (
        <div
          key={`${r.conversationId}:${r.at}`}
          style={{ ...banner, borderColor: "#5a4a2a", color: "#e0c67c", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
        >
          <span style={{ flex: "1 1 240px", lineHeight: 1.5 }}>
            🔐 <strong>{r.developerName}</strong> asked you to add or share{" "}
            <strong>{labelFields(r.fields)}</strong> for <strong>{r.buildingName}</strong>. Your details stay
            masked until you agree.
          </span>
          <button
            onClick={() => onOpenProfile({ focusFields: r.fields, forDeveloper: r.developerName })}
            style={{ ...submitBtn, padding: "8px 14px", fontSize: 13.5, whiteSpace: "nowrap" }}
          >
            Add details →
          </button>
          <button
            onClick={() => setDismissed((s) => new Set(s).add(`${r.conversationId}:${r.at}`))}
            aria-label="Dismiss"
            style={{ background: "none", border: "none", color: T.faint, fontSize: 18, cursor: "pointer", lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Opened units (§9 3b–5) — the units the desk has OPENED to this buyer. LOSSY UNTIL OFFER-ELIGIBLE:
//    specs show once a unit is opened; exact price / floor plan unlock only when the buyer clears the bar
//    (two-stage reveal). The server does the projection (lib/unit-grants route) — this page only ever
//    receives what it's allowed to see. ──
type OpenedUnit = {
  building: string;
  buildingName: string;
  unit: string;
  specs: { label: string; type: string; floor: number; sqm: number; view?: string; baths?: number; corner?: boolean };
  detail: { priceUsd: number; floorplan?: string; note?: string; terms?: PaymentTerms } | null;
  /** Building hero (exterior) — always present once opened; privacy-safe. (F4.) */
  photo: string | null;
  /** Unit-specific imagery (floorplan today) — present only when offer-eligible (two-stage reveal). */
  unitPhotos: string[];
  /** ordered subtype gallery (exterior → facilities → interiors → subtype floorplan) for the review
   *  carousel; eligible-gated. Empty until eligible / if no renderings. See IMAGE_SETS in lib/mm. */
  gallery?: string[];
  developerName: string;
  readiness: { met: boolean; missing: string[]; sealed: boolean };
  at: number;
};

// `paidVrx` present → the buyer already settled this deposit in $VRX; drives the pay button vs "paid" cue.
type HeldInfo = { building: string; unit: string; holdUntil: number; paidVrx?: { amountVrx: number; at: number } };

function OpenedUnits({
  account,
  onFixProfile,
  onReserve,
}: {
  account: string;
  onFixProfile: (f: ProfileFocus) => void;
  /** a cleared buyer hit "Reserve this unit" → deep-link into this building's desk chat on the unit.
   *  an optional composed offer plan (from the review overlay) rides along so the deposit/seal use the agreed plan. */
  onReserve: (building: string, unit: string, label: string, plan?: AssembledPlan) => void;
}) {
  const [units, setUnits] = useState<OpenedUnit[] | null>(null);
  const [held, setHeld] = useState<HeldInfo[]>([]);
  // The red-card alert popup: which unit the buyer clicked while it still needs verification.
  const [alertUnit, setAlertUnit] = useState<OpenedUnit | null>(null);
  // the review overlay — which CLEARED unit the buyer tapped to see full detail (photos/specs/price/plan).
  const [reviewUnit, setReviewUnit] = useState<OpenedUnit | null>(null);
  // which unit's "Not interested" dismiss is in flight (building:unit key) — disables its control.
  const [dismissingKey, setDismissingKey] = useState<string | null>(null);
  // Which held unit's $VRX payment is in flight (building:unit key), + a per-unit error line.
  const [payingKey, setPayingKey] = useState<string | null>(null);
  const [payErr, setPayErr] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [g, d] = await Promise.all([
        fetch(`/api/unit-grants?account=${encodeURIComponent(account)}`).then((r) => r.json()),
        fetch(`/api/direct-deposits?account=${encodeURIComponent(account)}`).then((r) => r.json()),
      ]);
      setUnits(g.units ?? []);
      setHeld(
        (d.deposits ?? [])
          .filter((x: { status: string }) => x.status === "held")
          .map((x: HeldInfo) => ({ building: x.building, unit: x.unit, holdUntil: x.holdUntil, paidVrx: x.paidVrx }))
      );
    } catch {
      setUnits([]);
    }
  }, [account]);

  // Pay a held unit's deposit from the buyer's own $VRX balance (self-pay). The server does the single
  // real debit + files the self-proving in_app record; on success we refresh so the balance + "✓ paid" update.
  const payVrx = useCallback(
    async (building: string, unit: string) => {
      const k = `${building}:${unit}`;
      setPayingKey(k);
      setPayErr((e) => ({ ...e, [k]: "" }));
      try {
        const res = await fetch("/api/direct-deposits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "pay-vrx", account, building, unit }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setPayErr((e) => ({ ...e, [k]: j?.error === "insufficient $VRX balance" ? "Not enough $VRX — claim or top up your wallet." : (j?.error ?? "Payment failed.") }));
          return;
        }
        await refresh(); // reflect the new balance + the paid state
      } catch {
        setPayErr((e) => ({ ...e, [k]: "Payment failed — try again." }));
      } finally {
        setPayingKey(null);
      }
    },
    [account, refresh]
  );

  // dismiss a unit ("not interested"). Buyer-authorized release — PATCH action:"dismiss" revokes the
  // buyer's OWN grant + posts a "passed" notice into the desk thread. On success the SSE grantTopic push already
  // refreshes the list (the card disappears); we also refresh + close any open review as a belt-and-suspenders.
  const dismiss = useCallback(
    async (building: string, unit: string) => {
      const k = `${building}:${unit}`;
      setDismissingKey(k);
      try {
        const res = await fetch("/api/unit-grants", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "dismiss", account, building, unit }),
        });
        if (res.ok) {
          setReviewUnit((r) => (r && r.building === building && r.unit === unit ? null : r));
          await refresh();
        }
      } catch {
        /* transient — the card simply stays; the buyer can retry */
      } finally {
        setDismissingKey(null);
      }
    },
    [account, refresh]
  );

  // REAL-TIME: the desk opening/closing a unit publishes an opaque `grants:<token>` bus tick; subscribe
  // so the list updates the instant it happens — no reload, no fast poll. We also refresh on the generic
  // "events" tick (a firm-hold lands there, flipping a unit to "reserved for you"). The token is recomputed
  // from our own account, so we only react to our own grant changes; other buyers' ticks are unlinkable.
  const myTopic = grantTopic(account);
  useEventStream((t) => {
    if (t.topic === myTopic || t.topic === "events") void refresh();
  }, !!account);

  useEffect(() => {
    void refresh();
    // SLOW safety poll — the SSE push above is the live path; this only catches a dropped stream (same
    // belt-and-suspenders pattern as the chat). Visible-tab only; a cheap first-party /api read, not a chain
    // read, so even this backstop costs nothing meaningful.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Nothing opened yet → don't render the section at all (keeps the funnel's "talk first" framing).
  if (!units || units.length === 0) return null;

  return (
    <section style={{ ...card, marginTop: 20 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Units opened to you</h2>
      <p style={{ fontSize: 13.5, opacity: 0.7, lineHeight: 1.5, margin: "0 0 14px" }}>
        The sales desk has opened these specific units for you. Complete your profile and fund your wallet to
        unlock exact prices and make an offer.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
        {units.map((u) => {
          const eligible = u.detail !== null;
          const heldRec = held.find((h) => h.building === u.building && h.unit === u.unit && h.holdUntil / 1e6 > Date.now());
          const isHeld = !!heldRec;
          const paidVrx = !!heldRec?.paidVrx;
          const payKey = `${u.building}:${u.unit}`;
          const paying = payingKey === payKey;
          // Verification needed for THIS card's developer: profile not sealed, or this developer's required
          // fields aren't all filled. Per-developer — two cards can differ for the same buyer. A held unit is
          // already past the bar, so it never shows the red cue.
          const needsVerify = !isHeld && (!u.readiness.sealed || !u.readiness.met);
          const borderColor = isHeld ? "rgba(56,211,159,0.5)" : needsVerify ? T.danger : T.border;
          const dismissing = dismissingKey === payKey;
          // the card is now INTERACTIVE for a cleared buyer (the gap — a revealed unit had no exit).
          //   needs-verify → the red-card alert (existing).  cleared → open the review overlay.
          // The inner action buttons stopPropagation so they don't also trip the card-level open.
          const onCardClick = needsVerify ? () => setAlertUnit(u) : () => setReviewUnit(u);
          return (
            <div
              key={`${u.building}:${u.unit}`}
              onClick={onCardClick}
              style={{
                border: `1px solid ${borderColor}`,
                borderRadius: 10,
                padding: 0,
                background: T.bg2,
                cursor: "pointer",
                overflow: "hidden",
              }}
            >
              {/* F4: building hero (exterior) — always shown once a unit is opened; privacy-safe (same
                  marketing shot the browse cards use, nothing unit-specific). Makes the card feel alive. */}
              {u.photo && (
                <div style={{ width: "100%", aspectRatio: "3 / 2", background: T.bg }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={u.photo}
                    alt={u.buildingName}
                    style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", display: "block" }}
                  />
                </div>
              )}
              <div style={{ padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 15.5, fontWeight: 600 }}>{u.specs.label}</span>
                <span style={{ fontSize: 12, fontFamily: T.mono, opacity: 0.6 }}>{u.unit}</span>
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.65, marginTop: 2 }}>{u.buildingName}</div>
              {needsVerify && (
                <div style={{ fontSize: 11.5, color: T.danger, marginTop: 6, fontWeight: 600 }}>
                  ⚠ Verification needed — tap to continue
                </div>
              )}
              {isHeld && (
                <div style={{ fontSize: 11.5, color: T.vetted, marginTop: 6, fontWeight: 600 }}>
                  ✓ Reserved for you — this unit is firm-held on-chain while you proceed.
                </div>
              )}
              {/* $VRX self-pay: on a held unit, the buyer can settle the reservation deposit from their
                  own $VRX balance. Once paid, the button becomes a confirmation. stopPropagation so the click
                  doesn't trip the card-level verify popup. */}
              {isHeld && (
                paidVrx ? (
                  <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ fontSize: 11.5, color: T.vetted, fontWeight: 600 }}>✓ Deposit paid in $VRX</div>
                    {/*  (Step 6): a paid deposit makes the deal binding → surface the AGREED Sale & Purchase
                        agreement + the explicit withdraw path (no casual dismiss once money has changed hands). */}
                    <PaidAgreement account={account} building={u.building} unit={u.unit} onChanged={refresh} />
                  </div>
                ) : (
                  <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      disabled={paying}
                      onClick={() => void payVrx(u.building, u.unit)}
                      style={{
                        background: paying ? T.panel2 : T.accent,
                        border: "none",
                        color: "#fff",
                        cursor: paying ? "default" : "pointer",
                        fontSize: 12.5,
                        fontWeight: 600,
                        padding: "6px 12px",
                        borderRadius: 8,
                      }}
                    >
                      {paying ? "Paying…" : "Pay deposit with $VRX"}
                    </button>
                    {payErr[payKey] && (
                      <div style={{ fontSize: 11, color: T.danger, marginTop: 5 }}>{payErr[payKey]}</div>
                    )}
                  </div>
                )
              )}
              <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>
                Floor {u.specs.floor} · {u.specs.sqm} m²
                {u.specs.view ? ` · ${u.specs.view}` : ""}
                {u.specs.baths ? ` · ${u.specs.baths} bath` : ""}
                {u.specs.corner ? " · corner" : ""}
              </div>

              {eligible && u.detail ? (
                <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
                  <div style={{ fontSize: 17, fontWeight: 700, color: T.vetted }}>
                    ${u.detail.priceUsd.toLocaleString()}
                  </div>
                  {u.detail.note && <div style={{ fontSize: 12.5, opacity: 0.7, marginTop: 4 }}>{u.detail.note}</div>}
                  {/* F4: unit-SPECIFIC imagery (the floorplan today) unlocks ONLY now, with the price —
 the two-stage reveal withholds before eligibility. Array so per-unit photos slot in later. */}
                  {u.unitPhotos.length > 0 && (
                    <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                      {u.unitPhotos.map((src) => (
                        <div key={src} style={{ width: "100%", background: T.bg, borderRadius: 6, overflow: "hidden" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={src}
                            alt={`${u.specs.label} — unit detail`}
                            style={{ width: "100%", height: "auto", display: "block" }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  {/* a cleared buyer can now ACT on the card — review full detail, or reserve straight away
                      (which deep-links into the desk chat so the proven AI hold flow runs). Not shown once held
                      (the unit already has its $VRX pay action above). stopPropagation so these don't also open
                      the review overlay that the whole card triggers. */}
                  {!isHeld && (
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => setReviewUnit(u)}
                        style={{ background: "none", border: `1px solid ${T.border}`, color: T.text, cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: "6px 12px", borderRadius: 8 }}
                      >
                        Review
                      </button>
                      <button
                        type="button"
                        onClick={() => onReserve(u.building, u.unit, u.specs.label)}
                        style={{ background: T.accent, border: "none", color: "#fff", cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: "6px 12px", borderRadius: 8 }}
                      >
                        Reserve this unit
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
                  <div style={{ fontSize: 13, color: "#e0c67c" }}>Price unlocks when you&apos;re ready for an offer</div>
                  <p style={{ fontSize: 11.5, opacity: 0.55, margin: "6px 0 0" }}>
                    Complete &amp; seal your profile and fund your wallet to see the price and make an offer.
                  </p>
                </div>
              )}
              {/* "Not interested" — every card gets an exit (the gap: revealed units accumulated with
                  no way to close them). Dismiss releases the buyer's own grant + notifies the desk they passed.
 stopPropagation so it doesn't open the review overlay. (Step 6): once the deposit is PAID the
                  deal is binding — a casual "Not interested" that silently releases the grant is WRONG, so it's
                  hidden; the explicit withdraw lives in the agreement block above (PaidAgreement). */}
              {!paidVrx && (
                <div style={{ marginTop: 10, textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    disabled={dismissing}
                    onClick={() => void dismiss(u.building, u.unit)}
                    style={{ background: "none", border: "none", color: T.dim, cursor: dismissing ? "default" : "pointer", fontSize: 11.5, textDecoration: "underline", padding: 0 }}
                  >
                    {dismissing ? "Removing…" : "Not interested"}
                  </button>
                </div>
              )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Red-card alert popup (the headline UX): the MISSING list comes straight from the server's
          per-developer readiness; the primary button deep-links the profile view focused on those fields. */}
      {alertUnit && (
        <VerifyAlert
          unit={alertUnit}
          onClose={() => setAlertUnit(null)}
          onFix={() => {
            const u = alertUnit;
            setAlertUnit(null);
            onFixProfile({ focusFields: u.readiness.missing, forDeveloper: u.developerName });
          }}
        />
      )}

      {/* the unit review overlay — full detail for a cleared buyer who tapped a card. Reserve from here
          deep-links into the desk chat; "Not interested" dismisses. */}
      {reviewUnit && (() => {
        const heldRec = held.find((h) => h.building === reviewUnit.building && h.unit === reviewUnit.unit && h.holdUntil / 1e6 > Date.now());
        return (
          <UnitReview
            unit={reviewUnit}
            account={account}
            held={!!heldRec}
            paidVrx={!!heldRec?.paidVrx}
            dismissing={dismissingKey === `${reviewUnit.building}:${reviewUnit.unit}`}
            onClose={() => setReviewUnit(null)}
            onChanged={refresh}
            onReserve={(composed) => {
              const u = reviewUnit;
              setReviewUnit(null);
              onReserve(u.building, u.unit, u.specs.label, composed);
            }}
            onDismiss={() => void dismiss(reviewUnit.building, reviewUnit.unit)}
          />
        );
      })()}
    </section>
  );
}

// ── PaidAgreement (Step 6) — the post-payment surface on a PAID held unit card. Once the deposit is paid
//    the deal is binding, so the card must lead to the AGREED Sale & Purchase agreement (not an indicative plan)
//    and offer an EXPLICIT withdraw path rather than a casual dismiss. The offer's requestId is a server-side
//    hash the buyer can't compute, so we resolve it (scoped) via /api/conversations-direct/offer?account=&building=
//    — the deposit-pay path auto-materializes the offer, so it appears shortly after payment. Polls gently until
//    it's ready, then renders the shared SaleContractButton (buyer sees their own copy, full) + a withdraw request
//    that POSTS to the desk (no silent grant release / refund — the desk handles the money). ──────────────────────
function PaidAgreement({ account, building, unit, onChanged }: { account: string; building: string; unit: string; onChanged: () => void }) {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await fetch(
        `/api/conversations-direct/offer?account=${encodeURIComponent(account)}&building=${encodeURIComponent(building)}`
      ).then((r) => r.json());
      setRequestId(typeof j.requestId === "string" ? j.requestId : null);
    } catch {
      /* transient — the poll retries */
    }
  }, [account, building]);

  useEffect(() => {
    void load();
    // Poll until the auto-materialized offer is resolvable (it lands moments after the pay debit), then stop
    // hammering once we have it. Visible-tab only; a cheap first-party read.
    const t = setInterval(() => {
      if (requestId) return;
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => clearInterval(t);
  }, [load, requestId]);

  const requestWithdraw = useCallback(async () => {
    if (!window.confirm("Withdraw from this purchase? Your deposit has been paid — the sales desk will follow up about a refund. This does not instantly reverse the payment.")) return;
    setWithdrawing(true);
    try {
      const res = await fetch("/api/unit-grants", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request-withdraw", account, building, unit }),
      });
      if (res.ok) {
        setWithdrawn(true);
        onChanged();
      }
    } catch {
      /* transient — the buyer can retry */
    } finally {
      setWithdrawing(false);
    }
  }, [account, building, unit, onChanged]);

  return (
    <div style={{ marginTop: 8 }}>
      {requestId ? (
        <SaleContractButton requestId={requestId} viewer={account} label="View / sign agreement" />
      ) : (
        <div style={{ fontSize: 11.5, opacity: 0.6 }}>Preparing your sale agreement…</div>
      )}
      <div style={{ marginTop: 8 }}>
        {withdrawn ? (
          <div style={{ fontSize: 11, color: T.dim }}>Withdrawal requested — the desk will be in touch.</div>
        ) : (
          <button
            type="button"
            disabled={withdrawing}
            onClick={() => void requestWithdraw()}
            style={{ background: "none", border: "none", color: T.dim, cursor: withdrawing ? "default" : "pointer", fontSize: 11, textDecoration: "underline", padding: 0 }}
          >
            {withdrawing ? "Requesting…" : "Withdraw from this purchase"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Indicative payment-plan preview (CLIENT) — mirrors the illustrative off_plan_standard shape the desk
//    uses on the S&P (directPlanFromTemplate), but inline here because that builder is server-only (fs/crypto)
//    and must not enter the client bundle. 10% deposit + 6 equal instalments; the last carries the remainder so
//    the total reconciles to price exactly. Deposit is the FIRST schedule line = deductible from the price (not
//    an extra charge). This is a display preview; the binding plan is sealed server-side. Null below any price. ─
// ── A short human description of a composed offer for the reserve chat message — "10% deposit, 6
//    instalments, 15% on transfer". Percentages are of the unit price (the figures the desk evaluates against
//  the caps). Neutral money structure only (no PII) — to put in the thread. ────────────────────────
function describePlan(p: AssembledPlan): string {
  const pct = (usd: number) => (p.priceUsd > 0 ? Math.round((usd / p.priceUsd) * 100) : 0);
  const parts: string[] = [`${pct(p.depositUsd)}% deposit`];
  if (p.onContractUsd > 0) parts.push(`${pct(p.onContractUsd)}% on contract`);
  if (p.instalmentCount > 0) parts.push(`${p.instalmentCount} instalments`);
  if (p.onKeyUsd > 0) parts.push(`${pct(p.onKeyUsd)}% on transfer`);
  if (p.furnitureUsd > 0) parts.push(`furniture package`);
  return parts.join(", ");
}

function buildIndicativePlan(priceUsd: number): { schedule: { label: string; amountUsd: number }[] } | null {
  const price = Math.max(0, Math.round(priceUsd));
  if (price <= 0) return null;
  const deposit = Math.round(price * 0.1);
  const balance = Math.max(0, price - deposit);
  const n = 6;
  const each = Math.floor(balance / n);
  const schedule: { label: string; amountUsd: number }[] = [{ label: "Deposit", amountUsd: deposit }];
  for (let i = 1; i <= n; i++) {
    const amt = i === n ? balance - each * (n - 1) : each; // last instalment carries the remainder → reconciles
    schedule.push({ label: `Instalment ${i}`, amountUsd: amt });
  }
  return { schedule };
}

// ── The unit review overlay — the full detail surface a cleared buyer gets by tapping an opened-unit
//  card. Before this, a revealed unit was inert: no way to inspect it, reserve it, or dismiss it (the
//  gap flagged). It reuses what the grant route already returns for an eligible buyer (hero + floorplan,
//    full specs, price, note) and adds a PAYMENT-PLAN PREVIEW so the buyer sees the deposit/instalment shape and
//    that the deposit is deductible from the price — BEFORE they reserve. The plan here is an INDICATIVE preview
//  (the real sealed plan is built by the desk on the S&P — directPlanFromTemplate); we show the standard
//    off-plan structure with a nominal 10% deposit so the numbers are honest-but-clearly-illustrative. Reserve
//    deep-links into the desk chat (the proven AI hold flow); dismiss releases the grant. ──────────────────────
function UnitReview({
  unit,
  account,
  held,
  paidVrx,
  dismissing,
  onClose,
  onChanged,
  onReserve,
  onDismiss,
}: {
  unit: OpenedUnit;
  account: string;
  held: boolean;
  /** (Step 6): deposit paid → the deal is binding; the overlay shows the AGREED agreement, not a compose UI. */
  paidVrx: boolean;
  dismissing: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** Reserve now carries the composed offer (the plan the buyer built) when terms are available, so the
   *  deposit/seal reflect what they actually set — not a fixed template. Absent plan → the proven template path. */
  onReserve: (composed?: AssembledPlan) => void;
  onDismiss: () => void;
}) {
  const price = unit.detail?.priceUsd ?? 0;
  const terms = unit.detail?.terms ?? null;
  // the OFFER-BUILDER. When the developer published payment terms (caps) AND the buyer isn't already
  // held, let them COMPOSE their own plan with the A4 calculator (sliders bound to the dev's ranges), so the
  // "fill in the payment plan within the caps" step asked for lives right in the review overlay. The
  // composed plan is captured here and carried into Reserve. When no terms exist (or the unit is already held),
  // we fall back to the static indicative preview (the shape). PaymentCalculator reads only building
  // .reservationFeeUsd + unit.priceUsd/.sqm, so a minimal projection from the OpenedUnit is enough.
  const canCompose = !held && !!terms && price > 0;
  const [composed, setComposed] = useState<AssembledPlan | null>(null);
  const calcUnit = { id: unit.unit, type: unit.specs.type, floor: unit.specs.floor, sqm: unit.specs.sqm, priceUsd: price } as unknown as Unit;
  const calcBuilding = { id: unit.building, name: unit.buildingName } as unknown as Building;
  const verdict: OfferVerdict | null = canCompose && composed ? evaluateOffer(composed, terms) : null;
  // Indicative fallback: when we can't compose (no terms / already held), show the illustrative off-plan
  // split inline (the off_plan_standard shape; the binding plan is sealed server-side via directPlanFromTemplate).
  const plan = canCompose ? null : buildIndicativePlan(price);
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 100, padding: 20, overflowY: "auto" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card, maxWidth: 560, width: "100%", marginTop: 0, maxHeight: "90vh", overflowY: "auto" }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <h2 style={{ fontSize: 19, margin: 0 }}>{unit.specs.label}</h2>
          <span style={{ fontSize: 12, fontFamily: T.mono, opacity: 0.6 }}>{unit.unit}</span>
        </div>
        <div style={{ fontSize: 13, opacity: 0.7, marginTop: 2 }}>{unit.buildingName} · {unit.developerName}</div>

        {held && (
          <div style={{ fontSize: 12.5, color: T.vetted, marginTop: 10, fontWeight: 600 }}>
            {paidVrx
              ? "✓ Deposit paid — your purchase is reserved and the sale agreement is ready."
              : "✓ Reserved for you — this unit is firm-held on-chain while you proceed."}
          </div>
        )}

        {/* Imagery — a CAROUSEL of every image applicable to this unit's SUBTYPE: building
            exterior → facilities → representative interiors → the subtype floorplan (the IMAGE_SETS schema in
            lib/mm; no other-unit art, privacy-safe). The grant route resolves `gallery` once offer-eligible;
            before eligibility (no gallery) we show the building hero alone. */}
        {(() => {
          const imgs = unit.gallery && unit.gallery.length > 0 ? unit.gallery : unit.photo ? [unit.photo] : [];
          return imgs.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <Carousel images={imgs} alt={`${unit.buildingName} — ${unit.specs.label}`} aspectRatio="3 / 2" />
            </div>
          ) : null;
        })()}

        {/* Specs */}
        <div style={{ fontSize: 14, marginTop: 14, lineHeight: 1.7 }}>
          Floor {unit.specs.floor} · {unit.specs.sqm} m²
          {unit.specs.view ? ` · ${unit.specs.view}` : ""}
          {unit.specs.baths ? ` · ${unit.specs.baths} bath` : ""}
          {unit.specs.corner ? " · corner" : ""}
        </div>

        {/* Price + payment plan. when the developer published terms, the buyer COMPOSES their offer here
            (the A4 calculator, sliders bound to the dev's caps); otherwise the static indicative preview. */}
        {unit.detail ? (
          <div style={{ marginTop: 14, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: T.vetted }}>${price.toLocaleString()}</div>
            {unit.detail.note && <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>{unit.detail.note}</div>}

            {paidVrx ? (
              //  (Step 6): paid → the deal is binding; surface the AGREED Sale & Purchase agreement + the
              // explicit withdraw path (no compose, no indicative preview — the plan is locked into the S&P).
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.6, marginBottom: 10 }}>
                  Your sale agreement
                </div>
                <PaidAgreement account={account} building={unit.building} unit={unit.unit} onChanged={onChanged} />
              </div>
            ) : canCompose && terms ? (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.6, marginBottom: 10 }}>
                  Design your offer
                </div>
                <PaymentCalculator building={calcBuilding} unit={calcUnit} terms={terms} onChange={setComposed} />
                {/* Live verdict (honesty fix — the "make the copy honest" note). The sliders are bound to
                    the derived caps, so a composed offer sits within the published RANGES by construction. But
                    "within the ranges" is a fact about the caps, NOT a promise the desk auto-accepts — the desk
 still confirms the exact structure (the discrete-options vs ranges gap). So the copy says
                    "within the published ranges" + "the desk confirms", never "accepted". Off-range → ask the desk. */}
                {verdict && (
                  <div
                    style={{
                      marginTop: 14,
                      padding: "10px 12px",
                      borderRadius: 8,
                      fontSize: 12.5,
                      border: `1px solid ${verdict.withinCaps ? "rgba(56,211,159,0.4)" : "rgba(232,184,75,0.45)"}`,
                      background: verdict.withinCaps ? "rgba(56,211,159,0.06)" : "rgba(232,184,75,0.06)",
                      color: verdict.withinCaps ? T.vetted : T.hold,
                      fontWeight: 600,
                    }}
                  >
                    {verdict.withinCaps
                      ? "✓ Within the developer's published ranges — reserve to put this plan to the desk to confirm."
                      : `⚠ Off-standard: ${verdict.summary} Reserve to ask the desk to consider it.`}
                  </div>
                )}
                <p style={{ fontSize: 11.5, opacity: 0.55, margin: "12px 0 0", lineHeight: 1.5 }}>
                  Set your plan within the developer&apos;s published ranges. The desk confirms the exact structure
                  when you reserve. The reservation deposit is deductible from the price. Your binding plan is
                  finalised with the desk on the sale agreement.
                </p>
                {/* the ONE thing the sliders can't express: terms OUTSIDE the published range. The buyer
                    asks the developer directly via a short form (no AI turn); it lands on the developer's /node
                    "Term requests" queue. The server refuses an in-range figure (telling them to use the sliders). */}
                <AskTermsControl account={account} building={unit.building} />
              </div>
            ) : (
              plan && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.6, marginBottom: 8 }}>
                    Indicative payment plan
                  </div>
                  <div style={{ display: "grid", gap: 4 }}>
                    {plan.schedule.map((r, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
                        <span style={{ opacity: 0.8 }}>{r.label}</span>
                        <span style={{ fontFamily: T.mono }}>${r.amountUsd.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: 11.5, opacity: 0.55, margin: "10px 0 0", lineHeight: 1.5 }}>
                    Illustrative structure — your binding plan is finalised with the desk on the sale agreement. The
                    reservation deposit is deductible from the price (it is the first line above, not an extra charge).
                  </p>
                </div>
              )
            )}
          </div>
        ) : (
          <div style={{ marginTop: 14, borderTop: `1px solid ${T.border}`, paddingTop: 14, fontSize: 13, color: "#e0c67c" }}>
            Complete &amp; seal your profile and fund your wallet to unlock the exact price and payment plan.
          </div>
        )}

        {/* Actions. (Step 6): once paid, "Not interested" is WRONG (the deal is binding) — it's hidden; the
            explicit withdraw lives in the agreement block above. */}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
          {!paidVrx ? (
            <button
              type="button"
              disabled={dismissing}
              onClick={onDismiss}
              style={{ background: "none", border: "none", color: T.dim, cursor: dismissing ? "default" : "pointer", fontSize: 12.5, textDecoration: "underline", padding: 0 }}
            >
              {dismissing ? "Removing…" : "Not interested"}
            </button>
          ) : (
            <span />
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              style={{ background: "none", border: `1px solid ${T.border}`, color: T.dim, fontSize: 13.5, cursor: "pointer", padding: "7px 14px", borderRadius: 8 }}
            >
              Close
            </button>
            {!held && (
              <button type="button" onClick={() => onReserve(composed ?? undefined)} style={{ ...submitBtn, margin: 0 }}>
                {canCompose ? "Reserve with this offer →" : "Reserve this unit →"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The red-card alert popup — "to proceed with {building} ({developer}) you still need: X, Y". If the only
//    gap is the seal (fields met but unsealed), it says so. Primary button → deep-link into the profile view. ─
function VerifyAlert({ unit, onClose, onFix }: { unit: OpenedUnit; onClose: () => void; onFix: () => void }) {
  const { missing, sealed } = unit.readiness;
  const fieldsGap = missing.length > 0;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card, maxWidth: 420, width: "100%", border: `1px solid ${T.danger}`, marginTop: 0 }}
      >
        <div style={{ fontSize: 16.5, fontWeight: 700, marginBottom: 6 }}>Verification needed</div>
        <p style={{ fontSize: 14, lineHeight: 1.55, opacity: 0.9, margin: "0 0 12px" }}>
          To proceed with <strong>{unit.buildingName}</strong> ({unit.developerName}) you still need to{" "}
          {fieldsGap ? (
            <>provide: <strong>{labelFields(missing)}</strong>{!sealed ? ", then seal your profile." : "."}</>
          ) : (
            <>seal your profile — your details are complete but not yet sealed.</>
          )}
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ background: "none", border: `1px solid ${T.border}`, color: T.dim, fontSize: 13.5, cursor: "pointer", padding: "7px 14px", borderRadius: 8 }}
          >
            Not now
          </button>
          <button onClick={onFix} style={{ ...submitBtn, margin: 0 }}>
            {fieldsGap ? "Add these details →" : "Seal my profile →"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.6 }}>{label}</div>
      <div style={{ fontSize: 15.5, fontWeight: 600, color: accent ? T.vetted : T.text, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ── Profile panel (the buyer's own KYC — wallet-keyed, saved server-side; no chain) ─────────────────────
const PROFILE_FIELDS: Array<{ key: keyof BuyerProfile; label: string; required?: boolean; kyc?: boolean }> = [
  { key: "name", label: "Display name", required: true },
  { key: "legalName", label: "Full legal name (as on ID/passport)", kyc: true },
  { key: "nationality", label: "Nationality", kyc: true },
  { key: "phone", label: "Phone", kyc: true },
  { key: "email", label: "Email" },
  { key: "passportNo", label: "Passport no." },
  { key: "idCardNo", label: "National ID no." },
  { key: "address", label: "Residential address" },
];

// ── MyProfileView — the full-width profile & verification surface (Phase 2). Replaces the old inline
//    panel. Three states driven by the record's seal: DRAFT (editable, Save; Seal appears once required met),
//    SEALED (read-only, Re-open to edit), and the deep-link FOCUS (red-card popup passes the missing fields +
//    the developer that needs them — we highlight exactly those inputs). The append-only trail + the lock are
//    server-enforced (lib/buyers-direct); this view just reflects/triggers them. ─────────────────────────────
function MyProfileView({
  account,
  record,
  kycMet,
  focus,
  onSaved,
  onBack,
}: {
  account: string;
  record: BuyerRecord | null;
  kycMet: boolean;
  focus: ProfileFocus;
  onSaved: () => Promise<void>;
  onBack: () => void;
}) {
  const [form, setForm] = useState<BuyerProfile>({ name: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const sealed = !!record?.sealed;
  const focusSet = new Set(focus.focusFields ?? []);
  const firstFocusRef = useRef<HTMLInputElement | null>(null);

  // Seed the form from the saved record whenever it (re)loads.
  useEffect(() => {
    if (record?.profile) setForm(record.profile);
  }, [record]);

  // Deep-link: scroll/focus the FIRST missing field the red-card popup asked for (once, on open).
  useEffect(() => {
    if (focus.focusFields?.length && !sealed) {
      const t = setTimeout(() => {
        firstFocusRef.current?.focus();
        firstFocusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 80);
      return () => clearTimeout(t);
    }
  }, [focus.focusFields, sealed]);

  // Which DEFAULT required fields are still blank (for the inline "needed for an offer" hint + Seal gate).
  const requiredBlank = (["legalName", "nationality", "phone"] as Array<keyof BuyerProfile>).filter(
    (k) => !(form[k] ?? "").trim(),
  );
  const canSeal = record?.profileSaved && requiredBlank.length === 0 && !sealed;

  async function post(body: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/buyers-direct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, ...body }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Something went wrong");
      setMsg(okMsg);
      await onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const firstFocusKey = focus.focusFields?.[0];

  return (
    <section style={{ ...card, marginTop: 24 }}>
      <button
        onClick={onBack}
        style={{ background: "none", border: `1px solid ${T.accentSoft}`, color: T.accent, fontSize: 13.5, fontWeight: 600, cursor: "pointer", padding: "5px 12px", borderRadius: 8, marginBottom: 14 }}
      >
        ← Back
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 23, margin: 0 }}>My profile &amp; verification</h2>
        {record?.profileSaved && (
          <span
            style={{
              fontSize: 12,
              padding: "2px 9px",
              borderRadius: 999,
              border: `1px solid ${sealed ? "#2f5f3f" : "#5a4a2a"}`,
              color: sealed ? "#7ce0a0" : "#e0c67c",
            }}
          >
            {sealed ? "✓ Sealed" : kycMet ? "Ready to seal" : "Incomplete"}
          </span>
        )}
      </div>
      <p style={{ fontSize: 13.5, opacity: 0.7, lineHeight: 1.5, margin: "6px 0 0", maxWidth: 640 }}>
        Saved privately against your wallet — nothing goes on-chain. Full legal name, nationality and phone are
        needed before you can make an offer; a developer may ask for more. Once you <strong>seal</strong> your
        profile it&apos;s locked — to change it you re-open, and every change is recorded.
      </p>

      {focus.forDeveloper && !sealed && (
        <div style={{ marginTop: 12, fontSize: 13, color: "#e8c876", border: `1px solid ${T.hold}`, background: "rgba(232,184,75,0.08)", borderRadius: 8, padding: "8px 12px" }}>
          Required by <strong>{focus.forDeveloper}</strong>
          {focus.focusFields?.length ? <> — add {labelFields(focus.focusFields)} below.</> : null}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "0 14px" }}>
          {PROFILE_FIELDS.map((f) => {
            const highlighted = focusSet.has(f.key);
            return (
              <div key={f.key}>
                <label style={lbl}>
                  {f.label}
                  {f.required && <span style={{ color: "#e0a0a0" }}> *</span>}
                  {f.kyc && <span style={{ color: T.faint, fontSize: 11 }}> (for offers)</span>}
                </label>
                <input
                  ref={f.key === firstFocusKey ? firstFocusRef : undefined}
                  style={{
                    ...input,
                    ...(highlighted ? { borderColor: T.hold, boxShadow: `0 0 0 1px ${T.hold}` } : null),
                    ...(sealed ? { opacity: 0.6, cursor: "not-allowed" } : null),
                  }}
                  value={form[f.key] ?? ""}
                  readOnly={sealed}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            );
          })}
        </div>

        {/* Actions — the three-state control surface. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          {sealed ? (
            confirmReopen ? (
              <>
                <span style={{ fontSize: 13, opacity: 0.8 }}>Re-open to edit? Your change will be recorded.</span>
                <button onClick={() => { setConfirmReopen(false); void post({ action: "reopen" }, "Re-opened — you can edit now."); }} disabled={busy} style={submitBtn}>
                  {busy ? "…" : "Yes, re-open"}
                </button>
                <button onClick={() => setConfirmReopen(false)} style={{ background: "none", border: `1px solid ${T.border}`, color: T.dim, fontSize: 13.5, cursor: "pointer", padding: "7px 14px", borderRadius: 8 }}>
                  Cancel
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmReopen(true)} style={submitBtn}>Re-open to edit</button>
            )
          ) : (
            <>
              <button onClick={() => void post({ profile: form }, "Profile saved.")} disabled={busy || !form.name.trim()} style={submitBtn}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => void post({ action: "seal" }, "Profile sealed — it's now locked.")}
                disabled={busy || !canSeal}
                title={canSeal ? "Lock your profile to attest it" : "Fill full legal name, nationality and phone first, and save"}
                style={{ ...submitBtn, background: canSeal ? T.vetted : T.panel2, color: canSeal ? "#07140e" : T.faint, border: `1px solid ${canSeal ? T.vetted : T.border}` }}
              >
                Seal profile
              </button>
            </>
          )}
          {msg && <span style={{ fontSize: 13, opacity: 0.75 }}>{msg}</span>}
        </div>

        {!sealed && requiredBlank.length > 0 && (
          <p style={{ fontSize: 12.5, color: "#e0c67c", margin: "8px 0 0" }}>
            To seal (and make an offer) you still need: {labelFields(requiredBlank)}.
          </p>
        )}
        {(record?.historyCount ?? 0) > 0 && (
          <p style={{ fontSize: 12, opacity: 0.55, margin: "8px 0 0" }}>
            Changes are recorded — {record!.historyCount} earlier version{record!.historyCount === 1 ? "" : "s"} on file.
          </p>
        )}

        <VisibilityDial account={account} record={record} onSaved={onSaved} />

        <BuyerDocs account={account} />
      </div>
    </section>
  );
}

// ── VisibilityDial — the buyer's per-field "what the desk sees" control (the B slice of the direct-
//  negotiation arc; the design docs §2). By DEFAULT the desk sees a masked hint of the
//    buyer's identity (name hint + nationality; passport/ID/address/contact hidden) — this protects the buyer
//    from being poached/profiled before they decide to engage. Here the buyer can CHOOSE to open specific
//    fields up-front. It changes only what a COUNTERPARTY sees; the buyer's own record is unchanged, and the
//    seal is untouched (it's a view preference, not attested identity — server enforces via publicDirectProfileView).
//    Only ever RELAXES the default — a field the buyer doesn't open stays masked. ──────────────────────────────

// The SYSTEM default visibility per field (mirrors lib/buyer-mask DIRECT_PROFILE_MASK). Shown as the baseline
// a buyer's choice starts from; an absent override entry means "use this default".
const DIAL_DEFAULT: Record<string, VisMode> = {
  name: "partial",
  legalName: "hide",
  nationality: "show",
  phone: "hide",
  email: "hide",
  passportNo: "hide",
  idCardNo: "hide",
  address: "hide",
};

// The order the dial lists fields (same as the editor). `name` + `nationality` lead because they're the fields
// the default already reveals; the rest are the sensitive ones the buyer may optionally open.
const DIAL_FIELDS: Array<keyof BuyerProfile> = [
  "name", "nationality", "legalName", "phone", "email", "passportNo", "idCardNo", "address",
];

const VIS_LABEL: Record<VisMode, string> = { show: "Show", partial: "Hint", hide: "Hide" };
const VIS_HINT: Record<VisMode, string> = {
  show: "Desk sees the full value",
  partial: "Desk sees a dotted hint (e.g. J••e W••g)",
  hide: "Desk sees nothing until you agree to reveal",
};

function VisibilityDial({
  account,
  record,
  onSaved,
}: {
  account: string;
  record: BuyerRecord | null;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Working copy of the override map, seeded from the record. Only fields the buyer changed FROM the default
  // are sent (the server merges the override over the default anyway, but keeping it minimal is cleaner).
  const [dial, setDial] = useState<Record<string, VisMode>>({});

  useEffect(() => {
    // Seed from the record, dropping any undefined-valued entries so the state's value type stays VisMode.
    const seed: Record<string, VisMode> = {};
    for (const [k, v] of Object.entries(record?.maskOverride ?? {})) {
      if (v) seed[k] = v;
    }
    setDial(seed);
  }, [record]);

  // The effective mode for a field = the buyer's override if set, else the system default.
  const modeOf = (k: string): VisMode => dial[k] ?? DIAL_DEFAULT[k] ?? "hide";

  function setMode(k: string, mode: VisMode) {
    setDial((prev) => {
      const next = { ...prev };
      // If the choice equals the default, drop the key (keep the override minimal). Else record it.
      if (mode === (DIAL_DEFAULT[k] ?? "hide")) delete next[k];
      else next[k] = mode;
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/buyers-direct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, action: "visibility", override: dial }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not save");
      setMsg("Saved — the desk now sees only what you chose.");
      await onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  // Only meaningful once a profile exists (nothing to show a desk otherwise).
  if (!record?.profileSaved) return null;

  // How many fields the buyer has opened beyond the default (for the collapsed summary).
  const openedCount = DIAL_FIELDS.filter((k) => modeOf(k) !== (DIAL_DEFAULT[k] ?? "hide") && modeOf(k) !== "hide").length;

  return (
    <div style={{ marginTop: 22, borderTop: `1px solid ${T.border}`, paddingTop: 18 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", color: T.text, fontSize: 15.5, fontWeight: 600, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 8 }}
      >
        <span style={{ fontSize: 12, opacity: 0.6 }}>{open ? "▾" : "▸"}</span>
        What the sales desk can see about you
      </button>
      <p style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.55, margin: "8px 0 0", maxWidth: 640 }}>
        By default a desk sees only a <strong>masked hint</strong> of who you are — enough to talk about a unit,
        not enough to identify or contact you behind our back. This protects you until <em>you</em> decide to
        share more. You can open specific details up-front here, or keep everything hidden and reveal later in
        the conversation. {openedCount > 0
          ? <strong>You&apos;ve chosen to show {openedCount} extra field{openedCount === 1 ? "" : "s"}.</strong>
          : "Right now the desk sees only the default hint."}
      </p>

      {open && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "grid", gap: 16 }}>
            {DIAL_FIELDS.map((k) => {
              const cur = modeOf(k);
              const hasVal = (record.profile[k] ?? "").trim();
              return (
                // Mobile-first: the field label, then a 3-up segmented control that NEVER breaks internally
                // (each button is flex:1, group is nowrap), then the hint on its own muted line. On a narrow
                // phone the whole block stacks cleanly instead of the old wrap where buttons spilled a row.
                <div key={k} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 13.5, opacity: hasVal ? 1 : 0.45 }}>
                    {FIELD_LABEL[k] ?? k}
                    {!hasVal && <span style={{ fontSize: 11, opacity: 0.6 }}> (empty)</span>}
                  </span>
                  <div style={{ display: "flex", flexWrap: "nowrap", border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
                    {(["show", "partial", "hide"] as VisMode[]).map((mode) => {
                      const active = cur === mode;
                      return (
                        <button
                          key={mode}
                          onClick={() => setMode(k, mode)}
                          title={VIS_HINT[mode]}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            background: active ? (mode === "show" ? T.vetted : mode === "partial" ? T.hold : T.panel2) : "transparent",
                            color: active ? (mode === "hide" ? T.text : "#07140e") : T.dim,
                            border: "none",
                            borderLeft: mode !== "show" ? `1px solid ${T.border}` : "none",
                            fontSize: 12.5,
                            fontWeight: active ? 700 : 500,
                            cursor: "pointer",
                            padding: "7px 8px",
                          }}
                        >
                          {VIS_LABEL[mode]}
                        </button>
                      );
                    })}
                  </div>
                  <span style={{ fontSize: 11.5, opacity: 0.55 }}>{VIS_HINT[cur]}</span>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
            <button onClick={() => void save()} disabled={busy} style={submitBtn}>
              {busy ? "Saving…" : "Save visibility"}
            </button>
            {msg && <span style={{ fontSize: 13, opacity: 0.75 }}>{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Identity documents (buyer uploads their OWN selfie + passport/ID — encrypted at rest, buyer-owned vault) ──
const DOC_KINDS: Array<{ kind: "headshot" | "passport" | "id_card"; label: string; hint: string }> = [
  { kind: "headshot", label: "Selfie / headshot", hint: "A clear photo of your face" },
  { kind: "passport", label: "Passport", hint: "Photo page" },
  { kind: "id_card", label: "National ID", hint: "Front of your ID card" },
];

type VaultDoc = { id: string; kind: string; filename: string; mime: string; size: number; at: number };

const docUrl = (account: string, docId: string) =>
  `/api/buyer-vault/doc?account=${encodeURIComponent(account)}&docId=${encodeURIComponent(docId)}`;

const KIND_LABEL: Record<string, string> = { headshot: "Selfie / headshot", passport: "Passport", id_card: "National ID" };

function BuyerDocs({ account }: { account: string }) {
  const [docs, setDocs] = useState<VaultDoc[]>([]);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);

  // The lightbox shows ALL attached docs in a fixed order; a thumbnail click opens at its position.
  const gallery = docs.map((d) => ({ url: docUrl(account, d.id), caption: KIND_LABEL[d.kind] ?? d.kind }));

  const refresh = useCallback(async () => {
    try {
      const j = await fetch(`/api/buyer-vault?account=${encodeURIComponent(account)}`).then((r) => r.json());
      setDocs(j.docs ?? []);
    } catch {
      /* leave as-is */
    }
  }, [account]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(kind: string, file: File) {
    setBusyKind(kind);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("account", account);
      fd.append("kind", kind);
      fd.append("file", file);
      const res = await fetch("/api/buyer-vault", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Upload failed");
      setDocs(j.docs ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusyKind(null);
    }
  }

  async function remove(docId: string) {
    const res = await fetch(`/api/buyer-vault?account=${encodeURIComponent(account)}&docId=${encodeURIComponent(docId)}`, { method: "DELETE" });
    const j = await res.json();
    setDocs(j.docs ?? []);
  }

  return (
    <div style={{ marginTop: 20, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Identity documents</div>
      <p style={{ fontSize: 12.5, opacity: 0.65, lineHeight: 1.5, margin: "0 0 12px" }}>
        Upload a selfie and your passport or ID. Stored <strong>encrypted</strong> and shared only when you
        choose to proceed with a purchase. Images only, up to 8&nbsp;MB each.
      </p>

      {err && <div style={{ ...banner, borderColor: "#5a2a2a", color: "#e0a0a0", marginTop: 0, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
        {DOC_KINDS.map(({ kind, label, hint }) => {
          const existing = docs.find((d) => d.kind === kind);
          return (
            <div
              key={kind}
              style={{
                border: `1px solid ${T.border}`,
                borderRadius: 10,
                overflow: "hidden",
                background: T.bg2,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  aspectRatio: "3 / 4", // portrait — IDs/passports/headshots are taller than wide
                  flexShrink: 0,
                  background: "#0b0e16",
                  display: "grid",
                  placeItems: "center",
                  overflow: "hidden",
                }}
              >
                {existing ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={docUrl(account, existing.id)}
                    alt={label}
                    title="Click to enlarge"
                    onClick={() => {
                      const gi = docs.findIndex((d) => d.id === existing.id);
                      if (gi >= 0) setLightbox(gi);
                    }}
                    // cover the portrait frame fully (no black bands); the lightbox shows the WHOLE image.
                    style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block", cursor: "zoom-in" }}
                  />
                ) : (
                  <span style={{ fontSize: 28, opacity: 0.3 }}>+</span>
                )}
              </div>
              <div style={{ padding: "10px 11px 12px", background: T.bg2, position: "relative", zIndex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {label} {existing && <span style={{ color: T.vetted }}>✓</span>}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    opacity: 0.55,
                    marginBottom: 8,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {existing ? existing.filename : hint}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <label
                    style={{
                      display: "inline-block",
                      fontSize: 12.5,
                      padding: "5px 12px",
                      borderRadius: 7,
                      border: `1px solid ${T.border}`,
                      background: "#0e1119",
                      cursor: busyKind === kind ? "wait" : "pointer",
                      opacity: busyKind === kind ? 0.6 : 1,
                    }}
                  >
                    {busyKind === kind ? "Uploading…" : existing ? "Replace" : "Upload"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                      style={{ display: "none" }}
                      disabled={busyKind === kind}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void upload(kind, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {existing && (
                    <button
                      onClick={() => void remove(existing.id)}
                      style={{ fontSize: 12.5, padding: "5px 10px", borderRadius: 7, border: "1px solid #5a2a2a", background: "none", color: "#e0a0a0", cursor: "pointer" }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {lightbox != null && gallery.length > 0 && (
        <Lightbox
          images={gallery.map((g) => g.url)}
          start={lightbox}
          caption={gallery[lightbox]?.caption ?? ""}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
