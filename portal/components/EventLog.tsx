"use client";

// EventLog — the "recently happened" activity timeline. A reusable, role-agnostic section: it reads
// GET /api/activity?viewer=&role= (the engine in lib/activity-feed.ts) and renders a reverse-chronological,
// plain-language, day-grouped list of everything the viewer is a party to. /node mounts it this session; the
// SAME component serves /agency, /agent, /root later by passing a different `me`/`role` (: "reuse
// this for other users? like a module — each sees their own activities in respect to the counterparty").
//
// LIVE: subscribes to the SSE bus (useEventStream) so a new act (a reveal request, an agreement join) lands
// in the feed without a refresh — same real-time seam as the inbox. Paired with a slow safety refetch.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { card } from "@/lib/ui";
import { T } from "@/lib/theme";
import { useEventStream } from "@/lib/useEventStream";

type FeedLine = {
  id: string;
  text: string;
  // Mirrors the engine's FeedLine["category"] (lib/activity-feed.ts). standing/inventory were added later; an
  // agent's News tab needs inventory (halt/listing news from the developers it works with), so all five render.
  category: "booking" | "buyer" | "agreement" | "standing" | "inventory";
  tone: "positive" | "negative" | "neutral" | "pending";
  badge: string;
  actionable: boolean;
  link?: { section: string; focus: string };
  at: number;
};

const CATEGORY_LABEL: Record<FeedLine["category"], string> = {
  booking: "Bookings",
  buyer: "Buyers",
  agreement: "Agreements",
  standing: "Standing",
  inventory: "Listings",
};

const CATEGORY_ICON: Record<FeedLine["category"], string> = {
  booking: "📥",
  buyer: "🧑",
  agreement: "📄",
  standing: "🛡",
  inventory: "🏢",
};

const TONE_COLOR: Record<FeedLine["tone"], string> = {
  positive: "#5fe0a8",
  negative: "#ff8f8f",
  neutral: "#9aa6be",
  pending: "#e8b84b",
};

// Soft tinted background for the tone BADGE chip ("a color badge or hint depending on which are
// neutral, positive or negative"). Keeps the strong TONE_COLOR for the text/dot; a translucent fill reads
// as a calm pill, not a loud block.
const TONE_BG: Record<FeedLine["tone"], string> = {
  positive: "rgba(95,224,168,0.14)",
  negative: "rgba(255,143,143,0.14)",
  neutral: "rgba(154,166,190,0.12)",
  pending: "rgba(232,184,75,0.14)",
};

