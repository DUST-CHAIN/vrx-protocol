"use client";

// VRX ROOT relationships dashboard — the owner's God's-eye view so the HUMAN team can help
// developers + agencies.: "VRX root UI has to show all these relations so we easily know who is
// connected to who, expiry, open invitations etc., to help the agencies and developers with our human team."
//
// Distinct from /network (on-chain Node/Org discovery): this reads the OFF-CHAIN stores the team acts on —
// profiles (KYC), gates (access), agents (team membership), agreements (status + rate + expiry), and
// applications (open invitations). It is READ-MOSTLY first (observe + support); root ACTIONS (
// termination, KYC corrections, resend invite) come later.
//
// AUTH: operator-gated, same posture as /applications — an operator secret (sessionStorage, demo-laptop
// gate) is sent as x-vrx-operator; the server fails CLOSED (fix #3) unless VRX_DEMO_OPEN=1 locally. The
// data here crosses every party boundary, so it must never be party-facing — see /api/root/overview.
//
// PRIVACY: the team sees names (the point — they act on them), but the API strips the secret salt
// every agreement (fix #1). 🔒 marks the private/off-chain fields; ⭐ marks the tamper-evident seal.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { getOwner } from "@/lib/vrx";
import { T, chip } from "@/lib/theme";
import { card, input, submitBtn } from "@/lib/ui";
import { prettyTerms } from "@/lib/contract";
import { PrivateMark, SealedMark } from "@/lib/marks";
import DashboardShell, { type ShellSection, useShellFocus } from "@/components/DashboardShell";
import { readOperatorSecret, writeOperatorSecret, onOperatorSecretChange } from "@/lib/operator-secret";
import BookingTokensPanel from "./BookingTokensPanel";
import HaltQueuePanel from "./HaltQueuePanel";
import FaucetPanel from "./FaucetPanel";
import AiDeskPanel from "./AiDeskPanel";
import Link from "next/link";

// ── VRX-root judge-access switch (D-: "the switch is inside vrx root") ────────────────────
// Controls what a visitor with NO operator key sees when they enter /root from the landing "VRX (the
// operator)" card. Flip this ONE constant to change the public posture (no deploy-time env needed):
//   "shell"  (option 1) — a no-key judge sees the console CHROME + an explainer of what VRX-root does, but
//                          the sensitive cross-party data stays locked (the server 401s every /api/root read
//                          without the key — overview is the most privacy-sensitive read in the system). Shows
//                          the surface honestly WITHOUT leaking the relationship graph. Good for a judge walk.
//   "gated"  (option 2) — no key = a lock screen; they can't even see the chrome until the key is entered.
// Switch to "gated" if "shell" ever feels like it shows too much. The REAL data lock is unchanged either way
// (server-side VRX_OPERATOR_SECRET, fail-closed) — this only tunes the no-key PRESENTATION.
const VRX_ROOT_JUDGE_ACCESS: "shell" | "gated" = "shell";

// ── Response types (mirror /api/root/overview) ────────────────────────────────────────────────────
type AgreementStatus = "published" | "proposed" | "agreed" | "declined" | "revoked";
type Expiry = { months: number | null; expiresAt: number | null; expiringSoon: boolean; expired: boolean };
type BuildingClause = { buildingId: string; buildingName?: string; commissionPct: number; scope: "whole" | { units: string[] } };
type Agreement = {
  id: string;
  status: AgreementStatus;
  verified: boolean;
  at: number;
  updatedAt: number;
  revokeRequestBy?: string;
  agencyName: string | null;
  developerName: string;
  expiry: Expiry;
  seal: {
    agency: string;
    developer: string;
    terms: string;
    by: "agency" | "developer";
    buildings: BuildingClause[];
  };
};
type Bookable = { developerName: string; buildings: string[] };
type GraphAgent = { account: string; name: string; inBooking: number; sold: number };
type GraphAgency = {
  account: string;
  name: string;
  region: string;
  gated: boolean;
  inBooking: number;
  sold: number;
  bookable: Bookable[];
  agents: GraphAgent[];
};
type GraphDeveloper = { account: string; name: string; buildingIds: string[]; inBooking: number; sold: number; agencies: GraphAgency[] };
type Person = { account: string; role: "developer" | "agency" | "agent"; legalName: string; region: string; vettedAt: number; inBooking: number; sold: number };
type Overview = {
  counts: { developers: number; agencies: number; agents: number; agreements: number };
  people: Person[];
  graph: GraphDeveloper[];
  agreements: Agreement[];
  attention: {
    adverseStanding: {
      developer: string;
      developerName: string;
      stage: "grace" | "suspended" | "removed";
      reasons: ("none" | "late_payment" | "misrepresentation")[];
      note: string;
      overdueUnpaidCount: number;
      suspendsAt: number | null;
      removesAt: number | null;
      listingsHidden: boolean;
    }[];
    openInvitations: { token: string; status: string; label: string | null; account: string | null; updatedAt: number; expiresAt: number }[];
    pendingKyc: { account: string; roleHint: string }[];
    stalledDeals: { id: string; developerName: string; agencyName: string | null; waitingOnName: string; proposedBy: string; sinceDays: number }[];
    expiringAgreements: { id: string; developerName: string; agencyName: string | null; expiresAt: number | null; expired: boolean }[];
    ungatedAgencies: { account: string; name: string; region: string }[];
  };
};

const fmtDate = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString() : "—");

export default function RootDashboard() {
  const { accountId, ready, signIn } = useWallet();
  const [owner, setOwner] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getOwner().then(setOwner).catch(() => setOwner(null));
    setSecret(readOperatorSecret());
    // The secret is set in ⚙ Settings now (owner-only); re-fetch when it changes there.
    return onOperatorSecretChange(setSecret);
  }, []);

  const isOwner = !!accountId && !!owner && accountId === owner;
  const headers = useMemo(() => (secret ? { "x-vrx-operator": secret } : undefined), [secret]);

  const load = useCallback(async () => {
    setLoadErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/root/overview", { headers });
      if (res.status === 401) {
        setLoadErr("Operator secret required or incorrect (or set VRX_DEMO_OPEN=1 locally).");
        setData(null);
        return;
      }
      if (!res.ok) throw new Error(`Failed to load (${res.status}).`);
      setData((await res.json()) as Overview);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    load();
  }, [load]);

  // Relation-browser controls lifted here so they sit in the shell header: the graph/list
  // toggle and the party search.
  const [browserView, setBrowserView] = useState<"graph" | "list">("graph");
  const [browserQuery, setBrowserQuery] = useState("");

  // Shell sections (view-switched). RelationBrowser is keepAlive so its selected-party / radial-graph
  // layout state survives switching away and back (it holds a lot of interactive state). The other three
  // are cheap read-only panels — unmount when inactive.
  const sections: ShellSection[] = data
    ? [
        {
          id: "browse",
          label: "Relation browser",
          icon: "🕸",
          keepAlive: true,
          element: <RelationBrowser people={data.people} graph={data.graph} headers={headers} view={browserView} q={browserQuery} />,
          headerAccessory: (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              {/* Counts + Refresh moved up into the header, between the intro and the search. */}
              <Counts data={data} compact />
              <button type="button" onClick={load} disabled={loading} style={refreshBtn}>
                {loading ? "…" : "Refresh"}
              </button>
              <input
                value={browserQuery}
                onChange={(e) => setBrowserQuery(e.target.value)}
                placeholder="Search name or account…"
                style={{ ...input, marginBottom: 0, width: 200, fontSize: 13, padding: "5px 10px" }}
              />
              <GraphListToggle view={browserView} onChange={setBrowserView} />
            </div>
          ),
        },
        {
          id: "attention",
          label: "Needs attention",
          icon: "⚠",
          element: <AttentionPanel attention={data.attention} />,
        },
        { id: "graph", label: "Network", icon: "⛓", element: <GraphPanel graph={data.graph} /> },
        {
          id: "agreements",
          label: "Agreements",
          icon: "📄",
          element: <AgreementsPanel agreements={data.agreements} />,
        },
        {
          id: "standing",
          label: "Standing & accuracy",
          icon: "⚖",
          element: <StandingPanel people={data.people} headers={headers} />,
        },
        {
          id: "inventory",
          label: "Inventory oversight",
          icon: "📦",
          element: <InventoryOversightPanel people={data.people} headers={headers} />,
        },
        {
          id: "escalations",
          label: "Escalations",
          icon: "⚑",
          element: <EscalationsPanel headers={headers} />,
        },
        {
          id: "change-gov",
          label: "Change governance",
          icon: "📝",
          element: <ChangeGovernancePanel headers={headers} />,
        },
        {
          id: "halts",
          label: "Building pauses",
          icon: "⏸",
          element: <HaltQueuePanel headers={headers} />,
        },
        {
          id: "payments",
          label: "Payments & disputes",
          icon: "💳",
          element: <PaymentsPanel headers={headers} />,
        },
        {
          id: "tokens",
          label: "Booking tokens",
          icon: "🎟",
          element: <BookingTokensPanel headers={headers} />,
        },
        {
          id: "faucet",
          label: "Gas faucet",
          icon: "⛽",
          element: <FaucetPanel headers={headers} />,
        },
        {
          id: "ai-desk",
          label: "AI Sales Director",
          icon: "🤖",
          element: <AiDeskPanel headers={headers} />,
        },
      ]
    : [];

  // D- judge-access switch. A visitor with NO operator key (secret === "") hits one of two postures:
  //   "gated" → a lock screen (they can't see the console chrome until they enter the key here).
  //   "shell" → fall through to the normal dashboard, which shows the chrome + a 401 "enter the key" footer
  //             (the server keeps the sensitive data locked). The explainer banner is injected below.
  const noKey = !secret;
  if (noKey && VRX_ROOT_JUDGE_ACCESS === "gated") {
    return <RootKeyGate />;
  }

  return (
    <DashboardShell
      title="Relationships"
      persistKey="root"
      intro="VRX connections, agreement status & expiry"
      topbarNote={<OwnerNote ready={ready} accountId={accountId} owner={owner} isOwner={isOwner} signIn={signIn} />}
      footer={
        loadErr ? (
          <p style={{ color: "#ff8080", fontSize: 13, marginTop: 10 }}>
            {loadErr} — set the operator secret in ⚙ Settings.
          </p>
        ) : null
      }
      sections={sections}
    >
      {/* "shell" mode: a no-key visitor (e.g. a judge) sees what this console IS, while the sensitive
          cross-party data stays locked behind the operator key (server-enforced). */}
      {noKey && <RootShellExplainer />}
      {!data && !loadErr && !noKey && <p style={{ opacity: 0.5, fontSize: 14, marginTop: 24 }}>Loading…</p>}
    </DashboardShell>
  );
}

// D- — the explainer a no-key visitor sees in "shell" mode: honest about what VRX-root does + why the
// data is locked (privacy is the moat), with a one-step key field so a judge who HAS the key can unlock here.
function RootShellExplainer() {
  const [key, setKey] = useState("");
  return (
    <div style={{ ...card, marginTop: 20, borderLeft: `3px solid ${T.vetted}`, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 17 }} aria-hidden>🛡️</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: T.vetted }}>VRX operator console</span>
        <span style={{ fontSize: 11.5, color: T.faint }}>· not a public role</span>
      </div>
      <p style={{ fontSize: 13.5, opacity: 0.82, lineHeight: 1.5, margin: 0 }}>
        This is where the VRX team vets &amp; onboards developers, agencies and agents, reviews flags, and
        manages relationships. The cross-party data here (names, deals, standing) is <strong>private by
        design</strong> and stays locked — it only loads with the VRX operator key.
      </p>
      <p style={{ fontSize: 12.5, color: T.faint, margin: 0 }}>
        Hackathon judges: request the operator key from the VRX team to act here, or enter it below.
      </p>
      <form
        onSubmit={(e) => { e.preventDefault(); if (key.trim()) writeOperatorSecret(key.trim()); }}
        style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
      >
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Operator key"
          aria-label="VRX operator key"
          style={{ ...input, marginBottom: 0, flex: 1, minWidth: 160, fontSize: 13, padding: "6px 9px" }}
        />
        <button type="submit" style={submitBtn}>Unlock</button>
      </form>
    </div>
  );
}

// D- — "gated" mode lock screen: no chrome until the key is entered.
function RootKeyGate() {
  const [key, setKey] = useState("");
  return (
    <main style={{ maxWidth: 520, margin: "60px auto", padding: "0 20px" }}>
      <div style={{ ...card, borderLeft: `3px solid ${T.vetted}`, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 18 }} aria-hidden>🛡️</span>
          <span style={{ fontSize: 17, fontWeight: 600, color: T.vetted }}>VRX operator console</span>
        </div>
        <p style={{ fontSize: 13.5, opacity: 0.82, lineHeight: 1.5, margin: 0 }}>
          This is the VRX team&apos;s private console — not a public role. It&apos;s locked.
          Hackathon judges: request the operator key from the VRX team.
        </p>
        <form
          onSubmit={(e) => { e.preventDefault(); if (key.trim()) writeOperatorSecret(key.trim()); }}
          style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
        >
          <input
            type="password"
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Operator key"
            aria-label="VRX operator key"
            style={{ ...input, marginBottom: 0, flex: 1, minWidth: 180, fontSize: 13, padding: "7px 10px" }}
          />
          <button type="submit" style={submitBtn}>Unlock</button>
        </form>
      </div>
    </main>
  );
}

// ── Relation Browser — the new TOP SECTION: a master-detail party browser ────────────────────
// LEFT = searchable party picker, grouped by role. RIGHT = the selected party's relation card (role-
// dependent). Every related party on the card is clickable → selects it → the card re-renders for THAT
// party, so the operator navigates the web (agency → its developer → one of its agents → …). Read-mostly
// (actions come later). When nobody is selected, the right pane shows a VRX-centered map of the
// whole network (: "show everyone including VRX"; VRX is a first-class node, future-proofed for
// multiple VRX nodes later). Lazy-loads /api/root/party on select (keeps the overview payload lean).

