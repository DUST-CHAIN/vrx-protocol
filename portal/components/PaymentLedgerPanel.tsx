"use client";

// in the node deal detail next to the contract-stage controls. It is the developer's view of the
// • LOG a payment the customer made (amount / date / method / rail + optional encrypted evidence slip).
// • SEE every logged payment, each ✓ Vetted (re-hashed seal) with its buyer-confirm state + evidence link.
// • VARIANCE — schedule-vs-actual from the sealed S&P plan (server-computed, computeLedgerStatus): paid of
// scheduled, next due, on-track / behind / over, late-by-N flag.
// • PAYABLE — "commission now payable: $X" when the agency unlock gate opened (signed + paid ≥ threshold).
// ONE server read (api/payments?ledger=1&developer=&requestId=) returns payments + the variance + the unlock
// verdict, so every number here comes from one authoritative server source (never recomputed on the client).
// Writes go to /api/payments (multipart log, DELETE). The slip bytes are fetched from /api/payments/evidence
// (authorizing route). VOCAB: plain words — "Payment received", "Deposit 2 of 4 in", "Commission
// payable" — no contract-speak, no hashes, no D-refs. PRIVACY: amounts/slips are B2B PII, off-chain.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useMoneyFull } from "@/lib/currency";
import { card, submitBtn } from "@/lib/ui";
import { T } from "@/lib/theme";

type PaymentMethod = "cash" | "bank_slip" | "qr_slip" | "other";
type PaymentRail = "in_app" | "offline";
type BuyerConfirm = "pending" | "confirmed" | "disputed";
type PayableReason = "payable" | "awaiting_signing" | "awaiting_payment" | "awaiting_both";
type PaymentVariance = "on_track" | "under" | "over" | "ahead" | "behind";

type PublicPayment = {
  id: string;
  amountUsd: number;
  paidAt: number;
  method: PaymentMethod;
  rail: PaymentRail;
  note?: string;
  buyerConfirm?: BuyerConfirm;
  disputeNote?: string;
  flag?: { kind: "bad_evidence" | "bad_actor"; by: string; reason?: string; at: number };
  verified: boolean;
  evidence: { id: string; side: "developer" | "buyer"; uploadedBy: string; at: number; filename: string; mime: string; size: number; contentHash: string }[];
};
type ExpectedLine = { label: string; dueUsd: number; dueAt?: number };
type LedgerStatus = {
  priceUsd: number;
  paidToDateUsd: number;
  expectedToDateUsd: number;
  scheduledTotalUsd: number;
  variance: PaymentVariance;
  nextDue?: ExpectedLine;
  lateByDays?: number;
  pctOfPrice: number;
  schedule: ExpectedLine[];
};
type PayableStatus = {
  payable: boolean;
  reason: PayableReason;
  unlockPct: number;
  thresholdUsd: number;
  paidToDateUsd: number;
};
type TerminationState =
  | "none"
  | "buyer_default_served"
  | "seller_default_served"
  | "cured"
  | "terminated_retained"
  | "terminated_refunded";
