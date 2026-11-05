"use client";

// WarroomOverview — the warroom's BI surface, extracted as a standalone component so it can mount
// TWO places from ONE source: a "Warroom" SECTION inside the developer app (/node) now, and the standalone
// /warroom app later (: "warroom shall be a menu item in developer for now … later it may become
// its own app"). Keeping it factored means graduating it to its own app is just re-adding the route + a nav
// entry — no re-write. It RUNS ON data we already hold (activity spine + the daily availability
// snapshot): no chain re-indexing.
//
// Three surfaces (the event log is mounted separately as its own section/route, so it isn't duplicated here):
//   1. KPI strip        — units available / on-hold / sold, pending booking requests, live agreements.
//   2. What's new         — a digest count of activity since this developer last opened the warroom.
//   3. Availability WALL — EVERY building as a small card (3–4 per row), each a MiniStackingPlan, under ONE
//      shared day SCRUBBER (drag, or ▶ Play to auto-step) that repaints all cards to that day's captured
//  frame. Honest gaps before capture began; no chain reads.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCatalog, timeAgo, type Building } from "@/lib/catalog-client";
import { useMoney } from "@/lib/currency";
import { card } from "@/lib/ui";
import { T } from "@/lib/theme";
import { MiniStackingPlan } from "@/components/MiniStackingPlan";

type Kpis = { available: number; onHold: number; sold: number; pending: number; agreements: number; total: number };
type DailyFrame = { developer: string; date: string; buildings: Record<string, Record<string, number>>; at: number };
type WarroomData = { kpis: Kpis; frames: DailyFrame[]; newSince: number; lastVisit: number | null };

