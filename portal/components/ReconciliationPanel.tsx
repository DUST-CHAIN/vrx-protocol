"use client";

// surface over lib/payment-reconcile (the pure engine) + the /api/payments wiring (-slice).
// THE MODEL ( — VRX facilitates + seals, does NOT adjudicate): the developer logs what they RECEIVED; the
// buyer (or their agent as proxy) INDEPENDENTLY records what they SENT; this panel shows the engine's pairing of
// the two ledgers so any mismatch is a PRECISE, machine-legible fact — "short by $500, 2 days apart" — never a
// free-text argument. VRX STATES the variance; whose number is "true" is the parties' to resolve (a discrepancy
// routes to the deal chat / dispute flow already built in §4b). This panel never moves money or `paidToDate`.
// ONE component, role-scoped by `canLog` (one build, three mounts — the "one spine, N consumers" habit):
// • AGENT (buyer's proxy) + BUYER (in person): canLog = true → the "record a payment I sent" form + the
// comparison. The agent names their client's account (`buyerAccount`); the buyer self-names.
// • DEVELOPER: canLog = false → the comparison only (read-only) — they see what the buyer-side attested
// against their own received records, so they can reconcile their books.
// AUTH posture (demo-layer, matches the rest of /api/payments): the viewer NAMES itself; the route authorises
// via lib/participant off the offer (any deal party may READ a reconciliation; only the buyer-side may log a
// sent record). The signed-request binding rides the deferred F1 signing arc. VOCAB: plain words only —
// "You recorded", "The developer recorded", "Matched", "Short" — no contract-speak, no hashes, no D-refs.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useMoneyFull } from "@/lib/currency";
import { card, submitBtn } from "@/lib/ui";
import { T } from "@/lib/theme";

type PaymentMethod = "cash" | "bank_slip" | "qr_slip" | "other";
type ReconcileKind =
  | "matched"
  | "short"
  | "over"
  | "date_drift"
  | "method_drift"
  | "unpaired_sent"
  | "unpaired_received";

type ReconcileLine = {
  kind: ReconcileKind;
  receivedId?: string;
  sentId?: string;
  receivedUsd?: number;
  sentUsd?: number;
  amountDeltaUsd?: number;
  dateDeltaDays?: number;
  methodDiffers?: boolean;
  copy: string;
};
type ReconcileSummary = {
  lines: ReconcileLine[];
  totalReceivedUsd: number;
  totalSentUsd: number;
  netDeltaUsd: number;
  reconciled: boolean;
  discrepancyCount: number;
  headline: string;
};
type ReconcileResponse = {
  summary: ReconcileSummary;
  // the public records of each side — amount/date/method only, for a per-line detail (salt/evidence stripped).
  received: { id: string; amountUsd: number; paidAt: number; method: PaymentMethod }[];
  sent: { id: string; amountUsd: number; paidAt: number; method: PaymentMethod }[];
};

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Cash",
  bank_slip: "Bank transfer",
  qr_slip: "QR / mobile",
  other: "Other",
};

// Each discrepancy kind gets a colour cue — matched/green, a real gap/amber-or-red, an "awaiting" state/dim.
const KIND_COLOR: Record<ReconcileKind, string> = {
  matched: T.vetted,
  short: T.danger,
  over: T.hold,
  date_drift: T.hold,
  method_drift: T.hold,
  unpaired_sent: T.dim,
  unpaired_received: T.dim,
};

function dateToMs(d: string): number {
  if (!d) return 0;
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return 0;
  return new Date(y, m - 1, day).getTime();
}
function msToDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The reconciliation surface for ONE deal. `viewer` is the acting account (authorised server-side off the
 * offer). `canLog` opens the buyer-side "record a payment I sent" form (buyer/agent mounts); a developer mount
 * passes canLog=false for the read-only comparison. In an AGENT mount, `buyerAccount` names the client the
 * sent record is attributed to (the agent acts as proxy); a self-logging buyer leaves it unset (defaults to
 * the viewer server-side).
 */
