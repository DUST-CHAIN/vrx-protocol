"use client";

// StampJobPanel — the developer's CLEAN-SLATE onboarding workspace (§6c of
// foreground "click → wait → 10 signs". The developer ASSEMBLES a plan (each unit → its real on-chain
// state), submits it, and the server worker drips ≤50-tile chunks over time (rate-spread, resumable). This
// panel is the assemble UI + the progress readout + the SEPARATE "Go on contract" (zero-time) action and the
// standing "on contract since <date>" banner.
// the sold/closed/blocked exceptions. Each phase is its own job. Only when the slate is final does the
// developer click "Go on contract" → the commission clock starts (the VRX↔developer contract takes effect).
// THIS SESSION the worker's sign step is STUBBED server-side (no live txs) — the whole flow is exercisable
// end-to-end with zero on-chain writes. The live function-call-key signer lands in a later session.
// No contract words (stamp_tiles / open / E-codes) in the visible copy.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { card, lbl, submitBtn, banner, mono } from "@/lib/ui";
import { hashRef } from "@/lib/vrx";
import { unitRef } from "@/lib/catalog-client";

/** The four real on-chain states, in the words. Index = the contract status code (0..3). */
const STATE_LABEL = ["available", "on hold", "closed", "sold"] as const;
type Code = 0 | 1 | 2 | 3;

type Unit = { id: string; type?: string; sqm?: number; floor?: number; priceUsd?: number };

type JobProgress = {
  status: "queued" | "running" | "paused" | "done" | "failed";
  chunksTotal: number;
  chunksDone: number;
  tilesTotal: number;
  tilesDone: number;
  fraction: number;
  etaMs: number | null;
};
type Job = {
  id: string;
  building: string;
  status: JobProgress["status"];
  error: string;
  createdAt: number;
};
type Baseline = { establishedAt: number; availableUnits: string[] } | null;
// Release readiness of the slate — how many units still lack an explicit vetted status.
type Readiness = { totalUnits: number; vettedUnits: number; unvettedUnits: string[]; ready: boolean } | null;