export default function WarroomOverview({ me }: { me: string }) {
  const [data, setData] = useState<WarroomData | null>(null);
  const [err, setErr] = useState(false);
  const [catalog, setCatalog] = useState<Building[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/warroom?developer=${encodeURIComponent(me)}&days=30`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        if (j?.kpis) setData(j as WarroomData);
        else setErr(true);
      })
      .catch(() => live && setErr(true));
    fetchCatalog(me)
      .then((c) => live && setCatalog(c))
      .catch(() => live && setCatalog([]));
    return () => {
      live = false;
    };
  }, [me]);

  if (err) {
    return (
      <section style={card}>
        <div style={{ color: "#ff8f8f", fontSize: 14 }}>Couldn&apos;t load the warroom. Please refresh in a moment.</div>
      </section>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <KpiStrip kpis={data?.kpis ?? null} />
      {data && data.newSince > 0 && <WhatsNew count={data.newSince} since={data.lastVisit} />}
      <AvailabilityMap frames={data?.frames ?? []} catalog={catalog} />
    </div>
  );
}

// ── KPI strip ──────────────────────────────────────────────────────────────────────────────────
function KpiStrip({ kpis }: { kpis: Kpis | null }) {
  const items: { label: string; value: number | null; color: string; hint: string }[] = [
    { label: "Available", value: kpis?.available ?? null, color: "#5fe0a8", hint: "Units on the market right now" },
    { label: "On hold", value: kpis?.onHold ?? null, color: "#e8b84b", hint: "Units with a booking in progress" },
    { label: "Sold", value: kpis?.sold ?? null, color: "#7aa2ff", hint: "Units reserved or done" },
    { label: "Booking requests", value: kpis?.pending ?? null, color: "#ff9f6b", hint: "Awaiting your reply" },
    { label: "Live agreements", value: kpis?.agreements ?? null, color: "#c8b8e8", hint: "Agencies you've agreed terms with" },
  ];
  return (
    <section style={card}>
      <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <span>📊</span> Warroom
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))",
          gap: 12,
        }}
      >
        {items.map((it) => (
          <div
            key={it.label}
            title={it.hint}
            style={{ padding: "14px 16px", borderRadius: 10, background: "#0e1119", border: "1px solid #232838" }}
          >
            <div style={{ fontSize: 28, fontWeight: 700, color: it.color, lineHeight: 1.1, fontFamily: "ui-monospace, monospace" }}>
              {it.value === null ? "—" : it.value.toLocaleString()}
            </div>
            <div style={{ fontSize: 12.5, color: T.dim, marginTop: 4 }}>{it.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── What's new since last visit ─────────────────────────────────────────────────────────────────
function WhatsNew({ count, since }: { count: number; since: number | null }) {
  const router = useRouter();
  return (
    <section style={{ ...card, borderColor: "#2f5e9e", background: "#0f1826" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 18 }}>🔔</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          {count} new {count === 1 ? "update" : "updates"} since your last visit
        </span>
        {since != null && <span style={{ fontSize: 12.5, color: T.dim }}>last opened {timeAgo(since)}</span>}
        <span style={{ fontSize: 12.5, color: T.dim }}>
          —{" "}
          <button
            type="button"
            onClick={() => router.push("/node?section=activity")}
            style={{ background: "none", border: "none", padding: 0, color: "#6cc4ff", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}
          >
            open the Event log
          </button>{" "}
          to catch up.
        </span>
      </div>
    </section>
  );
}

// ── Availability WALL + global day scrubber ─────────────────────────────────────────────────────────
// EVERY building with captured history as a small card (3–4 per row), each a MiniStackingPlan, under ONE
// shared scrubber. Dragging the slider — or hitting ▶ Play (auto-step) — repaints ALL cards to the selected
// day's captured frame, so you watch the whole company fill up over time. Per-building gaps carry FORWARD
// (a building with no frame on a given day shows its last-known state), so the wall never flickers to blank.
// No dropdown. All reads are from stored frames — never the chain.
function AvailabilityMap({ frames, catalog }: { frames: DailyFrame[]; catalog: Building[] | null }) {
  const money = useMoney();

  // The buildings that have ANY captured frame, in catalog order.
  const buildings = useMemo(() => {
    const ids = new Set<string>();
    for (const f of frames) for (const bid of Object.keys(f.buildings)) ids.add(bid);
    return (catalog ?? []).filter((b) => ids.has(b.id));
  }, [frames, catalog]);

  // The GLOBAL timeline = the sorted union of every captured date across all buildings.
  const timeline = useMemo(() => Array.from(new Set(frames.map((f) => f.date))).sort(), [frames]);

  // Per-building, per-date lookup with PER-UNIT CARRY-FORWARD: fold every captured frame for this building
  // up to `date` (oldest→newest) into one map, so a unit keeps its last-KNOWN status when a later frame
  // simply didn't see it. (The snapshot is a copy of whatever the browse cache held that day — if a unit
  // wasn't warmed into the cache on a given day it lands as -1 "not listed", which used to make a unit that
  // was "available" yesterday read "not listed" today, a fake off-market flicker.,: unit-1001.)
  // A later REAL status (0/1/2/3) always wins; a later -1 does NOT overwrite a known status — we treat -1 as
  // "no information this day", not "went off-market". Returns null only if the building has no frame at all.
  const statusFor = useCallback(
    (buildingId: string, date: string): Record<string, number> | null => {
      const relevant = frames
        .filter((f) => f.date <= date && f.buildings[buildingId])
        .sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at);
      if (relevant.length === 0) return null;
      const merged: Record<string, number> = {};
      for (const f of relevant) {
        for (const [uid, s] of Object.entries(f.buildings[buildingId])) {
          // Keep a known status over a later -1; otherwise the newer value wins.
          if (s === -1 && merged[uid] !== undefined && merged[uid] !== -1) continue;
          merged[uid] = s;
        }
      }
      return merged;
    },
    [frames]
  );

  // Scrubber position — default to the newest day.
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(timeline.length > 0 ? timeline.length - 1 : 0);
  }, [timeline.length]);

  // ▶ Play — auto-step through the timeline (~1 day/sec), stopping at the end. Manual drag pauses it.
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    setPlaying(false);
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => {
    if (!playing) return;
    // If starting from the end, rewind so Play always animates forward.
    setIdx((i) => (i >= timeline.length - 1 ? 0 : i));
    timer.current = setInterval(() => {
      setIdx((i) => {
        if (i >= timeline.length - 1) {
          if (timer.current) clearInterval(timer.current);
          timer.current = null;
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 900);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [playing, timeline.length]);

  if (catalog === null) {
    return (
      <section style={card}>
        <div style={{ color: T.dim, fontSize: 14 }}>Loading availability…</div>
      </section>
    );
  }

  if (buildings.length === 0) {
    return (
      <section style={card}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Availability over time</div>
        <div style={{ color: T.dim, fontSize: 14, lineHeight: 1.6 }}>
          No snapshots captured yet. The warroom takes one availability snapshot a day — slide (or play) back
          through the days here once a few have built up. Today&apos;s is being captured now; check back
          tomorrow to see the timeline grow.
        </div>
      </section>
    );
  }

  const date = timeline[idx] ?? timeline[timeline.length - 1];
  const dateLabel = date
    ? new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })
    : "";
  const single = timeline.length <= 1;

  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Availability over time</div>
        <span style={{ fontSize: 12.5, color: T.dim }}>all buildings · hover a unit for detail</span>
      </div>

      {/* Global day scrubber + Play */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => (playing ? stop() : setPlaying(true))}
          disabled={single}
          title={single ? "Only one day captured so far" : playing ? "Pause" : "Play through the days"}
          style={{
            flexShrink: 0,
            width: 34,
            height: 34,
            borderRadius: 999,
            border: `1px solid ${single ? "#2a3350" : T.accent}`,
            background: playing ? T.accent : "#0e1119",
            color: playing ? "#fff" : single ? "#55607a" : T.text,
            cursor: single ? "default" : "pointer",
            fontSize: 13,
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, timeline.length - 1)}
          value={idx}
          onChange={(e) => {
            stop();
            setIdx(Number(e.target.value));
          }}
          disabled={single}
          style={{ flex: 1, minWidth: 180, accentColor: T.accent }}
          aria-label="Scrub availability by day"
        />
        <div style={{ minWidth: 200, textAlign: "right" }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{dateLabel}</div>
          <div style={{ fontSize: 11.5, color: T.dim }}>
            {single ? "the only day captured so far" : `day ${idx + 1} of ${timeline.length}`}
          </div>
        </div>
      </div>

      {/* The building WALL — responsive cards, 3–4 per row on a wide screen, 1 on a phone. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))",
          gap: 12,
        }}
      >
        {buildings.map((b) => {
          const status = statusFor(b.id, date) ?? {};
          const avail = b.inventory.filter((u) => status[u.id] === 0).length;
          return (
            <div key={b.id} style={{ padding: "12px 12px 14px", borderRadius: 10, background: "#0e1119", border: "1px solid #232838", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.name}
                </div>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, color: "#7ce0a0", flexShrink: 0 }}>{avail} available</span>
              </div>
              <MiniStackingPlan units={b.inventory} status={status} formatPrice={money} />
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 11.5, color: T.dim, marginTop: 14, marginBottom: 0, lineHeight: 1.6 }}>
        Each day the warroom saves a copy of every building&apos;s availability. Drag the slider or press play
        to watch them fill up over time. A building with no snapshot on a given day keeps its last-known
        state; days before capture began aren&apos;t shown — the timeline only grows forward from here.
      </p>
    </section>
  );
}
