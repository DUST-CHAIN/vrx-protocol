"use client";

// MM-by-AI — the web frontend (the design docs §"it NEEDS a web frontend"). A human supplies the inputs
// the AI can't invent (the real listing copy · the real floor count · real reference images + optional key);
// the AI expands them into a complete importable building. The UI is DRESSING over the proven engine
// (mm/lib/ai-build.assembleBuildingPack) — the server route runs ONLY the DeepSeek text stage; everything else
// (assemble → validate → zip → download) happens here in the browser, so uploaded images never leave the device.
//
// Theme: native MM look — the same CSS tokens (--panel/--ink/--line/--accent) + .mm-field / .mm-btn classes
// every other MM surface uses. Reuses the fields.tsx controls.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Field, TextInput, TextArea, NumberInput } from "../fields";
import { useProject } from "../useProject";
import { useKeys } from "../useKeys";
import { specToProject } from "@/lib/project-pack";
import { assembleBuildingPack, parseSpec, buildSpecMessages, AI_BUILD_SYSTEM_PROMPT, type AiBuildingSpec } from "@/lib/ai-build";
import { askWithSystemClient } from "@/lib/ai-client";
import { generateMissingImages } from "@/lib/ai-build-images";
import { fillFromRendersetClient } from "@/lib/ai-build-renderset-client";
import { fileToMediaItem, requiredSlots } from "@/lib/media";
import { toZip } from "@/lib/export";
import { pricelistHtml } from "@/lib/pricelist";
import { brochureHtml } from "@/lib/brochure";
import { validatePack } from "@/lib/validate";
import { totalUnits, type MediaItem, type Pack } from "@/lib/pack";

type Phase = "idle" | "thinking" | "ready" | "error";

