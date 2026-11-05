"use client";

// ProvenanceBadge — the SHARED "where does this live / can I prove it" chip. Built ONCE, dropped
// wherever a record shows, so the on-chain receipt reaches every screen without an N-place edit (the
// "inject it into a module that's on almost every screen" insight).
//
// THREE KINDS (see the design docs — the authoritative record→tier map):
//   • onchain → ⛓ a real NEAR transaction (a contract change-method: open_claim / confirm_claim / stamp_tile /
//     grant_gate / register_peer …). Renders a LINK to the block explorer. In demo mode (no per-record tx yet)
//     it links to the real CONTRACT account + an honest "sandbox — representative on-chain record" caption.
//   • sealed → ⭐ an off-chain ATTESTED record (tamper-evident hash seal; re-hash verifies). NO tx, so NEVER an
//     explorer-tx link (that would be dishonest). This is the "✓ Vetted / sealed" family.
//   • private → 🔒 confidential value (price/terms/PII) — shown only to entitled parties, never a public receipt.
//
// HONESTY (pt5): the demo onchain link points at the REAL contract (which exists) and says sandbox — it
// never fabricates a tx hash. When the contract is final + records carry real txs, the same badge goes real
// with zero change here (the swap lives in lib/provenance-source.ts).

import { provenanceLink } from "@/lib/provenance-source";
import { T } from "@/lib/theme";

type Kind = "onchain" | "sealed" | "private";

const chip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: 999,
  fontSize: 12, fontWeight: 600, lineHeight: 1.4, border: "1px solid", textDecoration: "none",
};

export default function ProvenanceBadge({
  kind,
  txHash,
  label,
  className,
}: {
  kind: Kind;
  /** For kind="onchain": the real tx hash if known; omit → demo representative link. */
  txHash?: string | null;
  /** Optional override for the chip text (defaults per kind). */
  label?: string;
  className?: string;
}) {
  if (kind === "private") {
    return (
      <span
        className={className}
        style={{ ...chip, borderColor: `${T.faint}55`, color: T.faint, background: `${T.faint}12` }}
        title="Confidential — never shown publicly or put on-chain (price, terms, personal details)."
      >
        🔒 {label ?? "Private"}
      </span>
    );
  }

  if (kind === "sealed") {
    return (
      <span
        className={className}
        style={{ ...chip, borderColor: "#e0b84e66", color: "#e9c76a", background: "#e0b84e12" }}
        title="Tamper-evident seal — re-hashing the record verifies it hasn't been altered since it was signed. (Off-chain attested record; no blockchain transaction.)"
      >
        ⭐ {label ?? "Sealed · verifies"}
      </span>
    );
  }

  // onchain
  const { url, demo } = provenanceLink(txHash);
  return (
    <a
      className={className}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{ ...chip, borderColor: "#00EC9755", color: "#00EC97", background: "#00EC9712" }}
      title={
        demo
          ? "Sandbox — links to the live VRX contract on the NEAR explorer. In production each booking/stamp carries its own transaction."
          : "View this record's transaction on the NEAR block explorer."
      }
    >
      ⛓ {label ?? "On-chain"}
      <span aria-hidden style={{ opacity: 0.8 }}>↗</span>
      {demo && <span style={{ fontSize: 10, opacity: 0.6, fontWeight: 400 }}>sandbox</span>}
    </a>
  );
}
