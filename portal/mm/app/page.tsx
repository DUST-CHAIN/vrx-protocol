"use client";

// MM HOME. the flow: open to a CLEAN empty start — nothing preloaded — offering IMPORT or START
// BUILDING (+ the separate "New from AI" door). Only once the user picks do we enter the one-frame app
// (app/AppShell.tsx: tree + Studio map + Preview). "Start building" gives them land + one empty building to grow;
// they add detail or switch to the Studio map to set the land, and add more buildings as needed.
//
// "Untouched" is tracked by a dedicated localStorage flag (mm.started) set the moment they Import or Start —
// decoupled from the data model (the store stays always-valid per the canon's law #2; this only gates the UI).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "./useProject";
import { readEntityFile } from "@/lib/entity-file";
import { AppShell } from "./AppShell";
import { T } from "@/lib/theme";

const STARTED_KEY = "mm.started";

export default function Home() {
  const store = useProject();
  const [started, setStarted] = useState<boolean | null>(null); // null = not yet read (avoids SSR/first-paint flash)

  useEffect(() => {
    try { setStarted(localStorage.getItem(STARTED_KEY) === "1"); } catch { setStarted(true); }
  }, []);

  if (!store.hydrated || started === null) {
    return <div className="mm-empty" style={{ padding: 60 }}>Loading…</div>;
  }
  if (!started) {
    return <StartScreen onStarted={() => { try { localStorage.setItem(STARTED_KEY, "1"); } catch {} setStarted(true); }} />;
  }
  return <AppShell />;
}

// ── the clean empty start: Import · Start building · (separate) New from AI, with a short how-to ──────────────
function StartScreen({ onStarted }: { onStarted: () => void }) {
  const router = useRouter();
  const store = useProject();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [err, setErr] = useState("");

  // Start building: begin from a clean, minimal project (one empty building to grow) and enter the workspace.
  function startBuilding() {
    store.loadNew();
    onStarted();
  }

  // Import: read a picked entity file into the store, then enter the workspace.
  async function onImportFile(file: File | undefined) {
    if (!file) return;
    const env = await readEntityFile(file);
    if (!env) { setErr("That file isn't a valid MM project/entity export."); return; }
    store.importEntity(env);
    onStarted();
  }

  return (
    <div style={{ background: T.bg, color: T.text, minHeight: "100vh", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: `1px solid ${T.border}` }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: T.accent, display: "inline-block" }} />
        <b style={{ fontSize: 15 }}>VRX Model Maker</b>
        <span style={{ color: T.faint, fontSize: 12 }}>build a development for VRX</span>
      </div>

      <input
        ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
        onChange={(e) => { onImportFile(e.target.files?.[0]); e.target.value = ""; }}
      />

      <div style={{ maxWidth: 820, margin: "56px auto 0", padding: "0 20px" }}>
        <h1 style={{ fontSize: 27, margin: "0 0 8px" }}>Start your project</h1>
        <div style={{ fontSize: 14.5, color: T.dim, marginBottom: 30, lineHeight: 1.6, maxWidth: 640 }}>
          This tool turns a development — its buildings, units, prices and floor plans — into the package VRX
          imports. Begin from nothing, or load a project you saved earlier.
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <DoorCard
            kicker="✎"
            title="Start building"
            body="Begin from a blank project — one empty building to grow. Add floors and units, then draw the land and floor plans on the map."
            onClick={startBuilding}
          />
          <DoorCard
            kicker="⭱"
            title="Import a project"
            body="Load a developer, development, or building you exported earlier as a JSON file, and keep working on it."
            onClick={() => fileRef.current?.click()}
          />
        </div>
        {err && <div style={{ color: T.danger, fontSize: 13, marginTop: 12 }}>{err}</div>}

        <div style={{ marginTop: 22, fontSize: 12.5, color: T.faint }}>
          Rather have AI draft the whole building from a sentence?{" "}
          <button
            onClick={() => router.push("/ai")}
            style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", font: "inherit", padding: 0, textDecoration: "underline" }}
            title="The separate AI generator: one line of text → a complete building you then refine"
          >
            ✦ New from AI →
          </button>
        </div>

        {/* A short how-to for first-timers — what the workspace is, in plain words. */}
        <HowTo />
      </div>
    </div>
  );
}

function DoorCard({ kicker, title, body, onClick }: { kicker: string; title: string; body: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: "1 1 320px", minWidth: 300, textAlign: "left", background: T.panel, color: T.text,
        border: `1px solid ${T.border}`, borderRadius: 14, padding: "24px 24px 26px", cursor: "pointer",
        transition: "border-color .12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.accent; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; }}
    >
      <div style={{ fontSize: 30, marginBottom: 12, color: T.accent }}>{kicker}</div>
      <div style={{ fontSize: 18, fontWeight: 700, margin: "0 0 6px" }}>{title}</div>
      <div style={{ fontSize: 13, color: T.dim, lineHeight: 1.55 }}>{body}</div>
    </button>
  );
}

// A quiet, dismissible "how it works" so a first-time user understands the three faces before diving in.
function HowTo() {
  const steps: Array<[string, string, string]> = [
    ["Structured", "Enter the facts", "The developer, buildings, unit types, sizes, prices and payment plans — the data, in a clear tree."],
    ["Studio", "Draw the plan", "Lay out the land and each building's floor plans on a map/drawing board — sizes and prices roll up."],
    ["Preview", "See the result", "Exactly what a buyer sees. When it looks right, export the package for VRX to import."],
  ];
  return (
    <div style={{ marginTop: 44, borderTop: `1px solid ${T.borderSoft}`, paddingTop: 22 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.faint, marginBottom: 14 }}>
        How it works — three steps, in any order
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {steps.map(([face, head, body], i) => (
          <div key={face} style={{ flex: "1 1 210px", minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ width: 20, height: 20, borderRadius: 5, background: T.bg2, border: `1px solid ${T.border}`,
                display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: T.accent }}>{i + 1}</span>
              <b style={{ fontSize: 13.5 }}>{head}</b>
              <span style={{ fontSize: 11, color: T.faint }}>· {face}</span>
            </div>
            <div style={{ fontSize: 12.5, color: T.dim, lineHeight: 1.5 }}>{body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