type PartyBuilding = { id: string; name: string };
type PartyAgreement = Agreement & {
  buildings: (BuildingClause & { buildingName: string })[];
};
type PartyCard = {
  account: string;
  role: "developer" | "agency" | "agent";
  kyc: { account: string; role: string; legalName: string; region: string; vettedAt: number; vetted: boolean };
  liveDeals: number;
  agreements: PartyAgreement[];
  // developer
  buildingsOwned?: PartyBuilding[];
  agenciesWithAccess?: { account: string; name: string; region: string }[];
  agenciesNoAccess?: { account: string; name: string; region: string }[];
  //  §config-surface — VRX's own commercial terms with this developer (VRX-root sets these).
  vrxTerms?: {
    protocolFeePct: { effective: number; override: number | null; default: number };
    vrxSettleWorkingDays: { effective: number; override: number | null; default: number };
  };
  // agency
  buildingsVisible?: { developerAccount: string; developerName: string; buildings: PartyBuilding[] }[];
  agents?: { account: string; name: string }[];
  // agent
  agency?: { account: string; name: string } | null;
  buildingsViaAgency?: { id: string; name: string; viaDeveloper: string; developerAccount: string }[];
  agentNote?: string;
};

const ROLE_LABEL: Record<string, string> = { developer: "Developers", agency: "Agencies", agent: "Agents" };
const roleColor: Record<string, string> = { developer: T.accent, agency: T.vetted, agent: T.alt };

// Refresh button sized to MATCH the Graph/List toggle (26px) so the header controls line up.
const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  background: T.panel2,
  color: T.text,
  cursor: "pointer",
  fontSize: 12,
  padding: "3px 14px",
  minHeight: 26,
  height: 26,
  lineHeight: 1,
  borderRadius: 999,
};

