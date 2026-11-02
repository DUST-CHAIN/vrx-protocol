"use client";

// BookingSearch — the top-bar "jump to a booking by its short code" box, the last booking-code
// surface. The engine (lib/booking-codes) + the resolve API (api/booking-code?resolve=) + the
// per-app deep-link focus (?section=&focus=, DashboardShell.useShellFocus) already existed; this is only
// the INPUT surface that ties them together.
// WHAT IT DOES: the user types a code ("VRX-K7Q2M", "k7q2m", "vrx k7q2m" — the resolver is tolerant) and
// hits Enter. We resolve it to the booking's opaque requestId, then route to the CURRENT ROLE's booking
// inbox with ?focus=<requestId>. The active section reads that focus id and opens the booking IF it's in
// its own list; a section simply ignores a focus id it can't find (DashboardShell line ~41). So a code for
// a booking the viewer isn't party to resolves to a real code but opens nothing for them — fail-safe, no
// cross-role leak (the privacy moat): the box never reveals a booking's content, only that a code is or
// isn't a real handle, and only routes the viewer within their OWN app.
// PRIVACY NOTE: resolve returns {requestId, code, bookingAt} — all already-opaque handles, no PII, no terms.

import { useState } from "react";
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

  // Only roles with a booking inbox get the box (owner/unregistered have nothing to jump to).
  const home = role && role !== "unregistered" ? BOOKING_HOME[role] : undefined;
  if (!home) return null;

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
      ? "No booking with that code"
      : status === "error"
        ? "Network busy — try again"
        : null;

  return (
    <form onSubmit={submit} style={wrap} title="Jump to a booking by its code, e.g. VRX-K7Q2M">
      <span aria-hidden style={glyph}>
        🔎
      </span>
      <input
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (status !== "searching" && status !== "idle") setStatus("idle");
        }}
        placeholder="Find booking…"
        aria-label="Find a booking by its code"
        style={input}
      />
      {hint && (
        <span role="status" style={hintStyle}>
          {hint}
        </span>
      )}
    </form>
  );
}

// ── styles (tuned to the shell topbar's pill vocabulary — see DashboardShell roleChip/DemoRoleSwitch) ──
const wrap: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: T.panel2,
  border: "1px solid #394867", // SHELL_BORDER — matches the topbar's other pills
  borderRadius: 999,
  padding: "2px 10px",
};

const glyph: React.CSSProperties = { fontSize: 12, opacity: 0.8, lineHeight: 1 };

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
