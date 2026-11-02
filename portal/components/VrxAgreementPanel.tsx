"use client";

// VrxAgreementPanel — the developer-facing surface to READ VRX's own disclosure terms and SIGN
// the VRX↔developer agreement, with a per-building sign-off. This is the UI the pure/data layer built
//  (lib/vrx-developer-agreement.ts) was waiting for — it turns the sealed record into a human act.
// WHAT THE DEVELOPER DOES HERE:
// 1. Reads VRX's standard terms — the protocol fee + settlement clock, the accuracy/attestation compact,
// the §3c consequence routine, what continues regardless, and the pro-developer upside. The terms are
// VRX's OWN language (same for every developer), shown with an HONEST "draft" badge while the wording is
// a placeholder pending legal review (⚠ v1-draft — the structure is real; the exact words are not final).
// 2. Signs off each of their buildings as true/complete ( — the explicit attestation VRX's bounded
// vetting presumes). Checkboxes, one per building.
// 3. Signs — accepting VRX's current terms. The server freezes the terms version + content hash + a snapshot
// of their fee + settlement window + the sign-offs into a salted seal (✓ Vetted).
// WHY THIS MATTERS FOR ENFORCEMENT: the §3c stage scheduler (the timed grace→suspend→remove consequences) is
// bound by the rule *no VRX action against a developer that wasn't disclosed in the agreement they signed*.
// This surface is how a developer actually SEES + SIGNS that disclosure — so a real signature here is the
// precondition the scheduler's §7 safety depends on (not just "the terms exist somewhere").
// terms copy itself is already (it lives in lib/vrx-developer-agreement.ts VRX_DEVELOPER_TERMS).
// PRIVACY: off-chain; reads/writes are developer-scoped through /api/vrx-developer-agreement. The chain
// is untouched.

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchCatalog, type Building } from "@/lib/catalog-client";
import { card, lbl, submitBtn, banner } from "@/lib/ui";
import { T, seal, chip } from "@/lib/theme";

// The live terms shape served by GET (mirrors lib/vrx-developer-agreement.ts VrxDeveloperTerms).
type Terms = {
  version: string;
  draft: boolean;
  fee: string;
  accuracy: string;
  consequence: string;
  continues: string;
  upside: string;
  tokens?: string; // present from v2-draft onward (optional so a pre-v2 version renders without it)
};

type BuildingSignOff = { buildingId: string; attested: boolean; attestedAt: number };

// The salt-stripped public agreement the route returns (mirrors PublicVrxDeveloperAgreement). We read only
// what the panel renders — the seal fields + the ✓ Vetted result + lifecycle.
type PublicAgreement = {
  id: string;
  seal: {
    developer: string;
    termsVersion: string;
    protocolFeePct: number;
    vrxSettleWorkingDays: number;
    signOffs: BuildingSignOff[];
    signedAt: number;
  };
  sealHash: string;
  status: "signed" | "revoked";
  verified: boolean;
  at: number;
  updatedAt: number;
};

type Loaded = {
  current: PublicAgreement | null;
  terms: Terms;
  feePct: number;
  settleDays: number;
};

// The plain-words sections, in the order a developer should read them (obligation → protection → upside →
// capacity). A section with no copy for the current version is skipped at render (so a pre-v2 agreement that
// lacks the token clause renders cleanly) — see the SECTIONS.map guard below.
const SECTIONS: Array<{ key: keyof Terms; title: string }> = [
  { key: "fee", title: "What VRX earns, and when" },
  { key: "accuracy", title: "Your responsibility for accuracy" },
  { key: "consequence", title: "What happens if something goes wrong" },
  { key: "continues", title: "What always keeps going" },
  { key: "upside", title: "Why this is good for you" },
  { key: "tokens", title: "Booking tokens — reservation capacity VRX issues you" }, // v2-draft onward
];