/** "Today" / "Yesterday" / a date — the day bucket a timestamp falls in (local). */
function dayBucket(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { weekday: "short", month: "short", day: "numeric" }
      : { weekday: "short", year: "numeric", month: "short", day: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

/** Clock time (local) for a row. */
function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The per-ROW stamp (: "time but no date"). The day HEADER groups rows by day, but a row read on
 *  its own had only a clock. So a row that isn't from today carries a compact date too ("Oct 5 · 3:42 PM");
 *  today's rows stay just the time (the "Today" header already says the day). Prior-YEAR rows add the year. */
function stampOf(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return clockOf(at);
  const dateOpts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" };
  return `${d.toLocaleDateString(undefined, dateOpts)} · ${clockOf(at)}`;
}

export default function EventLog({
  me,
  role,
  title = "Event log",
  blurb = "Everything happening across your bookings, buyers and agreements.",
}: {
  me: string;
  role?: string;
  /** Section heading — the agent "News" tab passes "News"; /node keeps the default "Event log". */
  title?: string;
  /** One-line sub-heading. */
  blurb?: string;
}) {
  const router = useRouter();
  const [feed, setFeed] = useState<FeedLine[] | null>(null);
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState<"all" | FeedLine["category"]>("all");
  const seq = useRef(0);

  // Deep-link a row to where its subject lives: switch the dashboard to the right section and tell it which
  // item to focus ("view log → see something pending → go directly / deeplink to it"). The shell
  // reads ?section=&focus= on the URL; we push it and let the shell honour it.
  const openRow = useCallback(
    (row: FeedLine) => {
      if (!row.link) return;
      const params = new URLSearchParams({ section: row.link.section, focus: row.link.focus });
      router.push(`?${params.toString()}`, { scroll: false });
    },
    [router]
  );

  const load = useCallback(async () => {
    if (!me) return;
    const mine = ++seq.current;
    try {
      const r = await fetch(`/api/activity?viewer=${encodeURIComponent(me)}&role=${encodeURIComponent(role ?? "")}`);
      const j = await r.json();
      if (mine !== seq.current) return; // a newer load superseded this one
      setFeed(Array.isArray(j.feed) ? j.feed : []);
      setErr(false);
    } catch {
      if (mine !== seq.current) return;
      setErr(true);
    }
  }, [me, role]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: refetch on any bus tick (a new booking/reveal/agreement act). Plus a slow safety poll in case the
  // stream dropped (same belt-and-suspenders as the inbox).
  useEventStream(() => void load(), !!me);
  useEffect(() => {
    if (!me) return;
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [me, load]);

  // The category chips shown are DATA-DRIVEN: only categories actually present in this viewer's feed get a
  // chip, in a stable canonical order. So an agent (who never has `standing` rows — those are developer/root-
  // only) simply never sees a Standing chip, while /node sees the full set — one role-agnostic component.
  const CHIP_ORDER: FeedLine["category"][] = ["booking", "buyer", "agreement", "inventory", "standing"];
  const presentCategories = useMemo(() => {
    const have = new Set((feed ?? []).map((f) => f.category));
    return CHIP_ORDER.filter((c) => have.has(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);

  // If the active filter's category vanishes from the feed (e.g. a live update), fall back to "all" so we never
  // strand the user on an empty, chip-less category.
  useEffect(() => {
    if (filter !== "all" && !presentCategories.includes(filter)) setFilter("all");
  }, [filter, presentCategories]);

  const shown = useMemo(
    () => (feed ?? []).filter((f) => filter === "all" || f.category === filter),
    [feed, filter]
  );

  // Group the visible rows by day bucket, preserving newest-first order.
  const groups = useMemo(() => {
    const out: { day: string; rows: FeedLine[] }[] = [];
    for (const row of shown) {
      const day = dayBucket(row.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(row);
      else out.push({ day, rows: [row] });
    }
    return out;
  }, [shown]);

  const chip = (key: "all" | FeedLine["category"], label: string): React.CSSProperties => ({
    padding: "4px 11px",
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
    border: `1px solid ${filter === key ? T.accent : "#2a3350"}`,
    background: filter === key ? T.panel2 : "transparent",
    color: filter === key ? T.text : "#9aa6be",
  });

  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 13, color: T.dim }}>{blurb}</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={chip("all", "All")} onClick={() => setFilter("all")}>All</button>
          {presentCategories.map((c) => (
            <button key={c} type="button" style={chip(c, CATEGORY_LABEL[c])} onClick={() => setFilter(c)}>
              {CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      </div>

      {feed === null && !err && <div style={{ color: T.dim, fontSize: 14 }}>Loading…</div>}
      {err && <div style={{ color: "#ff8f8f", fontSize: 14 }}>Couldn’t load the event log. It’ll retry shortly.</div>}
      {feed !== null && shown.length === 0 && (
        <div style={{ color: T.dim, fontSize: 14 }}>
          Nothing yet{filter !== "all" ? " in this category" : ""}. Activity shows up here as it happens.
        </div>
      )}

      {groups.map((g) => (
        <div key={g.day} style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: T.dim,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              margin: "0 0 8px 2px",
            }}
          >
            {g.day}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {g.rows.map((row) => {
              const clickable = !!row.link;
              return (
                <div
                  key={row.id}
                  onClick={clickable ? () => openRow(row) : undefined}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openRow(row);
                          }
                        }
                      : undefined
                  }
                  className={clickable ? "vrx-eventrow" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    //  (mobile): let the row WRAP so the badge / "Review →" / timestamp drop to a second
                    // line on a narrow phone instead of pushing off-screen (: News content half-clipped).
                    flexWrap: "wrap",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 8,
                    borderLeft: `3px solid ${TONE_COLOR[row.tone]}`,
                    background: row.actionable ? "#161f2e" : "#141a27",
                    cursor: clickable ? "pointer" : "default",
                    boxShadow: row.actionable ? `inset 0 0 0 1px ${TONE_COLOR[row.tone]}55` : undefined,
                  }}
                >
                  <span style={{ fontSize: 15, flexShrink: 0 }}>{CATEGORY_ICON[row.category]}</span>
                  {/* Tone badge chip — colour + word so positive/negative/pending reads at a glance. */}
                  <span
                    style={{
                      flexShrink: 0,
                      alignSelf: "center",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 999,
                      color: TONE_COLOR[row.tone],
                      background: TONE_BG[row.tone],
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: TONE_COLOR[row.tone], display: "inline-block" }} />
                    {row.badge}
                  </span>
                  <span style={{ flex: 1, minWidth: 140, fontSize: 14, lineHeight: 1.5, color: T.text, overflowWrap: "anywhere" }}>{row.text}</span>
                  {/* Actionable rows (a pending item awaiting THIS viewer) show an explicit call to act. */}
                  {row.actionable && (
                    <span
                      style={{
                        flexShrink: 0,
                        alignSelf: "center",
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: T.accent,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Review →
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: T.dim, flexShrink: 0, whiteSpace: "nowrap" }}>{stampOf(row.at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