// Graph/List toggle — lives in the shell header, inline with the "Relationships" title.
// Explicit short height overrides the global `button { min-height: 40px }` so the pill isn't tall.
function GraphListToggle({ view, onChange }: { view: "graph" | "list"; onChange: (v: "graph" | "list") => void }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${T.border}`, borderRadius: 999, overflow: "hidden" }}>
      {(["graph", "list"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          style={{
            border: "none", cursor: "pointer", fontSize: 12, padding: "3px 14px", minHeight: 26, height: 26, lineHeight: 1,
            background: view === v ? T.accent : "transparent",
            color: view === v ? "#fff" : T.dim,
          }}
        >
          {v === "graph" ? "◉ Graph" : "☰ List"}
        </button>
      ))}
    </div>
  );
}

function RelationBrowser({
  people, graph, headers, view, q,
}: { people: Person[]; graph: GraphDeveloper[]; headers: Record<string, string> | undefined; view: "graph" | "list"; q: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [partyCard, setPartyCard] = useState<PartyCard | null>(null);
  const [cardErr, setCardErr] = useState<string | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  // Bumped after a card-scoped write (e.g. VRX-root edits a developer's terms) to re-fetch the live card.
  const [cardReload, setCardReload] = useState(0);
  const reloadCard = useCallback(() => setCardReload((n) => n + 1), []);
  // `view` (graph/list) and `q` (search) are lifted to the page so their controls sit in the shell header.

  const select = useCallback((account: string | null) => {
    setSelected(account);
  }, []);

  useEffect(() => {
    if (!selected) { setPartyCard(null); setCardErr(null); return; }
    let live = true;
    setPartyCard(null); // clear the PREVIOUS party's card immediately so nothing renders the wrong party
    setCardLoading(true);
    setCardErr(null);
    fetch(`/api/root/party?account=${encodeURIComponent(selected)}`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 401 ? "Operator secret required." : `Failed (${res.status}).`);
        return (await res.json()) as PartyCard;
      })
      .then((c) => { if (live) setPartyCard(c); })
      .catch((e) => { if (live) setCardErr(e instanceof Error ? e.message : "Failed to load."); })
      .finally(() => { if (live) setCardLoading(false); });
    return () => { live = false; };
  }, [selected, headers, cardReload]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (p: Person) =>
      !needle || p.legalName.toLowerCase().includes(needle) || p.account.toLowerCase().includes(needle);
    const roles: Person["role"][] = ["developer", "agency", "agent"];
    return roles.map((r) => ({ role: r, items: people.filter((p) => p.role === r && match(p)) }));
  }, [people, q]);

  return (
    <section style={{ ...card }}>
      {/* B5: master-detail — collapses to one column on phones via globals.css (was squished 2-col). */}
      <div className="vrx-master-detail" style={{ display: "grid", gridTemplateColumns: "minmax(200px, 260px) 1fr", gap: 16 }}>
        {/* LEFT — party picker (search moved to the shell header, next to the Graph/List toggle) */}
        <div style={{ borderRight: `1px solid ${T.borderSoft}`, paddingRight: 14, minHeight: 320 }}>
          <button
            type="button"
            onClick={() => select(null)}
            style={{
              ...pickerRow,
              marginBottom: 8,
              background: selected === null ? T.panel2 : "transparent",
              color: selected === null ? T.text : T.dim,
              fontWeight: 600,
            }}
          >
            ◉ Whole network (VRX)
          </button>
          {groups.map((g) => (
            <div key={g.role} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: roleColor[g.role], marginBottom: 4 }}>
                {ROLE_LABEL[g.role]} <span style={{ opacity: 0.6 }}>· {g.items.length}</span>
              </div>
              {g.items.map((p) => {
                // Same badges as the graph: agents show live IN-BOOKING (amber), agencies show SOLD (green).
                // Hidden when 0 (sold stays hidden until the watchlist fills it).
                const rosterBadge =
                  p.role === "agent" && p.inBooking > 0 ? { n: p.inBooking, bg: T.hold, fg: "#1a1407", title: "in booking" }
                  : p.role === "agency" && p.sold > 0 ? { n: p.sold, bg: T.vetted, fg: "#06281c", title: "sold" }
                  : null;
                return (
                  <button
                    key={p.account}
                    type="button"
                    onClick={() => select(p.account)}
                    style={{
                      ...pickerRow,
                      background: selected === p.account ? T.panel2 : "transparent",
                      color: selected === p.account ? T.text : T.dim,
                    }}
                  >
                    <span>{p.legalName}</span>
                    {rosterBadge && (
                      <span
                        title={rosterBadge.title}
                        style={{
                          flexShrink: 0, minWidth: 17, height: 17, padding: "0 5px", borderRadius: 999,
                          background: rosterBadge.bg, color: rosterBadge.fg, fontSize: 10.5, fontWeight: 700,
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                        }}
                      >
                        {rosterBadge.n}
                      </span>
                    )}
                  </button>
                );
              })}
              {g.items.length === 0 && <div style={{ fontSize: 12, opacity: 0.35, paddingLeft: 10 }}>—</div>}
            </div>
          ))}
        </div>
        {/* RIGHT — graph (default) and/or the flat relation card */}
        <div style={{ minHeight: 320 }}>
          {view === "graph" && (
            <NetworkGraph
              people={people}
              graph={graph}
              selected={selected}
              card={partyCard}
              onSelect={select}
            />
          )}
          {view === "list" && !selected && <NetworkMap people={people} onSelect={select} />}
          {selected && cardLoading && <p style={{ opacity: 0.5, fontSize: 14, marginTop: 12 }}>Loading…</p>}
          {selected && cardErr && <p style={{ color: "#ff8080", fontSize: 14, marginTop: 12 }}>{cardErr}</p>}
          {selected && partyCard && !cardLoading && (
            <div style={{ marginTop: view === "graph" ? 16 : 0, borderTop: view === "graph" ? `1px solid ${T.borderSoft}` : "none", paddingTop: view === "graph" ? 16 : 0 }}>
              <PartyCardView card={partyCard} onSelect={select} headers={headers} onSaved={reloadCard} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const pickerRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  width: "100%",
  textAlign: "left",
  border: "none",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 13.5,
  cursor: "pointer",
  background: "transparent",
};

// A clickable party chip used throughout the card to navigate the web.
function PartyLink({ name, account, onSelect }: { name: string; account: string; onSelect: (a: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(account)}
      style={{ border: "none", background: "transparent", color: T.accent, cursor: "pointer", padding: 0, fontSize: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}
    >
      {name}
    </button>
  );
}

// Empty state: VRX in the centre, developers around it, agencies/agents listed under each. VRX is a
// first-class node (future: multiple regional VRX nodes — this shape already allows it).
function NetworkMap({ people, onSelect }: { people: Person[]; onSelect: (a: string) => void }) {
  const developers = people.filter((p) => p.role === "developer");
  const agencies = people.filter((p) => p.role === "agency");
  const agents = people.filter((p) => p.role === "agent");
  return (
    <div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 999, background: T.accentSoft, border: `1px solid ${T.accent}55`, color: T.text, fontWeight: 600 }}>
        ◉ VRX <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.7 }}>· the network root</span>
      </div>
      <p style={{ fontSize: 13, opacity: 0.6, marginTop: 10 }}>
        {developers.length} developer{developers.length === 1 ? "" : "s"} · {agencies.length} agencies ·{" "}
        {agents.length} agents connected. Pick anyone on the left, or a name below, to open their card.
      </p>
      <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
        {developers.map((d) => (
          <div key={d.account} style={{ padding: "8px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
            <span style={{ fontSize: 11, color: roleColor.developer, textTransform: "uppercase", letterSpacing: 0.5 }}>Developer</span>{" "}
            <PartyLink name={d.legalName} account={d.account} onSelect={onSelect} />
          </div>
        ))}
        {agencies.length > 0 && (
          <div style={{ padding: "8px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
            <div style={{ fontSize: 11, color: roleColor.agency, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Agencies</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 13.5 }}>
              {agencies.map((a) => <PartyLink key={a.account} name={a.legalName} account={a.account} onSelect={onSelect} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Radial "spring" graph — pure SVG, no dependency ────────────────────────────────
// VRX (or the selected party) sits at the centre; its direct connections ring around it; second-degree
// connections (an agency's agents) sit on an outer arc near their parent. Links are curved. A gentle
// per-node float (requestAnimationFrame + a sine offset seeded per node) gives the "spring/alive" feel
// WITHOUT a physics engine. Every node is clickable → selects that party (re-centres the graph + opens
// its flat card below). Whole-network when nothing is selected; re-centred on the selected party otherwise.

type GNode = {
  account: string;
  uid: string; // STABLE per-node id within a view — unique even when the same account appears twice (e.g. an
               // agency gated to two developers shows as two nodes). All interaction state (refs, drag,
               // tween-from, hover) is keyed by uid, NOT account, to avoid duplicate-account collisions.
  label: string;
  role: "vrx" | "developer" | "agency" | "agent";
  ring: number; // 0 = centre, 1 = direct, 2 = second-degree, 3 = third
  angle: number; // radians
  parentAngle?: number; // for placement near its parent
  inBooking?: number; // recorded bookings in flight → amber PULSING badge (live/active)
  sold?: number; // confirmed sales (booked + unavailable > 2 weeks) → green static badge (settled)
  bookable?: Bookable[]; // agencies only: buildings they can book, grouped by developer (hover tooltip)
};

const NODE_FILL: Record<GNode["role"], string> = {
  vrx: T.accent, developer: T.accent, agency: T.vetted, agent: T.alt,
};

function NetworkGraph({
  people, graph, selected, card, onSelect,
}: {
  people: Person[];
  graph: GraphDeveloper[];
  selected: string | null;
  card: PartyCard | null;
  onSelect: (a: string) => void;
}) {
  const nameByAccount = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people) m.set(p.account.toLowerCase(), p.legalName);
    return m;
  }, [people]);

  // Per-node manual drag offsets (committed on pointerup), keyed by account. Reset when the focus changes
  // so a re-centre starts from clean resting positions. Mid-drag we write the DOM transform DIRECTLY (via
  // refs) so dragging does NOT re-render the React tree every pointermove — only pointerup commits to state.
  // Manual drag offsets, keyed by account — PERSISTED per focus in localStorage so a layout the user
  // arranges is REMEMBERED across reloads + navigation. Key = the focus (whole-network or the
  // centred party). Load on focus change; save whenever it changes.
  const layoutKey = `vrx.graph.layout.${selected ?? "__network__"}`;
  const [dragOffsets, setDragOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(layoutKey);
      setDragOffsets(raw ? JSON.parse(raw) : {});
    } catch { setDragOffsets({}); }
  }, [layoutKey]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (Object.keys(dragOffsets).length) window.localStorage.setItem(layoutKey, JSON.stringify(dragOffsets));
      else window.localStorage.removeItem(layoutKey);
    } catch { /* storage full / disabled — layout just won't persist */ }
  }, [dragOffsets, layoutKey]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodeRefs = useRef<Record<string, SVGGElement | null>>({});
  const drag = useRef<{ uid: string; account: string; startX: number; startY: number; baseDx: number; baseDy: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<string | null>(null); // hovered node UID (for the agency tooltip)

  // ── Zoom + pan: essential once the network grows past a handful of nodes. A single <g>
  // wraps all links+nodes and carries `translate(pan) scale(zoom)`. Node-DRAG and background-PAN are kept
  // separate by event target: node pointerdown stops propagation, so the svg's own pointerdown = PAN only.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const ZOOM_MIN = 0.4, ZOOM_MAX = 4;
  const panDrag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // ── Short re-centre TWEEN: on a click/focus change the layout animates SMOOTHLY from the old
  // positions to the new ones for ~0.5s, then stops. rAF runs ONLY during that window — CPU/GPU is busy for
  // the transition and idle the rest of the time (the explicit tradeoff asked for; a hard jump was
  // showing before). `prevPos` remembers where each account last rendered so we can interpolate; a node with
  // no prior position animates out from the centre instead of popping.
  const prevPos = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [tween, setTween] = useState(1); // 1 = settled (no animation); <1 = animating
  const tweenRaf = useRef(0);
  const startTween = useCallback(() => {
    cancelAnimationFrame(tweenRaf.current);
    const t0 = performance.now();
    const DUR = 520;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      setTween(p);
      if (p < 1) tweenRaf.current = requestAnimationFrame(step);
    };
    setTween(0);
    tweenRaf.current = requestAnimationFrame(step);
  }, []);
  // Kick a tween whenever the FOCUS changes (click to re-centre). Drag-release kicks its own below.
  // Also clear any hover — the hovered node may not exist in the new view (stale-index bug fix).
  useEffect(() => {
    setHover(null);
    startTween();
    return () => cancelAnimationFrame(tweenRaf.current);
  }, [selected, startTween]);

  // Build the node set for the current focus as a HIERARCHICAL RADIAL TREE. Each node carries its own
  // (ring, angle); children are spread WITHIN their parent's angular sector so the whole thing fans out
  // ("pans out") and nodes don't pile on top of each other. Whole-network = 4 layers: VRX → developers →
  // agencies → agents. A centred party = that party + the layers that hang off it.
  type Tree = { account: string; label: string; role: GNode["role"]; inBooking?: number; sold?: number; bookable?: Bookable[]; children: Tree[] };
  // deals/bookable carried only when known from the overview graph (whole-network view). A centred party's
  // sub-nodes come from the party card, which doesn't carry per-node deal counts, so their badges stay absent.
  const graphAgencyByAccount = useMemo(() => {
    const m = new Map<string, GraphAgency>();
    graph.forEach((d) => d.agencies.forEach((a) => m.set(a.account.toLowerCase(), a)));
    return m;
  }, [graph]);
  // Account → {inBooking, sold} for EVERY party (dev/agency/agent), sourced from the overview graph. The
  // party card's sub-node lists don't carry counts, so a CENTRED view looks these up — otherwise an agent's
  // badge + pulse vanished when you centred on its agency (they only showed in the whole-network view). The
  // centre node itself uses card.liveDeals. (bug fix.)
  const countsByAccount = useMemo(() => {
    const m = new Map<string, { inBooking: number; sold: number }>();
    graph.forEach((d) => {
      m.set(d.account.toLowerCase(), { inBooking: d.inBooking, sold: d.sold });
      d.agencies.forEach((a) => {
        m.set(a.account.toLowerCase(), { inBooking: a.inBooking, sold: a.sold });
        a.agents.forEach((ag) => m.set(ag.account.toLowerCase(), { inBooking: ag.inBooking, sold: ag.sold }));
      });
    });
    return m;
  }, [graph]);
  const cnt = (acct: string) => countsByAccount.get(acct.toLowerCase()) ?? { inBooking: 0, sold: 0 };
  const tree = useMemo<Tree>(() => {
    // Only trust `card` when it matches the current selection — during a fetch the previous party's card can
    // still be in state; ignoring it avoids a flash of the WRONG party's graph (bug fix).
    const cardMatches = !!card && !!selected && card.account.toLowerCase() === selected.toLowerCase();
    if (!selected || !cardMatches || !card) {
      // Whole network: VRX → each developer → its gated agencies → each agency's agents.
      return {
        account: "__vrx__", label: "VRX", role: "vrx",
        children: graph.map((dev) => ({
          account: dev.account, label: dev.name, role: "developer" as const, inBooking: dev.inBooking, sold: dev.sold,
          children: dev.agencies.filter((a) => a.gated).map((a) => ({
            account: a.account, label: a.name, role: "agency" as const, inBooking: a.inBooking, sold: a.sold, bookable: a.bookable,
            children: (a.agents ?? []).map((ag) => ({ account: ag.account, label: ag.name, role: "agent" as const, inBooking: ag.inBooking, sold: ag.sold, children: [] })),
          })),
        })),
      };
    }
    const root: Tree = { account: card.account, label: card.kyc.legalName, role: card.role, inBooking: card.liveDeals, children: [] };
    if (card.role === "developer") {
      root.children = (card.agenciesWithAccess ?? []).map((a) => ({
        account: a.account, label: a.name, role: "agency" as const, ...cnt(a.account),
        bookable: graphAgencyByAccount.get(a.account.toLowerCase())?.bookable, children: [],
      }));
    } else if (card.role === "agency") {
      root.children = [
        ...(card.buildingsVisible ?? []).map((v) => ({ account: v.developerAccount, label: v.developerName, role: "developer" as const, ...cnt(v.developerAccount), children: [] })),
        ...(card.agents ?? []).map((a) => ({ account: a.account, label: a.name, role: "agent" as const, ...cnt(a.account), children: [] })),
      ];
    } else if (card.role === "agent") {
      if (card.agency) {
        root.children.push({
          account: card.agency.account, label: card.agency.name, role: "agency", ...cnt(card.agency.account),
          bookable: graphAgencyByAccount.get(card.agency.account.toLowerCase())?.bookable, children: [],
        });
      }
      const seen = new Set<string>();
      (card.buildingsViaAgency ?? []).forEach((b) => {
        const k = b.developerAccount.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        root.children.push({ account: b.developerAccount, label: nameByAccount.get(k) ?? b.viaDeveloper, role: "developer", ...cnt(b.developerAccount), children: [] });
      });
    }
    return root;
  }, [selected, card, graph, nameByAccount, graphAgencyByAccount, countsByAccount]);

  // Flatten the tree into positioned GNodes as an UPWARD FAN: the root sits at the BOTTOM and
  // each deeper ring grows UPWARD — VRX → developer → agency → agent, bottom to top, so the user learns one
  // consistent orientation. Children fan across an arc ABOVE their parent (centred on "straight up", -90°);
  // deeper rings stay within their parent's slice so branches don't cross.
  const FAN = Math.PI * 0.82; // total spread of the top-level fan (a wide upward cone, not a full circle)
  const nodes = useMemo<GNode[]>(() => {
    const out: GNode[] = [];
    // uid = path from the root ("0", "0.2", "0.2.1" …) — stable + unique even for duplicate accounts.
    const place = (t: Tree, ring: number, a0: number, a1: number, uid: string, parentAngle?: number) => {
      const angle = (a0 + a1) / 2;
      out.push({ account: t.account, uid, label: t.label, role: t.role, ring, angle, parentAngle, inBooking: t.inBooking, sold: t.sold, bookable: t.bookable });
      const kids = t.children;
      if (!kids.length) return;
      // keep a small margin inside the sector so sibling branches don't touch
      const pad = (a1 - a0) * 0.05;
      const lo = a0 + pad, hi = a1 - pad;
      const step = (hi - lo) / kids.length;
      kids.forEach((k, i) => place(k, ring + 1, lo + i * step, lo + (i + 1) * step, `${uid}.${i}`, angle));
    };
    // The root's children fan across an arc centred on -90° (straight UP): [-90°-FAN/2, -90°+FAN/2].
    const up = -Math.PI / 2;
    place(tree, 0, up - FAN / 2, up + FAN / 2, "0");
    return out;
  }, [tree, FAN]);

  // Geometry — STATIC resting positions (computed once per focus, not per frame). Float + glide are CSS
  // (compositor-driven), so GPU/CPU stays idle except during an active drag. Four rings (VRX→dev→agency→
  // agent); the centre sits LOW so the fan has room to grow upward. Radii spread so it "pans out".
  const W = 760, H = 560, cx = W / 2, cy = H - 70; // centre near the BOTTOM (upward-fan layout)
  const R = [0, 150, 270, 380]; // radius per ring (0..3) — larger now that the fan uses the full height
  // Resting positions (no drag). The committed position adds any drag offset for that account.
  const rest = nodes.map((n) => ({
    x: cx + Math.cos(n.angle) * R[n.ring],
    y: cy + Math.sin(n.angle) * R[n.ring],
  }));
  // TARGET (settled) position = resting + any saved drag offset (keyed by uid, not account — duplicate-safe).
  const target = (i: number) => {
    const off = dragOffsets[nodes[i].uid];
    return { x: rest[i].x + (off?.dx ?? 0), y: rest[i].y + (off?.dy ?? 0) };
  };
  // easeOutCubic for a snappy-then-soft settle.
  const ease = (p: number) => 1 - Math.pow(1 - p, 3);
  // DISPLAYED position: during a tween, interpolate from where the node last was (or the centre, if it's
  // new) to its target; when settled (tween===1) it's just the target. The lerp is trivial math; the only
  // cost is the rAF-driven re-render, which runs for ~0.5s then stops.
  const posOf = (i: number) => {
    const to = target(i);
    if (tween >= 1) return to;
    const from = prevPos.current.get(nodes[i].uid) ?? { x: cx, y: cy }; // new nodes grow out from centre
    const e = ease(tween);
    return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
  };

  // Links: every node connects to its PARENT = the node in the ring directly above, nearest by angle
  // (the tree layout guarantees children sit inside their parent's angular sector, so nearest-angle is the
  // true parent). Works for all 4 rings: developer→VRX, agency→developer, agent→agency.
  const links: { from: number; to: number }[] = [];
  nodes.forEach((n, i) => {
    if (n.ring === 0) return;
    const targetAngle = n.parentAngle ?? n.angle;
    let best = 0, bestD = Infinity;
    nodes.forEach((m, j) => {
      if (m.ring !== n.ring - 1) return;
      const d = Math.abs(((m.angle - targetAngle) + Math.PI) % (Math.PI * 2) - Math.PI);
      if (d < bestD) { bestD = d; best = j; }
    });
    links.push({ from: best, to: i });
  });

  // Displayed positions for THIS render (tween-interpolated). Snapshot them so the NEXT tween starts from
  // where things actually are on screen (so an interrupted/re-click animates smoothly, never jumps).
  const points = nodes.map((_, i) => posOf(i));
  useEffect(() => {
    const m = new Map<string, { x: number; y: number }>();
    nodes.forEach((n, i) => m.set(n.uid, points[i]));
    prevPos.current = m;
  });

  if (nodes.length <= 1) {
    return <p style={{ opacity: 0.6, fontSize: 14 }}>No connections to show for this party.</p>;
  }

  // Convert a client point to SVG viewBox coords (so drag tracks correctly under the responsive scale).
  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: clientX, y: clientY };
    const r = svg.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H };
  };

  const onPointerDown = (uid: string, account: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const off = dragOffsets[uid];
    drag.current = {
      uid, account,
      startX: e.clientX, startY: e.clientY,
      baseDx: off?.dx ?? 0, baseDy: off?.dy ?? 0,
      moved: false,
    };
    // kill the re-centre transition + float while dragging so it tracks the pointer 1:1
    const g = nodeRefs.current[uid];
    if (g) {
      g.style.transition = "none";
      g.parentNode?.appendChild(g); // raise to front (SVG paints in document order) — so it's never hidden
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    // Background PAN (no node grabbed): move the whole <g> with the pointer.
    if (panDrag.current) {
      const pd = panDrag.current;
      const svg = svgRef.current;
      const r = svg?.getBoundingClientRect();
      // convert client delta → viewBox units so pan tracks 1:1 under the responsive scale
      const sx = r ? W / r.width : 1, sy = r ? H / r.height : 1;
      setPan({ x: pd.baseX + (e.clientX - pd.startX) * sx, y: pd.baseY + (e.clientY - pd.startY) * sy });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const p0 = toSvg(d.startX, d.startY);
    const p1 = toSvg(e.clientX, e.clientY);
    // deltas are in viewBox units; nodes live inside the scaled <g>, so divide by zoom to track 1:1
    const dx = d.baseDx + (p1.x - p0.x) / zoom;
    const dy = d.baseDy + (p1.y - p0.y) / zoom;
    if (Math.abs(p1.x - p0.x) > 3 || Math.abs(p1.y - p0.y) > 3) d.moved = true;
    const g = nodeRefs.current[d.uid];
    const idx = nodes.findIndex((n) => n.uid === d.uid);
    if (g && idx >= 0) g.setAttribute("transform", `translate(${rest[idx].x + dx} ${rest[idx].y + dy})`);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (panDrag.current) { panDrag.current = null; return; }
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const g = nodeRefs.current[d.uid];
    if (g) g.style.transition = ""; // restore the re-centre glide
    const p0 = toSvg(d.startX, d.startY);
    const p1 = toSvg(e.clientX, e.clientY);
    if (!d.moved) {
      // a click, not a drag → navigate (VRX / the current centre have nowhere to go → harmless no-op)
      if (d.account !== "__vrx__" && d.account !== (selected ?? "")) onSelect(d.account);
      return;
    }
    // commit the final offset to state (one re-render, links reconnect)
    setDragOffsets((prev) => ({ ...prev, [d.uid]: { dx: d.baseDx + (p1.x - p0.x) / zoom, dy: d.baseDy + (p1.y - p0.y) / zoom } }));
  };

  // Background pan start (pointerdown on the svg itself — node pointerdown stops propagation first).
  const onBgPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    panDrag.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y };
  };

  // Wheel zoom toward the cursor. React's onWheel is PASSIVE (preventDefault is a no-op → the page scrolls
  // too), so we attach a NON-PASSIVE native listener on the svg. Latest zoom/pan read from refs so the
  // handler stays stable without re-subscribing each render.
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const panRef = useRef(pan); panRef.current = pan;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault(); // stop the page from scrolling while zooming the graph
      const r = svg.getBoundingClientRect();
      const z = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor));
      if (next === z) return;
      const vx = ((e.clientX - r.left) / r.width) * W;
      const vy = ((e.clientY - r.top) / r.height) * H;
      setPan((p) => ({ x: vx - (vx - p.x) * (next / z), y: vy - (vy - p.y) * (next / z) }));
      setZoom(next);
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, []);

  // Tooltip target: an agency node being hovered that has bookable buildings. Position as a % of the
  // viewBox so it maps correctly under the responsive SVG scale — and apply the same pan/zoom transform the
  // nodes get (translate(pan) scale(zoom)) so the tooltip follows the node when zoomed/panned.
  const hoverIdx = hover != null ? nodes.findIndex((n) => n.uid === hover) : -1;
  const tip = hoverIdx >= 0 && nodes[hoverIdx].role === "agency" && (nodes[hoverIdx].bookable?.length ?? 0) > 0
    ? { node: nodes[hoverIdx], x: ((pan.x + points[hoverIdx].x * zoom) / W) * 100, y: ((pan.y + points[hoverIdx].y * zoom) / H) * 100 }
    : null;

  return (
    <div style={{ position: "relative" }}>
      {/* Idle animations are CSS-only (compositor, no rAF): the gentle node float + the live-booking pulse.
          Position changes on CLICK are driven by a short rAF TWEEN (see startTween) that runs ~0.5s then
 stops — busy during the transition, idle otherwise (the explicit tradeoff). */}
      <style>{`
        @keyframes vrxNodeFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        .vrx-gfloat { animation: vrxNodeFloat 6s ease-in-out infinite; will-change: transform; }
        @media (prefers-reduced-motion: reduce) { .vrx-gfloat { animation: none; } }
      `}</style>

      {/* Legend overlaid top-right INSIDE the graph area. */}
      <div
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          zIndex: 4,
          maxWidth: "min(360px, 70%)",
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          fontSize: 11,
          color: T.dim,
          flexWrap: "wrap",
          background: "rgba(10,14,23,0.72)",
          border: `1px solid ${T.borderSoft}`,
          borderRadius: 8,
          padding: "6px 9px",
          pointerEvents: "none",
        }}
      >
        <LegendDot color={NODE_FILL.developer} label="Developer / VRX" />
        <LegendDot color={NODE_FILL.agency} label="Agency" />
        <LegendDot color={NODE_FILL.agent} label="Agent" />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 14, height: 14, borderRadius: 999, background: T.hold, color: "#1a1407", fontSize: 9, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>#</span>
          in booking <span style={{ opacity: 0.55 }}>(pulsing = live)</span>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 14, height: 14, borderRadius: 999, background: T.vetted, color: "#06281c", fontSize: 9, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>#</span>
          sold
        </span>
        <span style={{ opacity: 0.6, flexBasis: "100%", textAlign: "right" }}>· click to travel · drag to rearrange (saved) · hover an agency for buildings</span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block", touchAction: "none", cursor: panDrag.current ? "grabbing" : "grab" }}
        onPointerDown={onBgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={(e) => { if (drag.current || panDrag.current) endDrag(e); }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {links.map((l, i) => {
          const a = points[l.from], b = points[l.to];
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 18; // slight bow
          return (
            <path
              key={i}
              d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
              fill="none"
              stroke={T.accent}
              strokeWidth={1.6}
              opacity={0.45}
            />
          );
        })}
        {nodes.map((n, i) => {
          const p = points[i];
          const isCentre = n.ring === 0;
          const rad = [26, 18, 13, 10][n.ring] ?? 10; // per-ring node size (4 rings)
          const inBooking = n.inBooking ?? 0;
          const sold = n.sold ?? 0;
          // Counts/pulse are relevant on EVERY node in the whole-network overview; but in a ZOOMED-IN
          // (party-selected) view only the centred party + its OWN agents should show them — a context
          // node like the developer pulsing with ANOTHER agency's deals was confusing (bug fix).
          const countsRelevant = !selected || isCentre || n.role === "agent";
          const showPulse = countsRelevant && inBooking > 0 && n.role !== "vrx"; // live bookings → heartbeat
          const showInBooking = countsRelevant && inBooking > 0 && n.role !== "vrx";
          const showSold = countsRelevant && sold > 0 && n.role !== "vrx";
          return (
            <g
              key={n.uid}
              ref={(el) => { nodeRefs.current[n.uid] = el; }}
              transform={`translate(${p.x} ${p.y})`}
            >
              {/* PULSE sits OUTSIDE the floating group so its scale origin is the node centre (0,0). Animated
                  with SMIL animateTransform(scale) + opacity — these run on the COMPOSITOR (GPU), so no
                  per-frame re-rasterization (animating `r` would re-raster each frame); effectively free even
                  with many pulsing nodes. Circle is centred at (0,0) so scale grows from the node centre. */}
              {showPulse && (
                // Clean RING-ONLY heartbeat (no fill — a filled disc read as a muddy brown stain over the
                // dark bg). Two staggered bright rings expand to ~1.9× and fade. GPU-only (scale+opacity).
                <>
                  <circle r={rad} fill="none" stroke={T.hold} strokeWidth={3} opacity={0.9} style={{ pointerEvents: "none" }}>
                    <animateTransform attributeName="transform" type="scale" values="1;1.9" dur="1.8s" repeatCount="indefinite" additive="sum" />
                    <animate attributeName="opacity" values="0.9;0" dur="1.8s" repeatCount="indefinite" />
                  </circle>
                  <circle r={rad} fill="none" stroke={T.hold} strokeWidth={3} opacity={0.9} style={{ pointerEvents: "none" }}>
                    <animateTransform attributeName="transform" type="scale" values="1;1.9" dur="1.8s" begin="0.9s" repeatCount="indefinite" additive="sum" />
                    <animate attributeName="opacity" values="0.9;0" dur="1.8s" begin="0.9s" repeatCount="indefinite" />
                  </circle>
                </>
              )}
              <g
                className={isCentre ? undefined : "vrx-gfloat"}
                style={{ cursor: "grab", animationDelay: isCentre ? undefined : `${(i % 6) * 0.5}s` }}
                onPointerDown={onPointerDown(n.uid, n.account)}
                onPointerEnter={n.role === "agency" ? () => setHover(n.uid) : undefined}
                onPointerLeave={n.role === "agency" ? () => setHover((h) => (h === n.uid ? null : h)) : undefined}
              >
                <circle r={rad} fill={NODE_FILL[n.role]} opacity={isCentre ? 0.95 : 0.85} />
                {n.role === "vrx" && (
                  <text textAnchor="middle" dy="0.35em" fontSize={13} fontWeight={700} fill="#fff" style={{ pointerEvents: "none" }}>VRX</text>
                )}
                {/* FULL name (no truncation). Long names wrap onto two lines so they stay
                    compact under the node instead of one very wide line. */}
                {/* VRX already shows its name INSIDE the circle — skip the below-label to avoid a double "VRX". */}
                {n.role !== "vrx" && (() => {
                  const fs = n.ring >= 2 ? 10 : 11;
                  const lines = wrapLabel(n.label, 16);
                  // Place the first line's BASELINE well below the node + its bottom-right badge (badge sits
                  // ~rad+9 below centre). Using absolute y on each tspan (not text dy) so the offset is exact.
                  const firstY = rad + 20;
                  return (
                    <text textAnchor="middle" fontSize={fs} fill={T.text} style={{ pointerEvents: "none" }}>
                      {lines.map((ln, li) => (
                        <tspan key={li} x={0} y={firstY + li * (fs + 2)}>{ln}</tspan>
                      ))}
                    </text>
                  );
                })()}
                {/* IN-BOOKING badge — amber, top-right (paired with the pulse). Only when relevant + > 0. */}
                {showInBooking && (
                  <g transform={`translate(${rad - 1} ${-rad + 1})`} style={{ pointerEvents: "none" }}>
                    <circle r={9} fill={T.hold} stroke={T.panel} strokeWidth={1.5} />
                    <text textAnchor="middle" dy="0.32em" fontSize={10} fontWeight={700} fill="#1a1407">{inBooking}</text>
                  </g>
                )}
                {/* SOLD badge — green, bottom-right. Ready now; renders only when relevant + > 0 (fills it). */}
                {showSold && (
                  <g transform={`translate(${rad - 1} ${rad - 1})`} style={{ pointerEvents: "none" }}>
                    <circle r={9} fill={T.vetted} stroke={T.panel} strokeWidth={1.5} />
                    <text textAnchor="middle" dy="0.32em" fontSize={10} fontWeight={700} fill="#06281c">{sold}</text>
                  </g>
                )}
              </g>
            </g>
          );
        })}
        </g>
      </svg>

      {/* Agency hover tooltip — the buildings they can BOOK, grouped by developer (HTML overlay, % positioned). */}
      {tip && (
        <div
          style={{
            position: "absolute",
            left: `${tip.x}%`,
            top: `${tip.y}%`,
            transform: "translate(-50%, -115%)",
            background: T.panel2,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            padding: "8px 11px",
            minWidth: 170,
            maxWidth: 260,
            boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
            {tip.node.label} <span style={{ fontWeight: 400, opacity: 0.6 }}>· can book</span>
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            {tip.node.bookable!.map((b) => (
              <div key={b.developerName} style={{ fontSize: 11.5, color: T.dim }}>
                <span style={{ opacity: 0.6 }}>via {b.developerName}:</span> {b.buildings.join(", ")}
              </div>
            ))}
          </div>
          {((tip.node.inBooking ?? 0) > 0 || (tip.node.sold ?? 0) > 0) && (
            <div style={{ fontSize: 11, marginTop: 5, display: "flex", gap: 10 }}>
              {(tip.node.inBooking ?? 0) > 0 && <span style={{ color: T.hold }}>{tip.node.inBooking} in booking</span>}
              {(tip.node.sold ?? 0) > 0 && <span style={{ color: T.vetted }}>{tip.node.sold} sold</span>}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// Split a node label into at most two lines for the SVG caption — full name, NO truncation. Breaks at the
// space nearest the middle when the label exceeds `soft` chars; a single long word stays on one line.
function wrapLabel(label: string, soft: number): string[] {
  if (label.length <= soft || !label.includes(" ")) return [label];
  const mid = label.length / 2;
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === " ") {
      const d = Math.abs(i - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    }
  }
  if (best < 0) return [label];
  return [label.slice(0, best), label.slice(best + 1)];
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: 999, background: color, display: "inline-block" }} /> {label}
    </span>
  );
}

// ── The selected party's relation card (role-dependent) ──────────────────────────────────────────────
function PartyCardView({
  card, onSelect, headers, onSaved,
}: {
  card: PartyCard;
  onSelect: (a: string) => void;
  headers: Record<string, string> | undefined;
  onSaved: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <KycHead card={card} />
      {card.role === "developer" && <DeveloperCard card={card} onSelect={onSelect} headers={headers} onSaved={onSaved} />}
      {card.role === "agency" && <AgencyCard card={card} onSelect={onSelect} />}
      {card.role === "agent" && <AgentCard card={card} onSelect={onSelect} />}
      {card.role !== "agent" && <CardAgreements card={card} onSelect={onSelect} />}
    </div>
  );
}

function KycHead({ card }: { card: PartyCard }) {
  const { kyc, liveDeals, role } = card;
  const ageDays = kyc.vettedAt ? Math.floor((Date.now() - kyc.vettedAt) / 86400000) : null;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 20 }}>{kyc.legalName}</strong>
        <span style={{ fontSize: 11, color: roleColor[role], textTransform: "uppercase", letterSpacing: 0.5 }}>{role}</span>
        {kyc.vetted ? <SealedMark /> : <span style={{ color: T.hold, fontSize: 12 }}>⚠ no KYC profile yet</span>}
        <PrivateMark />
      </div>
      <div style={{ marginTop: 4, fontSize: 13, color: T.dim, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
        {kyc.region && <span>{kyc.region}</span>}
        <code style={chip}>{card.account}</code>
        {ageDays != null && <span style={{ opacity: 0.6 }}>vetted {ageDays}d ago</span>}
      </div>
      <div style={{ marginTop: 6, fontSize: 13 }}>
        <span style={{ color: liveDeals > 0 ? T.hold : T.faint }}>
          {liveDeals} live deal{liveDeals === 1 ? "" : "s"} in progress
        </span>
        <span style={{ opacity: 0.6 }}> — presence only (no contents); a checksum against commission.</span>
      </div>
    </div>
  );
}

function DeveloperCard({
  card, onSelect, headers, onSaved,
}: {
  card: PartyCard;
  onSelect: (a: string) => void;
  headers: Record<string, string> | undefined;
  onSaved: () => void;
}) {
  return (
    <>
      {card.vrxTerms && (
        <VrxTermsEditor account={card.account} terms={card.vrxTerms} headers={headers} onSaved={onSaved} />
      )}
      <CardGroup title="Buildings they own">
        {(card.buildingsOwned ?? []).length === 0
          ? <Muted>None listed.</Muted>
          : <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
              {card.buildingsOwned!.map((b) => <span key={b.id} style={pill}>{b.name}</span>)}
            </div>}
      </CardGroup>
      <CardGroup title="Agencies with access">
        {(card.agenciesWithAccess ?? []).length === 0
          ? <Muted>No agencies gated in yet.</Muted>
          : <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 13.5 }}>
              {card.agenciesWithAccess!.map((a) => <PartyLink key={a.account} name={a.name} account={a.account} onSelect={onSelect} />)}
            </div>}
      </CardGroup>
      {(card.agenciesNoAccess ?? []).length > 0 && (
        <CardGroup title="Vetted agencies without access yet" hint="candidates to open up">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 13.5, opacity: 0.8 }}>
            {card.agenciesNoAccess!.map((a) => <PartyLink key={a.account} name={a.name} account={a.account} onSelect={onSelect} />)}
          </div>
        </CardGroup>
      )}
    </>
  );
}

//  §config-surface — VRX-root edits the developer's VRX COMMERCIAL TERMS: the protocol fee %
// and the settlement window (working days). These are VRX's OWN terms with the developer (hence root-set),
// distinct from the developer's buyer-default terms (which the developer sets on their own app). A blank box
// = "use the standard figure" (the placeholder shows the in-force default). Saves via the operator-gated POST.
function VrxTermsEditor({
  account, terms, headers, onSaved,
}: {
  account: string;
  terms: NonNullable<PartyCard["vrxTerms"]>;
  headers: Record<string, string> | undefined;
  onSaved: () => void;
}) {
  const [fee, setFee] = useState(terms.protocolFeePct.override != null ? String(terms.protocolFeePct.override) : "");
  const [days, setDays] = useState(terms.vrxSettleWorkingDays.override != null ? String(terms.vrxSettleWorkingDays.override) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/root/party", {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify({
          account,
          protocolFeePct: fee.trim() === "" ? null : Number(fee),
          vrxSettleWorkingDays: days.trim() === "" ? null : Number(days),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Save failed (${res.status})`);
      }
      setMsg("Saved.");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const box: React.CSSProperties = {
    width: 72, padding: "6px 8px", borderRadius: 7, border: `1px solid ${T.borderSoft}`,
    background: T.bg2, color: T.text, textAlign: "right",
  };

  return (
    <CardGroup title="VRX terms with this developer" hint="VRX's fee + settlement window — only you set these">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4, color: T.dim }}>
          Protocol fee
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input value={fee} disabled={busy} inputMode="decimal" placeholder={String(terms.protocolFeePct.default)}
              onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))} style={box} /> % per sale
          </span>
        </label>
        <label style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4, color: T.dim }}>
          Settlement window
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input value={days} disabled={busy} inputMode="numeric" placeholder={String(terms.vrxSettleWorkingDays.default)}
              onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ""))} style={box} /> working days
          </span>
        </label>
        <button type="button" disabled={busy} onClick={() => void save()}
          style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${T.borderSoft}`, background: T.accent, color: "#fff", cursor: "pointer", fontSize: 13, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 6 }}>
        Blank = the standard figure ({terms.protocolFeePct.default}% / {terms.vrxSettleWorkingDays.default} working days).
        In force now: {terms.protocolFeePct.effective}% · {terms.vrxSettleWorkingDays.effective} working days.
        {msg && <span style={{ marginLeft: 8, color: msg === "Saved." ? T.vetted : "#ff8080" }}>{msg}</span>}
      </div>
    </CardGroup>
  );
}

function AgencyCard({ card, onSelect }: { card: PartyCard; onSelect: (a: string) => void }) {
  const visible = card.buildingsVisible ?? [];
  return (
    <>
      <CardGroup title="Which buildings they can see" hint="via the developers that granted access">
        {visible.length === 0
          ? <Muted>No building access yet.</Muted>
          : <div style={{ display: "grid", gap: 6 }}>
              {visible.map((v) => (
                <div key={v.developerAccount} style={{ fontSize: 13.5 }}>
                  <span style={{ opacity: 0.6 }}>Via </span>
                  <PartyLink name={v.developerName} account={v.developerAccount} onSelect={onSelect} />
                  <span style={{ opacity: 0.6 }}> (access granted): </span>
                  {v.buildings.map((b) => b.name).join(", ") || "—"}
                </div>
              ))}
            </div>}
      </CardGroup>
      <CardGroup title="Their agents">
        {(card.agents ?? []).length === 0
          ? <Muted>No agents registered.</Muted>
          : <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 13.5 }}>
              {card.agents!.map((a) => <PartyLink key={a.account} name={a.name} account={a.account} onSelect={onSelect} />)}
            </div>}
      </CardGroup>
    </>
  );
}

function AgentCard({ card, onSelect }: { card: PartyCard; onSelect: (a: string) => void }) {
  const via = card.buildingsViaAgency ?? [];
  return (
    <>
      <CardGroup title="Their agency">
        {card.agency
          ? <span style={{ fontSize: 13.5 }}><PartyLink name={card.agency.name} account={card.agency.account} onSelect={onSelect} /></span>
          : <Muted>Not linked to an agency in our records.</Muted>}
      </CardGroup>
      <CardGroup title="Which buildings they can see" hint="inherited from their agency's access">
        {via.length === 0
          ? <Muted>None — their agency has no access yet.</Muted>
          : <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
              {via.map((b) => (
                <span key={`${b.developerAccount}/${b.id}`} style={pill}>
                  {b.name} <span style={{ opacity: 0.6 }}>· via {b.viaDeveloper}</span>
                </span>
              ))}
            </div>}
      </CardGroup>
      {card.agentNote && <div style={{ fontSize: 12.5, opacity: 0.55 }}>{card.agentNote}</div>}
    </>
  );
}

function CardAgreements({ card, onSelect }: { card: PartyCard; onSelect: (a: string) => void }) {
  const other = (a: PartyAgreement) =>
    card.role === "developer"
      ? { name: a.agencyName ?? "(open — awaiting a join)", account: a.seal.agency }
      : { name: a.developerName, account: a.seal.developer };
  return (
    <CardGroup title="Their agreements" hint="commission — private 🔒, sealed ⭐">
      {card.agreements.length === 0
        ? <Muted>No agreements.</Muted>
        : <div style={{ display: "grid", gap: 8 }}>
            {card.agreements.map((a) => {
              const o = other(a);
              const pendingEnd = a.status === "agreed" && !!a.revokeRequestBy;
              return (
                <div key={a.id} style={{ padding: "8px 11px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 14 }}>
                      with {o.account ? <PartyLink name={o.name} account={o.account} onSelect={onSelect} /> : <strong>{o.name}</strong>}
                    </span>
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <StatusBadge status={pendingEnd ? "pending-end" : a.status} />
                      {a.verified ? <SealedMark /> : <span style={{ color: T.danger, fontSize: 12 }}>⚠ unverified</span>}
                    </span>
                  </div>
                  <div style={{ marginTop: 5, fontSize: 12.5, color: T.text }}>
                    Rate <PrivateMark />: {a.buildings.map((b) => `${b.buildingName} ${b.commissionPct}%`).join(" · ")}
                  </div>
                  <ExpiryLine expiry={a.expiry} status={a.status} />
                </div>
              );
            })}
          </div>}
    </CardGroup>
  );
}

// Expiry COUNTDOWN (§4): live day count for an AGREED agreement; amber in the reminder window, red if past.
function ExpiryLine({ expiry, status }: { expiry: Expiry; status: AgreementStatus }) {
  if (expiry.months == null) return <div style={{ fontSize: 12.5, color: T.dim, marginTop: 3 }}>duration not stated</div>;
  if (status !== "agreed" || expiry.expiresAt == null)
    return <div style={{ fontSize: 12.5, color: T.dim, marginTop: 3 }}>{expiry.months}-month term (not running — not yet agreed)</div>;
  const days = Math.ceil((expiry.expiresAt - Date.now()) / 86400000);
  const date = new Date(expiry.expiresAt).toLocaleDateString();
  const color = expiry.expired ? T.danger : expiry.expiringSoon ? T.hold : T.text;
  const text = expiry.expired
    ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago (${date})`
    : `expires in ${days} day${days === 1 ? "" : "s"} (${date})`;
  return (
    <div style={{ fontSize: 12.5, color, marginTop: 3 }}>
      {text}
      {expiry.expiringSoon && !expiry.expired && <span style={{ opacity: 0.8 }}> · remind both parties</span>}
    </div>
  );
}

function CardGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
        {title} {hint && <span style={{ fontWeight: 400, opacity: 0.55 }}>— {hint}</span>}
      </div>
      <div style={{ marginTop: 5 }}>{children}</div>
    </div>
  );
}
const Muted = ({ children }: { children: React.ReactNode }) => <span style={{ opacity: 0.6, fontSize: 13 }}>{children}</span>;
const pill: React.CSSProperties = { fontSize: 12.5, padding: "2px 10px", borderRadius: 999, background: T.bg2, border: `1px solid ${T.borderSoft}`, color: T.dim };

// ── Standing & accuracy (§3c) — the VRX-ROOT misrepresentation console ──────────────
// The operator action surface that closes the §3c second-trigger seam end-to-end: flag a developer for a
// misrepresentation (an operator JUDGMENT, never machine-computed), see the standing it produces,
// withdraw it (no-latch — the developer corrected it), and RUN the stage-advancement scheduler so flagged
// developers actually advance grace→suspended→removed and every party on their deals is notified in the chat.
// Reads/writes /api/root/misrepresentations (the same operator-secret gate as the rest of /root).

type StandingStage = "good" | "grace" | "suspended" | "removed";
type StandingReason = "none" | "late_payment" | "misrepresentation";
type Standing = {
  stage: StandingStage;
  reasons: StandingReason[];
  overdueUnpaidCount: number;
  firstMissedDueAt?: number;
  suspendsAt?: number;
  removesAt?: number;
};
type Assertion = {
  id: string;
  developer: string;
  assertedBy: string;
  assertedAt: number;
  buildingId?: string;
  reason?: string;
  cleared?: { by: string; reason?: string; at: number };
};
type StandingResp = { assertions: Assertion[]; standing: Standing };
type AdvanceReport = {
  asOf: number;
  advances: { developer: string; stage: StandingStage; reasons: StandingReason[]; notified: boolean; requestIds: string[] }[];
  notifiedCount: number;
};