// slice 3 — the advisory buyer-default flag. ADVISORY ONLY: a prompt that the developer MAY serve a
// default notice; never a verdict, never an auto-serve. `eligible` is already suppressed server-side once any
// default/termination process is underway (terminationState past "none").
type DefaultAdvisory = {
  eligible: boolean;
  reason: "overdue" | "under_threshold";
  thresholdPct: number;
  terminationState: TerminationState;
};
// slice 5 — the retain/refund settlement figures, present once the deal is TERMINAL (null otherwise).
// Interest is advisory (buyer-default only); it is NOT folded into retained — the developer may claim it.
type TerminationInterest = { ratePctPerAnnum: number; amountUsd: number; claimable: boolean };
type TerminationSettlement = {
  outcome: "terminated_retained" | "terminated_refunded";
  retainedUsd: number;
  refundedUsd: number;
  interest: TerminationInterest | null;
  paidToDateUsd: number;
};
// The running cure-window end + the per-deal clause cure-floor (days) the serve form defaults to.
type TerminationOverlayLite = { state: TerminationState; cureEndsAt?: number; updatedAt: number };
type LedgerResponse = {
  payments: PublicPayment[];
  ledger: LedgerStatus;
  payable: PayableStatus | null;
  defaultAdvisory?: DefaultAdvisory;
  settlement?: TerminationSettlement | null;
  overlay?: TerminationOverlayLite;
  cureDays?: number;
};

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Cash",
  bank_slip: "Bank transfer",
  qr_slip: "QR / mobile",
  other: "Other",
};
const VARIANCE_COPY: Record<PaymentVariance, string> = {
  on_track: "On track — payments match the plan.",
  under: "Under — less has been paid than the plan calls for.",
  over: "Overpaid — more has been received than the plan total.",
  ahead: "Ahead — paid more than is due so far.",
  behind: "Behind — a payment is overdue against the plan.",
};
const VARIANCE_COLOR: Record<PaymentVariance, string> = {
  on_track: T.vetted,
  ahead: T.vetted,
  over: T.hold,
  under: T.dim,
  behind: T.danger,
};
const PAYABLE_COPY: Record<PayableReason, string> = {
  payable: "Payable now — signed, and enough of the customer's payment is in.",
  awaiting_signing: "Awaiting the signed sale & purchase agreement.",
  awaiting_payment: "Awaiting enough of the customer's payment to unlock.",
  awaiting_both: "Awaiting the signed agreement and the customer's payment.",
};

