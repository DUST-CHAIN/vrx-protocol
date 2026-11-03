"use client";

// VRX-ROOT developer-pack INGEST panel (MM → catalog, step 3; design: the design docs
// + ingest-pack/README.md §"How VRX imports it"). The operator's place to UPLOAD a developer's pack ZIP,
// PREVIEW the parsed tree + any reader errors, VET + REMAP each building's catalog id, and ACTIVATE buildings
// into the live catalog SELECTIVELY. Nothing goes live until the operator clicks "Activate" on a building.
//
// Reads/writes /api/root/ingest (operator-gated, fail-closed — same x-vrx-operator posture as the sibling
// root panels). The ZIP is base64'd in the browser and POSTed; the server parses + stages it (the pure
// lib/ingest-pack.ts reader) and merges on activate. FINDING-1 (S294b): a pack may carry a generic building
// id (e.g. "building"); the per-building id field lets the operator remap it to the real slug (e.g.
// "skyline-tower") so activation SUPERSEDES the seed instead of appending a stray building — the console
// flags "will REPLACE <id>" vs "new building" live from the catalog's current ids.
//
// PRIVACY: a pack is PUBLIC developer/building context — names, specs, images. No customer PII, no
// plaintext deal terms (the trace-over backdrop + metre drawing-board state are stripped at MM export).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T } from "@/lib/theme";
import { card } from "@/lib/ui";

// ── response shapes (mirror the server's StagedPack + /api/root/ingest GET) ──────────────────────────
type StagedBuilding = {
  packId: string;
  targetId: string;
  name: string;
  units: number;
  state: "pending" | "active" | "discarded";
};
type StagedPack = {
  id: string;
  stagedAt: number;
  developer: { id: string; name: string; holdingCompany?: string };
  complexes: { id: string; name: string; buildings: string[] }[];
  buildings: StagedBuilding[];
  errors: { where: string; message: string }[];
};

const btn: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  background: T.panel2,
  color: T.text,
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 12px",
  borderRadius: 6,
};
const activateBtn: React.CSSProperties = { ...btn, background: "#1f6f3f", borderColor: "#2a8f52", color: "#eafff1" };
const dangerBtn: React.CSSProperties = { ...btn, borderColor: T.danger, color: T.danger };
const idInput: React.CSSProperties = {
  background: T.bg2,
  border: `1px solid ${T.border}`,
  color: T.text,
  fontSize: 12,
  padding: "3px 8px",
  borderRadius: 6,
  width: 160,
  fontFamily: "monospace",
};

async function fileToB64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // chunked to avoid a call-stack blow-up on big packs (Skyline carries ~38 image slots).
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}

