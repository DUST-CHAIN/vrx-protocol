"use client";

// DashboardShell — the role-portal dashboard chrome: a slim TOPBAR + a persistent LEFT SIDEBAR +
// a scrollable CONTENT REGION. Replaces the "very-tall single scrolling column" each role page used to be.
//
// WHY: /node, /agency, /root were each a thin assembler that stacked several INDEPENDENT section
// components in one <main> column (e.g. /root = RelationBrowser + AttentionPanel + GraphPanel +
// AgreementsPanel). Because those sections are already self-contained (each owns its own state + fetch +
// SSE), we can turn the stack into a VIEW-SWITCHER cheaply: the sidebar picks a section and the content
// region shows ONLY that one — genuinely hidden, not a long scroll. The section internals are untouched.
//
// DECISIONS: sidebar+topbar+content; view-switch one-at-a-time; fold the old <Nav> into this
// topbar (one bar); NO role switcher (login resolves role via lib/role). Responsive: on a narrow viewport
// the sidebar collapses to a horizontal chip row above the content and the content goes full-width, so the
// dashboard degrades to a usable mobile stack (agency is mostly mobile — must not regress).
//
// keepAlive: unmounting a section drops its in-memory state. For inbox-type sections (open message thread /
// unsent draft — the "don't wipe the draft" guarantee) pass keepAlive so the section stays MOUNTED
// but CSS-hidden when another view is active, instead of being torn down.

