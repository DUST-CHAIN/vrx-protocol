"use client";

// Per-deal DEAL-TAILORING controls — SHARED across the agent-booking path (app/node/page.tsx) and the
// direct-sales desk (components/DirectEnquiries.tsx). slice 4.
// These six editors were born inside the node (developer-inbox) page for the AGENT booking path; the direct
// desk now materializes a real `lib/offers.Offer` so the SAME tailoring applies verbatim. To
// make "reused verbatim" literal — one source of truth, no drift — the editors live here and BOTH surfaces
// import them. (Scan-for-the-pattern discipline: a second copy on the desk would drift from the agent path.)
// Each editor keys on `offer.requestId` and POSTs to `/api/offers/*` with `viewer: me`; the server authorizes
// `viewer === offer.developer` (roleOnOffer → "developer"). For a direct offer the DESK IS the offer's
// developer, so the same authorization holds with no change. All are preview-editable and FROZEN at `final`
// (the server enforces the gate; the `locked` flag here only reflects it in the UI).
// PRIVACY/numbers: no contract words or E-codes leak to the UI; money figures are the
// resolved USD from the offer's sealed plan (the live mask/price handling lives server-side).

import { useEffect, useState } from "react";
import { useMoney } from "@/lib/currency";
import { T } from "@/lib/theme";
import { input, submitBtn, statusColor } from "@/lib/ui";
import { KycDocsReview } from "@/components/KycVault";

// Just the payment-plan fields the tailoring editors read (a subset of components/PaymentCalculator
// AssembledPlan). Kept here so the editors are self-contained; the node page re-exports it for its own use.
export type AssembledPlanLite = {
  priceUsd?: number;
  depositUsd?: number;
  onContractUsd?: number;
  onKeyUsd?: number;
  instalmentCount?: number;
  instalmentUsd?: number;
  frequencyDays?: number;
  bookingFeeUsd?: number;
  taxPct?: number;
  furnitureUsd?: number;
  schedule?: { label: string; amountUsd: number }[];
  balanced?: boolean;
};

// The offer record shape the editors consume. Mirrors the attested-offer store's Offer projection the GET
// `/api/offers?requestId=` endpoint returns (developerView). Both the agent inbox and the direct desk feed
// this exact shape in.
export type OfferRecord = {
  requestId: string;
  requestHash: string;
  developer: string;
  seal: {
    terms: string;
    plan: AssembledPlanLite | null;
    ownership?: string;
    freehold?: boolean;
    buyer?: unknown; // MASKED (public view) until unlock.
    by: string;
  };
  display: { buildingId?: string; unitId?: string; buyerType?: string | null; buyerId?: string };
  /** — off-seal unlock state. Absent/false = buyer still masked to the developer. */
  unlock?: {
    revealed: boolean;
    at?: number;
    trigger?: string;
    by?: string;
    revealRequest?: { by: string; at: number; declarationSeal: string };
  };
  /** — durable SOLD marker. */
  confirmed?: { at: number; by: string; tx?: string };
  /** — the S&P contract stage overlay (absent = "preview"). */
  contract?: { stage: "preview" | "final" | "payment_arrived" | "signed"; finalAt?: number; paymentArrivedAt?: number; signedAt?: number };
  /** — negotiation concessions (editable while preview, frozen at final). */
  concessions?: { id: string; label: string; note?: string; valueUsd?: number; at: number; by: string }[];
  /** — per-deal timed terms. */
  timedTerms?: { id: string; label: string; when: string; note?: string; committed?: boolean; at: number; by: string }[];
  /** — negotiable transfer-tax rate + buyer share (default 3.6% / 50 when absent). */
  tax?: { ratePct: number; buyerSharePct: number; at: number; by: string };
  /** — developer discount off the price (amount or %), editable while preview, frozen at final. */
  discount?: { kind: "amount" | "percent"; value: number; note?: string; at: number; by: string };
  /** — instalment ordinal (1-based, string key) → milestone label tie. */
  instalmentMilestones?: Record<string, string>;
  /** — instalment ordinal (1-based, string key) → pinned due-date override (ms epoch). Sparse. */
  instalmentDueDates?: Record<string, number>;
  at: number;
};

// The non-circumvention KYC-seen acknowledgement the developer accepts before marking a contract final.
const KYC_SEEN_ACK =
  "I confirm I have seen the buyer's KYC for this booking and will use it solely to prepare and execute this Sale & Purchase agreement.";