const STAGE_STYLE: Record<StandingStage, { bg: string; fg: string; label: string }> = {
  good: { bg: "#15271b", fg: "#7ce0a0", label: "in good standing" },
  grace: { bg: "#2a2413", fg: "#ffcf70", label: "grace period" },
  suspended: { bg: "#2a1c13", fg: "#ffb270", label: "suspended" },
  removed: { bg: "#26161a", fg: "#ff9a9a", label: "removed" },
};

function StandingPanel({ people, headers }: { people: Person[]; headers: Record<string, string> | undefined }) {
  const developers = useMemo(() => people.filter((p) => p.role === "developer"), [people]);
  const [selected, setSelected] = useState<string>("");
  // Deep-link from the "Needs attention" adverse-standing roll-up (?section=standing&focus=<developer>):
  // pre-select that developer so the operator lands on the right case in one click. Match case-insensitively
  // (the focus id is the stored account) and clear the focus once consumed so later manual nav isn't hijacked.
  const { focus, clearFocus } = useShellFocus("standing");
  useEffect(() => {
    if (!focus) return;
    const match = developers.find((d) => d.account.toLowerCase() === focus.toLowerCase());
    if (match) setSelected(match.account);
    clearFocus();
  }, [focus, developers, clearFocus]);
  const [resp, setResp] = useState<StandingResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Assert form.
  const [reason, setReason] = useState("");
  const [buildingId, setBuildingId] = useState("");
  // Scheduler run report.
  const [report, setReport] = useState<AdvanceReport | null>(null);
  const [reportErr, setReportErr] = useState<string | null>(null);

  const load = useCallback(async (developer: string) => {
    if (!developer) { setResp(null); return; }
    setErr(null); setLoading(true);
    try {
      const res = await fetch(`/api/root/misrepresentations?developer=${encodeURIComponent(developer)}`, { headers });
      if (res.status === 401) { setErr("Operator secret required (set it in ⚙ Settings)."); setResp(null); return; }
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as StandingResp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { load(selected); }, [selected, load]);

  const post = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/root/misrepresentations", {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { setErr("Operator secret required."); return false; }
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `Failed (${res.status}).`); }
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [headers]);

  const doAssert = async () => {
    const ok = await post({ action: "assert", developer: selected, reason: reason.trim() || undefined, buildingId: buildingId.trim() || undefined });
    if (ok) { setReason(""); setBuildingId(""); await load(selected); }
  };
  const clearOne = async (id: string) => { if (await post({ action: "clear", id })) await load(selected); };
  const clearAll = async () => { if (await post({ action: "clear", developer: selected })) await load(selected); };

  const runScheduler = async () => {
    setBusy(true); setReportErr(null); setReport(null);
    try {
      const res = await fetch("/api/root/misrepresentations", {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify({ action: "advance" }),
      });
      if (res.status === 401) { setReportErr("Operator secret required."); return; }
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setReport((await res.json()) as AdvanceReport);
      if (selected) await load(selected); // the selected developer's standing may have advanced
    } catch (e) {
      setReportErr(e instanceof Error ? e.message : "Run failed.");
    } finally {
      setBusy(false);
    }
  };

  const active = (resp?.assertions ?? []).filter((a) => !a.cleared);
  const cleared = (resp?.assertions ?? []).filter((a) => a.cleared);

  return (
    <section style={{ ...card }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Standing &amp; accuracy <PrivateMark /></h2>
      <p style={{ fontSize: 13, opacity: 0.6, marginTop: 0 }}>
        Flag a developer whose listing was found materially wrong and not corrected (an operator judgment — never
        automatic). The flag drives the same grace → suspended → removed stages as a late protocol fee; withdraw it
        the moment they correct it. Run the advancement to notify everyone on an affected developer&apos;s deals.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ fontSize: 13, color: T.dim }}>Developer</label>
        <select
          value={selected}
          onChange={(e) => { setSelected(e.target.value); setReport(null); setReportErr(null); }}
          style={{ ...input, marginBottom: 0, width: 260, fontSize: 13, padding: "6px 10px" }}
        >
          <option value="">— pick a developer —</option>
          {developers.map((d) => <option key={d.account} value={d.account}>{d.legalName}</option>)}
        </select>
        <button type="button" onClick={runScheduler} disabled={busy} style={{ ...refreshBtn, minHeight: 30, height: 30 }}>
          {busy ? "…" : "▶ Run standing advancement"}
        </button>
      </div>

      {err && <p style={{ color: "#ff8080", fontSize: 13, marginTop: 10 }}>{err}</p>}
      {loading && <p style={{ opacity: 0.5, fontSize: 13, marginTop: 10 }}>Loading…</p>}

      {selected && resp && !loading && (
        <div style={{ marginTop: 14, display: "grid", gap: 14 }}>
          {/* Current standing */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: T.dim }}>Current standing:</span>
            <span style={{ fontSize: 12, padding: "3px 12px", borderRadius: 999, ...stageChip(resp.standing.stage) }}>
              {STAGE_STYLE[resp.standing.stage].label}
            </span>
            {resp.standing.reasons.filter((r) => r !== "none").map((r) => (
              <span key={r} style={{ fontSize: 11, opacity: 0.7 }}>· {r === "misrepresentation" ? "accuracy" : "late payment"}</span>
            ))}
            {resp.standing.firstMissedDueAt && (
              <span style={{ fontSize: 12, opacity: 0.55 }}>clock from {fmtDate(resp.standing.firstMissedDueAt)}</span>
            )}
          </div>

          {/* Assert form */}
          <CardGroup title="Flag a misrepresentation" hint="operator judgment — seals an audit record, starts the §3c clock">
            <div style={{ display: "grid", gap: 8 }}>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What was found wrong (audit note — VRX-root only)"
                style={{ ...input, marginBottom: 0, fontSize: 13, padding: "6px 10px" }}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  value={buildingId}
                  onChange={(e) => setBuildingId(e.target.value)}
                  placeholder="Building id (optional)"
                  style={{ ...input, marginBottom: 0, width: 220, fontSize: 13, padding: "6px 10px" }}
                />
                <button type="button" onClick={doAssert} disabled={busy} style={dangerBtn}>
                  Flag developer
                </button>
              </div>
            </div>
          </CardGroup>

          {/* Active assertions */}
          <CardGroup title={`Active flags · ${active.length}`} hint="withdraw once corrected — no penalty latch">
            {active.length === 0
              ? <Muted>None — this developer is not flagged for accuracy.</Muted>
              : <div style={{ display: "grid", gap: 6 }}>
                  {active.map((a) => (
                    <div key={a.id} style={rowS}>
                      <span style={{ fontSize: 13 }}>
                        {a.reason || "(no note)"} {a.buildingId && <span style={{ opacity: 0.6 }}>· {a.buildingId}</span>}
                        <span style={{ opacity: 0.6 }}> · flagged {fmtDate(a.assertedAt)}</span>
                      </span>
                      <button type="button" onClick={() => clearOne(a.id)} disabled={busy} style={clearBtn}>withdraw</button>
                    </div>
                  ))}
                  {active.length > 1 && (
                    <button type="button" onClick={clearAll} disabled={busy} style={{ ...clearBtn, justifySelf: "start" }}>
                      withdraw all
                    </button>
                  )}
                </div>}
          </CardGroup>

          {/* Cleared (audit trail) */}
          {cleared.length > 0 && (
            <CardGroup title={`Withdrawn · ${cleared.length}`} hint="kept for audit; no longer affects standing">
              <div style={{ display: "grid", gap: 4 }}>
                {cleared.map((a) => (
                  <div key={a.id} style={{ ...rowS, opacity: 0.6 }}>
                    <span style={{ fontSize: 12.5 }}>
                      {a.reason || "(no note)"}<span style={{ opacity: 0.6 }}> · flagged {fmtDate(a.assertedAt)}</span>
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.7 }}>withdrawn {fmtDate(a.cleared!.at)}</span>
                  </div>
                ))}
              </div>
            </CardGroup>
          )}
        </div>
      )}

      {/* Scheduler run report */}
      {reportErr && <p style={{ color: "#ff8080", fontSize: 13, marginTop: 10 }}>{reportErr}</p>}
      {report && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}` }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            Advancement run · {fmtDate(report.asOf)}{" "}
            <span style={{ fontWeight: 400, opacity: 0.6 }}>
              — {report.notifiedCount} developer{report.notifiedCount === 1 ? "" : "s"} newly notified
            </span>
          </div>
          <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
            {report.advances.filter((a) => a.stage !== "good").length === 0
              ? <Muted>No developer is in an adverse stage.</Muted>
              : report.advances.filter((a) => a.stage !== "good").map((a) => (
                  <div key={a.developer} style={rowS}>
                    <span style={{ fontSize: 13 }}>
                      {a.developer}{" "}
                      <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, ...stageChip(a.stage) }}>
                        {STAGE_STYLE[a.stage].label}
                      </span>
                    </span>
                    <span style={{ fontSize: 12, color: a.notified ? T.hold : T.faint }}>
                      {a.notified ? `notified ${a.requestIds.length} deal${a.requestIds.length === 1 ? "" : "s"}` : "already announced"}
                    </span>
                  </div>
                ))}
          </div>
        </div>
      )}
    </section>
  );
}

const stageChip = (stage: StandingStage) => ({ background: STAGE_STYLE[stage].bg, color: STAGE_STYLE[stage].fg });
const dangerBtn: React.CSSProperties = {
  border: `1px solid ${T.danger}66`, background: "#26161a", color: "#ff9a9a",
  cursor: "pointer", fontSize: 13, padding: "6px 16px", borderRadius: 8, minHeight: 32,
};
const clearBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`, background: T.panel2, color: T.dim,
  cursor: "pointer", fontSize: 12, padding: "3px 12px", borderRadius: 999, minHeight: 24, height: 24, lineHeight: 1,
};

