"use client";

// CallOffControl (D-slice) — the bilateral "polite goodbye", used by BOTH the desk (DirectEnquiries) and
// the buyer (buyer DeskChat). A call-off is a HANDSHAKE: one party PROPOSES, the OTHER AGREES (→ the deal resets,
// no prejudice) or the proposer WITHDRAWS. Pending-until-agreed, no timeout (Q1). The component shows the
// right affordance from the viewer's `role` vs who proposed:
//   • nothing pending → a quiet "Close this deal" link (either party may propose).
//   • I proposed      → a "pending — Withdraw" note.
//   • they proposed   → "The other side proposed closing — Agree to close / keep going".
// On a completed agree the server resets consent + the buyer's dial and posts a horizontal-rule marker into the
// thread; this component just drives the ceremony and reflects state (the close itself is visible in the chat).
// Masking/consent reset is server-side — no client authority here.

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";

type Role = "buyer" | "developer";
type CallOff = {
  proposal?: { by: Role; byAccount: string; at: number };
  epoch?: number;
  closedAt?: number;
};

export default function CallOffControl({
  account,
  conversationId,
  role,
  onChanged,
}: {
  account: string;
  conversationId: string;
  role: Role;
  /** Called after any successful step so the parent can reload the thread (the marker is a new message). */
  onChanged?: () => void | Promise<void>;
}) {
  const [callOff, setCallOff] = useState<CallOff | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPropose, setConfirmPropose] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await fetch(
        `/api/conversations-direct/call-off?account=${encodeURIComponent(account)}&conversationId=${encodeURIComponent(conversationId)}`
      ).then((r) => r.json());
      if (j.callOff) setCallOff(j.callOff);
    } catch {
      /* transient */
    }
  }, [account, conversationId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  async function act(action: "request" | "withdraw" | "agree") {
    setBusy(true);
    try {
      await fetch("/api/conversations-direct/call-off", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, conversationId, action }),
      });
      setConfirmPropose(false);
      await load();
      await onChanged?.();
    } catch {
      /* leave state; user can retry */
    } finally {
      setBusy(false);
    }
  }

  const proposal = callOff?.proposal;
  const iProposed = proposal?.byAccount === account.toLowerCase();
  const linkBtn = {
    background: "none",
    border: "none",
    color: T.dim,
    fontSize: 11.5,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
  } as const;

  // Pending — the OTHER party proposed: offer Agree / keep going.
  if (proposal && !iProposed) {
    return (
      <div style={{ marginTop: 8, fontSize: 11.5, border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", background: T.bg2 }}>
        <span style={{ opacity: 0.8 }}>The other side proposed closing this deal — no hard feelings.</span>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button onClick={() => void act("agree")} disabled={busy} style={{ background: "none", border: `1px solid ${T.border}`, color: T.text, fontSize: 11.5, cursor: "pointer", padding: "4px 10px", borderRadius: 7 }}>
            {busy ? "…" : "Agree to close"}
          </button>
          <span style={{ fontSize: 10.5, opacity: 0.55, alignSelf: "center" }}>or just keep the conversation going</span>
        </div>
      </div>
    );
  }

  // Pending — I proposed: show it's awaiting them, with a Withdraw.
  if (proposal && iProposed) {
    return (
      <div style={{ marginTop: 8, fontSize: 11.5, opacity: 0.75, display: "flex", gap: 10, alignItems: "center" }}>
        <span>Call-off proposed — waiting for the other side.</span>
        <button onClick={() => void act("withdraw")} disabled={busy} style={linkBtn}>{busy ? "…" : "Withdraw"}</button>
      </div>
    );
  }

  // Nothing pending — a quiet propose link (with a one-tap confirm so it isn't fired by accident).
  return (
    <div style={{ marginTop: 8 }}>
      {confirmPropose ? (
        <span style={{ fontSize: 11.5, display: "inline-flex", gap: 8, alignItems: "center" }}>
          <span style={{ opacity: 0.75 }}>Close this deal, no hard feelings?</span>
          <button onClick={() => void act("request")} disabled={busy} style={{ background: "none", border: `1px solid ${T.border}`, color: T.text, fontSize: 11.5, cursor: "pointer", padding: "3px 9px", borderRadius: 7 }}>
            {busy ? "…" : "Yes, propose"}
          </button>
          <button onClick={() => setConfirmPropose(false)} style={linkBtn}>Cancel</button>
        </span>
      ) : (
        <button onClick={() => setConfirmPropose(true)} style={linkBtn}>Close this deal (no prejudice)</button>
      )}
    </div>
  );
}
