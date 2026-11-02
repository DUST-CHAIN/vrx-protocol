"use client";

// COVER / PASSWORD GATE — the first thing a visitor (and a hackathon JUDGE) sees. It's a PITCH-FIRST
// so the cover FRAMES VRX as "a mature, real system" (depth, not overwhelm) BEFORE the app — one-liner,
// 2-sentence what-it-is, an on-demand "watch the explainer" (the animation), a "what you'll see" expectation
// setter, a links row (video/repo/AI-doc for human+bot proof-of-real), then the passphrase entry (the brand
// moment: the phrase IS what VRX lets you do).
// SCOPE: a SOFT client gate (localStorage) — keeps casual eyes out of the UI; /api/* is NOT protected (a real
// lock would be middleware.ts). Right for a semi-private demo. For judges, the passphrase goes in the hackathon
// submission + README (so they just type it); an AI triage bot reads the REPO/README, never walks this UI, so
// the gate doesn't block the bot path. A ?enter=<phrase> query also unlocks (frictionless judge/AI link).

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import VrxExplainer from "./VrxExplainer";
import { T } from "@/lib/theme";

const GATE_KEY = "vrx.gate.ok";
const PASSPHRASE = "i want to see how i can transact globally";

// Fill these in the submission. Left as "#" placeholders so the row renders but points nowhere until set.
const LINKS = {
  video: "", // 2–4 min demo video
  repo: "", // the GitHub repo (proof-of-real for the human + the triage bot)
  forAi: "/for-ai-agent.md", // the machine-readable AI-knowledge guide (served from public/)
};

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export default function PasswordGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [showFilm, setShowFilm] = useState(false);
  const [showSite, setShowSite] = useState(false);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      // ?gate=reset re-locks (clears the remembered unlock) — handy for testing / re-seeing the cover.
      if (params.get("gate") === "reset") {
        window.localStorage.removeItem(GATE_KEY);
        setUnlocked(false);
        return;
      }
      // ?enter=<phrase> (or ?enter=1) unlocks programmatically — the frictionless judge/AI link.
      const qp = params.get("enter");
      if (qp && (qp === "1" || norm(qp) === norm(PASSPHRASE))) {
        window.localStorage.setItem(GATE_KEY, "1");
        setUnlocked(true);
        return;
      }
      setUnlocked(window.localStorage.getItem(GATE_KEY) === "1");
    } catch {
      setUnlocked(true); // storage blocked → don't hard-lock out
    }
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (norm(value) === norm(PASSPHRASE)) {
      try { window.localStorage.setItem(GATE_KEY, "1"); } catch { /* best-effort */ }
      setUnlocked(true);
    } else {
      setError(true);
      setValue("");
    }
  };

  if (unlocked === null) return null;
  if (unlocked) return <>{children}</>;

  return (
    <div style={wrap}>
      <div style={cover}>
        {/* ── Pitch ─────────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <span style={seal}>✓ Vetted</span>
          <span style={{ fontSize: 12, color: T.faint, letterSpacing: 0.6, textTransform: "uppercase" }}>
            Private preview
          </span>
        </div>

        <h1 style={{ fontSize: 30, lineHeight: 1.12, margin: "0 0 10px", color: T.text, letterSpacing: -0.6, fontWeight: 700 }}>
          Constitutional freedom to <span style={{ color: T.vetted }}>globally transact.</span>
        </h1>
        <p style={{ fontSize: 15.5, color: T.dim, lineHeight: 1.55, margin: "0 0 18px" }}>
          VRX is a private, on-chain reservation primitive — <strong style={{ color: T.text }}>one trusted source
          of truth for who reserved what</strong>. Operators with unique inventory feed live availability to many
          mutually-distrusting sales teams, who browse → book → reserve → settle, with prices and terms kept
          confidential. Real estate is the proof; the primitive is domain-agnostic.
        </p>

        {/* ── On-demand: the explainer + the real business site ─────────────── */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => setShowFilm(true)} style={filmBtn}>
            <span style={{ fontSize: 15 }}>▶</span> Watch the 60-second explainer
          </button>
          <button onClick={() => setShowSite(true)} style={siteBtn}>
            See Vetted Realty ↗
          </button>
        </div>

        {/* ── What you'll see (frames the complexity as depth) ──────────────── */}
        <div style={{ marginTop: 20 }}>
          <p style={label}>What you&apos;ll see inside</p>
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 7 }}>
            {[
              "Eight real roles — developer, agency, agent, buyer and more — each its own working app",
              "Privacy by design: personal details, prices and deal terms never go on-chain",
              "A full deal, end to end: browse availability → book → reserve → settle → account",
            ].map((t) => (
              <li key={t} style={{ display: "flex", gap: 9, fontSize: 14, color: T.dim, lineHeight: 1.45 }}>
                <span style={{ color: T.vetted, flexShrink: 0 }}>›</span>{t}
              </li>
            ))}
          </ul>
        </div>

        {/* ── Links (proof-of-real for a human + a triage bot) ──────────────── */}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 20 }}>
          {LINKS.video && <a href={LINKS.video} target="_blank" rel="noreferrer" style={linkStyle}>Demo video ↗</a>}
          {LINKS.repo && <a href={LINKS.repo} target="_blank" rel="noreferrer" style={linkStyle}>GitHub repo ↗</a>}
          <a href={LINKS.forAi} target="_blank" rel="noreferrer" style={linkStyle}>For your AI ↗</a>
        </div>

        {/* ── Enter (the brand moment + the gate) ───────────────────────────── */}
        {/* Deliberately SIMPLE: no click-to-copy, no copied-confirmation. Just "type the phrase
            the box." The phrase IS the brand moment, and typing/pasting it by hand reinforces the message — so we
            don't shortcut it. The phrase renders as plain selectable text (userSelect: all) for anyone who prefers
            to copy manually. (The ?enter= link still gives a frictionless path for judges/AI.) */}
        <form onSubmit={submit} style={{ marginTop: 24, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 20 }}>
          <p style={{ fontSize: 14, color: T.text, margin: "0 0 10px", lineHeight: 1.55 }}>
            To continue into the demo, type the following in the box below:{" "}
            <span style={phraseText}>i want to see how i can transact globally</span>
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(false); }}
              placeholder="Type the phrase here…"
              aria-label="Passphrase"
              style={{ ...input, borderColor: error ? T.danger : T.border, flex: 1, minWidth: 220 }}
            />
            <button type="submit" style={btn}>Go →</button>
          </div>
          {error && (
            <p style={{ color: T.danger, fontSize: 12.5, margin: "8px 0 0" }}>
              That&apos;s not quite it — type the phrase exactly as shown above.
            </p>
          )}
        </form>
      </div>

      {/* ── Explainer modal ─────────────────────────────────────────────────── */}
      {showFilm && (
        <div style={modalBackdrop} onClick={() => setShowFilm(false)}>
          <div style={modalStage} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowFilm(false)} style={modalClose} aria-label="Close explainer">×</button>
            <VrxExplainer />
          </div>
        </div>
      )}

      {/* ── Vetted Realty site lightbox ─────────────────────────────────────── */}
      {showSite && (
        <div style={modalBackdrop} onClick={() => setShowSite(false)}>
          <div style={siteStage} onClick={(e) => e.stopPropagation()}>
            <div style={siteBar}>
              <span style={{ fontSize: 13, color: T.dim }}>vettedrealty.com</span>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <a href="https://vettedrealty.com" target="_blank" rel="noreferrer" style={{ ...linkStyle, fontSize: 12.5 }}>
                  Open in new tab ↗
                </a>
                <button onClick={() => setShowSite(false)} style={{ ...modalClose, position: "static" }} aria-label="Close">×</button>
              </div>
            </div>
            {/* If the site blocks framing (X-Frame-Options/CSP), the iframe is blank — the "Open in new tab"
                link above is the always-works fallback so this is never a dead end. */}
            <iframe
              title="Vetted Realty"
              src="https://vettedrealty.com"
              style={{ width: "100%", flex: 1, border: "none", background: "#fff" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 16px",
  background: "radial-gradient(1100px 560px at 50% 16%, rgba(56,211,159,0.055), transparent 60%), #05070c",
};
const cover: React.CSSProperties = {
  width: "min(100%, 560px)", background: T.panel, border: `1px solid ${T.border}`,
  borderRadius: 16, padding: "30px 32px", boxShadow: "0 30px 90px rgba(0,0,0,0.55)",
};
const seal: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 999,
  fontSize: 12, fontWeight: 600, color: "#07140d", background: T.vetted, letterSpacing: 0.3,
};
const label: React.CSSProperties = {
  margin: 0, fontSize: 11.5, color: T.faint, textTransform: "uppercase", letterSpacing: 0.7, fontWeight: 600,
};
const filmBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 9, padding: "10px 16px", borderRadius: 10,
  border: `1px solid rgba(56,211,159,0.4)`, background: "rgba(56,211,159,0.08)", color: T.vetted,
  fontSize: 14, fontWeight: 600, cursor: "pointer",
};
const siteBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 10,
  border: `1px solid ${T.border}`, background: T.bg2, color: T.text,
  fontSize: 14, fontWeight: 500, cursor: "pointer",
};
const linkStyle: React.CSSProperties = { color: T.accent, fontSize: 13.5, textDecoration: "none", fontWeight: 500 };
// The passphrase as plain, selectable emphasis — not a button, not a chip. Typing it IS the brand moment.
const phraseText: React.CSSProperties = {
  color: T.vetted, fontWeight: 600, userSelect: "all", whiteSpace: "nowrap",
};
const input: React.CSSProperties = {
  boxSizing: "border-box", padding: "11px 13px", borderRadius: 9,
  background: T.bg2, border: `1px solid ${T.border}`, color: T.text, fontSize: 15, outline: "none",
};
const btn: React.CSSProperties = {
  padding: "11px 20px", borderRadius: 9, border: "none",
  background: T.vetted, color: "#07140d", fontSize: 15, fontWeight: 600, cursor: "pointer",
};
const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 100, background: "rgba(3,5,9,0.85)", backdropFilter: "blur(8px)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
};
const modalStage: React.CSSProperties = {
  // Responsive: wide screens get ~16:9; a portrait phone gets a TALL box (the explainer stacks diagram-over-
  // caption via its own media query). `min(86vh, max(16:9-height, 78vh))` → tall on portrait, 16:9 on desktop.
  position: "relative", width: "min(100%, 1000px)",
  height: "min(86vh, max(56.25vw, 78vh))",
  borderRadius: 14, overflow: "hidden", border: `1px solid ${T.border}`, boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
};
const modalClose: React.CSSProperties = {
  // low-contrast dark square over a dark iframe, easy to miss). Vetted-green ring + larger hit target.
  position: "absolute", top: 12, right: 12, zIndex: 20, width: 44, height: 44, borderRadius: 999,
  border: `1.5px solid ${T.vetted}`, background: "rgba(10,14,23,0.92)", color: T.vetted, fontSize: 24,
  fontWeight: 700, cursor: "pointer", lineHeight: 1, display: "flex", alignItems: "center",
  justifyContent: "center", boxShadow: "0 2px 14px rgba(0,0,0,0.5)",
};
const siteStage: React.CSSProperties = {
  position: "relative", width: "min(100%, 1100px)", height: "86vh",
  borderRadius: 14, overflow: "hidden", border: `1px solid ${T.border}`,
  boxShadow: "0 24px 80px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", background: T.panel,
};
const siteBar: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "8px 12px", borderBottom: `1px solid ${T.border}`, background: T.bg2, flexShrink: 0,
};