// ── Payments & disputes (VRX-root payment visibility) — the God's-eye money view ──
// Operator-gated read of /api/root/payments. Per developer: the VRX protocol-fee line + each agency-commission
// line (owed/paid/prospective) + buyer-DISPUTE signal. PRIVACY LINE (doc §7): root sees dispute COUNT +
// oldest-open AGE always, but a dispute's AMOUNT + NOTE + evidence flag ONLY when a party shared that record to
// `vrx` (disputeShare). The route enforces this; this UI just renders what it's given. plain words.

type RootDealLine = { requestId: string; building: string; unitId: string; amountUsd: number; kind: "earned" | "prospective"; payable?: boolean; payableReason?: string; vrxPayable?: boolean; vrxPayableReason?: string; vrxDueAt?: number | null };
type RootVrxFee = { accruedUsd: number; prospectiveUsd: number; outstandingUsd: number; saleCount: number; deals: RootDealLine[] };
type RootAgencyLine = { agency: string; agencyName: string; accruedUsd: number; prospectiveUsd: number; payableUsd: number; outstandingUsd: number; saleCount: number; deals: RootDealLine[] };
type RootSharedDispute = { requestId?: string; buildingId?: string; unitId?: string; amountUsd: number; note?: string; hasEvidence: boolean; disputedAt: number };
type RootDevPayments = {
  developer: string;
  developerName: string;
  vrxFee: RootVrxFee | null;
  agencies: RootAgencyLine[];
  disputes: { count: number; oldestOpenAgeDays: number | null; shared: RootSharedDispute[] };
};
type PaymentsResp = {
  totals: { commission: { accruedUsd: number; payableUsd: number; outstandingUsd: number; saleCount: number }; vrxFee: { accruedUsd: number; outstandingUsd: number; saleCount: number }; openDisputes: number };
  byDeveloper: RootDevPayments[];
};

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function PaymentsPanel({ headers }: { headers: Record<string, string> | undefined }) {
  const [resp, setResp] = useState<PaymentsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch("/api/root/payments", { headers });
      if (res.status === 401) { setErr("Operator secret required (set it in ⚙ Settings)."); setResp(null); return; }
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as PaymentsResp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { load(); }, [load]);

  if (err) return <section style={card}><p style={{ color: T.danger, fontSize: 13 }}>{err}</p></section>;
  if (!resp) return <section style={card}><p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p></section>;

  const { totals, byDeveloper } = resp;

  return (
    <section style={{ ...card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>Payments &amp; disputes</h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 14px", maxWidth: 680 }}>
        What each developer owes VRX (protocol fee) and their agencies (commission), plus any buyer disputes.
        Dispute details stay private to the developer and buyer unless a party shares a record with VRX.
      </p>

      {/* Totals strip */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16 }}>
        <TotalChip label="VRX fee owed" value={usd(totals.vrxFee.outstandingUsd)} sub={`${totals.vrxFee.saleCount} sale${totals.vrxFee.saleCount === 1 ? "" : "s"}`} />
        <TotalChip label="Commission payable" value={usd(totals.commission.payableUsd)} sub={`of ${usd(totals.commission.accruedUsd)} earned`} />
        <TotalChip label="Open disputes" value={String(totals.openDisputes)} tone={totals.openDisputes > 0 ? T.danger : undefined} />
      </div>

      {byDeveloper.length === 0 && <p style={{ opacity: 0.6, fontSize: 14 }}>No facilitated sales to settle yet.</p>}

      <div style={{ display: "grid", gap: 14 }}>
        {byDeveloper.map((d) => <DevPaymentsCard key={d.developer} d={d} />)}
      </div>
    </section>
  );
}

function TotalChip({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ padding: "8px 14px", borderRadius: 10, background: T.bg2, border: `1px solid ${T.borderSoft}`, minWidth: 130 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone ?? T.text, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function DevPaymentsCard({ d }: { d: RootDevPayments }) {
  const hasDisputes = d.disputes.count > 0;
  return (
    <div style={{ ...card, marginTop: 0, padding: "14px 16px", borderColor: hasDisputes ? T.danger : T.border }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 16 }}>{d.developerName}</strong>
        {hasDisputes && (
          <Link
            href={`/root?section=standing&focus=${encodeURIComponent(d.developer)}`}
            style={{ color: T.danger, fontSize: 12.5, textDecoration: "none" }}
            title="A dispute can be an early distress signal — review this developer's standing"
          >
            ⚠ {d.disputes.count} open dispute{d.disputes.count === 1 ? "" : "s"}
            {d.disputes.oldestOpenAgeDays !== null ? ` · oldest ${d.disputes.oldestOpenAgeDays}d` : ""} →
          </Link>
        )}
      </div>

      {/* VRX fee line */}
      {d.vrxFee ? (
        <div style={{ marginTop: 8, fontSize: 13.5 }}>
          <span style={{ opacity: 0.7 }}>Owes VRX: </span>
          <strong>{usd(d.vrxFee.outstandingUsd)}</strong>
          <span style={{ opacity: 0.55 }}> · {d.vrxFee.saleCount} confirmed sale{d.vrxFee.saleCount === 1 ? "" : "s"}{d.vrxFee.prospectiveUsd > 0 ? ` · ${usd(d.vrxFee.prospectiveUsd)} prospective` : ""}</span>
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: 13, opacity: 0.6 }}>No VRX fee owed yet.</div>
      )}

      {/* Agency commission lines */}
      {d.agencies.length > 0 && (
        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
          {d.agencies.map((a) => (
            <div key={a.agency} style={{ ...rowS, background: T.bg2 }}>
              <span>Owes <strong>{a.agencyName}</strong></span>
              <span style={{ fontSize: 13 }}>
                <span style={{ color: a.payableUsd > 0 ? T.vetted : T.dim }}>{usd(a.payableUsd)} payable</span>
                <span style={{ opacity: 0.6 }}> / {usd(a.accruedUsd)} earned</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Shared disputes (only records a party opened to VRX) */}
      {d.disputes.shared.length > 0 && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.danger, marginBottom: 4 }}>
            Shared with VRX for review
          </div>
          {d.disputes.shared.map((s, i) => (
            <div key={s.requestId ?? i} style={{ fontSize: 12.5, opacity: 0.85, padding: "3px 0" }}>
              {usd(s.amountUsd)} · {s.buildingId ?? "—"} {s.unitId ?? ""}
              {s.note ? <span style={{ fontStyle: "italic" }}> — “{s.note}”</span> : null}
              {s.hasEvidence ? <span style={{ opacity: 0.6 }}> · evidence attached</span> : null}
            </div>
          ))}
        </div>
      )}
      {hasDisputes && d.disputes.shared.length === 0 && (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.55, fontStyle: "italic" }}>
          Dispute details stay private to the developer and buyer unless a party shares a record with VRX.
        </div>
      )}
    </div>
  );
}

// ── Counts strip ───────────────────────────────────────────────────────────────────────────────────
// `compact` = the header variant: smaller numbers + tighter gaps so it fits inline between
// the intro and the search box.
function Counts({ data, compact }: { data: Overview | null; compact?: boolean }) {
  const c = data?.counts;
  const item = (n: number | undefined, label: string) => (
    <span style={{ fontSize: compact ? 12 : 13, color: T.dim }}>
      <strong style={{ color: T.text, fontSize: compact ? 14 : 18 }}>{n ?? "—"}</strong> {label}
    </span>
  );
  return (
    <div style={{ display: "flex", gap: compact ? 12 : 20, alignItems: "baseline", flexWrap: "wrap" }}>
      {item(c?.developers, "developers")}
      {item(c?.agencies, "agencies")}
      {item(c?.agents, "agents")}
      {item(c?.agreements, "agreements")}
    </div>
  );
}

