// The transparency lever: a developer may always STOP selling their own building, but a halt carries an
// explanatory NOTE (their own words) and everyone it affects can see what's going on. This is the UI over the
// (already-live) /api/catalog/halt route — assert a halt (regular|urgent, mandatory note), see the live halt +
// its history, and LIFT it when the building resumes.
// • Regular ("ask us first") — staged; takes effect once VRX acknowledges it. Use when there's no emergency.
// • Urgent ("stop now") — takes effect immediately (a legal issue, a pricing error, a unit that must not
// be booked). VRX is told right after.
// The NOTE is MANDATORY for both (the route 400s without one) — it's the source of the "what happened"
// explanation every affected party will see (the surprise card, the news line, the relationship channel).
// AUTH: the panel sends `by: developer` (F1 param-fallback today, lib/caller); the route proves the caller OWNS
// the building before it writes. PRIVACY: off-chain B2B fact; nothing on-chain; the note is the developer's
// own words, shown verbatim.
// Self-contained like RelationshipChannel: pass the developer + building, it loads the live halt + history on
// mount and refreshes after each action. The parent just mounts it.

"use client";

import { useCallback, useEffect, useState } from "react";
import { input, submitBtn, lbl } from "@/lib/ui";
import { T } from "@/lib/theme";
import { timeAgo } from "@/lib/catalog-client";

type HaltTier = "regular" | "urgent";
type HaltStatus = "pending" | "active" | "lifted";

// The salt-stripped projection the route returns (lib/building-halt.publicHalt).
type PublicHalt = {
  id: string;
  building: string;
  developer: string;
  tier: HaltTier;
  note: string;
  status: HaltStatus;
  assertedAt: number;
  acknowledged?: { by: string; at: number };
  lifted?: { by: string; at: number };
  sealHash: string;
  at: number;
  updatedAt: number;
};

const TIER_COPY: Record<HaltTier, { label: string; hint: string; colour: string }> = {
  regular: {
    label: "Regular — ask us first",
    hint: "No emergency. The pause takes effect once VRX acknowledges it; your partners are told either way.",
    colour: T.hold,
  },
  urgent: {
    label: "Urgent — stop now",
    hint: "Takes effect immediately (a legal issue, a pricing error, a unit that must not be booked). VRX is told right after.",
    colour: T.danger,
  },
};

/** Plain-words status line for a live/historical halt. */
function statusLine(h: PublicHalt): { text: string; colour: string } {
  if (h.status === "pending") return { text: "Pending VRX acknowledgement — not yet hidden", colour: T.hold };
  if (h.status === "active") return { text: "Active — this building is paused", colour: T.danger };
  return { text: "Lifted — the building has resumed", colour: T.vetted };
}

