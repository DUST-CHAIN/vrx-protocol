"use client";

// Central role detection for the portal — turns "a pile of screens everyone can see" into
// "each login sees THEIR app". In the real product one account = one actor (: one Chrome
// profile per role — root / developer / agency / agent), so a wallet resolves to exactly ONE role.
//
// Role is read straight off the contract from the connected account — no new contract state, no
// server, pure views ("scaffold around the primitive; contract UNCHANGED"):
//  get_owner → is this account us/VRX (the operator who vets & provisions)?
//   get_node(me)     → a Developer (Node)?
//   get_org(me)      → an Agency (Org)?
//   get_peer(me)     → an Agent (Peer)?
//
// VOCAB (vrx-vocab-translation memory): the UI speaks the words — owner=us/VRX, Node=Developer,
// Org=Agency, Peer=Agent. The contract keeps its own words under the hood.
//
// PRECEDENCE — owner → developer → agency → agent. Its ONLY job is the demo edge where the owner
// account (calculating-hand) is ALSO registered as a node: checking owner first means root always
// lands on the admin home, never the developer view (fixes the "owner shows as developer" bug).
// In production the roles are disjoint, so precedence never actually fires.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useWallet } from "./wallet";
import { getOwner, getNode, getOrg, getPeer } from "./vrx";
import { demoRoleUxArmed } from "./dev-signer-fence";

export type Role = "owner" | "developer" | "agency" | "agent" | "unregistered";

// DEMO role override — the landing picker sets this so a snapshot demo (no chain) can "assume a role"
// without the on-chain getNode/getOrg/getPeer fan-out (which would resolve "unregistered" with no localnet).
// Read ONLY when demoRoleUxArmed (public-demo flag OR localnet god-mode) — never affects a real wallet
// session. The value is one of the Role strings; an unknown/missing value falls through to normal detection.
const DEV_ROLE_KEY = "vrx.devRole";

/** The roles the demo picker can assume directly (the contract roles; the buyer is a STATE, not here). */
export const DEMO_ROLES = ["owner", "developer", "agency", "agent"] as const;
export type DemoRoleChoice = (typeof DEMO_ROLES)[number];

function readDemoRole(): Role | null {
  if (typeof window === "undefined" || !demoRoleUxArmed()) return null;
  try {
    const v = window.localStorage.getItem(DEV_ROLE_KEY);
    return v && (DEMO_ROLES as readonly string[]).includes(v) ? (v as Role) : null;
  } catch {
    return null;
  }
}

/** Set (or clear, with null) the demo role override the picker + topbar switcher use. No-op unless the
 *  demo UX is armed, so it can never affect a real wallet session. Clearing it falls back to normal
 *  (on-chain / state-based) resolution — which is what the BUYER needs (buyer is a state, not a role). */
export function setDemoRole(role: DemoRoleChoice | null): void {
  if (typeof window === "undefined" || !demoRoleUxArmed()) return;
  try {
    if (role) window.localStorage.setItem(DEV_ROLE_KEY, role);
    else window.localStorage.removeItem(DEV_ROLE_KEY);
  } catch {
    /* private mode / quota — best-effort */
  }
}

type RoleCtx = {
  /** Resolved role of the connected account, or null while resolving / signed out. */
  role: Role | null;
  /** Still reading the contract? */
  loading: boolean;
  /** The connected account id (mirrors useWallet, convenience). */
  accountId: string | null;
};

const Ctx = createContext<RoleCtx>({ role: null, loading: false, accountId: null });

// A registered record is "active" unless its serde-pinned `a` flag is explicitly false.
function active(rec: unknown): boolean {
  return !!rec && (rec as { a?: boolean }).a !== false;
}

// One account = one role, and a role changes ~never within a session. So we CACHE the resolved role
// in sessionStorage (per account) and use stale-while-revalidate: on a page revisit we hydrate the
// role INSTANTLY from cache (no chain read, no blocking spinner) and quietly re-verify in the
// background. This is the fix for the "revisit hangs on 'Signed in as…'" bug — after a big status
// burst throttles the RPC, re-reading get_owner/node/org/peer on every navigation would stall the
// whole UI; with the cache the known role paints immediately and a throttled re-check just no-ops.
const roleKey = (id: string) => `vrx.role.${id}`;

function readCachedRole(id: string): Role | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(roleKey(id));
    return v && ["owner", "developer", "agency", "agent", "unregistered"].includes(v) ? (v as Role) : null;
  } catch {
    return null;
  }
}

function writeCachedRole(id: string, role: Role): void {
  try {
    window.sessionStorage.setItem(roleKey(id), role);
  } catch {
    /* private mode / quota — cache is best-effort */
  }
}