// ── Needs attention ─────────────────────────────────────────────────────────────────────────────────
function AttentionPanel({ attention }: { attention: Overview["attention"] }) {
  const { adverseStanding, openInvitations, pendingKyc, stalledDeals, expiringAgreements, ungatedAgencies } = attention;
  const total =
    adverseStanding.length + openInvitations.length + pendingKyc.length + stalledDeals.length + expiringAgreements.length + ungatedAgencies.length;
  // The most-severe adverse stage present drives the panel border (a removed/suspended developer is the
  // loudest signal the team has — louder than an expiring agreement). danger for suspended/removed, hold for grace.
  const worstAdverse = adverseStanding.some((d) => d.stage === "suspended" || d.stage === "removed")
    ? T.danger
    : adverseStanding.length > 0
    ? T.hold
    : total
    ? T.hold
    : T.border;

  return (
    <section style={{ ...card, borderColor: worstAdverse }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>
        Needs attention {total > 0 && <span style={{ color: T.hold }}>· {total}</span>}
      </h2>
      {total === 0 && <p style={{ opacity: 0.6, fontSize: 14 }}>All clear — nothing waiting on the team.</p>}

      {/* Adverse standing (§3c) FIRST — the loudest signal: a developer late paying VRX and/or asserted to have
          misrepresented a listing. Each row deep-links to the Standing & accuracy console with that developer
 pre-selected, so the team acts in one click. plain words ("flagged"/"paused"/"removed"). */}
      {adverseStanding.length > 0 && (
        <AttnGroup title="Developers needing action" hint="late paying VRX and/or a listing found inaccurate — act in the Standing console">
          {adverseStanding.map((d) => {
            const stageLabel = d.stage === "grace" ? "flagged" : d.stage === "suspended" ? "paused" : "removed";
            const stageColor = d.stage === "grace" ? T.hold : T.danger;
            const why = d.reasons.includes("misrepresentation") && d.reasons.includes("late_payment")
              ? "late payment + inaccurate listing"
              : d.reasons.includes("misrepresentation")
              ? "inaccurate listing"
              : "late payment";
            const clock = d.stage === "grace" && d.suspendsAt
              ? `pauses ${fmtDate(d.suspendsAt)}`
              : d.stage === "suspended" && d.removesAt
              ? `removes ${fmtDate(d.removesAt)}`
              : "";
            return (
              <Link
                key={d.developer}
                href={`/root?section=standing&focus=${encodeURIComponent(d.developer)}`}
                style={{ ...rowS, textDecoration: "none", color: T.text }}
              >
                <span>
                  <strong>{d.developerName}</strong>
                  <span style={{ opacity: 0.6 }}> · {why}</span>
                </span>
                <span style={{ color: stageColor, fontSize: 13 }}>
                  {stageLabel}{clock ? ` · ${clock}` : ""}
                </span>
              </Link>
            );
          })}
        </AttnGroup>
      )}

      {expiringAgreements.length > 0 && (
        <AttnGroup title="Agreements expiring soon" hint="remind BOTH parties (~2 months ahead)">
          {expiringAgreements.map((a) => (
            <div key={a.id} style={rowS}>
              <span>
                <strong>{a.developerName}</strong> ↔ <strong>{a.agencyName ?? "—"}</strong>
              </span>
              <span style={{ color: a.expired ? T.danger : T.hold, fontSize: 13 }}>
                {a.expired ? "expired" : "expires"} {fmtDate(a.expiresAt)}
              </span>
            </div>
          ))}
        </AttnGroup>
      )}

      {stalledDeals.length > 0 && (
        <AttnGroup title="Stalled proposals" hint="no response — nudge the waiting party">
          {stalledDeals.map((d) => (
            <div key={d.id} style={rowS}>
              <span>
                <strong>{d.developerName}</strong> ↔ <strong>{d.agencyName ?? "—"}</strong>
                <span style={{ opacity: 0.6 }}> · {d.proposedBy} proposed</span>
              </span>
              <span style={{ color: T.hold, fontSize: 13 }}>
                waiting on {d.waitingOnName} · {d.sinceDays}d
              </span>
            </div>
          ))}
        </AttnGroup>
      )}

      {pendingKyc.length > 0 && (
        <AttnGroup title="Pending KYC" hint="in the network but no vetted profile yet">
          {pendingKyc.map((p) => (
            <div key={p.account} style={rowS}>
              <code style={chip}>{p.account}</code>
              <span style={{ opacity: 0.6, fontSize: 13 }}>{p.roleHint}</span>
            </div>
          ))}
        </AttnGroup>
      )}

      {openInvitations.length > 0 && (
        <AttnGroup title="Open invitations" hint="agency onboarding in progress">
          {openInvitations.map((i) => (
            <div key={i.token} style={rowS}>
              <span>
                {i.label ?? i.account ?? "(unlabelled invite)"}
                <span style={{ opacity: 0.6 }}> · {i.status === "applied" ? "awaiting vetting" : "invite sent"}</span>
              </span>
              <span style={{ opacity: 0.6, fontSize: 12 }}>
                {i.status === "invited" ? `expires ${fmtDate(i.expiresAt)}` : fmtDate(i.updatedAt)}
              </span>
            </div>
          ))}
        </AttnGroup>
      )}

      {ungatedAgencies.length > 0 && (
        <AttnGroup title="Vetted but no access yet" hint="agencies ready to work, not gated to any developer">
          {ungatedAgencies.map((a) => (
            <div key={a.account} style={rowS}>
              <span><strong>{a.name}</strong> <span style={{ opacity: 0.6 }}>· {a.region}</span></span>
              <code style={chip}>{a.account}</code>
            </div>
          ))}
        </AttnGroup>
      )}
    </section>
  );
}

function AttnGroup({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
        {title} <span style={{ fontWeight: 400, opacity: 0.55 }}>— {hint}</span>
      </div>
      <div style={{ marginTop: 6, display: "grid", gap: 4 }}>{children}</div>
    </div>
  );
}

const rowS: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "baseline",
  fontSize: 14,
  padding: "4px 8px",
  borderRadius: 6,
  background: T.bg2,
};

// ── Escalations (F-slice) — the VRX-ROOT review queue for direct-desk conversations a party referred to
// VRX. Either party (buyer or desk) can flag a conversation; it stays LIVE while VRX mediates. Here root sees the
// OPEN queue (neutral buyer account + building + who flagged + reason — NEVER the buyer's sealed PII, the moat
// holds) and posts a resolution IN the thread, which marks the flag resolved. Operator-gated like the rest of /root.
type OpenEscalation = { id: string; buyer: string; building: string; by: "buyer" | "developer"; at: number; reason?: string };

