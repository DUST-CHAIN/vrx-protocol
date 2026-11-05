"use client";

// Role dispatcher / home. Instead of a dev-skeleton "reads the live contract" note, the
// landing now greets the connected account BY ITS ROLE and points it at its own surface:
//   signed out          → what VRX is + Connect
//   us / VRX (owner)    → admin home (provisioning links) + live protocol stats
//   developer/agency/…  → a role home card linking to their app
//   unregistered        → "you're not provisioned yet"
//
// One account = one role (: one Chrome profile per actor). See lib/role.tsx for detection.
// VOCAB: owner=us/VRX, developer/agency/agent are the words (vrx-vocab-translation).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CONTRACT_ID, NETWORK, EXPLORER_URL } from "@/lib/config";
import { getOwner, getToll, getTreasury, getHoldWindow } from "@/lib/vrx";
import { useWallet } from "@/lib/wallet";
import { useRole, ROLE_META, navFor, setDemoRole, DEMO_ROLES, type DemoRoleChoice } from "@/lib/role";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";
import { writeOperatorSecret } from "@/lib/operator-secret";
import { card, submitBtn } from "@/lib/ui";
import { T, seal } from "@/lib/theme";
import { MarksLegend } from "@/lib/marks";
import SealedRing from "@/components/SealedRing";
import VrxLogoMark from "@/components/VrxLogoMark";

export default function Home() {
  const { accountId, ready, signIn, realConnect, connectError, clearConnectError } = useWallet();
  const { role, loading } = useRole();
  // Public-demo sandbox: show the wallet-less role-picker instead of the Connect prompt. Armed only by the
  // explicit flag (or localnet god-mode) — a real wallet deploy leaves it off and the normal flow shows.
  const [demoArmed, setDemoArmed] = useState(false);
  useEffect(() => setDemoArmed(demoRoleUxArmed()), []);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px" }}>
      <span style={seal}>✓ Vetted</span>

      {/* F6: connect-timeout escape hatch. If the wallet handshake hangs (flaky edge → the
          extension's content-script context dies), the modal is closed and this banner shows instead of
          an infinite spinner, so a stuck wallet doesn't read as "VRX is broken". */}
      {connectError && (
        <div
          role="alert"
          style={{
            ...card, marginTop: 16, borderColor: T.border, background: T.bg2,
            display: "flex", gap: 12, alignItems: "flex-start",
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1.4 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{connectError}</p>
          </div>
          <button
            onClick={clearConnectError}
            aria-label="Dismiss"
            style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      )}
      <h1 style={{ fontSize: 34, margin: "12px 0 4px", letterSpacing: -0.5 }}>
        Constitutional freedom to globally transact.
      </h1>
      <p style={{ opacity: 0.75, marginTop: 6, fontSize: 16, lineHeight: 1.55 }}>
        One trusted source of truth for who reserved what — private by design, with your prices and
        terms kept confidential. A peek into the{" "}
        <span style={{ color: T.vetted }}>Vetted Realty</span> world: developers, buildings, units,
        agencies and agents, transacting securely on their own terms.
      </p>

      {/* The two trust marks, explained once here so every 🔒/⭐ across the apps is self-evident. */}
      <section style={{ ...card, marginTop: 24, borderColor: T.borderSoft }}>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: T.faint, textTransform: "uppercase", letterSpacing: 0.6 }}>
          What the marks mean
        </p>
        <MarksLegend />
      </section>

      {!ready && <p style={{ opacity: 0.6, marginTop: 28 }}>Starting wallet…</p>}

      {ready && !accountId && (
        demoArmed
          ? <RealOrDemo connect={realConnect} />   /* both modes + a toggle (default: Demo) */
          : <SignedOut connect={signIn} />         /* flag off (real wallet deploy) → wallet only */
      )}

      {ready && accountId && loading && (
        <p style={{ opacity: 0.6, marginTop: 28 }}>Checking your role on the network…</p>
      )}

      {ready && accountId && !loading && role && (
        <RoleHome role={role} accountId={accountId} />
      )}
    </main>
  );
}

