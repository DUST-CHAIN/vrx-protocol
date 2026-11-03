"use client";

// ── IdentityStatusBadge (the reader surface for the identity durability arc) ───────────────────────────
// Renders ONE account's composed identity picture from /api/identity/status (PUBLIC read — vetting is counterparty-
// visible): the immutable ISSUANCE proof ("VRX-vetted as of T", with its Bitcoin-anchor state) + the mutable CURRENT
// status (active | revoked). Two complementary facts, shown together + honestly:
//   "✓ VRX-vetted as of 14 Nov 2026 (Bitcoin-anchored)"          — active, proof confirmed
//   "✓ VRX-vetted as of 14 Nov 2026 (Bitcoin confirmation pending)" — active, proof still landing (NORMAL, not a warn)
//   "⚠ Vetting REVOKED as of 1 Dec 2026 (fraud)"                 — current status overrides the live badge colour
//
// ⚠ NEVER a current-validity guarantee from the anchor alone: a Bitcoin stamp proves ISSUANCE-at-T, so the badge
// always reads "as of <date>", and the REVOCATION status (live) is what flips it to a warning. This mirrors the
// module invariant (lib/identity-stamp / lib/identity-revocation): provenance, never authorization — the badge shows
// truth, it never gates anything.
//
// Placement: the developer's own /node header (self-view) + any counterparty card (who am I dealing with). Compact
// pill by default; `detail` expands the full "as of" + revocation line. Degrades silently (renders nothing) if the
// status can't be fetched — it's an additive reassurance surface, never load-bearing for a flow.

import { useEffect, useState } from "react";
import { T } from "@/lib/theme";

type CurrentStatus = {
  account: string;
  state: "active" | "revoked";
  since: number;
  reasonCode?: string;
  label: string;
};
type IdentityStatus = {
  account: string;
  current: CurrentStatus;
  issuance: Array<{ status: "pending" | "proven" | "failed"; label: string; stampedAt: number; provenAt: number | null }>;
  issuanceLabels: string[];
};

export default function IdentityStatusBadge({
  account,
  detail = false,
}: {
  account: string;
  detail?: boolean;
}) {
  const [data, setData] = useState<IdentityStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    const qs = new URLSearchParams({ account });
    if (tz) qs.set("tz", tz);
    fetch(`/api/identity/status?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: IdentityStatus | null) => {
        if (live) {
          setData(j);
          setLoaded(true);
        }
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [account]);

  if (!loaded || !data) return null;

  const revoked = data.current.state === "revoked";
  // The best issuance label to show on the pill: prefer a PROVEN anchor's "as of" line, else the newest.
  const bestLabel =
    data.issuanceLabels.find((_, i) => data.issuance[i]?.status === "proven") ?? data.issuanceLabels[0] ?? null;
  const hasIssuance = data.issuance.length > 0;

  // No issuance anchor AND never revoked → nothing durable to show yet (don't render a misleading empty badge).
  if (!hasIssuance && !revoked) return null;

  const color = revoked ? T.danger : T.vetted;
  const pillText = revoked
    ? `⚠ ${data.current.label}`
    : bestLabel
      ? `✓ ${bestLabel}`
      : "✓ VRX-vetted";

  return (
    <span
      title={
        revoked
          ? "VRX has WITHDRAWN this party's vetting. The historical 'vetted as of' proof still stands (you can't un-happen a past attestation), but the vetting is NOT in force now."
          : "VRX vetted this party. The 'as of' date is when the vetting was issued; a Bitcoin anchor makes that issuance independently verifiable. This is provenance, not a live guarantee — check the current status."
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        fontWeight: 600,
        color,
        background: revoked ? "rgba(248,113,113,0.10)" : "rgba(74,222,128,0.10)",
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: "2px 9px",
        whiteSpace: detail ? "normal" : "nowrap",
        lineHeight: 1.4,
      }}
    >
      {pillText}
      {detail && revoked && hasIssuance && (
        // When revoked, STILL show the historical issuance line (it remains true) in a muted tone beside the warning.
        <span style={{ color: T.dim, fontWeight: 400, marginLeft: 6 }}>
          · (issued: {data.issuanceLabels[0]})
        </span>
      )}
    </span>
  );
}
