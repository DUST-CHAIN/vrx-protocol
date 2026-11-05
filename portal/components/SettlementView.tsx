"use client";

// SettlementView — the money-LOGIC dashboard over /api/settlement (lib/earmark's
// settlementRollup). ONE reusable section, two roles (the "reuse the pattern"):
//   • developer → what I OWE: a line per agency (commission) + one line to VRX (the protocol fee).
//   • agency    → what I'm OWED: a line per developer (commission). No VRX line (that fee is the
//     developer's obligation to VRX, not the agency's).
//
// HONEST about accrued vs prospective (the whole point): a figure is ACCRUED only on a CONFIRMED
// sale (really owed); PROSPECTIVE is previewed on a not-yet-confirmed booking (might still fall through).
// SETTLED is 0 until the on-rail TAKE settlement is built (/) — we carry it in the shape
// so the later rail fills it without reshaping anything, and show OUTSTANDING = accrued − settled = what's
// still owed right now. We never present a prospective number as money in hand.
//
// AUDITABLE: each party row EXPANDS to the individual bookings behind the total — unit, price,
// rate, amount, confirmed/previewed — plus the signed S&P document (SaleContractButton) and the on-chain
// booking-close receipt when the deal was closed through the system. A $6,720 total is traceable to the
// exact sale that produced it. Amounts shown in FULL (useMoneyFull) — compacting $10,980/$11,045 both to
// "$11K" on a settlement screen would hide a real difference.
//
// VOCAB: plain words — "You owe" / "Owed to you", "earned" / "if these bookings confirm". No
// contract-speak, no D-refs, no hash talk. PRIVACY: these USD figures are B2B and NEVER appear on a
// buyer's S&P — this surface is developer/agency-only. Nothing on-chain beyond the receipt link.

import { useCallback, useEffect, useState } from "react";
import { useMoneyFull } from "@/lib/currency";
import { card, submitBtn, mono } from "@/lib/ui";
import { T } from "@/lib/theme";
import { EXPLORER_URL } from "@/lib/config";
import { PrivateMark } from "@/lib/marks";
import SaleContractButton from "@/components/SaleContractButton";
import { vrxPayableReasonCopy, type VrxPayableReason } from "@/lib/payment-ledger";

type PayableReason = "payable" | "awaiting_signing" | "awaiting_payment" | "awaiting_both";
type DealLine = {
  requestId: string;
  buildingId?: string;
  unitId?: string;
  priceUsd: number;
  pct: number;
  amountUsd: number;
  kind: "earned" | "prospective";
  agency: string;
  at: number;
  confirmTx?: string;
  //  step 4 — the agency unlock verdict (commission lines only; absent/false on the VRX-fee line).
  payable?: boolean;
  payableReason?: PayableReason;
  unlockPct?: number;
  thresholdUsd?: number;
  paidToDateUsd?: number;
  //  §3b — the VRX 14-working-day clock verdict (VRX-fee lines only; absent on commission).
  // `vrxPayable` = the settlement window has closed (or early-settle fired) → the developer owes VRX now;
  // `vrxPayableReason` explains WHY; `vrxDueAt` = ms epoch the fee becomes due (absent = no exit).
  vrxPayable?: boolean;
  vrxPayableReason?: VrxPayableReason;
  vrxDueAt?: number;
};
type Balance = {
  accruedUsd: number;
  prospectiveUsd: number;
  /** step 4 — the subset of accrued that has passed the agency unlock gate (signed + paid ≥ threshold). */
  payableUsd: number;
  settledUsd: number;
  outstandingUsd: number;
  saleCount: number;
};

//  plain words for each unlock reason — why a commission is / isn't payable yet (B2B, no amounts).
const payableReasonCopy: Record<PayableReason, string> = {
  payable: "Payable now — signed and enough of the customer's payment is in.",
  awaiting_signing: "Awaiting the signed sale & purchase agreement.",
  awaiting_payment: "Awaiting enough of the customer's payment to unlock.",
  awaiting_both: "Awaiting the signed agreement and the customer's payment.",
};
type AgencyLine = { developer: string; agency: string; deals: DealLine[] } & Balance;
type VrxLine = { developer: string; deals: DealLine[] } & Balance;