// ── Signed out ──────────────────────────────────────────────────────────────────────────
function SignedOut({ connect }: { connect: () => void | Promise<void> }) {
  return (
    <section style={{ ...card, marginTop: 14 }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Sign in</h2>
      <p style={{ opacity: 0.75, fontSize: 15 }}>
        Connect the wallet we issued to you. You&apos;ll be taken straight to your workspace —
        admin, developer, agency, or agent.
      </p>
      <button onClick={() => void connect()} style={submitBtn}>
        Connect wallet
      </button>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 18 }}>
        Your prices, personal details and deal terms are always kept private and confidential.
      </p>
    </section>
  );
}

// ── REAL / DEMO toggle ───────────────────────────────────────────────────────────────
// Both modes on one landing, switchable (the call): a balanced tab toggle, DEFAULT = Demo so a
// cold visitor (judge) lands in the wallet-less explorable version, with the real wallet one click away.
// Only rendered when the demo UX is armed (NEXT_PUBLIC_VRX_DEMO baked in); a real-wallet deploy skips this
// wrapper entirely (SignedOut only). Switching is pure client state — no reload, no chain.
function RealOrDemo({ connect }: { connect: () => void | Promise<void> }) {
  const [mode, setMode] = useState<"demo" | "real">("demo");
  return (
    <div style={{ marginTop: 28 }}>
      <div role="tablist" style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 10, background: T.bg2, border: `1px solid ${T.border}` }}>
        <button role="tab" aria-selected={mode === "demo"} onClick={() => setMode("demo")} style={toggleTab(mode === "demo")}>
          ✦ Explore the demo
        </button>
        <button role="tab" aria-selected={mode === "real"} onClick={() => setMode("real")} style={toggleTab(mode === "real")}>
          Connect a wallet
        </button>
      </div>
      <p style={{ opacity: 0.55, fontSize: 12.5, margin: "8px 2px 0", lineHeight: 1.5 }}>
        {mode === "demo"
          ? "No wallet needed — step into any role on seeded sandbox data. Switch to a real wallet anytime."
          : "Connect the wallet we issued you to use VRX for real. Or switch back to the no-wallet demo above."}
      </p>
      {mode === "demo" ? <DemoPicker /> : <SignedOut connect={connect} />}
    </div>
  );
}

function toggleTab(active: boolean): React.CSSProperties {
  return {
    padding: "7px 10px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13.5,
    fontWeight: active ? 600 : 400,
    background: active ? T.vetted : "transparent",
    color: active ? "#07140d" : T.text,
  };
}

// ── DEMO role-picker ───────────────────────────────────────────────────────────────
// The public sandbox's front door: "Enter as…" cards that assume a role WITHOUT a wallet. Each card
// calls becomeAccount(the seeded account) + setDemoRole(role) then routes to that role's home. Two
// groups: the four PARTIES (Developer/Agency/Agent/Buyer) + a DIRECT-SALE spotlight (the developer
// selling direct to a walk-in — same actor as Developer, shown separately to highlight that channel).
// Accounts match the seed's dev-key slice + provision-localnet namespace (node/org/agent/buyer.test.near).
type DemoCard = {
  key: string;
  title: string;
  blurb: string;
  account: string;
  role: DemoRoleChoice | null; // null = a STATE not a role (the buyer); no role override, just /buyer
  href: string;
  tag?: string;
};

