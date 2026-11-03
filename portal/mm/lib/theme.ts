// SHARED DARK PALETTE — the single source of truth for the VRX Model Maker look (visual unification).
//
// WHY THIS EXISTS: before the app had TWO theme systems — the form-world routes (, /ai, /manage) used
// the CSS custom-properties in app/globals.css, while the canvas-world routes (/studio-ai , /studio-board) each
// hard-coded their OWN inline `const T = {...}` palette (duplicated three times). On screen they looked like two
// different apps. the direction: unify to ONE dark look, using the studio/board canvas theme as the
// target. This module is the canonical palette; globals.css mirrors the SAME hex values onto its CSS vars so the
// class-driven form-world and the inline-styled canvas-world render identically.
//
// RULE: these values and the `--*` vars in globals.css (the DARK / default `:root` block) must stay in lockstep.
// Change a colour HERE and in globals.css in the same pass, or the two halves drift apart again.

export const T = {
  bg: "#0a0e17", // page background
  board: "#0c111c", // the authoring-board backdrop (a hair above bg)
  bg2: "#0f1420", // inset / input / sunken surfaces
  panel: "#131a28", // cards, panels
  panel2: "#18202f", // raised controls
  border: "#232d40", // default hairline
  borderSoft: "#1c2434", // faint hairline
  text: "#e8ecf4", // primary ink
  dim: "#9aa6be", // secondary ink
  faint: "#8591a8", // tertiary ink / labels
  accent: "#3d7dff", // VRX blue — the identity accent
  vetted: "#38d39f", // green: ok / "fits" / tessellates
  danger: "#ff6b6b", // red: error / over-capacity
  hold: "#e8b84b", // amber: warn / held
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

export type Theme = typeof T;