// local midnight → ms epoch (the <input type=date> gives YYYY-MM-DD; we store the moment the payment landed)
function dateToMs(d: string): number {
  if (!d) return 0;
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return 0;
  return new Date(y, m - 1, day).getTime();
}
function msToDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function PaymentLedgerPanel({
  requestId,
  developer,
  buildingId,
  unitId,
  buyer,
}: {
  requestId: string;
  developer: string;
  buildingId?: string;
  unitId?: string;
  buyer?: string;
}) {
  const money = useMoneyFull();
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/payments?ledger=1&developer=${encodeURIComponent(developer)}&requestId=${encodeURIComponent(requestId)}`);
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not load the payment ledger.");
      else setData(j as LedgerResponse);
    } catch {
      setErr("Could not load the payment ledger.");
    } finally {
      setLoading(false);
    }
  }, [developer, requestId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...submitBtn, background: "transparent", color: T.text, border: `1px solid ${T.borderSoft}`, padding: "6px 10px" }}
      >
        💰 Payments {open ? "▾" : "▸"}
      </button>

      {open && (
        <div style={{ ...card, marginTop: 8, padding: "12px 14px" }}>
          {loading && <div style={{ fontSize: 12.5, color: T.dim }}>Loading…</div>}
          {err && <div style={{ fontSize: 12.5, color: T.danger }}>{err}</div>}

          {data && (
            <>
              <VariancePanel ledger={data.ledger} payable={data.payable} advisory={data.defaultAdvisory} money={money} />
              <TerminationControls
                requestId={requestId}
                developer={developer}
                advisory={data.defaultAdvisory}
                settlement={data.settlement ?? null}
                overlay={data.overlay}
                cureDays={data.cureDays ?? 30}
                money={money}
                onChanged={load}
              />
              <PaymentList payments={data.payments} developer={developer} onChanged={load} money={money} />
              <AddPaymentForm
                developer={developer}
                buildingId={buildingId}
                unitId={unitId}
                requestId={requestId}
                buyer={buyer}
                onAdded={load}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Plain-words readout of where a default/termination process stands on this deal, once it has begun.
// Shown INSTEAD of the eligibility prompt — no contract-speak, no clause numbers, no hashes.
const TERMINATION_STATE_COPY: Partial<Record<TerminationState, string>> = {
  buyer_default_served: "A default notice has been served. The cure period is running.",
  seller_default_served: "A seller default notice has been served. The cure period is running.",
  cured: "The default was rectified within the cure period — the deal continues.",
  terminated_retained: "This deal was terminated after an uncured default; payments were retained.",
  terminated_refunded: "This deal was terminated on a seller default; payments were refunded.",
};

// ── variance + payable readout ──────────────────────────────────────────────────────────────────────────
function VariancePanel({
  ledger,
  payable,
  advisory,
  money,
}: {
  ledger: LedgerStatus;
  payable: PayableStatus | null;
  advisory?: DefaultAdvisory;
  money: (usd: number) => string;
}) {
  const hasSchedule = ledger.scheduledTotalUsd > 0;
  return (
    <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${T.borderSoft}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
        {money(ledger.paidToDateUsd)} received
        {ledger.priceUsd > 0 && <span style={{ color: T.dim, fontWeight: 400 }}> of {money(ledger.priceUsd)} price</span>}
        {ledger.priceUsd > 0 && (
          <span style={{ color: T.dim, fontWeight: 400 }}> ({Math.round(ledger.pctOfPrice * 100)}%)</span>
        )}
      </div>

      {hasSchedule ? (
        <div style={{ fontSize: 12, color: VARIANCE_COLOR[ledger.variance], marginTop: 4 }}>{VARIANCE_COPY[ledger.variance]}</div>
      ) : (
        <div style={{ fontSize: 12, color: T.dim, marginTop: 4 }}>No structured payment plan — amount tracked against the sale price.</div>
      )}

      {typeof ledger.lateByDays === "number" && ledger.lateByDays > 0 && (
        <div style={{ fontSize: 12, color: T.danger, marginTop: 3 }}>⚠ Overdue by {ledger.lateByDays} day{ledger.lateByDays === 1 ? "" : "s"} against the plan.</div>
      )}

      {/*  slice 3 — advisory default flag / in-progress state. If a process has begun, show WHERE it stands;
          otherwise, if eligible, prompt (advisory — the developer decides and serves explicitly elsewhere). */}
      {advisory && advisory.terminationState !== "none" ? (
        <div style={{ fontSize: 12, color: T.hold, marginTop: 6 }}>{TERMINATION_STATE_COPY[advisory.terminationState]}</div>
      ) : advisory?.eligible ? (
        <div style={{ fontSize: 12, color: T.hold, marginTop: 6, lineHeight: 1.5 }}>
          ⚠ This deal <strong>may be eligible</strong> for a default notice
          {advisory.reason === "overdue"
            ? " — a payment is overdue against the plan."
            : ` — less than ${advisory.thresholdPct}% of the price has been paid.`}
          <div style={{ color: T.dim, marginTop: 2 }}>
            Advisory only. Serving a notice is your decision and a deliberate step — nothing happens automatically.
          </div>
        </div>
      ) : null}

      {ledger.nextDue && (
        <div style={{ fontSize: 12, color: T.dim, marginTop: 3 }}>
          Next due: {ledger.nextDue.label} — {money(ledger.nextDue.dueUsd)}
          {ledger.nextDue.dueAt ? ` by ${msToDate(ledger.nextDue.dueAt)}` : ""}
        </div>
      )}

      {payable && (
        <div style={{ fontSize: 12.5, marginTop: 8, color: payable.payable ? T.vetted : T.dim }}>
          {payable.payable ? "✓ " : ""}
          Agency commission {payable.payable ? "payable now" : "not yet payable"}.{" "}
          <span style={{ color: T.dim }}>{PAYABLE_COPY[payable.reason]}</span>
          {payable.thresholdUsd > 0 && (
            <span style={{ color: T.dim }}> (unlock at {money(payable.thresholdUsd)}; {money(payable.paidToDateUsd)} confirmed in)</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── termination controls ( slice 6) ────────────────────────────────────────────────────────────────
// The DEVELOPER's do-it surface for the default/termination process. State-aware: it shows exactly the
// one lawful action for where the deal stands — SERVE a notice (when advisory-eligible, home state), RECORD a
// cure or TERMINATE (once a notice is served, with a live cure-clock countdown), or nothing (terminal). Every
// action posts to /api/termination; the server re-validates lawfulness and seals the step (the UI is a
// convenience, never the authority). plain words throughout — no clause numbers, no hashes, no verbs.
// The TERMINATE action is the most destructive in the product, so it is guarded in the UI too: a TWO-STEP
// confirm that shows the exact money outcome first (retain $X / refund $Y, + the advisory interest the Seller
// (the server enforces this regardless; the UI hides the button until then so it never dangles un-clickable).
const DAY_MS = 86_400_000;
function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.ceil((to - from) / DAY_MS));
}

function TerminationControls({
  requestId,
  developer,
  advisory,
  settlement,
  overlay,
  cureDays,
  money,
  onChanged,
}: {
  requestId: string;
  developer: string;
  advisory?: DefaultAdvisory;
  settlement: TerminationSettlement | null;
  overlay?: TerminationOverlayLite;
  cureDays: number;
  money: (usd: number) => string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Which flow is open: serving a notice, or the two-step terminate confirm. null = just the state readout.
  const [mode, setMode] = useState<null | "serve_buyer" | "serve_seller" | "confirm_terminate">(null);
  const [note, setNote] = useState("");
  const [windowDays, setWindowDays] = useState(cureDays);

  const state = overlay?.state ?? advisory?.terminationState ?? "none";
  const now = Date.now();
  const cureEndsAt = overlay?.cureEndsAt;
  const cureElapsed = typeof cureEndsAt === "number" ? now >= cureEndsAt : false;

  async function post(step: string, extra?: { note?: string; cureWindowMs?: number }) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/termination", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, by: developer, step, note: extra?.note, cureWindowMs: extra?.cureWindowMs }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j?.error || "That step could not be taken.");
      } else {
        setMode(null);
        setNote("");
        onChanged(); // reload the ledger → new state + settlement
      }
    } catch {
      setErr("That step could not be taken.");
    } finally {
      setBusy(false);
    }
  }

  // Terminal — show the settled outcome, no actions.
  if (state === "terminated_retained" || state === "terminated_refunded") {
    return (
      <div style={termWrap}>
        <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
          {state === "terminated_retained" ? "Deal terminated — payments retained" : "Deal terminated — payments refunded"}
        </div>
        {settlement && (
          <div style={{ fontSize: 12, color: T.dim, marginTop: 4, lineHeight: 1.5 }}>
            {settlement.outcome === "terminated_retained" ? (
              <>
                {money(settlement.retainedUsd)} retained.
                {settlement.interest && settlement.interest.claimable && (
                  <> Interest of {money(settlement.interest.amountUsd)} ({settlement.interest.ratePctPerAnnum}% per annum) may additionally be claimed on the overdue amounts.</>
                )}
              </>
            ) : (
              <>{money(settlement.refundedUsd)} refunded to the buyer.</>
            )}
          </div>
        )}
      </div>
    );
  }

  // Cured — a brief resolved note (the deal resumed; VariancePanel also says so).
  if (state === "cured") {
    return (
      <div style={termWrap}>
        <div style={{ fontSize: 12.5, color: T.vetted }}>The default was rectified within the cure period — the deal continues.</div>
      </div>
    );
  }

  // A notice is in progress (buyer or seller default served) — show the cure clock + cure/terminate actions.
  if (state === "buyer_default_served" || state === "seller_default_served") {
    const isBuyer = state === "buyer_default_served";
    const terminateStep = isBuyer ? "terminate_buyer_default" : "terminate_seller_default";
    return (
      <div style={termWrap}>
        <div style={{ fontSize: 12.5, color: T.hold, fontWeight: 600 }}>
          {isBuyer ? "A buyer default notice has been served." : "A seller default notice has been served."}
        </div>
        <div style={{ fontSize: 12, color: T.dim, marginTop: 3 }}>
          {typeof cureEndsAt === "number" &&
            (cureElapsed
              ? "The cure period has elapsed. If the default is not rectified, you may now terminate."
              : `Cure period running — ${daysBetween(now, cureEndsAt)} day${daysBetween(now, cureEndsAt) === 1 ? "" : "s"} left (until ${msToDate(cureEndsAt)}).`)}
        </div>

        {err && <div style={{ fontSize: 12, color: T.danger, marginTop: 6 }}>{err}</div>}

        {mode !== "confirm_terminate" ? (
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button type="button" disabled={busy} onClick={() => post("record_cure", { note: note || undefined })} style={softBtn}>
              Record that it was rectified
            </button>
            {cureElapsed && (
              <button type="button" disabled={busy} onClick={() => setMode("confirm_terminate")} style={dangerBtn}>
                Terminate the deal…
              </button>
            )}
          </div>
        ) : (
          // TWO-STEP terminate confirm — show the money outcome first.
          <div style={{ marginTop: 10, padding: "10px 12px", border: `1px solid ${T.danger}`, borderRadius: 8, background: "#241012" }}>
            <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>Confirm termination</div>
            <div style={{ fontSize: 12, color: T.dim, marginTop: 4, lineHeight: 1.5 }}>
              {settlement ? (
                settlement.outcome === "terminated_retained" || isBuyer ? (
                  <>
                    On termination, {money(settlement?.retainedUsd ?? 0)} already paid is <strong>retained</strong>.
                    {settlement?.interest && settlement.interest.claimable && (
                      <> Interest of {money(settlement.interest.amountUsd)} ({settlement.interest.ratePctPerAnnum}% per annum) may additionally be claimed on the overdue amounts.</>
                    )}
                  </>
                ) : (
                  <>On termination, {money(settlement?.refundedUsd ?? 0)} paid is <strong>refunded</strong> to the buyer.</>
                )
              ) : (
                <>On termination, the payments made are settled per the agreement.</>
              )}
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Reason for termination (recorded on the sealed step)…"
              style={{ ...noteInput, marginTop: 8 }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" disabled={busy} onClick={() => post(terminateStep, { note: note || undefined })} style={dangerBtn}>
                {busy ? "Terminating…" : "Terminate — this cannot be undone"}
              </button>
              <button type="button" disabled={busy} onClick={() => { setMode(null); setErr(null); }} style={softBtn}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Home state (none). Offer SERVE only when the advisory says a default may be eligible. (The seller-default
  const canServeBuyer = advisory?.eligible === true;
  return (
    <div style={termWrap}>
      {err && <div style={{ fontSize: 12, color: T.danger, marginBottom: 6 }}>{err}</div>}
      {mode === null ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canServeBuyer && (
            <button type="button" disabled={busy} onClick={() => { setMode("serve_buyer"); setWindowDays(cureDays); }} style={softBtn}>
              Serve a default notice…
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => { setMode("serve_seller"); setWindowDays(cureDays); }} style={softBtn}>
            Serve a seller default notice…
          </button>
        </div>
      ) : (
        // Serve form — cure-window days (defaults to the clause floor) + reason note.
        <div style={{ padding: "10px 12px", border: `1px solid ${T.borderSoft}`, borderRadius: 8 }}>
          <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
            {mode === "serve_buyer" ? "Serve a buyer default notice" : "Serve a seller default notice"}
          </div>
          <div style={{ fontSize: 12, color: T.dim, marginTop: 4, lineHeight: 1.5 }}>
            The other party has a period to rectify the default. The agreement sets a minimum of {cureDays} days.
          </div>
          <label style={{ display: "block", fontSize: 12, color: T.dim, marginTop: 8 }}>
            Cure period (days)
            <input
              type="number"
              min={cureDays}
              value={windowDays}
              onChange={(e) => setWindowDays(Math.max(cureDays, Number(e.target.value) || cureDays))}
              style={{ ...noteInput, width: 90, marginTop: 3 }}
            />
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Reason for the notice (recorded on the sealed step)…"
            style={{ ...noteInput, marginTop: 8 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                post(mode === "serve_buyer" ? "serve_buyer_default" : "serve_seller_default", {
                  note: note || undefined,
                  cureWindowMs: Math.max(cureDays, windowDays) * DAY_MS,
                })
              }
              style={submitBtn}
            >
              {busy ? "Serving…" : "Serve the notice"}
            </button>
            <button type="button" disabled={busy} onClick={() => { setMode(null); setErr(null); }} style={softBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const termWrap: CSSProperties = { marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${T.borderSoft}` };
