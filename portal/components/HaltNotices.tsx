// Mounts on the agent + agency dashboards. On load it asks GET /api/halt-notices?viewer=<me> for every live
// halt that touches this viewer, and renders:
// • set (a) EXISTING-DEAL notice — UNMISSABLE: a loud, persistent banner (danger tone for an urgent halt,
// hold tone otherwise). Its "dismiss" is GATED — the moment it's shown we POST action:"seen" (which arms
// the dismiss server-side), and only THEN does the Hide button enable. You can't make it go away without
// it having been seen. Carries the developer's own-words NOTE + an "Ask the developer" button.
// • set (b) FORWARD-ONLY card — the lighter, freely-dismissible Part-B card (a building you're signed up on
// paused, but you have no live deal on it).
// "Ask the developer" opens the Part-D relationship channel (components/RelationshipChannel) in a modal, keyed
// on (developer, the viewer's agency) — the deep-link target the notice carries (askMore). VRX SURFACES, never
// adjudicates: the copy states the fact + quotes the note + offers a channel to ask; it promises nothing.
// DISMISS is CLIENT-LOCAL (a hide for this browser session) — honest: the server records only that the party
// was SHOWN the notice (the audit-able "they were told"), not a per-browser hide. A set-(a) notice re-appears
// on reload until the halt is lifted (it's unmissable by design); the dismiss just collapses it for now. A
// set-(b) card hides freely. Plain words only; the note is the developer's verbatim (never translated).

"use client";

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";
import { timeAgo } from "@/lib/catalog-client";
import RelationshipChannel from "@/components/RelationshipChannel";

type HaltNoticeKind = "existing_deal" | "forward_only";

type HaltNotice = {
  haltId: string;
  building: string;
  buildingLabel: string;
  developer: string;
  tier: "regular" | "urgent";
  note: string;
  assertedAt: number;
  kind: HaltNoticeKind;
  myDealCount: number;
  seen: boolean;
  askMore: { developer: string; agency: string } | null;
};

