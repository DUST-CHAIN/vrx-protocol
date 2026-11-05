"use client";

// Help widget — a folded page-corner button that opens a FULL-SCREEN overlay with two tabs:
//   • Quick help — the free, instant, pre-written Q&A (lib/ai-help-content). Zero cost, always available.
//   • Ask AI — a chat backed by DeepSeek via /api/ai-help, which is rate- + spend-capped server-side and
//     FAILS CLOSED to the free help when the cap is hit or the key is missing. So the widget is never broken:
//     worst case it quietly points the user back to Quick help.
//
// Mounted once globally in app/layout.tsx (next to DevAccountSwitcher) so it's on every page.
//
// MOBILE CORRECTNESS (the hard part — the classic on-screen-keyboard mess):
//   - The overlay height tracks window.visualViewport.height, NOT 100vh. When the soft keyboard opens it
//     shrinks the visual viewport; binding the overlay to it keeps the whole chat (incl. the input row)
//     inside the visible area instead of the input hiding behind the keyboard.
//   - The overlay is offset by visualViewport.offsetTop so it stays pinned when the browser chrome scrolls.
//   - safe-area insets (notch / home indicator) pad the frame via env(safe-area-inset-*).
//   - The input row is the flex footer (always last, never scrolls away); the message list scrolls above it.
//   - Inputs use fontSize >=16px so iOS Safari doesn't auto-zoom on focus.
//   - Body scroll is locked while open so the page behind doesn't rubber-band.

import { useCallback, useEffect, useRef, useState } from "react";
import { T } from "@/lib/theme";
import { HELP_TOPICS } from "@/lib/ai-help-content";
import { showCover } from "@/components/PasswordGate";

type ChatMsg = { role: "user" | "assistant"; content: string };

const CAP_FALLBACK =
  "The AI assistant is resting for now (it's rate-limited to keep the demo fair). The Quick help tab answers the common questions — or email vrx@vettedrealty.com.";

