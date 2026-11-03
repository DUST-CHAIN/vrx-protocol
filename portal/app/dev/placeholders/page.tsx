"use client";

// Dev preview — renders every ImagePlaceholder kind at card size so we can eyeball the SVG stand-ins.
// Not linked anywhere; just /dev/placeholders for a visual check. Safe to delete after the design is locked.

import ImagePlaceholder, { type PlaceholderKind } from "@/components/ImagePlaceholder";
import Carousel from "@/components/Carousel";

const KINDS: PlaceholderKind[] = ["exterior", "interior", "facility", "level", "unit"];
const IDS = ["dev-tower", "miracle-tower", "garden-court"];

export default function PlaceholdersPreview() {
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 16px", color: "#e8ecf4" }}>
      <h1 style={{ fontSize: 22 }}>Image placeholder set (S367)</h1>
      <p style={{ opacity: 0.6, fontSize: 14 }}>
        Deterministic per building id + kind. Each is the stand-in shown when a real photo/render is missing.
      </p>
      {IDS.map((id) => (
        <section key={id} style={{ marginTop: 24 }}>
          <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 8 }}>id: {id}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {KINDS.map((kind) => (
              <div key={kind} style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #232d40" }}>
                <div style={{ aspectRatio: "16 / 9" }}>
                  <ImagePlaceholder id={id} kind={kind} />
                </div>
                <div style={{ fontSize: 12, padding: "6px 8px", opacity: 0.7 }}>{kind}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
      <section style={{ marginTop: 32 }}>
        <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 8 }}>Empty Carousel → placeholder (the "wire once" fix)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          <div><Carousel images={[]} aspectRatio="3 / 2" placeholderKind="exterior" placeholderId="demo-tower" /></div>
          <div><Carousel images={[]} aspectRatio="3 / 2" placeholderKind="interior" placeholderId="demo-tower" /></div>
          <div><Carousel images={[]} aspectRatio="3 / 2" placeholderKind="unit" placeholderId="demo-tower" /></div>
        </div>
      </section>
    </main>
  );
}
