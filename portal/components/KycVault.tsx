"use client";

// Buyer-KYC ENCRYPTED VAULT — the UI ( pt-2). Two surfaces over /api/kyc-vault + /api/kyc-vault/doc:
// • <KycVaultPanel> — the AGENT attaches a buyer's identity documents + structured contract fields + an
// optional captured GPS to a roster buyer. Mounted on the agent BuyerPicker. Images are encrypted at
// rest server-side (envelope AES-GCM, lib/kyc-vault); this panel only ever sends the raw file once.
// • <KycDocsReview> — the DEVELOPER's read-only pre-sign view. Shows the decrypted docs (via the scoped
// doc route, requestId+viewer, reveal-gated) so the developer can do the human visual match (face ↔ ID ↔
// card name) BEFORE marking the contract final + accepting the "seen, this purpose only" undertaking.
// PRIVACY: the plaintext image bytes come only from the scoped /api/kyc-vault/doc route (no-store). This
// component holds metadata + renders <img src=the-scoped-route>; it never persists bytes.

import { useCallback, useEffect, useRef, useState } from "react";
import { T } from "@/lib/theme";
import LocationMap from "@/components/LocationMap";

const KIND_LABEL: Record<string, string> = {
  headshot: "Buyer photo (headshot)",
  passport: "Passport",
  id_card: "National ID card",
  card_front: "Credit-card front (optional)",
};
const KIND_ORDER = ["headshot", "passport", "id_card", "card_front"] as const;
type Kind = (typeof KIND_ORDER)[number];

type DocMeta = { id: string; kind: string; filename: string; mime: string; size: number; contentHash: string; at: number };
type Fields = {
  legalName?: string;
  nationality?: string;
  passportNo?: string;
  idCardNo?: string;
  dob?: string;
  address?: string;
  phone?: string;
  email?: string;
};
type EntryMeta = {
  buyerId: string;
  fields: Fields;
  gps?: { lat: number; lng: number; accuracy?: number; at: number };
  docs: DocMeta[];
  updatedAt: number;
};

