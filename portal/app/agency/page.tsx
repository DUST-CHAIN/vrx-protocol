"use client";

// Agency app (step 3) — the AGENCY's home. The agency-side twin of the developer dashboard,
// built on the SAME shared seams (the whole point of was to build these once, not bespoke):
//   • its DEAL INBOX reads /api/agency-claims — every booking its own agents opened — over the SAME event
//  MIRROR + /api/claims attested-offer join, and pushes via the SAME useEventStream
// . Read-mostly: the agency OBSERVES its agents' deals (the developer accepts/confirms; the
//  agent books) and TALKS to the developer in the per-booking channel thread.
//  • it proposes/manages COMMISSION AGREEMENTS with developers — the attested record (another
//  record: plaintext off-chain + hash seal + re-hash ✓ VETTED), via /api/agreements.
//  • it manages its own AGENTS (register_peer / deactivate_peer) — the original surface, kept.
//
// WHO SEES THIS APP is decided at VRX-root onboarding and read back on login (lib/role.tsx): the
// connected account's role lands it here. There is deliberately NO persona/identity switch in the UI — the
// role is already fixed upstream, so there is nothing for the user to toggle. (A single owner selling their
// own unit is handled by whatever role they're onboarded as; that's a routing concern, not a mode here.)
//
// VOCAB (vrx-vocab-translation): contract Org = Agency, Peer = Agent, claim = booking, node = developer.
// PRIVACY: the chain carries only opaque hashes + neutral ids; plaintext (offers, agreements, chat)
// stays in the party-private server stores. Agency writes are #[payable] + tolled (V5/) → depositFor(me).

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useWallet } from "@/lib/wallet";
import { useRole } from "@/lib/role";
import {
  hashRef,
  getOrg,
  getPeer,
  registerPeerArgs,
  deactivatePeerArgs,
  depositFor,
  isRequestLapsed,
  requestClock,
  humanDuration,
  CLAIM_STATUS,
  type ClaimWire,
} from "@/lib/vrx";
import { useMoney } from "@/lib/currency";
import { card, lbl, input, submitBtn, banner, mono, statusColor } from "@/lib/ui";
import { seal as sealStyle, chip, T } from "@/lib/theme";
import { commissionReasonCopy, type CommissionReason } from "@/lib/commission-reason";
import { PrivateMark, SealedMark } from "@/lib/marks";
import { ContractModal } from "@/components/ContractModal";
import SaleContractButton from "@/components/SaleContractButton";
import { prettyTerms } from "@/lib/contract";
import { useTxRun, TxProgress } from "@/components/TxAction";
import { useEventStream } from "@/lib/useEventStream";
import { channelTopic } from "@/lib/channel-topic";
import PropertyBrowser from "@/components/PropertyBrowser";
import { timeAgo } from "@/lib/catalog-client";
import { DealChat, type Msg as DealChatMsg } from "@/components/DealChat";
import DashboardShell, { type ShellSection } from "@/components/DashboardShell";
import HaltNotices from "@/components/HaltNotices";
import SettlementView from "@/components/SettlementView";
import AgencyTokensPanel from "@/components/AgencyTokensPanel";
import AgentPerformance from "@/components/AgentPerformance";

