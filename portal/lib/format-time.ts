// TIMEZONE-AWARE DISPLAY LAYER (the "make sure the user sees THEIR time" note). Isomorphic (server + client).
//
// ── THE GOLDEN RULE ──────────────────────────────────────────────────────────────────────────────────────────
// VRX STORES every time as a UTC ms-epoch (one unambiguous clock — see lib/clock.ts). It DISPLAYS every time in the
// VIEWER'S timezone. This module is the ONE place that formatting happens, so a buyer in Pattaya reads a deadline in
// Asia/Bangkok, not a UTC string that's off by a day near midnight. Never format a user-facing date with
// `toISOString` (that's UTC) — always go through here with the viewer's zone.
//
// ── WHERE THE VIEWER'S ZONE COMES FROM (best first) ──────────────────────────────────────────────────────────
//  1. AUTO (client, zero effort) — the browser's resolved zone: `resolveBrowserTimeZone` reads
//  Intl.DateTimeFormat.resolvedOptions.timeZone (e.g. "Asia/Bangkok"). This is the default on the client.
//   2. EXPLICIT (a user preference) — a stored IANA zone the user picked (for travel, or a server-rendered surface
//      where the browser zone isn't in scope). Pass it as `tz`.
//   3. DEFAULT (fallback) — `VRX_DEFAULT_TZ` (env) or the beachhead default "Asia/Bangkok" (Pattaya/Thailand). Used
//      when neither auto nor explicit is available (e.g. a server render with no user preference yet).
// A caller resolves the zone (usually: explicit preference ?? browser-auto ?? default) and passes it to format*.

/** The beachhead default zone (the operator catalog/Vetted Realty = Pattaya, Thailand). Overridable via VRX_DEFAULT_TZ. */
export const FALLBACK_TIME_ZONE = "Asia/Bangkok";

/** The project default zone — env override, else the beachhead default. Used when no viewer zone is known. */
export function defaultTimeZone(): string {
  const env = (typeof process !== "undefined" && process.env && process.env.VRX_DEFAULT_TZ) ? process.env.VRX_DEFAULT_TZ.trim() : "";
  return env && isValidTimeZone(env) ? env : FALLBACK_TIME_ZONE;
}

/** The browser's resolved IANA zone (CLIENT only — "Asia/Bangkok", "Europe/London", …). Returns null off the client
 *  / when unavailable, so a caller falls through to an explicit preference or the default. */
export function resolveBrowserTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/** Is `tz` a valid IANA zone this runtime knows? (A bad zone passed to Intl throws — we validate so a stray value
 *  degrades to the default instead of crashing a render.) */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The effective zone for a format call: a valid explicit `tz` wins; else the project default. (A caller that wants
 * browser-auto resolves it first via resolveBrowserTimeZone and passes it as `tz`.) */
function effectiveZone(tz?: string): string {
  return tz && isValidTimeZone(tz) ? tz : defaultTimeZone();
}

/** Format a UTC ms-epoch as a DATE in the viewer's zone (default locale en-GB → "14 Nov 2026"). `0`/falsy → "—". */
export function formatDate(ms: number, tz?: string, locale = "en-GB"): string {
  if (!ms || ms <= 0) return "—";
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: effectiveZone(tz), year: "numeric", month: "short", day: "numeric" }).format(new Date(ms));
  } catch {
    return "—";
  }
}

/** Format a UTC ms-epoch as a DATE + TIME in the viewer's zone, WITH the zone abbreviation so the user sees it's
 *  their local time (e.g. "14 Nov 2026, 19:30 GMT+7"). `0`/falsy → "—". */
export function formatDateTime(ms: number, tz?: string, locale = "en-GB"): string {
  if (!ms || ms <= 0) return "—";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: effectiveZone(tz),
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(ms));
  } catch {
    return "—";
  }
}

/** The ISO-like YYYY-MM-DD, but computed IN the viewer's zone (not UTC). For a compact "as of <date>" that still
 * respects the viewer's day boundary — the fix for the labels that previously used toISOString.slice(0,10). */
export function localDateStamp(ms: number, tz?: string): string {
  if (!ms || ms <= 0) return "";
  try {
    // en-CA gives YYYY-MM-DD; timeZone makes the day boundary the viewer's, not UTC's.
    return new Intl.DateTimeFormat("en-CA", { timeZone: effectiveZone(tz), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return "";
  }
}

// ── TWO-SIDED (counterparty-aware) display ───────────────────────────────────────────────────────
// In a deal, each party needs to see the OTHER side's local time too — especially when the counterparty is a PERSON
// (not an always-on AI) who may be asleep/off-hours. So a deadline reads "19:30 your time (also 14:30 for them)",
// and a surface can warn when the counterparty is likely outside working hours.

/** The short UTC-offset label for a zone at a given instant (e.g. "GMT+7") — so a user can see WHICH zone a time is
 *  in at a glance. A 0/falsy epoch → "" (NOT the current offset — that would leak a "now" where the contract means
 * "unknown"; adversarial-pass fix). */
export function zoneOffsetLabel(ms: number, tz: string): string {
  if (!ms || ms <= 0) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: effectiveZone(tz), timeZoneName: "short" }).formatToParts(new Date(ms));
    return parts.find((p) => p.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
}

/** Format one instant for BOTH parties: "<time> <yourZone> (also <time> <theirZone> for them)". For a deadline or a
 *  "they'll respond by" shown to `viewerTz`, annotated with what it is in `counterpartyTz`. If the two zones are the
 *  same (or the counterparty zone is unknown), the annotation is omitted. */
export function formatForBothParties(
  ms: number,
  viewerTz: string | undefined,
  counterpartyTz: string | undefined,
  locale = "en-GB"
): string {
  const mine = formatDateTime(ms, viewerTz, locale);
  const vz = effectiveZone(viewerTz);
  const cz = counterpartyTz && isValidTimeZone(counterpartyTz) ? counterpartyTz : "";
  if (!cz || cz === vz || !ms || ms <= 0) return mine;
  try {
    const theirs = new Intl.DateTimeFormat(locale, { timeZone: cz, hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
    return `${mine} (also ${theirs} for them)`;
  } catch {
    return mine; // never let a counterparty-zone hiccup break the viewer's own time
  }
}

/** A coarse "is this instant inside typical working hours (08:00–19:00) in `tz`?" — so a surface can warn "the other
 *  side is a person and it's currently outside their working hours, expect a slower reply." Advisory only. */
export function isWithinWorkingHours(ms: number, tz: string, startHour = 8, endHour = 19): boolean {
  try {
    // Read the HOUR part explicitly from formatToParts (not parseInt on the whole string — robust across locales /
    // non-ASCII digits; adversarial-pass fix).
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: effectiveZone(tz), hour: "2-digit", hour12: false }).formatToParts(new Date(ms > 0 ? ms : Date.now()));
    const hourStr = parts.find((p) => p.type === "hour")?.value ?? "";
    const h = parseInt(hourStr, 10);
    if (!Number.isFinite(h)) return true; // unknown → don't warn
    return h >= startHour && h < endHour;
  } catch {
    return true;
  }
}
