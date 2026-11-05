"use client";

// /warroom — the FUTURE standalone warroom app, kept as a scaffold.: "warroom shall be a
// menu item in developer for now … later it may become its own app" + "from VRX root we will onboard a CEO
// who gets his own wallet and becomes the warroom app — but not yet". So TODAY the warroom lives as a section
// inside the developer app (/node, via components/WarroomOverview). This route stays as the standalone shell
// the future CEO app graduates into — same WarroomOverview component, its own DashboardShell — so promoting
// it is just wiring a `ceo` role (onboarded from root) to land here, no re-write.
//
// Gated to developers today (the only account that has a warroom to show); the future CEO role attaches here.

import { useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { useRole } from "@/lib/role";
import { getNode } from "@/lib/vrx";
import { banner } from "@/lib/ui";
import { T } from "@/lib/theme";
import DashboardShell, { type ShellSection } from "@/components/DashboardShell";
import WarroomOverview from "@/components/WarroomOverview";
import EventLog from "@/components/EventLog";

export default function WarroomPage() {
  const { accountId, ready, signIn } = useWallet();
  const { role } = useRole();
  const [isNode, setIsNode] = useState<boolean | null>(null);

  useEffect(() => {
    if (!accountId) {
      setIsNode(null);
      return;
    }
    // Trust a (demo-override) developer role immediately — same pattern as /node + /agent. The snapshot
    // demo has no chain to register the node on, so the on-chain getNode returns null; the role override
    // carries it. (lib/role demoRoleUxArmed)
    if (role === "developer") setIsNode(true);
    getNode(accountId)
      .then((n) => {
        const ok = !!n && (n as { a?: boolean }).a !== false;
        if (n === null && role === "developer") return;
        setIsNode(ok);
      })
      .catch(() => { if (role !== "developer") setIsNode(false); });
  }, [accountId, role]);

  const sections: ShellSection[] =
    accountId && isNode
      ? [
          { id: "overview", label: "Overview", icon: "📊", element: <WarroomOverview me={accountId} /> },
          { id: "activity", label: "Event log", icon: "🕑", element: <EventLog me={accountId} role="developer" /> },
        ]
      : [];

  return (
    <DashboardShell
      title="Warroom"
      persistKey="warroom"
      intro="Your company at a glance — availability over time, live demand, and what's happened"
      banner={<WarroomBanner ready={ready} accountId={accountId} isNode={isNode} signIn={signIn} />}
      sections={sections}
    />
  );
}

// Sign-in / not-a-developer gate (same posture as /node).
function WarroomBanner({
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
      <div style={{ ...banner, borderColor: "#2b3350", background: "#141a27" }}>
        Sign in with your developer account to open your warroom.{" "}
        <button type="button" onClick={signIn} style={{ marginLeft: 8, background: "none", border: "none", color: T.accent, cursor: "pointer", fontWeight: 600 }}>
          Connect
        </button>
      </div>
    );
  }
  if (isNode === false) {
    return (
      <div style={{ ...banner, borderColor: "#6b5426", background: "#241d0e" }}>
        This account isn&apos;t set up as a developer, so there&apos;s no warroom to show. The warroom is a
        developer&apos;s own executive view of their buildings and deals.
      </div>
    );
  }
  return null;
}