export default function AgencyPage() {
  const { accountId, ready, signIn, callFunction } = useWallet();
  const { role } = useRole();
  const [isAgency, setIsAgency] = useState<boolean | null>(null);
  const [gatedBuildingIds, setGatedBuildingIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (!accountId) {
      setIsAgency(null);
      setGatedBuildingIds(null);
      return;
    }
    // Trust a (demo-override) agency role immediately — same pattern as /node + /agent (demo has no chain
    // to register the org on; the role override carries it). (lib/role demoRoleUxArmed)
    if (role === "agency") setIsAgency(true);
    getOrg(accountId)
      .then((o) => {
        const ok = !!o && (o as { a?: boolean }).a !== false;
        if (o === null && role === "agency") return;
        setIsAgency(ok);
      })
      .catch(() => { if (role !== "agency") setIsAgency(false); });
    fetch(`/api/agent/developers?agency=${encodeURIComponent(accountId)}`)
      .then((r) => r.json())
      .then((d: { developers?: { buildings: { id: string }[] }[] }) =>
        setGatedBuildingIds((d.developers ?? []).flatMap((dev) => dev.buildings.map((b) => b.id)))
      )
      .catch(() => setGatedBuildingIds([]));
  }, [accountId]);

  // Dashboard-shell sections — same wrapping as /node + /root: the agency page was already a thin
  // assembler of self-contained sections, so the shell turns the stack into a sidebar view-switcher. The
  // DealInbox is keepAlive (its lifted message threads / unsent drafts must survive switching away — the
  //  "don't wipe the draft" guarantee). The Properties view only appears once the agency has gated
  // access to at least one building. Agency is mostly used on mobile; the shell collapses the sidebar to a
  // chip row below 860px (must not regress). Only built when signed in as an agency.
  const sections: ShellSection[] =
    accountId && isAgency
      ? [
          { id: "deals", label: "Deal inbox", icon: "📥", keepAlive: true, element: <DealInbox me={accountId} /> },
          { id: "agreements", label: "Agreements", icon: "📄", element: <Agreements me={accountId} /> },
          { id: "settlement", label: "Settlement", icon: "💰", element: <SettlementView me={accountId} role="agency" /> },
          { id: "agents", label: "My agents", icon: "👥", element: <ManageAgents me={accountId} callFunction={callFunction} /> },
          { id: "performance", label: "Agent performance", icon: "📊", element: <AgentPerformance me={accountId} /> },
          { id: "tokens", label: "Booking tokens", icon: "🎟", element: <AgencyTokensPanel me={accountId} /> },
          ...(gatedBuildingIds !== null && gatedBuildingIds.length > 0
            ? [{
                id: "properties",
                label: "Properties",
                icon: "🏢",
                element: <PropertyBrowser heading="Properties your agents can offer" filterIds={gatedBuildingIds} account={accountId} />,
              } as ShellSection]
            : []),
        ]
      : [];

  return (
    <DashboardShell
      title="Agency"
      persistKey="agency"
      intro="Your deals, your agents, and your commission agreements"
      banner={<RoleBanner ready={ready} accountId={accountId} isAgency={isAgency} signIn={signIn} />}
      topSlot={accountId && isAgency ? <HaltNotices me={accountId} /> : undefined}
      sections={sections}
    />
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  DEAL INBOX — the agency's master-detail view over /api/agency-claims (read-mostly)
// ════════════════════════════════════════════════════════════════════════════════════════════════
// The agency-side twin of the developer Queue (node/page.tsx). Same spine, but:
//   • scoped to THIS agency's bookings (its agents' deals), not a developer's incoming queue;
//   • READ-MOSTLY — the agency watches status + talks in the thread; it does NOT reply/confirm (that's
//     the developer) and does NOT re-open the booking (that's the agent). So no on-chain write buttons.
//   • shows which AGENT opened each deal + which DEVELOPER it's with (the agency's two extra dimensions).
// Reuses the lessons verbatim: ONE parent owns rows + selection + lifted threads/drafts; the
// Messages tab is a stateless presenter so a status re-render can't wipe an unsent draft; SSE push
// refreshes on real change with a slow safety poll as fallback.

type InboxRow = {
  requestId: string;
  claim: ClaimWire | null;
  offer: OfferRecord | null;
  verified: boolean;
  names: { building?: string; unit?: string } | null;
  agent: string | null;
  developer: string | null;
  /** — commission this agency earns on the sale (null = no live rate). Summed for the dashboard total. */
  commission?: { pct: number; priceUsd: number; amountUsd: number } | null;
  /** H2 — WHY, so a blank earning is explained honestly instead of silent. */
  commissionReason?: CommissionReason;
  baselineAt?: number;
};
type OfferRecord = {
  requestId: string;
  requestHash: string;
  developer: string;
  seal: {
    terms: string;
    plan: AssembledPlanLite | null;
    ownership?: string;
    freehold?: boolean;
    buyer?: unknown;
    by: string;
  };
  display: { buildingId?: string; unitId?: string; buyerType?: string | null };
  /** the off-seal deal progress the agency OBSERVES. `confirmed` = SOLD (developer closed it
   *  on-chain); `contract.stage` = where the S&P document is. The agency reads these to show a deal's real
 * stage; before F3 these were absent from the type so a progressed deal fell to "unknown". */
  confirmed?: { at: number; by: string } | null;
  contract?: { stage: "preview" | "final" | "payment_arrived" | "signed" } | null;
  at: number;
};
type AssembledPlanLite = {
  priceUsd?: number;
  depositUsd?: number;
  onContractUsd?: number;
  onKeyUsd?: number;
  instalmentCount?: number;
  instalmentUsd?: number;
  frequencyDays?: number;
  bookingFeeUsd?: number;
  taxPct?: number;
  furnitureUsd?: number;
  balanced?: boolean;
};
type Msg = DealChatMsg;
type Group = "awaiting" | "held" | "history";

function groupOf(row: InboxRow): Group {
  const s = row.claim?.s;
  if (s === 0 && !isRequestLapsed(row.claim)) return "awaiting";
  if (s === 1) return "held";
  return "history";
}
function rowTitle(row: InboxRow): string {
  const { names, claim } = row;
  if (names?.unit) return `${names.building ?? "Unit"} · unit ${names.unit}`;
  if (claim) return `unit ${(claim.k ?? "").slice(0, 10)}…`;
  return "Booking";
}

// The deal's status for the dot/badge. A deal progresses on-chain (claim.s: open→accepted→declined) and then
// via the OFF-SEAL overlay the agency OBSERVES — `confirmed` (SOLD) and `contract.stage` (where the S&P
// is). Read the MOST ADVANCED signal first: a seeded/closed deal has `claim:null` but a real
// `confirmed`/`contract.stage`, so before F3 it fell through to "unknown". `lapsed` still wins (a timed-
// out open request). Labels map onto statusColor's existing cases so the dot is coloured, not grey-"unknown".
function dealStatus(row: InboxRow): string {
  if (isRequestLapsed(row.claim)) return "lapsed";
  if (row.offer?.confirmed) return "sold";
  switch (row.offer?.contract?.stage) {
    case "signed":
      return "signed";
    case "payment_arrived":
      return "payment received";
    case "final":
      return "ready to sign";
    case "preview":
      return "in contract";
  }
  return row.claim ? CLAIM_STATUS[row.claim.s] ?? String(row.claim.s) : "unknown";
}

function DealInbox({ me }: { me: string }) {
  const money = useMoney();
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Lifted channel state (the fix): threads + drafts live here, keyed by requestId.
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      setErr(null);
      try {
        const r = await fetch(`/api/agency-claims?agency=${encodeURIComponent(me)}`);
        if (!r.ok) throw new Error(r.status === 503 ? "network busy" : `claims ${r.status}`);
        const j = (await r.json()) as { rows?: InboxRow[] };
        setRows(j.rows ?? []);
      } catch (e) {
        if (!opts?.silent) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [me]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // REAL-TIME: the SAME SSE push the developer inbox uses. A mirror advance ("events") refreshes
  // the list; a thread tick ("channel:<id>") reloads the open thread (handled below).
  useEventStream((t) => {
    if (t.topic === "events") void refresh({ silent: true });
  });

  // Slow safety poll (5 min) — catches up if the SSE stream silently dropped. Visible-tab only.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh({ silent: true });
    }, 300_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadThread = useCallback(async (requestId: string) => {
    try {
      const r = await fetch(`/api/channels/${encodeURIComponent(requestId)}?viewer=${encodeURIComponent(me)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { messages?: Msg[] };
      setThreads((prev) => ({ ...prev, [requestId]: j.messages ?? [] }));
    } catch {
      /* transient — keep last known thread */
    }
  }, [me]);

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

  useEventStream((t) => {
    const sel = selectedIdRef.current;
    if (sel && t.topic === channelTopic(sel)) void loadThread(sel);
  });

  const setDraft = useCallback((requestId: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [requestId]: value }));
  }, []);

  // The agency posts on the SELL side of the deal (from: "agent") — it represents its own agent in the
  // conversation with the developer. Body is passed EXPLICITLY (the stale-closure fix).
  const sendMessage = useCallback(
    async (requestId: string, body: string) => {
      const text = body.trim();
      if (!text) return;
      try {
        const r = await fetch(`/api/channels/${encodeURIComponent(requestId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: "agent", by: me, text }),
        });
        if (r.ok) {
          setDrafts((prev) => ({ ...prev, [requestId]: "" }));
          await loadThread(requestId);
        }
      } catch {
        /* leave the draft so the agency can retry — the whole point of lifting it */
      }
    },
    [me, loadThread]
  );

  const q = query.trim().toLowerCase();
  const matches = (row: InboxRow) => {
    if (!q) return true;
    const hay = [rowTitle(row), row.agent, row.developer, row.offer?.seal.terms]
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
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Deals</h2>
        <button type="button" onClick={() => refresh()} disabled={loading} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13 }}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
        Every booking your agents have opened. Watch each deal&apos;s progress and talk to the developer.
      </p>
      {/* commission rollup across the agency's deals that have a live agreement rate. */}
      {(() => {
        const total = rows.reduce((s, r) => s + (r.commission?.amountUsd ?? 0), 0);
        const n = rows.filter((r) => r.commission).length;
        return total > 0 ? (
          <p style={{ fontSize: 13, marginTop: 2 }}>
            <span style={{ opacity: 0.6 }}>Commission across {n} deal{n === 1 ? "" : "s"}:</span>{" "}
            <strong>{money(total)}</strong>
          </p>
        ) : null;
      })()}
      {err && <p style={{ color: "#ff8080" }}>Network busy — {err}. Try Refresh in a moment.</p>}

      {!err && rows.length === 0 && !loading && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>
          No deals yet. Once your agents open a booking, it shows here.
        </p>
      )}

      {rows.length > 0 && (
        <div className="vrx-master-detail" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 320px) 1fr", gap: 16, marginTop: 14, alignItems: "start" }}>
          {/* B5: tag as master-detail so globals.css collapses it to ONE column on phones (was a
              squished two-column grid on mobile — the "deformed" look). */}
          <InboxList groups={groups} selectedId={selectedId} onSelect={setSelectedId} query={query} onQuery={setQuery} />
          <InboxDetail
            key={selected?.requestId ?? "none"}
            row={selected}
            me={me}
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
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search deals…" style={{ ...input, margin: 0, padding: "7px 9px", fontSize: 13 }} />
      </div>
      <div style={{ maxHeight: 520, overflowY: "auto" }}>
        {total === 0 && <p style={{ fontSize: 12.5, opacity: 0.55, padding: "14px 12px", margin: 0 }}>No deals match.</p>}
        <ListGroup label="Awaiting developer" color={T.open} rows={groups.awaiting} selectedId={selectedId} onSelect={onSelect} />
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
  const { claim, offer, verified, agent } = row;
  const lapsed = isRequestLapsed(claim);
  const statusLabel = dealStatus(row);
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
          <span title={verified ? "Verified against the on-chain record" : "Does not match the on-chain record"} style={{ fontSize: 11, color: verified ? T.vetted : T.danger }}>
            {verified ? "✓" : "⚠"}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 11, marginTop: 2, color: lapsed ? T.hold : statusColor(statusLabel) }}>● {statusLabel}</div>
      {agent && <div style={{ fontSize: 10.5, opacity: 0.6, marginTop: 1, ...mono }}>{agent}</div>}
    </button>
  );
}

