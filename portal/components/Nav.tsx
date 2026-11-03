"use client";

// Role-scoped header nav. Replaces the old flat 8-link bar: each login now sees only the
// links its role needs (navFor). Signed out / unregistered → just the VRX Portal home link.
// The brand link always goes to "/" (the role dispatcher decides what home to show).

import Link from "next/link";
import { usePathname } from "next/navigation";
import ConnectButton from "@/components/ConnectButton";
import SettingsMenu from "@/components/SettingsMenu";
import VrxLogoMark from "@/components/VrxLogoMark";
import { useWallet } from "@/lib/wallet";
import { useRole, navFor, ROLE_META } from "@/lib/role";

export default function Nav() {
  const { role, loading } = useRole();
  const { accountId, ready } = useWallet();
  const pathname = usePathname();
  const links = navFor(role);

  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        padding: "9px 14px",
        borderBottom: "1px solid #1c2130",
        flexWrap: "wrap",
      }}
    >
      <nav style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0, flexWrap: "wrap" }}>
        {/* Compact brand: ◆ VRX + the role chip (drops "· Vetted Realty" to save space). */}
        <Link
          href="/"
          style={{ color: "#e8ecf4", textDecoration: "none", fontWeight: 700, letterSpacing: 0.3, display: "inline-flex", alignItems: "center", gap: 6 }}
          title="Constitutional freedom to globally transact — a preview of Vetted Realty"
        >
          <VrxLogoMark size={32} /> VRX
        </Link>
        {role && role !== "unregistered" && (
          <span
            style={{
              fontSize: 12,
              padding: "2px 8px",
              borderRadius: 999,
              background: "#1a2030",
              border: "1px solid #2a3350",
              color: "#9ab0ff",
            }}
            title="Your role on VRX"
          >
            {ROLE_META[role].label}
          </span>
        )}
        {links.map((l) => {
          const activeLink = pathname === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              style={{
                color: activeLink ? "#e6e9ef" : "#9aa4bf",
                textDecoration: "none",
                fontSize: 14,
                fontWeight: activeLink ? 600 : 400,
              }}
            >
              {l.label}
            </Link>
          );
        })}
        {loading && <span style={{ opacity: 0.4, fontSize: 13 }}>…</span>}
      </nav>
      <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
        {ready && accountId ? (
          <>
            {/* Only the wallet name stays on the bar (closeable via the gear → sign out). */}
            <span
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 13,
                padding: "5px 9px",
                borderRadius: 8,
                background: "#141824",
                border: "1px solid #232838",
                maxWidth: "44vw",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={`Connected account: ${accountId}`}
            >
              {accountId.replace(/\.(testnet|near)$/, "")}
            </span>
            <SettingsMenu />
          </>
        ) : (
          <ConnectButton />
        )}
      </div>
    </header>
  );
}
