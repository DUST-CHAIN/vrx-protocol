"use client";

// EscalateControl (F-slice) — "Refer to VRX", used by BOTH the desk (DirectEnquiries) and the buyer
// (buyer DeskChat). SYMMETRIC: either party may flag the conversation for VRX review. Unlike call-off (D) and
// block (E), this keeps the deal LIVE — VRX comes in to mediate and replies in the thread. Thin by design:
// flag → a `vrx` ack appears in the chat → VRX later posts a resolution. The component shows a quiet link when
// nothing's pending and a "referred to VRX — under review" note while open. VRX sees the negotiation record,
// not the buyer's PII (the moat is unchanged by escalation — server-side).

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";

type Escalation = { status: "open" | "resolved" | null; by?: "buyer" | "developer"; at?: number; reason?: string };

export default function EscalateControl({
  account,
  conversationId,
  onChanged,
}: {
  account: string;
  conversationId: string;
  onChanged?: () => void | Promise<void>;
}) {
  const [esc, setEsc] = useState<Escalation | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      const j = await fetch(
        `/api/conversations-direct/escalate?account=${encodeURIComponent(account)}&conversationId=${encodeURIComponent(conversationId)}`
      ).then((r) => r.json());
      if (j.escalation) setEsc(j.escalation);
    } catch {
      /* transient */
    }
  }, [account, conversationId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20000);
    return () => clearInterval(t);
  }, [load]);

  async function raise() {
    setBusy(true);
    try {
      await fetch("/api/conversations-direct/escalate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, conversationId, reason: reason.trim() || undefined }),
      });
      setConfirm(false);
      setReason("");
      await load();
      await onChanged?.();
    } catch {
      /* leave state; retry */
    } finally {
      setBusy(false);
    }
  }

  const linkBtn = {
    background: "none",
    border: "none",
    color: T.faint,
    fontSize: 11.5,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
  } as const;

  // Open — show the under-review note (either party sees it once raised).
  if (esc?.status === "open") {
    return (
      <div style={{ marginTop: 6, fontSize: 11.5, color: T.accent }}>
        ⚑ Referred to VRX — under review. The deal stays open; VRX will reply here.
      </div>
    );
  }

  // Not open (never, or resolved) — offer a quiet "refer to VRX" link with an optional reason.
  return (
    <div style={{ marginTop: 6 }}>
      {confirm ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 420 }}>
          <span style={{ fontSize: 11.5, opacity: 0.8 }}>Refer this conversation to VRX to review? (optional note)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What's the concern? (optional)"
            style={{ fontSize: 12, padding: "5px 9px", borderRadius: 7, border: `1px solid ${T.border}`, background: T.bg2, color: T.text }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => void raise()} disabled={busy} style={{ background: "none", border: `1px solid ${T.border}`, color: T.text, fontSize: 11.5, cursor: "pointer", padding: "4px 10px", borderRadius: 7 }}>
              {busy ? "…" : "Refer to VRX"}
            </button>
            <button onClick={() => setConfirm(false)} style={linkBtn}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setConfirm(true)} style={linkBtn}>
          {esc?.status === "resolved" ? "Refer to VRX again" : "Refer to VRX"}
        </button>
      )}
    </div>
  );
}