import { createContext, Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import ConnectButton from "@/components/ConnectButton";
import SettingsMenu from "@/components/SettingsMenu";
import BookingSearch from "@/components/BookingSearch";
import TopbarMenu from "@/components/TopbarMenu";
import VrxLogoMark from "@/components/VrxLogoMark";
import AccountIdCard from "@/components/AccountIdCard";
import NodeLicensesNudge from "@/components/NodeLicensesNudge";
import VrxBalanceChip from "@/components/VrxBalanceChip";
import { useWallet } from "@/lib/wallet";
import { useRole, navFor, ROLE_META, setDemoRole, type DemoRoleChoice } from "@/lib/role";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";
import { useIsMobile } from "@/lib/use-is-mobile";
import { T } from "@/lib/theme";

// Deep-link focus: the ?focus= id the active section should scroll to / open. A section reads it via
// useShellFocus and clears it after acting so a later manual navigation isn't re-hijacked. Null when none.
const FocusContext = createContext<{ focus: string | null; clearFocus: () => void }>({
  focus: null,
  clearFocus: () => {},
});

/** Sections call this to learn which item a deep-link wants focused. */
export function useShellFocus(sectionId: string): { focus: string | null; clearFocus: () => void } {
  const ctx = useContext(FocusContext);
  // The focus id is subject-scoped, not section-scoped, so every section reads the same value; a section
  // simply ignores a focus id it can't find in its own list. `sectionId` is accepted for future per-section
  // routing + call-site clarity.
  void sectionId;
  return ctx;
}

export type ShellSection = {
  /** Stable id (used as the view key + sessionStorage persistence key). */
  id: string;
  /** Sidebar label. */
  label: string;
  /** Optional leading glyph/emoji for the sidebar item. */
  icon?: ReactNode;
  /** The section's content (its existing self-contained component). */
  element: ReactNode;
  /** Keep mounted (CSS-hidden) when inactive instead of unmounting — for stateful panels (inbox drafts). */
  keepAlive?: boolean;
  /** Optional right-aligned badge count on the sidebar item (e.g. unread). */
  badge?: number;
  /** Optional control shown right-aligned above the section ONLY while this section is active (e.g. Refresh). */
  headerAccessory?: ReactNode;
};

type Props = {
  /** The page H1 shown in the content header. */
  title: string;
  /** The switchable sections. First is the default view. Empty → shell shows only `banner`/`children`. */
  sections?: ShellSection[];
  /** Optional short blurb shown INLINE on the title's baseline (to the right of the H1). */
  intro?: ReactNode;
  /** Optional pre-content block (role gate / sign-in prompt) — always visible, above sections. */
  banner?: ReactNode;
  /** Optional ALWAYS-VISIBLE block below the banner, above every section — for cross-cutting notices that
 * must show regardless of the active view (e.g. the A2 halt notice). Unlike `children` (which only
   *  shows when no section is active), this renders on every view. */
  topSlot?: ReactNode;
  /** Optional content header accessory, right-aligned next to the section title (e.g. a Refresh button). */
  headerAccessory?: ReactNode;
  /** Optional block rendered BELOW the active section (e.g. counts strip / operator-secret gate). */
  footer?: ReactNode;
  /** Optional note shown in the TOPBAR (e.g. "connected as …, not the owner" read-only notice). */
  topbarNote?: ReactNode;
  /** Fallback content when there are no sections (e.g. loading / gated-out). */
  children?: ReactNode;
  /** sessionStorage key suffix so each role remembers its last view independently. */
  persistKey?: string;
};

// Reads the deep-link query params and reports them up. Isolated + rendered inside <Suspense> so the
// useSearchParams CSR-bailout stays behind a suspense boundary (required for `next build`). Renders nothing.
function SearchParamSync({
  onChange,
}: {
  onChange: (p: { section: string | null; focus: string | null }) => void;
}) {
  const sp = useSearchParams();
  const section = sp.get("section");
  const focus = sp.get("focus");
  useEffect(() => {
    onChange({ section, focus });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, focus]);
  return null;
}

export default function DashboardShell({
  title,
  sections = [],
  intro,
  banner,
  topSlot,
  headerAccessory,
  footer,
  topbarNote,
  children,
  persistKey,
}: Props) {
  const { role } = useRole();
  const routeLinks = navFor(role);
  const pathname = usePathname();
  // : on mobile, fold the whole topbar control set into one ☰ menu. Desktop renders the inline
  // row exactly as before — each control mounts once (no duplicate state) by branching on this.
  const isMobile = useIsMobile();
  // Mobile bar shows the username as tidy PLAIN TEXT (no pill chip —: the pill wastes space). The
  // full connect/sign-out control lives in the ☰ menu. accountId is the display handle.
  const { accountId } = useWallet();

  const storageKey = persistKey ? `vrx.shell.view.${persistKey}` : null;
  const [activeId, setActiveId] = useState<string | null>(sections[0]?.id ?? null);

  // Deep-link support: ?section=<id> switches the view; ?focus=<id> is read by the active section to
  // scroll/open a specific item. A URL section wins over the saved view, so a deep-link from the event log
  // ("Review →") lands directly on the right surface + item.
  //
  // useSearchParams is read inside a <Suspense>-wrapped child (SearchParamSync, rendered below) rather
  // than here, because calling it in this client component made `next build` fail static prerender with the
  // CSR-bailout error ("useSearchParams should be wrapped in a suspense boundary"). The child reports the
  // two params up into local state; `null` until it mounts, which is the same as "no deep-link". (.)
  const [urlSection, setUrlSection] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  // Restore last view on mount (per-role), if still valid — UNLESS the URL names a section (deep-link wins).
  useEffect(() => {
    if (!storageKey || sections.length === 0) return;
    if (urlSection && sections.some((s) => s.id === urlSection)) return; // deep-link handled below
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved && sections.some((s) => s.id === saved)) setActiveId(saved);
    } catch {
      /* private mode — best-effort */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, sections.length]);

  // Honour ?section= whenever it changes (a deep-link click updates the URL in place).
  useEffect(() => {
    if (urlSection && sections.some((s) => s.id === urlSection)) setActiveId(urlSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSection, sections.length]);

  // Track the live ?focus= so a section can consume it then clear it (prevents re-focusing on later nav).
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => setFocus(focusId), [focusId]);
  const focusCtx = useMemo(() => ({ focus, clearFocus: () => setFocus(null) }), [focus]);

  // If sections change and the active id is gone, fall back to the first.
  useEffect(() => {
    if (sections.length > 0 && !sections.some((s) => s.id === activeId)) {
      setActiveId(sections[0].id);
    }
  }, [sections, activeId]);

  const select = (id: string) => {
    setActiveId(id);
    if (storageKey) {
      try {
        sessionStorage.setItem(storageKey, id);
      } catch {
        /* best-effort */
      }
    }
  };

  const active = useMemo(() => sections.find((s) => s.id === activeId) ?? null, [sections, activeId]);

  return (
    <div style={shellRoot}>
      {/* Deep-link query reader — isolated behind a suspense boundary (see SearchParamSync). */}
      <Suspense fallback={null}>
        <SearchParamSync
          onChange={({ section, focus }) => {
            setUrlSection(section);
            setFocusId(focus);
          }}
        />
      </Suspense>
      {/* ── TOPBAR (folds in the old Nav: brand + role chip + account + settings) ────────────── */}
      <header style={topbar} className="vrx-shell-topbar">
        <Link href="/" style={brand} title="Constitutional freedom to globally transact — a preview of Vetted Realty">
          {/* Rounded VRX logo mark + wordmark (: replace the ◆ with the real logo in a circle).
              FUTURE: becomes the user's photo + a clickable sealed ID card when logged in (photo arc). */}
          <VrxLogoMark size={32} />
          <span className="vrx-brand-word"> VRX</span>
        </Link>
        {role && role !== "unregistered" && (
          <span style={roleChip} className="vrx-role-chip" title="Your role on VRX">
            {ROLE_META[role].label}
          </span>
        )}
        {/* DESKTOP: role switch sits in the left group (unchanged). MOBILE: it moves into the ☰ menu below. */}
        {!isMobile && <DemoRoleSwitch />}
        {topbarNote && <div style={topbarNoteStyle} className="vrx-shell-topnote">{topbarNote}</div>}
        <div style={{ flex: 1 }} className="vrx-shell-topspacer" />
        {isMobile ? (
          // MOBILE: a SLIM fixed bar — small search + tidy plain-text username + a ☰ menu that
          // holds all the heavier controls (role switch, connect/sign-out, settings). The username is plain
          // text (no space-eating pill); the full connect/sign-out action lives in the menu.
          <>
            <BookingSearch />
            {accountId && (
              <span style={acctPlain} title={accountId}>
                {accountId}
              </span>
            )}
            {/* ☰ pinned hard to the right edge: marginLeft:auto so the search + account sit left
                and the menu button always hugs the right, independent of their widths. */}
            <TopbarMenu style={{ marginLeft: "auto" }}>
              {accountId && role && role !== "unregistered" && (
                <div style={{ display: "flex", justifyContent: "flex-start" }}><VrxBalanceChip me={accountId} walletHref="/wallet" /></div>
              )}
              <DemoRoleSwitch />
              <ConnectButton />
              {/* Photo avatar → sealed ID card (photo subsystem). */}
              {accountId && role && role !== "unregistered" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <AccountIdCard account={accountId} />
                  <span style={{ fontSize: 13, opacity: 0.75 }}>ID card</span>
                </div>
              )}
              <SettingsMenu />
              {/* Node-license funnel, surface #2: reachable from the ☰ on every role (compact). */}
              <NodeLicensesNudge compact />
            </TopbarMenu>
          </>
        ) : (
          // DESKTOP: the inline right-hand control group, unchanged from before.
          <>
            {/* Jump-to-booking search — only renders for roles with a booking inbox. */}
            <BookingSearch />
            {/* $VRX balance in-context (wallet #3) — always visible for a registered user, not just in-panel. */}
            {accountId && role && role !== "unregistered" && <VrxBalanceChip me={accountId} walletHref="/wallet" />}
            {/* Photo avatar → sealed ID card (photo subsystem). */}
            {accountId && role && role !== "unregistered" && <AccountIdCard account={accountId} />}
            <ConnectButton />
            <SettingsMenu />
          </>
        )}
      </header>

      {/* ── BODY: sidebar + content ─────────────────────────────────────────────────────────── */}
      <div style={body} className="vrx-shell-body">
        <aside style={sidebar} className="vrx-shell-sidebar">
          {/* Cross-route links (navFor) — e.g. owner: Relationships / Onboarding / … . A SINGLE route link
 is just a redundant "you are here" label above the section menu (: looked strange on
              the developer app, which has one route), so we only show this group when there are ≥2 routes to
              move between. The sections menu below is the real navigation for a single-route role. */}
          {routeLinks.length > 1 && (
            <nav style={navGroup}>
              {routeLinks.map((l) => {
                const here = pathname === l.href;
                return (
                  <Link key={l.href} href={l.href} style={{ ...routeLink, ...(here ? routeLinkActive : null) }}>
                    {l.label}
                  </Link>
                );
              })}
            </nav>
          )}

          {sections.length > 0 && (
            <>
              {routeLinks.length > 1 && <div style={divider} />}
              <nav style={navGroup}>
                {sections.map((s) => {
                  const on = s.id === activeId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => select(s.id)}
                      style={{ ...sectionLink, ...(on ? sectionLinkActive : null) }}
                      aria-current={on ? "page" : undefined}
                    >
                      {s.icon != null && <span style={{ width: 18, textAlign: "center" }}>{s.icon}</span>}
                      <span style={{ flex: 1, textAlign: "left" }}>{s.label}</span>
                      {typeof s.badge === "number" && s.badge > 0 && <span style={badgeStyle}>{s.badge}</span>}
                    </button>
                  );
                })}
              </nav>
            </>
          )}
        </aside>

        <main style={content} className="vrx-shell-content">
          {/* Inner wrap: FHD-tuned + self-fitting. The content area can be ~1700px on a 1920 screen next
              to the sidebar; an uncapped list/row layout stretches uncomfortably wide. Cap the readable
              column at a comfortable dashboard measure and CENTER it, so it reads well on FHD and fluidly
              fills narrower laptops. (A full-bleed view like the radial graph can opt out via its own
              width.) */}
          <div style={contentInner} className="vrx-shell-inner">
          {/* Page H1 + intro are DROPPED on every dashboard screen: the sidebar's active item is
              the "you are here", and the account shows top-right — the big title + grey intro line just ate
              vertical space. `title`/`intro` stay in the props (used for the browser tab + as a hint) but
              aren't painted here. The sign-in / not-onboarded BANNER still renders (it's load-bearing), and
              a section's optional headerAccessory (e.g. a Refresh button) gets a thin right-aligned row. */}
          {(active?.headerAccessory || headerAccessory) && (
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginBottom: 8 }}>
              {active?.headerAccessory}
              {headerAccessory}
            </div>
          )}
          {banner}
          {topSlot && <div style={{ marginTop: banner ? 12 : 0 }}>{topSlot}</div>}

          {sections.length > 0 ? (
            <FocusContext.Provider value={focusCtx}>
            <div style={{ marginTop: banner ? 12 : 0 }}>
              {sections.map((s) => {
                const on = s.id === activeId;
                // keepAlive sections stay mounted but hidden; others mount only when active.
                if (s.keepAlive) {
                  return (
                    <div key={s.id} style={{ display: on ? "block" : "none" }}>
                      {s.element}
                    </div>
                  );
                }
                return on ? <div key={s.id}>{s.element}</div> : null;
              })}
              {active == null && children}
            </div>
            </FocusContext.Provider>
          ) : (
            <div style={{ marginTop: 16 }}>{children}</div>
          )}

          {footer && <div style={{ marginTop: 20 }}>{footer}</div>}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────────────────────