function InboxDetail({
  row,
  me,
  thread,
  draft,
  onDraft,
  onSend,
}: {
  row: InboxRow | null;
  me: string;
  thread: Msg[] | null;
  draft: string;
  onDraft: (requestId: string, value: string) => void;
  onSend: (requestId: string, body: string) => void | Promise<void>;
}) {
  const money = useMoney();
  const [tab, setTab] = useState<"offer" | "buyer" | "messages">("offer");

  if (!row) {
    return (
      <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 10, padding: 24, color: T.dim, fontSize: 13 }}>
        Select a deal on the left to see its offer, buyer, and messages.
      </div>
    );
  }

  const { requestId, claim, offer, verified, agent, developer } = row;
  const statusLabel = dealStatus(row);
  const lapsed = isRequestLapsed(claim);
  const msgCount = thread?.length ?? 0;

  const tabBtn = (key: typeof tab): React.CSSProperties => ({
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
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.borderSoft}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{rowTitle(row)}</div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <VerifiedSeal offer={offer} verified={verified} />
            {lapsed ? (
              <span style={{ color: T.hold, fontSize: 13, whiteSpace: "nowrap" }} title="No response within 2 hours">
                ● lapsed
              </span>
            ) : (
              <span style={{ color: statusColor(statusLabel), fontSize: 13, whiteSpace: "nowrap" }}>● {statusLabel}</span>
            )}
          </div>
        </div>
        <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4, ...mono }}>
          {developer ? <>developer {developer}</> : null}
          {agent ? <> · agent {agent}</> : null}
        </div>
        {/* Read-mostly: the agency observes the status (the developer accepts/confirms). A gentle hint. */}
        <p style={{ fontSize: 12, opacity: 0.55, margin: "10px 0 0" }}>
          {claim?.s === 0 && !lapsed && (() => {
            const c = requestClock(claim);
            return `Waiting on the developer to respond${c ? ` — ${humanDuration(c.leftMs)} left before it lapses` : ""}. Nudge them in Messages if it's urgent.`;
          })()}
          {claim?.s === 1 && "Accepted — held for the deposit. The developer confirms once the deposit is paid."}
          {claim?.s === 2 && "The developer declined this booking."}
          {claim?.s === 3 && "The developer offered an alternative — see Messages."}
          {lapsed && "Still open after 2 hours — the developer hasn't responded yet. Nudge them in Messages; they can still accept."}
        </p>
      </div>

      <div style={{ display: "flex", gap: 2, padding: "0 10px", borderBottom: `1px solid ${T.borderSoft}` }}>
        <button type="button" style={tabBtn("offer")} onClick={() => setTab("offer")}>Offer</button>
        <button type="button" style={tabBtn("buyer")} onClick={() => setTab("buyer")}>Buyer</button>
        <button type="button" style={tabBtn("messages")} onClick={() => setTab("messages")}>
          Messages{msgCount > 0 ? ` · ${msgCount}` : ""}
        </button>
      </div>

      <div style={{ padding: 16 }}>
        {tab === "offer" && (
          <>
            <OfferDetail offer={offer} money={money} />
            {/* the commission your agency earns on this sale (B2B; never on the buyer S&P). */}
            {row.commission && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <span style={{ opacity: 0.55 }}>Your agency&apos;s commission</span>{" "}
                <strong>{money(row.commission.amountUsd)}</strong>{" "}
                <span style={{ opacity: 0.6 }}>· {row.commission.pct}% of {money(row.commission.priceUsd)}</span>
              </div>
            )}
            {/* H2 (scope widened) — a booking that earns nothing: explain WHY, don't leave it blank,
                for ANY booking (not just accepted). The copy fn is null for earned/prospective, so this only
 fills the otherwise-silent no-commission cases (incl. the unconfirmed one caught). */}
            {!row.commission && row.commissionReason && commissionReasonCopy(row.commissionReason, row.baselineAt) && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: T.dim }}>
                <span style={{ opacity: 0.55 }}>Your agency&apos;s commission</span>{" "}
                {commissionReasonCopy(row.commissionReason, row.baselineAt)}
              </div>
            )}
            {offer && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
                <SaleContractButton requestId={requestId} viewer={me} />
                <div style={{ fontSize: 11.5, color: T.dim, marginTop: 6 }}>
                  The full Sale &amp; Purchase agreement for this deal, populated from the booking.
                </div>
              </div>
            )}
          </>
        )}
        {tab === "buyer" && <BuyerBlock offer={offer} />}
        {tab === "messages" && (
          <DealChat viewerRole="agent" thread={thread} draft={draft} onDraft={(v) => onDraft(requestId, v)} onSend={(body) => onSend(requestId, body)} />
        )}
      </div>
    </div>
  );
}