const noteInput: CSSProperties = {
  display: "block", width: "100%", boxSizing: "border-box", background: "#10161f",
  border: `1px solid ${T.borderSoft}`, borderRadius: 6, color: T.text, padding: "6px 8px", fontSize: 12.5, fontFamily: "inherit", resize: "vertical",
};
const softBtn: CSSProperties = {
  fontSize: 12.5, padding: "6px 12px", borderRadius: 7, border: `1px solid ${T.borderSoft}`, background: "#18202f", color: T.text, cursor: "pointer",
};
const dangerBtn: CSSProperties = {
  fontSize: 12.5, padding: "6px 12px", borderRadius: 7, border: "1px solid #7a2b2b", background: "#3a1416", color: "#ffb4b4", cursor: "pointer", fontWeight: 600,
};

// ── the logged payments list ────────────────────────────────────────────────────────────────────────────
function PaymentList({
  payments,
  developer,
  onChanged,
  money,
}: {
  payments: PublicPayment[];
  developer: string;
  onChanged: () => void;
  money: (usd: number) => string;
}) {
  if (payments.length === 0) {
    return <div style={{ fontSize: 12.5, color: T.dim, marginBottom: 10 }}>No payments logged yet.</div>;
  }
  return (
    <div style={{ marginBottom: 12 }}>
      {payments.map((p) => (
        <PaymentRow key={p.id} p={p} developer={developer} onChanged={onChanged} money={money} />
      ))}
    </div>
  );
}