// Shell-local brighter values (: stronger/brighter borders, brighter small text, and more
// contrast between the MENU and the CONTENT area). We brighten here rather than touching the global
// theme tokens so the rest of the app's calm surfaces don't shift. The grouping reads as:
//   topbar + sidebar = raised, LIGHTER surface (SHELL_SURFACE)  ←→  content frame = DARKER sunken well.
const SHELL_BORDER = "#394867"; // brighter than T.border (#232d40) — edges that actually show
const SHELL_SURFACE = "#1a2234"; // the menu/topbar surface — clearly lighter than the content well
const SHELL_TEXT = "#c3ccde"; // small nav/label text — brighter than T.dim (#9aa6be)

// Locked to the viewport: the whole dashboard is exactly one screen tall, so wheel-zoom
// the graph never grows the page / triggers a vertical page scroll. The CONTENT region scrolls internally
// instead (overflow-y: auto). On mobile the body stacks (sidebar → content) and still fits via the same
// internal scroll. Uses 100dvh so mobile browser chrome doesn't clip it.
const shellRoot: React.CSSProperties = {
  height: "100dvh",
  maxHeight: "100dvh",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  background: T.bg,
  color: T.text,
};

const topbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 16px",
  borderBottom: `1px solid ${SHELL_BORDER}`,
  position: "sticky",
  top: 0,
  zIndex: 40,
  background: SHELL_SURFACE, // raised, lighter surface so the bar reads as its own region
};

