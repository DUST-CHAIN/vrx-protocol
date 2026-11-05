"use client";

// MM Structured face — the whole app shell: FRAME (left) · splitter · Editor (center) · Rail (right).
// Slice 1 of the three faces (MM_ENGINE_AND_FACES §3). Studio + Preview are later slices (disabled in Frame).

import { Frame } from "./Frame";
import { Editor } from "./Editor";
import { Rail } from "./Rail";
import { Studio } from "./Studio";
import { Preview } from "./Preview";
import { Splitter } from "./Splitter";
import { usePack } from "./usePack";
import { useChrome } from "./useChrome";
import { useGeo } from "./useGeo";

export default function Page() {
  const api = usePack("seed");
  const chrome = useChrome();
  // Lifted to page-level so BOTH Frame (geo tree in Studio pane) and Studio (canvas) share one geo state.
  const geo = useGeo(api);

  return (
    <div className="mm-shell">
      <Frame api={api} chrome={chrome} geo={geo} />
      <Splitter onResize={chrome.setFrameW} />
      {chrome.face === "studio" ? (
        <Studio api={api} geo={geo} />
      ) : chrome.face === "preview" ? (
        <main className="mm-main mm-main--preview">
          <Preview api={api} />
        </main>
      ) : (
        <>
          <main className="mm-main">
            <Editor api={api} />
          </main>
          <Rail api={api} />
        </>
      )}
    </div>
  );
}