type DeveloperSettlement = {
  role: "developer";
  account: string;
  owesAgencies: AgencyLine[];
  owesVrx: VrxLine | null;
  totals: { commission: Balance; vrxFee: Balance };
};
type AgencySettlement = {
  role: "agency";
  account: string;
  owedBy: AgencyLine[];
  totals: { commission: Balance };
};
type Payload = DeveloperSettlement | AgencySettlement;

export default function SettlementView({ me, role }: { me: string; role: "developer" | "agency" }) {
  const money = useMoneyFull();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/settlement?account=${encodeURIComponent(me)}&role=${role}`);
      if (!r.ok) throw new Error(`settlement ${r.status}`);
      setData((await r.json()) as Payload);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [me, role]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isDev = role === "developer";

  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Settlement</h2>
        <button type="button" onClick={() => void refresh()} disabled={loading} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13 }}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 6 }}>
        {isDev
          ? "What you owe each agency in commission on the deals they've closed with you, plus the VRX platform fee. Earned amounts are on confirmed sales; the rest is previewed and only becomes owed once those bookings confirm. Open any line to see the deals behind it. Amounts are kept private."
          : "What each developer owes you in commission on the deals your agents have closed. Earned amounts are on confirmed sales; the rest is previewed and only becomes owed once those bookings confirm. Open any line to see the deals behind it. Amounts are kept private."}
      </p>

      {err && <p style={{ color: T.danger, fontSize: 13 }}>Couldn&apos;t load settlement — {err}. Try Refresh in a moment.</p>}
      {loading && data === null && <p style={{ opacity: 0.5, fontSize: 14 }}>Loading…</p>}

      {data && isDev && <DeveloperBody data={data as DeveloperSettlement} money={money} me={me} />}
      {data && !isDev && <AgencyBody data={data as AgencySettlement} money={money} me={me} />}
    </section>
  );
}

// ── Developer view: what I owe (agencies + VRX) ────────────────────────────────────────────────────────
function DeveloperBody({ data, money, me }: { data: DeveloperSettlement; money: (usd: number) => string; me: string }) {
  const nothing = data.owesAgencies.length === 0 && !hasMoney(data.owesVrx);
  if (nothing) {
    return (
      <p style={{ opacity: 0.6, fontSize: 14 }}>
        Nothing to settle yet. Once an agency closes a sale with you, the commission you owe them — and the VRX
        platform fee — show here.
      </p>
    );
  }
  return (
    <div style={{ marginTop: 12, display: "grid", gap: 16 }}>
      {/* Headline totals — the two obligation streams, earned vs still-prospective. The VRX card carries the
          on-demand "can my wallet cover this bill?" check (the one place a live chain read is useful). */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <TotalCard label="You owe agencies (commission)" bal={data.totals.commission} money={money} direction="owe" showPayable />
        <TotalCard label="You owe VRX (platform fee)" bal={data.totals.vrxFee} money={money} direction="owe" showPayable payableKind="vrx">
          <BalanceCheck me={me} billUsd={data.totals.vrxFee.outstandingUsd} money={money} />
        </TotalCard>
      </div>

      {data.owesAgencies.length > 0 && (
        <div>
          <SectionLabel>By agency</SectionLabel>
          <div style={{ display: "grid", gap: 8 }}>
            {data.owesAgencies.map((l) => (
              <PartyRow key={`${l.developer}|${l.agency}`} who={l.agency} bal={l} deals={l.deals} money={money} me={me} feeLine={false} />
            ))}
          </div>
        </div>
      )}

      {hasMoney(data.owesVrx) && (
        <div>
          <SectionLabel>Platform fee to VRX</SectionLabel>
          <PartyRow who="VRX" bal={data.owesVrx!} deals={data.owesVrx!.deals} money={money} me={me} feeLine />
        </div>
      )}
    </div>
  );
}

// ── Agency view: what I'm owed (per developer) ─────────────────────────────────────────────────────────
function AgencyBody({ data, money, me }: { data: AgencySettlement; money: (usd: number) => string; me: string }) {
  if (data.owedBy.length === 0) {
    return (
      <p style={{ opacity: 0.6, fontSize: 14 }}>
        Nothing owed to you yet. Once your agents close a sale with a developer you have an agreement with, the
        commission owed shows here.
      </p>
    );
  }
  return (
    <div style={{ marginTop: 12, display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <TotalCard label="Owed to you (commission)" bal={data.totals.commission} money={money} direction="owed" showPayable />
      </div>
      <div>
        <SectionLabel>By developer</SectionLabel>
        <div style={{ display: "grid", gap: 8 }}>
          {data.owedBy.map((l) => (
            <PartyRow key={`${l.developer}|${l.agency}`} who={l.developer} bal={l} deals={l.deals} money={money} me={me} feeLine={false} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── shared bits ──
function hasMoney(b: Balance | null | undefined): boolean {
  return !!b && (b.accruedUsd > 0 || b.prospectiveUsd > 0);
}

/** A real on-chain tx hash links to the explorer; a seeded-demo `stub:…` placeholder does not (it isn't a
 *  real transaction). Base58 NEAR hashes have no colon; the stub sentinel does. */
function isRealTx(tx: string | undefined): boolean {
  return !!tx && !tx.startsWith("stub:") && !tx.includes(":");
}

// The VRX settlement-clock due date (§3b) as a short calendar date — honest and locale-aware, no recomputed
// working-day countdown (which could drift from the server's calendar; the server owns the working-day math).
function fmtDueDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: T.faint, marginBottom: 6 }}>
      {children}
    </div>
  );
}

// A big "earned / prospective" total. `direction` just tints the primary figure (owe = amber, owed = green).
// `children` = an optional footer slot (the VRX card uses it for the balance check).
function TotalCard({ label, bal, money, direction, showPayable, payableKind = "agency", children }: { label: string; bal: Balance; money: (usd: number) => string; direction: "owe" | "owed"; showPayable?: boolean; payableKind?: "agency" | "vrx"; children?: React.ReactNode }) {
  const primaryColor = direction === "owed" ? T.vetted : T.hold;
  return (
    <div style={{ padding: "12px 14px", borderRadius: 10, background: T.bg2, border: `1px solid ${T.border}` }}>
      <div style={{ fontSize: 12, opacity: 0.6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: primaryColor }}>
        {money(bal.outstandingUsd)}
        <PrivateMark />
      </div>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>
        earned on {bal.saleCount} confirmed sale{bal.saleCount === 1 ? "" : "s"}
      </div>
      {/* The PAYABLE graduation: of the earned total, how much has passed its unlock gate and is owed NOW vs
          merely earned-not-yet-due. The gate differs by stream — the AGENCY commission unlocks on a signed S&P
 + enough of the customer's payment in (step 4); the VRX platform fee unlocks on the 14-working-day
 settlement clock (§3b) — so the "none yet" explanation is worded to match each gate. */}
      {showPayable && bal.accruedUsd > 0 && (
        <div style={{ fontSize: 12, marginTop: 4, color: bal.payableUsd > 0 ? T.vetted : T.dim }}>
          {bal.payableUsd > 0
            ? `${money(bal.payableUsd)} payable now ✓`
            : payableKind === "vrx"
              ? "none payable yet — within the settlement window"
              : "none payable yet — awaiting signing / payment"}
        </div>
      )}
      {bal.prospectiveUsd > 0 && (
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
          + {money(bal.prospectiveUsd)} if open bookings confirm
        </div>
      )}
      {children}
    </div>
  );
}

// ── On-demand wallet-balance check — "is my balance OK to pay the VRX bill?" ────────────────
// Reads the developer's wallet balance ONLY when clicked (respects "nothing hits FastNEAR unless it's a
// must"), through our server proxy. The verdict is INDICATIVE: balance is NEAR, the bill is USD, so we
// convert at the app's static demo rate — honest about that rather than implying authoritative FX.
function BalanceCheck({ me, billUsd, money }: { me: string; billUsd: number; money: (usd: number) => string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [bal, setBal] = useState<{ availableNear: number; availableUsd: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function check() {
    setState("loading");
    setMsg(null);
    try {
      const r = await fetch(`/api/settlement/balance?account=${encodeURIComponent(me)}`);
      const j = await r.json();
      if (!r.ok) {
        setState("error");
        setMsg(typeof j.error === "string" ? j.error : "Couldn't read your balance.");
        return;
      }
      setBal({ availableNear: j.availableNear, availableUsd: j.availableUsd });
      setState("done");
    } catch {
      setState("error");
      setMsg("Couldn't read your balance.");
    }
  }

  if (state === "idle") {
    return (
      <button
        type="button"
        onClick={() => void check()}
        style={{ marginTop: 10, padding: "5px 11px", fontSize: 12, borderRadius: 6, border: `1px solid ${T.border}`, background: T.panel, color: T.dim, cursor: "pointer" }}
      >
        Check my wallet balance
      </button>
    );
  }
  if (state === "loading") return <div style={{ marginTop: 10, fontSize: 12, opacity: 0.6 }}>Reading your balance…</div>;
  if (state === "error") {
    return (
      <div style={{ marginTop: 10, fontSize: 12 }}>
        <span style={{ color: T.danger }}>{msg}</span>{" "}
        <button type="button" onClick={() => void check()} style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontSize: 12, padding: 0 }}>Retry</button>
      </div>
    );
  }
  // done
  const covers = bal != null && bal.availableUsd >= billUsd;
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.borderSoft}`, fontSize: 12 }}>
      <div style={{ opacity: 0.7 }}>
        Wallet: <b>Ⓝ{bal?.availableNear.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>{" "}
        <span style={{ opacity: 0.7 }}>(≈ {money(bal?.availableUsd ?? 0)})</span>
      </div>
      {billUsd > 0 ? (
        <div style={{ marginTop: 3, color: covers ? T.vetted : T.danger }}>
          {covers ? "✓" : "⚠"} Indicative: {covers ? "covers" : "does not cover"} your {money(billUsd)} VRX fee
        </div>
      ) : (
        <div style={{ marginTop: 3, opacity: 0.6 }}>No VRX fee outstanding right now.</div>
      )}
      <div style={{ marginTop: 3, opacity: 0.6, fontSize: 11 }}>Balance in NEAR, fee in USD — rough guide only.</div>
    </div>
  );
}

