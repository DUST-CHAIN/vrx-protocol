"use client";

// TermRequestsPanel — the DEVELOPER-facing queue of buyer asks for payment terms OUTSIDE the published
// range (lib/ai-desk/term-requests). The one terms case the overlay form + AI desk can't self-serve: only the
// developer may bend their own rule. Read + resolve over /api/term-requests?developer=<me> (+ PATCH resolve).
//
// Self-contained + drop-in: <TermRequestsPanel me={accountId} />. Scoped to the developer's own buildings
// (server-enforced). PRIVACY: a request carries only a neutral money ask + the buyer's note — no buyer PII.

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";
import { card } from "@/lib/ui";

type TermRequest = {
  id: string;
  dealId: string;
  buildingId: string;
  developer: string;
  milestone?: "depositPct" | "onContractPct" | "onKeyPct" | "instalments";
  askedValue?: number;
  breach?: { side: "below" | "above"; bound: number };
  note?: string;
  source: "buyer" | "desk";
  status: "open" | "resolved";
  at: number;
};

const MILESTONE_LABEL: Record<NonNullable<TermRequest["milestone"]>, string> = {
  depositPct: "Deposit",
  onContractPct: "On contract",
  onKeyPct: "On handover",
  instalments: "Instalments",
};

/** A compact relative-time label ("2d ago"). Dependency-free. */
function ago(ms: number, now: number): string {
  const mins = Math.round(Math.abs(now - ms) / 60000);
  const body = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return `${body} ago`;
}

/** The human ask line for one request (the structured ask + its breach, or the free-text note). */
function askText(r: TermRequest): string {
  if (r.milestone && typeof r.askedValue === "number") {
    const unit = r.milestone === "instalments" ? "" : "%";
    const head = `${MILESTONE_LABEL[r.milestone]} ${r.askedValue}${unit}`;
    const b = r.breach ? ` (${r.breach.side} the ${r.breach.bound}${unit} ${r.breach.side === "above" ? "max" : "min"})` : "";
    return head + b;
  }
  return r.note ? `“${r.note}”` : "A custom payment structure";
}

export default function TermRequestsPanel({ me }: { me: string | undefined }) {
  const [requests, setRequests] = useState<TermRequest[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!me) return;
    try {
      const r = await fetch(`/api/term-requests?developer=${encodeURIComponent(me)}`);
      if (r.ok) {
        const j = await r.json();
        setRequests(j.requests as TermRequest[]);
        setNow(Date.now());
      } else setErr("could not load");
    } catch {
      setErr("could not load");
    }
  }, [me]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20000);
    return () => clearInterval(t);
  }, [load]);

  async function resolve(id: string) {
    if (!me) return;
    setBusy(id);
    try {
      await fetch("/api/term-requests", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: me, id, action: "resolve" }),
      });
      await load();
    } catch {
      /* leave state; retry */
    } finally {
      setBusy(null);
    }
  }

  if (!me) return null;

  if (!requests) {
    return (
      <div style={card}>
        <div style={{ color: T.dim, fontSize: 13 }}>{err ?? "Loading term requests…"}</div>
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Payment-term requests</div>
        {requests.length > 0 ? (
          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 6, background: T.hold, color: "#1a1206" }}>
            {requests.length} to review
          </span>
        ) : null}
      </div>

      {requests.length === 0 ? (
        <div style={{ fontSize: 13, color: T.dim }}>
          No open requests. When a buyer asks for terms outside your published range, it lands here for your call.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {requests.map((r) => (
            <div key={r.id} style={{ padding: "9px 11px", borderRadius: 8, background: T.panel2, border: `1px solid ${T.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: T.text }}>{askText(r)}</span>
                <span style={{ fontSize: 11, color: T.dim, padding: "2px 6px", borderRadius: 6, background: T.panel }}>
                  {r.buildingId}
                </span>
                <span style={{ fontSize: 11, color: T.dim, padding: "2px 6px", borderRadius: 6, background: T.panel }}>
                  via {r.source === "buyer" ? "form" : "desk"}
                </span>
              </div>
              {/* When there's a structured ask AND a note, show the note on its own line. */}
              {r.milestone && r.note ? (
                <div style={{ fontSize: 12.5, color: T.dim, marginBottom: 4 }}>“{r.note}”</div>
              ) : null}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <span style={{ fontSize: 11, color: T.dim }}>filed {ago(r.at, now)}</span>
                <button
                  onClick={() => void resolve(r.id)}
                  disabled={busy === r.id}
                  style={{
                    background: "none",
                    border: `1px solid ${T.border}`,
                    color: T.text,
                    fontSize: 11.5,
                    cursor: "pointer",
                    padding: "4px 11px",
                    borderRadius: 7,
                  }}
                >
                  {busy === r.id ? "…" : "Mark resolved"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
