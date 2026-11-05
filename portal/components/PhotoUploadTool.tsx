"use client";

// PhotoUploadTool — the real-user upload/crop/center tool for the photo subsystem.
//
// Two slots:
//   • portrait — the PUBLIC avatar. The user picks an image, then pans/zooms a SQUARE crop (center-weighted
//     default). We export the cropped square as a JPEG blob and POST it; the server renders the 60–80px icon.
//   • passport — the SENSITIVE ID document. No crop (the whole page matters); we just validate + upload. The
//     server flags it sensitive and the mask spine gates who can ever see it.
//
// CLIENT PRE-CHECK: reject >3MB OR >2000px longest side BEFORE sending — we never ship huge bytes.
// For the portrait, the square crop is re-encoded on the client so the upload is already small + normalised.
//
// CONSENT: an explicit, honest data-handling line is shown at the upload point (we store the image, watermark
// the visible copies, keep a tamper-evident provenance record, and — for ID docs — show them only to you or a
// counterparty you consent to). No overclaiming.

import { useCallback, useEffect, useRef, useState } from "react";
import { T } from "@/lib/theme";

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SIDE = 2000;
const EXPORT_PX = 512; // the cropped square we send (server downsizes to the 72px icon + a ≤500 display)

type Slot = "portrait" | "passport";

const btn: React.CSSProperties = {
  background: T.accent, border: "none", color: "#fff", cursor: "pointer",
  fontSize: 13.5, padding: "7px 16px", borderRadius: 8,
};
const btnGhost: React.CSSProperties = {
  background: T.panel2, border: `1px solid ${T.border}`, color: T.text, cursor: "pointer",
  fontSize: 13, padding: "6px 14px", borderRadius: 8,
};

