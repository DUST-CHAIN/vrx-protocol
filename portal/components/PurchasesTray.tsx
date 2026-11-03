"use client";

// ── PurchasesTray (Slice B, [[vrx-buyer-purchases-tray]], the design docs) ──────────
// "after payment buyer SURE receives the reservation with the signed online 'draft' S&P — and all
// docs in the app anytime in my purchases tray or somewhere suitable."
//
// A single, always-available buyer surface that consolidates, PER reservation: the Reservation Document (the
// object), the draft S&P (via SaleContractButton once paid + materialized), and an HONEST lifecycle status badge —
// so the docs aren't scattered across chat threads + held-unit cards. The in-app twin of the operator catalog emailing the
// reservation doc to the parties.
//
// Build-ON (don't reinvent): the row reuses the shared SaleContractButton (identical S&P viewer every surface
// shows) for the DRAFT contract; the feed is /api/buyer/purchases (the buyer-scoped read/aggregation, no mint).
//
// The key design point (honest badges): a provisional draft is NEVER presented as a binding contract. Each row
// shows exactly where it is in the lifecycle (reserved → confirmed → deposit paid → ratified), and the S&P link is
// labelled "draft — provisional" + only appears once the deposit is paid AND the offer is materialized. The FINAL
// signed contract (post courier + scan-back + dev-admin sign-off, Slice 5) is a later stage — not claimed here.

import { useCallback, useEffect, useState } from "react";
import SaleContractButton from "./SaleContractButton";
import EvidencePacksPanel from "./EvidencePacksPanel";
import { T } from "@/lib/theme";

type PurchaseStatus = "reserved" | "confirmed" | "window_lapsed" | "deposit_paid" | "ratified";

type Purchase = {
  conversationId: string;
  building: string;
  unit: string;
  priceUsd: number;
  depositUsd: number;
  status: PurchaseStatus;
  revision: number;
  proposedSigningAt: number;
  vrxApprovedAt: number | null;
  confirmedAt: number | null;
  depositDueAt: number | null;
  depositWindowMsLeft: number;
  depositPaidVrx: number | null;
  // ESCROW CUSTODY (Slice 2) — null unless the deposit is in escrow custody (flag VRX_ESCROW_CUSTODY).
  custodyState: "held" | "release_pending" | "released" | "refunded" | null;
  vetoMsLeft: number;
  // OTS DURABILITY (D-) — the Bitcoin-anchor status of this deal's deposit evidence. null when no
  // evidence pack was emitted. `pending` is a NORMAL hours-long state (never a blocker); `proven` = Bitcoin-anchored.
  evidenceAnchor: { status: "pending" | "proven" | "failed"; label: string; count: number } | null;
  spRequestId: string | null;
  at: number;
  updatedAt: number;
};

// Honest badge copy + colour per lifecycle stage (aligns with the on-chain status palette, lib/theme).
const STATUS_META: Record<PurchaseStatus, { label: string; color: string }> = {
  reserved: { label: "Reserved — confirm to start", color: T.dim },
  confirmed: { label: "Confirmed — deposit due", color: T.hold },
  window_lapsed: { label: "Window lapsed — re-confirm", color: T.danger },
  deposit_paid: { label: "Deposit paid", color: T.vetted },
  ratified: { label: "Signing date ratified", color: T.closed },
};

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString()}`;
const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
// Remaining deposit window, coarse (the exact clock lives on the chat chip; the tray just reassures it's live).
function fmtLeft(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m left to pay`;
  return `${mins}m left to pay`;
}

export default function PurchasesTray({ account }: { account: string }) {
  const [rows, setRows] = useState<Purchase[] | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await fetch(`/api/buyer/purchases?account=${encodeURIComponent(account)}`).then((r) => r.json());
      setRows(Array.isArray(j.purchases) ? j.purchases : []);
      setErr(false);
    } catch {
      setErr(true);
    }
  }, [account]);

  useEffect(() => {
    void load();
    // Gentle visible-tab poll so a reservation issued/paid in a chat thread appears here without a reload.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => clearInterval(t);
  }, [load]);

  // Nothing to show until the buyer has at least one reservation — stay out of the way for a fresh buyer.
  if (err || !rows || rows.length === 0) return null;

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px", letterSpacing: -0.3 }}>My purchases</h2>
      <p style={{ opacity: 0.7, fontSize: 13, margin: "0 0 14px", lineHeight: 1.5, maxWidth: 620 }}>
        Your reservations and documents, all in one place. A draft Sale &amp; Purchase agreement is sealed digitally
        when you pay the deposit — it stays provisional until the paper contract is signed and scanned back.
      </p>
      <div style={{ display: "grid", gap: 12 }}>
        {rows.map((p) => (
          <PurchaseRow key={`${p.building}/${p.unit}/${p.conversationId}`} p={p} account={account} onChange={load} />
        ))}
      </div>
      {/* the buyer's own encrypted evidence copies (the durability leg made tangible): set up a delivery key +
          list the sealed packs VRX holds for them. Caller-scoped; degrades silently. Shown once below the rows. */}
      <EvidencePacksPanel account={account} />
    </section>
  );
}

