// Self-hosted Inter (F5 — "de-google us as much as possible"). `next/font/google` DOWNLOADS
// the font files at BUILD time and serves them from OUR OWN origin — there is NO runtime request to
// fonts.googleapis.com / fonts.gstatic.com. (The name is misleading: this is the canonical Next way to
// SELF-HOST a Google-catalogued font; nothing hits Google when a user loads a page.) We expose it as a CSS
// variable so both our inline styles and the wallet-selector modal (whose vendored CSS used to @import Inter
// from Google — now stripped, see app/vendor/wallet-selector-modal.css) resolve the SAME local face.
import { Inter } from "next/font/google";

export const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-inter",
  // Fall back to the previous system stack if the self-hosted face is ever unavailable — identical to the
  // old body fontFamily, so a missing font degrades to exactly today's look, never a bare serif.
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
});
