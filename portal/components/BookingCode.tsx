// BookingCode — a tiny, reusable chip that shows a booking's short memorable code (VRX-DDD-NNN).
//
// The code is minted/looked-up lazily by /api/booking-code from the booking's requestId (the server resolves
// the developer from the offer). This component fetches it once per requestId and caches it process-wide, so
// a list of 50 bookings makes at most 50 cheap requests the FIRST time and zero on every re-render after —
// the same discipline the status cache uses for units. Copy-to-clipboard on click so it's quick to paste.
//
// PRIVACY: the code is opaque — it reveals nothing about the buyer/terms. Safe to show on any surface.

"use client";

import { useEffect, useState } from "react";
import { T } from "@/lib/theme";

// Process-wide memo so the same code never refetches (requestId → code, or "" when not scopable yet).
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

async function loadCode(requestId: string): Promise<string> {
  if (cache.has(requestId)) return cache.get(requestId)!;
  const existing = inflight.get(requestId);
  if (existing) return existing;
  const p = fetch(`/api/booking-code?requestId=${encodeURIComponent(requestId)}`)
    .then((r) => (r.ok ? r.json() : { code: "" }))
    .then((d: { code?: string }) => d.code ?? "")
    .catch(() => "")
    .then((code) => {
      cache.set(requestId, code);
      inflight.delete(requestId);
      return code;
    });
  inflight.set(requestId, p);
  return p;
}

/** Imperative getter for non-React callers (e.g. building a title string). Resolves to "" if not scopable. */
export function getBookingCode(requestId: string): Promise<string> {
  return loadCode(requestId);
}

export default function BookingCode({
  requestId,
  size = 12,
  copyable = true,
}: {
  requestId: string;
  /** font size px — matches the surrounding line (chat header bigger, list rows smaller). */
  size?: number;
  copyable?: boolean;
}) {
  const [code, setCode] = useState<string>(() => cache.get(requestId) ?? "");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    if (!code) void loadCode(requestId).then((c) => live && setCode(c));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  if (!code) return null; // nothing to show until it resolves (a booking with no offer stays blank)

  const copy = async () => {
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked (insecure context) — the code is still visible to read/quote */
    }
  };

  return (
    <span
      onClick={copyable ? copy : undefined}
      title={copyable ? (copied ? "Copied!" : "Booking code — click to copy") : "Booking code"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "ui-monospace, monospace",
        fontSize: size,
        fontWeight: 600,
        letterSpacing: 0.3,
        color: copied ? "#7ce0a0" : "#6cc4ff",
        background: "#141c2a",
        border: `1px solid ${copied ? "#2f6a44" : "#243049"}`,
        borderRadius: 5,
        padding: "1px 6px",
        cursor: copyable ? "pointer" : "default",
        whiteSpace: "nowrap",
        userSelect: "all",
      }}
    >
      {copied ? "✓ copied" : code}
    </span>
  );
}
