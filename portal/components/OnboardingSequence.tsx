"use client";

// POST-ARRIVAL ONBOARDING SEQUENCE. When a user ARRIVES — connects a real wallet OR picks a demo
// role — the system "reaches out" with a short timed drip of notifications:
//   1) welcome + ROLE-SPECIFIC "what to do next"
//  2) a $75,000 $VRX platform-credit airdrop (drives the REAL claim path, lib/vrx-token)
//   3) a credits note: what $VRX pays for, the 0.5% seller-side fee, "log in tomorrow for another $75k"
//  (= the 2nd claim, ≥48h cooldown), and the HONEST framing — it's a real system but $VRX is
//      PLAY MONEY (a wink: maybe a collector meme-coin someday 😄), never real USD.
//
// HONESTY (project HARD rule): never imply $VRX is USD or a live token. Copy says "platform credits" + the
// play-money note. Distinct from the real BTC asset layers (equity token / node licenses) — see memory
// vrx-asset-layers-and-node-economics.
//
// Plays ONCE per account (localStorage flag) so it doesn't re-fire on every navigation/reload. The airdrop is
// idempotent-safe regardless: claim enforces the cap/cooldown, so a double-fire just no-ops with a friendly
// "already granted — come back tomorrow" instead of double-paying.
//
// MOBILE + DESKTOP: the toast stack is fixed bottom-center on phones (full-width minus margins) and
// bottom-right on wider screens; cards cap their width so long copy wraps cleanly.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/lib/wallet";
import { useRole, type Role } from "@/lib/role";
import { T } from "@/lib/theme";
import ParticipateModal from "@/components/ParticipateModal";

// ── Timing (DEMO-FAST per — a judge/visitor sees the whole arc in ~1 min). The REAL-USER timings
//    are kept here commented for a future "realistic drip" mode: welcome ~90s, airdrop ~100s, credits +10min. ──
const DELAY_WELCOME_MS = 15_000; // real: 90_000
const DELAY_AIRDROP_MS = 25_000; // real: 100_000
const DELAY_CREDITS_MS = 60_000; // real: 600_000
const AUTO_DISMISS_MS = 22_000; // each toast auto-fades after this (user can dismiss sooner)

const SEEN_PREFIX = "vrx.onboarding.seen."; // + account

type ToastKind = "welcome" | "airdrop" | "credits";
type Toast = { id: number; kind: ToastKind; title: string; body: React.ReactNode; accent: string };

// Role-specific "what to do next" (plain language — no jargon). `unregistered`/owner get a generic line.
function roleNextSteps(role: Role | null): { label: string; steps: string } {
  switch (role) {
    case "developer":
      return { label: "developer", steps: "List your buildings and units, grant agencies access, and confirm bookings as they come in. You can also sell direct to walk-in buyers." };
    case "agency":
      return { label: "agency", steps: "Register your agents, work the developers who've granted you access, and track your team's bookings and commission." };
    case "agent":
      return { label: "agent", steps: "Browse available units, open a booking request for your buyer, negotiate terms, and follow it through to a signed deal." };
    case "owner":
      return { label: "operator", steps: "You oversee the platform — vet parties, watch activity, and keep the system healthy." };
    default:
      return { label: "explorer", steps: "Pick a role to step into — developer, agency, agent or buyer — and walk a real deal end to end on seeded data." };
  }
}

