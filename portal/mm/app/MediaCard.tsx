"use client";

// Marketing-images card (Structured face). Lists the building's REQUIRED image slots (derived from
// requiredSlots: 3 renderings + a level plan per floor + a plan per unit type) and lets the user ATTACH a
// real image per slot. Empty slots show the exact placeholder that will export (law #2 / "active backfill")
// so the user sees what's real vs injected. SOURCE-AGNOSTIC: a future Gemini "Generate" button writes the
// same MediaItem — this card already renders source:"generated" items identically to uploads.

import { useMemo, useRef, useState } from "react";
import type { PackApi } from "./usePack";
import { readKeys } from "./useKeys";
import {
  fileToMediaItem,
  itemForSlot,
  mediaCoverage,
  placeholderSvg,
  requiredSlots,
  type MediaSlot,
} from "@/lib/media";
import { bytesToB64, generateSlotImage, slotImagePrompt } from "@/lib/ai-build-images";

export function MediaCard({ api, buildingId }: { api: PackApi; buildingId: string }) {
  const slots = useMemo(
    () => requiredSlots(api.pack).filter((s) => s.buildingId === buildingId),
    [api.pack, buildingId]
  );
  const cov = useMemo(() => {
    const all = mediaCoverage(api.pack);
    const forB = slots.filter((s) => itemForSlot(api.pack, buildingId, s.key)).length;
    return { forB, total: slots.length, globalFilled: all.filled, globalTotal: all.total };
  }, [api.pack, buildingId, slots]);

  if (!slots.length) {
    return (
      <div className="mm-card">
        <h3>Marketing images</h3>
        <div className="mm-empty">
          Image slots appear once this building has floors/units (level &amp; unit-plan slots) — every empty
          slot still exports a tinted placeholder so the pack is always complete.
        </div>
      </div>
    );
  }

  const groups: Array<{ title: string; kind: MediaSlot["kind"] }> = [
    { title: "Renderings (exterior / interior / facilities)", kind: "rendering" },
    { title: "Level plans", kind: "level" },
    { title: "Unit-type plans", kind: "unit" },
  ];

  return (
    <div className="mm-card">
      <h3>
        Marketing images{" "}
        <span style={{ color: "var(--ink-dim)", fontWeight: 400, fontSize: 12 }}>
          — {cov.forB}/{cov.total} filled · empty slots export a placeholder
        </span>
      </h3>
      <p style={{ color: "var(--ink-dim)", fontSize: 12, marginTop: -6 }}>
        Upload a real image per slot, or ✨ Generate one with Gemini (add your key in ⚙ Settings). Write a
        description first for a better result. Empty slots still ship a tinted placeholder (law #2).
      </p>
      {groups.map((g) => {
        const gslots = slots.filter((s) => s.kind === g.kind);
        if (!gslots.length) return null;
        return (
          <div key={g.kind} style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-dim)", marginBottom: 6 }}>{g.title}</div>
            <div className="mm-media-grid">
              {gslots.map((s) => (
                <MediaSlotTile key={s.key} api={api} slot={s} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MediaSlotTile({ api, slot }: { api: PackApi; slot: MediaSlot }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const item = itemForSlot(api.pack, slot.buildingId, slot.key);
  // Placeholder preview via a UTF-8 data URI (encodeURIComponent) — btoa is Latin1-only and the SVG label
  // contains a "•" (U+2022). Real images are already base64 bytes, so base64 is fine for them.
  const src = item
    ? `data:${item.mime};base64,${item.dataB64}`
    : `data:image/svg+xml;utf8,${encodeURIComponent(placeholderSvg(slot))}`;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const id = `${slot.buildingId}:${slot.key}`.replace(/[^a-z0-9]+/gi, "-");
    const mi = await fileToMediaItem(file, slot.buildingId, slot.key, id);
    api.setMedia(mi);
    if (fileRef.current) fileRef.current.value = ""; // allow re-pick of the same file
  }

  const caption = api.slotCaption(slot.buildingId, slot.key);

  // ✨ Generate this slot's image with Gemini, using the user's saved key + the enriched prompt (caption + the real
  // unit data) + the building's already-uploaded images as reference (so a set shares a look). Fail-soft.
  async function onGenerate() {
    const key = readKeys().gemini;
    if (!key) {
      alert("Add your Gemini key first — open ⚙ Settings · AI keys in the left panel (there's a link to get one). Image generation uses your own key and stays on this device.");
      return;
    }
    setBusy(true);
    try {
      // reference images = this building's uploaded/generated images (condition the set's look & feel)
      const refs = (api.pack.media || [])
        .filter((m) => m.buildingId === slot.buildingId && m.source !== "placeholder" && m.slotKey !== slot.key)
        .slice(0, 2)
        .map((m) => ({ dataB64: m.dataB64, mime: m.mime }));
      const prompt = slotImagePrompt(api.pack, slot, { caption: caption || undefined });
      const img = await generateSlotImage(prompt, slot, { apiKey: key, references: refs });
      if (!img) { alert("Couldn't generate this image (check your Gemini key / quota, or try again). The slot keeps its placeholder."); return; }
      api.setMedia({
        id: `${slot.buildingId}:${slot.key}`.replace(/[^a-z0-9]+/gi, "-"),
        buildingId: slot.buildingId, slotKey: slot.key, source: "generated", mime: img.mime, dataB64: bytesToB64(img.bytes),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mm-media-tile">
      <div className="mm-media-thumb" style={{ aspectRatio: `${slot.aspectW} / ${slot.aspectH}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={slot.label} />
        {!item && <span className="mm-media-badge">placeholder</span>}
      </div>
      <div className="mm-media-meta">
        <div className="mm-media-label" title={slot.key}>{slot.label}</div>
        {/* per-slot DESCRIPTION (editable before an image exists) — the prompt the AI will later generate from. */}
        <textarea
          value={caption}
          placeholder="Describe this image (used as the AI prompt later)…"
          onChange={(e) => api.setSlotCaption(slot.buildingId, slot.key, e.target.value)}
          rows={2}
          style={{ width: "100%", resize: "vertical", fontSize: 12, color: "var(--ink)", background: "var(--bg)",
            border: "1px solid var(--line)", borderRadius: 6, padding: "5px 7px", marginBottom: 6 }}
        />
        <div className="mm-btn-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button className="mm-btn" onClick={() => fileRef.current?.click()}>
            {item ? "Replace" : "Upload"}
          </button>
          {/* Real Gemini generate: uses the user's saved key + the enriched prompt + the set's reference images. */}
          <button
            className="mm-btn"
            disabled={busy}
            title="Generate this image with Gemini from its description + the building's look (uses your saved Gemini key)"
            onClick={onGenerate}
          >
            {busy ? "✨ Generating…" : "✨ Generate"}
          </button>
          {item && (
            <button className="mm-btn mm-btn--danger" onClick={() => api.removeMedia(slot.buildingId, slot.key)}>
              ✕
            </button>
          )}
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPick} />
    </div>
  );
}
