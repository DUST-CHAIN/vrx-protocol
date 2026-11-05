"use client";

// NodeLicensesNudge — the compact, discoverable one-liner that funnels a user to the node-license
// idea (the rich surface is NodeLicensesPanel). Low cost, high value: a small honest invitation to help fund &
// run VRX by buying a real Bitcoin node license. Appears in the wallet area, onboarding, and the ☰ menu.
//
// HONEST (HARD rule): REAL Bitcoin asset, NOT $VRX play credit — the copy + the Bitcoin-orange accent keep the
// two distinct. By default the nudge opens the Participate surface in an IN-APP MODAL OVERLAY (F9, —
// "open in a popup, not a new tab"); every nudge site (☰ menu, onboarding, wallet area) gets the same
// overlay for free. Pass `href` to deep-link instead (e.g. straight to tokenscan), or `onClick` to make it a
// plain button (e.g. reveal a menu section) — both skip the modal.

import { useState } from "react";
import { T } from "@/lib/theme";
import { fromPriceBtc } from "@/lib/node-licenses";
import ParticipateModal from "@/components/ParticipateModal";

const BTC = "#f7931a";

export default function NodeLicensesNudge({
  href,
  onClick,
  compact = false,
}: {
  /** Deep-link target. When set, the nudge is a plain link to this URL (skips the in-app modal). */
  href?: string;
  /** When set, the nudge is a button (e.g. to reveal a menu section) instead of opening the modal. */
  onClick?: () => void;
  /** Tighter styling for dense contexts (inside the ☰ menu). */
  compact?: boolean;
}) {
  // F9: default behaviour = open the Participate content in a modal overlay (no navigation, no new tab).
  const [open, setOpen] = useState(false);
  const from = fromPriceBtc();
  const label = (
    <>
      <span aria-hidden style={{ color: BTC, fontSize: compact ? 14 : 16 }}>₿</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, textAlign: "left", minWidth: 0 }}>
        <span style={{ fontSize: compact ? 12.5 : 13.5, color: T.text, fontWeight: 600 }}>
          Help fund &amp; run VRX
        </span>
        <span style={{ fontSize: compact ? 10.5 : 11.5, color: T.faint, lineHeight: 1.4 }}>
          Buy a Bitcoin node license{from ? ` — from ${from} ₿` : ""} · real BTC, not $VRX
        </span>
      </span>
      <span aria-hidden style={{ marginLeft: "auto", color: T.faint, fontSize: 13 }}>→</span>
    </>
  );

  const style: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: compact ? "8px 10px" : "10px 12px",
    borderRadius: 10,
    background: T.bg2,
    border: `1px solid ${BTC}44`, // faint Bitcoin-orange ring — nods to BTC without shouting
    color: T.text,
    textDecoration: "none",
    cursor: "pointer",
    boxSizing: "border-box",
  };

  const ariaLabel = "Help fund and run VRX — buy a Bitcoin node license";

  // Explicit onClick wins (e.g. a menu section toggle).
  if (onClick) {
    return (
      <button type="button" onClick={onClick} style={{ ...style, textAlign: "left" }} aria-label={ariaLabel}>
        {label}
      </button>
    );
  }
  // Explicit href → a real link (e.g. deep-link straight to tokenscan).
  if (href) {
    return (
      <a href={href} style={style} aria-label={ariaLabel}>
        {label}
      </a>
    );
  }
  // Default (F9): open the Participate surface in an in-app modal overlay — no navigation, no new tab.
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} style={{ ...style, textAlign: "left" }} aria-label={ariaLabel}>
        {label}
      </button>
      {open && <ParticipateModal onClose={() => setOpen(false)} />}
    </>
  );
}