export default function HaltNotices({ me }: { me: string }) {
  const [notices, setNotices] = useState<HaltNotice[]>([]);
  // Client-local hides (per browser session) — see header. Keyed by haltId.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Which notice's "ask the developer" modal is open (its askMore target), or null.
  const [ask, setAsk] = useState<{ developer: string; agency: string } | null>(null);

  const load = useCallback(async () => {
    if (!me) return;
    try {
      const r = await fetch(`/api/halt-notices?viewer=${encodeURIComponent(me)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { notices?: HaltNotice[] };
      setNotices(Array.isArray(j.notices) ? j.notices : []);
    } catch {
      /* transient — keep what we have */
    }
  }, [me]);

  useEffect(() => {
    load();
  }, [load]);

  // The moment an UNSEEN set-(a) notice is on screen, record that the party was shown it (arms the dismiss).
  // We only need to do this for the unmissable ones — a forward-only card is freely dismissible already.
  useEffect(() => {
    const unseenA = notices.filter((n) => n.kind === "existing_deal" && !n.seen);
    if (unseenA.length === 0) return;
    (async () => {
      for (const n of unseenA) {
        await fetch("/api/halt-notices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ viewer: me, haltId: n.haltId, action: "seen" }),
        }).catch(() => {});
      }
      // Reflect the armed state locally so the Hide button enables without a full reload.
      setNotices((cur) => cur.map((n) => (n.kind === "existing_deal" ? { ...n, seen: true } : n)));
    })();
  }, [notices, me]);

  const visible = notices.filter((n) => !hidden.has(n.haltId));
  if (visible.length === 0) return null;

  const hide = (haltId: string) => setHidden((cur) => new Set(cur).add(haltId));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
      {visible.map((n) => {
        const urgent = n.tier === "urgent";
        const isA = n.kind === "existing_deal";
        // set (a) = loud (danger if urgent, hold otherwise); set (b) = quiet neutral card.
        const tone = isA ? (urgent ? T.danger : T.hold) : T.border;
        const headColor = isA ? (urgent ? "#ff9a9a" : "#e8c876") : T.text;
        return (
          <div
            key={n.haltId}
            style={{
              border: `1px solid ${tone}`,
              borderLeft: `4px solid ${tone}`,
              background: isA
                ? urgent
                  ? "rgba(255,107,107,0.08)"
                  : "rgba(232,184,75,0.08)"
                : "rgba(35,45,64,0.35)",
              borderRadius: 10,
              padding: "12px 15px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: headColor }}>
                {isA ? "⚠ Building halted — affects your deal" : "ℹ A building you work with was paused"}
                {" — "}
                {n.buildingLabel}
              </div>
              <div style={{ fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" }}>{timeAgo(n.assertedAt)}</div>
            </div>

            {isA && (
              <div style={{ fontSize: 12.5, opacity: 0.9, marginTop: 4 }}>
                This affects{" "}
                <strong>
                  {n.myDealCount} of your {n.myDealCount === 1 ? "deals" : "deals"}
                </strong>{" "}
                on this building. Your past sales and earned commission are unaffected and continue in full.
              </div>
            )}
            {!isA && (
              <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 4 }}>
                You&rsquo;re signed up on this building but have no live deal on it — nothing of yours is affected.
              </div>
            )}

            {/* The developer's own words — quoted verbatim, never translated. */}
            <div
              style={{
                fontSize: 13,
                marginTop: 8,
                padding: "8px 11px",
                background: "rgba(0,0,0,0.18)",
                borderRadius: 7,
                borderLeft: `2px solid ${T.border}`,
                fontStyle: "italic",
                opacity: 0.95,
              }}
            >
              &ldquo;{n.note}&rdquo;
              <div style={{ fontSize: 11, fontStyle: "normal", opacity: 0.55, marginTop: 3 }}>
                — {n.developer} (the developer&rsquo;s own words)
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              {n.askMore && (
                <button
                  onClick={() => setAsk(n.askMore)}
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    padding: "6px 13px",
                    borderRadius: 7,
                    border: `1px solid ${T.accent}`,
                    background: "transparent",
                    color: T.accent,
                    cursor: "pointer",
                  }}
                >
                  Ask the developer
                </button>
              )}
              {/* set (a): Hide is GATED on seen (always armed by the time it renders — see effect). set (b): free. */}
              <button
                onClick={() => hide(n.haltId)}
                disabled={isA && !n.seen}
                title={isA ? "You can hide this once it's been seen" : "Dismiss"}
                style={{
                  fontSize: 12.5,
                  padding: "6px 13px",
                  borderRadius: 7,
                  border: `1px solid ${T.border}`,
                  background: "transparent",
                  color: isA && !n.seen ? T.border : T.text,
                  cursor: isA && !n.seen ? "not-allowed" : "pointer",
                  opacity: isA && !n.seen ? 0.5 : 0.85,
                }}
              >
                Hide
              </button>
              <span style={{ fontSize: 11, opacity: 0.5 }}>
                VRX surfaces this on the developer&rsquo;s behalf. It doesn&rsquo;t decide the outcome.
              </span>
            </div>
          </div>
        );
      })}

      {/* "Ask the developer" → the Part-D relationship channel in a modal. */}
      {ask && (
        <div
          onClick={() => setAsk(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.bg,
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              padding: 16,
              width: "min(560px, 100%)",
              maxHeight: "85vh",
              overflow: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Ask {ask.developer}</div>
              <button
                onClick={() => setAsk(null)}
                style={{ background: "transparent", border: "none", color: T.text, fontSize: 20, cursor: "pointer", opacity: 0.7 }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <RelationshipChannel developer={ask.developer} agency={ask.agency} me={me} />
          </div>
        </div>
      )}
    </div>
  );
}
