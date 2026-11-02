"use client";

// the first draft lacked: the developer logs each offline (Rail B) payment; the BUYER (or their AGENT acting
// as proxy) then SEES what was recorded against them and CONFIRMS or DISPUTES it → a two-party attested fact.
// The SAME component serves BOTH actors (one build, two mounts):
// • mode "buyer" — mounted on /buyer (the direct buyer acting in person). Loads the buyer's OWN payments
// across all their deals via GET /api/payments?buyer=. `as` = "buyer".
// • mode "agent" — mounted in the /agent deal detail (the buyer's agent/agency as proxy: "the agent must do
// all things for a customer they handle"). Loads ONE deal's payments via GET ?agent=&requestId=.
// `as` = "agent_for_buyer". The route authorises the agent via lib/participant off the offer.
// What the actor can do per offline payment:
// • CONFIRM — "yes, that's what I paid" → a confirmed two-party fact (counts toward the agency unlock).
// • DISPUTE (+ reason) — "that's not right" → flags to the DEAL CHAT for the parties to resolve.
// • ATTACH their OWN slip (buyer-side evidence) — their proof of funds SENT (the developer attaches the
// received-funds slip; both sides' slips live on the one record). Does NOT touch the developer's seal.
// • SHARE-TO-AGENT (buyer mode only) — keep their agent in the loop on this payment even after signing.
// PRIVACY / VOCAB: the buyer sees ONLY their OWN payments — never the agency's commission or VRX's
// cut (those stay B2B). Plain words: "Payment the developer recorded", "Confirm", "Dispute". No contract-speak,
// no hashes, no amounts of anyone else's money. Slips stay private to the developer + buyer (+ the agent while
// brokering, per the stage rule enforced server-side in /api/payments/evidence).

import { useCallback, useEffect, useRef, useState } from "react";
import { useMoneyFull } from "@/lib/currency";
import { card, submitBtn } from "@/lib/ui";
import { T } from "@/lib/theme";

type PaymentMethod = "cash" | "bank_slip" | "qr_slip" | "other";
type PaymentRail = "in_app" | "offline";
type BuyerConfirm = "pending" | "confirmed" | "disputed";
type EvidenceSide = "developer" | "buyer";

type PublicPayment = {
  id: string;
  developer: string;
  buildingId: string;
  unitId: string;
  requestId?: string;
  amountUsd: number;
  paidAt: number;
  method: PaymentMethod;
  rail: PaymentRail;
  note?: string;
  buyerConfirm?: BuyerConfirm;
  disputeNote?: string;
  buyerShareToAgent?: { at: number };
  flag?: { kind: "bad_evidence" | "bad_actor"; by: string; reason?: string; at: number };
  verified: boolean;
  evidence: { id: string; side: EvidenceSide; uploadedBy: string; at: number; filename: string; mime: string; size: number; contentHash: string }[];
};

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Cash",
  bank_slip: "Bank transfer",
  qr_slip: "QR / mobile",
  other: "Other",
};

function msToDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The buyer-side payments surface. In "buyer" mode `account` is the buyer; in "agent" mode `account` is the
 * agent/agency and `requestId` scopes to one deal. `onDisputed` lets the host (e.g. a deal page) surface a
 * cue that a dispute was raised — the server flags it to the deal chat; this callback is optional UI.
 */
