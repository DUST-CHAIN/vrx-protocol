"use client";

// Settings menu — a gear button (top-right) that opens a dropdown holding the things that
// used to clutter the top bar: currency ("show prices in"), preferences (snapshot freshness), and sign
// out (with confirm). Only the wallet-name chip stays directly on the bar. Closeable; closes on outside
// click / Escape.

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "@/lib/wallet";
import { useRole } from "@/lib/role";
import { openBuyerProfile } from "@/lib/buyer-profile-event";
import { CurrencyPicker } from "@/lib/currency-provider";
import { usePrefs } from "@/lib/prefs";
import GasBalance from "@/components/GasBalance";
import CreditsCard from "@/components/CreditsCard";
import { OPERATOR_SECRET_KEY, OPERATOR_SECRET_EVENT, readOperatorSecret, writeOperatorSecret } from "@/lib/operator-secret";
import { showCover } from "@/components/PasswordGate";

export default function SettingsMenu() {
  const { accountId, signOut, realConnected } = useWallet();
  const { role } = useRole();
  const pathname = usePathname();
  // Direct buyer is a STATE not a role — the buyer SPA lives at /buyer and owns its profile view.
  // Only surface the launcher there (it dispatches an event the buyer page listens for).
  const onBuyer = pathname === "/buyer" || pathname.startsWith("/buyer/");
  const { prefs, setPrefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [secret, setSecret] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Load the operator secret once (owner-only field below) so the input reflects the saved value.
  useEffect(() => {
    setSecret(readOperatorSecret());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={(e) => {
          // when this gear lives INSIDE the mobile ☰ (TopbarMenu), that menu closes (unmounts us) on
          // any inner click. Stop the click from bubbling to the menu-closer so tapping the gear OPENS this
          // dropdown instead of being destroyed in the same click (the "gear does nothing on mobile" bug).
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Settings"
        aria-label="Settings"
        style={{
          minHeight: 30,
          height: 30,
          width: 30,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: open ? "#1a2233" : "#141824",
          color: "#c7cde0",
          border: "1px solid #232838",
          borderRadius: 8,
          fontSize: 16,
          cursor: "pointer",
          lineHeight: 1,
        }}
      >
        ⚙
      </button>

      {open && (
        <div
          className="vrx-settings-panel"
          style={{
            position: "absolute",
            right: 0,
            top: 38,
            zIndex: 50,
            width: 260,
            maxWidth: "calc(100vw - 24px)",
            background: "#0e1119",
            border: "1px solid #232838",
            borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {/* Buyer: launcher to the full-width profile & verification view (the popup only LAUNCHES — the
              KYC form is too big to host here). Only on /buyer. */}
          {onBuyer && accountId && (
            <div>
              <button
                onClick={() => {
                  setOpen(false);
                  openBuyerProfile();
                }}
                style={{ ...smallBtn, width: "100%", textAlign: "left", background: "#141b2b", borderColor: "#2a3350", color: "#9ab0ff" }}
              >
                My profile &amp; verification →
              </button>
            </div>
          )}

          {/* About / cover — re-open the intro cover (view-only, no passphrase). It carries info found nowhere
              else (what VRX is, the explainer, how to explore); the cover is seen once at unlock, so this keeps
 it reachable. */}
          <div>
            <button
              onClick={() => { setOpen(false); showCover(); }}
              style={{ ...smallBtn, width: "100%", textAlign: "left" }}
            >
              About VRX / intro cover →
            </button>
          </div>

          {/* Currency */}
          <div>
            <div style={sectionLabel}>Show prices in</div>
            <CurrencyPicker compact />
          </div>

          {/* Preferences */}
          <div>
            <div style={sectionLabel}>Availability</div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, opacity: 0.9 }}>
              <span>Auto-show floors updated within</span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <input
                type="number"
                min={1}
                value={prefs.staleMinutes}
                onChange={(e) => setPrefs({ ...prefs, staleMinutes: Math.max(1, Number(e.target.value) || 60) })}
                style={{
                  width: 70,
                  background: "rgba(255,255,255,0.06)",
                  color: "inherit",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 6,
                  padding: "3px 6px",
                  fontSize: 13,
                }}
              />
              <span style={{ fontSize: 13, opacity: 0.7 }}>minutes</span>
            </div>
            <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>
              Older floors show a “tap to load latest” overlay.
            </div>
          </div>

          {/* Account / sign out */}
          {accountId && (
            <div style={{ borderTop: "1px solid #1c2130", paddingTop: 12 }}>
              <div style={sectionLabel}>Account</div>
              <div style={{ fontSize: 12, fontFamily: "ui-monospace, monospace", opacity: 0.7, marginBottom: 8, wordBreak: "break-all" }}>
                {accountId}
              </div>
              {/* F7: gas balance is a LIVE on-chain faucet read — only meaningful for a REAL
                  connected wallet. In demo/no-wallet mode the identity is a simulated role that may
                  not exist on-chain, so a live read 502s into "Network busy". Gate it on realConnected
                  and show an honest note otherwise (no RPC call for a demo identity). */}
              {realConnected ? (
                <GasBalance account={accountId} />
              ) : (
                <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>
                  Gas is shown when you connect a real wallet. You’re exploring in demo mode — no gas needed.
                </div>
              )}
              <div style={{ height: 12 }} />
              {/* Operator secret — VRX Root/owner only. Unlocks the owner dashboards (/root, /applications).
                  Lives here (not on the dashboard) so it's a quiet once-per-session setting. Saving
                  broadcasts OPERATOR_SECRET_EVENT so an open dashboard re-fetches immediately. */}
              {role === "owner" && (
                <div style={{ marginBottom: 12 }}>
                  <div style={sectionLabel}>Operator secret</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder="VRX_OPERATOR_SECRET"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        background: "rgba(255,255,255,0.06)",
                        color: "inherit",
                        border: "1px solid rgba(255,255,255,0.15)",
                        borderRadius: 6,
                        padding: "5px 8px",
                        fontSize: 13,
                      }}
                    />
                    <button onClick={() => writeOperatorSecret(secret)} style={smallBtn}>
                      Use
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>
                    Unlocks the VRX team dashboards. Kept only in this browser session.
                  </div>
                </div>
              )}
              {/* FastNEAR credits — VRX Root/owner only (operator info). */}
              {role === "owner" && <CreditsCard />}
              {role === "owner" && <div style={{ height: 12 }} />}
              {confirming ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => void signOut()} style={{ ...smallBtn, background: "#3a1414", borderColor: "#7a2a2a", color: "#ff8a8a" }}>
                    Confirm sign out
                  </button>
                  <button onClick={() => setConfirming(false)} style={smallBtn}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirming(true)} style={{ ...smallBtn, color: "#ff8a8a", borderColor: "#522" }}>
                  Sign out
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  opacity: 0.6,
  marginBottom: 6,
};

const smallBtn: React.CSSProperties = {
  minHeight: 30,
  padding: "5px 10px",
  background: "#18202f",
  color: "#c7cde0",
  border: "1px solid #2a3350",
  borderRadius: 7,
  fontSize: 13,
  cursor: "pointer",
};
