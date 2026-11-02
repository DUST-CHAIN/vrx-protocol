"use client";

// ── DocumentsPanel ──────────────────────────────────────────────────────────────
// A reusable building-documents panel: a tidy list of document buttons that open in a shared lightbox. It's
// the REPLICABLE dashboard spine — the SAME component is dropped into the developer (node), agency, agent,
// and buyer surfaces; `role` + `stage` decide which documents are visible and whether they're editable, so
// each audience sees only what it's allowed to at that point in the deal.
// Documents today:
// • Title deed — building legal foundation. Encrypted at rest, PARTY-OPEN. Developer uploads;
// everyone on the deal can view. The ONLY fully-wired doc this pass (upload + view).
// • Subscribed agencies — the building's DEAL-TERMS overview: which agencies have ACCESS (gates) and
// on what TERMS (agreements, with the snapshotted commission + scope + status). Pure
// surfacing of existing state via /api/building-docs/context — no new data model.
// • Acceptable terms — the developer's SOFT min–max commission ENVELOPE for NEW agreements.
// Developer-only; editable here. It flags an out-of-band rate (on the node agreement
// form + the Subscribed-agencies list) so the developer notices — it never blocks.
// • Furniture package — the furniture packs ATTACHED to this building (lib/furniture-packs). Read-only
// summary here; the developer authors/attaches packs in the node "Furniture packs" menu.
// • Agency agreement — the developer↔agency terms. Per-deal when live; shown here as a template.
// • S&P agreement — the Sale & Purchase. Per-deal when live; shown here as a template.
// • Agency offer — the reusable offer template; carries the VRX-facilitation (protocol-fee) slice
// ( §9). Not yet authored → placeholder.
// (The MIN–MAX commission ENVELOPE shipped here as the "Acceptable terms" row — see above. It will
// migrate to the building-setup editor when that lands; the data model + soft-warning stay unchanged.)
// bundle ( §2), construction/handover schedule as a document, furniture spec sheet, floor/level plans,
// re-vet evidence trail ( §4) — add them to DOC_SPECS with the right role/stage visibility. Keep each
// absent-safe: a building with none of these behaves exactly as today.
// Deferred (wallet arc): the ON-CHAIN "this is final" seal of the title-deed+location bundle + the ✓integrity
// check surfaced to parties ( §5). This panel is the surface those drop into.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { checkEnvelope, envelopeLabel, type TermsEnvelope } from "@/lib/catalog-client";
import { demoRoleUxArmed } from "@/lib/dev-signer-fence";

export type DocRole = "developer" | "agency" | "agent" | "buyer";
/** Deal stage (coarse) — drives which documents a non-developer may see. `none` = pre-deal. */
export type DealStage = "none" | "browsing" | "booked" | "agreed" | "final" | "signed";

type DocStatus = "ready" | "empty" | "template" | "locked";

/** Public metadata returned by /api/building-docs. */
type BuildingDocMeta = {
  id: string;
  building: string;
  kind: "title_deed";
  filename: string;
  mime: string;
  size: number;
  uploadedAt: number;
  sha256: string;
};

// ── Deal-terms context — the join returned by /api/building-docs/context. ────────────────────────
/** One building's clause inside an agreement (mirrors lib/agreements.AgreementBuilding). */
type AgreementBuildingClause = {
  buildingId: string;
  commissionPct: number;
  scope: "whole" | { units: string[] };
};
/** A salt-stripped, ✓-verified agreement (mirrors lib/agreements.PublicAgreement, only the fields we read). */
type CtxAgreement = {
  id: string;
  status: "published" | "proposed" | "agreed" | "declined" | "revoked";
  verified: boolean;
  seal: {
    agency: string;
    developer: string;
    buildings: AgreementBuildingClause[];
    agencyIdentity?: { legalName: string };
  };
};
type CtxFurniturePack = { id: string; label: string; items: unknown[] };
/** The whole context payload for the deal-terms surfacing. */
type DealContext = {
  developer: string;
  agencies: string[];
  agreements: CtxAgreement[];
  furniturePacks: CtxFurniturePack[];
  /** The developer's soft commission band. null = none set. Flags out-of-band snapshots; never blocks. */
  termsEnvelope: TermsEnvelope | null;
};