// Coarse veto countdown — the exact clock lives server-side; this just reassures the window is live.
function fmtVetoLeft(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m left to veto`;
  if (mins >= 1) return `${mins}m left to veto`;
  return "closing shortly";
}

function PurchaseRow({ p, account, onChange }: { p: Purchase; account: string; onChange: () => void }) {
  const meta = STATUS_META[p.status];
  const [busy, setBusy] = useState<null | "veto" | "waive">(null);
  const [escrowErr, setEscrowErr] = useState<string | null>(null);

  // The buyer's escrow controls (veto = refund me; waive = fast-close, release now). Both fire /api/escrow; the
  // server re-proves the buyer + the custody state (these buttons are advisory UI — the route is the authority).
  const escrowAct = useCallback(
    async (action: "veto" | "waive", failMsg: string) => {
      setBusy(action);
      setEscrowErr(null);
      try {
        const r = await fetch("/api/escrow", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ account, conversationId: p.conversationId, action, unit: p.unit }),
        }).then((res) => res.json().catch(() => ({})));
        if (!r?.ok) setEscrowErr(failMsg);
        onChange();
      } catch {
        setEscrowErr("Couldn't reach the escrow service. Please try again.");
      } finally {
        setBusy(null);
      }
    },
    [account, p.conversationId, p.unit, onChange]
  );

  const veto = useCallback(
    () => escrowAct("veto", "Could not veto — the release may have already finalized. Refreshing…"),
    [escrowAct]
  );
  const waive = useCallback(
    () => escrowAct("waive", "Could not release early — the window may have already closed. Refreshing…"),
    [escrowAct]
  );

  const vetoOpen = p.custodyState === "release_pending" && p.vetoMsLeft > 0;
  // The escrow guarantee is VISIBLE on any deposit that has entered custody (held → terminal) — D- model #1.
  const escrowProtected = p.custodyState !== null;

  return (
    <div
      style={{
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>
          <span style={{ fontFamily: T.mono }}>{p.unit}</span>{" "}
          <span style={{ opacity: 0.6, fontWeight: 400 }}>· {p.building}</span>
        </strong>
        {/* The escrow GUARANTEE made visible (D- model #1): every direct deposit routes through VRX custody —
            the money is protected until the deal proceeds, not sitting in the developer's wallet. Shown on any
            deposit that has entered custody (not an opt-in per deal — a platform promise, like the VRX fee). */}
        {escrowProtected && (
          <span
            title="Your deposit is held in VRX escrow until the deal proceeds — a VRX platform guarantee on every reservation."
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.vetted,
              background: "rgba(74,222,128,0.10)",
              border: `1px solid ${T.vetted}`,
              borderRadius: 999,
              padding: "2px 9px",
              whiteSpace: "nowrap",
            }}
          >
            🛡 Escrow-protected ✓
          </span>
        )}
        {/* OTS DURABILITY (D-): the Bitcoin-anchor state of this deal's deposit evidence. `pending` is a
            NORMAL hours-long state (the in-system record is already final; the Bitcoin proof lands later) — so it's
            phrased as reassurance, NEVER a warning/blocker. Only shown once an evidence pack exists. */}
        {p.evidenceAnchor && p.evidenceAnchor.status !== "failed" && (
          <span
            title={
              p.evidenceAnchor.status === "proven"
                ? "This deposit's sealed evidence is permanently anchored to the Bitcoin blockchain — an independently-verifiable record that outlives VRX."
                : "This deposit's sealed evidence has been submitted for Bitcoin anchoring. Confirmation lands in a few hours — your record is already final; this is added durable proof."
            }
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: p.evidenceAnchor.status === "proven" ? T.vetted : T.dim,
              background: p.evidenceAnchor.status === "proven" ? "rgba(74,222,128,0.10)" : "rgba(148,163,184,0.10)",
              border: `1px solid ${p.evidenceAnchor.status === "proven" ? T.vetted : T.border}`,
              borderRadius: 999,
              padding: "2px 9px",
              whiteSpace: "nowrap",
            }}
          >
            {p.evidenceAnchor.status === "proven" ? "⛓ Bitcoin-anchored" : "⛓ Sealing to Bitcoin…"}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11.5,
            fontWeight: 600,
            color: meta.color,
            border: `1px solid ${meta.color}`,
            borderRadius: 999,
            padding: "2px 9px",
            whiteSpace: "nowrap",
          }}
        >
          {meta.label}
        </span>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 8, fontSize: 12.5 }}>
        <span>
          Price <strong style={{ fontFamily: T.mono }}>{fmtUsd(p.priceUsd)}</strong>
        </span>
        <span>
          Deposit <strong style={{ fontFamily: T.mono }}>{fmtUsd(p.depositUsd)}</strong>
          <span style={{ opacity: 0.55 }}> (deductible)</span>
        </span>
        <span>
          Signing by <strong>{fmtDate(p.proposedSigningAt)}</strong>
          {p.vrxApprovedAt ? <span style={{ color: T.vetted }}> ✓ ratified</span> : <span style={{ opacity: 0.55 }}> (proposed)</span>}
        </span>
        {p.revision > 1 && <span style={{ opacity: 0.55 }}>rev. {p.revision}</span>}
      </div>

      {/* Deposit-window reassurance while the clock is running (the chat chip owns the live countdown + pay). */}
      {p.status === "confirmed" && p.depositWindowMsLeft > 0 && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: T.hold }}>{fmtLeft(p.depositWindowMsLeft)}</p>
      )}
      {p.status === "window_lapsed" && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: T.danger }}>
          The 2-hour payment window lapsed. Re-confirm in the chat to restart it.
        </p>
      )}

      {/* ESCROW CUSTODY (Slice 2) — the money is held in escrow, not yet the developer's. While the
          developer's release request is pending, the buyer sees a live veto window + a "Veto release" control
          that refunds the deposit. Only rendered when the deposit is actually in custody (flag ON). */}
      {p.custodyState === "held" && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: T.dim }}>
          🔒 Your deposit is held in escrow — released to the developer only when the deal proceeds.
        </p>
      )}
      {p.custodyState === "release_pending" && (
        <div style={{ marginTop: 10, padding: "9px 11px", background: "rgba(232,184,75,0.08)", border: `1px solid ${T.hold}`, borderRadius: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: T.hold, fontWeight: 600 }}>
            The developer requested release of your escrowed deposit.
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 11.5, opacity: 0.8 }}>
            {vetoOpen
              ? `If the deal has fallen through, you can veto to get your deposit back — or release it now for a fast close. ${fmtVetoLeft(p.vetoMsLeft)}.`
              : "The veto window has closed — the deposit will release to the developer."}
          </p>
          {vetoOpen && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button
                onClick={veto}
                disabled={busy !== null}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: T.danger,
                  background: "transparent",
                  border: `1px solid ${T.danger}`,
                  borderRadius: 8,
                  padding: "5px 12px",
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy === "veto" ? "Vetoing…" : "Veto release — refund my deposit"}
              </button>
              {/* WAIVE (D-): the buyer voluntarily gives up the rest of their veto window for a fast close —
                  release the escrowed deposit to the developer now. The buyer's own choice; never a developer lever. */}
              <button
                onClick={waive}
                disabled={busy !== null}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: T.vetted,
                  background: "transparent",
                  border: `1px solid ${T.vetted}`,
                  borderRadius: 8,
                  padding: "5px 12px",
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy === "waive" ? "Releasing…" : "Release now — close fast"}
              </button>
            </div>
          )}
          {escrowErr && <p style={{ margin: "6px 0 0", fontSize: 11, color: T.danger }}>{escrowErr}</p>}
        </div>
      )}
      {p.custodyState === "refunded" && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: T.danger }}>
          ↩ Your escrowed deposit was refunded.
        </p>
      )}
      {p.custodyState === "released" && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: T.vetted }}>
          ✓ Your deposit was released to the developer.
        </p>
      )}

      {/* The DRAFT S&P — only once the deposit is paid AND the offer is materialized (spRequestId present). Clearly
          labelled provisional; the shared viewer shows the buyer their own identity in full. */}
      {p.spRequestId ? (
        <div style={{ marginTop: 10 }}>
          <SaleContractButton
            requestId={p.spRequestId}
            viewer={account}
            label="View draft Sale & Purchase agreement"
            compact
          />
          <p style={{ margin: "5px 0 0", fontSize: 10.5, opacity: 0.6, lineHeight: 1.5 }}>
            Draft — digitally sealed, provisional until the paper contract is signed and scanned back.
            {p.depositPaidVrx ? ` Deposit paid in $VRX.` : ""}
          </p>
        </div>
      ) : (
        p.status !== "reserved" &&
        p.status !== "confirmed" &&
        p.status !== "window_lapsed" && (
          <p style={{ margin: "10px 0 0", fontSize: T.fsMeta, opacity: 0.55 }}>Your sale agreement is being prepared…</p>
        )
      )}
    </div>
  );
}