export default function OnboardingSequence() {
  const { accountId, ready } = useWallet();
  const { role } = useRole();
  const router = useRouter();
  const [toasts, setToasts] = useState<Toast[]>([]);
  // F9: the "node licenses" link in the credits toast opens the Participate content in an IN-APP MODAL
  // (no full-page navigation — a raw <a href> would reload the app and strand the user). Hosted at the root.
  const [participateOpen, setParticipateOpen] = useState(false);
  const idSeq = useRef(0);
  const timers = useRef<number[]>([]);
  const roleRef = useRef<Role | null>(role);
  roleRef.current = role; // always read the freshest role inside the scheduled callbacks

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, body: React.ReactNode, accent: string) => {
      const id = ++idSeq.current;
      setToasts((ts) => [...ts, { id, kind, title, body, accent }]);
      const h = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      timers.current.push(h);
    },
    [dismiss]
  );

  // Fire the airdrop via the REAL claim path. Graceful on the cap/cooldown (just reflect it in the copy).
  const grantAirdrop = useCallback(async (account: string): Promise<string> => {
    try {
      const res = await fetch("/api/vrx-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "claim", account }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // F10: tell the topbar chip (+ any balance view) to refresh NOW, so it doesn't keep showing the
        // pre-claim number for up to 30s and disagree with this toast's "now X".
        try { window.dispatchEvent(new Event("vrx:balance-changed")); } catch { /* non-browser/no-op */ }
        return `Your balance is now ${Number(data.balanceVrx ?? 0).toLocaleString()} $VRX.`;
      }
      // Already claimed today / cap reached — honest, friendly.
      return typeof data.error === "string" && /day|limit|cooldown/i.test(data.error)
        ? "You've already been granted your $VRX for now — come back tomorrow for the next drop."
        : "Your $VRX is being prepared — check your wallet panel in a moment.";
    } catch {
      return "Your $VRX is being prepared — check your wallet panel in a moment.";
    }
  }, []);

  useEffect(() => {
    if (!ready || !accountId) return;
    const account = accountId;
    const seenKey = SEEN_PREFIX + account.toLowerCase();
    try {
      if (window.localStorage.getItem(seenKey)) return; // already played for this account
      window.localStorage.setItem(seenKey, String(Date.now()));
    } catch {
      /* storage blocked — still play it, just non-persistently */
    }

    // Clear any timers from a prior account before scheduling this one's.
    timers.current.forEach((h) => window.clearTimeout(h));
    timers.current = [];

    // 1) WELCOME + role next-steps.
    timers.current.push(
      window.setTimeout(() => {
        const r = roleNextSteps(roleRef.current);
        push(
          "welcome",
          "Welcome to VRX 👋",
          <>
            You're in as <strong style={{ color: T.vetted }}>{r.label}</strong>. {r.steps}
          </>,
          T.vetted
        );
      }, DELAY_WELCOME_MS)
    );

    // 2) $75,000 $VRX airdrop (real claim path).
    timers.current.push(
      window.setTimeout(async () => {
        const detail = await grantAirdrop(account);
        push(
          "airdrop",
          "🎉 $75,000 $VRX airdropped",
          <>
            We've credited your account with <strong>$75,000 in $VRX platform credits</strong> to try everything
            for real. {detail}
          </>,
          "#f1c40f"
        );
      }, DELAY_AIRDROP_MS)
    );

    // 3) Credits note: what it's for + fee + tomorrow-again + the honest play-money wink.
    timers.current.push(
      window.setTimeout(() => {
        push(
          "credits",
          "What your $VRX is for",
          <>
            Use it to pay deposits, negotiate deals, sign contracts, track and pay installments, and chat with
            your agents and developer — and learn to trust VRX, the system that works for you.
            <br />
            <span style={{ display: "block", marginTop: 8, color: T.dim }}>
              Log in tomorrow for another <strong>$75,000 $VRX</strong>. VRX's platform fee is just{" "}
              <strong>0.5%</strong>, charged to the seller and taken from the deposit (about $500 on a typical
              deal).
            </span>
            <span style={{ display: "block", marginTop: 8, fontSize: 12, color: T.dim, fontStyle: "italic" }}>
              We're honest — this is the new generation. VRX is a real system, but $VRX is play money for the
              sandbox (who knows, maybe a collector's meme coin one day 😄). Real value lives on Bitcoin — our
              equity token and{" "}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setParticipateOpen(true); }}
                style={{ color: "#f7931a", fontStyle: "normal", background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", textDecoration: "underline" }}
              >
                node licenses
              </button>{" "}
              (help fund &amp; run VRX).
            </span>
          </>,
          T.accent
        );
      }, DELAY_CREDITS_MS)
    );

    return () => {
      timers.current.forEach((h) => window.clearTimeout(h));
      timers.current = [];
    };
    // Re-run only when the arrived account changes (not on role flips mid-session — roleRef captures the latest).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, accountId]);

  // Render nothing visible unless there are toasts OR the participate modal is open (it can outlive the toast).
  if (toasts.length === 0 && !participateOpen) return null;

  return (
    <>
      {toasts.length > 0 && (
        <div style={wrap} className="vrx-toast-wrap" aria-live="polite">
          {toasts.map((t) => {
            // F12: the $VRX toasts (airdrop/credits) are a shortcut to the wallet — click the card to go
            // see your balance/history. The welcome toast isn't balance-related, so it stays non-clickable.
            // Clicks on the dismiss × or the inner "node licenses" button must NOT also navigate (stopPropagation
            // on ×; the inner button already lives in its own handler). $VRX lives in VRX's own /wallet, not in
            // an external wallet — $VRX is an off-chain VRX-native credit (Meteor would only show NEAR).
            const goesToWallet = t.kind === "airdrop" || t.kind === "credits";
            return (
              <div
                key={t.id}
                style={{ ...card, borderLeft: `3px solid ${t.accent}`, cursor: goesToWallet ? "pointer" : "default" }}
                role="status"
                onClick={goesToWallet ? () => { dismiss(t.id); router.push("/wallet"); } : undefined}
                title={goesToWallet ? "Open your $VRX wallet" : undefined}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}
                  style={closeBtn}
                  aria-label="Dismiss"
                  title="Dismiss"
                >
                  ×
                </button>
                <div style={{ ...titleStyle, color: t.accent }}>{t.title}</div>
                <div style={bodyStyle}>{t.body}</div>
              </div>
            );
          })}
        </div>
      )}
      {participateOpen && <ParticipateModal onClose={() => setParticipateOpen(false)} />}
    </>
  );
}

const wrap: React.CSSProperties = {
  position: "fixed",
  zIndex: 90,
  // Sit ABOVE the Help widget (fixed bottom-right ~16px) so the toast's last lines aren't clipped by it.
  bottom: 76,
  // Phone: span the width (minus margins), centered. ≥560px: anchor bottom-right, capped width.
  left: 12,
  right: 12,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  alignItems: "center",
  pointerEvents: "none",
};

const card: React.CSSProperties = {
  position: "relative",
  pointerEvents: "auto",
  width: "100%",
  maxWidth: 420,
  background: T.panel,
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  padding: "14px 16px 14px 16px",
  boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
  color: T.text,
  animation: "vrxToastIn 0.25s ease-out",
};

const titleStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 15,
  marginBottom: 6,
  paddingRight: 20,
};

const bodyStyle: React.CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.5,
  color: T.text,
};

const closeBtn: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 10,
  background: "transparent",
  border: "none",
  color: "#8a93a8",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
  padding: 2,
};
