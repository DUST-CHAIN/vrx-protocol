"use client";

// BookingSearch — the top-bar "jump to a booking by its short code" box, the last booking-code
// surface. The engine (lib/booking-codes) + the resolve API (/api/booking-code?resolve=) + the
// per-app deep-link focus (?section=&focus=, DashboardShell.useShellFocus) already existed; this is only
// the INPUT surface that ties them together.
//
// WHAT IT DOES: the user types a code ("VRX-K7Q2M", "k7q2m", "vrx k7q2m" — the resolver is tolerant) and
// hits Enter. We resolve it to the booking's opaque requestId, then route to the CURRENT ROLE's booking
// inbox with ?focus=<requestId>. The active section reads that focus id and opens the booking IF it's in
// its own list; a section simply ignores a focus id it can't find (DashboardShell line ~41). So a code for
// a booking the viewer isn't party to resolves to a real code but opens nothing for them — fail-safe, no
// cross-role leak (the privacy moat): the box never reveals a booking's content, only that a code is or
// isn't a real handle, and only routes the viewer within their OWN app.
//
// PRIVACY NOTE: resolve returns {requestId, code, bookingAt} — all already-opaque handles, no PII, no terms.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRole, type Role } from "@/lib/role";
import { T } from "@/lib/theme";

// Per-role booking inbox: the route + the section id its booking list lives in (verified against each
// app's DashboardShell sections). Owner has no per-booking-by-code inbox, so it isn't offered the box.
const BOOKING_HOME: Partial<Record<Exclude<Role, null>, { route: string; section: string }>> = {
  developer: { route: "/node", section: "queue" }, // Queue — "Booking requests"
  agency: { route: "/agency", section: "deals" }, // DealInbox — "Deal inbox"
  agent: { route: "/agent", section: "bookings" }, // "My bookings"
};

type Status = "idle" | "searching" | "notfound" | "error";

export default function BookingSearch() {
  const { role } = useRole();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  // Mobile collapse (the crowded-topbar fix): below the shell's 860px breakpoint the box renders as a
  // single 🔎 pill so it stops squeezing the bar; tapping it expands the input inline (and auto-focuses).
  // On desktop it's always expanded. Blurring an empty input on mobile re-collapses it.
  const [isNarrow, setIsNarrow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 860px)");
    const apply = () => setIsNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Only roles with a booking inbox get the box (owner/unregistered have nothing to jump to).
  const home = role && role !== "unregistered" ? BOOKING_HOME[role] : undefined;
  if (!home) return null;

  const showInput = !isNarrow || expanded;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const typed = value.trim();
    if (!typed) return;
    setStatus("searching");
    try {
      const r = await fetch(`/api/booking-code?resolve=${encodeURIComponent(typed)}`);
      if (r.status === 404) {
        setStatus("notfound");
        return;
      }
      if (!r.ok) {
        setStatus("error");
        return;
      }
      const j = (await r.json()) as { requestId?: string };
      if (!j.requestId) {
        setStatus("notfound");
        return;
      }
      setStatus("idle");
      setValue("");
      // Route to our own app's booking inbox + hand the focus id to the active section. The section opens
      // it if it's theirs; otherwise nothing opens (fail-safe — see header note).
      router.push(`${home.route}?section=${home.section}&focus=${encodeURIComponent(j.requestId)}`);
    } catch {
      setStatus("error");
    }
  };

  const hint =
    status === "notfound"
      ? "No booking with that code for you"
      : status === "error"
        ? "Network busy — try again"
        : null;

  // Collapsed (mobile, not yet opened): a single 🔎 pill button that expands the box on tap.
  if (isNarrow && !expanded) {
    return (
      <button
        type="button"
        aria-label="Find one of your bookings by its code"
        title="Find one of your bookings by its code"
        onClick={() => {
          setExpanded(true);
          // focus after the input mounts
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        style={iconBtn}
      >
        🔎
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      style={{
        ...wrap,
        // Focus-within accent: lift the border + a soft accent ring so the box feels alive when typing.
        borderColor: focused ? T.accent : "#394867",
        boxShadow: focused ? `0 0 0 3px ${T.accent}22` : "none",
      }}
      title="Type one of YOUR booking codes (e.g. VRX-K7Q2M) to jump to it. It opens a booking only if it's one of yours."
    >
      <span aria-hidden style={{ ...glyph, opacity: focused ? 1 : 0.7, color: focused ? T.accent : T.dim }}>
        🔎
      </span>
      {showInput && (
        <input
          ref={inputRef}
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (status !== "searching" && status !== "idle") setStatus("idle");
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // On mobile, collapse back to the pill when left empty so the bar stays uncluttered.
            if (isNarrow && !value.trim() && status === "idle") setExpanded(false);
          }}
          placeholder="Find my booking…"
          aria-label="Find one of your bookings by its code"
          className="vrx-code-input"
          style={input}
        />
      )}
      {/* Persistent helper so an agent with no code to type understands what the box is for: it jumps to
          ONE OF YOUR OWN bookings by its code — it never reveals another party's booking. A code that isn't
          yours simply opens nothing (fail-safe), which the placeholder/helper framing makes read as "not mine"
          rather than "broken". The helper is desktop-only so the mobile expanded box stays compact. */}
      {hint ? (
        <span role="status" style={hintStyle}>
          {hint}
        </span>
      ) : (
        !isNarrow && <span style={helperStyle}>your code</span>
      )}
    </form>
  );
}

// ── styles (tuned to the shell topbar's pill vocabulary — see DashboardShell roleChip/DemoRoleSwitch) ──
const wrap: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  background: T.bg2, // a touch sunken vs the bar so it reads as an input well, not another pill
  border: "1px solid #394867", // SHELL_BORDER — matches the topbar's other pills
  borderRadius: 999,
  padding: "3px 12px",
  transition: "border-color .15s ease, box-shadow .15s ease", // smooth focus lift
};

const glyph: React.CSSProperties = { fontSize: 12, lineHeight: 1, transition: "color .15s ease, opacity .15s ease" };

// The collapsed mobile pill — same vocabulary as the expanded box, sized as a tap target.
const iconBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: T.panel2,
  border: "1px solid #394867",
  borderRadius: 999,
  width: 34,
  height: 30,
  fontSize: 14,
  cursor: "pointer",
  color: T.text,
  flexShrink: 0,
};

const input: React.CSSProperties = {
  background: "transparent",
  border: "none",
  outline: "none",
  color: T.text,
  fontSize: 13,
  width: 110,
  fontFamily: "ui-monospace, monospace",
  letterSpacing: 0.3,
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#e8b84b",
  whiteSpace: "nowrap",
};

// The quiet persistent helper (shown when there's no active hint) — tells an agent the box jumps to THEIR
// OWN booking by its code, so a no-op reads as "not mine" not "broken".
const helperStyle: React.CSSProperties = {
  fontSize: 11,
  color: T.dim,
  whiteSpace: "nowrap",
  opacity: 0.7,
};
