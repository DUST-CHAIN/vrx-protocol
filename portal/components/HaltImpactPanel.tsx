// HaltImpactPanel — the developer's HALT-IMPACT COCKPIT (Part A3, the design docs).
//
// The symmetric half of the halt lever: where BuildingHaltPanel lets the developer PAUSE the building, this
// shows them WHAT A PAUSE TOUCHES — every existing deal on the building they may need to break / refund /
// cancel / renegotiate, each with its unit, stage, counterparty, and the money already owed on it. A support
// tool for a hard moment ("hopefully never"): see the full picture so nothing is missed.
//
// SAME affected-set resolver as A2 (lib/halt-affected), projected for the developer via /api/catalog/halt-impact.
// It reads live whether or not a halt is in effect — so it also works as a PRE-HALT PREVIEW (the developer can
// see the impact of a pause they're considering before they confirm it).
//
// IT SURFACES, IT DOES NOT INSTRUCT: plain, non-judgmental copy. VRX lists the facts + what's owed; it
// never tells the developer to refund/cancel, nor promises an outcome. Those conversations happen with the
// counterparty (the relationship channel, Part D — "ask more" lands with A2/B).
//
// PRIVACY: the agency + agent are B2B partners, always shown. The BUYER line is shown ONLY as far
// as the developer is already entitled — the route applies the SAME mask/reveal gate (developerView) the inbox
// uses, so a still-masked buyer reads as "identity protected" here too. This panel never widens disclosure.
//
// Self-contained like BuildingHaltPanel: pass the developer + building; it loads on mount. Read-only (no writes).

"use client";

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";
import { useMoneyFull } from "@/lib/currency";

type DealStage = "confirmed_sale" | "live_booking" | "open_negotiation";

type ImpactDeal = {
  requestId: string;
  unitLabel: string;
  stage: DealStage;
  agency: string | null;
  agent: string;
  buyer: string | null;
  buyerMasked: boolean;
  obligation: {
    commissionPct: number;
    commissionUsd: number;
    feePct: number;
    feeUsd: number;
    agency: string;
    kind: "earned" | "prospective";
  } | null;
};

type ImpactResponse = {
  building: string;
  buildingId: string;
  affectsExistingDeals: boolean;
  count: number;
  totals: { commissionUsd: number; feeUsd: number };
  deals: ImpactDeal[];
};

// Plain-words stage copy (no contract words) + a tone colour.
const STAGE_COPY: Record<DealStage, { label: string; colour: string }> = {
  confirmed_sale: { label: "Confirmed sale", colour: T.danger },
  live_booking: { label: "Booking in progress", colour: T.hold },
  open_negotiation: { label: "In negotiation", colour: T.dim },
};

export default function HaltImpactPanel({
  developer,
  building,
  buildingName,
  /** Bump this to force a reload (e.g. the parent just asserted/lifted a halt). */
  refreshKey,
}: {
  developer: string;
  building: string;
  buildingName?: string;
  refreshKey?: number;
}) {
  const [data, setData] = useState<ImpactResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const money = useMoneyFull();

  const load = useCallback(async () => {
    if (!developer || !building) return;
    try {
      const qs = new URLSearchParams({ building, account: developer }).toString();
      const r = await fetch(`/api/catalog/halt-impact?${qs}`);
      if (!r.ok) {
        setLoaded(true);
        return;
      }
      setData((await r.json()) as ImpactResponse);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [developer, building]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const name = buildingName || building;
  const count = data?.count ?? 0;

  // Nothing yet (or no affected deals) — a quiet reassuring line, collapsed by default.
  const headline =
    count === 0
      ? `No existing deals are tied to ${name} — a pause here affects only new bookings.`
      : `${count} existing deal${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} tied to ${name}. A pause does not cancel ${count === 1 ? "it" : "them"} — this is what it touches.`;

  return (
    <section
      style={{
        marginTop: 16,
        padding: "12px 16px 16px",
        borderRadius: 12,
        background: T.panel,
        border: `1px solid ${count > 0 ? T.hold + "55" : T.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>📋 What a pause would affect</h3>
        {count > 0 && (
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 999,
              background: T.hold + "22",
              color: T.hold,
            }}
          >
            {count} existing deal{count === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {!loaded ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, marginTop: 10 }}>Loading…</p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, opacity: 0.75, margin: "8px 0 0", lineHeight: 1.5 }}>{headline}</p>

          {count > 0 && (
            <>
              {/* Totals of what's ALREADY OWED across the affected deals (H1 — a pause never erases this). */}
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  flexWrap: "wrap",
                  marginTop: 10,
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: T.panel2,
                  border: `1px solid ${T.borderSoft}`,
                }}
              >
                <div>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>Agency commission owed</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{money(data?.totals.commissionUsd ?? 0)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>VRX fee owed</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{money(data?.totals.feeUsd ?? 0)}</div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                style={{ background: "none", border: "none", color: T.dim, fontSize: 12.5, cursor: "pointer", padding: 0, marginTop: 10 }}
              >
                {open ? "Hide" : "Show"} the {count} deal{count === 1 ? "" : "s"}
              </button>

              {open && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  {(data?.deals ?? []).map((d) => {
                    const s = STAGE_COPY[d.stage];
                    return (
                      <div
                        key={d.requestId}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 10,
                          background: T.panel2,
                          border: `1px solid ${s.colour}33`,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{d.unitLabel}</span>
                          <span style={{ fontSize: 11.5, fontWeight: 600, color: s.colour }}>{s.label}</span>
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4, lineHeight: 1.5 }}>
                          {/* Counterparty — agency/agent are partners (shown); buyer is mask-gated. */}
                          <span style={{ opacity: 0.6 }}>Partner:</span>{" "}
                          {d.agency ? d.agency : d.agent || "—"}
                          {d.agency && d.agent ? ` (${d.agent})` : ""}
                          <br />
                          <span style={{ opacity: 0.6 }}>Buyer:</span>{" "}
                          {d.buyer ? d.buyer : d.buyerMasked ? <em style={{ opacity: 0.7 }}>identity protected</em> : "—"}
                        </div>
                        {d.obligation ? (
                          <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                            <span style={{ opacity: 0.6 }}>
                              {d.obligation.kind === "earned" ? "Owed on this sale:" : "Would be owed if it closes:"}
                            </span>{" "}
                            commission {money(d.obligation.commissionUsd)} ({d.obligation.commissionPct}%) · VRX fee{" "}
                            {money(d.obligation.feeUsd)} ({d.obligation.feePct}%)
                          </div>
                        ) : (
                          <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 6 }}>No commission resolved for this deal.</div>
                        )}
                      </div>
                    );
                  })}
                  <p style={{ fontSize: 11, opacity: 0.5, margin: "4px 0 0", lineHeight: 1.5 }}>
                    This is a summary, not instructions. What happens to each deal is between you and the
                    counterparty — VRX keeps the record and can relay a message.
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
