// IMAGE QUALITY ANALYSIS — SERVER-ONLY. Cheap heuristics over image dimensions + pixel stats to surface
// likely-"not good" images (low-res, odd aspect, tiny file, flat/placeholder) in the admin review. HINTS, not a
// verdict — the operator eyeballs the thumbnail. Uses the same LAZY-sharp posture as lib/images.ts (a native
// binary that may be absent on some hosts → degrade to no flags, never crash). Results are CACHED by file
// mtime+size so a re-scan is instant unless a file actually changed (the scan over hundreds of images is slow).

import { promises as fs } from "fs";

export type QualityFlag = "tiny-file" | "low-res" | "odd-aspect" | "placeholder";
export type Quality = { w?: number; h?: number; flags: QualityFlag[] };

type SharpFn = (input: string) => {
  metadata(): Promise<{ width?: number; height?: number }>;
  stats(): Promise<{ channels: { stdev: number }[] }>;
};
let sharpMod: SharpFn | null | undefined;
async function getSharp(): Promise<SharpFn | null> {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = ((await import("sharp")).default as unknown) as SharpFn;
  } catch {
    sharpMod = null;
  }
  return sharpMod;
}

// mtime+size keyed cache so a re-scan only pays sharp cost for changed files.
const cache = new Map<string, { sig: string; q: Quality }>();

/** Analyse ONE image at `abs`. Cached by (mtimeMs|size); recomputed only when the file changes. */
export async function analyzeImage(abs: string): Promise<Quality> {
  let sig = "";
  let sizeKb = 0;
  try {
    const st = await fs.stat(abs);
    sig = `${st.mtimeMs}|${st.size}`;
    sizeKb = Math.round(st.size / 1024);
  } catch {
    return { flags: [] };
  }
  const hit = cache.get(abs);
  if (hit && hit.sig === sig) return hit.q;

  const flags: QualityFlag[] = [];
  if (sizeKb <= 6) flags.push("tiny-file");
  const sharp = await getSharp();
  let q: Quality = { flags };
  if (sharp) {
    try {
      const img = sharp(abs);
      const meta = await img.metadata();
      const w = meta.width, h = meta.height;
      if (w && h) {
        if (Math.min(w, h) < 400) flags.push("low-res");
        const ar = w / h;
        if (ar < 0.33 || ar > 3) flags.push("odd-aspect");
        try {
          const stats = await img.stats();
          const avgStdev = stats.channels.reduce((s, c) => s + c.stdev, 0) / stats.channels.length;
          if (avgStdev < 6) flags.push("placeholder");
        } catch {
          /* stats unsupported on some formats */
        }
      }
      q = { w, h, flags };
    } catch {
      q = { flags };
    }
  }
  cache.set(abs, { sig, q });
  return q;
}