export default function IngestPanel({ headers }: { headers: Record<string, string> | undefined }) {
  const [packs, setPacks] = useState<StagedPack[]>([]);
  const [liveIds, setLiveIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // a per-action lock message
  const [error, setError] = useState<string | null>(null);
  // local edits to a building's target id before committing (keyed `${packId}:${buildingPackId}`).
  const [idEdits, setIdEdits] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const liveSet = useMemo(() => new Set(liveIds), [liveIds]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/root/ingest", { headers });
      if (r.ok) {
        const j = await r.json();
        setPacks((j.packs as StagedPack[]) ?? []);
        setLiveIds((j.liveIds as string[]) ?? []);
      }
    } catch {
      /* operator can retry */
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>, lockMsg: string): Promise<Record<string, unknown> | null> => {
      setBusy(lockMsg);
      setError(null);
      try {
        const r = await fetch("/api/root/ingest", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError((j as { error?: string }).error ?? `request failed (${r.status})`);
          return null;
        }
        return j as Record<string, unknown>;
      } catch (e) {
        setError(e instanceof Error ? e.message : "request failed");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [headers],
  );

  const onUpload = useCallback(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    setBusy("Parsing pack…");
    try {
      const zipB64 = await fileToB64(file);
      const res = await post({ op: "stage", zipB64 }, "Staging pack…");
      if (res) {
        if (fileRef.current) fileRef.current.value = "";
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not read file");
    } finally {
      setBusy(null);
    }
  }, [post, load]);

  const onRemap = useCallback(
    async (packId: string, buildingPackId: string, asId: string) => {
      const res = await post({ op: "remap", packId, buildingPackId, asId }, "Remapping…");
      if (res) await load();
    },
    [post, load],
  );

  const onActivate = useCallback(
    async (packId: string, buildingPackId: string, asId: string) => {
      const res = await post({ op: "activate", packId, buildingPackId, asId: asId || undefined }, "Activating…");
      if (res) await load();
    },
    [post, load],
  );

  const onDiscard = useCallback(
    async (packId: string) => {
      const res = await post({ op: "discard", packId }, "Discarding…");
      if (res) await load();
    },
    [post, load],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Developer pack ingest</h2>
        <button style={btn} onClick={() => void load()} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      <p style={{ margin: 0, color: T.dim, fontSize: 13, lineHeight: 1.5 }}>
        Upload a developer’s <strong>pack ZIP</strong> (exported from Model Maker). VRX parses it and holds it{" "}
        <strong>staged</strong> — nothing reaches the live catalog until you <strong>activate</strong> a building.
        Confirm each building’s catalog id first: a matching id <strong>replaces</strong> the existing building; a new
        id is added.
      </p>

      {/* Upload */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <input ref={fileRef} type="file" accept=".zip" style={{ fontSize: 13, color: T.text }} />
        <button style={activateBtn} onClick={() => void onUpload()} disabled={!!busy}>
          {busy ?? "Stage pack"}
        </button>
      </div>

      {error && (
        <div style={{ ...card, borderColor: T.danger, color: T.danger, fontSize: 13 }}>⚠ {error}</div>
      )}

      {/* Staged packs */}
      {packs.length === 0 ? (
        <div style={{ color: T.dim, fontSize: 13 }}>No staged packs. Upload one above to begin.</div>
      ) : (
        packs.map((p) => (
          <div key={p.id} style={{ ...card }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{p.developer.name}</span>{" "}
                <span style={{ color: T.dim, fontSize: 12 }}>
                  · {p.developer.id} · {p.complexes.length} complex{p.complexes.length === 1 ? "" : "es"} ·{" "}
                  {p.buildings.length} building{p.buildings.length === 1 ? "" : "s"}
                </span>
              </div>
              <button style={dangerBtn} onClick={() => void onDiscard(p.id)} disabled={!!busy}>
                Discard pack
              </button>
            </div>

            {p.errors.length > 0 && (
              <div style={{ marginTop: 8, color: T.danger, fontSize: 12 }}>
                {p.errors.length} reader note{p.errors.length === 1 ? "" : "s"}:{" "}
                {p.errors.slice(0, 4).map((e) => `${e.where}: ${e.message}`).join(" · ")}
                {p.errors.length > 4 ? " · …" : ""}
              </div>
            )}

            {/* Buildings */}
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {p.buildings.map((b) => {
                const key = `${p.id}:${b.packId}`;
                const draftId = idEdits[key] ?? b.targetId;
                const willReplace = liveSet.has(draftId);
                const active = b.state === "active";
                return (
                  <div
                    key={b.packId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: T.bg2,
                      border: `1px solid ${T.border}`,
                      opacity: active ? 0.7 : 1,
                    }}
                  >
                    <div style={{ minWidth: 150, flex: "1 1 150px" }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{b.name}</div>
                      <div style={{ color: T.dim, fontSize: 11 }}>
                        pack id <code>{b.packId}</code> · {b.units} unit{b.units === 1 ? "" : "s"}
                      </div>
                    </div>

                    {active ? (
                      <div style={{ fontSize: 12, color: "#8fe0a8" }}>
                        ✓ active as <code>{b.targetId}</code>
                      </div>
                    ) : (
                      <>
                        <label style={{ fontSize: 11, color: T.dim }}>
                          catalog id
                          <input
                            style={{ ...idInput, marginLeft: 6 }}
                            value={draftId}
                            onChange={(e) => setIdEdits((m) => ({ ...m, [key]: e.target.value }))}
                            onBlur={() => {
                              if (draftId.trim() && draftId !== b.targetId) void onRemap(p.id, b.packId, draftId.trim());
                            }}
                          />
                        </label>
                        <span style={{ fontSize: 11, color: willReplace ? "#e0b24a" : "#8fb4e0" }}>
                          {willReplace ? "⟳ will REPLACE this building" : "＋ new building"}
                        </span>
                        <button
                          style={activateBtn}
                          disabled={!!busy || !draftId.trim()}
                          onClick={() => void onActivate(p.id, b.packId, draftId.trim())}
                        >
                          Activate
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