const FIELD_DEFS: { key: keyof Fields; label: string; placeholder?: string }[] = [
  { key: "legalName", label: "Full legal name (as on ID)" },
  { key: "nationality", label: "Nationality" },
  { key: "passportNo", label: "Passport number" },
  { key: "idCardNo", label: "National ID number" },
  { key: "dob", label: "Date of birth", placeholder: "YYYY-MM-DD" },
  { key: "address", label: "Residential address" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
];

const wrap: React.CSSProperties = {
  marginTop: 12,
  padding: "12px 14px",
  borderRadius: 10,
  background: T.bg2,
  border: `1px solid ${T.borderSoft}`,
};
const lbl: React.CSSProperties = { display: "block", fontSize: 11, color: T.dim, margin: "8px 0 3px" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: 7,
  border: `1px solid ${T.border}`,
  background: T.panel,
  color: T.text,
  fontSize: 13,
  boxSizing: "border-box",
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// AGENT PANEL — upload + fields + GPS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function KycVaultPanel({ buyerId, agent }: { buyerId: string; agent: string }) {
  const [entry, setEntry] = useState<EntryMeta | null>(null);
  const [fields, setFields] = useState<Fields>({});
  const [busy, setBusy] = useState<string | null>(null); // the kind being uploaded, or "fields"/"gps"
  const [err, setErr] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const load = useCallback(async () => {
    if (!buyerId || !agent) return;
    try {
      const r = await fetch(`/api/kyc-vault?buyerId=${encodeURIComponent(buyerId)}&agent=${encodeURIComponent(agent)}`);
      const j = await r.json();
      setEntry(j.entry ?? null);
      if (j.entry?.fields) setFields(j.entry.fields);
    } catch {
      /* best-effort */
    }
  }, [buyerId, agent]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(kind: Kind, file: File) {
    setErr(null);
    setBusy(kind);
    try {
      const fd = new FormData();
      fd.set("agent", agent);
      fd.set("buyerId", buyerId);
      fd.set("kind", kind);
      fd.set("file", file);
      const r = await fetch("/api/kyc-vault", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Upload failed.");
      else setEntry(j.entry);
    } catch {
      setErr("Upload failed.");
    } finally {
      setBusy(null);
    }
  }

  async function removeDoc(docId: string) {
    setBusy(docId);
    try {
      await fetch(
        `/api/kyc-vault?buyerId=${encodeURIComponent(buyerId)}&agent=${encodeURIComponent(agent)}&docId=${encodeURIComponent(docId)}`,
        { method: "DELETE" }
      );
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function saveFields() {
    setErr(null);
    setBusy("fields");
    try {
      const r = await fetch("/api/kyc-vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "fields", agent, buyerId, fields }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || "Could not save.");
      else {
        setEntry(j.entry);
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 1500);
      }
    } finally {
      setBusy(null);
    }
  }

  function captureGps() {
    setErr(null);
    if (!navigator.geolocation) {
      setErr("This device can't share a location.");
      return;
    }
    setBusy("gps");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const r = await fetch("/api/kyc-vault", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              op: "gps",
              agent,
              buyerId,
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            }),
          });
          const j = await r.json();
          if (r.ok) setEntry(j.entry);
          else setErr(j?.error || "Could not save location.");
        } finally {
          setBusy(null);
        }
      },
      () => {
        setErr("Location permission denied.");
        setBusy(null);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  const docByKind = (k: string) => entry?.docs.find((d) => d.kind === k) ?? null;

  return (
    <div style={wrap}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>Buyer KYC &amp; documents</div>
      <div style={{ fontSize: 11, color: T.dim, marginTop: 3, lineHeight: 1.4 }}>
        Identity documents the developer reviews before the Sale &amp; Purchase contract is finalised. Uploads are{" "}
        <strong style={{ color: T.vetted }}>encrypted at rest</strong> — only the booking&apos;s developer can view them,
        and only after you reveal the buyer. Complete any time up to signing.
      </div>

      {/* Documents */}
      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        {KIND_ORDER.map((k) => {
          const doc = docByKind(k);
          return (
            <div
              key={k}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 9px",
                borderRadius: 8,
                background: T.panel,
                border: `1px solid ${doc ? T.border : T.borderSoft}`,
              }}
            >
              {doc ? (
                <img
                  src={`/api/kyc-vault/doc?buyerId=${encodeURIComponent(buyerId)}&agent=${encodeURIComponent(agent)}&docId=${encodeURIComponent(doc.id)}`}
                  alt={KIND_LABEL[k]}
                  style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: `1px solid ${T.border}` }}
                />
              ) : (
                <div style={{ width: 44, height: 44, borderRadius: 6, background: T.bg2, border: `1px dashed ${T.border}` }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: T.text }}>{KIND_LABEL[k]}</div>
                <div style={{ fontSize: 11, color: doc ? T.vetted : T.faint }}>
                  {doc ? `✓ uploaded · ${doc.filename}` : "not uploaded"}
                </div>
              </div>
              <label style={{ ...pill, cursor: busy ? "default" : "pointer", opacity: busy === k ? 0.5 : 1 }}>
                {busy === k ? "…" : doc ? "Replace" : "Upload"}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  disabled={!!busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(k, f);
                    e.target.value = "";
                  }}
                />
              </label>
              {doc && (
                <button type="button" onClick={() => void removeDoc(doc.id)} disabled={!!busy} style={linkBtn}>
                  remove
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* GPS */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <button type="button" onClick={captureGps} disabled={!!busy} style={pill}>
          {busy === "gps" ? "…" : "📍 Capture location"}
        </button>
        {entry?.gps && (
          <a
            href={`https://www.openstreetmap.org/?mlat=${entry.gps.lat}&mlon=${entry.gps.lng}#map=16/${entry.gps.lat}/${entry.gps.lng}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11.5, color: T.accent }}
          >
            {entry.gps.lat.toFixed(5)}, {entry.gps.lng.toFixed(5)} — view on map ↗
          </a>
        )}
      </div>

      {/* Structured contract fields */}
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
        {FIELD_DEFS.map((f) => (
          <label key={f.key} style={{ display: "block" }}>
            <span style={lbl}>{f.label}</span>
            <input
              style={input}
              value={fields[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <button type="button" onClick={saveFields} disabled={!!busy} style={{ ...pill, borderColor: T.accent, color: T.accent }}>
          {busy === "fields" ? "Saving…" : "Save KYC details"}
        </button>
        {savedTick && <span style={{ fontSize: 11.5, color: T.vetted }}>✓ saved</span>}
      </div>

      {err && <div style={{ fontSize: 11.5, color: T.danger, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// DEVELOPER REVIEW — read-only, pre-sign. Serves bytes via the reveal-gated requestId+viewer route.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function KycDocsReview({ requestId, viewer }: { requestId: string; viewer: string }) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [gps, setGps] = useState<EntryMeta["gps"] | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "none" | "locked">("loading");
  const asked = useRef(false);

  // The developer's metadata read reuses the agent GET? No — that's agent-scoped. Instead the doc bytes come
  // from the scoped doc route; metadata (which docs exist + fields) is returned by /api/claims/sp (the S&P
  // viewer already resolves this booking for the developer). We fetch it there to avoid a second scope path.
  useEffect(() => {
    if (asked.current || !requestId || !viewer) return;
    asked.current = true;
    (async () => {
      try {
        const r = await fetch(`/api/claims/sp?requestId=${encodeURIComponent(requestId)}&viewer=${encodeURIComponent(viewer)}&kyc=1`);
        const j = await r.json();
        if (!r.ok) {
          setStatus(j?.error?.includes("reveal") ? "locked" : "none");
          return;
        }
        const kyc = j.kyc as { docs?: DocMeta[]; fields?: Fields; gps?: EntryMeta["gps"] } | undefined;
        if (!kyc || !kyc.docs?.length) {
          setStatus("none");
          return;
        }
        setDocs(kyc.docs);
        setFields(kyc.fields ?? {});
        setGps(kyc.gps ?? null);
        setStatus("ok");
      } catch {
        setStatus("none");
      }
    })();
  }, [requestId, viewer]);

  if (status === "loading") return <div style={{ fontSize: 11.5, color: T.dim }}>Loading buyer KYC…</div>;
  if (status === "locked")
    return <div style={{ fontSize: 11.5, color: T.dim }}>Reveal the buyer&apos;s identity to review their KYC documents.</div>;
  if (status === "none")
    return <div style={{ fontSize: 11.5, color: T.faint }}>No buyer KYC documents on file yet.</div>;

  const byKind = (k: string) => docs?.find((d) => d.kind === k) ?? null;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text, marginBottom: 2 }}>Buyer KYC — visual match</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 8 }}>
        Confirm the photo, the ID/passport, and the name on any card agree before you finalise. Used only to prepare
        and execute this contract.
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {KIND_ORDER.map((k) => {
          const doc = byKind(k);
          if (!doc) return null;
          return (
            <a
              key={k}
              href={`/api/kyc-vault/doc?requestId=${encodeURIComponent(requestId)}&viewer=${encodeURIComponent(viewer)}&docId=${encodeURIComponent(doc.id)}`}
              target="_blank"
              rel="noreferrer"
              style={{ textAlign: "center", textDecoration: "none" }}
            >
              <img
                src={`/api/kyc-vault/doc?requestId=${encodeURIComponent(requestId)}&viewer=${encodeURIComponent(viewer)}&docId=${encodeURIComponent(doc.id)}`}
                alt={KIND_LABEL[k]}
                style={{ width: 120, height: 90, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}`, display: "block" }}
              />
              <span style={{ fontSize: 10.5, color: T.dim, display: "block", marginTop: 3 }}>{KIND_LABEL[k]}</span>
            </a>
          );
        })}
      </div>
      {fields && Object.values(fields).some(Boolean) && (
        <div style={{ marginTop: 10, fontSize: 12, color: T.text, display: "grid", gap: 2 }}>
          {FIELD_DEFS.filter((f) => fields[f.key]).map((f) => (
            <div key={f.key}>
              <span style={{ color: T.dim }}>{f.label}: </span>
              {fields[f.key]}
            </div>
          ))}
        </div>
      )}
      {gps && (
        // Buyer's captured upload GPS on a read-only OSM mini-map ( — the maps arc's first consumer).
        // Party-scoped PII: only reachable here through the reveal-gated developer review.
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11.5, color: T.dim, marginBottom: 4 }}>
            📍 Captured location {gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}
            {gps.accuracy ? ` · ±${Math.round(gps.accuracy)}m` : ""}
          </div>
          <LocationMap geo={{ lat: gps.lat, lng: gps.lng }} height={180} />
        </div>
      )}
    </div>
  );
}

const pill: React.CSSProperties = {
  fontSize: 11.5,
  padding: "5px 10px",
  borderRadius: 7,
  background: T.panel,
  border: `1px solid ${T.border}`,
  color: T.text,
  cursor: "pointer",
};
const linkBtn: React.CSSProperties = {
  fontSize: 11,
  color: T.faint,
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 0,
};
