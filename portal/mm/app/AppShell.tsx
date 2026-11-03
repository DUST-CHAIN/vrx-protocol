"use client";

// THE one-frame MM app (simplification pass, D-). ONE frame + the three FACES (Structured · Studio ·
// Preview) — this IS the app per the design docs §2. Before this shell lived only at /structured
// (mis-named as a route "Structured" that collided with the in-frame "Structured" face) while four other routes
// competed with it. Now it is the home app; the old screens are reached as the two FRONT DOORS (see StartScreen).
//
// Extracted here (from the old /structured page) so `/` and `/structured` render the SAME shell — one source, no
// drift. The deep FOLD of the grid-paint / one-line-AI / drag-board internals INTO the Studio face as modes is a
// DEFERRED later slice; this slice lands the one-app skeleton + the single face-switch nav.

import { Frame } from "./Frame";
import { Editor } from "./Editor";
import { Rail } from "./Rail";
import { Studio } from "./Studio";
import { Preview } from "./Preview";
import { Splitter } from "./Splitter";
import { usePackStore } from "./usePackStore";
import { useChrome } from "./useChrome";
import { useGeo } from "./useGeo";
import { useProject } from "./useProject";

export function AppShell() {
  // Gate on store.hydrated so the first paint reflects the restored tree, not the fresh default (the store
  // hydrates from localStorage in an effect, async after first render).
  const store = useProject();
  if (!store.hydrated) return <div className="mm-empty" style={{ padding: 60 }}>Loading…</div>;
  return <ShellInner />;
}

function ShellInner() {
  const api = usePackStore();
  const chrome = useChrome();
  // Lifted to this level so BOTH Frame (geo tree in the Studio pane) and Studio (canvas) share one geo state.
  const geo = useGeo(api);

  // The right RAIL splitter sits between the canvas/editor and the inspector pane; it resizes --rail-w.
  // Only faces WITH a right pane render it (studio + structured); preview spans the full width instead.
  const railSplitter = (
    <Splitter onResize={chrome.setRailW} side="right" cssVar="--rail-w" fallback={320} />
  );

  return (
    <div className="mm-shell">
      <Frame api={api} chrome={chrome} geo={geo} />
      <Splitter onResize={chrome.setFrameW} />
      {chrome.face === "studio" ? (
        <Studio api={api} geo={geo} railSplitter={railSplitter} />
      ) : chrome.face === "preview" ? (
        <main className="mm-main mm-main--preview">
          <Preview api={api} />
        </main>
      ) : (
        <>
          <main className="mm-main">
            <Editor api={api} />
          </main>
          {railSplitter}
          <Rail api={api} />
        </>
      )}
    </div>
  );
}