function EscalationsPanel({ headers }: { headers: Record<string, string> | undefined }) {
  const [open, setOpen] = useState<OpenEscalation[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch("/api/root/escalations", { headers });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load");
      setOpen(j.open ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { void load(); }, [load]);

  async function resolve(id: string) {
    setBusyId(id);
    try {
      const res = await fetch("/api/root/escalations", {
        method: "POST",
        headers: { ...(headers ?? {}), "content-type": "application/json" },
        body: JSON.stringify({ conversationId: id, message: replies[id]?.trim() || undefined }),
      });
      if (res.ok) { setReplies((r) => ({ ...r, [id]: "" })); await load(); }
    } catch {
      /* leave */
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Escalations</h2>
      <p style={{ fontSize: 13, opacity: 0.7, maxWidth: 640, lineHeight: 1.5 }}>
        Direct-desk conversations a buyer or desk referred to VRX. The deal stays open while you review. You see the
        neutral account + building + the concern — never the buyer&apos;s private details. Replying posts a note
        into their conversation and clears the flag.
      </p>
      {err && <p style={{ color: "#ff8080", fontSize: 13 }}>{err}</p>}
      {loading && open.length === 0 ? (
        <p style={{ fontSize: 13, opacity: 0.6 }}>Loading…</p>
      ) : open.length === 0 ? (
        <p style={{ fontSize: 13, opacity: 0.6 }}>No open escalations.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {open.map((e) => (
            <div key={e.id} style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: "10px 12px", background: T.bg2 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {e.building} · flagged by the {e.by === "buyer" ? "buyer" : "desk"}
              </div>
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, fontFamily: T.mono }}>{e.buyer}</div>
              {e.reason && <div style={{ fontSize: 12.5, marginTop: 6, opacity: 0.85 }}>&ldquo;{e.reason}&rdquo;</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  value={replies[e.id] ?? ""}
                  onChange={(ev) => setReplies((r) => ({ ...r, [e.id]: ev.target.value }))}
                  placeholder="Reply into the conversation (optional)…"
                  style={{ flex: 1, fontSize: 12, padding: "5px 9px", borderRadius: 7, border: `1px solid ${T.border}`, background: T.panel, color: T.text }}
                />
                <button onClick={() => void resolve(e.id)} disabled={busyId === e.id} style={{ background: "none", border: `1px solid ${T.border}`, color: T.text, fontSize: 12, cursor: "pointer", padding: "5px 12px", borderRadius: 7 }}>
                  {busyId === e.id ? "…" : "Reply & resolve"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Change governance (S190h Slice 7) — the VRX-ROOT TIER-0 correction REVIEW queue ─────────────────────────
// The read side of the change-governance arc + its one ACTION: review a developer's request to correct an
// IMMUTABLE land legal-anchor (title deed / survey page / land number / address). These anchors cannot change
// through the normal edit path (immutable_tier0); a genuine typo is fixed ONLY via a VRX-reviewed correction.
// Approving one is the single highest-privilege write in the model — it overrides land immutability — so the UI
// shows the full before→after diff + the developer's reason and labels the gravity plainly, never a casual
// one-click approve. Operator-gated (x-vrx-operator). Reads/decides /api/root/change-governance.

type LandAnchors = {
  titleDeedNum?: string; surveyPageNum?: string; landNumber?: string; address?: string; addressTH?: string;
};
type QueueCorrection = {
  id: string; building: string; buildingName: string; developer: string;
  before: LandAnchors; after: LandAnchors; reason: string;
  status: "open" | "approved" | "rejected"; at: number;
};

// Plain-words labels for the land anchors (no contract/field-code talk in the VRX-team UI).
const ANCHOR_LABEL: Record<keyof LandAnchors, string> = {
  titleDeedNum: "Title deed no.",
  surveyPageNum: "Survey page no.",
  landNumber: "Land number",
  address: "Registered address",
  addressTH: "Registered address (Thai)",
};

function ChangeGovernancePanel({ headers }: { headers: Record<string, string> | undefined }) {
  const [queue, setQueue] = useState<QueueCorrection[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch("/api/root/change-governance", { headers });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load");
      setQueue(j.queue ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { void load(); }, [load]);

  async function decide(id: string, decision: "approved" | "rejected") {
    // Approving overrides immutability — confirm deliberately (the gravity flag, not a casual click).
    if (decision === "approved" && typeof window !== "undefined") {
      if (!window.confirm("Approve this correction? This overrides the immutability of a land legal-anchor on a building that is on contract. The corrected value is written, a before/after record is sealed, and every affected party is notified. VRX records the correction — it does not warrant the new value.")) return;
    }
    setBusyId(id);
    try {
      const res = await fetch("/api/root/change-governance", {
        method: "POST",
        headers: { ...(headers ?? {}), "content-type": "application/json" },
        body: JSON.stringify({ id, decision, by: "vrx-root" }),
      });
      if (res.ok) await load();
      else { const j = await res.json().catch(() => ({})); setErr(j.error ?? "Could not decide"); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not decide");
    } finally {
      setBusyId(null);
    }
  }

  // The changed anchors only: fields whose before ≠ after (incl. a newly-set or cleared anchor).
  const changedFields = (c: QueueCorrection): (keyof LandAnchors)[] => {
    const keys = Object.keys(ANCHOR_LABEL) as (keyof LandAnchors)[];
    return keys.filter((k) => (c.before[k] ?? "") !== (c.after[k] ?? ""));
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Change governance</h2>
      <p style={{ fontSize: 13, opacity: 0.7, maxWidth: 680, lineHeight: 1.5 }}>
        Requests to correct an <strong>immutable</strong> land legal-anchor — the title deed, survey page, land
        number or registered address — on a building that is already on contract. These never change through the
        normal edit path. Approving a correction <strong>overrides that immutability</strong>: the corrected value
        is written, a sealed before/after record is kept, and every affected agency and buyer is notified. VRX
        records the correction and the evidence — it does not warrant that the new value is correct.
      </p>
      {err && <p style={{ color: T.danger, fontSize: 13 }}>{err}</p>}
      {loading && queue.length === 0 ? (
        <p style={{ fontSize: 13, opacity: 0.6 }}>Loading…</p>
      ) : queue.length === 0 ? (
        <p style={{ fontSize: 13, opacity: 0.6 }}>No corrections awaiting review.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {queue.map((c) => {
            const fields = changedFields(c);
            return (
              <div key={c.id} style={{ border: `1px solid ${T.hold}55`, borderRadius: 9, padding: "12px 14px", background: T.bg2 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                    {c.buildingName} <span style={{ fontWeight: 400, opacity: 0.6 }}>· land correction requested</span>
                  </div>
                  <div style={{ fontSize: 11.5, opacity: 0.55 }}>{fmtDate(c.at)}</div>
                </div>
                <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 2, fontFamily: T.mono }}>{c.developer}</div>

                {/* The before → after diff — only the anchors that actually changed. */}
                <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                  {fields.length === 0 && (
                    <div style={{ fontSize: 12.5, opacity: 0.6 }}>No field change detected in this request.</div>
                  )}
                  {fields.map((k) => (
                    <div key={k} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 8, fontSize: 12.5, alignItems: "baseline" }}>
                      <div style={{ opacity: 0.6 }}>{ANCHOR_LABEL[k]}</div>
                      <div>
                        <span style={{ color: T.danger, textDecoration: "line-through", opacity: 0.8 }}>
                          {c.before[k] || "—"}
                        </span>
                        <span style={{ opacity: 0.5, margin: "0 7px" }}>→</span>
                        <span style={{ color: T.vetted, fontWeight: 600 }}>{c.after[k] || "—"}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {c.reason && (
                  <div style={{ fontSize: 12.5, marginTop: 10, padding: "7px 10px", background: T.panel, borderRadius: 7, borderLeft: `3px solid ${T.hold}` }}>
                    <span style={{ opacity: 0.55 }}>Reason given:</span> &ldquo;{c.reason}&rdquo;
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    onClick={() => void decide(c.id, "approved")}
                    disabled={busyId === c.id}
                    style={{ background: T.vetted, border: "none", color: "#06281c", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "6px 14px", borderRadius: 7 }}
                  >
                    {busyId === c.id ? "…" : "Approve correction"}
                  </button>
                  <button
                    onClick={() => void decide(c.id, "rejected")}
                    disabled={busyId === c.id}
                    style={{ background: "none", border: `1px solid ${T.border}`, color: T.text, fontSize: 12.5, cursor: "pointer", padding: "6px 14px", borderRadius: 7 }}
                  >
                    {busyId === c.id ? "…" : "Reject"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Inventory oversight (§2) — the VRX-ROOT view of what developers do to their ──
// on-contract inventory, + the trust-dial that sets WHO approves a developer's version-gated changes.
// Two jobs, both operator-gated (same x-vrx-operator posture as the rest of /root):
//   1. A persistent, NOT-dismissible audit of inventory.* change notices, grouped per developer / day / type,
//      with a one-click ESCALATE (= the §3c misrepresentation assert — no new enforcement machine).
//  2. The APPROVER trust-dial: per developer, set whether they self-approve ("developer") or a VRX/CEO
//      wallet signs their changes off ("ceo"/"vrx"). This is what re-routes the Approve/Reject power on a pending
//      inventory version from the developer to the CEO — request-approval stamps this approver onto each version.
// Reads/writes /api/root/inventory-oversight (groups + escalate) and /api/root/approver (the trust-dial).

type OversightVerb =
  | "inventory.repriced" | "inventory.off_market" | "inventory.availability"
  | "inventory.unit_added" | "inventory.unit_removed" | "inventory.unit_changed" | "inventory.listing_updated";
type OversightGroup = {
  developer: string; day: string; verb: OversightVerb; count: number; latestAt: number;
  buildings: string[];
  entries: { at: number; context?: { building?: string; count?: number; direction?: string } }[];
};
type ApproverRole = "developer" | "ceo" | "vrx";
type OversightPolicy = {
  developer: string;
  approver: string;
  approverRole: ApproverRole;
  policyPreset: string;
  updatedAt: number;
};
type OversightResp = { groups: OversightGroup[]; policies: OversightPolicy[] };

// Plain-words label per inventory verb (building + count/direction only ever reached the spine).
const OVERSIGHT_VERB_LABEL: Record<OversightVerb, string> = {
  "inventory.repriced": "repriced",
  "inventory.off_market": "took off-market",
  "inventory.availability": "changed availability",
  "inventory.unit_added": "added a unit",
  "inventory.unit_removed": "removed a unit",
  "inventory.unit_changed": "changed a unit",
  "inventory.listing_updated": "updated the listing",
};

function InventoryOversightPanel({ people, headers }: { people: Person[]; headers: Record<string, string> | undefined }) {
  const nameByAccount = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people) m.set(p.account.toLowerCase(), p.legalName);
    return m;
  }, [people]);
  const developers = useMemo(() => people.filter((p) => p.role === "developer"), [people]);

  const [resp, setResp] = useState<OversightResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const res = await fetch("/api/root/inventory-oversight", { headers });
      if (res.status === 401) { setErr("Operator secret required (set it in ⚙ Settings)."); setResp(null); return; }
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as OversightResp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [headers]);
  useEffect(() => { load(); }, [load]);

  const escalate = useCallback(async (developer: string, buildingId?: string) => {
    const reason = window.prompt(`Escalate ${nameByAccount.get(developer.toLowerCase()) ?? developer}? Add an internal note (VRX-root only):`);
    if (reason === null) return; // cancelled
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/root/inventory-oversight", {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify({ action: "escalate", developer, buildingId, reason: reason.trim() || undefined }),
      });
      if (res.status === 401) { setErr("Operator secret required."); return; }
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `Failed (${res.status}).`); }
      // Escalate writes a standing flag — no oversight-group change to reload, but refresh so the operator sees
      // the action took (and any subsequent note). Harmless, keeps the panel honest.
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Escalate failed.");
    } finally {
      setBusy(false);
    }
  }, [headers, load, nameByAccount]);

  const policyByDev = useMemo(() => {
    const m = new Map<string, OversightPolicy>();
    for (const p of resp?.policies ?? []) m.set(p.developer.toLowerCase(), p);
    return m;
  }, [resp]);

  return (
    <section style={{ ...card }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Inventory oversight <PrivateMark /></h2>
      <p style={{ fontSize: 13, opacity: 0.6, marginTop: 0 }}>
        What each developer is doing to their on-contract inventory (building + count + direction only — never a
        price or terms). Nothing here is dismissible; it&apos;s the audit trail. Set who signs a developer&apos;s
        version-gated changes off below. Escalate if a pattern looks wrong — it flags their standing.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
        {err && <span style={{ color: "#ff8080", fontSize: 13 }}>{err}</span>}
      </div>

      {/* ── The approver trust-dial, per developer ── */}
      <div style={{ marginTop: 16 }}>
        <CardGroup title="Change approver" hint="who signs a developer's version-gated changes off — default is the developer themselves">
          {developers.length === 0 ? <Muted>No developers yet.</Muted> : (
            <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
              {developers.map((d) => (
                <ApproverRow
                  key={d.account}
                  developer={d.account}
                  developerName={d.legalName}
                  policy={policyByDev.get(d.account.toLowerCase())}
                  headers={headers}
                  disabled={busy}
                  onSaved={load}
                />
              ))}
            </div>
          )}
        </CardGroup>
      </div>

      {/* ── The change-activity audit, grouped ── */}
      <div style={{ marginTop: 18 }}>
        <CardGroup title="Recent inventory changes" hint="grouped per developer, day, and change type — newest first">
          {loading && !resp ? <Muted>Loading…</Muted>
            : (resp?.groups.length ?? 0) === 0 ? <Muted>No on-contract inventory changes recorded yet.</Muted>
            : (
              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                {resp!.groups.map((g, i) => (
                  <div key={`${g.developer}|${g.day}|${g.verb}|${i}`} style={{ ...rowS, alignItems: "center" }}>
                    <span style={{ fontSize: 13.5 }}>
                      <strong>{nameByAccount.get(g.developer.toLowerCase()) ?? g.developer}</strong>{" "}
                      {OVERSIGHT_VERB_LABEL[g.verb] ?? g.verb}
                      {g.count > 1 && <span style={{ opacity: 0.6 }}> ×{g.count}</span>}
                      {g.buildings.length > 0 && <span style={{ opacity: 0.6 }}> · {g.buildings.join(", ")}</span>}
                      <span style={{ opacity: 0.6 }}> · {g.day}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => escalate(g.developer, g.buildings.length === 1 ? undefined : undefined)}
                      disabled={busy}
                      style={clearBtn}
                      title="Flag this developer's standing (opens an internal note)"
                    >
                      escalate
                    </button>
                  </div>
                ))}
              </div>
            )}
        </CardGroup>
      </div>
    </section>
  );
}

// One developer's approver control: shows the current approver, lets VRX-root flip developer⇄CEO and type the
// CEO/VRX NEAR wallet. Default (developer self-approves) = the account IS the developer; picking CEO reveals the
// wallet field. Saves to /api/root/approver (setApprover, re-seals the policy). A developer with no policy yet
// (not on contract) can't be set — we say so instead of failing silently.
function ApproverRow({
  developer, developerName, policy, headers, disabled, onSaved,
}: {
  developer: string;
  developerName: string;
  policy: OversightPolicy | undefined;
  headers: Record<string, string> | undefined;
  disabled: boolean;
  onSaved: () => void | Promise<void>;
}) {
  // Local draft seeded from the live policy; "ceo" collapses to the role we send (ceo), "developer" self-approves.
  const current: ApproverRole = policy?.approverRole ?? "developer";
  const [role, setRole] = useState<ApproverRole>(current === "vrx" ? "vrx" : current);
  const [wallet, setWallet] = useState(policy && policy.approverRole !== "developer" ? policy.approver : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Resync the draft when the loaded policy changes (e.g. after a save elsewhere / refresh).
  useEffect(() => {
    setRole(policy?.approverRole ?? "developer");
    setWallet(policy && policy.approverRole !== "developer" ? policy.approver : "");
    setMsg(null);
  }, [policy?.approverRole, policy?.approver]);

  const noPolicy = !policy;
  const selfApprove = role === "developer";
  const changed = role !== current || (!selfApprove && wallet.trim().toLowerCase() !== (policy?.approver ?? "").toLowerCase());

  async function save() {
    setBusy(true); setMsg(null);
    // Self-approve → approver = the developer. CEO/VRX → the typed wallet.
    const approver = selfApprove ? developer : wallet.trim();
    if (!selfApprove && !approver) { setMsg("Enter the approver's NEAR account."); setBusy(false); return; }
    try {
      const res = await fetch("/api/root/approver", {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify({ developer, approver, approverRole: role }),
      });
      const b = await res.json().catch(() => ({}));
      if (res.status === 401) { setMsg("Operator secret required."); return; }
      if (res.status === 404) { setMsg("This developer isn't on contract yet — no policy to set."); return; }
      if (!res.ok) { setMsg(typeof b.error === "string" ? b.error : `Failed (${res.status}).`); return; }
      setMsg("Saved.");
      await onSaved();
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...rowS, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 13.5, minWidth: 160 }}>
        <strong>{developerName}</strong>
        {noPolicy && <span style={{ opacity: 0.6, fontSize: 12 }}> · not on contract</span>}
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginLeft: "auto" }}>
        <select
          value={selfApprove ? "developer" : "ceo"}
          onChange={(e) => setRole(e.target.value === "developer" ? "developer" : "ceo")}
          disabled={disabled || busy || noPolicy}
          style={{ ...input, marginBottom: 0, width: 190, fontSize: 12.5, padding: "5px 8px" }}
        >
          <option value="developer">Developer self-approves</option>
          <option value="ceo">VRX / CEO approves</option>
        </select>
        {!selfApprove && (
          <input
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="ceo.vrx.testnet"
            disabled={disabled || busy || noPolicy}
            style={{ ...input, marginBottom: 0, width: 200, fontSize: 12.5, padding: "5px 8px" }}
          />
        )}
        <button type="button" onClick={save} disabled={disabled || busy || noPolicy || !changed} style={{ ...clearBtn, opacity: changed && !noPolicy ? 1 : 0.5 }}>
          {busy ? "…" : "Save"}
        </button>
        {msg && <span style={{ fontSize: 12, opacity: 0.75 }}>{msg}</span>}
      </div>
    </div>
  );
}

// ── Relationship graph: developer → agencies (gated) → agents ────────────────────────────────────────
function GraphPanel({ graph }: { graph: GraphDeveloper[] }) {
  return (
    <section style={{ ...card }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Who&apos;s connected to who</h2>
      {graph.length === 0 && <p style={{ opacity: 0.6, fontSize: 14 }}>No developers in the registry.</p>}
      {graph.map((dev) => (
        <div key={dev.account} style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 16 }}>{dev.name}</strong>
            <code style={chip}>{dev.account}</code>
            <span style={{ fontSize: 12, opacity: 0.55 }}>
              {dev.buildingIds.length} building{dev.buildingIds.length === 1 ? "" : "s"}
            </span>
          </div>
          <div style={{ marginTop: 8, marginLeft: 14, borderLeft: `2px solid ${T.border}`, paddingLeft: 14, display: "grid", gap: 8 }}>
            {dev.agencies.map((ag) => (
              <div key={ag.account}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ color: ag.gated ? T.text : T.faint }}>{ag.name}</span>
                  {ag.gated ? (
                    <span style={{ fontSize: 11, color: T.vetted, border: `1px solid ${T.vetted}55`, borderRadius: 999, padding: "1px 8px" }}>
                      access granted
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: T.faint, border: `1px solid ${T.border}`, borderRadius: 999, padding: "1px 8px" }}>
                      no access yet
                    </span>
                  )}
                  <span style={{ fontSize: 12, opacity: 0.6 }}>{ag.region}</span>
                </div>
                {ag.agents.length > 0 && (
                  <div style={{ marginLeft: 12, marginTop: 3, fontSize: 13, color: T.dim }}>
                    {ag.agents.map((a) => a.name).join(" · ")}
                  </div>
                )}
              </div>
            ))}
            {dev.agencies.length === 0 && <span style={{ opacity: 0.6, fontSize: 13 }}>No agencies vetted yet.</span>}
          </div>
        </div>
      ))}
    </section>
  );
}

// ── Agreements table: status · rate · expiry (private + sealed marks) ────────────────────────────────
function AgreementsPanel({ agreements }: { agreements: Agreement[] }) {
  return (
    <section style={{ ...card }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>
        Commission agreements <PrivateMark />
      </h2>
      <p style={{ fontSize: 13, opacity: 0.6, marginTop: 0 }}>
        The money side of each relationship — kept off-chain and private; sealed so it can&apos;t be altered after signing.
      </p>
      {agreements.length === 0 && <p style={{ opacity: 0.6, fontSize: 14 }}>No agreements yet.</p>}
      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {agreements.map((a) => (
          <AgreementRow key={a.id} a={a} />
        ))}
      </div>
    </section>
  );
}

function AgreementRow({ a }: { a: Agreement }) {
  const pendingEnd = a.status === "agreed" && !!a.revokeRequestBy;
  return (
    <article style={{ padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 15 }}>
          <strong>{a.developerName}</strong>
          <span style={{ opacity: 0.5 }}> ↔ </span>
          <strong>{a.agencyName ?? "(open — awaiting a join)"}</strong>
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={pendingEnd ? "pending-end" : a.status} />
          {a.verified ? <SealedMark /> : <span style={{ color: T.danger, fontSize: 12 }}>⚠ unverified</span>}
        </span>
      </div>
      <div style={{ marginTop: 6, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: T.text }}>
        <span>
          Rate <PrivateMark />:{" "}
          {a.seal.buildings.map((b) => `${b.buildingName ?? b.buildingId} ${b.commissionPct}%`).join(" · ")}
        </span>
        {a.expiry.months != null ? (
          <span style={{ color: a.expiry.expired ? T.danger : a.expiry.expiringSoon ? T.hold : T.text }}>
            {a.status === "agreed"
              ? `${a.expiry.expired ? "expired" : "expires"} ${fmtDate(a.expiry.expiresAt)} (${a.expiry.months}mo term)`
              : `${a.expiry.months}mo term`}
          </span>
        ) : (
          <span style={{ color: T.dim }}>duration not stated</span>
        )}
      </div>
      {a.seal.terms && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: T.dim, whiteSpace: "pre-wrap" }}>
          <PrivateMark /> {prettyTerms(a.seal.terms)}
        </div>
      )}
    </article>
  );
}

function StatusBadge({ status }: { status: AgreementStatus | "pending-end" }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    published: { bg: "#1a2c4d", fg: "#9ec1ff", label: "published" },
    proposed: { bg: "#2a2413", fg: "#ffcf70", label: "proposed" },
    agreed: { bg: "#15271b", fg: "#7ce0a0", label: "agreed" },
    "pending-end": { bg: "#2a2413", fg: "#ffcf70", label: "ending — awaiting confirm" },
    declined: { bg: "#26161a", fg: "#ff9a9a", label: "declined" },
    revoked: { bg: "#201a26", fg: "#c7a2e0", label: "ended" },
  };
  const s = map[status] ?? map.proposed;
  return <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, background: s.bg, color: s.fg }}>{s.label}</span>;
}

// (SecretGate removed — the operator secret now lives in ⚙ Settings, owner-only, via lib/operator-secret.)
// Owner note is rendered compactly in the shell topbar (see OwnerNote above).

// Compact topbar notice: rendered inside the shell's amber topbar-note pill, so it returns plain
// inline content (no banner wrapper). Only shows when NOT the owner — read-only + how to unlock.
function OwnerNote({
  ready, accountId, owner, isOwner, signIn,
}: { ready: boolean; accountId: string | null; owner: string | null; isOwner: boolean; signIn: () => void }) {
  if (!ready || isOwner) return null;
  return accountId ? (
    <span title={`Connected as ${accountId}, not the owner (${owner ?? "…"}). Read-only; set the operator secret in Settings to unlock.`}>
      Read-only — not the owner wallet. Set the operator secret in ⚙ Settings to unlock.
    </span>
  ) : (
    <span>
      VRX team dashboard — set the operator secret in ⚙ Settings, or{" "}
      <button onClick={signIn} style={{ background: "none", border: "none", color: "inherit", textDecoration: "underline", cursor: "pointer", padding: 0, font: "inherit", minHeight: 0 }}>
        connect
      </button>{" "}
      the owner wallet.
    </span>
  );
}
