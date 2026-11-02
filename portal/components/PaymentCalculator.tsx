"use client";

// Payment-plan CALCULATOR (A4) — the interactive tab where the customer designs their exact
// Milestones: deposit · on-contract · on-key(handover) · N instalments. Each of the first three is
// entered as a FIXED amount OR a %, two-way converted against the price. Instalments auto-divide the
// remainder over N payments (remainder to the last), on a monthly-from-start schedule. Separate
// developer fees (reservation/booking/tax) are shown as line items, not deducted from the milestones.
// The assembled plan is returned via onChange so the parent can hash it into open_claim's request_hash
// ( — the raw plan stays off-chain; only its hash goes on-chain). Presentational + local state only.

import { useEffect, useMemo, useState } from "react";
import { useMoney } from "@/lib/currency";
import type { Building, Unit, PaymentTerms } from "@/lib/catalog-client";
import { T } from "@/lib/theme";

// The four price components, each with a colour so the allocation bar + statement read at a glance.
const SEG = {
  deposit: T.accent, // "#3d7dff"
  contract: "#8a6bff",
  instalments: T.vetted, // "#38d39f"
  transfer: T.hold, // "#e8b84b"
} as const;

export type AssembledPlan = {
  priceUsd: number;
  depositUsd: number;
  onContractUsd: number;
  onKeyUsd: number;
  instalmentCount: number;
  instalmentUsd: number; // each (last may carry the remainder)
  frequencyDays: number;
  bookingFeeUsd: number;
  taxPct: number;
  reservationUsd: number;
  furnitureUsd: number; // 0 if not ordered
  schedule: { label: string; amountUsd: number }[];
  /** true when deposit+onContract+onKey+instalments reconcile to the price. */
  balanced: boolean;
};

type Part = { mode: "pct" | "amt"; value: number };

// First published option of a terms array as the sensible default (developer's headline plan).
const first = <T,>(a: T[] | undefined, fb: T): T => (a && a.length ? a[0] : fb);