function VerifiedSeal({ offer, verified }: { offer: OfferRecord | null; verified: boolean }) {
  if (!offer) {
    return (
      <span style={{ ...chip, fontSize: 10.5 }} title="No offer plaintext on file for this booking. The on-chain record still stands.">
        offer not on file
      </span>
    );
  }
  if (verified) {
    return (
      <span style={sealStyle} title="The offer on file matches the on-chain record exactly — unaltered since it was signed.">
        ✓ Vetted
      </span>
    );
  }
  return (
    <span
      style={{ ...sealStyle, color: T.danger, background: "rgba(255,107,107,0.10)", border: `1px solid rgba(255,107,107,0.4)` }}
      title="The offer on file does NOT match the on-chain record."
    >
      ⚠ Mismatch
    </span>
  );
}

function BuyerBlock({ offer }: { offer: OfferRecord | null }) {
  const buyer = offer?.seal.buyer;
  const buyerType = offer?.display.buyerType;
  const hasBuyer = buyer != null && typeof buyer === "object" && Object.keys(buyer as object).length > 0;
  return (
    <div style={{ padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Buyer</span>
        {buyerType && <span style={{ ...chip, fontSize: 10.5 }}>{String(buyerType)}</span>}
        {!hasBuyer && (
          <span style={{ fontSize: 11, color: T.hold, background: "rgba(232,184,75,0.10)", border: "1px solid rgba(232,184,75,0.35)", borderRadius: 999, padding: "2px 8px" }}>
            detail not yet provided
          </span>
        )}
      </div>
      {hasBuyer ? (
        <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
          {Object.entries(buyer as Record<string, unknown>).map(([k, v]) => (
            <div key={k}>
              <span style={{ opacity: 0.55 }}>{k}</span> {String(v)}
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 12, opacity: 0.6, margin: "6px 0 0" }}>No buyer identity attached to this booking yet.</p>
      )}
    </div>
  );
}

function OfferDetail({ offer, money }: { offer: OfferRecord | null; money: (usd: number) => string }) {
  if (!offer) {
    return <div style={{ fontSize: 12.5, opacity: 0.55 }}>No offer detail on file for this booking (it may have been made outside this portal).</div>;
  }
  const p = offer.seal.plan;
  const terms = offer.seal.terms?.trim();
  return (
    <div>
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
            {typeof p.taxPct === "number" && p.taxPct > 0 && <span><span style={{ opacity: 0.55 }}>Tax</span> {p.taxPct}%</span>}
          </div>
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  AGREEMENTS — the commission agreement (an attested record on the spine)
// ════════════════════════════════════════════════════════════════════════════════════════════════
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
  lastBy?: string;
  revokeRequestBy?: string;
  onChainTx?: string;
  at: number;
  updatedAt: number;
  verified: boolean;
};

// A one-line summary of the per-building commission clauses (e.g. "parkgate 3% · palmgate 2.5% (12 units)").
function clausesSummary(buildings: AgreementBuildingClause[]): string {
  if (!buildings?.length) return "—";
  return buildings
    .map((b) => {
      const scope = b.scope === "whole" ? "" : ` (${b.scope.units.length} units)`;
      return `${b.buildingId} ${b.commissionPct}%${scope}`;
    })
    .join(" · ");
}

function Agreements({ me }: { me: string }) {
  const [rows, setRows] = useState<AgreementRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showBrowse, setShowBrowse] = useState(false);

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
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Commission agreements</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setShowBrowse((v) => !v)} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: showBrowse ? T.accent : T.panel2, color: showBrowse ? "#fff" : T.dim }}>
            {showBrowse ? "Close" : "Browse published terms"}
          </button>
        </div>
      </div>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
        Your commission terms with each developer. Browse developers&apos; published terms and join one as-is —
        the developer sets the terms; you can discuss changes with them directly, but the agreement is theirs to
        set. Both sides hold the same signed copy; a ✓ Vetted seal means it hasn&apos;t changed since it was
        agreed. Amounts and rates are kept off-chain and private.
      </p>

      {showBrowse && <BrowsePublished me={me} onJoined={async () => { setShowBrowse(false); await refresh(); }} />}

      {loading && rows === null && <p style={{ opacity: 0.5, fontSize: 14 }}>Loading…</p>}
      {rows && rows.length === 0 && !showBrowse && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>No agreements yet. Browse a developer&apos;s published terms to join one.</p>
      )}
      {rows?.map((g) => (
        <AgreementRow key={g.id} g={g} me={me} onChanged={refresh} />
      ))}
    </section>
  );
}

