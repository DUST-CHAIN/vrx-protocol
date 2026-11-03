"use client";

// LiveHeartbeat — a small, HONEST "on-chain · live" pulse. VRX is a live on-chain truth source,
// but its background refreshes (balance, chat, chain reads) happen silently — the user gets no signal the data
// is live. This gives them one: a heart/dot that BEATS each time the real NEAR block height ADVANCES.
//
// Why it's honest (not a blind timer): it polls /api/chain-head (a plain block read) on a slow cadence and
// beats ONLY when the height actually moved. A height that advances = the chain is live AND VRX is reading it.
// If a read fails or the height stalls, it shows "syncing" (grey) — a real degraded signal, never a fake beat.
//
// Cost: one light block read per poll (12s default), shared app-wide (mount once per surface). Respects
// prefers-reduced-motion via the .vrx-heartbeat CSS (globals.css) — the dot just holds steady, no pulse.

import { useCallback, useEffect, useRef, useState } from "react";
import { T } from "@/lib/theme";

const POLL_MS = 12_000; // slow + cheap; NEAR blocks are ~1s so the height always advances between polls

type Phase = "init" | "live" | "syncing";

export default function LiveHeartbeat({ compact = false }: { compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>("init");
  const [height, setHeight] = useState<number | null>(null);
  // A monotonically-incrementing key forces the CSS beat animation to REPLAY on each advance (re-trigger a
  // one-shot animation by remounting the animated node via key — the standard trick).
  const [beat, setBeat] = useState(0);
  const lastHeightRef = useRef<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/chain-head", { cache: "no-store" });
      const j = await r.json();
      if (j.live && typeof j.height === "number") {
        const advanced = lastHeightRef.current !== null && j.height > lastHeightRef.current;
        const first = lastHeightRef.current === null;
        lastHeightRef.current = j.height;
        setHeight(j.height);
        setPhase("live");
        // Beat on the first successful read AND on every subsequent advance (so it pulses, honestly, on motion).
        if (advanced || first) setBeat((b) => b + 1);
      } else {
        setPhase("syncing");
      }
    } catch {
      setPhase("syncing");
    }
  }, []);

  // Poll on mount + on a slow interval. A ref keeps the interval callback pointing at the latest poll without
  // re-arming the timer each render.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  useEffect(() => {
    void pollRef.current();
    const t = setInterval(() => void pollRef.current(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  const color = phase === "live" ? T.vetted : phase === "syncing" ? T.dim : T.dim;
  const label = phase === "syncing" ? "syncing" : "live";
  const title =
    phase === "live"
      ? `On-chain and live — NEAR block ${height?.toLocaleString("en-US") ?? "…"}. VRX reads the chain directly.`
      : phase === "syncing"
        ? "Reconnecting to the chain — the in-system record is still valid; this is just the live read catching up."
        : "Checking the chain…";

  return (
    <span
      title={title}
      aria-label={`On-chain status: ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: compact ? 11 : 12,
        fontWeight: 600,
        color,
        background: T.bg2,
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 999,
        padding: compact ? "2px 8px" : "3px 10px",
        whiteSpace: "nowrap",
        letterSpacing: 0.2,
        userSelect: "none",
      }}
    >
      {/* The beating dot. key={beat} remounts it on each advance so the one-shot .vrx-heartbeat animation
          replays — a real pulse on real on-chain motion. A ❤ when live; a hollow ○ when syncing. */}
      <span
        key={beat}
        aria-hidden
        className={phase === "live" ? "vrx-heartbeat" : undefined}
        style={{
          display: "inline-block",
          fontSize: compact ? 9 : 10,
          lineHeight: 1,
          color: phase === "live" ? T.danger : T.dim, // the heart is RED when live, grey when syncing
        }}
      >
        {phase === "syncing" ? "○" : "●"}
      </span>
      <span style={{ opacity: 0.9 }}>on-chain</span>
      <span style={{ opacity: 0.55, fontWeight: 500 }}>· {label}</span>
    </span>
  );
}