// Demo identities map to the REAL SEEDED demo actors (vvv-dev-* developers + their gated agencies/agents),
// NOT the localnet dev-key `*.test.near` accounts (those are god-mode-only and are NOT in the public snapshot
// — pointing the picker at them showed "No buildings to show"). vvv-dev-01 owns miracle-tower/oceanview/
// skyline-tower; big-mango is gated to it with bm-agent-1 as an agent; demo-walkin is the spotlight buyer.
const DEMO_PARTIES: DemoCard[] = [
  { key: "developer", title: "Developer", role: "developer", account: "vvv-dev-01.testnet", href: "/node",
    blurb: "Own the units. Grant agencies access, mark availability, confirm bookings — and sell direct to walk-in buyers." },
  { key: "agency", title: "Agency", role: "agency", account: "big-mango.testnet", href: "/agency",
    blurb: "Place buyers through your agents. Manage your salespeople and track their bookings." },
  { key: "agent", title: "Agent", role: "agent", account: "bm-agent-1.testnet", href: "/agent",
    blurb: "Reserve units for buyers on behalf of your agency. Open and follow booking requests." },
  { key: "buyer", title: "Buyer (walk-in)", role: null, account: "demo-walkin.testnet", href: "/buyer",
    blurb: "Browse direct-sale buildings, talk to the developer's desk, and move through the funnel." },
];

// The direct-sale spotlight: SAME developer actor, lands on the developer console — framed as the direct channel.
const DEMO_DIRECT: DemoCard = {
  key: "direct-sale", title: "Direct Sale", role: "developer", account: "vvv-dev-01.testnet", href: "/node",
  tag: "the developer, selling direct",
  blurb: "See the no-agency path: the developer's own desk selling straight to a walk-in buyer (no agent in the middle).",
};

// "More lives to step into": the four DEMO_PARTIES above lead into the single busiest actor of
// each role; these promote a SECOND row of equally-populated ALTERNATE actors so a judge gets a window into
// the "life" of MANY different users — a rival developer, other agencies, other agents — each with its own
// book of real seeded deals. Every account here was verified busy (offers/agreements referencing it) on the
// live box so none lands on an empty dashboard. Thin actors (0 activity) stay in the full-cast list
// below, never promoted. The `role` drives which dashboard + which CARD_ACCENT colour it reuses.
const DEMO_MORE: DemoCard[] = [
  { key: "developer", title: "Meridian Developments", role: "developer", account: "vvv-dev-02.testnet", href: "/node",
    tag: "Central Pattaya", blurb: "A developer in Central Pattaya — Parkgate, Palmgate and Gardengate — managing availability and incoming bookings across its buildings." },
  { key: "developer", title: "Vetta Group", role: "developer", account: "vvv-dev-03.testnet", href: "/node",
    tag: "Pattaya & northpoint", blurb: "A developer with Garden Court in Central Pattaya plus NorthPoint and SouthBay on northpoint Hill — an active sales pipeline." },
  { key: "agency", title: "a global agency (Thailand)", role: "agency", account: "a global agency-th.testnet", href: "/agency",
    tag: "Bangkok", blurb: "A Bangkok agency placing buyers across several developers — manage its agents and track their bookings and performance." },
  { key: "agency", title: "Pattaya Realty", role: "agency", account: "pattaya-realty.testnet", href: "/agency",
    tag: "Pattaya", blurb: "A Pattaya agency working its own book of buyers — see its agents, their bookings and how the desk is performing." },
  { key: "agent", title: "Nina Ivanova", role: "agent", account: "pr-agent-1.testnet", href: "/agent",
    tag: "Pattaya Realty", blurb: "An agent at Pattaya Realty — her own buyers and open bookings, across the developers her agency works with." },
  { key: "agent", title: "Mark Reynolds", role: "agent", account: "sav-agent-2.testnet", href: "/agent",
    tag: "a global agency (Thailand)", blurb: "An agent at a global agency — his own buyers and bookings, across the agency's developer relationships." },
];