function confirmBadge(p: PublicPayment): { text: string; color: string } {
  if (p.flag) return { text: p.flag.kind === "bad_actor" ? "⚑ flagged" : "⚑ evidence flagged", color: T.danger };
  if (p.rail === "in_app") return { text: "self-proving", color: T.vetted };
  if (p.buyerConfirm === "confirmed") return { text: "✓ buyer confirmed", color: T.vetted };
  if (p.buyerConfirm === "disputed") return { text: "⚠ disputed", color: T.danger };
  return { text: "awaiting buyer confirm", color: T.dim };
}

function PaymentRow({
  p,
  developer,
  onChanged,
  money,
}: {
  p: PublicPayment;
  developer: string;
  onChanged: () => void;
  money: (usd: number) => string;
}) {
  const [busy, setBusy] = useState(false);
  const badge = confirmBadge(p);

  async function remove() {
    if (!window.confirm("Remove this logged payment? This also deletes its evidence slip.")) return;
    setBusy(true);
    try {
      await fetch(`/api/payments?developer=${encodeURIComponent(developer)}&id=${encodeURIComponent(p.id)}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "8px 0", borderBottom: `1px solid ${T.borderSoft}`, fontSize: 12.5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: T.text, fontWeight: 600 }}>{money(p.amountUsd)}</span>
        <span style={{ color: T.dim }}>{msToDate(p.paidAt)}</span>
      </div>
      <div style={{ color: T.dim, marginTop: 2 }}>
        {METHOD_LABEL[p.method]} · {p.rail === "in_app" ? "in-app" : "offline"} ·{" "}
        <span style={{ color: badge.color }}>{badge.text}</span>
        {!p.verified && <span style={{ color: T.danger }}> · ⚠ seal mismatch</span>}
      </div>
      {p.note && <div style={{ color: T.dim, marginTop: 2, fontStyle: "italic" }}>{p.note}</div>}
      {p.disputeNote && <div style={{ color: T.danger, marginTop: 2 }}>Dispute: {p.disputeNote}</div>}
      {p.flag?.reason && <div style={{ color: T.danger, marginTop: 2 }}>Flag: {p.flag.reason}</div>}
      <div style={{ marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
        {p.evidence.map((ev) => (
          <a
            key={ev.id}
            href={`/api/payments/evidence?id=${encodeURIComponent(p.id)}&evidenceId=${encodeURIComponent(ev.id)}&viewer=${encodeURIComponent(developer)}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: T.accent, fontSize: 12 }}
          >
            {ev.side === "buyer" ? "Buyer's slip" : "Your slip"} ({ev.filename})
          </a>
        ))}
        <button type="button" disabled={busy} onClick={remove} style={{ background: "none", border: "none", color: T.dim, cursor: "pointer", fontSize: 12, padding: 0 }}>
          Remove
        </button>
      </div>
    </div>
  );
}

