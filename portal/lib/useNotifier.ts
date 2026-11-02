// Generic client NOTIFIER hook — a soft WebAudio chime + a real browser Notification (one-time permission,
// requested on first use, silently degrades if denied/unsupported). Pure client UX; touches no chain.
// Extracted from the developer inbox (node/page.tsx) so EVERY surface uses ONE implementation (the "reuse the
// developer acts on one of theirs, the BUYER when the sales desk replies. Caller supplies title/body so the
// same hook serves any signal. The document-title badge is the caller's concern (page-specific text).
// away-from-screen operator actually hears it. Default 1 (unchanged for existing callers).
// take the user to reply"). Clicking focuses the tab and navigates there. Omitted → click just focuses.

import { useCallback, useRef } from "react";

export type NotifyOpts = {
  /** Collapse rapid-fire notifications of the same kind into one (per the Notification spec). */
  tag?: string;
  /** How many times to repeat the chime, spaced apart. Default 1.: 3 for chat/bookings. */
  repeat?: number;
  /** URL the notification opens on click (same tab, focused). Deep-links straight to the reply surface. */
  href?: string;
};

export function useNotifier() {
  const askedRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // One "ding-dong" (two soft notes) starting at offset `startAt` seconds from now.
  const dingDong = useCallback((ctx: AudioContext, startAt: number) => {
    const base = ctx.currentTime + startAt;
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = base + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  }, []);

  const chime = useCallback(
    (repeat = 1) => {
      try {
        type WithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext };
        const Ctor = window.AudioContext ?? (window as WithWebkit).webkitAudioContext;
        if (!Ctor) return;
        const ctx = audioCtxRef.current ?? new Ctor();
        audioCtxRef.current = ctx;
        if (ctx.state === "suspended") void ctx.resume();
        // Each repeat is one full ding-dong (~0.46s); space them ~0.55s apart so they read as distinct rings.
        const times = Math.max(1, Math.min(repeat, 5)); // clamp — never more than 5 rings
        for (let i = 0; i < times; i++) dingDong(ctx, i * 0.55);
      } catch {
        /* audio blocked (e.g. no prior user gesture) — the title badge + notification still fire */
      }
    },
    [dingDong]
  );

  // Fire the cues: chime (optionally repeated) + a browser Notification (optionally deep-linking on click).
  return useCallback(
    (title: string, body: string, opts: string | NotifyOpts = {}) => {
      // Back-compat: a string third arg is the tag (the old (title, body, tag) signature).
      const o: NotifyOpts = typeof opts === "string" ? { tag: opts } : opts;
      const tag = o.tag ?? "vrx";
      chime(o.repeat ?? 1);
      if (typeof Notification === "undefined") return;
      const show = () => {
        try {
          const n = new Notification(title, { body, tag });
          if (o.href) {
            n.onclick = () => {
              try {
                window.focus();
                window.location.href = o.href!;
              } catch {
                /* best-effort */
              }
              n.close();
            };
          }
        } catch {
          /* best-effort */
        }
      };
      if (Notification.permission === "granted") {
        show();
      } else if (Notification.permission === "default" && !askedRef.current) {
        askedRef.current = true;
        void Notification.requestPermission().then((p) => {
          if (p === "granted") show();
        });
      }
    },
    [chime]
  );
}