export default function DocumentsPanel({
  building,
  buildingName,
  role,
  stage = "none",
  editable,
}: {
  building: string;
  buildingName: string;
  role: DocRole;
  stage?: DealStage;
  /** Developer-only authoring (upload/replace/remove the title deed). Defaults to role === "developer". */
  editable?: boolean;
}) {
  const canEdit = editable ?? role === "developer";
  const [deed, setDeed] = useState<BuildingDocMeta | null>(null);
  const [ctx, setCtx] = useState<DealContext | null>(null);
  const [open, setOpen] = useState<null | { title: string; kind: DocKey }>(null);
  const [loaded, setLoaded] = useState(false);

  const loadDeed = useCallback(async () => {
    try {
      const res = await fetch(`/api/building-docs?building=${encodeURIComponent(building)}`);
      const j = (await res.json()) as { docs?: BuildingDocMeta[] };
      setDeed((j.docs ?? []).find((d) => d.kind === "title_deed") ?? null);
    } catch {
      setDeed(null);
    } finally {
      setLoaded(true);
    }
  }, [building]);

  // Deal-terms context (who's subscribed + furniture). Only the developer + agency surfaces need it; a buyer
  // sees the furniture summary too, so fetch it for everyone but gate the ROWS below on role/stage.
  const loadCtx = useCallback(async () => {
    try {
      const res = await fetch(`/api/building-docs/context?building=${encodeURIComponent(building)}`);
      setCtx(res.ok ? ((await res.json()) as DealContext) : null);
    } catch {
      setCtx(null);
    }
  }, [building]);

  useEffect(() => {
    setLoaded(false);
    void loadDeed();
    void loadCtx();
  }, [loadDeed, loadCtx]);

  // Which docs this role+stage may SEE. The developer sees everything about their own building. A deal party
  // (agency/agent/buyer) sees the title deed once engaged, and the agreements only at the stage they apply.
  const rows: DocRow[] = [
    {
      key: "title_deed",
      label: "Title deed",
      hint: "Land-registry document — the building's legal foundation.",
      status: deed ? "ready" : canEdit ? "empty" : "locked",
      visible: canEdit || stage !== "none",
    },
    {
      // Deal-terms overview: who has ACCESS (gates) and on what TERMS (agreements). Developer sees the whole
      // picture for their building; an agency sees it as context on the relationship. Not for agent/buyer.
      key: "subscribed",
      label: "Subscribed agencies",
      hint: "Which agencies have access to this building, and on what terms.",
      status: ctx && (ctx.agencies.length > 0 || agreementsForBuilding(ctx, building).length > 0) ? "ready" : "empty",
      // Badge counts the gated agencies (the access list) — the primary "who's subscribed" number.
      badge: ctx && ctx.agencies.length > 0 ? `${ctx.agencies.length}` : undefined,
      visible: role === "developer" || role === "agency",
    },
    {
      // Acceptable terms — the developer's soft MIN–MAX commission band for NEW agreements. Developer-
      // only (it's their private negotiation guide, not an agency-facing promise). Editable here; soft-warns
      // the authoring form + the subscribed list when a rate is out of band.
      key: "acceptable_terms",
      label: "Acceptable terms",
      hint: "Your min–max commission band for new agreements. A soft guide — it flags, it never blocks.",
      status: ctx?.termsEnvelope && envelopeLabel(ctx.termsEnvelope) ? "ready" : "empty",
      badge: ctx?.termsEnvelope ? envelopeLabel(ctx.termsEnvelope) ?? undefined : undefined,
      visible: role === "developer",
    },
    {
      // Furniture packs attached to this building (read-only summary; authored in the node packs menu).
      key: "furniture",
      label: "Furniture package",
      hint: "Furniture packs offered on this building.",
      status: ctx && ctx.furniturePacks.length > 0 ? "ready" : "empty",
      badge: ctx && ctx.furniturePacks.length > 0 ? `${ctx.furniturePacks.length}` : undefined,
      visible: role === "developer" || (role !== "agency" && stage !== "none"),
    },
    {
      key: "agency_agreement",
      label: "Agency agreement",
      hint: "Developer ↔ agency terms. Signed per engagement.",
      status: "template",
      visible: role === "developer" || role === "agency",
    },
    {
      key: "sp_agreement",
      label: "Sale & Purchase",
      hint: "The S&P contract — populated per deal, shown before deposit.",
      status: "template",
      visible: role === "developer" || (role !== "agency" && stage !== "none"),
    },
    {
      key: "agency_offer",
      label: "Agency offer template",
      hint: "Reusable offer template — carries the VRX-facilitation slice.",
      status: "empty",
      visible: role === "developer" || role === "agency",
    },
  ];
  const shown = rows.filter((r) => r.visible);

  return (
    <div
      style={{
        background: "#0e1119",
        border: "1px solid #232838",
        borderRadius: 10,
        padding: 12,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, opacity: 0.75, letterSpacing: 0.2 }}>
        📄 Building documents
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {shown.map((r) => (
          <DocButton
            key={r.key}
            row={r}
            onOpen={() => setOpen({ title: r.label, kind: r.key })}
          />
        ))}
        {shown.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.6, padding: "6px 2px" }}>
            Documents appear here as the deal progresses.
          </div>
        )}
      </div>
      {!loaded && <div style={{ fontSize: 11, opacity: 0.4 }}>Loading…</div>}

      {open && (
        <DocLightbox
          title={open.title}
          kind={open.kind}
          building={building}
          buildingName={buildingName}
          deed={deed}
          ctx={ctx}
          role={role}
          canEdit={canEdit}
          onClose={() => setOpen(null)}
          onChanged={() => { void loadDeed(); void loadCtx(); }}
        />
      )}
    </div>
  );
}