export function RoleProvider({ children }: { children: ReactNode }) {
  const { accountId, ready } = useWallet();
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Signed out (or selector not ready) → no role, nothing to read.
    if (!ready || !accountId) {
      setRole(null);
      setLoading(false);
      return;
    }
    let cancelled = false;

    // DEMO override: in a sandbox demo the picker has already told us the role — use it directly and
    // SKIP the on-chain fan-out (which has no chain to read on a snapshot demo). Fenced by demoRoleUxArmed.
    const demoRole = readDemoRole();
    if (demoRole) {
      setRole(demoRole);
      setLoading(false);
      return;
    }

    // Hydrate instantly from cache if we already know this account's role — the page never blocks.
    const cached = readCachedRole(accountId);
    if (cached) {
      setRole(cached);
      setLoading(false); // we have an answer; revalidation below is silent
    } else {
      setLoading(true);
    }

    (async () => {
      try {
        // One parallel read fan-out. owner is a plain string compare; the other three are
        // Option<record> — present + active means the account holds that role. Each read is
        // timeout-bounded (lib/vrx.ts view), so a throttled RPC fails fast instead of hanging.
        //
        // F13 FIX: the owner read must distinguish "read SUCCEEDED, I'm not the owner" from "read
        // THREW" — collapsing both to "" silently DEMOTED the real owner to "unregistered" whenever ONLY
        // get_owner hiccuped (the node/org/peer reads legitimately return null for the owner, so the old
        // `allFailed` guard never fired). Sentinel `null` = the read threw; "" is NOT reachable from a
        // successful read (get_owner always returns a non-empty account id).
        const [owner, node, org, peer] = await Promise.all([
          getOwner().catch(() => null), // null = read FAILED (distinct from a returned account id)
          getNode(accountId).catch(() => null),
          getOrg(accountId).catch(() => null),
          getPeer(accountId).catch(() => null),
        ]);
        if (cancelled) return;
        const ownerReadFailed = owner === null;
        // If every read failed (RPC down) and we already have a cached role, KEEP it rather than
        // downgrading a real actor to "unregistered" on a transient outage.
        const allFailed = ownerReadFailed && node === null && org === null && peer === null;
        if (allFailed && cached) return;
        // F13: the owner read FAILED but others returned (so NOT allFailed) and none of node/org/peer is this
        // account. We CANNOT conclude "not the owner" from a failed read — that was the demotion bug. If the
        // cache already knows this account is the owner, keep it (sticky). Otherwise show "unregistered"
        // tentatively but DO NOT cache it, so a refresh/revalidation re-resolves cleanly once the owner read
        // succeeds (vs. the old code which cached the wrong "unregistered" answer).
        if (ownerReadFailed && !active(node) && !active(org) && !active(peer)) {
          if (cached === "owner") return; // don't drop a known owner on a transient owner-read fail
          setRole("unregistered"); // tentative; NOT cached, so it self-heals on the next successful read
          return;
        }
        let resolved: Role = "unregistered";
        if (owner && accountId === owner) resolved = "owner";
        else if (active(node)) resolved = "developer";
        else if (active(org)) resolved = "agency";
        else if (active(peer)) resolved = "agent";
        setRole(resolved);
        writeCachedRole(accountId, resolved);
      } catch {
        if (!cancelled && !cached) setRole("unregistered");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, ready]);

  return <Ctx.Provider value={{ role, loading, accountId }}>{children}</Ctx.Provider>;
}

export function useRole(): RoleCtx {
  return useContext(Ctx);
}

// ── Presentation helpers (one place so nav + landing agree) ────────────────────────────────

/** the word for each role + a one-line "what this login does". */
export const ROLE_META: Record<
  Exclude<Role, null>,
  { label: string; blurb: string; home: string; homeLabel: string }
> = {
  owner: {
    label: "VRX Admin",
    blurb: "You vet and onboard everyone — developers, agencies, and their agents.",
    home: "/onboarding",
    homeLabel: "Admin",
  },
  developer: {
    label: "Developer",
    blurb: "Grant agencies access, mark units available, and confirm booking requests.",
    home: "/node",
    homeLabel: "My units & bookings",
  },
  agency: {
    label: "Agency",
    blurb: "Register and manage your agents (salespeople).",
    home: "/agency",
    homeLabel: "My agents",
  },
  agent: {
    label: "Agent",
    blurb: "Open booking requests on units, on behalf of your buyers.",
    home: "/agent",
    homeLabel: "Book a unit",
  },
  unregistered: {
    label: "Not onboarded",
    blurb:
      "This account isn't on VRX yet. Ask us (VRX) to set you up as a developer, agency, or agent.",
    home: "/",
    homeLabel: "Home",
  },
};

/** The nav links a given role should see — the role-scoped menu (replaces the flat 8-link bar). */
export function navFor(role: Role | null): { href: string; label: string }[] {
  switch (role) {
    case "owner":
      return [
        { href: "/root", label: "Relationships" },
        { href: "/onboarding", label: "Onboarding" },
        { href: "/applications", label: "Applications" },
        { href: "/provisioned", label: "Onboarded" },
        { href: "/network", label: "Network" },
      ];
    case "developer":
      return [{ href: "/node", label: "My units & bookings" }];
    case "agency":
      return [{ href: "/agency", label: "My agents" }];
    case "agent":
      return [{ href: "/agent", label: "Book a unit" }];
    default:
      // signed out / unregistered — just the home.
      return [];
  }
}