export default function BuildingHaltPanel({
  developer,
  building,
  buildingName,
  onChanged,
}: {
  /** The developer (owner) account — sent as `by`; the route verifies ownership. */
  developer: string;
  /** The catalog building id this panel controls. */
  building: string;
  /** Display name for the heading (falls back to the id). */
  buildingName?: string;
  /** Called after a successful assert/lift so the parent can refresh its catalog view. */
  onChanged?: () => void;
}) {
  const [live, setLive] = useState<PublicHalt | null>(null);
  const [history, setHistory] = useState<PublicHalt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tier, setTier] = useState<HaltTier>("regular");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    if (!developer || !building) return;
    try {
      const qs = new URLSearchParams({ building, account: developer }).toString();
      const r = await fetch(`/api/catalog/halt?${qs}`);
      if (!r.ok) {
        setLoaded(true);
        return;
      }
      const j = (await r.json()) as { halt: PublicHalt | null; history: PublicHalt[] };
      setLive(j.halt ?? null);
      setHistory(j.history ?? []);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [developer, building]);

  useEffect(() => {
    void load();
  }, [load]);

  const assert = useCallback(async () => {
    const trimmed = note.trim();
    if (!trimmed) {
      setMsg("Add a note saying why you're pausing this building — your partners will see it.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/catalog/halt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "halt", building, by: developer, tier, note: trimmed }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setNote("");
        setMsg(tier === "urgent" ? "Building paused — VRX has been notified." : "Pause requested — VRX will acknowledge it shortly.");
        await load();
        onChanged?.();
      } else {
        setMsg(j.error || "Couldn't pause the building.");
      }
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }, [note, tier, building, developer, load, onChanged]);

  const lift = useCallback(async () => {
    if (!live) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/catalog/halt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "lift", building, by: developer, id: live.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setMsg("Building resumed.");
        await load();
        onChanged?.();
      } else {
        setMsg(j.error || "Couldn't resume the building.");
      }
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }, [live, building, developer, load, onChanged]);

  const name = buildingName || building;

  return (
    <section
      style={{
        marginTop: 16,
        padding: "12px 16px 16px",
        borderRadius: 12,
        background: T.panel,
        border: `1px solid ${live ? T.danger + "55" : T.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>⏸ Pause selling this building</h3>
        <span style={{ fontSize: 12.5, opacity: 0.6 }}>
          Stop new bookings &amp; browsing on {name}. Your signed-up partners are told, with your note.
        </span>
      </div>

      {!loaded ? (
        <p style={{ fontSize: 12.5, opacity: 0.55, marginTop: 10 }}>Loading…</p>
      ) : live ? (
        // ── A live (pending|active) halt: show it + the LIFT control. ──
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              background: T.panel2,
              border: `1px solid ${statusLine(live).colour}55`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: statusLine(live).colour }}>
                {statusLine(live).text}
              </span>
              <span style={{ fontSize: 11.5, opacity: 0.6 }}>
                {live.tier === "urgent" ? "Urgent" : "Regular"} · paused {timeAgo(live.assertedAt)}
              </span>
            </div>
            <p style={{ fontSize: 13, margin: "8px 0 0", lineHeight: 1.5 }}>
              <span style={{ opacity: 0.6 }}>Your note:</span> “{live.note}”
            </p>
            {live.status === "pending" && (
              <p style={{ fontSize: 11.5, opacity: 0.65, margin: "6px 0 0" }}>
                This building is still visible until VRX acknowledges the pause. Choose <em>Urgent</em> next time
                if it must stop at once.
              </p>
            )}
          </div>
          <button type="button" onClick={lift} disabled={busy} style={{ ...submitBtn, marginTop: 12, background: T.vetted, border: "none" }}>
            {busy ? "…" : "Resume selling"}
          </button>
        </div>
      ) : (
        // ── No live halt: the ASSERT form. ──
        <div style={{ marginTop: 12 }}>
          <label style={lbl}>How urgent is this pause?</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            {(["regular", "urgent"] as HaltTier[]).map((t) => {
              const selected = tier === t;
              const c = TIER_COPY[t];
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontSize: 13.5,
                    background: selected ? c.colour + "22" : T.bg2,
                    border: `1px solid ${selected ? c.colour : T.border}`,
                    color: selected ? c.colour : T.dim,
                    fontWeight: selected ? 600 : 400,
                  }}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <p style={{ fontSize: 11.5, opacity: 0.65, margin: "0 0 10px" }}>{TIER_COPY[tier].hint}</p>

          <label style={lbl}>Why are you pausing this building? (required — your partners will see this)</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="e.g. Pausing new bookings while we finalise the revised payment plan. Existing deals are unaffected."
            style={{ ...input, fontFamily: "inherit", resize: "vertical", marginBottom: 10 }}
          />
          <button type="button" onClick={assert} disabled={busy || !note.trim()} style={{ ...submitBtn, background: TIER_COPY[tier].colour, border: "none", color: "#0a0e17" }}>
            {busy ? "…" : tier === "urgent" ? "Pause now" : "Request pause"}
          </button>
        </div>
      )}

      {msg && <p style={{ fontSize: 12.5, marginTop: 10, color: msg.startsWith("Network") || msg.startsWith("Couldn't") ? T.danger : T.dim }}>{msg}</p>}

      {history.length > 0 && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 8 }}>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            style={{ background: "none", border: "none", color: T.dim, fontSize: 12, cursor: "pointer", padding: 0 }}
          >
            {showHistory ? "Hide" : "Show"} pause history ({history.length})
          </button>
          {showHistory && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {history.map((h) => (
                <div key={h.id} style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.5 }}>
                  <span style={{ color: statusLine(h).colour }}>●</span> {h.tier === "urgent" ? "Urgent" : "Regular"} ·{" "}
                  {h.status} · {timeAgo(h.assertedAt)} — “{h.note}”
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