export default function ReconciliationPanel({
  requestId,
  viewer,
  canLog,
  buyerAccount,
  heading = "Payment reconciliation",
}: {
  requestId: string;
  viewer: string;
  canLog: boolean;
  /** AGENT mode — the buyer client to attribute a logged sent record to. Unset → the viewer (self-buyer). */
  buyerAccount?: string;
  heading?: string;
}) {
  const money = useMoneyFull();
  const [data, setData] = useState<ReconcileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/payments?reconcile=1&requestId=${encodeURIComponent(requestId)}&viewer=${encodeURIComponent(viewer)}`);
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not load the reconciliation.");
      else setData(j as ReconcileResponse);
    } catch {
      setErr("Could not load the reconciliation.");
    } finally {
      setLoading(false);
    }
  }, [requestId, viewer]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const s = data?.summary;

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...submitBtn, background: "transparent", color: T.text, border: `1px solid ${T.borderSoft}`, padding: "6px 10px" }}
      >
        ⇄ Reconcile payments {open ? "▾" : "▸"}
      </button>

      {open && (
        <div style={{ ...card, marginTop: 8, padding: "12px 14px" }}>
          {loading && <div style={{ fontSize: 12.5, color: T.dim }}>Loading…</div>}
          {err && <div style={{ fontSize: 12.5, color: T.danger }}>{err}</div>}

          {s && (
            <>
              {/* Headline + the two aggregate totals (the trusted received figure vs the buyer-attested sent). */}
              <div style={{ fontSize: 13, fontWeight: 600, color: s.reconciled ? T.vetted : s.lines.length === 0 ? T.dim : T.hold }}>
                {s.reconciled ? "✓ " : ""}
                {s.headline}
              </div>
              <div style={{ fontSize: 12, color: T.dim, marginTop: 4, lineHeight: 1.5 }}>
                Developer recorded <strong style={{ color: T.text }}>{money(s.totalReceivedUsd)}</strong> received;
                the buyer side recorded <strong style={{ color: T.text }}>{money(s.totalSentUsd)}</strong> sent.
                {Math.abs(s.netDeltaUsd) > 1 && (
                  <>
                    {" "}
                    A {s.netDeltaUsd > 0 ? "gap" : "shortfall"} of{" "}
                    <strong style={{ color: s.netDeltaUsd < 0 ? T.danger : T.hold }}>{money(Math.abs(s.netDeltaUsd))}</strong>{" "}
                    between the two ledgers.
                  </>
                )}
              </div>
              <div style={{ fontSize: 11, color: T.dim, marginTop: 4, fontStyle: "italic" }}>
                These are the facts from each side&apos;s records. VRX does not decide which is correct — a
                mismatch is for you and the other party to settle (raise it in the deal chat).
              </div>

              {/* Per-line detail — each pairing or lone record, with its structured delta in plain words. */}
              {s.lines.length > 0 && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  {s.lines.map((line, i) => (
                    <ReconcileLineRow key={`${line.kind}-${line.receivedId ?? ""}-${line.sentId ?? ""}-${i}`} line={line} money={money} />
                  ))}
                </div>
              )}

              {/* The buyer-side "record a payment I sent" form (buyer / agent-proxy mounts only). */}
              {canLog && (
                <LogSentForm
                  requestId={requestId}
                  viewer={viewer}
                  buyerAccount={buyerAccount}
                  money={money}
                  onLogged={load}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ReconcileLineRow({ line, money }: { line: ReconcileLine; money: (usd: number) => string }) {
  const color = KIND_COLOR[line.kind];
  return (
    <div style={{ padding: "8px 10px", border: `1px solid ${T.borderSoft}`, borderRadius: 7, borderLeft: `3px solid ${color}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color, fontWeight: 600 }}>{line.copy}</span>
      </div>
      <div style={{ fontSize: 12, color: T.dim, marginTop: 3 }}>
        {typeof line.receivedUsd === "number" && <>Developer: {money(line.receivedUsd)}</>}
        {typeof line.receivedUsd === "number" && typeof line.sentUsd === "number" && <span> · </span>}
        {typeof line.sentUsd === "number" && <>Buyer side: {money(line.sentUsd)}</>}
        {typeof line.dateDeltaDays === "number" && line.dateDeltaDays > 0 && (
          <> · {line.dateDeltaDays} day{line.dateDeltaDays === 1 ? "" : "s"} apart</>
        )}
      </div>
    </div>
  );
}

