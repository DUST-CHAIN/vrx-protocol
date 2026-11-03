"use client";

// /admin/images — IMAGE REVIEW. A visual grid of every floorplan + rendering image on the
// server, grouped building → category. Spot a "not good" one → Download it, edit it in your own tool, then
// Replace (upload back to the exact same path) → the live file is overwritten in place. Read + surgical write.
// Sandbox-only (the API routes 403 on a non-demo prod build).

import { useCallback, useEffect, useRef, useState } from "react";
import { T } from "@/lib/theme";
import { readOperatorSecret } from "@/lib/operator-secret";

type QualityFlag = "tiny-file" | "low-res" | "odd-aspect" | "placeholder";
type Quality = { w?: number; h?: number; flags: QualityFlag[] };
type ImgNode = { name: string; url: string; relPath: string; sizeKb: number };
type CatNode = { category: string; images: ImgNode[] };
type BuildingNode = { building: string; categories: CatNode[] };
type RootNode = { root: string; buildings: BuildingNode[] };
type MissingNode = { building: string; type: string; subtype: string; expectedKey: string; uploadRelPath: string };

export default function ImageReviewPage() {
  const [roots, setRoots] = useState<RootNode[] | null>(null);
  const [missing, setMissing] = useState<MissingNode[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [rootFilter, setRootFilter] = useState<"all" | "floorplans" | "renderings">("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [quality, setQuality] = useState<Record<string, Quality>>({});
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [bump, setBump] = useState(0); // cache-bust replaced thumbnails
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<ImgNode | null>(null); // click a thumbnail → smooth lightbox (not a new tab)

  const load = useCallback(async () => {
    setErr(null);
    try {
      const j = await fetch("/api/admin/images").then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "load failed");
      setRoots(j.roots);
      setTotal(j.total);
      setMissing(j.missing ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function replace(relPath: string, file: File, allowCreate = false) {
    setBusyPath(relPath);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("relPath", relPath);
      fd.set("file", file);
      if (allowCreate) fd.set("allowCreate", "true");
      const op = readOperatorSecret(); // empty on the demo box → server 403s the write (view-only for demo users)
      const j = await fetch("/api/admin/images/replace", { method: "POST", body: fd, headers: op ? { "x-vrx-operator": op } : {} }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "replace failed");
      setMsg(`${allowCreate ? "Uploaded" : "Replaced"} ${relPath} (${j.sizeKb} KB)`);
      setBump((b) => b + 1); // force thumbnails to re-fetch
      if (allowCreate) await load(); // a new file moves it out of "missing" into the grid
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : "replace failed"}`);
    } finally {
      setBusyPath(null);
    }
  }

  const scanQuality = useCallback(async () => {
    setScanning(true);
    setMsg(null);
    try {
      const j = await fetch("/api/admin/images/scan").then((r) => r.json());
      if (!j.ok) throw new Error(j.error || "scan failed");
      setQuality(j.quality ?? {});
      setScanned(true);
      setMsg(`Quality scan done — ${j.flaggedCount} flagged`);
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : "scan failed"}`);
    } finally {
      setScanning(false);
    }
  }, []);

  const flagsFor = (relPath: string): QualityFlag[] => quality[relPath]?.flags ?? [];
  const q = filter.trim().toLowerCase();
  const flaggedCount = (roots ?? []).reduce(
    (n, r) => n + r.buildings.reduce((m, b) => m + b.categories.reduce((k, c) => k + c.images.filter((im) => flagsFor(im.relPath).length > 0).length, 0), 0),
    0
  );
  const shown = (roots ?? [])
    .filter((r) => rootFilter === "all" || r.root === rootFilter)
    .map((r) => ({
      ...r,
      buildings: r.buildings
        .map((b) => ({
          ...b,
          categories: b.categories
            .map((c) => ({
              ...c,
              images: c.images.filter(
                (im) => (!q || im.relPath.toLowerCase().includes(q)) && (!flaggedOnly || flagsFor(im.relPath).length > 0)
              ),
            }))
            .filter((c) => c.images.length > 0),
        }))
        .filter((b) => b.categories.length > 0),
    }))
    .filter((r) => r.buildings.length > 0);

  return (
    <main style={{ background: T.bg, color: T.text, minHeight: "100vh", padding: "24px 28px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Image review</h1>
        <p style={{ color: T.dim, fontSize: 13.5, margin: "0 0 16px" }}>
          Every floorplan + rendering image on the server. Spot a bad one → <strong>Download</strong>, edit it,
          then <strong>Replace</strong> (upload back) to overwrite it in place. {total} images.
        </p>

        {/* controls */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by path (e.g. palmgate, 1BR, levels)…"
            style={{ flex: "1 1 280px", minWidth: 220, padding: "8px 12px", background: T.bg2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13.5 }}
          />
          {(["all", "floorplans", "renderings"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRootFilter(r)}
              style={{
                padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                border: `1px solid ${rootFilter === r ? T.accent : T.border}`,
                background: rootFilter === r ? T.accentSoft : T.bg2, color: T.text,
              }}
            >
              {r}
            </button>
          ))}
          <button
            onClick={() => scanQuality()}
            disabled={scanning}
            style={{ padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: scanning ? "default" : "pointer", border: `1px solid ${T.accent}`, background: scanned ? T.bg2 : T.accentSoft, color: T.text }}
          >
            {scanning ? "Scanning…" : scanned ? "Re-scan quality" : "Scan quality"}
          </button>
          {scanned && (
            <button
              onClick={() => setFlaggedOnly((v) => !v)}
              style={{
                padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                border: `1px solid ${flaggedOnly ? T.hold : T.border}`,
                background: flaggedOnly ? "#2a1e10" : T.bg2, color: flaggedOnly ? T.hold : T.text,
              }}
            >
              ⚠ Flagged only{flaggedCount ? ` (${flaggedCount})` : ""}
            </button>
          )}
          <button onClick={() => load()} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer", border: `1px solid ${T.border}`, background: T.bg2, color: T.text }}>
            Refresh
          </button>
        </div>

        {err && <div style={{ color: T.danger, marginBottom: 16 }}>Error: {err}</div>}
        {msg && (
          <div style={{ position: "sticky", top: 8, zIndex: 5, background: msg.startsWith("Error") ? "#3a1620" : "#132a20", color: msg.startsWith("Error") ? T.danger : T.vetted, border: `1px solid ${msg.startsWith("Error") ? T.danger : T.vetted}`, padding: "8px 14px", borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
            {msg}
          </div>
        )}
        {!roots && !err && <div style={{ color: T.dim }}>Loading…</div>}

        {/* MISSING subtype plans — mandatory gaps to fill (upload slots) */}
        {missing.length > 0 && (
          <section style={{ marginBottom: 28, background: "#2a1e10", border: `1px solid ${T.hold}`, borderRadius: 10, padding: "14px 16px" }}>
            <h2 style={{ fontSize: 15.5, fontWeight: 700, color: T.hold, margin: "0 0 4px" }}>
              ⚠ Missing unit-plan images ({missing.length})
            </h2>
            <p style={{ color: T.dim, fontSize: 12.5, margin: "0 0 12px" }}>
              These {`{type, subtype}`} combinations exist in a building&apos;s inventory but have NO floor-plan image — a buyer sees no plan.
              Upload one to fill the slot (creates the file at the expected path).
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
              {missing.map((m) => (
                <MissingSlot key={m.uploadRelPath} m={m} busy={busyPath === m.uploadRelPath} onUpload={(f) => replace(m.uploadRelPath, f, true)} />
              ))}
            </div>
          </section>
        )}

        {shown.map((r) => (
          <section key={r.root} style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: T.accent, margin: "0 0 10px", textTransform: "capitalize" }}>{r.root}</h2>
            {r.buildings.map((b) => (
              <div key={b.building} style={{ marginBottom: 18 }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 600, margin: "0 0 8px" }}>{b.building}</h3>
                {b.categories.map((c) => {
                  // Inline missing-plan slots belong in the floorplans "units" category of this building.
                  const inlineMissing = r.root === "floorplans" && c.category === "units" ? missing.filter((m) => m.building === b.building) : [];
                  return (
                    <div key={c.category} style={{ marginBottom: 12 }}>
                      <div style={{ color: T.faint, fontSize: 12, margin: "0 0 6px", fontFamily: T.mono }}>
                        {c.category}
                        {inlineMissing.length > 0 && <span style={{ color: T.hold, marginLeft: 8 }}>· {inlineMissing.length} missing</span>}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
                        {c.images.map((im) => (
                          <ImageCard key={im.relPath} im={im} q={quality[im.relPath]} bump={bump} busy={busyPath === im.relPath} onReplace={(f) => replace(im.relPath, f)} onOpen={() => setLightbox(im)} />
                        ))}
                        {inlineMissing.map((m) => (
                          <MissingSlot key={m.uploadRelPath} m={m} busy={busyPath === m.uploadRelPath} onUpload={(f) => replace(m.uploadRelPath, f, true)} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        ))}
        {roots && shown.length === 0 && <div style={{ color: T.dim }}>No images match the filter.</div>}
      </div>

      {lightbox && <Lightbox im={lightbox} bump={bump} onClose={() => setLightbox(null)} />}
    </main>
  );
}

function Lightbox({ im, bump, onClose }: { im: ImgNode; bump: number; onClose: () => void }) {
  // smooth overlay preview — close on backdrop click or Esc; jump straight to the tracer from here.
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(5,8,14,0.86)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24, animation: "vrxfade 140ms ease-out", backdropFilter: "blur(2px)" }}
    >
      <style>{`@keyframes vrxfade{from{opacity:0}to{opacity:1}}`}</style>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${im.url}?v=${bump}`}
        alt={im.name}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "92vw", maxHeight: "78vh", objectFit: "contain", borderRadius: 8, boxShadow: "0 10px 50px rgba(0,0,0,0.6)", background: "#fff" }}
      />
      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        <span style={{ color: T.dim, fontSize: 12.5, fontFamily: T.mono }}>{im.relPath} · {im.sizeKb} KB</span>
        <a href={`/admin/images/tracer?img=${encodeURIComponent(im.url)}`} style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600, borderRadius: 8, border: `1px solid ${T.accent}`, background: T.accentSoft, color: "#fff", textDecoration: "none" }}>
          ✏ Trace this plan
        </a>
        <a href={im.url} download style={{ padding: "8px 16px", fontSize: 13, borderRadius: 8, border: `1px solid ${T.border}`, background: T.bg2, color: T.text, textDecoration: "none" }}>
          ⬇ Download
        </a>
        <a href={im.url} target="_blank" rel="noreferrer" style={{ padding: "8px 16px", fontSize: 13, borderRadius: 8, border: `1px solid ${T.border}`, background: T.bg2, color: T.text, textDecoration: "none" }}>
          ⤢ Full size
        </a>
        <button onClick={onClose} style={{ padding: "8px 16px", fontSize: 13, borderRadius: 8, border: `1px solid ${T.border}`, background: T.bg2, color: T.text, cursor: "pointer" }}>
          Close (Esc)
        </button>
      </div>
    </div>
  );
}

function MissingSlot({ m, busy, onUpload }: { m: MissingNode; busy: boolean; onUpload: (f: File) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div style={{ background: T.panel, border: `1px dashed ${T.hold}`, borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        style={{ background: T.bg2, aspectRatio: "4 / 3", display: "flex", alignItems: "center", justifyContent: "center", border: "none", color: T.hold, cursor: busy ? "default" : "pointer", fontSize: 13, textAlign: "center", padding: 10 }}
      >
        {busy ? "Uploading…" : "＋ Upload missing plan"}
      </button>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{m.expectedKey}</div>
        <div style={{ fontSize: 11, color: T.faint, fontFamily: T.mono, overflowWrap: "anywhere" }}>
          {m.building} · {m.type}/{m.subtype} → {m.uploadRelPath}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function ImageCard({ im, q, bump, busy, onReplace, onOpen }: { im: ImgNode; q?: Quality; bump: number; busy: boolean; onReplace: (f: File) => void; onOpen: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const flags = q?.flags ?? [];
  const flagged = flags.length > 0;
  return (
    <div style={{ background: T.panel, border: `1px solid ${flagged ? T.hold : T.border}`, borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <button onClick={onOpen} title="Click to preview" style={{ display: "block", background: T.bg2, aspectRatio: "4 / 3", overflow: "hidden", border: "none", padding: 0, cursor: "zoom-in", width: "100%" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${im.url}?v=${bump}`} alt={im.name} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} loading="lazy" />
      </button>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, overflowWrap: "anywhere" }}>{im.name}</div>
        <div style={{ fontSize: 11, color: T.faint, fontFamily: T.mono, overflowWrap: "anywhere" }}>
          {im.relPath} · {im.sizeKb} KB{q?.w && q?.h ? ` · ${q.w}×${q.h}` : ""}
        </div>
        {flags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {flags.map((f) => (
              <span key={f} style={{ fontSize: 10.5, fontWeight: 600, color: T.hold, background: "#2a1e10", border: `1px solid ${T.hold}`, borderRadius: 5, padding: "1px 6px" }}>
                {f}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
          <a href={im.url} download style={{ flex: 1, textAlign: "center", padding: "6px 8px", fontSize: 12, borderRadius: 7, border: `1px solid ${T.border}`, background: T.bg2, color: T.text, textDecoration: "none" }}>
            Download
          </a>
          <a href={`/admin/images/tracer?img=${encodeURIComponent(im.url)}`} title="Trace this plan into editable SVG" style={{ flex: 1, textAlign: "center", padding: "6px 8px", fontSize: 12, borderRadius: 7, border: `1px solid ${T.border}`, background: T.bg2, color: T.text, textDecoration: "none" }}>
            Trace
          </a>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            style={{ flex: 1, padding: "6px 8px", fontSize: 12, borderRadius: 7, cursor: busy ? "default" : "pointer", border: `1px solid ${T.accent}`, background: busy ? T.bg2 : T.accentSoft, color: T.text }}
          >
            {busy ? "Uploading…" : "Replace"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onReplace(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}
