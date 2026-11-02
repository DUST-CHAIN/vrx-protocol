// FIELD PLAUSIBILITY — a client-safe, SYNCHRONOUS "does this value look like a real X?" check.
// trimmed, title in a closed set) but never field MEANING — so "2946524" saves as a phone and a malformed
// string saves as an email. This inverts @nationaldesignstudio/rampart-edge's PII *detector* into an input
// *plausibility* signal: if the library recognises the value as the expected identifier, it's very likely a
// real one; if it recognises nothing, that's a soft "double-check this?" nudge.
// TIER 1 (this module): phone / email / idRef only. These ride Rampart's DETERMINISTIC validators — pure,
// synchronous, checksummed rules (E.164 phones, email format, SSN/ITIN/passport/USCIS/… id shapes). No ONNX
// model, no onnxruntime-web, no Web Worker, no WASM asset: importing `detect` from the top-level package does
// NOT load the model (that's lazy inside createGate), so this adds only a few KB of rules to the client. The
// NAME field needs the fuzzy model and is handled in a separate slice (lib/name-plausibility — later).
// HARD INVARIANTS (the moat + product intent):
// 1. ADVISORY ONLY. This NEVER blocks save. A real buyer with an unusual identifier the rules don't know
// (a non-US national id, an unusual phone grouping) must still save with at most one dismissible warning.
// False-rejecting a legitimate buyer on a legal-adjacent sealed record is worse than accepting a sloppy one.
// 2. LOCAL. Rampart runs entirely in-process; nothing about the value leaves the device. Privacy moat intact.
// 3. "unknown" is a first-class result — empty / too-short input is NEVER flagged (don't nag a half-typed field).
// Proven on our real categories by lib/rampart-probe.run.ts: valid +1/+66 phones, real email, SSN →
// recognised; "2946524", "000", "jane at example dot com", "notanemail", "zzz" → correctly not recognised.

import { detect, type Label } from "@nationaldesignstudio/rampart-edge";

/** Which buyer fields tier-1 can judge. (name → separate model-backed slice; address → excluded, model can't.) */
export type PlausibleField = "phone" | "email" | "idRef";

/** The verdict for one field value. `unknown` = not enough input to judge (never warn on this). */
export type Plausibility =
  | { status: "ok"; label: Label } // a real instance was recognised
  | { status: "warn" } //           non-trivial input, but nothing recognised → soft "double-check?"
  | { status: "unknown" }; //       empty / too short to judge

/** Below this many non-space chars we don't judge — a half-typed field shouldn't nag. */
const MIN_CHARS = 4;

/** The identifier Labels we accept as "this really is an X", per field. Soft id hits count for idRef only. */
const HARD_OK: Record<PlausibleField, readonly Label[]> = {
  phone: ["PHONE", "PHONE_E164"],
  email: ["EMAIL"],
  idRef: [
    "PASSPORT", "MRZ", "DRIVERS_LICENSE", "SSN", "ITIN", "EIN", "MEDICARE_MBI",
    "USCIS_A_NUMBER", "USCIS_RECEIPT", "ES_DNI", "FR_NIR", "DE_STEUER_ID",
    "IT_CODICE_FISCALE", "PT_NIF", "NL_BSN", "BR_CPF",
  ],
};

// idRef is intentionally LENIENT: global ID formats vary wildly and the rules only know a handful, so we
// accept a SOFT detection too (e.g. a passport/USCIS shape the rules flag but can't checksum). phone/email
// require a HARD hit — those rules are reliable and a soft-only hit there usually means a format example.
const SOFT_OK_FIELDS: ReadonlySet<PlausibleField> = new Set<PlausibleField>(["idRef"]);

/**
 * Judge whether `value` looks like a real instance of `field`. Pure + synchronous — safe to call on every
 * keystroke (debounce in the UI for comfort, not correctness). Returns `unknown` for empty/short input.
 */
export function checkFieldPlausibility(field: PlausibleField, value: string): Plausibility {
  const v = (value ?? "").trim();
  if (v.replace(/\s+/g, "").length < MIN_CHARS) return { status: "unknown" };

  const accept = HARD_OK[field];
  const allowSoft = SOFT_OK_FIELDS.has(field);
  for (const d of detect(v)) {
    if (!accept.includes(d.label)) continue;
    if (d.hard || allowSoft) return { status: "ok", label: d.label };
  }
  return { status: "warn" };
}

/** A short, user-facing, developer-talk-free hint for a `warn` (speak the words, no error codes). */
export function plausibilityHint(field: PlausibleField): string {
  switch (field) {
    case "phone":
      return "This doesn’t look like a complete phone number — double-check it.";
    case "email":
      return "This doesn’t look like a valid email address — double-check it.";
    case "idRef":
      return "This doesn’t look like a recognisable ID or passport number — double-check it.";
  }
}