export default function PhotoUploadTool({
  account,
  slot,
  subjectAccount,
  onUploaded,
  onCancel,
}: {
  /** The uploader (connected) account. */
  account: string;
  /** portrait (public avatar) or passport (sensitive ID doc). */
  slot: Slot;
  /** Whose image it is — defaults to the uploader (self-upload). A desk uploading on behalf passes the buyer. */
  subjectAccount?: string;
  /** Called with the new imageId + icon URL after a successful upload. */
  onUploaded?: (res: { imageId: string; iconUrl: string }) => void;
  onCancel?: () => void;
}) {
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // crop transform (portrait only): zoom + offset of the image under a fixed square viewport.
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const VIEW = 260; // on-screen crop viewport size (px)

  const reset = () => {
    setImgEl(null);
    setErr(null);
    setZoom(1);
    setOff({ x: 0, y: 0 });
  };

  const onPick = useCallback(async (file: File) => {
    setErr(null);
    if (file.size > MAX_BYTES) {
      setErr(`That image is ${(file.size / (1024 * 1024)).toFixed(1)}MB — please pick one under 3MB.`);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      if (longest > MAX_SIDE) {
        setErr(`That image is ${longest}px on its longest side — please use one ≤2000px (or let your phone downscale it).`);
        return;
      }
      setImgEl(img);
      setZoom(1);
      setOff({ x: 0, y: 0 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setErr("Could not read that image.");
    };
    img.src = url;
  }, []);

  // Draw the portrait crop preview whenever the image/zoom/offset changes.
  useEffect(() => {
    if (slot !== "portrait" || !imgEl) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.save();
    // scale so the image COVERS the square at zoom=1, then apply user zoom + pan.
    const base = VIEW / Math.min(imgEl.naturalWidth, imgEl.naturalHeight);
    const s = base * zoom;
    const dw = imgEl.naturalWidth * s;
    const dh = imgEl.naturalHeight * s;
    const dx = (VIEW - dw) / 2 + off.x;
    const dy = (VIEW - dh) / 2 + off.y;
    ctx.drawImage(imgEl, dx, dy, dw, dh);
    ctx.restore();
  }, [slot, imgEl, zoom, off]);

  // Export the cropped square (portrait) or the whole image (passport) as a JPEG blob for upload.
  const exportBlob = useCallback(async (): Promise<Blob | null> => {
    if (!imgEl) return null;
    if (slot === "passport") {
      // No crop — re-encode at native size (already ≤2000px, ≤3MB) to a JPEG so the server gets normalised bytes.
      const cv = document.createElement("canvas");
      cv.width = imgEl.naturalWidth;
      cv.height = imgEl.naturalHeight;
      cv.getContext("2d")!.drawImage(imgEl, 0, 0);
      return new Promise((res) => cv.toBlob((b) => res(b), "image/jpeg", 0.9));
    }
    // portrait: render the same crop transform at EXPORT_PX resolution.
    const cv = document.createElement("canvas");
    cv.width = EXPORT_PX;
    cv.height = EXPORT_PX;
    const ctx = cv.getContext("2d")!;
    const scale = EXPORT_PX / VIEW;
    const base = VIEW / Math.min(imgEl.naturalWidth, imgEl.naturalHeight);
    const s = base * zoom * scale;
    const dw = imgEl.naturalWidth * s;
    const dh = imgEl.naturalHeight * s;
    const dx = (EXPORT_PX - dw) / 2 + off.x * scale;
    const dy = (EXPORT_PX - dh) / 2 + off.y * scale;
    ctx.drawImage(imgEl, dx, dy, dw, dh);
    return new Promise((res) => cv.toBlob((b) => res(b), "image/jpeg", 0.9));
  }, [imgEl, slot, zoom, off]);

  const upload = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const blob = await exportBlob();
      if (!blob) throw new Error("Nothing to upload.");
      const fd = new FormData();
      fd.append("file", blob, `${slot}.jpg`);
      fd.append("uploaderAccount", account);
      fd.append("subjectAccount", subjectAccount || account);
      fd.append("slot", slot);
      const res = await fetch("/api/images", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Upload failed (${res.status}).`);
      onUploaded?.({ imageId: json.imageId, iconUrl: json.iconUrl });
      reset();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }, [exportBlob, account, subjectAccount, slot, onUploaded]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {!imgEl ? (
        <label style={{ ...btnGhost, display: "inline-block", textAlign: "center" }}>
          {slot === "portrait" ? "Choose a photo" : "Choose a passport / ID image"}
          <input
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
              e.currentTarget.value = ""; // allow re-pick of the same file
            }}
          />
        </label>
      ) : slot === "portrait" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
          <canvas
            ref={canvasRef}
            width={VIEW}
            height={VIEW}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX - off.x, y: e.clientY - off.y };
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              setOff({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
            }}
            onPointerUp={() => (drag.current = null)}
            style={{
              width: VIEW, height: VIEW, borderRadius: "50%", cursor: "grab",
              background: "#000", touchAction: "none", border: `2px solid ${T.border}`,
            }}
          />
          <div style={{ fontSize: 12, opacity: 0.7 }}>Drag to position · zoom below</div>
          <input
            type="range" min={1} max={3} step={0.01} value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            style={{ width: VIEW }}
          />
        </div>
      ) : (
        <div style={{ fontSize: 13, opacity: 0.85 }}>
          Image selected ({imgEl.naturalWidth}×{imgEl.naturalHeight}px). It will be stored securely and shown
          only to you or a counterparty you explicitly consent to.
        </div>
      )}

      {err && <div style={{ color: T.danger ?? "#ff6b6b", fontSize: 13 }}>{err}</div>}

      {/* Honest consent / data-handling copy at the upload point. */}
      <div style={{ fontSize: 11.5, opacity: 0.6, lineHeight: 1.5 }}>
        {slot === "portrait"
          ? "Your photo becomes your public avatar. Visible copies carry a “Vetted Realty” watermark, and we keep a tamper-evident record of when it was added. We strip camera/location data from the file."
          : "Your ID document is stored as sensitive data: shown only to you or a counterparty you consent to, never public. Copies served to a counterparty carry an invisible trace so a leak is attributable. We strip camera/location data and keep a tamper-evident provenance record. This is a deterrent, not a guarantee against a determined attacker."}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {imgEl && (
          <button type="button" style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={upload}>
            {busy ? "Uploading…" : slot === "portrait" ? "Save photo" : "Save ID document"}
          </button>
        )}
        {imgEl && (
          <button type="button" style={btnGhost} disabled={busy} onClick={reset}>
            Pick another
          </button>
        )}
        {onCancel && (
          <button type="button" style={btnGhost} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