function btnOf(label: string): React.CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 8,
    border: `1px solid ${statusColor(label)}`,
    background: "#0e1119",
    color: statusColor(label),
    cursor: "pointer",
    fontSize: 14,
  };
}

// — the developer records NEGOTIATION CONCESSIONS (free extras / promised changes) onto a booking. These
// seal into the S&P and bind at close, so they're editable only while the contract is at "preview" (once the
// developer marks it final the server locks them → the buyer signs against a fixed list). Developer-only.
export function ConcessionsEditor({ offer, me, onChanged }: { offer: OfferRecord; me: string; onChanged: () => void }) {
  const money = useMoney();
  const locked = (offer.contract?.stage ?? "preview") !== "preview";
  const list = offer.concessions ?? [];
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/offers/concessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: offer.requestId, viewer: me, ...body }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not update concessions.");
      else onChanged();
    } catch {
      setErr("Could not update concessions.");
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const l = label.trim();
    if (!l) return;
    await post({ op: "add", label: l, note: note.trim() || undefined, valueUsd: value ? Number(value) : undefined });
    setLabel("");
    setNote("");
    setValue("");
  }

  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>
        Concessions &amp; promises <span style={{ opacity: 0.7 }}>— free extras or agreed changes, recorded into the contract</span>
      </div>

      {list.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
          {list.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1 }}>
                {c.label}
                {typeof c.valueUsd === "number" && c.valueUsd > 0 ? <span style={{ opacity: 0.6 }}> · {money(c.valueUsd)}</span> : null}
                {c.note ? <span style={{ opacity: 0.55 }}> — {c.note}</span> : null}
              </span>
              {!locked && (
                <button type="button" disabled={busy} onClick={() => void post({ op: "remove", id: c.id })} style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer" }}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, opacity: 0.55, marginBottom: 8 }}>None recorded.</div>
      )}

      {locked ? (
        <div style={{ fontSize: 11.5, opacity: 0.6 }}>Contract is final — concessions are locked.</div>
      ) : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Free covered parking" style={{ ...input, flex: 2, minWidth: 150 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" style={{ ...input, flex: 1, minWidth: 110 }} />
          <input value={value} onChange={(e) => setValue(e.target.value)} type="number" placeholder="value $ (opt)" style={{ ...input, width: 110 }} />
          <button type="button" disabled={busy || !label.trim()} onClick={() => void add()} style={{ ...submitBtn, padding: "6px 14px", opacity: busy || !label.trim() ? 0.5 : 1 }}>
            Add
          </button>
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: T.hold, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// — per-deal TIMED TERMS ( part 1): the time-bound commitments a buyer was anxious about and wanted
// in THEIR contract — "covered car-park by March 2027", "title transfer within 60 days of final payment", a
// rental-guarantee period. Distinct from the building construction schedule (InstalmentMilestoneEditor below)
// and from undated concessions (above). `when` is free-text (date OR relative trigger). The developer marks
// each as a COMMITTED (binding) date or an indicative projection — the S&P §4B states which binds. Editable
// while preview, frozen at final (same guard as concessions). Renders into the S&P "4B. Time-Bound Commitments".
export function TimedTermsEditor({ offer, me, onChanged }: { offer: OfferRecord; me: string; onChanged: () => void }) {
  const locked = (offer.contract?.stage ?? "preview") !== "preview";
  const list = offer.timedTerms ?? [];
  const [label, setLabel] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [committed, setCommitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/offers/timed-terms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: offer.requestId, viewer: me, ...body }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not update timed terms.");
      else onChanged();
    } catch {
      setErr("Could not update timed terms.");
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const l = label.trim();
    const w = when.trim();
    if (!l || !w) return;
    await post({ op: "add", label: l, when: w, note: note.trim() || undefined, committed });
    setLabel("");
    setWhen("");
    setNote("");
    setCommitted(false);
  }

  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>
        Time-bound commitments <span style={{ opacity: 0.7 }}>— dated promises for this deal, recorded into the contract</span>
      </div>

      {list.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
          {list.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1 }}>
                {t.label}: <span style={{ opacity: 0.8 }}>{t.when}</span>
                <span style={{ opacity: 0.6 }}> · {t.committed ? "committed" : "indicative"}</span>
                {t.note ? <span style={{ opacity: 0.55 }}> — {t.note}</span> : null}
              </span>
              {!locked && (
                <button type="button" disabled={busy} onClick={() => void post({ op: "remove", id: t.id })} style={{ background: "transparent", border: "none", color: T.dim, cursor: "pointer" }}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, opacity: 0.55, marginBottom: 8 }}>None recorded.</div>
      )}

      {locked ? (
        <div style={{ fontSize: 11.5, opacity: 0.6 }}>Contract is final — timed terms are locked.</div>
      ) : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Car-park handover" style={{ ...input, flex: 2, minWidth: 150 }} />
          <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="when — e.g. by Mar 2027" style={{ ...input, flex: 1, minWidth: 130 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" style={{ ...input, flex: 1, minWidth: 110 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, opacity: 0.85, cursor: "pointer" }}>
            <input type="checkbox" checked={committed} onChange={(e) => setCommitted(e.target.checked)} />
            binding
          </label>
          <button type="button" disabled={busy || !label.trim() || !when.trim()} onClick={() => void add()} style={{ ...submitBtn, padding: "6px 14px", opacity: busy || !label.trim() || !when.trim() ? 0.5 : 1 }}>
            Add
          </button>
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: T.hold, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// — tie plan INSTALMENTS to construction MILESTONES (off-plan payment-on-progress, "20% at topping-out").
// Display join only: the sealed plan ordinals + the building's timeline are both read-only; the developer sets
// the mutable link per instalment. Editable while preview, frozen at final. Shows nothing if the plan has no
// instalments or the building has no timeline (author the timeline in the building console first).
export function InstalmentMilestoneEditor({ offer, me, onChanged }: { offer: OfferRecord; me: string; onChanged: () => void }) {
  const locked = (offer.contract?.stage ?? "preview") !== "preview";
  const count = offer.seal?.plan?.instalmentCount ?? 0;
  const ties = offer.instalmentMilestones ?? {};
  const [milestones, setMilestones] = useState<{ label: string; when: string }[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const buildingId = offer.display?.buildingId;

  useEffect(() => {
    if (!buildingId) return;
    let live = true;
    fetch(`/api/catalog?building=${encodeURIComponent(buildingId)}&account=${encodeURIComponent(me)}`)
      .then((r) => r.json())
      .then((j: { building?: { constructionTimeline?: { label: string; when: string }[] } }) => {
        if (live) setMilestones(j.building?.constructionTimeline ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [buildingId, me]);

  // Nothing to tie: no instalments in the plan, or no timeline authored on the building.
  if (count < 1 || milestones.length === 0) return null;

  async function set(instalment: number, milestoneLabel: string) {
    setBusy(instalment);
    try {
      await fetch("/api/offers/instalment-milestone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: offer.requestId, viewer: me, instalment, milestoneLabel }),
      });
      onChanged();
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>
        Payment on progress <span style={{ opacity: 0.7 }}>— tie instalments to construction milestones</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
          <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <span style={{ width: 92, opacity: 0.8 }}>Instalment {n}</span>
            {locked ? (
              <span style={{ opacity: 0.7 }}>{ties[String(n)] ? `→ ${ties[String(n)]}` : "—"}</span>
            ) : (
              <select
                value={ties[String(n)] ?? ""}
                disabled={busy === n}
                onChange={(e) => void set(n, e.target.value)}
                style={{ ...input, flex: 1, minWidth: 140 }}
              >
                <option value="">— not tied —</option>
                {milestones.map((m) => (
                  <option key={m.label} value={m.label}>
                    {m.label} ({m.when})
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>
      {locked && <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>Locked — contract is final.</div>}
    </div>
  );
}

// AUTO-INTERVAL date (booking date + n×frequencyDays) as the default, and the desk can pin an explicit date
// (the buyer wanted a specific day, or a weekend/holiday roll). A pinned date is transparent — it renders in
// the S&P §2 to all parties and feeds the payment ledger, never a hidden side-arrangement. Preview-only; the
// server locks it at `final`. The same resolution rule lives server-side in lib/sale-contract.instalmentDueDate
// (date-input → ms is local-midnight; we only ever compare DATES, so the tz offset is immaterial to the day shown).
const DAY_MS_UI = 86_400_000;
function msToDateInput(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dateInputToMs(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const ms = new Date(`${v}T00:00:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}
export function InstalmentDueDateEditor({ offer, me, onChanged }: { offer: OfferRecord; me: string; onChanged: () => void }) {
  const locked = (offer.contract?.stage ?? "preview") !== "preview";
  const count = offer.seal?.plan?.instalmentCount ?? 0;
  const freq = offer.seal?.plan?.frequencyDays ?? 0;
  const overrides = offer.instalmentDueDates ?? {};
  // Anchor matches the server (api/claims/sp + api/payments): the STABLE `offer.at` (c — not
  // confirmed?.at, so the desk's date preview never diverges from the signed/closed S&P §2 + ledger).
  const anchor = offer.at;
  const [busy, setBusy] = useState<number | null>(null);
  // an accepted-but-odd date (warn, e.g. already in the past). Cleared when another row is edited.
  const [msg, setMsg] = useState<{ n: number; text: string; kind: "err" | "warn" } | null>(null);

  // No instalments in the plan → nothing to date.
  if (count < 1) return null;

  // The auto-interval default for ordinal n, or null when the plan carries no frequency (then there is no
  // automatic date and the desk must pin one for the date to appear — the honest "undated" case).
  const autoFor = (n: number): number | null => (anchor > 0 && freq > 0 ? anchor + n * freq * DAY_MS_UI : null);

  async function set(instalment: number, dueAt: number | null) {
    setBusy(instalment);
    setMsg(null);
    try {
      const r = await fetch("/api/offers/instalment-due-date", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: offer.requestId, viewer: me, instalment, dueAt }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Rejected (e.g. before booking / out of order / too far out) — nothing stored; show why, don't refresh.
        setMsg({ n: instalment, text: j?.error || "That date isn't valid for this instalment.", kind: "err" });
        return;
      }
      if (j?.warn) setMsg({ n: instalment, text: j.warn, kind: "warn" });
      onChanged();
    } catch {
      setMsg({ n: instalment, text: "Could not update the due date.", kind: "err" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>
        Instalment due dates <span style={{ opacity: 0.7 }}>— auto-spaced from the plan; pin a specific date if the buyer needs one</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {Array.from({ length: count }, (_, i) => i + 1).map((n) => {
          const over = overrides[String(n)];
          const auto = autoFor(n);
          const effective = typeof over === "number" ? over : auto; // what the contract will show for this line
          const value = typeof effective === "number" ? msToDateInput(effective) : "";
          const pinned = typeof over === "number";
          const rowMsg = msg && msg.n === n ? msg : null;
          return (
            <div key={n} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span style={{ width: 92, opacity: 0.8 }}>Instalment {n}</span>
                {locked ? (
                  <span style={{ opacity: 0.7 }}>{value ? value : "—"}</span>
                ) : (
                  <>
                    <input
                      type="date"
                      value={value}
                      disabled={busy === n}
                      onChange={(e) => {
                        const ms = dateInputToMs(e.target.value);
                        if (ms) void set(n, ms);
                      }}
                      style={{ ...input, minWidth: 150 }}
                    />
                    <span style={{ fontSize: 11, opacity: 0.6 }}>{pinned ? "pinned" : auto ? "auto" : "no date"}</span>
                    {pinned && (
                      <button
                        type="button"
                        disabled={busy === n}
                        onClick={() => void set(n, null)}
                        style={{ ...input, cursor: "pointer", fontSize: 11, padding: "2px 8px" }}
                        title="Revert to the auto-spaced date"
                      >
                        reset
                      </button>
                    )}
                  </>
                )}
              </div>
              {rowMsg && (
                <span style={{ fontSize: 11, marginLeft: 100, color: rowMsg.kind === "err" ? "#f0a0a0" : "#e8c97a" }}>
                  {rowMsg.kind === "err" ? "✕ " : "⚠ "}{rowMsg.text}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {freq < 1 && !locked && (
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
          No payment frequency on this plan — instalments have no automatic date. Pin a date above to state one in the contract.
        </div>
      )}
      {locked && <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>Locked — contract is final.</div>}
    </div>
  );
}

// — the developer sets a DISCOUNT off the price (a fixed amount OR a % of the price). Sibling of
// concessions: off-seal, editable while preview, frozen at final; nets against the price on the S&P. The
// discounted/net figure is computed from the booked price; a value of 0 clears the discount.
export function DiscountEditor({ offer, me, onChanged }: { offer: OfferRecord; me: string; onChanged: () => void }) {
  const money = useMoney();
  const locked = (offer.contract?.stage ?? "preview") !== "preview";
  const cur = offer.discount;
  const [kind, setKind] = useState<"amount" | "percent">(cur?.kind ?? "amount");
  const [value, setValue] = useState(String(cur?.value ?? ""));
  const [note, setNote] = useState(cur?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const price = offer.seal?.plan?.priceUsd ?? 0;
  const valN = Number(value) || 0;
  const amt = kind === "percent" ? Math.round((price * Math.min(100, valN)) / 100) : Math.min(price || valN, Math.round(valN));
  const net = price > 0 ? price - amt : 0;

  async function save(clear = false) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/offers/discount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: offer.requestId, viewer: me, kind, value: clear ? 0 : valN, note }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not save discount.");
      else {
        if (clear) {
          setValue("");
          setNote("");
        }
        onChanged();
      }
    } catch {
      setErr("Could not save discount.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>
        Developer discount <span style={{ opacity: 0.7 }}>— off the price, nets on the agreement</span>
      </div>
      {locked ? (
        <div style={{ fontSize: 12.5 }}>
          {cur
            ? cur.kind === "percent"
              ? `${cur.value}% off${price > 0 ? ` (${money(amt)})` : ""}`
              : `${money(cur.value)} off`
            : "no discount"}
          <span style={{ fontSize: 11.5, opacity: 0.6 }}> (locked — contract is final)</span>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select value={kind} onChange={(e) => setKind(e.target.value as "amount" | "percent")} style={{ ...input, width: 110 }}>
              <option value="amount">Amount ($)</option>
              <option value="percent">Percent (%)</option>
            </select>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type="number"
              step={kind === "percent" ? "0.5" : "1000"}
              placeholder={kind === "percent" ? "e.g. 5" : "e.g. 20000"}
              style={{ ...input, width: 120 }}
            />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="reason (optional)" style={{ ...input, width: 180 }} />
            <button type="button" disabled={busy} onClick={() => void save(false)} style={{ ...submitBtn, padding: "6px 14px", opacity: busy ? 0.5 : 1 }}>
              Save
            </button>
            {cur && (
              <button type="button" disabled={busy} onClick={() => void save(true)} style={{ ...submitBtn, padding: "6px 14px", background: T.bg2, border: `1px solid ${T.borderSoft}`, color: T.dim, opacity: busy ? 0.5 : 1 }}>
                Clear
              </button>
            )}
          </div>
          {price > 0 && valN > 0 && (
            <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 6 }}>
              {money(amt)} off · net {money(net)}
            </div>
          )}
        </>
      )}
      {err && <div style={{ fontSize: 12, color: T.hold, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// — the developer sets the negotiable TRANSFER TAX (rate + buyer/seller split). Optional + shared;
// default 3.6% / 50-50. Editable while preview, frozen at final. Shown on the S&P with both parties' shares.
export function TaxEditor({ offer, me, onChanged }: { offer: OfferRecord; me: string; onChanged: () => void }) {
  const money = useMoney();
  const locked = (offer.contract?.stage ?? "preview") !== "preview";
  const cur = offer.tax;
  const [rate, setRate] = useState(String(cur?.ratePct ?? 3.6));
  const [buyerShare, setBuyerShare] = useState(cur?.buyerSharePct ?? 50);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const price = offer.seal?.plan?.priceUsd ?? 0;
  const rateN = Number(rate) || 0;
  const total = Math.round((price * rateN) / 100);
  const buyerAmt = Math.round((total * buyerShare) / 100);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/offers/tax", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: offer.requestId, viewer: me, ratePct: rateN, buyerSharePct: buyerShare }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not save tax.");
      else onChanged();
    } catch {
      setErr("Could not save tax.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>
        Transfer tax <span style={{ opacity: 0.7 }}>— optional, shared buyer/developer</span>
      </div>
      {locked ? (
        <div style={{ fontSize: 12.5 }}>
          {cur ? `${cur.ratePct}% · Buyer ${cur.buyerSharePct}% / Developer ${100 - cur.buyerSharePct}%` : "default 3.6% · 50/50"}
          <span style={{ fontSize: 11.5, opacity: 0.6 }}> (locked — contract is final)</span>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12.5 }}>
              Rate{" "}
              <input value={rate} onChange={(e) => setRate(e.target.value)} type="number" step="0.1" style={{ ...input, width: 80 }} />%
            </label>
            <label style={{ fontSize: 12.5 }}>
              Buyer share{" "}
              <input value={buyerShare} onChange={(e) => setBuyerShare(Math.max(0, Math.min(100, Number(e.target.value))))} type="number" step="5" style={{ ...input, width: 80 }} />%
            </label>
            <button type="button" disabled={busy} onClick={() => void save()} style={{ ...submitBtn, padding: "6px 14px", opacity: busy ? 0.5 : 1 }}>
              Save
            </button>
          </div>
          {price > 0 && rateN > 0 && (
            <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 6 }}>
              {money(total)} total · Buyer {money(buyerAmt)} / Developer {money(total - buyerAmt)}
            </div>
          )}
        </>
      )}
      {err && <div style={{ fontSize: 12, color: T.hold, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// the developer's S&P CONTRACT stage controls. Walks preview → final → payment_arrived → signed.
// Each step is an off-chain act (no wallet) that POSTs /api/claims/contract; the server enforces the gates
// (final needs the buyer revealed + the KYC-seen ack; payment_arrived needs final). We show the CURRENT stage
// and only the single next action the developer can take, with honest gate hints. Signing itself (the last
// step) rides the later wallet arc, so we don't offer a "sign" button here yet — we stop at payment_arrived.
export function ContractStageControls({ offer, me, onChanged }: { offer: OfferRecord; me: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stage = offer.contract?.stage ?? "preview";
  const revealed = Boolean(offer.unlock?.revealed);

  async function act(action: "final" | "payment_arrived") {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/claims/contract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: offer.requestId, by: me, action }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not update the contract.");
      else onChanged();
    } catch {
      setErr("Could not update the contract.");
    } finally {
      setBusy(false);
    }
  }

  const STAGE_LABEL: Record<string, string> = {
    preview: "Preview — buyer reviewing before deposit",
    final: "Final — ready to sign",
    payment_arrived: "Payment received — valid to sign online",
    signed: "Signed",
  };

  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: T.bg2, border: `1px solid ${T.borderSoft}` }}>
      <div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>
        Contract stage: <span style={{ color: T.text, fontWeight: 600 }}>{STAGE_LABEL[stage]}</span>
      </div>

      {stage === "preview" && (
        <div>
          {!revealed ? (
            <div style={{ fontSize: 12, color: T.dim }}>
              To prepare the final, signable contract (which discloses the buyer&apos;s full identity), first
              reveal the buyer on the <strong>Buyer</strong> tab. The contract stays a masked preview until then.
            </div>
          ) : (
            <>
              {/*  pt-2 — review the buyer's encrypted KYC documents BEFORE finalising. The server also
                  ENFORCES that a headshot + an ID/passport exist before it will advance to "final". */}
              <KycDocsReview requestId={offer.requestId} viewer={me} />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(KYC_SEEN_ACK + "\n\nMark the contract ready to sign?")) void act("final");
                }}
                style={{ ...btnOf("closed"), opacity: busy ? 0.5 : 1, marginTop: 10 }}
              >
                Mark contract final (ready to sign)
              </button>
            </>
          )}
        </div>
      )}

      {stage === "final" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("payment_arrived")}
          style={{ ...btnOf("closed"), opacity: busy ? 0.5 : 1 }}
        >
          Confirm on-contract payment received
        </button>
      )}

      {stage === "payment_arrived" && (
        <div style={{ fontSize: 12.5, color: T.vetted }}>
          ✓ Payment confirmed — this contract is valid to sign online. (Online signing arrives with the signing
          release.)
        </div>
      )}

      {stage === "signed" && <div style={{ fontSize: 12.5, color: T.vetted }}>✓ Contract signed.</div>}

      {err && <div style={{ fontSize: 12, color: T.danger, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

/**
 * The full tailoring control set for one deal, in the agreed order. Both the agent inbox (app/node/page.tsx)
 * and the direct desk (DirectEnquiries.tsx) render this identically so the two channels tailor a deal the
 * SAME way into the SAME S&P. The SaleContractButton + PaymentLedgerPanel are composed by each caller
 * separately (they differ in placement/labels), so they are NOT part of this wrapper.
 */
export function DealTailoringControls({ offer, me, onChanged }: { offer: OfferRecord; me: string; onChanged: () => void }) {
  return (
    <>
      <ConcessionsEditor offer={offer} me={me} onChanged={onChanged} />
      <TimedTermsEditor offer={offer} me={me} onChanged={onChanged} />
      <DiscountEditor offer={offer} me={me} onChanged={onChanged} />
      <TaxEditor offer={offer} me={me} onChanged={onChanged} />
      <InstalmentMilestoneEditor offer={offer} me={me} onChanged={onChanged} />
      <InstalmentDueDateEditor offer={offer} me={me} onChanged={onChanged} />
      <ContractStageControls offer={offer} me={me} onChanged={onChanged} />
    </>
  );
}