export default function PaymentCalculator({
  building,
  unit,
  terms,
  onChange,
}: {
  building: Building;
  unit: Unit;
  terms: PaymentTerms;
  onChange?: (plan: AssembledPlan) => void;
}) {
  const money = useMoney();
  const price = unit.priceUsd;

  // Seed each milestone from the developer's first published option (as a %).
  const caps = terms.caps ?? {};
  // Seed each milestone from the developer's first published option (as a %).
  const [deposit, setDeposit] = useState<Part>({ mode: "pct", value: first(terms.depositPct, 0.5) });
  const [onContract, setOnContract] = useState<Part>({
    mode: "pct",
    value: first(terms.onContract, { installments: 1, amountPct: 25 }).amountPct,
  });
  const [onKey, setOnKey] = useState<Part>({ mode: "pct", value: first(terms.onKeyPct, 15) });
  const [instalments, setInstalments] = useState<number>(caps.instalmentsDefault ?? 6);
  const [freq, setFreq] = useState<number>(first(terms.frequencyDays, 30));

  // Optional fitted-furniture package (developer-set price per m²; due before instalment N).
  const furnitureUsd = Math.round((terms.furniturePerSqmUsd ?? 0) * (unit.sqm || 0));
  const furnitureOffered = furnitureUsd > 0;
  const [furniture, setFurniture] = useState(false);
  const furnBeforeInst = terms.furnitureDueBeforeInstalment ?? 3;

  const bookingFee = first(terms.bookingFee, 0);
  const taxPct = first(terms.taxPct, 0);
  const reservation = building.reservationFeeUsd ?? 0;
  const contractDays = terms.contractDays ?? 7;

  const toUsd = (p: Part) => (p.mode === "amt" ? p.value : (price * p.value) / 100);
  const depositUsd = toUsd(deposit);
  const onContractUsd = toUsd(onContract);
  const onKeyUsd = toUsd(onKey);
  const remaining = Math.max(0, price - depositUsd - onContractUsd - onKeyUsd);
  // the instalment floor defaults to 0 so an agent can offer a SINGLE/arbitrary plan — all in the
  // deposit, or deposit+on-contract and nothing more (e.g. a ready unit, a resale, or a NON-property listing
  // like software: deposit → agreement+balance → done). A developer who wants to FORBID instalments on a
  // building sets caps.instalmentsMin AND instalmentsMax to 0. The seal/S&P already accept any structure.
  const nMin = caps.instalmentsMin ?? 0;
  const nMax = caps.instalmentsMax ?? 60;
  const n = Math.max(nMin, Math.min(nMax, Math.round(instalments)));
  const each = n > 0 ? Math.floor(remaining / n) : 0; // guard /0 when there are no instalments
  const lastExtra = n > 0 ? remaining - each * n : 0;
  // Rough span the instalments run over (the developer sets this window — usually up to ~2–3 years).
  const spanMonths = n > 0 ? Math.max(1, Math.round((n * freq) / 30)) : 0;

  const allocated = depositUsd + onContractUsd + onKeyUsd + remaining;
  const toAllocate = price - allocated; // ~0 when balanced (remaining absorbs the rest, so this is 0)
  const balanced = Math.abs(price - (depositUsd + onContractUsd + onKeyUsd + each * n + lastExtra)) < 1;

  const furnUsd = furniture ? furnitureUsd : 0;

  const plan: AssembledPlan = useMemo(() => {
    const schedule: { label: string; amountUsd: number }[] = [];
    if (depositUsd > 0) schedule.push({ label: "Deposit", amountUsd: depositUsd });
    if (onContractUsd > 0) schedule.push({ label: "On contract", amountUsd: onContractUsd });
    for (let k = 0; k < n; k++) {
      let amt = k === n - 1 ? each + lastExtra : each;
      // Furniture: full cost due BEFORE instalment `furnBeforeInst` — fold it onto the instalment just
      if (furnUsd > 0 && k + 1 === Math.max(1, furnBeforeInst - 1)) amt += furnUsd;
      schedule.push({ label: `Instalment ${k + 1}${furnUsd > 0 && k + 1 === Math.max(1, furnBeforeInst - 1) ? " + furniture" : ""}`, amountUsd: amt });
    }
    if (onKeyUsd > 0) schedule.push({ label: "On transfer", amountUsd: onKeyUsd });
    return {
      priceUsd: price,
      depositUsd,
      onContractUsd,
      onKeyUsd,
      instalmentCount: n,
      instalmentUsd: each,
      frequencyDays: freq,
      bookingFeeUsd: bookingFee,
      taxPct,
      reservationUsd: reservation,
      furnitureUsd: furnUsd,
      schedule,
      balanced,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, depositUsd, onContractUsd, onKeyUsd, n, each, lastExtra, freq, bookingFee, taxPct, reservation, furnUsd, furnBeforeInst, balanced]);

  // Bubble the assembled plan up whenever it changes (effect, not render — avoids a setState-in-render).
  useEffect(() => {
    onChange?.(plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  // Proportional segments for the allocation bar (only the price-milestone parts; fees sit outside).
  const instalmentsUsd = each * n + lastExtra;
  const bar = [
    { key: "deposit", label: "Deposit", usd: depositUsd, color: SEG.deposit },
    { key: "contract", label: "On contract", usd: onContractUsd, color: SEG.contract },
    { key: "instalments", label: "Instalments", usd: instalmentsUsd, color: SEG.instalments },
    { key: "transfer", label: "On transfer", usd: onKeyUsd, color: SEG.transfer },
  ].filter((s) => s.usd > 0);

  return (
    <div>
      <p style={{ fontSize: 12.5, color: T.dim, margin: "0 0 18px", lineHeight: 1.55 }}>
        Design the plan within the developer&apos;s allowed range. The instalments absorb whatever is left
        after the deposit, on-contract and handover payments. Sign the agreement within{" "}
        <strong style={{ color: T.text }}>{contractDays} days</strong> of reserving.
      </p>

      {/* Allocation bar — the whole price split at a glance (trading-terminal density). */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
          {bar.map((s) =>
            // The instalments segment gets a tick per instalment — the payments visibly divided.
            s.key === "instalments" && n > 1 ? (
              <div
                key={s.key}
                title={`${s.label} · ${n} payments · ${money(s.usd)}`}
                style={{ width: `${(s.usd / price) * 100}%`, background: s.color, transition: "width 0.25s ease", display: "flex" }}
              >
                {Array.from({ length: n }).map((_, k) => (
                  <div
                    key={k}
                    style={{
                      flex: 1,
                      // A thin divider between instalments (not on the last one) — reads as ticks.
                      borderRight: k < n - 1 ? "1px solid rgba(10,14,23,0.55)" : "none",
                    }}
                  />
                ))}
              </div>
            ) : (
              <div key={s.key} title={`${s.label} · ${money(s.usd)}`} style={{ width: `${(s.usd / price) * 100}%`, background: s.color, transition: "width 0.25s ease" }} />
            )
          )}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 8 }}>
          {bar.map((s) => (
            <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: T.dim }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: "inline-block" }} />
              {s.label} <span style={{ color: T.faint }}>{pct(s.usd, price)}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Milestones the customer sets */}
      <div style={{ ...surfaceCard, padding: "4px 14px", marginBottom: 16 }}>
        <Milestone accent={SEG.deposit} label="Reservation deposit" part={deposit} setPart={setDeposit} price={price} money={money}
          min={caps.depositPctMin} max={caps.depositPctMax} />
        <Milestone accent={SEG.contract} label="On contract" part={onContract} setPart={setOnContract} price={price} money={money}
          min={caps.onContractPctMin} max={caps.onContractPctMax} sub={`within ${contractDays} days`} />

        {/* Instalments (during construction) — a SLIDER over the developer's allowed count. Hidden
            entirely when the developer forbids instalments (nMax===0 → ready units / resales / non-property). */}
        {nMax > 0 && (
          <div style={{ ...row, alignItems: "flex-start", borderBottom: `1px solid ${T.borderSoft}` }}>
            <span style={{ width: 3, alignSelf: "stretch", borderRadius: 999, background: SEG.instalments, opacity: 0.8 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <span style={rowLabel}>
                  Instalments {n > 0 && <span style={{ fontSize: 12, fontWeight: 400, color: T.faint }}>· ~{spanMonths} mo</span>}
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: T.text, fontFamily: T.mono, whiteSpace: "nowrap" }}>
                  {n === 0 ? "none" : `${n} × ${money(each)}`}
                </span>
              </div>
              {nMax > nMin ? (
                <input
                  type="range"
                  aria-label="Number of instalments"
                  min={nMin}
                  max={nMax}
                  step={1}
                  value={n}
                  onChange={(e) => setInstalments(Number(e.target.value))}
                  style={{ width: "100%", accentColor: SEG.instalments, marginTop: 8, marginBottom: 2, height: 24 }}
                />
              ) : null}
              <div style={rowSub}>
                {n === 0
                  ? "No instalments — balance due via the payments above"
                  : `${lastExtra > 0 ? `last ${money(each + lastExtra)} · ` : ""}every ${freq} days${nMax > nMin ? ` · ${nMin}–${nMax} payments` : ""}`}
              </div>
            </div>
          </div>
        )}

        {/* Frequency (developer-published options, if more than one) */}
        {terms.frequencyDays && terms.frequencyDays.length > 1 && (
          <div style={{ ...row, borderBottom: `1px solid ${T.borderSoft}` }}>
            <span style={{ width: 3, alignSelf: "stretch" }} />
            <div style={{ flex: 1 }}>
              <div style={rowLabel}>Frequency</div>
            </div>
            <select value={freq} onChange={(e) => setFreq(Number(e.target.value))} style={{ ...numInput, width: 140, textAlign: "left" }}>
              {terms.frequencyDays.map((d) => (
                <option key={d} value={d}>every {d} days</option>
              ))}
            </select>
          </div>
        )}

        <Milestone accent={SEG.transfer} label="On transfer" part={onKey} setPart={setOnKey} price={price} money={money}
          min={caps.onKeyPctMin} max={caps.onKeyPctMax} sub="on handover / title transfer" last />

        {/* Furniture package (optional add-on) — full cost due before instalment N (developer cash-flow). */}
        {furnitureOffered && (
          <label style={{ ...row, borderBottom: "none", cursor: "pointer" }}>
            <span style={{ width: 3, alignSelf: "stretch" }} />
            <input type="checkbox" checked={furniture} onChange={(e) => setFurniture(e.target.checked)} style={{ width: 16, height: 16, accentColor: T.accent }} />
            <span style={{ flex: 1 }}>
              <div style={rowLabel}>Fitted furniture package</div>
              <div style={rowSub}>{money(furnitureUsd)} · due before instalment {furnBeforeInst}</div>
            </span>
          </label>
        )}
      </div>

      {/* Statement — the assembled schedule, reads like a receipt. */}
      <div
        style={{
          ...surfaceCard,
          padding: "12px 14px",
          border: `1px solid ${balanced ? "rgba(56,211,159,0.35)" : "rgba(232,184,75,0.4)"}`,
          background: balanced ? "rgba(56,211,159,0.05)" : "rgba(232,184,75,0.05)",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: T.faint, marginBottom: 8 }}>
          Payment schedule
        </div>
        <Line k="Unit price" v={money(price)} strong />
        <div style={{ borderTop: `1px solid ${T.borderSoft}`, margin: "7px 0" }} />
        <Line k="Deposit" dot={SEG.deposit} v={`${pct(depositUsd, price)} · ${money(depositUsd)}`} />
        <Line k="On contract" dot={SEG.contract} v={`${pct(onContractUsd, price)} · ${money(onContractUsd)}`} />
        {/* Instalments listed out: first few each, then the last (which carries the remainder).
            Compact summary — the whole schedule without printing up to 48 lines. */}
        {n > 0 && remaining > 0 && (
          lastExtra > 0 && n > 1 ? (
            <>
              <Line k={n > 2 ? `Instalments 1–${n - 1}` : "Instalment 1"} dot={SEG.instalments} v={`${money(each)} each`} />
              <Line k={`Instalment ${n}`} dot={SEG.instalments} v={money(each + lastExtra)} />
            </>
          ) : (
            <Line k={n > 1 ? `Instalments 1–${n}` : "Instalment 1"} dot={SEG.instalments} v={`${money(each)} each`} />
          )
        )}
        <Line k="On transfer" dot={SEG.transfer} v={`${pct(onKeyUsd, price)} · ${money(onKeyUsd)}`} />
        {furnUsd > 0 && <Line k="Furniture" v={money(furnUsd)} />}
        <div style={{ borderTop: `1px solid ${T.borderSoft}`, margin: "7px 0" }} />
        <Line
          k={balanced ? "Balanced" : "Left to allocate"}
          v={balanced ? money(price + furnUsd) : money(Math.abs(toAllocate))}
          strong
          okColor={balanced ? T.vetted : T.hold}
        />
      </div>

      {/* Separate fees + estimated tax (developer line items, not part of the price milestones). */}
      <div style={{ marginTop: 14, fontSize: 12.5 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: T.faint, marginBottom: 6 }}>
          Plus, separately
        </div>
        {reservation > 0 && <Line k="Reservation fee" v={money(reservation)} small />}
        {bookingFee > 0 && <Line k="Booking fee" v={money(bookingFee)} small />}
        {taxPct > 0 && <Line k="Transfer tax (est.)" v={`~${taxPct}% · ${money(Math.round((price * taxPct) / 100))}`} small />}
        {taxPct > 0 && (
          <div style={{ fontSize: 11, color: T.faint, marginTop: 4 }}>
            Tax is estimated; the exact amount is confirmed at title transfer.
          </div>
        )}
      </div>
    </div>
  );
}

// no mobile keyboard to wreck the layout, and the dev's min/max caps ARE the slider bounds (can't go out
// of range). The live % and $ value show above the track. Falls back to a sensible 0–100 range when the
// developer didn't set an explicit cap for this milestone.
function Milestone({
  label,
  part,
  setPart,
  price,
  money,
  min,
  max,
  sub,
  accent,
  last,
}: {
  label: string;
  part: Part;
  setPart: (p: Part) => void;
  price: number;
  money: (usd: number) => string;
  /** Developer caps on the PERCENTAGE — become the slider bounds. */
  min?: number;
  max?: number;
  sub?: string;
  /** Colour stripe tying the row to its allocation-bar segment. */
  accent?: string;
  /** Last row in the card — no bottom border. */
  last?: boolean;
}) {
  // Always work in % for the slider (the $ shows live). Convert if the part is currently an amount.
  const curPct = part.mode === "pct" ? part.value : price > 0 ? round2((part.value / price) * 100) : 0;
  const lo = min != null ? min : 0;
  const hi = max != null ? max : Math.max(lo, 100);
  // A tight, mobile-friendly step: fine where the range is small, coarser where it's wide.
  const span = Math.max(0.5, hi - lo);
  const step = span <= 5 ? 0.1 : span <= 30 ? 0.5 : 1;
  const usd = (price * curPct) / 100;
  const fixed = lo === hi; // developer locked this milestone to a single value — show it, no slider
  const rangeHint = min != null && max != null ? `allowed ${trim(min)}–${trim(max)}%` : undefined;

  return (
    <div style={{ ...row, alignItems: "flex-start", borderBottom: last ? "none" : `1px solid ${T.borderSoft}` }}>
      <span style={{ width: 3, alignSelf: "stretch", borderRadius: 999, background: accent ?? "transparent", opacity: 0.8 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={rowLabel}>{label}</span>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: T.text, fontFamily: T.mono, whiteSpace: "nowrap" }}>
            {trim(round2(curPct))}% · {money(usd)}
          </span>
        </div>
        {!fixed && (
          <input
            type="range"
            aria-label={label}
            min={lo}
            max={hi}
            step={step}
            value={curPct}
            onChange={(e) => setPart({ mode: "pct", value: round2(Number(e.target.value)) })}
            style={{ width: "100%", accentColor: accent ?? T.accent, marginTop: 8, marginBottom: 2, height: 24 }}
          />
        )}
        <div style={rowSub}>
          {rangeHint ?? (fixed ? "set by developer" : "")}
          {sub ? `${rangeHint || !fixed ? " · " : ""}${sub}` : ""}
        </div>
      </div>
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const trim = (n: number) => (Number.isInteger(n) ? String(n) : String(round2(n)));

function Line({ k, v, strong, small, dot, okColor }: { k: string; v: string; strong?: boolean; small?: boolean; dot?: string; okColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: small ? "3px 0" : "4px 0" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: strong ? T.text : T.dim, fontWeight: strong ? 600 : 400, fontSize: small ? 12.5 : 13 }}>
        {dot && <span style={{ width: 8, height: 8, borderRadius: 2.5, background: dot, display: "inline-block", flex: "none" }} />}
        {k}
      </span>
      <span style={{ fontWeight: strong ? 700 : 500, fontFamily: T.mono, fontSize: small ? 12.5 : 13, color: okColor ?? (strong ? T.text : T.dim) }}>{v}</span>
    </div>
  );
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");

const surfaceCard: React.CSSProperties = {
  background: T.panel,
  border: `1px solid ${T.border}`,
  borderRadius: 12,
};
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "11px 0",
};
const rowLabel: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: T.text };
const rowSub: React.CSSProperties = { fontSize: 12, color: T.dim, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const numInput: React.CSSProperties = {
  width: 68,
  background: T.bg2,
  color: T.text,
  border: `1px solid ${T.border}`,
  borderRadius: 7,
  padding: "6px 7px",
  fontSize: 13.5,
  textAlign: "right",
};