// ── Browse + JOIN published developer terms (Mode 2) ──────────────────────────────────────────
// A vetted agency discovers developers' STANDING published terms (GET ?published=1) as cards and JOINS
// one — accepting the per-building rates AS-IS. The agency cannot counter-propose: the developer authors the
// terms; joining is the agency's only way onto an agreement, besides confirming a mutual revoke.
// Joining re-seals the record with the agency's identity folded in (server-side) and moves it to "agreed".
// The developer still grants access to units separately — joining is accepting the commission terms, not
// automatic access to inventory.
function BrowsePublished({ me, onJoined }: { me: string; onJoined: () => void | Promise<void> }) {
  const [list, setList] = useState<AgreementRecord[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/agreements?published=1`);
      const j = (await r.json()) as { agreements?: AgreementRecord[] };
      setList(j.agreements ?? []);
    } catch {
      setList([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function join(id: string) {
    setBusyId(id);
    setErr(null);
    try {
      const r = await fetch("/api/agreements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ join: id, by: me }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(typeof j.error === "string" ? j.error : "Could not join these terms.");
        return;
      }
      await onJoined();
    } catch {
      setErr("Network error — please try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ padding: "12px 14px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.border}`, margin: "10px 0" }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>Developers&apos; published terms</div>
      <p style={{ fontSize: 12.5, opacity: 0.7, margin: "4px 0 10px" }}>
        Standing commission terms developers have published for any vetted agency. Joining accepts the terms
        as-is; the developer still grants your agents access to their units separately.
      </p>
      {list === null && <p style={{ opacity: 0.5, fontSize: 13 }}>Loading published terms…</p>}
      {list && list.length === 0 && (
        <p style={{ opacity: 0.6, fontSize: 13 }}>No developers have published standing terms yet.</p>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {list?.map((g) => {
          const devName = g.seal.developerIdentity?.legalName || g.seal.developer;
          return (
            <div key={g.id} style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.bg }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{devName}</div>
                <button type="button" disabled={busyId === g.id} onClick={() => void join(g.id)} style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, background: "#1c5e2a" }}>
                  {busyId === g.id ? "Joining…" : "Join these terms"}
                </button>
              </div>
              <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
                {g.seal.buildings.map((b) => (
                  <div key={b.buildingId}>
                    <b>{b.commissionPct}%</b> on {b.buildingId}
                    {b.scope === "whole" ? " (whole building)" : ` (${b.scope.units.length} units — non-exclusive)`}
                  </div>
                ))}
              </div>
              {g.seal.terms && <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap", opacity: 0.85 }}>{prettyTerms(g.seal.terms)}</div>}
              <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 4 }}>published {timeAgo(g.at)}</div>
            </div>
          );
        })}
      </div>
      {err && <div style={{ ...banner, fontSize: 12.5, borderColor: "#7a2b2b", background: "#241010", marginTop: 8 }}>{err}</div>}
    </div>
  );
}

