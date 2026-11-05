// AI Sales Director — chat PII scrub (RE-ENGINED to RAMPART the design docs §7).
// PURE (no fs / no network): strip PII TOKENS out of free-text chat BEFORE the model sees it, so the AI reasons
// over "the buyer shared a phone number" rather than the digits. the rule: scrub where it HELPS (free-text),
// don't force where USELESS (the stored profile is already masked via buyer-mask). Buyer per-conversation CONSENT
// can pass their own contact info through (§3b) — handled by the `consented` flag.
//
// SLICE 8: the structural detector now LEADS with RAMPART (@nationaldesignstudio/rampart-edge). We use its
// DETERMINISTIC VALIDATOR layer (`detect`) — a pure-TypeScript pass over 34 checksummed entity types (EMAIL, PHONE,
// PHONE_E164, PASSPORT, MRZ, CREDIT_CARD, IBAN, SSN, DE/FR/IT/ES/PT/NL/BR national ids, …) with span offsets.
// RAMPART's 1.45 MB ONNX classifier half is BROWSER-targeted (lazy `import("onnxruntime-web")`) and is NOT touched
// here — importing the package top-level for `detect` does not load onnxruntime, so this stays Node-safe and runs at
// the authoritative SERVER chokepoint (sanitize.buildDeskContext inbound + decide outbound), the real server→DeepSeek
// leak boundary. Client-side RAMPART is parked behind TEE (§7 — it buys nothing on this hop).
//
// DEFENSE-IN-DEPTH (why RAMPART + regex, not RAMPART instead of): RAMPART is precise on checksummed/structured
// identifiers but regionally scoped (US/EU) — it does NOT catch a loosely-formatted Thai mobile (081-234-5678) or an
// arbitrary passport run (AB1234567X), which is exactly our Thailand buyer population. So RAMPART runs FIRST (broad,
// checksummed, low-false-positive) and our proven structural regexes run as a SECOND fallback pass for the regional
// formats RAMPART misses. The union is strictly safer than either alone (verified: regexes alone passed the
// Thai-phone / fictional-passport cases RAMPART skipped). This remains defense-in-depth, not a guarantee — the real
// privacy floor is that the AI never needs literal PII to sell, and the stored profile is already masked. VRX-specific
// addition over both: we also redact the buyer's OWN name tokens (RAMPART allowlists public figures; it can't know
// THIS buyer's name).

import { detect, type Detection, type Label } from "@nationaldesignstudio/rampart-edge";

/** The neutral placeholders the AI sees instead of a real value — enough to reason, nothing to identify. */
const PLACEHOLDER: Record<string, string> = {
  email: "[email]",
  phone: "[phone]",
  id: "[id-number]",
  name: "[name]",
  other: "[redacted]",
};

/** Map a RAMPART structural label → our coarse placeholder (so the AI still reads "a phone"/"an email"/"an id"
 *  rather than a flat [redacted], preserving the reason-over-shape behavior). Anything financial / government /
 *  national-id folds to the id-number bucket; URLs/handles and anything unmapped fall to the generic placeholder. */
function placeholderFor(label: Label): string {
  switch (label) {
    case "EMAIL":
      return PLACEHOLDER.email;
    case "PHONE":
    case "PHONE_E164":
      return PLACEHOLDER.phone;
    case "SSN":
    case "ITIN":
    case "EIN":
    case "MEDICARE_MBI":
    case "USCIS_A_NUMBER":
    case "USCIS_RECEIPT":
    case "PASSPORT":
    case "MRZ":
    case "DRIVERS_LICENSE":
    case "ROUTING_NUMBER":
    case "BANK_ACCOUNT":
    case "CREDIT_CARD":
    case "IBAN":
    case "BIC":
    case "VIN":
    case "LICENSE_PLATE":
    case "ES_DNI":
    case "FR_NIR":
    case "DE_STEUER_ID":
    case "IT_CODICE_FISCALE":
    case "PT_NIF":
    case "NL_BSN":
    case "BR_CPF":
      return PLACEHOLDER.id;
    default:
      // URL / IPV4 / IPV6 / MAC / ZIP / DATE / DOB / COORDINATES — not identifying on their own for a sales chat,
      // but RAMPART flagged them as structural; redact generically rather than leak.
      return PLACEHOLDER.other;
  }
}

