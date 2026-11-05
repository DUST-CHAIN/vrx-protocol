// Trust MARKS — the small visual tags that make VRX's two promises EVIDENT inline.
//
// The moat is privacy + tamper-evidence, but those are invisible unless we SHOW them. So every field
// the user sees carries one of two tiny marks, consistently, across every screen:
//
//   🔒 Lock  (yellow, T.hold)  = PRIVATE / confidential. This value never goes on-chain and is never
//                                shown publicly — prices, commission terms, KYC identity, the salt.
//                                It's the "kept private by design" promise, made visible.
//   ⭐ Star  (green,  T.vetted) = SEALED / verified. This value is covered by the ✓ Vetted tamper-
//                                evident seal (the salted hash re-verifies) — it hasn't been altered
//                                since it was signed.
//
// The two are DIFFERENT promises (confidential ≠ unaltered), so they are two distinct marks, never one.
// Per: the marks carry NO per-field tooltip — their meaning is explained ONCE on the landing
// page (see the MarksLegend below, rendered pre-login) so the UI stays clean and the user learns them once.
//
// Usage: put <PrivateMark/> or <SealedMark/> next to a label or value. They're inline, baseline-aligned,
// and size to the surrounding text. Keep them SMALL — a cue, not a decoration.

import type { CSSProperties } from "react";
import { T } from "./theme";

const base: CSSProperties = {
  display: "inline-block",
  fontSize: "0.85em",
  lineHeight: 1,
  verticalAlign: "baseline",
  marginLeft: 4,
  userSelect: "none",
};

/** 🔒 PRIVATE — a confidential field that never goes public / on-chain. Yellow. */
export function PrivateMark({ style }: { style?: CSSProperties }) {
  return (
    <span
      aria-label="Private — kept confidential, never shown publicly or put on-chain"
      title="Private — kept confidential"
      style={{ ...base, color: T.hold, ...style }}
    >
      🔒
    </span>
  );
}

/** ⭐ SEALED — a field covered by the ✓ Vetted tamper-evident seal. Green. */
export function SealedMark({ style }: { style?: CSSProperties }) {
  return (
    <span
      aria-label="Sealed — covered by the tamper-evident ✓ Vetted seal"
      title="Sealed — tamper-evident"
      style={{ ...base, color: T.vetted, ...style }}
    >
      ⭐
    </span>
  );
}

/**
 * The one place the marks are EXPLAINED — rendered on the landing page before login, so the
 * meaning is learned once and every 🔒/⭐ across the apps is then self-evident without per-field tooltips.
 */
export function MarksLegend({ style }: { style?: CSSProperties }) {
  const row: CSSProperties = { display: "flex", alignItems: "baseline", gap: 8, fontSize: 14, lineHeight: 1.5 };
  return (
    <div style={{ display: "grid", gap: 8, ...style }}>
      <div style={row}>
        <span style={{ color: T.hold, fontSize: 16 }}>🔒</span>
        <span style={{ color: T.dim }}>
          <strong style={{ color: T.text }}>Private.</strong> Kept confidential — never shown publicly or
          put on the blockchain. Your prices, terms and personal details.
        </span>
      </div>
      <div style={row}>
        <span style={{ color: T.vetted, fontSize: 16 }}>⭐</span>
        <span style={{ color: T.dim }}>
          <strong style={{ color: T.text }}>Sealed.</strong> Protected by a tamper-evident seal — proof it
          hasn&apos;t been altered since it was signed.
        </span>
      </div>
    </div>
  );
}