export default function AiBuildPage() {
  const store = useProject();
  const keys = useKeys();
  const [blurb, setBlurb] = useState<string>("");
  const [area, setArea] = useState<string>("");
  const [stories, setStories] = useState<number | undefined>(undefined);
  const [apiKey, setApiKey] = useState<string>(""); // optional per-request override of the saved Settings key
  const [refImages, setRefImages] = useState<File[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>("");
  const [tokens, setTokens] = useState<number>(0);
  const [pack, setPack] = useState<Pack | null>(null);

  const buildingId = pack?.buildings[0]?.id || "";
  const val = useMemo(() => (pack ? validatePack(pack) : null), [pack]);

  // The result card renders BELOW a long form, so on a successful generate it can sit off-screen — scroll it into
  // view so the user sees the outcome + the "Open in the workspace" action (fix: "no next/export" was really
  // the result being below the fold).
  const resultRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (phase === "ready" && pack) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [phase, pack]);

  async function generate() {
    setError("");
    setPhase("thinking");
    setPack(null);
    try {
      // 1. DeepSeek text stage — CLIENT-SIDE: the hosted static export has no /api route, so the browser
      //    calls DeepSeek directly with the user's OWN key (the per-request field if typed, else the Settings key).
      //    Same key posture as the Gemini image stage; parseSpec runs locally (it did server-side before).
      const key = (apiKey || keys.deepseek || "").trim();
      const res = await askWithSystemClient(AI_BUILD_SYSTEM_PROMPT, buildSpecMessages(blurb, { area: area || undefined, stories }), {
        temperature: 0.4,
        maxTokens: 2000,
        apiKey: key,
      });
      if (!res.ok) {
        setError(errorText(res.error)); // no_key -> "add a DeepSeek key"; upstream -> model fault
        setPhase("error");
        return;
      }
      const spec = parseSpec(res.answer);
      if (!spec) {
        setError(errorText("parse_failed"));
        setPhase("error");
        return;
      }
      const j = { ok: true as const, spec, tokens: res.tokens };
      setTokens(j.tokens || 0);

      // 1b. write the spec into the SHARED STORE as an EDITABLE authored building (stage 2) — so the
      //     generated building persists + opens in the grid editor (no more one-shot sessionStorage handoff).
      store.setProject(specToProject(j.spec, store.project));

      // 2. assemble the spec into a complete Pack (client-side — the proven MM engine) for THIS page's immediate
      //    download/preview/pricelist actions (the store holds the editable truth; the Pack is the export view).
      const { pack: p } = assembleBuildingPack(j.spec);
      const bId = p.buildings[0]?.id || "";

      // 3. attach the uploaded REFERENCE IMAGES as source:"upload" MediaItems, into the first matching empty
      //    rendering slots (so they ride along in the ZIP + show in the brochure). Best-effort.
      if (refImages.length && bId) {
        const slots = requiredSlots(p).filter((s) => s.buildingId === bId && s.kind === "rendering");
        const items: MediaItem[] = [];
        for (let i = 0; i < refImages.length && i < slots.length; i++) {
          items.push(await fileToMediaItem(refImages[i], bId, slots[i].key, `upload-${i}`));
        }
        if (items.length) p.media = [...(p.media || []), ...items];
      }

      // 4. DEFAULT images from the bundled render-set (real, consistent) for any slot the uploads didn't fill.
      const setItems = await fillFromRendersetClient(p);
      if (setItems.length) p.media = [...(p.media || []), ...setItems];

      // 5. generated images (real Gemini when a key is saved) for anything still empty; the uploaded references
      //    condition the set's look & feel; placeholder-backfill at export covers whatever stays empty (law #2).
      const refs = (p.media || [])
        .filter((m) => m.buildingId === bId && m.source === "upload")
        .slice(0, 2)
        .map((m) => ({ dataB64: m.dataB64, mime: m.mime }));
      const img = await generateMissingImages(p, { apiKey: keys.gemini || undefined, references: refs });
      if (img.items.length) p.media = [...(p.media || []), ...img.items];

      setPack(p);
      setPhase("ready");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setPhase("error");
    }
  }

  async function downloadZip() {
    if (!pack) return;
    const blob = await toZip(pack, "vrx-mm-by-ai 0.1.0");
    saveBlob(blob, `${pack.developer.id || "pack"}-ingest-pack.zip`);
  }

  function openDoc(kind: "pricelist" | "brochure") {
    if (!pack || !buildingId) return;
    const html = kind === "pricelist" ? pricelistHtml(pack, buildingId) : brochureHtml(pack, buildingId);
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
  }

  function openInMm() {
    // The generated building is ALREADY in the shared store (written at generate time), so opening the workspace is
    // just a navigation — no handoff needed (stage 2). go to the ONE workspace `/` (not the retired
    // grid screen), and mark the project "started" so the home start-screen gate lets us straight into the app.
    try { localStorage.setItem("mm.started", "1"); } catch {}
    window.location.href = "/";
  }

  const busy = phase === "thinking";
  const canGenerate = blurb.trim().length > 20 && !busy;

  return (
    <div style={wrap}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "32px 24px" }}>
        {/* the generator is a SEPARATE part reached from the workspace — give it a clear way back (the top
            route-nav was removed; the face switch is the only nav now, and it lives in the workspace). */}
        <Link href="/" style={{ color: "var(--ink-dim)", fontSize: 13, textDecoration: "none" }} title="Back to the workspace">
          ← Workspace
        </Link>
        <div className="mm-brand" style={{ margin: "6px 0" }}>
          <span className="mm-brand__dot" /> MM · by AI
        </div>
        <h1 style={{ fontSize: 24, margin: "4px 0 6px" }}>Author a building from a brief</h1>
        <p style={{ color: "var(--ink-dim)", fontSize: 14, margin: "0 0 22px", lineHeight: 1.55 }}>
          Paste a listing/marketing blurb, set the floor count, optionally drop reference images — the AI expands
          it into a complete, importable VRX pack (units, floors, geometry, pricelist &amp; brochure). The output
          is the same ZIP a developer imports.
        </p>

        <section style={card}>
          <Field label="Listing / marketing text" hint="paste the building's copy — the more real detail, the better" full>
            <TextArea value={blurb} onChange={setBlurb} placeholder="e.g. Riverside North is a 25-storey waterfront residence in northpoint offering studios to 2-bedroom units from $55,000…" />
          </Field>
          <div style={row2}>
            <Field label="Number of floors" hint="the one fact the AI shouldn't guess">
              <NumberInput value={stories} onChange={setStories} placeholder="25" step={1} />
            </Field>
            <Field label="Area / district" hint="optional, public info">
              <TextInput value={area} onChange={setArea} placeholder="northpoint" />
            </Field>
          </div>

          <Field label="Reference images" hint="optional — ride along as the building renderings (stay on your device until you download)">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => setRefImages(Array.from(e.target.files || []))}
            />
            {refImages.length > 0 && (
              <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 4 }}>{refImages.length} image(s) selected</div>
            )}
          </Field>

          <Field label="DeepSeek API key" hint={keys.deepseek ? "using your saved key from ⚙ Settings — type here to override just this run" : "paste a key, or save one once in ⚙ Settings · AI keys (left panel). Used for this request only, never stored on a server."}>
            <TextInput value={apiKey} onChange={setApiKey} placeholder={keys.deepseek ? "(saved key in Settings — leave blank)" : "sk-…"} mono />
            {!keys.deepseek && !apiKey && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>Get a DeepSeek key ↗</a>
              </div>
            )}
          </Field>

          <div className="mm-btn-row" style={{ marginTop: 14 }}>
            <button className="mm-btn mm-btn--primary" onClick={generate} disabled={!canGenerate}>
              {busy ? "Generating…" : "✦ Generate building"}
            </button>
          </div>
          {phase === "error" && <div style={errBox}>{error}</div>}
        </section>

        {phase === "ready" && pack && (
          <section ref={resultRef} style={{ ...card, marginTop: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ fontSize: 18, margin: 0 }}>{pack.buildings[0]?.name || "Building"}</h2>
              <span style={{ fontSize: 12, color: "var(--ink-dim)" }}>{tokens.toLocaleString()} tokens</span>
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-dim)", margin: "4px 0 12px" }}>
              {pack.complexes[0]?.name}{pack.buildings[0]?.area ? ` · ${pack.buildings[0]?.area}` : ""} · {pack.buildings[0]?.stories} floors · {totalUnits(pack)} units
              {val && <> · {val.counts.errors === 0 ? "✓ valid pack" : `${val.counts.errors} error(s)`}{val.counts.warnings ? ` · ${val.counts.warnings} warning(s)` : ""}</>}
            </div>
            {/* the PRIMARY action is to open the generated building in the one workspace and refine it there
                (structure-first; the AI drafted it, you finish it). The ZIP/docs are secondary exports. */}
            <div className="mm-btn-row" style={{ flexWrap: "wrap", gap: 8 }}>
              <button className="mm-btn mm-btn--primary" onClick={openInMm}>→ Open in the workspace</button>
              <button className="mm-btn" onClick={downloadZip}>⭳ Download ZIP</button>
              <button className="mm-btn" onClick={() => openDoc("pricelist")}>Pricelist</button>
              <button className="mm-btn" onClick={() => openDoc("brochure")}>Brochure</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 10 }}>
              The AI drafted this building — open the workspace to review and adjust the units, prices and layout.
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function errorText(code?: string): string {
  switch (code) {
    case "no_key": return "No DeepSeek key set. Paste your API key above, or save one in Settings — it stays on your device.";
    case "no_blurb": return "Please paste some listing text first.";
    case "parse_failed": return "The AI reply couldn't be parsed into a building spec — try again or add more detail.";
    case "upstream": return "The AI service is unavailable right now — please try again.";
    default: return "Generation failed — please try again.";
  }
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ── inline styles using MM's CSS tokens so the page is native to the app ──
const wrap: React.CSSProperties = { background: "var(--bg)", color: "var(--ink)", minHeight: "100vh" };
const card: React.CSSProperties = { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10, padding: 18 };
const row2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };
const errBox: React.CSSProperties = { marginTop: 12, padding: "9px 12px", borderRadius: 6, background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)", color: "var(--ink)", fontSize: 13 };