export default function VrxAgreementPanel({ me }: { me: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(false);

  // Per-building sign-off checkbox state (buildingId → attested). Seeded from the current agreement so a
  // re-sign starts from what the developer previously attested, not a blank slate.
  const [signOff, setSignOff] = useState<Record<string, boolean>>({});
  const [signing, setSigning] = useState(false);
  const [signErr, setSignErr] = useState<string | null>(null);
  const [justSigned, setJustSigned] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadErr(false);
    try {
      const r = await fetch(
        `/api/vrx-developer-agreement?developer=${encodeURIComponent(me)}&viewer=${encodeURIComponent(me)}`
      );
      const j = (await r.json()) as Loaded;
      setData(j);
      // Seed the checkboxes from the current agreement's attested sign-offs.
      const seeded: Record<string, boolean> = {};
      for (const s of j.current?.seal.signOffs ?? []) seeded[s.buildingId] = s.attested;
      setSignOff(seeded);
    } catch {
      setLoadErr(true);
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The developer's own buildings — the set they can sign off. Same source the portfolio grid uses.
  useEffect(() => {
    fetchCatalog(me)
      .then((bs) => setBuildings(bs))
      .catch(() => setBuildings([]));
  }, [me]);

  // Which buildings the CURRENT signed agreement already attests (for the "signed off" marks).
  const attestedNow = useMemo(() => {
    const set = new Set<string>();
    for (const s of data?.current?.seal.signOffs ?? []) if (s.attested) set.add(s.buildingId);
    return set;
  }, [data]);

  async function sign() {
    setSigning(true);
    setSignErr(null);
    setJustSigned(false);
    try {
      const signOffs = Object.entries(signOff).map(([buildingId, attested]) => ({ buildingId, attested }));
      const r = await fetch("/api/vrx-developer-agreement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ developer: me, viewer: me, signOffs }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Could not sign — please try again.");
      }
      setJustSigned(true);
      await refresh();
    } catch (e) {
      setSignErr(e instanceof Error ? e.message : "Could not sign — please try again.");
    } finally {
      setSigning(false);
    }
  }

  if (loading && !data) return <p style={{ opacity: 0.5, fontSize: 14 }}>Loading your VRX agreement…</p>;
  if (loadErr && !data)
    return (
      <div style={{ ...banner, fontSize: 13 }}>
        Couldn&apos;t load your VRX agreement.{" "}
        <button type="button" onClick={() => void refresh()} style={{ ...submitBtn, padding: "4px 10px", fontSize: 12.5, marginLeft: 8 }}>
          Retry
        </button>
      </div>
    );
  if (!data) return null;

  const { current, terms, feePct, settleDays } = data;
  const signedCount = Object.values(signOff).filter(Boolean).length;
  const onCurrentVersion = current?.seal.termsVersion === terms.version;

  return (
    <section style={{ ...card, borderColor: T.accent }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Your agreement with VRX</h2>
        {/* The user-facing "Draft terms" badge was removed: it read as contradictory next to
            "✓ Signed & Vetted". The honest v1-draft posture still lives in the version tag (VRX_DEVELOPER_TERMS_
 VERSION = "v1-draft") +; a wording change still bumps the version + re-requires signing.
            `terms.draft` stays in the data — only the badge is gone. */}
        {current && current.status === "signed" && (
          <span style={seal}>{current.verified ? "✓ Signed & Vetted" : "Signed"}</span>
        )}
      </div>
      <p style={{ opacity: 0.65, fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
        This is VRX&apos;s own agreement with you as a developer. Read it, sign off each of your buildings as
        accurate, and sign. Nothing VRX does to your account happens outside what this agreement describes.
      </p>

      {/* The fee + settlement window the developer will agree to — the honest numbers, up front. */}
      <div
        style={{
          display: "flex",
          gap: 20,
          flexWrap: "wrap",
          margin: "12px 0",
          padding: "10px 14px",
          background: T.bg2,
          border: `1px solid ${T.borderSoft}`,
          borderRadius: 10,
        }}
      >
        <div>
          <div style={{ ...lbl, marginBottom: 2 }}>VRX fee</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{feePct}%</div>
          <div style={{ fontSize: 11.5, opacity: 0.6 }}>per sale VRX helps you make</div>
        </div>
        <div>
          <div style={{ ...lbl, marginBottom: 2 }}>Settlement window</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{settleDays} working days</div>
          <div style={{ fontSize: 11.5, opacity: 0.6 }}>to pay after a unit leaves availability</div>
        </div>
      </div>

      {/* The plain-words sections. A section absent from the current version's copy (e.g. the token clause on a
          pre-v2 agreement) is skipped — never render an empty box. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
        {SECTIONS.filter((s) => typeof terms[s.key] === "string" && terms[s.key]).map((s) => (
          <div key={s.key} style={{ padding: "10px 14px", background: T.panel2, border: `1px solid ${T.borderSoft}`, borderRadius: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{s.title}</div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.65, opacity: 0.88 }}>{terms[s.key] as string}</p>
          </div>
        ))}
      </div>

      {/* Per-building sign-off. */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Sign off your buildings</div>
        <p style={{ fontSize: 12.5, opacity: 0.65, margin: "4px 0 10px", lineHeight: 1.55 }}>
          For each building, confirm the listing is true and complete. VRX reviews it as a reasonableness check,
          but you stay responsible for keeping it accurate. Only buildings you sign off are ready for VRX to vet.
          Signing off makes a building ready to list — it does not hide it. If you later need to stop new
          bookings, use the halt control on the building, not by withdrawing the sign-off.
        </p>
        {buildings === null ? (
          <p style={{ opacity: 0.5, fontSize: 13 }}>Loading your buildings…</p>
        ) : buildings.length === 0 ? (
          <p style={{ opacity: 0.6, fontSize: 13 }}>No buildings yet — you can still sign the agreement and sign off buildings later.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {buildings.map((b) => (
              <label
                key={b.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  background: T.bg2,
                  border: `1px solid ${signOff[b.id] ? "rgba(56,211,159,0.4)" : T.borderSoft}`,
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={!!signOff[b.id]}
                  onChange={(e) => setSignOff((prev) => ({ ...prev, [b.id]: e.target.checked }))}
                />
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>{b.name}</span>
                <span style={{ fontSize: 12, opacity: 0.55 }}>{b.units} units</span>
                {attestedNow.has(b.id) && onCurrentVersion && (
                  <span style={{ ...chip, marginLeft: "auto", color: T.vetted, borderColor: "rgba(56,211,159,0.3)" }}>
                    signed off
                  </span>
                )}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Sign / re-sign. */}
      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void sign()}
          disabled={signing}
          style={{ ...submitBtn, padding: "9px 20px", opacity: signing ? 0.6 : 1 }}
        >
          {signing
            ? "Signing…"
            : current && current.status === "signed"
            ? onCurrentVersion
              ? "Update my sign-offs"
              : "Re-sign the current terms"
            : "Sign the VRX agreement"}
        </button>
        <span style={{ fontSize: 12.5, opacity: 0.6 }}>
          {signedCount} of {buildings?.length ?? 0} building{(buildings?.length ?? 0) === 1 ? "" : "s"} signed off
        </span>
      </div>

      {justSigned && (
        <div style={{ ...banner, marginTop: 12, fontSize: 13, borderColor: "#2b5e3a", background: "#0f1c14" }}>
          Signed. Your agreement with VRX is sealed and verified.
        </div>
      )}
      {signErr && (
        <div style={{ ...banner, marginTop: 12, fontSize: 13, borderColor: "#6b2626", background: "#241010" }}>{signErr}</div>
      )}

      {current && current.status === "signed" && (
        <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 12, lineHeight: 1.6 }}>
          Signed {new Date(current.seal.signedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} on terms{" "}
          <span style={{ fontFamily: T.mono }}>{current.seal.termsVersion}</span>
          {!onCurrentVersion && " — VRX has since updated its terms; re-sign to accept the current version."}
        </p>
      )}
    </section>
  );
}