function fmtEta(ms: number | null): string {
  if (ms == null) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function StampJobPanel({
  developer,
  building,
  units,
}: {
  /** The owning developer account (the caller / authz subject). */
  developer: string;
  /** The catalog building id. */
  building: string;
  /** The building's inventory (id + the fields that go into the integrity hash). */
  units: Unit[];
}) {
  // Per-unit desired state. Default: everything AVAILABLE (0) — the phase-1 clean slate; the developer
  // opts OUT (marks the exceptions) rather than opting in (§6b: default-select).
  const [plan, setPlan] = useState<Record<string, Code>>({});
  const [spreadMin, setSpreadMin] = useState(1.5); // minutes between chunks (the rate spread; gentle default)
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [baseline, setBaseline] = useState<Baseline>(null);
  const [readiness, setReadiness] = useState<Readiness>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Seed every unit to available on first mount.
  useEffect(() => {
    setPlan((p) => {
      if (Object.keys(p).length) return p;
      const seed: Record<string, Code> = {};
      for (const u of units) seed[u.id] = 0;
      return seed;
    });
  }, [units]);

  // Load the latest job + the current baseline for this building.
  const refresh = useCallback(async () => {
    const [jr, br] = await Promise.all([
      fetch(`/api/stamp-jobs?caller=${encodeURIComponent(developer)}&building=${encodeURIComponent(building)}`).then((r) => r.json()).catch(() => ({})),
      fetch(`/api/stamp-jobs/go-on-contract?caller=${encodeURIComponent(developer)}&building=${encodeURIComponent(building)}`).then((r) => r.json()).catch(() => ({})),
    ]);
    if (jr?.job) { setJob(jr.job); setProgress(jr.progress ?? null); } else { setJob(null); setProgress(null); }
    setBaseline(br?.baseline ?? null);
    setReadiness(br?.readiness ?? null);
  }, [developer, building]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while a job is running/queued so the progress panel stays live without a manual refresh.
  useEffect(() => {
    const active = progress && (progress.status === "running" || progress.status === "queued");
    if (active && !pollRef.current) {
      pollRef.current = setInterval(() => void refresh(), 4000);
    } else if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [progress, refresh]);

  const counts = useMemo(() => {
    const c = [0, 0, 0, 0];
    for (const u of units) c[plan[u.id] ?? 0]++;
    return c;
  }, [plan, units]);

  function setAll(code: Code) {
    const next: Record<string, Code> = {};
    for (const u of units) next[u.id] = code;
    setPlan(next);
  }

  async function submit() {
    setBusy(true);
    setNote(null);
    try {
      // Build the plan items with the SAME opaque refs the existing stamp path uses ( — hashing off-chain).
      const items = await Promise.all(
        units.map(async (u) => {
          const ref = unitRef(building, u.id);
          const unitKey = await hashRef(ref, "vrx-unit");
          const integrityHash = await hashRef(
            { ref, type: u.type, sqm: u.sqm, floor: u.floor, priceUsd: u.priceUsd },
            "vrx-tile"
          );
          return { unit: u.id, unitKey, status: plan[u.id] ?? 0, integrityHash };
        })
      );
      const res = await fetch("/api/stamp-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: developer, building, plan: items, spreadMs: Math.round(spreadMin * 60000) }),
      }).then((r) => r.json());
      if (res?.job) {
        setNote("Onboarding started — the units will be set over time. You can close this page; it keeps going.");
        await refresh();
      } else {
        setNote(res?.error || "Could not start onboarding.");
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not start onboarding.");
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "pause" | "resume") {
    if (!job) return;
    setBusy(true);
    try {
      await fetch("/api/stamp-jobs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: developer, id: job.id, action }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function goOnContract() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/stamp-jobs/go-on-contract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: developer, building }),
      }).then((r) => r.json());
      if (res?.baseline) {
        setBaseline(res.baseline);
        setNote(null);
      } else {
        setNote(res?.error || "Could not go on contract yet.");
      }
    } finally {
      setBusy(false);
    }
  }

  const running = progress && (progress.status === "running" || progress.status === "queued");
  const canGoOnContract = !running && units.length > 0;

  return (
    <div style={{ ...card, borderColor: "#2b62ff" }}>
      <b style={{ fontSize: 15 }}>Onboarding — set the slate</b>

      {/* The standing "on contract since" banner (: shown so everyone knows the start date). */}
      {baseline && (
        <div style={{ ...banner, borderColor: "#2b62ff", background: "#101a2e" }}>
          <b>On contract with VRX since {fmtDate(baseline.establishedAt)}.</b>{" "}
          <span style={{ opacity: 0.8 }}>
            Commission counts on sales from that day on — {baseline.availableUnits.length} unit
            {baseline.availableUnits.length === 1 ? "" : "s"} available at the slate.
          </span>
        </div>
      )}

      <p style={{ fontSize: 13, opacity: 0.8, marginTop: 10 }}>
        Mark every unit&apos;s real state. All units start as <b>available</b> — change the ones that are already
        sold, closed, or on hold. When the slate is correct, run it. Already-sold units don&apos;t count for
        commission; they were sold before the contract.
      </p>

      {/* Bulk helpers + the per-state counts. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <button type="button" disabled={busy} onClick={() => setAll(0)} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}>
          All available
        </button>
        <span style={{ fontSize: 13, opacity: 0.85, marginLeft: 6, alignSelf: "center" }}>
          {counts[0]} available · {counts[3]} sold · {counts[2]} closed · {counts[1]} on hold
        </span>
      </div>

      {/* Per-unit state selectors — only shown when no job is running (assemble mode). */}
      {!running && (
        <div style={{ maxHeight: 280, overflowY: "auto", marginTop: 12, border: "1px solid #232838", borderRadius: 8 }}>
          {units.map((u) => (
            <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderBottom: "1px solid #1a1f2c" }}>
              <span style={{ ...mono, fontSize: 13, minWidth: 90 }}>{u.id}</span>
              <span style={{ fontSize: 12, opacity: 0.6, flex: 1 }}>
                {[u.type, u.floor != null ? `fl ${u.floor}` : null, u.sqm ? `${u.sqm}m²` : null].filter(Boolean).join(" · ")}
              </span>
              <select
                value={plan[u.id] ?? 0}
                onChange={(e) => setPlan((p) => ({ ...p, [u.id]: Number(e.target.value) as Code }))}
                disabled={busy}
                style={{ background: "#0e1119", color: "#e6e9ef", border: "1px solid #2a2f40", borderRadius: 6, padding: "4px 8px", fontSize: 13 }}
              >
                {STATE_LABEL.map((label, code) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {/* The rate-spread control + submit (assemble mode). */}
      {!running && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
          <label style={{ ...lbl, marginBottom: 0 }}>
            Spread over{" "}
            <input
              type="number"
              min={0}
              step={0.5}
              value={spreadMin}
              onChange={(e) => setSpreadMin(Math.max(0, Number(e.target.value)))}
              disabled={busy}
              style={{ width: 64, background: "#0e1119", color: "#e6e9ef", border: "1px solid #2a2f40", borderRadius: 6, padding: "4px 8px", fontSize: 13 }}
            />{" "}
            min between batches
          </label>
          <span style={{ fontSize: 12, opacity: 0.6 }}>
            {Math.ceil(units.length / 50)} batch{Math.ceil(units.length / 50) === 1 ? "" : "es"} of up to 50 units
          </span>
          <button type="button" onClick={submit} disabled={busy || units.length === 0} style={{ ...submitBtn, marginLeft: "auto" }}>
            Run onboarding
          </button>
        </div>
      )}

      {/* The live progress panel (running mode). */}
      {progress && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 14 }}>
              {progress.status === "running" && "Setting units…"}
              {progress.status === "queued" && "Queued…"}
              {progress.status === "paused" && "Paused"}
              {progress.status === "done" && "All units set ✓"}
              {progress.status === "failed" && "Stopped — needs attention"}
            </b>
            <span style={{ fontSize: 13, opacity: 0.8 }}>
              {progress.tilesDone} / {progress.tilesTotal} units
              {progress.etaMs != null && progress.status === "running" ? ` · ${fmtEta(progress.etaMs)} left` : ""}
            </span>
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              {running && (
                <button type="button" onClick={() => control("pause")} disabled={busy} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13, background: "#18202f", color: "#c7cde0" }}>
                  Pause
                </button>
              )}
              {(progress.status === "paused" || progress.status === "failed") && (
                <button type="button" onClick={() => control("resume")} disabled={busy} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13 }}>
                  Resume
                </button>
              )}
            </div>
          </div>
          {/* Progress bar. */}
          <div style={{ height: 8, background: "#1a1f2c", borderRadius: 999, marginTop: 8, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round(progress.fraction * 100)}%`, background: "#2b62ff", transition: "width .4s" }} />
          </div>
          {job?.error && progress.status === "failed" && (
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Reason: {job.error}</p>
          )}
        </div>
      )}

      {/* Go on contract — the separate, deliberate zero-time action. Only when nothing is mid-run. */}
      {canGoOnContract && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #232838" }}>
          <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>
            When the whole slate is correct, go on contract. This fixes the start date — commission counts from
            that day on. {baseline ? "Re-running updates the available set but keeps the original date." : ""}
          </p>
          {/*  Surface units with no decision yet. Advisory, not a block — the developer can still
              go on contract (those units simply aren't bookable until given a status). Clean = nothing shown. */}
          {readiness && readiness.unvettedUnits.length > 0 && (
            <p style={{ fontSize: 12.5, color: "#e8b84b", margin: "0 0 10px", lineHeight: 1.45 }}>
              {readiness.unvettedUnits.length} of {readiness.totalUnits} unit
              {readiness.unvettedUnits.length === 1 ? " hasn’t" : "s haven’t"} been given a status yet. You can
              still go on contract, but those units won’t be bookable until you mark each one above.
            </p>
          )}
          <button type="button" onClick={goOnContract} disabled={busy} style={submitBtn}>
            {baseline ? "Update the slate" : "Go on contract"}
          </button>
        </div>
      )}

      {note && (
        <p style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 13, background: "#141824", border: "1px solid #232838" }}>
          {note}
        </p>
      )}
    </div>
  );
}
