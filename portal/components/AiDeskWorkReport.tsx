"use client";

// AiDeskWorkReport (the slice 6+7 follow-on, the design docs §6) — the DEVELOPER-facing
// render of "what your AI Sales Director is working on". A read-only panel over /api/ai-desk-report?developer=<me>
// (lib/ai-desk/work-report.developerWorkReport): per deal, where it stands (plain-words stage), the unit in
// focus/held, the auto-release deadline, when the AI expects to close, and the AI's own running summary.
//
// Self-contained + drop-in: mount it in the developer dashboard with <AiDeskWorkReport developer={me} />. Reads
// only (no mutate); fail-soft to a short message. PRIVACY: the summary is the AI's PII-free prose about the
// deal shape — no buyer identity; the read-model scopes to the developer's own buildings.

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";
import { card } from "@/lib/ui";

type WorkReportItem = {
  dealId: string;
  buildingId: string;
  counterparty: "buyer" | "agent";
  stage: string;
  unitId?: string;
  held: boolean;
  deadlineAt?: number;
  expectedCloseAt?: number;
  summary: string;
  updatedAt: number;
};

type WorkReport = {
  developer: string;
  items: WorkReportItem[];
  totals: { active: number; held: number };
};

/** A compact relative-time label ("in 3h", "2d ago"). Stable + dependency-free. */
function when(ms: number, now: number): string {
  const diff = ms - now;
  const future = diff >= 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  const body =
    mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return future ? `in ${body}` : `${body} ago`;
}

function chip(bg: string, fg: string) {
  return {
    display: "inline-block",
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: 6,
    background: bg,
    color: fg,
  } as const;
}

export default function AiDeskWorkReport({ developer }: { developer: string | undefined }) {
  const [report, setReport] = useState<WorkReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!developer) return;
    try {
      const r = await fetch(`/api/ai-desk-report?developer=${encodeURIComponent(developer)}`);
      if (r.ok) {
        setReport((await r.json()) as WorkReport);
        setNow(Date.now());
      } else setErr("could not load");
    } catch {
      setErr("could not load");
    }
  }, [developer]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!developer) return null;

  if (!report) {
    return (
      <div style={card}>
        <div style={{ color: T.dim, fontSize: 13 }}>{err ?? "Loading desk activity…"}</div>
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>AI Sales Director — desk activity</div>
        <div style={{ display: "flex", gap: 6 }}>
          <span style={chip(T.panel2, T.dim)}>{report.totals.active} active</span>
          {report.totals.held > 0 ? <span style={chip(T.accent, "#fff")}>{report.totals.held} held</span> : null}
        </div>
      </div>

      {report.items.length === 0 ? (
        <div style={{ fontSize: 13, color: T.dim }}>No live deals — the desk isn't working anything right now.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {report.items.map((it) => (
            <div
              key={it.dealId}
              style={{ padding: "8px 10px", borderRadius: 8, background: T.panel2, border: `1px solid ${T.border}` }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{it.stage}</span>
                {it.unitId ? <span style={chip(T.panel, T.dim)}>{it.held ? "held" : "focus"} · {it.unitId}</span> : null}
                <span style={chip(T.panel, T.dim)}>{it.counterparty}</span>
                {it.held && typeof it.deadlineAt === "number" ? (
                  <span style={chip(T.panel, it.deadlineAt < now ? "#e66" : T.dim)}>releases {when(it.deadlineAt, now)}</span>
                ) : null}
                {typeof it.expectedCloseAt === "number" ? (
                  <span style={chip(T.panel, T.dim)}>close {when(it.expectedCloseAt, now)}</span>
                ) : null}
              </div>
              {it.summary ? (
                <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap" }}>{it.summary}</div>
              ) : (
                <div style={{ fontSize: 12, color: T.dim, fontStyle: "italic" }}>No summary yet.</div>
              )}
              <div style={{ fontSize: 11, color: T.dim, marginTop: 4 }}>updated {when(it.updatedAt, now)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
