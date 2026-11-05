// Shared portal styles — extracted from the onboarding screen so tiles/claims/onboarding
// share one visual language instead of copy-pasting the same objects. Plain inline-style objects
// (the portal doesn't use a CSS framework); import what a screen needs.
//
// colours now come from the "Vetted" theme tokens (lib/theme.ts) so the whole portal shares one
// solid-institutional palette. Keep new work importing T/surface from theme.ts directly; these
// aliases keep the existing screens consistent without a churny rewrite.
import type { CSSProperties } from "react";
import { T } from "./theme";

export const card: CSSProperties = {
  marginTop: 14,
  // Tighter TOP padding so panel titles sit ~6px higher. Side padding trimmed 16→12 (B1,
  // ) to reclaim L/R space app-wide on mobile — this is the shared card every role uses, so one
  // change lands everywhere; 12px still reads fine on desktop. Bottom stays 16.
  padding: "10px 12px 16px",
  borderRadius: 12,
  background: T.panel,
  border: `1px solid ${T.border}`,
};

export const lbl: CSSProperties = {
  display: "block",
  fontSize: 13,
  opacity: 0.8,
  marginBottom: 5,
};

export const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 12px",
  marginBottom: 12,
  borderRadius: 8,
  background: T.bg2,
  // border comes from globals.css (dim blue always, bright blue on focus) — don't set it here
  // or the inline border would override the :focus rule.
  color: "#e6e9ef",
  fontSize: 16, // >=16px prevents iOS Safari auto-zooming the page when an input gains focus
};

export const pill: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  background: "#0e1119",
  border: "1px solid #2a2f40",
  color: "#c7cde0",
  fontSize: 14,
  cursor: "pointer",
};

export const pillActive: CSSProperties = {
  background: "#2b62ff",
  border: "1px solid #2b62ff",
  color: "#fff",
};

export const submitBtn: CSSProperties = {
  ...pillActive,
  padding: "10px 18px",
  border: "none",
  cursor: "pointer",
  fontSize: 15,
};

export const banner: CSSProperties = {
  marginTop: 18,
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid",
  background: "#141824",
  fontSize: 14,
};

export const mono: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

// Status → colour, for tile/claim badges. Tile: open/hold/closed/done. Claim: open/ok/no/alt.
export function statusColor(label: string): string {
  switch (label) {
    case "open":
      return "#7ce0a0"; // available / awaiting
    case "hold":
    case "accepted":
    case "ready to sign": // contract final — in-progress
    case "payment received": // on-contract payment in, valid to sign
    case "in contract": // preview-stage S&P
      return "#e0c67c"; // in-progress
    case "closed":
    case "done":
    case "sold": // developer confirmed + closed on-chain
    case "signed": // S&P executed
      return "#7aa2ff"; // settled
    case "declined":
      return "#ff8080";
    case "alternative":
      return "#c78ce0";
    default:
      return "#9aa4bf";
  }
}
