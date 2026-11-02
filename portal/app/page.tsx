"use client";

// Role dispatcher / home. Instead of a dev-skeleton "reads the live contract" note, the
// landing now greets the connected account BY ITS ROLE and points it at its own surface:
// signed out → what VRX is + Connect
// us / VRX (owner) → admin home (provisioning links) + live protocol stats
// developer/agency/… → a role home card linking to their app
// unregistered → "you're not provisioned yet"

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CONTRACT_ID, NETWORK, EXPLORER_URL } from "@/lib/config";
import { getOwner, getToll, getTreasury, getHoldWindow } from "@/lib/vrx";
import { useWallet } from "@/lib/wallet";
import { useRole, ROLE_META, navFor, setDemoRole, DEMO_ROLES, type DemoRoleChoice } from "@/lib/role";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";
import { card, submitBtn } from "@/lib/ui";
import { T, seal } from "@/lib/theme";
import { MarksLegend } from "@/lib/marks";

export default function Home() {
  const { accountId, ready, signIn } = useWallet();
  const { role, loading } = useRole();
  // Public-demo sandbox: show the wallet-less role-picker instead of the Connect prompt. Armed only by the
  // explicit flag (or localnet god-mode) — a real wallet deploy leaves it off and the normal flow shows.
  const [demoArmed, setDemoArmed] = useState(false);
  useEffect(() => setDemoArmed(demoRoleUxArmed()), []);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px" }}>
      <span style={seal}>✓ Vetted</span>
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
          ? <RealOrDemo signIn={signIn} />   /* both modes + a toggle (default: Demo) */
          : <SignedOut signIn={signIn} />    /* flag off (real wallet deploy) → wallet only */
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
function SignedOut({ signIn }: { signIn: () => void }) {
  return (
    <section style={{ ...card, marginTop: 14 }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Sign in</h2>
      <p style={{ opacity: 0.75, fontSize: 15 }}>
        Connect the wallet we issued to you. You&apos;ll be taken straight to your workspace —
        admin, developer, agency, or agent.
      </p>
      <button onClick={signIn} style={submitBtn}>
        Connect wallet
      </button>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 18 }}>
        Your prices, personal details and deal terms are always kept private and confidential.
      </p>
    </section>
  );
}

// ── REAL / DEMO toggle ───────────────────────────────────────────────────────────────
// cold visitor (judge) lands in the wallet-less explorable version, with the real wallet one click away.
// Only rendered when the demo UX is armed (NEXT_PUBLIC_VRX_DEMO baked in); a real-wallet deploy skips this
// wrapper entirely (SignedOut only). Switching is pure client state — no reload, no chain.
function RealOrDemo({ signIn }: { signIn: () => void }) {
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
      {mode === "demo" ? <DemoPicker /> : <SignedOut signIn={signIn} />}
    </div>
  );
}

function toggleTab(active: boolean): React.CSSProperties {
  return {
    padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13.5,
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
// — pointing the picker at them showed "No buildings to show"). vvv-dev-01 owns miracle-tower/pearls-view/
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

function DemoPicker() {
  const { becomeAccount } = useWallet();
  const router = useRouter();

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
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {DEMO_PARTIES.map((c) => (
          <PickerCard key={c.key} c={c} onEnter={enter} />
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

// ── Full seeded-actor roster — collapsible, grouped by role, each entry steps into that exact actor ──
type RosterActor = { account: string; role: "developer" | "agency" | "agent"; legalName?: string; region?: string };
const ROLE_GROUP: { role: RosterActor["role"]; label: string; demoRole: DemoRoleChoice; href: string }[] = [
  { role: "developer", label: "Developers", demoRole: "developer", href: "/node" },
  { role: "agency", label: "Agencies", demoRole: "agency", href: "/agency" },
  { role: "agent", label: "Agents", demoRole: "agent", href: "/agent" },
];

function AllActorsRoster({ onEnter }: { onEnter: (account: string, role: DemoRoleChoice, href: string) => void }) {
  const [open, setOpen] = useState(false);
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
              const rows = actors.filter((a) => a.role === g.role);
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
                        title={`${a.account}${a.region ? ` · ${a.region}` : ""} — enter as this ${g.role}`}
                        style={{
                          display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
                          padding: "6px 11px", borderRadius: 9, cursor: "pointer", textAlign: "left",
                          border: `1px solid ${T.border}`, background: T.bg2, color: T.text,
                        }}
                      >
                        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{a.legalName || a.account}</span>
                        <span style={{ fontSize: 10.5, fontFamily: T.mono, opacity: 0.6 }}>{a.account}</span>
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

function PickerCard({ c, onEnter }: { c: DemoCard; onEnter: (c: DemoCard) => void }) {
  return (
    <button
      onClick={() => onEnter(c)}
      style={{
        textAlign: "left", cursor: "pointer", borderRadius: 10, padding: "14px 15px",
        border: `1px solid ${T.border}`, background: T.bg2, color: T.text, display: "grid", gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{c.title}</span>
        {c.tag && <span style={{ fontSize: 11.5, color: T.faint }}>· {c.tag}</span>}
      </div>
      <span style={{ fontSize: 13.5, opacity: 0.78, lineHeight: 1.45 }}>{c.blurb}</span>
      <span style={{ fontSize: 13, color: T.vetted, marginTop: 2 }}>Enter →</span>
    </button>
  );
}

// screens for each of the apps / portal faces with good DRY explanation"). Dry = clear, no fluff:
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