const brand: React.CSSProperties = {
  color: T.text,
  textDecoration: "none",
  fontWeight: 700,
  letterSpacing: 0.3,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const roleChip: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 8px",
  borderRadius: 999,
  background: T.panel2,
  border: `1px solid ${SHELL_BORDER}`,
  color: "#9ab0ff",
};

// Mobile username as tidy PLAIN TEXT — monospace handle, truncates, NO pill/border (the pill
// chip ate horizontal space on the slim bar). The connect/sign-out action lives in the ☰ menu.
const acctPlain: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12.5,
  color: SHELL_TEXT,
  minWidth: 0,
  maxWidth: "34vw",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// ── DEMO role switcher ───────────────────────────────────────────────────────────────
// A compact top-bar dropdown that jumps between demo roles WITHOUT returning to the landing picker.
// Shown ONLY when the demo UX is armed (public-demo flag or localnet god-mode) — invisible on a real
// wallet deploy. Account map + the buyer-is-a-state (role=null) rule mirror the landing DemoPicker.
const DEMO_SWITCH: { key: string; label: string; account: string; role: DemoRoleChoice | null; href: string }[] = [
  { key: "developer", label: "Developer", account: "node.test.near", role: "developer", href: "/node" },
  { key: "agency", label: "Agency", account: "org.test.near", role: "agency", href: "/agency" },
  { key: "agent", label: "Agent", account: "agent.test.near", role: "agent", href: "/agent" },
  { key: "buyer", label: "Buyer (walk-in)", account: "buyer.test.near", role: null, href: "/buyer" },
];

