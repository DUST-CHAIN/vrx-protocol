"use client";

// VrxBalanceChip (wallet #3) — the $VRX balance IN-CONTEXT in the topbar, so a user always sees
// their play-credit balance, not only inside the wallet section. Self-contained: own fetch + own state (reads
// the same /api/vrx-token the wallet panel uses), so it drops into the shared topbar without threading balance
// state through DashboardShell. Refreshes lightly so a claim/spend elsewhere reflects here within ~30s.
//
// HONEST: labelled "$VRX" (the play credit), never conflated with real NEAR. A click routes to the full wallet.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { T } from "@/lib/theme";

export default function VrxBalanceChip({ me, walletHref }: { me: string; walletHref?: string }) {
  const router = useRouter();
  const [vrx, setVrx] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!me) return;
    try {
      const r = await fetch(`/api/vrx-token?account=${encodeURIComponent(me)}`);
      if (!r.ok) return;
      const j = await r.json();
      if (typeof j.balanceVrx === "number") setVrx(j.balanceVrx);
    } catch {
      /* transient — keep the last known value */
    }
  }, [me]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void load();
    const t = setInterval(() => void loadRef.current(), 30_000);
    // F10: refresh IMMEDIATELY when a $VRX move happens elsewhere (e.g. the onboarding airdrop claim),
    // instead of waiting up to 30s for the next poll — which made the chip disagree with the airdrop toast's
    // "your balance is now X" (chip showed the pre-claim number). Any code that changes a balance dispatches
    // `window` event "vrx:balance-changed"; we re-fetch on it.
    const onChange = () => void loadRef.current();
    window.addEventListener("vrx:balance-changed", onChange);
    return () => {
      clearInterval(t);
      window.removeEventListener("vrx:balance-changed", onChange);
    };
  }, [load]);

  if (vrx === null) return null; // nothing to show until we have a real number (no flicker of "0")

  const chip = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12.5,
        fontWeight: 600,
        color: T.vetted,
        background: T.bg2,
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 999,
        padding: "3px 10px",
        whiteSpace: "nowrap",
        cursor: walletHref ? "pointer" : "default",
      }}
      title="Your $VRX balance (in-system play credit) — tap for the wallet"
    >
      {vrx.toLocaleString("en-US")} <span style={{ opacity: 0.7, fontWeight: 500 }}>$VRX</span>
    </span>
  );

  if (!walletHref) return chip;
  return (
    <button type="button" onClick={() => router.push(walletHref)} style={{ border: "none", background: "none", padding: 0 }}>
      {chip}
    </button>
  );
}