// ── the add-payment form ────────────────────────────────────────────────────────────────────────────────
function AddPaymentForm({
  developer,
  buildingId,
  unitId,
  requestId,
  buyer,
  onAdded,
}: {
  developer: string;
  buildingId?: string;
  unitId?: string;
  requestId: string;
  buyer?: string;
  onAdded: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<PaymentMethod>("bank_slip");
  const [rail, setRail] = useState<PaymentRail>("offline");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return setErr("Enter a positive amount.");
    const paidAt = dateToMs(date);
    if (!paidAt) return setErr("Enter the date the payment was received.");
    if (!buildingId || !unitId) return setErr("This deal is missing its unit reference.");

    setBusy(true);
    try {
      const form = new FormData();
      form.set("developer", developer);
      form.set("buildingId", buildingId);
      form.set("unitId", unitId);
      form.set("requestId", requestId);
      if (buyer) form.set("buyer", buyer);
      form.set("amountUsd", String(amt));
      form.set("paidAt", String(paidAt));
      form.set("method", method);
      form.set("rail", rail);
      if (note.trim()) form.set("note", note.trim());
      if (file) form.set("file", file);
      const r = await fetch("/api/payments", { method: "POST", body: form });
      const j = await r.json();
      if (!r.ok) {
        setErr(j?.error || "Could not log the payment.");
      } else {
        setAmount("");
        setNote("");
        setFile(null);
        onAdded();
      }
    } catch {
      setErr("Could not log the payment.");
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = { background: T.bg2, color: T.text, border: `1px solid ${T.borderSoft}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5 };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 6 }}>Log a payment received</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label style={{ fontSize: 11, color: T.dim }}>
          Amount (USD)
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...inputStyle, width: "100%", marginTop: 2 }} />
        </label>
        <label style={{ fontSize: 11, color: T.dim }}>
          Date received
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
          Settled
          <select value={rail} onChange={(e) => setRail(e.target.value as PaymentRail)} style={{ ...inputStyle, width: "100%", marginTop: 2 }}>
            <option value="offline">Offline (bank / cash / QR)</option>
            <option value="in_app" disabled>
              In-app (coming with settlement release)
            </option>
          </select>
        </label>
      </div>
      <label style={{ fontSize: 11, color: T.dim, display: "block", marginTop: 8 }}>
        Note (optional)
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Deposit — reference 4471" style={{ ...inputStyle, width: "100%", marginTop: 2 }} />
      </label>
      <label style={{ fontSize: 11, color: T.dim, display: "block", marginTop: 8 }}>
        Evidence slip (optional — photo of the receipt / bank slip, or a PDF statement)
        <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ display: "block", marginTop: 2, fontSize: 12, color: T.dim }} />
      </label>
      {err && <div style={{ fontSize: 12, color: T.danger, marginTop: 6 }}>{err}</div>}
      <button type="button" disabled={busy} onClick={submit} style={{ ...submitBtn, marginTop: 10, opacity: busy ? 0.5 : 1 }}>
        {busy ? "Logging…" : "Log payment"}
      </button>
      <div style={{ fontSize: 11, color: T.dim, marginTop: 6 }}>
        Offline payments the customer makes to you (cash, bank transfer, QR) are recorded here with evidence. The
        customer (or their agent) confirms each entry. A confirmed payment counts toward unlocking the agency&apos;s
        commission; slips stay private to you and the customer.
      </div>
    </div>
  );
}