// NOTE: the AGENCY cannot author or counter-propose an agreement. The developer sets ALL
// contract details (commission %, payment, duration, basis, buildings). An agency negotiates via chat but
// its only on-contract action is to JOIN a developer's published rate card as-is (BrowsePublished above) or
// confirm a revoke. The old `ProposeAgreement` form (agency sets its own %/terms) was removed here, and
// `/api/agreements` rejects `by:"agency"` seals fail-closed so a crafted request can't recreate it.

function AgreementRow({ g, me, onChanged }: { g: AgreementRecord; me: string; onChanged: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [showContract, setShowContract] = useState(false);
  const isAgency = g.seal.agency.toLowerCase() === me.toLowerCase();
  const counterparty = isAgency ? g.seal.developer : g.seal.agency;
  const proposerIsAgency = g.seal.by === "agency";
  // The counterparty to a PROPOSAL is the side that can agree/decline it.
  const canRespond = g.status === "proposed" && (proposerIsAgency ? !isAgency : isAgency);
  // Ending an agreed agreement is MUTUAL: a durable agreement protects commission already earned, so
  // neither side can revoke it alone. One party requests to end it; the other confirms.
  const revokePending = !!g.revokeRequestBy;
  const iRequestedEnd = revokePending && g.revokeRequestBy?.toLowerCase() === me.toLowerCase();
  const canRequestEnd = g.status === "agreed" && !revokePending;
  const canConfirmEnd = g.status === "agreed" && revokePending && !iRequestedEnd;

  const statusColorOf = (s: string) =>
    s === "agreed" ? T.vetted : s === "proposed" ? T.hold : s === "declined" || s === "revoked" ? T.danger : T.dim;

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
    <div style={{ borderTop: `1px solid ${T.borderSoft}`, padding: "14px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <b style={{ fontSize: 15 }}>{g.seal.buildings.length === 1 ? "1 building" : `${g.seal.buildings.length} buildings`}</b>
            <span style={{ fontSize: 12.5, opacity: 0.7 }}>
              with <code style={{ ...mono, fontSize: 12 }}>{(isAgency ? g.seal.developerIdentity?.legalName : g.seal.agencyIdentity?.legalName) || counterparty}</code><PrivateMark />
            </span>
            {g.verified ? (
              <span style={{ ...sealStyle, fontSize: 10 }} title="The signed terms AND the vetted identities both match the seal — unaltered.">✓ Vetted<SealedMark /></span>
            ) : (
              <span style={{ ...sealStyle, fontSize: 10, color: T.danger, background: "rgba(255,107,107,0.10)", border: "1px solid rgba(255,107,107,0.4)" }} title="Does not match the signed seal.">⚠ Mismatch</span>
            )}
          </div>
          <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
            {g.seal.buildings.map((b) => (
              <div key={b.buildingId}>
                <b>{b.commissionPct}%</b><PrivateMark /> on {b.buildingId}
                {b.scope === "whole" ? " (whole building)" : ` (${b.scope.units.length} units — non-exclusive)`}
              </div>
            ))}
          </div>
          {g.seal.terms && <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap", opacity: 0.85 }}>{prettyTerms(g.seal.terms)}<PrivateMark /></div>}
          <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 4 }}>
            <span style={{ color: statusColorOf(g.status) }}>● {g.status}</span> · proposed by {g.seal.by} · {timeAgo(g.at)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setShowContract(true)} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }} title="Read the full written agreement and print or save it as a PDF.">View contract</button>
          {canRespond && (
            <>
              <button type="button" disabled={busy} onClick={() => move("agreed")} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#1c5e2a" }}>Agree</button>
              <button type="button" disabled={busy} onClick={() => move("declined")} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#5e1c1c" }}>Decline</button>
            </>
          )}
          {g.status === "proposed" && !canRespond && <span style={{ fontSize: 12, opacity: 0.55 }}>Awaiting {counterparty}</span>}
          {canRequestEnd && (
            <button type="button" disabled={busy} onClick={requestEnd} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#3a2416", color: "#e0b88a" }} title="A signed agreement protects commission already earned. Ending it needs both parties to agree.">Request to end</button>
          )}
          {canConfirmEnd && (
            <button type="button" disabled={busy} onClick={requestEnd} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#5e1c1c" }} title="The other party asked to end this agreement. Confirm to end it by mutual consent.">Confirm ending</button>
          )}
          {iRequestedEnd && <span style={{ fontSize: 12, opacity: 0.55 }}>End requested — awaiting {counterparty}</span>}
        </div>
      </div>
      {showContract && <ContractModal g={g} onClose={() => setShowContract(false)} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  MANAGE AGENTS — the original surface (register_peer / deactivate_peer), kept
// ════════════════════════════════════════════════════════════════════════════════════════════════
function ManageAgents({ me, callFunction }: { me: string; callFunction: ReturnType<typeof useWallet>["callFunction"] }) {
  const [open, setOpen] = useState(true);
  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Your agents</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: T.panel2, color: T.dim }}>
          {open ? "Hide" : "Manage"}
        </button>
      </div>
      {open && (
        <>
          <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
            Register your salespeople so they can open booking requests on behalf of buyers, and deactivate
            them when they leave. Their personal details are kept private.
          </p>
          {/* The ROSTER (bug-fix): the tab previously showed only the register + deactivate forms, so a
              signed-in agency with existing agents saw an empty-looking "My agents" tab while Agent performance
              listed them — a data-source MISMATCH. The roster + performance now read the SAME source
              (/api/agents?agency=), so the two tabs can't disagree about who the agency's agents are. */}
          <AgentRoster me={me} />
          <RegisterAgent me={me} callFunction={callFunction} />
          <ManageAgent me={me} callFunction={callFunction} />
        </>
      )}
    </section>
  );
}

