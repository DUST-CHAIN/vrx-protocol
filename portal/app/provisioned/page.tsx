"use client";

// Root-dashboard v0 read view — "what have I provisioned?"
// Lists the nodes/orgs THIS client provisioned (from local storage — lib/provisioned.ts) and confirms each
// one against the LIVE contract via get_node/get_org. This is deliberately the per-client view, not a
// network-wide enumeration: per clients carry their own weight (no contract-side list_* enumeration,
// no central server). A global view is a later shared-indexer layer.
// PRIVACY: we only ever show the neutral account id + the opaque on-chain ref + the on-chain flags.
// No off-chain profile/PII is stored or shown — it never left the onboarding form.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getNode, getOrg } from "@/lib/vrx";
import { listProvisioned, forgetProvisioned, type ProvisionedRecord } from "@/lib/provisioned";
import { CONTRACT_ID, EXPLORER_URL } from "@/lib/config";

// Shape of a node/org view result (serde short keys): { id, h|r, t (ns), a }.
type OnChain = { id: string; h?: string; r?: string; t: number; a: boolean } | null;

type Row = ProvisionedRecord & {
  onchain: OnChain;
  state: "loading" | "confirmed" | "missing" | "error";
};

export default function Provisioned() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const local = listProvisioned();
    setLoaded(true);
    // Seed rows in "loading" so the list paints immediately, then confirm each against the chain.
    setRows(local.map((r) => ({ ...r, onchain: null, state: "loading" as const })));
    const confirmed = await Promise.all(
      local.map(async (r): Promise<Row> => {
        try {
          const oc = (r.kind === "node" ? await getNode(r.id) : await getOrg(r.id)) as OnChain;
          return { ...r, onchain: oc, state: oc ? "confirmed" : "missing" };
        } catch {
          return { ...r, onchain: null, state: "error" };
        }
      })
    );
    setRows(confirmed);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function forget(r: Row) {
    forgetProvisioned(r.id, r.kind);
    setRows((rs) => rs.filter((x) => !(x.id === r.id && x.kind === r.kind)));
  }

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Provisioned</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        Nodes and orgs provisioned from <strong>this client</strong>, confirmed live against{" "}
        <code>{CONTRACT_ID}</code>. This is a local record — a network-wide view comes later via a
        shared indexer. Only the neutral id + opaque ref are shown.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
        <button type="button" onClick={refresh} style={btn}>
          Refresh from chain
        </button>
        <Link href="/onboarding" style={{ ...btn, textDecoration: "none", display: "inline-block" }}>
          + Provision
        </Link>
      </div>

      {loaded && rows.length === 0 && (
        <div style={empty}>
          Nothing provisioned from this client yet. Head to{" "}
          <Link href="/onboarding" style={{ color: "#7aa2ff" }}>
            Onboarding
          </Link>{" "}
          to provision a node or org. (Provisions made from another client won&apos;t show here — that&apos;s
          the shared-indexer view, still to come.)
        </div>
      )}

      {rows.map((r) => (
        <article key={`${r.kind}:${r.id}`} style={rowCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <div>
              <span style={kindTag(r.kind)}>{r.kind === "node" ? "Node" : "Org"}</span>
              <code style={{ fontSize: 15, marginLeft: 8 }}>{r.id}</code>
            </div>
            <StateBadge state={r.state} active={r.onchain?.a} />
          </div>

          <div style={{ fontSize: 13, opacity: 0.75, marginTop: 8, lineHeight: 1.6 }}>
            <div>
              Opaque ref:{" "}
              <code style={{ wordBreak: "break-all" }}>{shortHash(r.ref)}</code>
              {r.onchain && (r.onchain.h ?? r.onchain.r) && (
                <span style={{ marginLeft: 8 }}>
                  {refMatches(r) ? (
                    <span style={{ color: "#7ce0a0" }}>✓ matches on-chain</span>
                  ) : (
                    <span style={{ color: "#ffcf70" }}>⚠ differs from on-chain ref</span>
                  )}
                </span>
              )}
            </div>
            <div>Provisioned from here: {new Date(r.at).toLocaleString()}</div>
            {r.onchain && (
              <div>On-chain since: {new Date(r.onchain.t / 1e6).toLocaleString()}</div>
            )}
            {r.tx && (
              <div>
                Tx:{" "}
                <a
                  href={`${EXPLORER_URL}/transactions/${r.tx}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#7aa2ff" }}
                >
                  {shortHash(r.tx)}
                </a>
              </div>
            )}
          </div>

          <button type="button" onClick={() => forget(r)} style={forgetBtn} title="Remove from this client's local list only — does not touch the chain">
            Forget locally
          </button>
        </article>
      ))}
    </main>
  );
}

function refMatches(r: Row): boolean {
  const onchainRef = r.onchain?.h ?? r.onchain?.r;
  return !!onchainRef && onchainRef === r.ref;
}

function StateBadge({ state, active }: { state: Row["state"]; active?: boolean }) {
  if (state === "loading") return <span style={{ ...badge, ...badgeGray }}>checking…</span>;
  if (state === "error") return <span style={{ ...badge, ...badgeRed }}>chain error</span>;
  if (state === "missing")
    return <span style={{ ...badge, ...badgeRed }}>not on-chain</span>;
  return active ? (
    <span style={{ ...badge, ...badgeGreen }}>active</span>
  ) : (
    <span style={{ ...badge, ...badgeAmber }}>inactive</span>
  );
}

function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

// ── styles ──
const btn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  background: "#0e1119",
  border: "1px solid #2a2f40",
  color: "#c7cde0",
  fontSize: 14,
  cursor: "pointer",
};
const rowCard: React.CSSProperties = {
  padding: 16,
  marginBottom: 12,
  borderRadius: 12,
  background: "#141824",
  border: "1px solid #232838",
};
const empty: React.CSSProperties = {
  padding: 22,
  borderRadius: 12,
  background: "#141824",
  border: "1px dashed #2a2f40",
  fontSize: 14,
  opacity: 0.85,
};
const badge: React.CSSProperties = {
  fontSize: 12,
  padding: "3px 10px",
  borderRadius: 999,
  whiteSpace: "nowrap",
};
const badgeGray: React.CSSProperties = { background: "#232838", color: "#9aa4bf" };
const badgeGreen: React.CSSProperties = { background: "#15271b", color: "#7ce0a0", border: "1px solid #2f5a3a" };
const badgeAmber: React.CSSProperties = { background: "#2a2413", color: "#ffcf70", border: "1px solid #5a4a1a" };
const badgeRed: React.CSSProperties = { background: "#26161a", color: "#ff9a9a", border: "1px solid #5a3a3a" };
const kindTag = (kind: "node" | "org"): React.CSSProperties => ({
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 6,
  background: kind === "node" ? "#152030" : "#20182a",
  color: kind === "node" ? "#8ab6ff" : "#c79aff",
  border: `1px solid ${kind === "node" ? "#2a4a70" : "#4a2a6a"}`,
});
const forgetBtn: React.CSSProperties = {
  marginTop: 12,
  padding: "5px 10px",
  borderRadius: 7,
  background: "transparent",
  border: "1px solid #3a2a2a",
  color: "#c98a8a",
  fontSize: 12,
  cursor: "pointer",
};
