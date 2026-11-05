// ── Shared contract viewer (extracted; generalized for the S&P) ─────────────────
// The read-only "View contract" modal: renders a ContractDoc as a paper-styled sheet with Print / Save-as-PDF
// via `window.print`. Lives here as a component so every surface shows the IDENTICAL document from the same
// generator. Two consumers today, both producing the same ContractDoc shape:
//   • AGENCY AGREEMENT — pass `g` (a ContractInput); the modal renders it via `renderContract` (lib/contract).
//     Shown to the developer (/node) + agency (/agency); the developer authors it, the agency only reads it.
//   • SALE & PURCHASE (S&P) — pass a pre-rendered `doc` (from renderSaleContract, lib/sale-contract) + role
//     labels (the second signatory is the BUYER, not an agency). Shown to the buyer/developer/agent BEFORE the
//  deposit so the buyer sees the full populated contract. Same paper sheet, print, seal block.
// No new deps — the print stylesheet (`.vrx-contract-print`) scopes printing to the sheet alone.

"use client";

import { useState } from "react";
import { renderContract, type ContractInput, type ContractSignatory, type ContractDoc } from "@/lib/contract";
import type { ReviewFlag } from "@/lib/sale-contract";
import { submitBtn } from "@/lib/ui";

// Build a brief, readable PDF filename from the document — the browser's "Save as PDF" uses document.title
// as the default file name, so we swap it in just for the print and restore it after. Shape:
//   "Agency Agreement - Summit Estates & a global agency - SIGNED - 05fa3af6"
//   "Sale and Purchase Agreement - Summit Estates & J. Doe - DRAFT - 9b1c0f22"
// (status word is human: SIGNED for an executed agreement, DRAFT/UNSIGNED otherwise). Title comes from the
// doc itself so it's correct for any contract kind. File-system-safe.
function contractFileTitle(doc: ContractDoc): string {
  const statusWord = doc.execution.signed ? "SIGNED" : doc.execution.verified ? "DRAFT" : "UNSIGNED";
  const a = doc.execution.developer.name;
  const b = doc.execution.agency.name;
  const ref = doc.execution.sealHashFull.slice(0, 8);
  // Title-case the doc title for the filename ("AGENCY AGREEMENT" → "Agency Agreement").
  const kind = doc.title.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase());
  const raw = `${kind} - ${a} & ${b} - ${statusWord} - ${ref}`;
  // strip characters most OSes reject in filenames, collapse whitespace
  return raw.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Props: supply EITHER `g` (an agency-agreement ContractInput — rendered via renderContract) OR a pre-rendered
 * `doc` (e.g. from renderSaleContract). `roles` overrides the two signature-slot labels (default developer /
 * agency; the S&P passes "The Developer (Vendor)" / "The Buyer"). `onClose` closes the modal.
 */