// ── Agent ROSTER — the list the tab was missing ─────────────────────────────────────────────────
// Reads /api/agents?agency= (the off-chain mirror, lib/agents) — the SAME endpoint AgentPerformance's roster
// comes from, so "My agents" and "Agent performance" can never show a different set of agents. Neutral
// account ids + join time only: the sealed agent profile is never returned by the API, so there is no
// PII to render here. Read-only; registering/deactivating is done in the forms below.
function AgentRoster({ me }: { me: string }) {
  const [agents, setAgents] = useState<{ account: string; at: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch(`/api/agents?agency=${encodeURIComponent(me)}`);
      if (!r.ok) throw new Error(`agents ${r.status}`);
      const j = (await r.json()) as { agents?: { account: string; at: number }[] };
      setAgents(j.agents ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not load");
    }
  }, [me]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Registered agents{agents ? ` · ${agents.length}` : ""}</h3>
        <button type="button" onClick={() => void load()} style={{ ...submitBtn, padding: "4px 10px", fontSize: 12, background: T.panel2, color: T.dim }}>
          Refresh
        </button>
      </div>
      {err && <p style={{ color: "#e8b84b", fontSize: 12.5, marginTop: 6 }}>Couldn&apos;t load the roster — {err}.</p>}
      {agents !== null && !err && agents.length === 0 && (
        <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
          No agents registered yet. Add your first salesperson below.
        </p>
      )}
      {agents && agents.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", border: `1px solid ${T.borderSoft}`, borderRadius: 10, overflow: "hidden" }}>
          {agents.map((a) => (
            <li
              key={a.account}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, padding: "9px 12px", borderTop: `1px solid ${T.borderSoft}`, background: T.bg2 }}
            >
              <span style={{ ...mono, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.account}</span>
              <span style={{ fontSize: 11.5, opacity: 0.55, whiteSpace: "nowrap" }}>joined {timeAgo(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RegisterAgent({ me, callFunction }: { me: string; callFunction: ReturnType<typeof useWallet>["callFunction"] }) {
  const [agentId, setAgentId] = useState("");
  const [profile, setProfile] = useState("");
  const [devId, setDevId] = useState("");
  const { state, run, busy } = useTxRun();
  const [invite, setInvite] = useState<{ link: string; qr: string } | null>(null);

  async function submit() {
    setInvite(null);
    const id = agentId.trim();
    if (!id) return;
    const ok = await run(
      async () => {
        const agentRef = await hashRef({ agent: id, agency: me, profile: profile.trim() }, "vrx-agent");
        const built = registerPeerArgs(id, agentRef);
        const deposit = await depositFor(me);
        return callFunction({ method: built.method, args: built.args, deposit });
      },
      { successNote: `Agent ${id} registered to your agency.`, mapError: writeErr, ensureGasFor: me }
    );
    if (!ok) return;

    fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: id, agency: me }),
    }).catch(() => {});

    const params = new URLSearchParams();
    if (devId.trim()) params.set("dev", devId.trim());
    const link = `${window.location.origin}/agent${params.toString() ? `?${params}` : ""}`;
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 200 }).catch(() => "");
    setInvite({ link, qr });
    setProfile("");
    setAgentId("");
  }

  return (
    <div style={{ marginTop: 10 }}>
      <h3 style={{ fontSize: 15, marginTop: 0, marginBottom: 8 }}>Register an agent</h3>
      <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: 0 }}>
        <label style={lbl}>Agent account <span style={{ opacity: 0.6 }}>— the salesperson&apos;s own wallet account</span></label>
        <input value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="e.g. agent-jo.testnet" style={input} />
        <label style={lbl}>Agent profile <span style={{ opacity: 0.6 }}>— name / contact, kept private; sealed at registration (keep your own editable records)</span></label>
        <textarea value={profile} onChange={(e) => setProfile(e.target.value)} rows={3} placeholder="Name and contact details for your own records — kept private. Sealed into the registration, so keep your own editable copy if their contact changes." style={{ ...input, fontFamily: "inherit", resize: "vertical" }} />
        <label style={lbl}>Developer to prefill <span style={{ opacity: 0.6 }}>— optional; the agent&apos;s QR opens ready to book from this developer</span></label>
        <input value={devId} onChange={(e) => setDevId(e.target.value)} placeholder="e.g. vvv-dev-01.testnet" style={input} />
        <button type="button" onClick={submit} disabled={busy} style={submitBtn}>{busy ? "Signing…" : "Register agent"}</button>
      </fieldset>
      <TxProgress state={state} />
      {invite && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${T.borderSoft}` }}>
          <p style={{ fontSize: 14, margin: "0 0 8px" }}>📱 <b>Give this to your agent.</b> They scan it on their phone, land on the booking screen, and connect their own wallet.</p>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            {invite.qr && <img src={invite.qr} alt="Agent onboarding QR" width={160} height={160} style={{ borderRadius: 10, background: "#fff", padding: 6 }} />}
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 12, opacity: 0.6, margin: "0 0 4px" }}>Or share this link:</p>
              <code style={{ ...mono, fontSize: 12, wordBreak: "break-all", color: "#a9c0ff" }}>{invite.link}</code>
              <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>The QR carries no login — your agent signs in with their own wallet.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ManageAgent({ me, callFunction }: { me: string; callFunction: ReturnType<typeof useWallet>["callFunction"] }) {
  const [agentId, setAgentId] = useState("");
  const { state, run, busy } = useTxRun();
  const [lookup, setLookup] = useState<string | null>(null);
  //  audit (c3): only allow deactivate once the lookup confirms this agent IS registered to US and still
  // active — a flag, not a prose match, so the submit guard can't disagree with what the status line shows. The
  // contract rejects a doomed deactivate anyway (not-a-peer), but the UI must not invite the doomed tx.
  const [canDeactivate, setCanDeactivate] = useState(false);

  async function check() {
    setLookup(null);
    setCanDeactivate(false);
    if (!agentId.trim()) return;
    const p = (await getPeer(agentId.trim()).catch(() => null)) as { o?: string; a?: boolean } | null;
    if (!p) setLookup("Not a registered agent.");
    else if (p.o !== me) setLookup(`Registered to a different agency (${p.o}). You can't manage it.`);
    else {
      setLookup(p.a === false ? "Registered to you — currently INACTIVE." : "Registered to you — active.");
      setCanDeactivate(p.a !== false); // already-inactive → nothing to deactivate
    }
  }

  async function deactivate() {
    const id = agentId.trim();
    if (!id) return;
    const ok = await run(
      async () => {
        const built = deactivatePeerArgs(id);
        const deposit = await depositFor(me);
        return callFunction({ method: built.method, args: built.args, deposit });
      },
      { successNote: `Agent ${id} deactivated.`, mapError: writeErr, ensureGasFor: me }
    );
    if (ok) { setLookup(null); setCanDeactivate(false); }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${T.borderSoft}` }}>
      <h3 style={{ fontSize: 15, marginTop: 0, marginBottom: 4 }}>Deactivate an agent</h3>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 4 }}>Turn off an agent who has left. Only agents registered to your agency can be deactivated.</p>
      <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: 0 }}>
        <label style={lbl}>Agent account</label>
        <input
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setLookup(null);
            setCanDeactivate(false);
          }}
          onBlur={check}
          placeholder="e.g. agent-jo.testnet"
          style={input}
        />
        {lookup && <p style={{ fontSize: 13, opacity: 0.75, marginTop: -8, ...mono }}>{lookup}</p>}
        {/*  (c3): the button only arms once `check` confirms an active agent registered to us, so the UI's
            "go" can't contradict the status line (the contract would reject a doomed tx, but we don't invite it). */}
        <button type="button" onClick={deactivate} disabled={busy || !canDeactivate} style={submitBtn}>{busy ? "Signing…" : "Deactivate agent"}</button>
      </fieldset>
      <TxProgress state={state} />
    </div>
  );
}

// ── shared bits ──
function RoleBanner({
  ready,
  accountId,
  isAgency,
  signIn,
}: {
  ready: boolean;
  accountId: string | null;
  isAgency: boolean | null;
  signIn: () => void;
}) {
  if (!ready) return null;
  if (!accountId) {
    return (
      <div style={{ ...banner, border: `1px solid ${T.border}` }}>
        Connect your agency wallet to see your deals and agreements.{" "}
        <button onClick={signIn} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, marginLeft: 8 }}>Connect</button>
      </div>
    );
  }
  if (isAgency === false) {
    return (
      <div style={{ ...banner, border: "1px solid #5a3a3a", background: "#22161a" }}>
        Connected as <code>{accountId}</code>, which isn&apos;t set up as an agency. Agencies are onboarded
        by us (VRX) first — please contact us to get set up.
      </div>
    );
  }
  // Signed in + onboarded → no banner (role + account are in the top bar). Only the sign-in /
  // not-onboarded prompts show.
  return null;
}

function writeErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NOT_ORG/i.test(msg)) return "This account isn't set up as an agency.";
  if (/PEER_EXISTS/i.test(msg)) return "That agent account is already registered.";
  if (/PEER_NOT_FOUND/i.test(msg)) return "No such agent.";
  if (/NOT_PEERS_ORG/i.test(msg)) return "That agent belongs to a different agency — you can't manage it.";
  if (/rejected|cancell?ed|user closed|denied/i.test(msg)) return "Request cancelled.";
  if (/E57|deposit/i.test(msg)) return "Couldn't complete — please try again.";
  return "Something went wrong. Please try again.";
}