export default function BuyerPaymentPanel({
  mode,
  account,
  requestId,
  heading = "My payments",
}: {
  mode: "buyer" | "agent";
  account: string;
  /** Required in "agent" mode — the deal to scope to. Ignored in "buyer" mode (loads all the buyer's own). */
  requestId?: string;
  heading?: string;
}) {
  const money = useMoneyFull();
  const [payments, setPayments] = useState<PublicPayment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const qs =
        mode === "agent"
          ? `agent=${encodeURIComponent(account)}&requestId=${encodeURIComponent(requestId ?? "")}`
          : `buyer=${encodeURIComponent(account)}`;
      const r = await fetch(`/api/payments?${qs}`);
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not load your payments.");
      else setPayments((j.payments ?? []) as PublicPayment[]);
    } catch {
      setErr("Could not load your payments.");
    }
  }, [mode, account, requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (payments === null && !err) {
    return <div style={{ fontSize: 12.5, color: T.dim }}>Loading your payments…</div>;
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>{heading}</h2>
      <p style={{ fontSize: 13.5, opacity: 0.7, lineHeight: 1.5, margin: "0 0 14px", maxWidth: 640 }}>
        {mode === "agent"
          ? "Payments the developer recorded for your buyer on this deal. Confirm each on their behalf, or dispute it if it doesn't match what was paid."
          : "Payments the developer recorded that you made to them. Confirm each one, or dispute it if it doesn't match — a dispute opens a note to the deal chat so you and the developer can sort it out."}
      </p>

      {err && <div style={{ fontSize: 12.5, color: T.danger, marginBottom: 10 }}>{err}</div>}

      {payments && payments.length === 0 ? (
        <div style={{ ...card, marginTop: 0 }}>
          <p style={{ fontSize: 13, opacity: 0.65, margin: 0 }}>No payments recorded yet.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {payments?.map((p) => (
            <BuyerPaymentRow key={p.id} p={p} mode={mode} account={account} money={money} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function stateBadge(p: PublicPayment): { text: string; color: string } {
  if (p.flag) return { text: "⚑ flagged", color: T.danger };
  if (p.rail === "in_app") return { text: "Paid in-app — self-proving", color: T.vetted };
  if (p.buyerConfirm === "confirmed") return { text: "✓ You confirmed this", color: T.vetted };
  if (p.buyerConfirm === "disputed") return { text: "⚠ You disputed this", color: T.danger };
  return { text: "Awaiting your confirmation", color: T.hold };
}

function BuyerPaymentRow({
  p,
  mode,
  account,
  money,
  onChanged,
}: {
  p: PublicPayment;
  mode: "buyer" | "agent";
  account: string;
  money: (usd: number) => string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [disputeNote, setDisputeNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const badge = stateBadge(p);
  // Rail-A (in-app) is self-proving → nothing to confirm. A flagged record is frozen from buyer action here.
  const actionable = p.rail === "offline" && !p.flag;
  const mySlip = p.evidence.find((e) => e.side === "buyer");

  async function confirmOp(decision: "confirmed" | "disputed", note?: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "confirm", id: p.id, by: account, decision, disputeNote: note }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not update this payment.");
      else {
        setDisputing(false);
        setDisputeNote("");
        onChanged();
      }
    } catch {
      setErr("Could not update this payment.");
    } finally {
      setBusy(false);
    }
  }

  async function shareToAgent(on: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "shareAgent", id: p.id, by: account, on }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not update sharing.");
      else onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function attachSlip(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.set("op", "addEvidence");
      form.set("id", p.id);
      form.set("by", account);
      form.set("side", "buyer");
      form.set("file", file);
      const r = await fetch("/api/payments", { method: "POST", body: form });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not attach your slip.");
      else onChanged();
    } catch {
      setErr("Could not attach your slip.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontSize: 15.5, fontWeight: 700, color: T.text }}>{money(p.amountUsd)}</span>
        <span style={{ fontSize: 12.5, color: T.dim }}>{msToDate(p.paidAt)}</span>
      </div>
      <div style={{ fontSize: 12.5, color: T.dim, marginTop: 3 }}>
        {METHOD_LABEL[p.method]} · <span style={{ color: badge.color }}>{badge.text}</span>
      </div>
      {p.note && <div style={{ fontSize: 12.5, color: T.dim, marginTop: 2, fontStyle: "italic" }}>“{p.note}”</div>}
      {p.disputeNote && <div style={{ fontSize: 12.5, color: T.danger, marginTop: 3 }}>Your dispute note: {p.disputeNote}</div>}

      {/* Evidence links — the buyer may view their own slip + the developer's (both sides, per the auth route). */}
      {p.evidence.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap" }}>
          {p.evidence.map((ev) => (
            <a
              key={ev.id}
              href={`/api/payments/evidence?id=${encodeURIComponent(p.id)}&evidenceId=${encodeURIComponent(ev.id)}&viewer=${encodeURIComponent(account)}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: T.accent, fontSize: 12 }}
            >
              {ev.side === "buyer" ? "Your slip" : "Developer's slip"} ({ev.filename})
            </a>
          ))}
        </div>
      )}

      {err && <div style={{ fontSize: 12, color: T.danger, marginTop: 6 }}>{err}</div>}

      {actionable ? (
        <div style={{ marginTop: 10, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 10 }}>
          {disputing ? (
            <div>
              <div style={{ fontSize: 12, color: T.dim, marginBottom: 4 }}>
                What&apos;s wrong with this entry? Your note goes to the deal chat.
              </div>
              <textarea
                value={disputeNote}
                onChange={(e) => setDisputeNote(e.target.value)}
                rows={2}
                placeholder="e.g. I paid $5,000, not $4,500 — see my slip."
                style={{ width: "100%", background: T.bg2, color: T.text, border: `1px solid ${T.borderSoft}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5, resize: "vertical" }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" disabled={busy} onClick={() => void confirmOp("disputed", disputeNote.trim() || undefined)} style={{ ...submitBtn, margin: 0, background: T.danger, color: "#1a0a0a", border: `1px solid ${T.danger}` }}>
                  {busy ? "…" : "Submit dispute"}
                </button>
                <button type="button" onClick={() => { setDisputing(false); setDisputeNote(""); }} style={{ background: "none", border: `1px solid ${T.border}`, color: T.dim, fontSize: 13, cursor: "pointer", padding: "7px 14px", borderRadius: 8 }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button type="button" disabled={busy} onClick={() => void confirmOp("confirmed")} style={{ ...submitBtn, margin: 0, background: p.buyerConfirm === "confirmed" ? T.panel2 : T.vetted, color: p.buyerConfirm === "confirmed" ? T.faint : "#07140e", border: `1px solid ${p.buyerConfirm === "confirmed" ? T.border : T.vetted}` }}>
                {p.buyerConfirm === "confirmed" ? "Confirmed ✓" : "Confirm"}
              </button>
              <button type="button" disabled={busy} onClick={() => setDisputing(true)} style={{ background: "none", border: `1px solid ${T.border}`, color: p.buyerConfirm === "disputed" ? T.danger : T.dim, fontSize: 13, cursor: "pointer", padding: "7px 14px", borderRadius: 8 }}>
                {p.buyerConfirm === "disputed" ? "Re-dispute" : "Dispute"}
              </button>

              {/* Attach my own slip (buyer-side proof of funds sent). */}
              <label style={{ fontSize: 12.5, color: T.accent, cursor: busy ? "wait" : "pointer" }}>
                {mySlip ? "Replace my slip" : "Attach my slip"}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,application/pdf"
                  style={{ display: "none" }}
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void attachSlip(f);
                  }}
                />
              </label>

              {/* Buyer-only: keep my agent in the loop on this payment (standing share — survives signing). */}
              {mode === "buyer" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void shareToAgent(!p.buyerShareToAgent)}
                  style={{ background: "none", border: "none", color: p.buyerShareToAgent ? T.vetted : T.dim, fontSize: 12, cursor: "pointer", padding: 0, marginLeft: "auto" }}
                  title="Let your agent see this payment's slips, even after the agreement is signed"
                >
                  {p.buyerShareToAgent ? "✓ Shared with my agent" : "Share with my agent"}
                </button>
              )}
            </div>
          )}
        </div>
      ) : p.flag ? (
        <div style={{ fontSize: 12, color: T.danger, marginTop: 8 }}>
          This payment was flagged for review. It can&apos;t be confirmed until it&apos;s resolved — see the deal chat.
        </div>
      ) : null}
    </div>
  );
}
