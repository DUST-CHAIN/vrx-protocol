"use client";

// The "View S&P contract" button + modal — the buyer-facing Sale & Purchase viewer (arc).
//
// the key insight: the buyer wants to SEE the full populated contract BEFORE paying the deposit. So this
// is a READ surface available at the booking/offer stage on every party's app (developer /node, agency /agency,
// agent /agent — and the dedicated buyer app later). One shared component so all surfaces show the IDENTICAL
// document: it fetches the server-assembled SaleContractInput (scoped to the caller, masking applied for
// a developer viewer), renders it with renderSaleContract + the shared <ContractModal>, and prints/PDFs it.
//
// The second signatory on an S&P is the BUYER (not an agency), so we pass role labels overriding the modal's
// defaults. The button quietly hides if the booking has no offer on file (nothing to render).

import { useCallback, useState } from "react";
import { ContractModal } from "./ContractModal";
import { renderSaleContract, reviewAnnotations, type SaleContractInput } from "@/lib/sale-contract";
import { T } from "@/lib/theme";

export default function SaleContractButton({
  requestId,
  viewer,
  label = "View S&P contract",
  compact = false,
}: {
  /** The opaque on-chain booking id. */
  requestId: string;
  /** The caller's account — the server scopes the assembly to this party (developer/agent/agency). */
  viewer: string;
  label?: string;
  /** A smaller inline chip style (for a row), vs the default button. */
  compact?: boolean;
}) {
  const [input, setInput] = useState<SaleContractInput | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/claims/sp?requestId=${encodeURIComponent(requestId)}&viewer=${encodeURIComponent(viewer)}`
      );
      const j = await r.json();
      if (!r.ok) {
        setErr(j?.error || "Could not load the contract.");
        return;
      }
      setInput(j.input as SaleContractInput);
      setOpen(true);
    } catch {
      setErr("Could not load the contract.");
    } finally {
      setBusy(false);
    }
  }, [requestId, viewer]);

  const style: React.CSSProperties = compact
    ? {
        padding: "3px 10px",
        borderRadius: 6,
        border: `1px solid ${T.borderSoft}`,
        background: T.panel,
        color: T.dim,
        cursor: "pointer",
        fontSize: 12,
      }
    : {
        padding: "7px 14px",
        borderRadius: 8,
        border: `1px solid ${T.border}`,
        background: T.bg2,
        color: T.text,
        cursor: "pointer",
        fontSize: 13,
      };

  return (
    <>
      <button type="button" onClick={load} disabled={busy} style={{ ...style, opacity: busy ? 0.5 : 1 }}>
        {busy ? "Loading…" : `📄 ${label}`}
      </button>
      {err && <span style={{ color: T.danger, fontSize: 12, marginLeft: 8 }}>{err}</span>}
      {open && input && (
        <ContractModal
          doc={renderSaleContract(input)}
          review={reviewAnnotations(input)}
          roles={{ party1: "The Developer (Vendor)", party2: "The Buyer" }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