export function ContractModal({
  g,
  doc: docProp,
  roles,
  review,
  onClose,
}: {
  g?: ContractInput;
  doc?: ContractDoc;
  roles?: { party1: string; party2: string };
  /**  review mode — the deal-specific QA checklist (filled/missing/withheld). When supplied, a
   *  "Review" toggle appears that shows the checklist panel so the reviewer can verify what's specific to
   *  this deal and what's still blank before signing. Screen-only (never printed). S&P only today. */
  review?: ReviewFlag[];
  onClose: () => void;
}) {
  const [showReview, setShowReview] = useState(false);
  const doc = docProp ?? renderContract(g as ContractInput);
  const role1 = roles?.party1 ?? "The Developer";
  const role2 = roles?.party2 ?? "The Agency";
  // Execution is numbered one past the LAST numbered body section. The leading sections (Parties, Recitals)
  // are unnumbered, so count by reading the highest "N." heading prefix rather than the array length — correct
  // for the agency agreement (…6. Amendments → 7. Execution) and the S&P whether or not it has a Furniture
  // section (…5. Amendments → 6. Execution, or …6. Amendments → 7. Execution).
  const lastNumbered = doc.sections.reduce((max, s) => {
    const m = /^(\d+)\./.exec(s.heading);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  const execNo = lastNumbered + 1;

  // Print with a good PDF name: set document.title to the readable contract title, print, then restore it.
  function printContract() {
    const prev = document.title;
    document.title = contractFileTitle(doc);
    const restore = () => {
      document.title = prev;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
    // Fallback restore in case afterprint doesn't fire (some browsers on cancel).
    setTimeout(restore, 1500);
  }

  return (
    <div
      onClick={onClose}
      className="vrx-contract-overlay"
      style={{ position: "fixed", inset: 0, background: "rgba(4,7,12,0.78)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", overflow: "auto", padding: "32px 16px" }}
    >
      {/* Print scope: hide everything, then reveal only the contract sheet, at full width on paper. */}
      {/* Mobile: the wide outer frame + sheet padding wasted most of a phone's width, leaving a sliver
 for the text. Thin the overlay gutter + the sheet padding on narrow screens so the document
          gets the room. Pure presentation; no layout logic. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        .vrx-contract-print, .vrx-contract-print * { visibility: visible !important; }
        .vrx-contract-print { position: absolute !important; inset: 0 !important; margin: 0 !important; box-shadow: none !important; border: none !important; max-width: none !important; width: auto !important; background: #fff !important; color: #111 !important; }
        .vrx-contract-noprint { display: none !important; }
      }
      @media (max-width: 640px) {
        .vrx-contract-overlay { padding: 10px 6px !important; }
        .vrx-contract-print { padding: 22px 16px !important; border-radius: 8px !important; }
      }`}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        className="vrx-contract-print"
        style={{ position: "relative", overflow: "hidden", background: "#faf9f6", color: "#1a1a1a", width: "min(820px, 100%)", borderRadius: 10, padding: "48px 56px", boxShadow: "0 24px 80px rgba(0,0,0,0.5)", fontFamily: "Georgia, 'Times New Roman', serif", lineHeight: 1.6 }}
      >
        {/* DRAFT / UNSIGNED watermark — a big diagonal stamp across the whole sheet when the agreement is NOT
            yet executed by both parties, so a printed or saved PDF is unmistakably marked. Prints too. */}
        {!doc.execution.signed && (
          <div aria-hidden style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 2 }}>
            <div style={{ transform: "rotate(-30deg)", fontSize: 120, fontWeight: 800, letterSpacing: 8, color: "rgba(154,42,42,0.12)", textTransform: "uppercase", whiteSpace: "nowrap", fontFamily: "Arial, sans-serif" }}>
              {doc.execution.verified ? "Draft" : "Unsigned"}
            </div>
          </div>
        )}
        <div style={{ position: "relative", zIndex: 1 }}>
        {/* Action row (mobile): wraps, and Close is a compact round "×" so a long primary label
            ("Print / Save as PDF") can't force the row oversized on a phone. */}
        <div className="vrx-contract-noprint" style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
          {review && review.length > 0 && (
            <button
              type="button"
              onClick={() => setShowReview((v) => !v)}
              style={{ ...submitBtn, padding: "7px 14px", fontSize: 13, background: showReview ? "#2e2a12" : "#1c2412", color: showReview ? "#e8dca0" : "#b9d08c" }}
            >
              {showReview ? "Hide review" : "Review fields"}
            </button>
          )}
          <button type="button" onClick={printContract} style={{ ...submitBtn, padding: "7px 14px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}>Print / Save as PDF</button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            style={{ width: 34, height: 34, flexShrink: 0, borderRadius: 999, border: "1px solid #3a2a2a", background: "#2a1c1c", color: "#e0b0b0", fontSize: 18, lineHeight: 1, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            ×
          </button>
        </div>

        {/*  REVIEW PANEL — screen-only QA checklist of the deal-specific fields: what's auto-filled vs.
 still blank vs. deliberately withheld. Lets the developer/agency verify at a glance before
            signing. Never printed (vrx-contract-noprint). */}
        {showReview && review && review.length > 0 && (
          <div className="vrx-contract-noprint" style={{ marginBottom: 24, padding: "14px 16px", background: "#eef0f3", border: "1px solid #d4d8df", borderRadius: 8 }}>
            <div style={{ fontFamily: "Arial, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: "#3a3f48", marginBottom: 10 }}>
              REVIEW — deal-specific fields ({review.filter((f) => f.state === "missing").length} to complete)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
              {review.map((f) => {
                const tone =
                  f.state === "filled"
                    ? { bg: "#e4f3e4", bar: "#2f8f3f", mark: "✓", markColor: "#2f8f3f" }
                    : f.state === "withheld"
                    ? { bg: "#eceef1", bar: "#8a8f98", mark: "•", markColor: "#6a6f78" }
                    : { bg: "#fbf3cf", bar: "#c9a52a", mark: "⚠", markColor: "#9a7a10" };
                //  (mobile): wrap + a flexible (not rigid 150px) label so a review row fits a phone —
                // the rigid minWidth pushed the value off-screen (: review view half-clipped).
                return (
                  <div key={f.key} style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "2px 10px", padding: "6px 10px", background: tone.bg, borderLeft: `3px solid ${tone.bar}`, borderRadius: 4, fontFamily: "Arial, sans-serif" }}>
                    <span style={{ color: tone.markColor, fontWeight: 700, fontSize: 13, width: 14, flexShrink: 0 }}>{tone.mark}</span>
                    <span style={{ fontSize: 13, color: "#2a2e34", flex: "1 1 150px", minWidth: 0, fontWeight: 600 }}>{f.label}</span>
                    <span style={{ fontSize: 13, color: f.state === "missing" ? "#9a7a10" : "#3a3f48", flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>
                      {f.state === "missing" ? "to be completed before signing" : f.value ?? "recorded"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <h1 style={{ fontSize: 24, letterSpacing: 2, textAlign: "center", margin: "0 0 4px" }}>{doc.title}</h1>
        <p style={{ textAlign: "center", fontSize: 13.5, opacity: 0.7, margin: "0 0 32px" }}>{doc.dateline}</p>

        {doc.sections.map((s) => (
          <section key={s.heading} style={{ marginBottom: 22 }}>
            <h2 style={{ fontSize: 15.5, margin: "0 0 8px", fontWeight: 700 }}>{s.heading}</h2>
            {s.body.map((p, i) => (
              <p key={i} style={{ margin: "0 0 7px", fontSize: 14 }}>{p}</p>
            ))}
          </section>
        ))}

        {/* Execution / seal block — the ✓Vetted digital duplicate+signatures. */}
        <section style={{ marginTop: 28, borderTop: "2px solid #ccc5b4", paddingTop: 18 }}>
          <h2 style={{ fontSize: 15.5, margin: "0 0 8px", fontWeight: 700 }}>{execNo}. Execution</h2>
          {doc.execution.lines.map((l, i) => (
            <p key={i} style={{ margin: "0 0 7px", fontSize: 13.5, color: i === 0 && !doc.execution.verified ? "#9a2a2a" : "#1a1a1a" }}>{l}</p>
          ))}

          {/* The FULL seal reference — this hash IS the cryptographic proof (re-hash of the sealed terms +
              identities). It's the verifiable artifact today; the on-chain co-signature txn id is added here
 when the on-chain signing arc lands. Shown in full (monospace) so a holder can verify it. */}
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#f1efe8", border: "1px solid #ddd8cb", borderRadius: 6 }}>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 3, fontFamily: "Arial, sans-serif", letterSpacing: 0.3 }}>SEAL REFERENCE (the cryptographic proof of this document)</div>
            <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, wordBreak: "break-all", color: "#1a1a1a" }}>{doc.execution.sealHashFull}</div>
          </div>

          <div style={{ display: "flex", gap: 48, marginTop: 36, flexWrap: "wrap" }}>
            <Signature slot={doc.execution.developer} role={role1} />
            <Signature slot={doc.execution.agency} role={role2} />
          </div>
        </section>
        </div>
      </div>
    </div>
  );
}

// One signature slot. When the party has signed (agreement executed) we "ink" the line with their vetted-
// identity proof reference in semi-transparent blue — a visible, non-empty signature that reads as signed on
// screen AND on a printed PDF. If not signed, the line stays blank (we never fake a signature).
function Signature({ slot, role }: { slot: ContractSignatory; role: string }) {
  const inkBlue = "rgba(26, 60, 158, 0.72)"; // semi-transparent blue "ink"
  return (
    <div style={{ flex: "1 1 240px" }}>
      <div style={{ borderBottom: "1px solid #1a1a1a", paddingBottom: 4, minHeight: 40, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        {slot.signed ? (
          <>
            {/* The "ink" signature: the party's name in a script-ish blue, then its proof reference beneath. */}
            <div style={{ fontFamily: "'Segoe Script', 'Brush Script MT', cursive", fontSize: 22, color: inkBlue, lineHeight: 1.1 }}>{slot.name}</div>
            {slot.proofRef && (
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 9.5, color: inkBlue, wordBreak: "break-all", marginTop: 2 }}>
                ✓ signed · id {slot.proofRef}
              </div>
            )}
          </>
        ) : (
          <span style={{ fontSize: 12, opacity: 0.6, fontStyle: "italic" }}>awaiting signature</span>
        )}
      </div>
      <div style={{ fontSize: 13, marginTop: 6 }}>{slot.name}</div>
      <div style={{ fontSize: 12, opacity: 0.6 }}>{role}</div>
    </div>
  );
}