function DemoPicker() {
  const { becomeAccount } = useWallet();
  const router = useRouter();

  // The VRX-owner account (for the "VRX team" entry below). Resolve it from the contract so the entry
  // always points at the real owner; CONTRACT_ID is owner on every deploy (DEPLOY.md: "contract/owner"),
  // so it's a safe fallback while the view resolves / if the RPC is throttled.
  const [ownerAccount, setOwnerAccount] = useState<string>(CONTRACT_ID);
  useEffect(() => {
    getOwner().then((o) => o && setOwnerAccount(o)).catch(() => {/* keep CONTRACT_ID fallback */});
  }, []);

  const enter = (c: DemoCard) => {
    becomeAccount(c.account);
    setDemoRole(c.role); // null clears any override (buyer is a state, resolved server-side)
    router.push(c.href);
  };

  // Enter as a SPECIFIC seeded actor from the live roster (the "full cast" section).
  const enterAccount = (account: string, role: DemoRoleChoice, href: string) => {
    becomeAccount(account);
    setDemoRole(role);
    router.push(href);
  };

  // D-: enter as VRX-ROOT (the owner) WITHOUT a wallet. Sets the owner demo-role (fenced to the demo
  // flag by setDemoRole) so `role === "owner"` resolves → the VRX-team dashboards (/root, /applications,
  // /onboarding) become reachable AND the ⚙ Settings operator-secret box appears. The server still gates
  // every /api/root/* write on the real VRX_OPERATOR_SECRET (fail-closed) — so a tester who enters here can
  // VIEW the admin surfaces, but only the holder of the operator key (pasted once per device in Settings)
  // can create developers / flag / act. This is the "now" bearer-secret path; owner-wallet-signature is the
  // later hardening (D- same family as 's per-operator-signature TODO).
  // The key is the REAL lock (checked server-side, fail-closed). We stash it with the existing
  // writeOperatorSecret (sessionStorage, same store /root + Settings read) so /root unlocks in ONE step —
  // no second credential, no digging into Settings. A blank/wrong key still ENTERS the admin VIEW, but every
  // /api/root/* write is denied by the server until the right key is present (that's the point: the card isn't
  // the lock, VRX_OPERATOR_SECRET is).
  const enterAsVrx = (operatorKey: string) => {
    becomeAccount(ownerAccount);
    setDemoRole("owner");
    if (operatorKey.trim()) writeOperatorSecret(operatorKey.trim());
    router.push("/root");
  };

  return (
    <section style={{ ...card, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={seal}>Sandbox demo</span>
      </div>
      <h2 style={{ fontSize: 20, margin: "6px 0 2px" }}>Experience VRX as…</h2>
      <p style={{ opacity: 0.72, fontSize: 14.5, marginTop: 4, lineHeight: 1.5 }}>
        No wallet needed. Step into any role to see its side of the deal — then switch freely from the top bar.
        This is a sandbox: it runs the real app on seeded data and resets clean.
      </p>

      <p style={{ margin: "18px 0 8px", fontSize: 12, color: T.faint, textTransform: "uppercase", letterSpacing: 0.6 }}>
        The parties
      </p>
      {/* The party cards + the VRX-root card PACKED into one grid: the four public roles anyone can
          step into, then the LAST card = VRX itself — the operator, which is NOT a public role (gated by the
          operator key; judges can request access). Same grid so it reads as "…and this is us". */}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {DEMO_PARTIES.map((c) => (
          <PickerCard key={c.key} c={c} onEnter={enter} />
        ))}
        <VrxTeamEntry ownerAccount={ownerAccount} onEnter={enterAsVrx} />
      </div>

      {/* "More lives to step into": the four cards above land on the busiest actor of each role;
          this second row of big buttons promotes OTHER well-populated actors — a rival developer, other
          agencies, other agents — so you get a window into the LIFE of many different users, each with its own
          real book of seeded deals. Every one is verified-busy (never an empty dashboard). */}
      <p style={{ margin: "22px 0 4px", fontSize: 12, color: T.faint, textTransform: "uppercase", letterSpacing: 0.6 }}>
        More lives to step into
      </p>
      <p style={{ opacity: 0.68, fontSize: 13.5, margin: "0 0 10px", lineHeight: 1.5 }}>
        Step into other companies working across Thailand — developers in Pattaya, agencies in Bangkok and
        Pattaya and their agents. Each has its own buildings or book of buyers, its own bookings and its own
        performance to explore.
      </p>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {DEMO_MORE.map((c) => (
          <PickerCard key={`more-${c.account}`} c={c} onEnter={enter} />
        ))}
      </div>

      <p style={{ margin: "20px 0 8px", fontSize: 12, color: T.faint, textTransform: "uppercase", letterSpacing: 0.6 }}>
        A closer look
      </p>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <PickerCard c={DEMO_DIRECT} onEnter={enter} />
      </div>

      {/* The FULL seeded cast — data-driven from the live roster (/api/profiles), so it auto-scales as the seed
 grows (: show scalability; "seed more later" becomes automatic). The 4 cards above are the
          guaranteed-rich entry; this proves VRX runs a whole network of actors, not a handful. */}
      <AllActorsRoster onEnter={enterAccount} />
    </section>
  );
}

// D- — the VRX-team entry card with an inline operator-key prompt. Collapsed to a single line until
// clicked, then reveals the password field + Enter. The key reuses the existing operator-secret store.
// Packs into the party grid as the LAST card: "…and this is us, VRX — NOT a public role".
// The access DECISION (what a no-key judge may) lives in /root via VRX_ROOT_JUDGE_ACCESS, not here —
// this card only ENTERS; /root enforces read-only-shell vs fully-gated. (: "the switch is inside vrx root".)
function VrxTeamEntry({ ownerAccount, onEnter }: { ownerAccount: string; onEnter: (operatorKey: string) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const a = { icon: "🛡️", color: T.vetted };
  return (
    <div
      style={{
        textAlign: "left", borderRadius: 10, padding: "14px 15px",
        border: `1px solid ${a.color}55`, background: `${a.color}0f`, color: T.text,
        display: "grid", gap: 6, borderLeft: `3px solid ${a.color}`,
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Enter as VRX root (${ownerAccount}) — the operator who vets & onboards`}
        style={{ textAlign: "left", cursor: "pointer", background: "none", border: "none", color: T.text, display: "grid", gap: 6, padding: 0 }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 17 }} aria-hidden>{a.icon}</span>
          <span style={{ fontSize: 16, fontWeight: 600, color: a.color }}>VRX (the operator)</span>
        </div>
        <span style={{ fontSize: 13.5, opacity: 0.78, lineHeight: 1.45 }}>
          Us — we vet &amp; onboard everyone: developers, agencies, agents. This is <strong>not a public role</strong>
          {" "}— it&apos;s gated. <span style={{ color: T.faint }}>Hackathon judges: request access from the VRX team.</span>
        </span>
        {!open && <span style={{ fontSize: 13, color: a.color, marginTop: 2 }}>Enter with operator key →</span>}
      </button>
      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); onEnter(key); }}
          style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}
        >
          <input
            type="password"
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Operator key"
            aria-label="VRX operator key"
            style={{
              flex: 1, minWidth: 140, background: "rgba(255,255,255,0.06)", color: "inherit",
              border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "6px 9px", fontSize: 13,
            }}
          />
          <button
            type="submit"
            style={{ cursor: "pointer", borderRadius: 6, padding: "6px 14px", fontSize: 13, fontWeight: 600,
              border: `1px solid ${a.color}`, background: `${a.color}22`, color: a.color }}
          >
            Enter →
          </button>
        </form>
      )}
      {open && (
        <span style={{ fontSize: 11.5, opacity: 0.6, lineHeight: 1.45 }}>
          The key is checked on the server (it unlocks admin actions). Stored only in this browser session.
        </span>
      )}
    </div>
  );
}

// ── Full seeded-actor roster — collapsible, grouped by role, each entry steps into that exact actor ──
type RosterActor = {
  account: string;
  role: "developer" | "agency" | "agent";
  legalName?: string;
  region?: string;
  // enrich the roster rows with vetting + avatar so each entry shows a SEALED avatar (ring + ✓) — the
  // "show vetting where you see other actors" treatment on the one real counterparty-facing surface.
  verified?: boolean;
  portraitUrl?: string | null;
  // : "how much content" — developers=building count, agencies=agent count, agents=verified(1)|0.
  // Drives the busiest-first ordering within each role group (server computes it in /api/profiles).
  contentScore?: number;
};
const ROLE_GROUP: { role: RosterActor["role"]; label: string; demoRole: DemoRoleChoice; href: string }[] = [
  { role: "developer", label: "Developers", demoRole: "developer", href: "/node" },
  { role: "agency", label: "Agencies", demoRole: "agency", href: "/agency" },
  { role: "agent", label: "Agents", demoRole: "agent", href: "/agent" },
];

function AllActorsRoster({ onEnter }: { onEnter: (account: string, role: DemoRoleChoice, href: string) => void }) {
  // : the full cast defaults OPEN — the roster is part of the demo's value, not a hidden extra.
  const [open, setOpen] = useState(true);
  const [actors, setActors] = useState<RosterActor[] | null>(null);

  useEffect(() => {
    if (!open || actors) return;
    void (async () => {
      try {
        const j = await fetch("/api/profiles").then((r) => r.json());
        setActors(Array.isArray(j.profiles) ? j.profiles : []);
      } catch {
        setActors([]);
      }
    })();
  }, [open, actors]);

  const total = actors?.length ?? 0;

  return (
    <div style={{ marginTop: 22, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 16 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", padding: 0, fontSize: 13.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 7 }}
      >
        <span style={{ opacity: 0.7 }}>{open ? "▾" : "▸"}</span>
        Explore the full cast{actors ? ` — ${total} seeded actors` : ""}
      </button>
      {open && (
        actors === null ? (
          <p style={{ fontSize: 13, opacity: 0.55, marginTop: 10 }}>Loading the roster…</p>
        ) : (
          <div style={{ marginTop: 12, display: "grid", gap: 14 }}>
            {ROLE_GROUP.map((g) => {
              // : busiest-first — order each role group by contentScore (buildings/agents), then
              // verified, then name. Floats the richest actors up; thin ones (e.g. a 0-building dev signer) sink.
              const rows = actors
                .filter((a) => a.role === g.role)
                .sort((a, b) =>
                  (b.contentScore ?? 0) - (a.contentScore ?? 0) ||
                  Number(Boolean(b.verified)) - Number(Boolean(a.verified)) ||
                  (a.legalName || a.account).localeCompare(b.legalName || b.account)
                );
              if (rows.length === 0) return null;
              return (
                <div key={g.role}>
                  <p style={{ margin: "0 0 6px", fontSize: 11.5, color: T.faint, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {g.label} · {rows.length}
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {rows.map((a) => (
                      <button
                        key={a.account}
                        onClick={() => onEnter(a.account, g.demoRole, g.href)}
                        title={`${a.account}${a.region ? ` · ${a.region}` : ""}${a.verified ? " · ✓ vetted" : ""} — enter as this ${g.role}`}
                        style={{
                          display: "inline-flex", flexDirection: "row", alignItems: "center", gap: 9,
                          padding: "6px 11px", borderRadius: 9, cursor: "pointer", textAlign: "left",
                          border: `1px solid ${T.border}`, background: T.bg2, color: T.text,
                        }}
                      >
                        {/* a small SEALED avatar — the holographic ring + ✓ shows vetting visually here,
                            where you're looking at OTHER actors, not just your own card. Photo if on file, else
                            the brand mark; the ring renders only when the actor's identity seal verified. */}
                        <SealedRing size={26} sealed={Boolean(a.verified)} showBadge={false}>
                          <VrxLogoMark size={26} photoUrl={a.portraitUrl || undefined} alt={a.legalName || a.account} />
                        </SealedRing>
                        <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{a.legalName || a.account}</span>
                          <span style={{ fontSize: 10.5, fontFamily: T.mono, opacity: 0.6 }}>{a.account}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <p style={{ fontSize: 11.5, opacity: 0.6, margin: 0, lineHeight: 1.5 }}>
              Every actor is live on the seeded network. The four cards above are the guided tour; this is the
              whole cast — step into any one.
            </p>
          </div>
        )
      )}
    </div>
  );
}

// A3: distinct icon + accent per role so the cards read as separate surfaces, not a grey wall.
// Keyed by DemoCard.key; a neutral fallback keeps the data-driven roster (unknown keys) sane.
const CARD_ACCENT: Record<string, { icon: string; color: string }> = {
  developer: { icon: "🏢", color: "#4ea3ff" },      // blue — owns the inventory
  agency: { icon: "🏬", color: "#b57bff" },         // violet — sales org
  agent: { icon: "🧑‍💼", color: "#2fd4a7" },          // teal — on the ground
  buyer: { icon: "🔑", color: "#ffb84e" },          // amber — the end customer
  "direct-sale": { icon: "🤝", color: "#ff7ab0" },  // pink — the direct channel
};
const CARD_ACCENT_FALLBACK = { icon: "●", color: T.vetted };

function PickerCard({ c, onEnter }: { c: DemoCard; onEnter: (c: DemoCard) => void }) {
  const a = CARD_ACCENT[c.key] ?? CARD_ACCENT_FALLBACK;
  return (
    <button
      onClick={() => onEnter(c)}
      style={{
        textAlign: "left", cursor: "pointer", borderRadius: 10, padding: "14px 15px",
        border: `1px solid ${a.color}55`, background: `${a.color}0f`, color: T.text,
        display: "grid", gap: 6, borderLeft: `3px solid ${a.color}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 17 }} aria-hidden>{a.icon}</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: a.color }}>{c.title}</span>
        {c.tag && <span style={{ fontSize: 11.5, color: T.faint }}>· {c.tag}</span>}
      </div>
      <span style={{ fontSize: 13.5, opacity: 0.78, lineHeight: 1.45 }}>{c.blurb}</span>
      <span style={{ fontSize: 13, color: a.color, marginTop: 2 }}>Enter →</span>
    </button>
  );
}

// Per-role landing content — a well-designed face for each app (: "well-designed landing
// screens for each of the apps / portal faces with good DRY explanation"). Dry = clear, no fluff:
// what this app is, what you do, and how it works under the hood (the trust cue). VOCAB is the.
const ROLE_LANDING: Record<
  NonNullable<ReturnType<typeof useRole>["role"]>,
  { title: string; lead: string; does: string[]; how: string }
> = {
  owner: {
    title: "VRX Admin",
    lead: "You vet and onboard every participant on the platform.",
    does: [
      "Onboard developers and agencies (invitation-only — no self-signup)",
      "Review agency applications and approve them",
      "Oversee everyone you've onboarded and the wider network",
    ],
    how: "Only your account can admit a developer or agency to the platform. Everything on the network flows from who you vet.",
  },
  developer: {
    title: "Developer console",
    lead: "You own the units. Mark them available, grant agencies access, and confirm bookings.",
    does: [
      "Browse your buildings and units on a live stacking plan",
      "Mark a unit available (or sold) in one click",
      "Grant an agency access; accept, decline or counter booking requests",
    ],
    how: "Only you can confirm a booking on your own units. Prices, sizes and images stay private to you until you choose to share them.",
  },
  agency: {
    title: "Agency console",
    lead: "You place buyers through your agents. Manage your salespeople and their bookings.",
    does: [
      "Register and manage your agents (salespeople)",
      "Work the developers who have granted you access",
      "Track your agents' bookings and sales",
    ],
    how: "A developer grants your agency access; your agents then book against it. Your agency identity is reusable across many developers.",
  },
  agent: {
    title: "Agent app",
    lead: "You reserve units for buyers, on behalf of your agency.",
    does: [
      "Browse buildings and units with details and images",
      "Open a booking request on an available unit",
      "Negotiate terms and follow the request to confirmation",
    ],
    how: "Your booking and its terms stay private and confidential. The developer receives it, replies, and confirms.",
  },
  unregistered: {
    title: "Not onboarded yet",
    lead: "This account isn't on the platform yet.",
    does: [],
    how: "VRX is invitation-only — ask us to set you up as a developer, agency, or agent. Once we do, your workspace appears here automatically.",
  },
};

// ── Role home ───────────────────────────────────────────────────────────────────────────
function RoleHome({ role, accountId }: { role: NonNullable<ReturnType<typeof useRole>["role"]>; accountId: string }) {
  const meta = ROLE_META[role];
  const landing = ROLE_LANDING[role];
  const links = navFor(role);

  return (
    <>
      <section style={{ ...card, marginTop: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
          <span style={seal}>✓ {meta.label}</span>
          <code style={{ fontSize: 13, opacity: 0.55, fontFamily: T.mono }}>{accountId}</code>
        </div>
        <h2 style={{ fontSize: 22, margin: "6px 0 4px" }}>{landing.title}</h2>
        <p style={{ opacity: 0.8, fontSize: 15.5, marginTop: 0, lineHeight: 1.5 }}>{landing.lead}</p>

        {landing.does.length > 0 && (
          <ul style={{ margin: "14px 0 4px", padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {landing.does.map((d) => (
              <li key={d} style={{ display: "flex", gap: 9, fontSize: 14.5, opacity: 0.9 }}>
                <span style={{ color: T.vetted, flexShrink: 0 }}>›</span>
                {d}
              </li>
            ))}
          </ul>
        )}

        <p style={{ fontSize: 13, opacity: 0.55, lineHeight: 1.5, marginTop: 14, borderLeft: `2px solid ${T.borderSoft}`, paddingLeft: 10 }}>
          {landing.how}
        </p>

        {role !== "unregistered" && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
            {links.map((l, i) => (
              <Link key={l.href} href={l.href} style={{ textDecoration: "none" }}>
                <span style={(i === 0 ? submitBtn : secondaryBtn) as React.CSSProperties}>
                  {l.label} →
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Protocol internals are only meaningful to us/VRX — a developer/agency/agent doesn't need them. */}
      {role === "owner" && <ProtocolStats />}
    </>
  );
}

const secondaryBtn: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  borderRadius: 8,
  border: `1px solid ${T.border}`,
  background: T.bg2,
  color: T.text,
  fontSize: 15,
  cursor: "pointer",
};

// ── Live protocol stats (owner only) ──────────────────────────────────────────────────────
type Live = { owner: string; tollYocto: string; treasury: string; holdWindowNs: string };

function ProtocolStats() {
  const [live, setLive] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getOwner(), getToll(), getTreasury(), getHoldWindow()])
      .then(([owner, tollYocto, treasury, holdWindowNs]) =>
        setLive({ owner, tollYocto, treasury, holdWindowNs })
      )
      .catch((e) => setErr(String(e?.message || e)));
  }, []);

  const holdHours = live
    ? (Number(BigInt(live.holdWindowNs) / 1_000_000_000n) / 3600).toFixed(2)
    : "";

  return (
    <section style={{ ...card, marginTop: 14 }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Platform status</h2>
      <Row label="Network" value={NETWORK} />
      <Row
        label="Contract"
        value={
          <a
            href={`${EXPLORER_URL}/accounts/${CONTRACT_ID}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#7aa2ff" }}
          >
            {CONTRACT_ID}
          </a>
        }
      />
      {err && <p style={{ color: "#ff8080", marginTop: 16 }}>Could not reach the platform: {err}</p>}
      {!live && !err && <p style={{ opacity: 0.6 }}>Loading platform status…</p>}
      {live && (
        <>
          <Row label="Administrator" value={live.owner} />
          <Row label="Network fee" value={`${yoctoToNear(live.tollYocto)} NEAR`} />
          <Row label="Fee account" value={live.treasury} />
          <Row label="Booking hold window" value={`${holdHours} h`} />
        </>
      )}
    </section>
  );
}

// 1 NEAR = 1e24 yocto.
function yoctoToNear(y: string): string {
  try {
    const n = BigInt(y);
    const whole = n / 10n ** 24n;
    const frac = (n % 10n ** 24n).toString().padStart(24, "0").slice(0, 6);
    return `${whole}.${frac}`.replace(/\.?0+$/, "") || "0";
  } catch {
    return y;
  }
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "8px 0",
        borderBottom: "1px solid #1c2130",
        fontSize: 15,
      }}
    >
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", textAlign: "right" }}>{value}</span>
    </div>
  );
}