type DocKey = "title_deed" | "subscribed" | "acceptable_terms" | "furniture" | "agency_agreement" | "sp_agreement" | "agency_offer";
type DocRow = { key: DocKey; label: string; hint: string; status: DocStatus; visible: boolean; badge?: string };

/** The clauses that cover a given building across a context's agreements (one per agreement that includes it). */
function agreementsForBuilding(ctx: DealContext, building: string): CtxAgreement[] {
  return ctx.agreements.filter((g) => g.seal.buildings.some((b) => b.buildingId === building));
}

const STATUS_BADGE: Record<DocStatus, { text: string; color: string }> = {
  ready: { text: "✓ on file", color: "#5fd08a" },
  empty: { text: "not set", color: "#8892a8" },
  template: { text: "template", color: "#7fa8e8" },
  locked: { text: "when engaged", color: "#8892a8" },
};

function DocButton({ row, onOpen }: { row: DocRow; onOpen: () => void }) {
  const badge = STATUS_BADGE[row.status];
  return (
    <button
      type="button"
      onClick={onOpen}
      title={row.hint}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        borderRadius: 8,
        border: "1px solid #232a3b",
        background: "#0b0e16",
        color: "#dfe5f5",
        cursor: "pointer",
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
      {row.badge && (
        <span
          style={{
            fontSize: 11, fontWeight: 600, color: "#cfe0ff", background: "#1a2540",
            borderRadius: 999, padding: "1px 7px", flex: "none", minWidth: 18, textAlign: "center",
          }}
        >
          {row.badge}
        </span>
      )}
      <span style={{ fontSize: 11, color: badge.color, flex: "none" }}>{badge.text}</span>
    </button>
  );
}

