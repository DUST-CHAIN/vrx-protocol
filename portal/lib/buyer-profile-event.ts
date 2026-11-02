// Decoupled launcher signal for the buyer's "My profile & verification" view (Phase 2).
// WHY AN EVENT: the ⚙ SettingsMenu lives in the GLOBAL <Nav> (a shared component), while the buyer SPA
// that OWNS the profile view is the separate /buyer route. The popup must only LAUNCH the view, never host
// the KYC form. Rather than lift state across unrelated components, the launcher dispatches a window
// CustomEvent and the buyer page listens — the same loosely-coupled pattern SettingsMenu already uses for
// the operator secret (OPERATOR_SECRET_EVENT). No shared store, no prop-drilling across routes.
// The optional detail carries a focus request so the SAME entry point serves (a) the plain launcher (no
// focus) and (b) the red-card popup's deep-link (focus the exact missing fields for a developer).

export const OPEN_BUYER_PROFILE_EVENT = "vrx-open-buyer-profile";

export type OpenBuyerProfileDetail = {
  /** Profile field KEYS to scroll to / outline (the red-card popup's "add these" deep-link). */
  focusFields?: string[];
  /** The developer whose requirements prompted this (for the "Required by {name}" context line). */
  forDeveloper?: string;
};

/** Fire the launcher (from the ⚙ popup or a red-card popup). No-op during SSR. */
export function openBuyerProfile(detail?: OpenBuyerProfileDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_BUYER_PROFILE_EVENT, { detail: detail ?? {} }));
}