// ── the buyer-side "record a payment I sent" form ─────────────────────────────────────────────────────────
function LogSentForm({
  requestId,
  viewer,
  buyerAccount,
  money,
  onLogged,
}: {
  requestId: string;
  viewer: string;
  buyerAccount?: string;
  money: (usd: number) => string;
  onLogged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<PaymentMethod>("bank_slip");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return setErr("Enter a positive amount.");
    const paidAt = dateToMs(date);
    if (!paidAt) return setErr("Enter the date you sent the payment.");

    setBusy(true);
    try {
      const r = await fetch("/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "logSent",
          by: viewer,
          requestId,
          buyer: buyerAccount || undefined, // agent names the client; a self-buyer omits (defaults to `by`)
          amountUsd: amt,
          paidAt,
          method,
          note: note.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j?.error || "Could not record the payment.");
      } else {
        setShowForm(false);
        setAmount("");
        setNote("");
        onLogged(); // reload the reconciliation → the new sent record appears + re-pairs
      }
    } catch {
      setErr("Could not record the payment.");
    } finally {
      setBusy(false);
    }
  }

  if (!showForm) {
    return (
      <div style={{ marginTop: 12, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 12 }}>
        <button type="button" onClick={() => setShowForm(true)} style={softBtn}>
          Record a payment I sent
        </button>
        <div style={{ fontSize: 11, color: T.dim, marginTop: 6, lineHeight: 1.5 }}>
          Log what you sent the developer, independently. It&apos;s compared against the developer&apos;s own
          record so any mismatch shows up clearly. This is your own record — it doesn&apos;t change the
          developer&apos;s books.
        </div>
      </div>
    );
  }

  const inputStyle: CSSProperties = { background: T.bg2, color: T.text, border: `1px solid ${T.borderSoft}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5 };
  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 12 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text, marginBottom: 8 }}>Record a payment you sent</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label style={{ fontSize: 11, color: T.dim }}>
          Amount (USD)
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...inputStyle, width: "100%", marginTop: 2 }} />
        </label>
        <label style={{ fontSize: 11, color: T.dim }}>
          Date sent
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: "100%", marginTop: 2 }} />
        </label>
        <label style={{ fontSize: 11, color: T.dim }}>
          Method
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} style={{ ...inputStyle, width: "100%", marginTop: 2 }}>
            <option value="cash">Cash</option>
            <option value="bank_slip">Bank transfer</option>
            <option value="qr_slip">QR / mobile</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: T.dim }}>
          Note (optional)
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Deposit — my bank ref 4471" style={{ ...inputStyle, width: "100%", marginTop: 2 }} />
        </label>
      </div>
      {err && <div style={{ fontSize: 12, color: T.danger, marginTop: 6 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" disabled={busy} onClick={submit} style={{ ...submitBtn, margin: 0, opacity: busy ? 0.5 : 1 }}>
          {busy ? "Recording…" : "Record this payment"}
        </button>
        <button type="button" disabled={busy} onClick={() => { setShowForm(false); setErr(null); }} style={softBtn}>
          Cancel
        </button>
      </div>
      <div style={{ fontSize: 11, color: T.dim, marginTop: 6 }}>
        {amount && Number(amount) > 0 ? `You're recording ${money(Number(amount))} sent. ` : ""}
        You can attach your own slip after recording it, from the payment the developer logs for it.
      </div>
    </div>
  );
}

const softBtn: CSSProperties = {
  fontSize: 12.5, padding: "6px 12px", borderRadius: 7, border: `1px solid ${T.borderSoft}`, background: "#18202f", color: T.text, cursor: "pointer",
};
