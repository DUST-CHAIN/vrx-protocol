// VRX theme tokens — "Vetted".
//
// Design brief: (1) use space well — dense, grid-first, information-rich, like a
// trading terminal; (2) project SOLIDITY / "vetted" — an institutional, trustworthy base, not
// flashy-crypto; (3) project TRUST through the on-chain BUZZ — show tx hashes, references, live
// status, a little "flashing lights" reserved for the moment the chain confirms; (4) SHOW THE
// PROCESS AS IT GOES (signing → sent → confirmed) as a rule — it's the UX that earns trust.
//
// So: a calm deep-slate institutional frame + one disciplined accent, where the ONLY things that
// glow/pulse are on-chain truths (a live status dot, a landed tx, a confirm flash). The solidity is
// the frame; the buzz is the blockchain proof. Monospace everywhere data is on-chain.

import type { CSSProperties } from "react";

export const T = {
  // Base surfaces — deep slate-navy, layered darkest→lightest for depth without borders shouting.
  bg: "#0a0e17", // page
  bg2: "#0f1420", // sunken (inputs, wells)
  panel: "#131a28", // card
  panel2: "#18202f", // raised card / selected
  border: "#232d40",
  borderSoft: "#1c2434",

  // Text
  text: "#e8ecf4",
  dim: "#9aa6be",
  faint: "#8591a8", // a11y: lifted from #63708c (3.3–3.9:1, failed AA) to pass WCAG AA-body (5.1–6.1:1) on every surface, still clearly dimmer than `dim`

  // The single "vetted" accent — a confident institutional blue-teal (trust, not hype).
  accent: "#3d7dff",
  accentSoft: "#1a2c4d",
  vetted: "#38d39f", // the verification green — checkmarks, confirmed, available

  // On-chain status palette (aligns with lib/ui.ts statusColor).
  open: "#38d39f", // available / awaiting
  hold: "#e8b84b", // in progress
  closed: "#5b9bff", // settled / sold
  danger: "#ff6b6b",
  alt: "#c78ce0",

  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",

  // Font-size floor. The minimum READABLE meta/label size — one place to tune the dense small text
  // scattered as raw `fontSize: 11` inline literals across the dashboards. Adopted as the token so a future
  // readability pass (mobile/a11y) retunes HERE, not in ~40 files. 12px = the sub-12px "too small" floor
  //  flagged; decorative glyphs (e.g. a single char inside a 14px legend dot) legitimately stay smaller
  // and are NOT governed by this token.
  fsMeta: 12,
} as const;

export const surface: CSSProperties = {
  background: T.panel,
  border: `1px solid ${T.border}`,
  borderRadius: 12,
};

/** A pill "VETTED"/verified seal used to carry the trust cue. */
export const seal: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: T.vetted,
  background: "rgba(56,211,159,0.10)",
  border: `1px solid rgba(56,211,159,0.35)`,
  borderRadius: 999,
  padding: "3px 9px",
};

/** Monospace chip for on-chain refs / account ids / hashes. */
export const chip: CSSProperties = {
  fontFamily: T.mono,
  fontSize: 12,
  color: T.dim,
  background: T.bg2,
  border: `1px solid ${T.borderSoft}`,
  borderRadius: 6,
  padding: "2px 7px",
};