// ── Fallback structural patterns (the proven regexes) — a SECOND pass for the regional/loose formats
//    RAMPART's US/EU validators don't recognize (Thai mobile, arbitrary passport/id runs). Order matters:
//    email before phone so an email's digits aren't eaten as a phone. ──
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// A phone: 8+ digits possibly separated by space/dash/dot/parens, optional leading +.
const PHONE_RE = /(?<![\w])\+?[\d][\d\s().-]{6,}\d(?![\w])/g;
// A long bare digit/alnum run = passport/id card (9+ chars with ≥1 digit; catches AB1234567X and 7+ digit runs).
const IDNUM_RE = /\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{9,}\b/g;

/** Apply the fallback regexes to text that RAMPART has already passed over. Each placeholder token (e.g. "[email]")
 *  is inert under these patterns, so re-scrubbing RAMPART's output never double-redacts a placeholder. PURE. */
function applyFallbackRegex(text: string): string {
  let s = text;
  s = s.replace(EMAIL_RE, PLACEHOLDER.email);
  s = s.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 7 ? ` ${PLACEHOLDER.phone} ` : m));
  s = s.replace(IDNUM_RE, PLACEHOLDER.id);
  return s;
}

/** Structural PII pass: RAMPART's deterministic validators FIRST (precise, checksummed, broad entity set), then the
 *  fallback regexes for the regional/loose formats RAMPART misses. `detect` resolves overlaps and returns
 *  ORIGINAL-string offsets; we splice back-to-front so earlier offsets stay valid. PURE. */
function applyStructural(text: string): string {
  // 1) RAMPART deterministic validators.
  const dets: Detection[] = detect(text);
  let s = text;
  if (dets.length > 0) {
    // Back-to-front by start so each splice doesn't shift the offsets of the ones we haven't done yet.
    const sorted = [...dets].sort((a, b) => b.start - a.start);
    for (const d of sorted) {
      if (d.start < 0 || d.end > s.length || d.start >= d.end) continue; // defensive: skip a bad span
      s = s.slice(0, d.start) + placeholderFor(d.label) + s.slice(d.end);
    }
  }
  // 2) Fallback regexes over the result (placeholders are inert under them — no double-redaction).
  return applyFallbackRegex(s);
}

/** Build the set of name tokens to watch from the buyer's UNMASKED profile (server-side only — the scrubber
 *  runs server-side where the real name is known; it emits the scrubbed text that goes to the AI). Splits a
 *  full/legal name into word tokens ≥3 chars (so "Jo" isn't over-eagerly matched). Lowercased. */
export function nameTokens(profile: { name?: string; legalName?: string } | undefined): string[] {
  if (!profile) return [];
  const raw = `${profile.name ?? ""} ${profile.legalName ?? ""}`;
  const out = new Set<string>();
  for (const w of raw.split(/\s+/)) {
    const t = w.trim().toLowerCase().replace(/[^a-z'-]/g, "");
    if (t.length >= 3) out.add(t);
  }
  return [...out];
}

/** Redact the buyer's own name tokens (RAMPART's validators allowlist public figures but can't know THIS buyer's
 *  name — so this VRX-specific pass layers on top of the structural one). Whole-word, case-insensitive. PURE. */
function applyNames(text: string, names: string[]): string {
  let s = text;
  for (const n of names) {
    if (!n) continue;
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    s = s.replace(re, PLACEHOLDER.name);
  }
  return s;
}

/** Scrub one line of free text. `names` = the buyer's own name tokens to redact (from nameTokens). If
 *  `consented` is true the buyer chose to share their contact info → structural PII passes through, but we
 *  STILL redact nothing extra (consent is the buyer's call). Returns the scrubbed text. PURE. */
export function scrubLine(text: string, names: string[], consented: boolean): string {
  if (consented) return text; // buyer opted to share — pass through verbatim (§3b consent)
  const structural = applyStructural(text);
  const named = applyNames(structural, names);
  return named.replace(/\s{2,}/g, " ").trim();
}

/** Scrub an OUTBOUND draft the AI produced (defense-in-depth): the desk must never echo a PII identifier back
 *  into the thread unless the buyer consented. Same structural redaction, no name list needed (the AI shouldn't
 *  be emitting the buyer's name anyway). PURE. */
export function scrubOutbound(text: string, consented: boolean): string {
  if (consented) return text;
  return applyStructural(text).replace(/\s{2,}/g, " ").trim();
}