// ── The shared document lightbox ──────────────────────────────────────────────────────────────────────
// Renders the title deed inline (PDF via <iframe>, image via <img>) pointed at the party-open view route, with
// a developer upload/replace control. The contract templates show a stage-gated explainer (the LIVE per-deal
// contract lives in the agent/buyer dashboards via ContractModal; here at building level it's a template).
function DocLightbox({
  title,
  kind,
  building,
  buildingName,
  deed,
  ctx,
  role,
  canEdit,
  onClose,
  onChanged,
}: {
  title: string;
  kind: DocKey;
  building: string;
  buildingName: string;
  deed: BuildingDocMeta | null;
  ctx: DealContext | null;
  role: DocRole;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(f: File) {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("building", building);
      fd.append("kind", "title_deed");
      fd.append("file", f);
      const res = await fetch("/api/building-docs", { method: "POST", body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "upload failed");
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await fetch(`/api/building-docs?building=${encodeURIComponent(building)}&kind=title_deed`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const isDeed = kind === "title_deed";
  // In the public DEMO the ENCRYPTED document blob isn't shipped (only its metadata) — building-docs are
  // AES-GCM vault blobs, not committed public assets. So a demo viewer can't render the deed; rather
  // than a broken <img>, show it as what it IS: a sealed, private document (sells the privacy moat). On a real
  // deploy the blob is present and renders normally. `demoSealed` = demo mode AND there is deed metadata.
  const [demoArmed, setDemoArmed] = useState(false);
  useEffect(() => setDemoArmed(demoRoleUxArmed()), []);
  const demoSealed = demoArmed && !!deed;
  const viewUrl = deed && !demoSealed ? `/api/building-docs/view?id=${encodeURIComponent(deed.id)}` : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => !busy && onClose()}
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(4,6,12,0.82)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0e1119", border: "1px solid #232838", borderRadius: 12,
          width: "min(920px, 96vw)", maxHeight: "92vh", overflow: "auto", padding: 18, color: "#dfe5f5",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>📄 {title}</h3>
          <span style={{ fontSize: 12.5, opacity: 0.6 }}>{buildingName}</span>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "#9aa4bf", cursor: "pointer", fontSize: 20 }}
          >
            ×
          </button>
        </div>

        {isDeed ? (
          <div>
            {viewUrl ? (
              deed!.mime === "application/pdf" ? (
                <iframe
                  src={viewUrl}
                  title="Title deed"
                  style={{ width: "100%", height: "62vh", border: "1px solid #232838", borderRadius: 8, background: "#fff" }}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={viewUrl}
                  alt="Title deed"
                  style={{ maxWidth: "100%", maxHeight: "62vh", display: "block", margin: "0 auto", borderRadius: 8, border: "1px solid #232838" }}
                />
              )
            ) : demoSealed ? (
              <div
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
                  padding: "30px 18px", textAlign: "center",
                  border: "1px dashed #2f3a57", borderRadius: 10, background: "#0b0e16",
                }}
              >
                <div style={{ fontSize: 30, lineHeight: 1 }}>🔒</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Sealed — private document</div>
                <div style={{ fontSize: 12.5, opacity: 0.7, maxWidth: 420, lineHeight: 1.6 }}>
                  This document is encrypted in the building vault and only decrypts for the parties on the deal.
                  Its filename, size and integrity hash are shown below as proof it&apos;s on file — the contents
                  stay private. That&apos;s the point: VRX proves a document exists and hasn&apos;t changed,
                  without exposing it.
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.7, padding: "24px 0", textAlign: "center" }}>
                {canEdit ? "No title deed on file yet — upload the land-registry document below." : "The title deed will be available here once the developer files it."}
              </div>
            )}

            {deed && (
              <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 8, lineHeight: 1.6 }}>
                {deed.filename} · {(deed.size / 1024).toFixed(0)} KB · filed {new Date(deed.uploadedAt).toLocaleDateString()}
                <br />
                Integrity hash <code style={{ opacity: 0.8 }}>{deed.sha256.slice(0, 16)}…</code> — sealed on-chain at “this is final” (coming).
              </div>
            )}

            {canEdit && (
              <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #2a3350", background: "#1a2540", color: "#dfe5f5", cursor: "pointer", fontSize: 13, opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? "Uploading…" : deed ? "Replace document" : "Upload title deed"}
                </button>
                {deed && (
                  <button type="button" disabled={busy} onClick={() => void remove()} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #3a2030", background: "#2a1420", color: "#e0a0a0", cursor: "pointer", fontSize: 13 }}>
                    Remove
                  </button>
                )}
                {err && <span style={{ fontSize: 12.5, color: "#e0a0a0" }}>{err}</span>}
              </div>
            )}
          </div>
        ) : kind === "subscribed" ? (
          <SubscribedAgencies ctx={ctx} building={building} role={role} />
        ) : kind === "acceptable_terms" ? (
          <AcceptableTerms ctx={ctx} building={building} canEdit={canEdit} onChanged={onChanged} />
        ) : kind === "furniture" ? (
          <FurnitureSummary ctx={ctx} />
        ) : (
          <TemplateExplainer kind={kind as Exclude<DocKey, "title_deed" | "subscribed" | "acceptable_terms" | "furniture">} />
        )}
      </div>
    </div>
  );
}

