"use client";

//  slice 5 — the BUYER chooses how they'll pay, from the developer's accepted menu for this building.
//
// The developer authors the accepted-payment options per building's seller (slices 1/3); the buyer picks one
// here. The pick lands on the offer (off-seal, frozen at `final`) and makes the S&P §2 state THAT destination
// as the binding payment term. Reads the SAME server-assembled SaleContractInput the contract viewer uses
// (so the menu and the agreed pick can never diverge from the document), and posts the choice to
// /api/offers/payment-option (buyer/agent-scoped, validates the id, 409s once the contract is final).
//
// Renders nothing until the deal actually has ≥1 accepted method — no empty section (same discipline as the
// rest of the buyer funnel). A destination is off-chain payee data; choosing one never moves money in-app.

import { useCallback, useEffect, useState } from "react";
import type { SaleContractInput } from "@/lib/sale-contract";
import type { PaymentOption } from "@/lib/catalog-client";
import { T } from "@/lib/theme";

export default function PaymentOptionPicker({ requestId, viewer }: { requestId: string; viewer: string }) {
  const [options, setOptions] = useState<PaymentOption[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [locked, setLocked] = useState(false); // contract at final+ → the pick is frozen
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/claims/sp?requestId=${encodeURIComponent(requestId)}&viewer=${encodeURIComponent(viewer)}`
      );
      const j = await r.json();
      if (r.ok && j?.input) {
        const input = j.input as SaleContractInput;
        setOptions(input.developer?.seller?.paymentOptions ?? []);
        setChosen(input.agreedPaymentOptionId ?? null);
        setLocked((input.stage ?? "preview") !== "preview");
      }
    } catch {
      /* leave as-is */
    } finally {
      setLoaded(true);
    }
  }, [requestId, viewer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function pick(optionId: string | null) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/offers/payment-option", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, viewer, optionId }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not save your choice.");
      else setChosen(j.paymentOptionId ?? null);
    } catch {
      setErr("Could not save your choice.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded || options.length === 0) return null;

  return (
    <div style={{ marginTop: 10, border: `1px solid ${T.borderSoft}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>How you'll pay</div>
      <div style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5, marginBottom: 10 }}>
        Choose how you'll make payments for this property. Your choice is stated on your agreement. You pay to
        the destination shown and keep a record of each payment — nothing is charged in the app.
      </div>
      {options.map((o) => {
        const on = o.id === chosen;
        return (
          <label
            key={o.id}
            style={{
              display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px", marginBottom: 6,
              borderRadius: 7, cursor: locked ? "default" : "pointer",
              border: `1px solid ${on ? T.accent : T.borderSoft}`, background: on ? T.bg2 : "transparent",
            }}
          >
            <input
              type="radio" name={`pm-${requestId}`} checked={on} disabled={busy || locked}
              onChange={() => void pick(o.id)} style={{ marginTop: 3 }}
            />
            <span>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{o.label}</span>
              <span style={{ fontSize: 11.5, opacity: 0.7, display: "block" }}>{o.destination}</span>
              {o.instructions && <span style={{ fontSize: 11, opacity: 0.55, display: "block" }}>{o.instructions}</span>}
            </span>
          </label>
        );
      })}
      {!locked && chosen && (
        <button type="button" onClick={() => void pick(null)} disabled={busy}
          style={{ fontSize: 11, background: "none", border: "none", color: T.dim, cursor: "pointer", padding: "2px 0", textDecoration: "underline" }}>
          clear my choice
        </button>
      )}
      {locked && <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>Your agreement is finalised — the payment method is locked.</div>}
      {err && <div style={{ fontSize: 11.5, color: T.danger, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
