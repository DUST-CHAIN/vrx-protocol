"use client";

// ── EvidencePacksPanel (the reader surface for the encrypted-evidence-pack durability leg) ─────────────
// The party's "hold your OWN copy" surface ([[vrx-money-privacy-durability-fork]], the notary-not-bank leg). At each
// money/consent chokepoint (deposit custody today) VRX seals a FULL encrypted copy of the event to the party's X25519
// delivery key — the server holds ciphertext it CANNOT read. This panel lets the party:
//   (1) see whether they have a DELIVERY KEY on file (needed to receive packs), and mint one if not;
//   (2) list the encrypted packs addressed to them (metadata only — the server never shows plaintext).
// Opening a pack = a FUTURE client-side step (the party decrypts with their OWN private key — never through the
// server). This panel surfaces existence + custody of the party's durable evidence; it does not decrypt here.
//
// WHY it matters (the honest line shown to the party): "If VRX ever disappears, you still hold your own sealed,
// independently-verifiable copy of every deposit event." That's the durability promise made concrete.
//
// Fetches /api/evidence/packs + /api/evidence/delivery-key (both CALLER-SCOPED — the party only ever sees their own).
// Additive + degrades silently: if nothing is registered and no packs exist, it renders a compact "set up" prompt;
// if the fetch fails it renders nothing (never blocks the tray it sits in).

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";

type PackMeta = {
  packId: string;
  kind: string;
  ref: string;
  recipient: string;
  contentHash: string;
  createdAt: number;
};
type KeyStatus = { registered: boolean; current?: string; archivedCount?: number; updatedAt?: number };

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const KIND_LABEL: Record<string, string> = {
  deposit_custody: "Deposit event",
  sp_document: "Sale & Purchase",
  handover: "Handover",
  signing: "Signing",
  change_governance: "Change of terms",
  other: "Evidence",
};

export default function EvidencePacksPanel({ account }: { account: string }) {
  const [packs, setPacks] = useState<PackMeta[] | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [minting, setMinting] = useState(false);
  const [mintedPriv, setMintedPriv] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pr, kr] = await Promise.all([
        fetch(`/api/evidence/packs?account=${encodeURIComponent(account)}`),
        fetch(`/api/evidence/delivery-key?account=${encodeURIComponent(account)}`),
      ]);
      const pj = pr.ok ? await pr.json() : { packs: [] };
      const kj = kr.ok ? await kr.json() : { registered: false };
      setPacks(Array.isArray(pj.packs) ? pj.packs : []);
      setKeyStatus(kj);
    } catch {
      setPacks([]);
      setKeyStatus({ registered: false });
    } finally {
      setLoaded(true);
    }
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  const mintKey = useCallback(async () => {
    setMinting(true);
    setErr(null);
    try {
      const r = await fetch("/api/evidence/delivery-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, action: "mint" }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setErr("Couldn't set up your evidence key. Please try again.");
      } else {
        setMintedPriv(j.privateKeyB64 || null); // shown ONCE for the party to save; never stored server-side
        await load();
      }
    } catch {
      setErr("Couldn't reach the evidence service. Please try again.");
    } finally {
      setMinting(false);
    }
  }, [account, load]);

  if (!loaded) return null;
  const hasPacks = !!packs && packs.length > 0;
  const registered = !!keyStatus?.registered;

  // Nothing to show AND no key AND no packs → a quiet "set up your evidence copies" prompt (so the party can opt in
  // before their first custody event; after that, packs appear). We DO render this so the feature is discoverable.
  return (
    <div
      style={{
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: "12px 14px",
        marginTop: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>🔐 Your sealed evidence copies</strong>
        {registered && (
          <span style={{ fontSize: 11, color: T.vetted }} title="You have a delivery key on file — new deposit events are sealed to you automatically.">
            · delivery key active
          </span>
        )}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 11.5, color: T.dim, lineHeight: 1.5 }}>
        VRX seals an encrypted copy of each of your deposit events to your own key — one only you can open. If VRX ever
        disappears, you still hold an independently-verifiable record.
      </p>

      {/* Set-up: no delivery key yet → offer to mint one. */}
      {!registered && (
        <div style={{ marginTop: 10 }}>
          <button
            onClick={mintKey}
            disabled={minting}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#fff",
              background: T.accent,
              border: "none",
              borderRadius: 8,
              padding: "6px 12px",
              cursor: minting ? "default" : "pointer",
              opacity: minting ? 0.6 : 1,
            }}
          >
            {minting ? "Setting up…" : "Set up my evidence key"}
          </button>
        </div>
      )}

      {/* The minted private key — shown ONCE. The party MUST save it (server never stores it). */}
      {mintedPriv && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            background: "rgba(232,184,75,0.08)",
            border: `1px solid ${T.hold}`,
            borderRadius: 8,
          }}
        >
          <strong style={{ fontSize: 11.5, color: T.hold }}>⚠ Save this private key now — it is shown only once.</strong>
          <p style={{ margin: "4px 0 6px", fontSize: 11, color: T.dim }}>
            This is YOUR key to open your sealed evidence copies. VRX does not keep it. Store it somewhere safe.
          </p>
          <code
            style={{
              display: "block",
              fontFamily: T.mono,
              fontSize: 10.5,
              wordBreak: "break-all",
              color: T.text,
              background: "rgba(0,0,0,0.25)",
              padding: "6px 8px",
              borderRadius: 6,
            }}
          >
            {mintedPriv}
          </code>
        </div>
      )}

      {err && <p style={{ margin: "8px 0 0", fontSize: 11, color: T.danger }}>{err}</p>}

      {/* The pack list (metadata only — never plaintext). */}
      {hasPacks && (
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 6 }}>
          {packs!.map((pk) => (
            <li
              key={pk.packId}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                fontSize: 11.5,
                padding: "6px 8px",
                background: "rgba(56,211,159,0.06)",
                border: `1px solid ${T.border}`,
                borderRadius: 8,
              }}
            >
              <span style={{ fontWeight: 600 }}>{KIND_LABEL[pk.kind] ?? pk.kind}</span>
              <span style={{ color: T.dim }}>· {fmtDate(pk.createdAt)}</span>
              <span
                title="The fingerprint of your decrypted copy — you re-derive it from your opened copy to prove it's intact."
                style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 10, color: T.dim }}
              >
                {pk.contentHash.slice(0, 12)}…
              </span>
            </li>
          ))}
        </ul>
      )}

      {registered && !hasPacks && (
        <p style={{ margin: "8px 0 0", fontSize: 11, color: T.dim }}>
          No sealed copies yet — one is created automatically on your next deposit event.
        </p>
      )}
    </div>
  );
}