// ── Subscribed-agencies overview ──────────────────────────────────────────────────────────────────
// Joins ACCESS (gates → ctx.agencies) with TERMS (agreements → the clause for this building). An agency with a
// gate but no agreement = "access, no terms yet"; an agreement with no live gate = terms agreed, access not yet
// opened. Both are real states worth showing — the developer needs to see the gap. Read-only surfacing.
function SubscribedAgencies({ ctx, building, role }: { ctx: DealContext | null; building: string; role: DocRole }) {
  if (!ctx) return <Muted>Loading…</Muted>;
  const clauses = agreementsForBuilding(ctx, building);
  // Index agreements by agency (lowercased) so we can pair each gated agency with its terms, if any.
  const byAgency = new Map<string, CtxAgreement>();
  for (const g of clauses) if (g.seal.agency) byAgency.set(g.seal.agency.toLowerCase(), g);

  // The union of agencies that have access OR terms (an agreement may exist before/without a gate).
  const names = new Set<string>();
  for (const a of ctx.agencies) names.add(a);
  for (const g of clauses) if (g.seal.agency) names.add(g.seal.agency);
  // NOTE: the developer sees every relationship on their building (this panel is developer-mounted today).
  // When the AGENCY surface mounts this panel, it must receive the viewer's account id and filter to its own
  // row only — an agency must never see a developer's OTHER agency relationships. (role alone can't scope it.)
  const rows = Array.from(names);
  void role;

  if (rows.length === 0) {
    return (
      <Muted>
        No agencies are subscribed to {ctx ? "this building" : "it"} yet. Grant an agency access on the
        “Agency access” panel, then agree terms — they’ll appear here.
      </Muted>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 0" }}>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 2 }}>
        Access from the gate; terms from the agency agreement (commission is the snapshot frozen when it was agreed).
      </div>
      {rows.map((agency) => {
        const g = byAgency.get(agency.toLowerCase());
        const clause = g?.seal.buildings.find((b) => b.buildingId === building);
        const hasAccess = ctx.agencies.some((a) => a.toLowerCase() === agency.toLowerCase());
        const name = g?.seal.agencyIdentity?.legalName;
        return (
          <div
            key={agency}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "9px 11px",
              border: "1px solid #232a3b", borderRadius: 8, background: "#0b0e16",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {name || agency}
              </div>
              <div style={{ fontSize: 11, opacity: 0.55, marginTop: 1 }}>
                {hasAccess ? "✓ access granted" : "terms only — access not opened"}
                {clause && (
                  <>
                    {" · "}
                    {clause.scope === "whole" ? "whole building" : `${clause.scope.units.length} unit(s)`}
                  </>
                )}
              </div>
            </div>
            {clause ? (
              <div style={{ textAlign: "right", flex: "none" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#9dd0ff" }}>
                  {clause.commissionPct}%
                  {role === "developer" && checkEnvelope(clause.commissionPct, ctx.termsEnvelope) && (
                    <span title={`Outside your acceptable band${envelopeLabel(ctx.termsEnvelope) ? ` (${envelopeLabel(ctx.termsEnvelope)})` : ""}`}
                      style={{ marginLeft: 5, fontSize: 11, color: "#e8c97f" }}>⚠</span>
                  )}
                </div>
                <div style={{ fontSize: 10.5, color: statusColor(g!.status) }}>
                  {g!.status}{g!.verified ? " · ✓ vetted" : ""}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11, opacity: 0.6, flex: "none" }}>no terms yet</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const AGREEMENT_STATUS_COLOR: Record<CtxAgreement["status"], string> = {
  published: "#7fa8e8",
  proposed: "#e8c97f",
  agreed: "#5fd08a",
  declined: "#c98a8a",
  revoked: "#8892a8",
};
function statusColor(s: CtxAgreement["status"]): string {
  return AGREEMENT_STATUS_COLOR[s] ?? "#8892a8";
}

// ── Acceptable-terms VIEW (authoring moved to Building Setup) ────────────────────────────
// The developer's SOFT min–max commission band for NEW agreements on this building. The AUTHORING home moved
// to the Building Setup editor (Fees & terms tab) so terms are edited in one place; this panel keeps a
// surfaces the sealed agreement snapshots that fall OUTSIDE the band as honest context — a sealed snapshot is
// frozen and the band bounds only NEW agreements.
function AcceptableTerms({
  ctx,
  building,
  canEdit,
}: {
  ctx: DealContext | null;
  building: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const env = ctx?.termsEnvelope ?? null;

  // Sealed snapshots that already fall outside the CURRENT (saved) band — shown as honest context.
  const clauses = ctx ? agreementsForBuilding(ctx, building) : [];
  const outOfBand = clauses
    .map((g) => ({ g, clause: g.seal.buildings.find((b) => b.buildingId === building) }))
    .filter((x) => x.clause && checkEnvelope(x.clause.commissionPct, env) !== null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" }}>
      <div style={{ fontSize: 12.5, opacity: 0.72, lineHeight: 1.6 }}>
        The commission band the developer is willing to agree on <b>new</b> agreements for this building. It’s a
        soft guide — it flags a rate outside the band when terms are set, so they notice; it never blocks.
        Already-agreed terms stay frozen.
      </div>
      <div style={{ fontSize: 13 }}>
        {env && envelopeLabel(env) ? (
          <>Current band: <b>{envelopeLabel(env)}</b>.</>
        ) : (
          <span style={{ opacity: 0.6 }}>No band set for this building.</span>
        )}
      </div>
      {canEdit && (
        <div style={{ fontSize: 12, opacity: 0.55 }}>
          Set or change the band in <b>Building setup → Fees &amp; terms</b>.
        </div>
      )}
      {outOfBand.length > 0 && (
        <div style={{ fontSize: 12, color: "#e8c97f", border: "1px solid #4a3d1c", background: "#241d0e", borderRadius: 8, padding: "8px 10px", lineHeight: 1.6 }}>
          {outOfBand.length} agreed term{outOfBand.length === 1 ? "" : "s"} on this building sit outside the band
          ({outOfBand.map((x) => `${x.clause!.commissionPct}%`).join(", ")}). That’s fine — sealed terms are
          frozen; the band only guides new agreements.
        </div>
      )}
    </div>
  );
}

// ── Furniture summary ─────────────────────────────────────────────────────────────────────────────
// Read-only list of the packs attached to this building. Authoring/attachment stays in the node "Furniture
function FurnitureSummary({ ctx }: { ctx: DealContext | null }) {
  if (!ctx) return <Muted>Loading…</Muted>;
  if (ctx.furniturePacks.length === 0) {
    return <Muted>No furniture packs are attached to this building yet. Attach one in the “Furniture packs” menu.</Muted>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 0" }}>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 2 }}>
        Furniture packs offered on this building. Per-unit cost is computed from the unit’s area at quote time.
      </div>
      {ctx.furniturePacks.map((p) => (
        <div
          key={p.id}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "9px 11px",
            border: "1px solid #232a3b", borderRadius: 8, background: "#0b0e16",
          }}
        >
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{p.label}</span>
          <span style={{ fontSize: 11, opacity: 0.55, flex: "none" }}>
            {p.items.length} item{p.items.length === 1 ? "" : "s"}
          </span>
        </div>
      ))}
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, opacity: 0.7, padding: "20px 2px", textAlign: "center", lineHeight: 1.6 }}>{children}</div>;
}

/** Placeholder body for the not-yet-wired contract templates — honest about what's live vs. coming. */
type TemplateKey = Exclude<DocKey, "title_deed" | "subscribed" | "acceptable_terms" | "furniture">;
function TemplateExplainer({ kind }: { kind: TemplateKey }) {
  const copy: Record<TemplateKey, { what: string; when: string }> = {
    agency_agreement: {
      what: "The developer↔agency agreement sets the access + commission terms.",
      when: "The live, signed version appears per engagement in the Agreements area.",
    },
    sp_agreement: {
      what: "The Sale & Purchase agreement is the buyer's contract for a specific unit.",
      when: "It's populated and shown to the buyer before the deposit, at the ‘final’ stage of a booking.",
    },
    agency_offer: {
      what: "A reusable offer template an agency presents to a buyer — it carries the VRX-facilitation (protocol-fee) slice.",
      when: "Authoring is coming; the template will attach to a building and prefill per deal.",
    },
  };
  const c = copy[kind];
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.8, padding: "8px 2px 4px" }}>
      <p style={{ marginTop: 0 }}>{c.what}</p>
      <p style={{ opacity: 0.7 }}>{c.when}</p>
    </div>
  );
}