export default function HelpWidget() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"quick" | "ai">("quick");

  // --- Ask-AI chat state ---
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // --- Mobile viewport tracking: overlay follows the VISUAL viewport (shrinks with the keyboard) ---
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  // Desktop vs phone: on a wide screen the help overlay must be a constrained RIGHT-SIDE panel, not the
  // whole window (full-screen on desktop is hard to read; it's perfect as-is on phone).
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 760px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) return;
    const v = window.visualViewport;
    const sync = () => setVv({ h: v.height, top: v.offsetTop });
    sync();
    v.addEventListener("resize", sync);
    v.addEventListener("scroll", sync);
    return () => {
      v.removeEventListener("resize", sync);
      v.removeEventListener("scroll", sync);
    };
  }, [open]);

  // Lock the page behind the overlay + close on Esc.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Keep the newest message in view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs, busy]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const next: ChatMsg[] = [...msgs, { role: "user", content: text }];
    setMsgs(next);
    setDraft("");
    setBusy(true);
    try {
      const r = await fetch("/api/ai-help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        answer?: string;
        fallback?: boolean;
      };
      const reply = j.ok && j.answer ? j.answer : CAP_FALLBACK;
      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: CAP_FALLBACK }]);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, msgs]);

  // The folded page-corner tab (closed state).
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open help"
        style={{
          position: "fixed",
          right: 0,
          bottom: "calc(84px + env(safe-area-inset-bottom, 0px))",
          zIndex: 900,
          padding: "9px 12px 9px 14px",
          borderTopLeftRadius: 12,
          borderBottomLeftRadius: 12,
          border: `1px solid ${T.border}`,
          borderRight: "none",
          background: T.panel2,
          color: T.text,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          boxShadow: "-2px 2px 10px rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "center",
          gap: 7,
        }}
      >
        <span aria-hidden style={{ color: T.accent, fontSize: 15 }}>?</span>
        Help
      </button>
    );
  }

  // Overlay geometry.
  //  • DESKTOP (≥760px): a constrained, rounded RIGHT-SIDE panel (not the whole window) so it's a readable
  //    drawer. A dimmed backdrop (below) catches outside-clicks to close.
  //  • PHONE: follow the VISUAL viewport exactly (shrinks with the soft keyboard) — unchanged, it's perfect.
  const frame: React.CSSProperties = isDesktop
    ? {
        position: "fixed", top: 16, right: 16, bottom: 16, width: "min(420px, 92vw)",
        zIndex: 1000, borderRadius: 14, overflow: "hidden",
        border: `1px solid ${T.border}`, boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }
    : vv
    ? { position: "fixed", left: 0, right: 0, top: vv.top, height: vv.h, zIndex: 1000 }
    : { position: "fixed", inset: 0, zIndex: 1000 };

  return (
    <>
      {/* Desktop-only click-away backdrop (phone is full-screen so needs none). */}
      {isDesktop && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(3,5,9,0.45)" }}
        />
      )}
    <div
      style={{
        ...frame,
        background: T.bg,
        display: "flex",
        flexDirection: "column",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      {/* Header: title + tab switch + close */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 14px",
          paddingTop: "calc(12px + env(safe-area-inset-top, 0px))",
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <strong style={{ fontSize: 15 }}>VRX help</strong>
        <div style={{ display: "flex", gap: 6, marginLeft: 6 }}>
          {(["quick", "ai"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                padding: "5px 11px",
                borderRadius: 8,
                border: `1px solid ${tab === t ? T.accent : T.border}`,
                background: tab === t ? T.accentSoft : "transparent",
                color: tab === t ? T.text : T.dim,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {t === "quick" ? "Quick help" : "Ask AI"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close help"
          style={{
            marginLeft: "auto",
            width: 34,
            height: 34,
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: "transparent",
            color: T.dim,
            fontSize: 18,
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>

      {/* Body (scrolls) */}
      {tab === "quick" ? (
        <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "4px 14px 16px" }}>
          {HELP_TOPICS.map((t, i) => (
            <QuickItem key={i} q={t.q} a={t.a} />
          ))}
          <p style={{ color: T.faint, fontSize: 12, marginTop: 16 }}>
            Need something specific? Try the <b>Ask AI</b> tab, or email vrx@vettedrealty.com.
          </p>
          {/* Re-open the intro cover (view-only, no passphrase) — it carries the overview + "how to explore"
 that live nowhere else. */}
          <button
            onClick={() => { setOpen(false); showCover(); }}
            style={{
              marginTop: 10, background: "none", border: "none", padding: 0, cursor: "pointer",
              color: T.accent, fontSize: 13, fontWeight: 500, textAlign: "left",
            }}
          >
            View the intro cover (what VRX is &amp; how to explore) →
          </button>
        </div>
      ) : (
        <>
          <div ref={listRef} style={{ flex: "1 1 auto", overflowY: "auto", padding: "12px 14px" }}>
            {msgs.length === 0 && (
              <p style={{ color: T.dim, fontSize: 14 }}>
                Ask anything about VRX — what it is, whether it fits your use-case, how reservations and
                privacy work. Answers are kept short and honest.
              </p>
            )}
            {msgs.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} />
            ))}
            {busy && <div style={{ color: T.faint, fontSize: 13, padding: "4px 2px" }}>…thinking</div>}
          </div>
          {/* Input row — the flex FOOTER: always visible above the keyboard because the frame height = visualViewport. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            style={{
              flex: "0 0 auto",
              display: "flex",
              gap: 8,
              padding: "10px 12px",
              paddingBottom: "calc(10px + env(safe-area-inset-bottom, 0px))",
              borderTop: `1px solid ${T.border}`,
              background: T.panel,
            }}
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask about VRX…"
              enterKeyHint="send"
              style={{
                flex: 1,
                boxSizing: "border-box",
                padding: "10px 12px",
                borderRadius: 8,
                background: T.bg2,
                border: `1px solid ${T.border}`,
                color: T.text,
                fontSize: 16, // >=16px: no iOS auto-zoom on focus
              }}
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              style={{
                padding: "0 16px",
                borderRadius: 8,
                border: "none",
                background: busy || !draft.trim() ? T.border : T.accent,
                color: "#fff",
                fontSize: 15,
                fontWeight: 600,
                cursor: busy || !draft.trim() ? "default" : "pointer",
              }}
            >
              Send
            </button>
          </form>
        </>
      )}
    </div>
    </>
  );
}

function QuickItem({ q, a }: { q: string; a: string }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${T.borderSoft}` }}>
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "12px 2px",
          background: "transparent",
          border: "none",
          color: T.text,
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
          display: "flex",
          gap: 8,
        }}
      >
        <span aria-hidden style={{ color: T.accent }}>{show ? "−" : "+"}</span>
        {q}
      </button>
      {show && (
        <p style={{ color: T.dim, fontSize: 14, lineHeight: 1.5, margin: "0 0 12px 18px" }}>{a}</p>
      )}
    </div>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const mine = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", margin: "6px 0" }}>
      <div
        style={{
          maxWidth: "82%",
          padding: "9px 12px",
          borderRadius: 12,
          background: mine ? T.accentSoft : T.panel,
          border: `1px solid ${mine ? T.accent : T.border}`,
          color: T.text,
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {content}
      </div>
    </div>
  );
}