// One counterparty line: who + its earned/prospective split, EXPANDABLE to the per-deal audit breakdown.
// `feeLine` = this is the VRX platform-fee line, so the per-deal amounts/rate are the FEE (not the commission).
function PartyRow({
  who,
  bal,
  deals,
  money,
  me,
  feeLine,
}: {
  who: string;
  bal: Balance;
  deals: DealLine[];
  money: (usd: number) => string;
  me: string;
  feeLine: boolean;
}) {
  const [open, setOpen] = useState(false);
  const canExpand = deals.length > 0;
  return (
    <div style={{ borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}`, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        disabled={!canExpand}
        style={{
          display: "flex", width: "100%", justifyContent: "space-between", alignItems: "baseline", gap: 12,
          flexWrap: "wrap", padding: "10px 12px", border: "none", background: "none", textAlign: "left",
          color: T.text, cursor: canExpand ? "pointer" : "default",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ ...mono, fontSize: 13, color: T.text, overflow: "hidden", textOverflow: "ellipsis" }}>
            {canExpand && <span style={{ color: T.dim, marginRight: 6 }}>{open ? "▾" : "▸"}</span>}
            {who}
          </div>
          <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 2 }}>
            {bal.saleCount} confirmed sale{bal.saleCount === 1 ? "" : "s"}
            {bal.prospectiveUsd > 0 && ` · ${money(bal.prospectiveUsd)} previewed`}
            {canExpand && ` · ${deals.length} deal${deals.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {money(bal.outstandingUsd)}
            <PrivateMark />
          </div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>earned</div>
        </div>
      </button>

      {open && canExpand && (
        <div style={{ borderTop: `1px solid ${T.borderSoft}`, padding: "4px 12px 10px" }}>
          {deals.map((d) => (
            <DealRow key={d.requestId} d={d} money={money} me={me} feeLine={feeLine} />
          ))}
        </div>
      )}
    </div>
  );
}

// One booking inside an expanded line: unit · price × rate = amount, confirmed/previewed, + the signed S&P
// document and the on-chain close receipt (when the deal was closed through the system). This is the audit
// trail that makes the rolled-up total traceable to the exact sale.
function DealRow({ d, money, me, feeLine }: { d: DealLine; money: (usd: number) => string; me: string; feeLine: boolean }) {
  const earned = d.kind === "earned";
  const unitLabel = d.unitId ? d.unitId.replace(/^unit-/, "unit ") : null;
  const title = [d.buildingId, unitLabel].filter(Boolean).join(" · ") || `booking ${d.requestId.slice(0, 10)}…`;
  return (
    <div style={{ padding: "9px 0", borderBottom: `1px solid ${T.borderSoft}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {title}{" "}
            <span style={{ fontSize: 11, fontWeight: 500, color: earned ? T.vetted : T.hold }}>
              ● {earned ? "confirmed" : "previewed"}
            </span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>
            {money(d.priceUsd)} × {d.pct}%{feeLine ? " platform fee" : " commission"}
          </div>
          {/*  step 4 — the agency unlock verdict for THIS deal (commission lines only). A confirmed-but-
              unpayable deal explains WHY (signed? paid enough?). */}
          {!feeLine && earned && (
            <div style={{ fontSize: 11.5, marginTop: 3, color: d.payable ? T.vetted : T.dim }}>
              {d.payable ? "✓ payable now" : `◷ earned — ${payableReasonCopy[d.payableReason ?? "awaiting_both"]}`}
              {typeof d.thresholdUsd === "number" && d.thresholdUsd > 0 && typeof d.paidToDateUsd === "number" && (
                <span style={{ opacity: 0.7 }}>
                  {" "}· customer paid {money(d.paidToDateUsd)} of {money(d.thresholdUsd)} unlock
                </span>
              )}
            </div>
          )}
          {/*  §3b — the VRX 14-working-day settlement clock for THIS fee line. Payable once the
              window has closed; otherwise "◷ due by <date>" (we show the server-computed due DATE, not a
              client-recomputed working-day countdown, so the calendar can't drift between the two). */}
          {feeLine && earned && (
            <div style={{ fontSize: 11.5, marginTop: 3, color: d.vrxPayable ? T.vetted : T.dim }}>
              {d.vrxPayable
                ? "✓ payable now"
                : `◷ accrued — ${vrxPayableReasonCopy[d.vrxPayableReason ?? "clock_running"]}`}
              {!d.vrxPayable && typeof d.vrxDueAt === "number" && (
                <span style={{ opacity: 0.7 }}> · due by {fmtDueDate(d.vrxDueAt)}</span>
              )}
            </div>
          )}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: earned ? undefined : T.dim }}>{money(d.amountUsd)}</div>
      </div>
      {/* Links: the signed S&P document (server-scoped to this viewer) + the on-chain close receipt. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
        <SaleContractButton requestId={d.requestId} viewer={me} label="S&P document" compact />
        {/* The on-chain close receipt — only a REAL tx hash links to the explorer. Seeded demo sales carry a
 `stub:…` placeholder (closed via the off-chain ChainStub), which isn't a real tx — so we
            show an honest "demo close" note instead of a dead explorer link. */}
        {isRealTx(d.confirmTx) ? (
          <a
            href={`${EXPLORER_URL}/transactions/${d.confirmTx}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12, color: T.accent, textDecoration: "none" }}
            title="The on-chain booking-close receipt"
          >
            ⛓ on-chain receipt ↗
          </a>
        ) : d.confirmTx ? (
          <span style={{ fontSize: 11.5, opacity: 0.6 }} title="Closed via the seeded demo (no live transaction)">
            ⛓ demo close
          </span>
        ) : earned ? (
          <span style={{ fontSize: 11.5, opacity: 0.6 }}>closed on-chain (receipt not captured)</span>
        ) : null}
      </div>
    </div>
  );
}