function DemoRoleSwitch() {
  const { becomeAccount } = useWallet();
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(demoRoleUxArmed()), []);
  if (!armed) return null;

  const onChange = (key: string) => {
    const c = DEMO_SWITCH.find((x) => x.key === key);
    if (!c) return;
    becomeAccount(c.account);
    setDemoRole(c.role);
    router.push(c.href);
  };

  return (
    <select
      onChange={(e) => onChange(e.target.value)}
      defaultValue=""
      title="Switch demo role"
      className="vrx-role-switch"
    >
      <option value="" disabled>Switch role…</option>
      {DEMO_SWITCH.map((c) => (
        <option key={c.key} value={c.key}>{c.label}</option>
      ))}
    </select>
  );
}

const body: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  alignItems: "stretch",
};

const sidebar: React.CSSProperties = {
  width: 216,
  flexShrink: 0,
  borderRight: `1px solid ${SHELL_BORDER}`,
  padding: "16px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: SHELL_SURFACE, // same raised, lighter surface as the topbar → menu reads as one group
};

const navGroup: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

const divider: React.CSSProperties = { height: 1, background: SHELL_BORDER, margin: "6px 4px" };

const routeLink: React.CSSProperties = {
  display: "block",
  padding: "7px 10px",
  borderRadius: 8,
  color: SHELL_TEXT,
  textDecoration: "none",
  fontSize: 13.5,
  fontWeight: 500,
};
const routeLinkActive: React.CSSProperties = { background: T.panel2, color: T.text };

const sectionLink: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: SHELL_TEXT,
  fontSize: 14,
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
};
const sectionLinkActive: React.CSSProperties = {
  background: T.panel2,
  border: `1px solid ${T.accent}`,
  color: T.text,
  fontWeight: 600,
};

const badgeStyle: React.CSSProperties = {
  fontSize: 11,
  minWidth: 18,
  textAlign: "center",
  padding: "1px 6px",
  borderRadius: 999,
  background: T.accentSoft,
  color: "#9ab0ff",
  border: `1px solid ${T.border}`,
};

const content: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  padding: 5, // tight gap around the content card (the old clamp(…28px) wasted a big black margin)
  overflowX: "hidden",
  overflowY: "auto", // the dashboard is locked to 100dvh; the CONTENT scrolls here, not the page
};

// Full-width content beside the sidebar (: on a wide screen the old 1440px cap left a big empty
// gutter on the right — use that space). NO frame/border here — the section panels render their own `card`
// surfaces, so wrapping them in another border made a box-in-a-box (the "container in a container").
// The menu-vs-content contrast comes from the lighter sidebar/topbar surface vs the darker page well.
const contentInner: React.CSSProperties = {
  width: "100%",
};

// (The page H1 + intro header block was removed — the sidebar's active item + the top-bar account
// are the "you are here", so the big title/intro just wasted vertical space. `title`/`intro` props remain
// for the browser tab + as hints; they're no longer painted, so their styles were dropped.)

// Topbar read-only / role notice — compact, amber-tinted so it's noticed without shouting.
const topbarNoteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#e8b84b",
  background: "rgba(232,184,75,0.08)",
  border: "1px solid rgba(232,184,75,0.28)",
  borderRadius: 8,
  padding: "4px 10px",
  maxWidth: "46vw",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
